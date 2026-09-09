/**
 * `OrganiseService` (M40) — registered as `"organise"`.
 *
 * It answers the one question every command in this module asks — **which pages?** — and it owns
 * the machinery they share: the settings, the progress dialog, opening a source file, and the
 * handful of engine round-trips that turn a set of pages into bytes.
 *
 * The commands in `manifest.ts` are thin on purpose: they read arguments, ask a dialog, and call
 * a method here. That way the palette, the ribbon, the thumbnail context menu, a drag and the
 * e2e suite all reach the same code, and "what would Delete Pages delete?" has exactly one
 * answer.
 */

import type { ProgressHandle } from '@app/dialog/Dialogs';
import type { ShellServices } from '@app/services';
import type { DocumentTab } from '@app/tabs/Documents';
import type { Document } from '@core/Document';
import type { ModelId } from '@core/Ids';
import type { Registry } from '@core/Registry';
import type { Selection } from '@core/Selection';
import { DeletePagesCommand, InsertPagesCommand, RotatePagesCommand } from '@core/commands';
import type { PdfEngine } from '@engine/PdfEngine';
import { hasBridge, invoke, type OpenedFile } from '@shared/ipc';
import type { Rotation } from '@shared/pdf';
import { choiceToPortraitPoints, orient } from '@shared/pageSizes';
import type { Orientation, PageSizeChoice } from '@shared/create';
import {
  DOCUMENT_SERVICE,
  type DocumentService,
} from '@modules/M20-document-model/DocumentService';
import { VIEWER_SERVICE, type ViewerService } from '@modules/M11-viewer/ViewerService';
import {
  NAVIGATION_SERVICE,
  type NavigationService,
} from '@modules/M12-navigation-panels/NavigationService';
import { CREATE_SERVICE, type CreateService } from '@modules/M91-create-pdf/CreateService';
import {
  ImportPagesCommand,
  PruneOutlineCommand,
  ReorderPagesCommand,
  SetPageLabelsCommand,
  danglingBookmarks,
  orderAfterMove,
  orderAfterReverse,
  orderAfterSwap,
} from './commands';
import {
  bookmarksForPages,
  closeQuietly,
  pageSizesOf,
  slicePages,
  SliceCancelled,
} from './extract';
import { labelsForRange, type LabelSpec } from './labels';
import { countPages, formatRange, parseRange, type RangeContext } from './range';
import {
  DEFAULT_ORGANISE_SETTINGS,
  extractFileName,
  ipcSettingsStorage,
  readOrganiseSettings,
  writeOrganiseSetting,
  type InsertPosition,
  type OrganiseSettings,
  type SettingsStorage,
} from './settings';

export const ORGANISE_SERVICE = 'organise';

/** How long an operation may take before the progress dialog appears (M21's number). */
const PROGRESS_DELAY_MS = 400;
/** Above this many pages an operation always shows progress, however fast it turns out to be. */
export const PROGRESS_PAGE_THRESHOLD = 20;

export interface OrganiseServiceOptions {
  readonly registry: Registry;
  readonly shell: ShellServices;
  readonly storage?: SettingsStorage;
}

/** A resolved target: the pages a command will act on, both ways round. */
export interface PageTarget {
  readonly ids: ReadonlyArray<ModelId>;
  /** 0-based visual indexes, ascending. */
  readonly indexes: ReadonlyArray<number>;
  /** `"1-3, 6"`, for a confirmation or a toast. */
  readonly text: string;
}

/** What a command was told to act on. Any of them may be absent. */
export interface TargetArgs {
  /** Explicit 0-based page indexes. */
  readonly pages?: unknown;
  /** A range string in this module's dialect. */
  readonly range?: unknown;
}

export class OrganiseService {
  private readonly registry: Registry;
  private readonly shell: ShellServices;
  private readonly storage: SettingsStorage;
  private settingsValue: OrganiseSettings = DEFAULT_ORGANISE_SETTINGS;
  private readonly listeners = new Set<(settings: OrganiseSettings) => void>();
  /** What the last operation did, for the e2e suite to read back. */
  lastOutcome: Readonly<Record<string, unknown>> | null = null;

  constructor(options: OrganiseServiceOptions) {
    this.registry = options.registry;
    this.shell = options.shell;
    this.storage = options.storage ?? ipcSettingsStorage();
  }

  // ---- settings ---------------------------------------------------------------------------------

  get settings(): OrganiseSettings {
    return this.settingsValue;
  }

  async load(): Promise<void> {
    this.settingsValue = await readOrganiseSettings(this.storage);
    this.notify();
  }

  async setSetting<K extends keyof OrganiseSettings>(
    name: K,
    value: OrganiseSettings[K],
  ): Promise<OrganiseSettings[K]> {
    this.settingsValue = { ...this.settingsValue, [name]: value };
    await writeOrganiseSetting(this.storage, name, value);
    this.notify();
    this.shell.invalidate();
    return value;
  }

  onSettingsChange(listener: (settings: OrganiseSettings) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    for (const listener of Array.from(this.listeners)) listener(this.settingsValue);
  }

  // ---- what the commands reach through ----------------------------------------------------------

  get dialogs(): ShellServices['dialogs'] {
    return this.shell.dialogs;
  }

  get toasts(): ShellServices['toasts'] {
    return this.shell.toasts;
  }

  get documents(): ShellServices['documents'] {
    return this.shell.documents;
  }

  get selection(): Selection {
    return this.shell.selection;
  }

  /** The document of the active tab, or null. */
  get document(): Document | null {
    if (!this.registry.hasService(DOCUMENT_SERVICE)) return null;
    return this.registry.service<DocumentService>(DOCUMENT_SERVICE).active;
  }

  /** The active document, or a clear error. Commands reaching this are gated on `when`. */
  require(): Document {
    const doc = this.document;
    if (!doc) throw new Error('No document is open');
    return doc;
  }

  get engine(): PdfEngine {
    return this.require().engine;
  }

  /** 0-based current page of the viewer. */
  get currentPage(): number {
    const page = this.shell.ui.get().view.page;
    return page > 0 ? page - 1 : 0;
  }

  private get navigation(): NavigationService | null {
    return this.registry.hasService(NAVIGATION_SERVICE)
      ? this.registry.service<NavigationService>(NAVIGATION_SERVICE)
      : null;
  }

  private get creates(): CreateService | null {
    return this.registry.hasService(CREATE_SERVICE)
      ? this.registry.service<CreateService>(CREATE_SERVICE)
      : null;
  }

  /**
   * Everything about this tab's pages may look different now — a rotation, an insert, a page
   * gone. Drops the thumbnails and the viewer's tiles and repaints. A plain reorder does not need
   * it: a thumbnail is cached against its page *id*, which does not change when a page moves.
   */
  invalidateRender(): void {
    const tab = this.shell.documents.active;
    if (!tab) return;
    this.navigation?.invalidateRender(tab.id);
    if (!this.registry.hasService(VIEWER_SERVICE)) return;
    const viewer = this.registry.service<ViewerService>(VIEWER_SERVICE);
    viewer.renderer.forget(tab.id);
    viewer.get(tab.id)?.refresh();
  }

  /** Nudges every view that a page moved or went, without dropping any raster. */
  private refreshViews(): void {
    const tab = this.shell.documents.active;
    if (!tab) return;
    if (this.registry.hasService(VIEWER_SERVICE)) {
      this.registry.service<ViewerService>(VIEWER_SERVICE).get(tab.id)?.refresh();
    }
  }

  // ---- which pages ------------------------------------------------------------------------------

  /** What the range parser needs to know about the document right now. */
  rangeContext(doc: Document = this.require()): RangeContext {
    return {
      pageCount: doc.pageCount,
      currentPage: Math.min(this.currentPage, Math.max(0, doc.pageCount - 1)),
      selectedPages: this.selectedPages(),
      pageSizes: doc.state.pages.map((page) => {
        const size = doc.pageSize(page.id);
        return { width: size?.width ?? 0, height: size?.height ?? 0 };
      }),
    };
  }

  /** The thumbnail selection M12 keeps in the shell's `Selection` under the `pages` kind. */
  selectedPages(): number[] {
    return [...(this.selection.as('pages')?.pages ?? [])].sort((a, b) => a - b);
  }

  /**
   * The pages a command acts on: what it was told, else what is selected, else the current page.
   *
   * That order is the whole targeting rule of this module. It is here rather than in each
   * command so a palette entry, a ribbon button, a context-menu item and a test can never mean
   * different things by "these pages".
   */
  target(args: TargetArgs = {}, doc: Document = this.require()): PageTarget {
    const indexes = this.resolveIndexes(args, doc);
    return this.targetOf(indexes, doc);
  }

  /** A target from explicit 0-based indexes, cleaned up and sorted. */
  targetOf(indexes: ReadonlyArray<number>, doc: Document = this.require()): PageTarget {
    const clean = [...new Set(indexes)]
      .filter((i) => Number.isInteger(i) && i >= 0 && i < doc.pageCount)
      .sort((a, b) => a - b);
    return {
      indexes: clean,
      ids: clean.flatMap((i) => {
        const page = doc.state.pages[i];
        return page ? [page.id] : [];
      }),
      text: formatRange(clean),
    };
  }

  private resolveIndexes(args: TargetArgs, doc: Document): number[] {
    if (Array.isArray(args.pages)) {
      return (args.pages as unknown[]).filter((p): p is number => typeof p === 'number');
    }
    if (typeof args.range === 'string') {
      const parsed = parseRange(args.range, this.rangeContext(doc));
      if (parsed.error !== null) throw new Error(parsed.error);
      return [...parsed.pages];
    }
    const selected = this.selectedPages().filter((p) => p < doc.pageCount);
    if (selected.length > 0) return selected;
    return [Math.min(this.currentPage, Math.max(0, doc.pageCount - 1))];
  }

  /** Engine indexes for model pages, in the same order. Pages the engine lost are dropped. */
  engineIndexes(ids: ReadonlyArray<ModelId>, doc: Document = this.require()): number[] {
    return ids.flatMap((id) => {
      const index = doc.enginePage(id);
      return index === undefined ? [] : [index];
    });
  }

  /** Where an insert goes, given the setting and what is selected. */
  insertIndex(position: InsertPosition, target: PageTarget, doc: Document): number {
    switch (position) {
      case 'first':
        return 0;
      case 'last':
        return doc.pageCount;
      case 'before':
        return target.indexes[0] ?? 0;
      case 'after':
        return (target.indexes[target.indexes.length - 1] ?? doc.pageCount - 1) + 1;
    }
  }

  // ---- progress ---------------------------------------------------------------------------------

  /**
   * Runs an operation under a progress dialog that only appears if it is slow or big.
   *
   * A three-page insert finishes long before the 400 ms are up and never shows one; a 500-page
   * extract shows one immediately and can be stopped. Cancelling is co-operative: the work sees
   * an `AbortSignal` and throws `SliceCancelled`, which the caller turns into "nothing happened".
   */
  async withProgress<T>(
    options: { readonly title: string; readonly text?: string; readonly pages?: number },
    work: (report: (fraction: number, text?: string) => void, signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController();
    // A holder rather than a `let`: the dialog is created inside a callback the timer owns, and a
    // plain local would still be narrowed to `null` where it is closed.
    const held: { dialog: ProgressHandle | null } = { dialog: null };
    let latest = 0;
    let latestText = options.text ?? '';
    const show = (): void => {
      if (held.dialog) return;
      const dialog = this.shell.dialogs.progress({
        title: options.title,
        ...(options.text === undefined ? {} : { text: options.text }),
        id: 'organise-progress',
      });
      held.dialog = dialog;
      dialog.set(latest, latestText);
      void dialog.onCancel.then(() => {
        controller.abort();
      });
    };
    // A big job shows its dialog at once; a small one only if it turns out to be slow.
    const big = (options.pages ?? 0) > PROGRESS_PAGE_THRESHOLD;
    const timer = big ? null : setTimeout(show, PROGRESS_DELAY_MS);
    if (big) show();
    const report = (fraction: number, text?: string): void => {
      latest = fraction;
      if (text !== undefined) latestText = text;
      held.dialog?.set(fraction, text);
    };
    try {
      return await work(report, controller.signal);
    } finally {
      if (timer) clearTimeout(timer);
      held.dialog?.close();
    }
  }

  // ---- reordering -------------------------------------------------------------------------------

  /** Applies a new page order, unless it is the order the document is already in. */
  async reorder(order: ReadonlyArray<ModelId>, label: string): Promise<boolean> {
    const doc = this.require();
    const command = new ReorderPagesCommand(doc, order, label);
    if (command.isNoop) return false;
    await doc.apply(command);
    this.refreshViews();
    return true;
  }

  /** Moves pages so they land before the visual index `insertBefore`. */
  async movePages(ids: ReadonlyArray<ModelId>, insertBefore: number): Promise<boolean> {
    const doc = this.require();
    const order = orderAfterMove(
      doc.state.pages.map((p) => p.id),
      ids,
      insertBefore,
    );
    const moved = await this.reorder(
      order,
      ids.length === 1 ? 'Move page' : `Move ${countPages(ids.length)}`,
    );
    if (moved) this.reselect(ids);
    return moved;
  }

  /**
   * Puts the selection back on these pages, wherever they have ended up.
   *
   * Every move does this. Without it, pressing "move down" twice moves two *different* pages:
   * the second press acts on whichever page has arrived at the index the first one left, which
   * is not what anyone means by pressing a button twice.
   */
  reselect(ids: ReadonlyArray<ModelId>): void {
    const doc = this.document;
    if (!doc) return;
    const pages = ids
      .flatMap((id) => {
        const index = doc.pageIndex(id);
        return index >= 0 ? [index] : [];
      })
      .sort((a, b) => a - b);
    this.selection.set(pages.length === 0 ? { kind: 'none' } : { kind: 'pages', pages });
  }

  async reversePages(ids: ReadonlyArray<ModelId>): Promise<boolean> {
    const doc = this.require();
    const order = orderAfterReverse(
      doc.state.pages.map((p) => p.id),
      ids,
    );
    return await this.reorder(order, 'Reverse pages');
  }

  async swapPages(a: ModelId, b: ModelId): Promise<boolean> {
    const doc = this.require();
    const order = orderAfterSwap(
      doc.state.pages.map((p) => p.id),
      a,
      b,
    );
    return await this.reorder(order, 'Swap pages');
  }

  // ---- rotating ---------------------------------------------------------------------------------

  async rotate(target: PageTarget, degrees: Rotation, relative = true): Promise<number> {
    const doc = this.require();
    if (target.ids.length === 0) return 0;
    await doc.apply(new RotatePagesCommand(doc, target.ids, degrees, relative));
    this.invalidateRender();
    return target.ids.length;
  }

  // ---- deleting ---------------------------------------------------------------------------------

  /**
   * Deletes pages, and with them the bookmarks that pointed at them, in one undo entry.
   *
   * A document cannot lose its last page: a PDF with no pages is not a PDF, and the honest
   * answer to "delete all of them" is to say so rather than to produce a file no reader opens.
   */
  async deletePages(target: PageTarget): Promise<number> {
    const doc = this.require();
    if (target.ids.length === 0) return 0;
    if (target.ids.length >= doc.pageCount) {
      await this.dialogs.error(
        'Delete pages',
        'A document must keep at least one page. Deleting every page would leave a file no reader could open.',
      );
      return 0;
    }
    const going = new Set<string>(target.ids);
    const bookmarks = this.settingsValue.pruneBookmarksOnDelete
      ? danglingBookmarks(doc, going)
      : [];
    const label =
      target.ids.length === 1 ? 'Delete page' : `Delete ${countPages(target.ids.length)}`;
    await doc.batch(label, async () => {
      await doc.apply(new DeletePagesCommand(doc, target.ids));
      if (bookmarks.length > 0) await doc.apply(new PruneOutlineCommand(doc, bookmarks));
    });
    this.selection.clear();
    this.refreshViews();
    return target.ids.length;
  }

  // ---- inserting --------------------------------------------------------------------------------

  /** Inserts blank pages of a preset size. */
  async insertBlank(options: {
    readonly at: number;
    readonly count: number;
    readonly size: PageSizeChoice;
    readonly orientation: Orientation;
  }): Promise<ReadonlyArray<ModelId>> {
    const doc = this.require();
    const size = orient(choiceToPortraitPoints(options.size), options.orientation);
    const command = new InsertPagesCommand(doc, options.at, options.count, size);
    await doc.apply(command);
    this.invalidateRender();
    return command.pageIds;
  }

  /**
   * Inserts blank pages of an exact size in points — "the same as the current page", which no
   * preset can promise: a scanned page is 612.3 by 791.8 and rounding it to Letter would be a
   * different page.
   */
  async insertBlankExact(options: {
    readonly at: number;
    readonly count: number;
    readonly width: number;
    readonly height: number;
  }): Promise<ReadonlyArray<ModelId>> {
    const doc = this.require();
    const command = new InsertPagesCommand(doc, options.at, options.count, {
      width: options.width,
      height: options.height,
    });
    await doc.apply(command);
    this.invalidateRender();
    return command.pageIds;
  }

  /**
   * Inserts pages that came from somewhere else.
   *
   * `bytes` is a whole document; `pages` says which of it to take. The pages are **sliced out
   * first**, so what the command carries — and therefore what a crash-recovery record holds — is
   * three pages rather than the five hundred they came from.
   */
  async insertFrom(options: {
    readonly bytes: Uint8Array;
    readonly pages?: ReadonlyArray<number>;
    readonly at: number;
    readonly keepBookmarks?: boolean;
    readonly label?: string;
    readonly name?: string;
    readonly report?: (fraction: number, text?: string) => void;
    readonly signal?: AbortSignal;
  }): Promise<ReadonlyArray<ModelId>> {
    const doc = this.require();
    const engine = doc.engine;
    const source = await engine.open(new Uint8Array(options.bytes), {
      name: options.name ?? 'inserted.pdf',
    });
    let sliced: Uint8Array;
    let sizes: Array<{ width: number; height: number }>;
    let bookmarks: ReturnType<typeof bookmarksForPages> = [];
    try {
      const count = await engine.pageCount(source);
      const wanted =
        options.pages && options.pages.length > 0
          ? options.pages.filter((p) => p >= 0 && p < count)
          : Array.from({ length: count }, (_, i) => i);
      if (wanted.length === 0) throw new Error('That file has no pages to insert');
      options.report?.(0.1, `Copying ${countPages(wanted.length)}`);
      sizes = await pageSizesOf(engine, source, wanted);
      if (options.keepBookmarks ?? this.settingsValue.keepBookmarksOnInsert) {
        const outline = await engine.outline(source).catch(() => []);
        bookmarks = bookmarksForPages(outline, wanted);
      }
      sliced = await slicePages(engine, source, wanted, {
        withComments: true,
        ...(options.signal ? { signal: options.signal } : {}),
        onProgress: (f) => options.report?.(0.1 + f * 0.6),
      });
    } finally {
      await closeQuietly(engine, source);
    }
    options.report?.(0.8, 'Inserting');
    const command = new ImportPagesCommand(doc, {
      bytes: sliced,
      pages: sizes.map((_, i) => i),
      at: options.at,
      sizes,
      ...(bookmarks.length > 0 ? { bookmarks } : {}),
      ...(options.label === undefined ? {} : { label: options.label }),
    });
    await doc.apply(command);
    this.invalidateRender();
    options.report?.(1);
    return command.pageIds;
  }

  /** Turns any file the app understands into PDF bytes: a PDF as-is, anything else via M91. */
  async pdfBytesOf(file: OpenedFile | { name: string; bytes: Uint8Array }): Promise<Uint8Array> {
    if (looksLikePdf(file.name, file.bytes)) return file.bytes;
    const creates = this.creates;
    if (!creates) {
      throw new Error(`${file.name} is not a PDF, and the converters are not available.`);
    }
    const result = await creates.convertFile({
      name: file.name,
      bytes: file.bytes,
      path: 'path' in file ? file.path : '',
    });
    return result.bytes;
  }

  /** Asks the OS for files to insert. Empty when the reader cancelled or there is no bridge. */
  async chooseFiles(): Promise<OpenedFile[]> {
    if (!hasBridge()) return [];
    return await invoke('file:openFilesDialog', {
      title: 'Insert pages from',
      buttonLabel: 'Insert',
      multi: true,
      filters: [
        {
          name: 'PDF and images',
          extensions: ['pdf', 'png', 'jpg', 'jpeg', 'tif', 'tiff', 'bmp', 'webp', 'gif'],
        },
        { name: 'PDF', extensions: ['pdf'] },
        { name: 'Text and web pages', extensions: ['txt', 'md', 'html', 'htm'] },
        { name: 'All files', extensions: ['*'] },
      ],
    });
  }

  // ---- duplicating and copying ------------------------------------------------------------------

  /** Copies of some pages, inserted at `at` in this same document. */
  async duplicate(target: PageTarget, at: number): Promise<ReadonlyArray<ModelId>> {
    const doc = this.require();
    const engineIndexes = this.engineIndexes(target.ids, doc);
    if (engineIndexes.length === 0) return [];
    const bytes = await slicePages(doc.engine, doc.handle, engineIndexes, { withComments: true });
    const label =
      target.ids.length === 1 ? 'Duplicate page' : `Duplicate ${countPages(target.ids.length)}`;
    return await this.insertFrom({
      bytes,
      at,
      keepBookmarks: false,
      label,
      name: 'duplicate.pdf',
    });
  }

  /** Copies pages into another open document, at its end. Used by the cross-document drag. */
  async copyToDocument(target: PageTarget, tabId: string): Promise<number> {
    const source = this.require();
    const docs = this.registry.service<DocumentService>(DOCUMENT_SERVICE);
    const destination = docs.get(tabId);
    if (!destination) throw new Error('That document is not open any more');
    if (destination === source) return 0;
    const engineIndexes = this.engineIndexes(target.ids, source);
    if (engineIndexes.length === 0) return 0;
    const bytes = await slicePages(source.engine, source.handle, engineIndexes, {
      withComments: true,
    });
    const sizes = await pageSizesOf(source.engine, source.handle, engineIndexes);
    const command = new ImportPagesCommand(destination, {
      bytes,
      pages: sizes.map((_, i) => i),
      at: destination.pageCount,
      sizes,
      label: `Copy in ${countPages(target.ids.length)}`,
    });
    await destination.apply(command);
    return target.ids.length;
  }

  // ---- replacing --------------------------------------------------------------------------------

  /** Puts other pages in the place of these ones: one insert and one delete, one undo entry. */
  async replace(options: {
    readonly target: PageTarget;
    readonly bytes: Uint8Array;
    readonly pages?: ReadonlyArray<number>;
    readonly name?: string;
    readonly report?: (fraction: number, text?: string) => void;
    readonly signal?: AbortSignal;
  }): Promise<number> {
    const doc = this.require();
    const { target } = options;
    if (target.indexes.length === 0) return 0;
    const at = target.indexes[0] ?? 0;
    let inserted = 0;
    await doc.batch(`Replace ${countPages(target.ids.length)}`, async () => {
      const ids = await this.insertFrom({
        bytes: options.bytes,
        ...(options.pages ? { pages: options.pages } : {}),
        at,
        keepBookmarks: false,
        label: 'Insert replacement pages',
        ...(options.name === undefined ? {} : { name: options.name }),
        ...(options.report === undefined ? {} : { report: options.report }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      inserted = ids.length;
      const going = new Set<string>(target.ids);
      const bookmarks = this.settingsValue.pruneBookmarksOnDelete
        ? danglingBookmarks(doc, going)
        : [];
      await doc.apply(new DeletePagesCommand(doc, target.ids));
      if (bookmarks.length > 0) await doc.apply(new PruneOutlineCommand(doc, bookmarks));
    });
    this.selection.clear();
    this.invalidateRender();
    return inserted;
  }

  // ---- extracting -------------------------------------------------------------------------------

  /** The bytes of a document made of these pages. */
  async extractBytes(
    target: PageTarget,
    options: {
      readonly withComments?: boolean;
      readonly report?: (fraction: number, text?: string) => void;
      readonly signal?: AbortSignal;
    } = {},
  ): Promise<Uint8Array> {
    const doc = this.require();
    const engineIndexes = this.engineIndexes(target.ids, doc);
    if (engineIndexes.length === 0) throw new Error('Those pages are not in the document');
    return await slicePages(doc.engine, doc.handle, engineIndexes, {
      withComments: options.withComments ?? this.settingsValue.extractWithComments,
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.report ? { onProgress: (f: number) => options.report?.(f) } : {}),
    });
  }

  /** Opens bytes as a new, unsaved tab — the same path a created document takes (M91). */
  async openInNewTab(bytes: Uint8Array, title: string): Promise<DocumentTab> {
    const docs = this.registry.service<DocumentService>(DOCUMENT_SERVICE);
    const opened = await docs.open(bytes, { name: `${title}.pdf`, title });
    if (this.registry.hasService(VIEWER_SERVICE)) {
      await this.registry
        .service<ViewerService>(VIEWER_SERVICE)
        .attach(opened.tab, opened.document);
    }
    // It has never been saved, so Ctrl+S and the close question both treat it as unkept work.
    opened.document.undo.markUnsaved();
    return opened.tab;
  }

  /** Writes bytes to a path through main. Returns false when there is no bridge (a browser run). */
  async writeFile(path: string, bytes: Uint8Array): Promise<boolean> {
    if (!hasBridge()) return false;
    await invoke('file:write', path, bytes);
    return true;
  }

  /** Asks where to put an extracted file. */
  async askWhereToSave(defaultName: string): Promise<string | null> {
    if (!hasBridge()) return null;
    return await invoke('file:saveAsDialog', {
      defaultPath: defaultName,
      title: 'Extract pages to',
      buttonLabel: 'Extract',
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
  }

  /** A file name for one extracted page, from the pattern setting. */
  fileNameForPage(index: number, doc: Document = this.require()): string {
    const page = doc.state.pages[index];
    return extractFileName(this.settingsValue.extractNamePattern, {
      name: baseName(doc.state.title),
      page: index + 1,
      label: page?.label ?? String(index + 1),
    });
  }

  // ---- labels -----------------------------------------------------------------------------------

  /** Renumbers a run of pages in one undo entry. */
  async setLabels(target: PageTarget, spec: LabelSpec): Promise<number> {
    const doc = this.require();
    if (target.ids.length === 0) return 0;
    const current = doc.state.pages.map((p) => p.label);
    const next = labelsForRange(current, target.indexes, spec);
    const entries = target.indexes.flatMap((index) => {
      const page = doc.state.pages[index];
      const label = next[index];
      return page && label !== undefined && label !== page.label
        ? [{ pageId: page.id, label }]
        : [];
    });
    if (entries.length === 0) return 0;
    await doc.apply(new SetPageLabelsCommand(doc, entries, 'Renumber pages'));
    doc.breakMerge();
    return entries.length;
  }

  /** Puts the plain 1, 2, 3 numbering back on a run of pages. */
  async clearLabels(target: PageTarget): Promise<number> {
    const doc = this.require();
    const entries = target.indexes.flatMap((index) => {
      const page = doc.state.pages[index];
      const label = String(index + 1);
      return page && page.label !== label ? [{ pageId: page.id, label }] : [];
    });
    if (entries.length === 0) return 0;
    await doc.apply(new SetPageLabelsCommand(doc, entries, 'Remove page numbering'));
    doc.breakMerge();
    return entries.length;
  }

  /** Reports what an operation did, in the shape the developer commands hand to the tests. */
  record(outcome: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
    this.lastOutcome = outcome;
    return outcome;
  }

  /** Turns a cancellation into "nothing happened" and lets every other failure through. */
  static cancelled(error: unknown): boolean {
    return error instanceof SliceCancelled;
  }
}

/** A PDF by its name or its first bytes — the type a file claims is believed last (M12). */
export function looksLikePdf(name: string, bytes: Uint8Array): boolean {
  if (name.toLowerCase().endsWith('.pdf')) return true;
  const header = String.fromCharCode(...bytes.subarray(0, 5));
  return header === '%PDF-';
}

/** A document's title without its extension, for naming what comes out of it. */
export function baseName(title: string): string {
  const slash = Math.max(title.lastIndexOf('/'), title.lastIndexOf('\\'));
  const name = slash >= 0 ? title.slice(slash + 1) : title;
  return name.toLowerCase().endsWith('.pdf') ? name.slice(0, -4) : name;
}

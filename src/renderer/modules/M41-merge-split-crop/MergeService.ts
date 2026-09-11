/**
 * `MergeService` (M41) — registered as `"documentOps"`.
 *
 * The commands in `manifest.ts` are thin: they read arguments, ask a dialog, and call a method
 * here. This is where the two halves meet — the pure operations in `src/engine/ops/`, which know
 * nothing about documents, and the open `Document`, which is the authority on what the reader
 * meant — and where the one interesting decision in the module lives.
 *
 * **Replacing pages.** Deskew and flatten change page *content*, and PDFium can neither wrap a
 * content stream nor un-flatten a page, so an in-place engine mutation could not be undone. So
 * the pages are replaced: sliced out, put through the pure op, imported back where they were,
 * and the originals deleted — all inside one `doc.batch`, so Edit ▸ Undo shows one entry and
 * gives back exactly what was there, annotations included. Runs are done last-first so the
 * indexes of the ones still to come do not move, and destinations that pointed at a replaced
 * page are re-aimed at its replacement rather than being quietly orphaned.
 *
 * Everything the reader might wait for goes through M40's progress dialog, which only appears if
 * the work turns out to be slow, and every one of them can be cancelled.
 */

import type { ShellServices } from '@app/services';
import type { DocumentTab } from '@app/tabs/Documents';
import type { Document } from '@core/Document';
import type { ModelId } from '@core/Ids';
import type { Registry } from '@core/Registry';
import type { Selection } from '@core/Selection';
import { DeletePagesCommand, SetPageBoxCommand } from '@core/commands';
import type { DocHandle, PdfEngine } from '@engine/PdfEngine';
import { clampRect, inkBounds, inkRect, rectFromMargins, type Margins } from '@engine/ops/crop';
import { detectSkew, MIN_ANGLE, type SkewEstimate } from '@engine/ops/deskew';
import type { CombineOptions, CombineResult } from '@engine/ops/combine';
import type { SplitOptions, SplitPart } from '@engine/ops/split';
import { OpCancelled, OpFailed, type OpSource, type Raster } from '@engine/ops/types';
import { hasBridge, invoke, type OpenedFile } from '@shared/ipc';
import type { PageBoxName, PageBoxes, PdfRect } from '@shared/pdf';
import {
  DOCUMENT_SERVICE,
  type DocumentService,
} from '@modules/M20-document-model/DocumentService';
import { VIEWER_SERVICE, type ViewerService } from '@modules/M11-viewer/ViewerService';
import type { Viewer } from '@modules/M11-viewer/Viewer';
import {
  ORGANISE_SERVICE,
  baseName,
  type OrganiseService,
  type PageTarget,
} from '@modules/M40-organise-pages/OrganiseService';
import { ImportPagesCommand } from '@modules/M40-organise-pages/commands';
import { pageSizesOf, slicePages } from '@modules/M40-organise-pages/extract';
import { countPages } from '@modules/M40-organise-pages/range';
import { OpsClient } from './OpsClient';
import {
  DropFieldsCommand,
  RepointDestinationsCommand,
  fieldsWithoutWidgets,
  repointingsFor,
  type Repointing,
} from './commands';
import {
  DEFAULT_MERGE_SETTINGS,
  ipcSettingsStorage,
  readMergeSettings,
  writeMergeSetting,
  type MergeSettings,
  type SettingsStorage,
} from './settings';

export const MERGE_SERVICE = 'documentOps';

/** Device pixels per point used for the pictures the detectors look at. */
const DETECT_SCALE = 1.5;

export interface MergeServiceOptions {
  readonly registry: Registry;
  readonly shell: ShellServices;
  readonly storage?: SettingsStorage;
  readonly client?: OpsClient;
}

/** One page's answer from the skew detector, with the page it is about. */
export interface PageSkew extends SkewEstimate {
  /** 0-based model page index. */
  readonly page: number;
  readonly label: string;
}

export class MergeService {
  private readonly registry: Registry;
  private readonly shell: ShellServices;
  private readonly storage: SettingsStorage;
  private clientValue: OpsClient | null;
  private settingsValue: MergeSettings = DEFAULT_MERGE_SETTINGS;
  private readonly listeners = new Set<(settings: MergeSettings) => void>();
  /** What the last operation did, for the e2e suite to read back. */
  lastOutcome: Readonly<Record<string, unknown>> | null = null;

  constructor(options: MergeServiceOptions) {
    this.registry = options.registry;
    this.shell = options.shell;
    this.storage = options.storage ?? ipcSettingsStorage();
    this.clientValue = options.client ?? null;
  }

  // ---- settings ---------------------------------------------------------------------------------

  get settings(): MergeSettings {
    return this.settingsValue;
  }

  /**
   * The operations Worker, started the first time something needs it.
   *
   * Lazily, as M21's writer and M91's converters are: a Worker costs a thread and a megabyte of
   * parsed bundle at boot, and most sessions never combine, split or straighten anything.
   */
  get client(): OpsClient {
    this.clientValue ??= OpsClient.spawn();
    return this.clientValue;
  }

  /** Whether the work runs off the main thread — answered without starting the Worker to find out. */
  get offThread(): boolean {
    return this.clientValue?.offThread ?? typeof Worker !== 'undefined';
  }

  async load(): Promise<void> {
    this.settingsValue = await readMergeSettings(this.storage);
    this.notify();
  }

  async setSetting<K extends keyof MergeSettings>(
    name: K,
    value: MergeSettings[K],
  ): Promise<MergeSettings[K]> {
    this.settingsValue = { ...this.settingsValue, [name]: value };
    await writeMergeSetting(this.storage, name, value);
    this.notify();
    this.shell.invalidate();
    return value;
  }

  onSettingsChange(listener: (settings: MergeSettings) => void): () => void {
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

  get selection(): Selection {
    return this.shell.selection;
  }

  /** The viewer of the active tab, when there is one — the crop tool needs its overlay layers. */
  get viewer(): Viewer | null {
    if (!this.registry.hasService(VIEWER_SERVICE)) return null;
    return this.registry.service<ViewerService>(VIEWER_SERVICE).active;
  }

  /** Runs another command through the shell, so failures reach the reader as a toast. */
  run(commandId: string, args?: Readonly<Record<string, unknown>>): Promise<unknown> {
    return this.shell.run(commandId, args);
  }

  /**
   * M40's service, which this module leans on rather than repeating: it owns "which pages?", the
   * progress dialog, opening a file through the converters, and slicing pages out.
   */
  get organise(): OrganiseService {
    return this.registry.service<OrganiseService>(ORGANISE_SERVICE);
  }

  get document(): Document | null {
    if (!this.registry.hasService(DOCUMENT_SERVICE)) return null;
    return this.registry.service<DocumentService>(DOCUMENT_SERVICE).active;
  }

  require(): Document {
    const doc = this.document;
    if (!doc) throw new Error('No document is open');
    return doc;
  }

  get engine(): PdfEngine {
    return this.require().engine;
  }

  /** Which pages a command acts on — M40's rule, so the two modules never disagree. */
  target(args: { readonly pages?: unknown; readonly range?: unknown } = {}): PageTarget {
    return this.organise.target(args);
  }

  /** Everything about this tab's pages may look different now. */
  invalidateRender(): void {
    this.organise.invalidateRender();
  }

  /** Reports what an operation did, in the shape the developer commands hand to the tests. */
  record(outcome: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
    this.lastOutcome = outcome;
    return outcome;
  }

  /** Turns a cancellation into "nothing happened" and lets every other failure through. */
  async cancellable<T>(work: () => Promise<T>): Promise<T | null> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof OpCancelled) return null;
      if (OrganiseService_cancelled(error)) return null;
      throw error;
    }
  }

  // ---- combining --------------------------------------------------------------------------------

  /** Turns whatever the reader chose into PDF bytes, routing non-PDFs through M91's converters. */
  async sourceFor(file: OpenedFile | { name: string; bytes: Uint8Array }): Promise<OpSource> {
    return { name: file.name, bytes: await this.organise.pdfBytesOf(file) };
  }

  async combine(
    sources: ReadonlyArray<OpSource>,
    options: CombineOptions,
  ): Promise<CombineResult | null> {
    if (sources.length === 0) throw new OpFailed('There are no files to combine');
    const pages = sources.reduce((n, s) => n + (s.pages?.length ?? 1), 0);
    return await this.cancellable(
      async () =>
        await this.organise.withProgress(
          { title: 'Combine files', text: 'Reading the files', pages },
          async (report, signal) => {
            const job = this.client.combine(sources, options, (fraction, message) => {
              report(fraction ?? 0, message);
            });
            signal.addEventListener('abort', () => {
              job.cancel();
            });
            return await job.promise;
          },
        ),
    );
  }

  // ---- splitting --------------------------------------------------------------------------------

  async split(options: SplitOptions): Promise<ReadonlyArray<SplitPart> | null> {
    const doc = this.require();
    const bytes = await doc.engine.save(doc.handle);
    const result = await this.cancellable(
      async () =>
        await this.organise.withProgress(
          { title: 'Split document', text: 'Working out the parts', pages: doc.pageCount },
          async (report, signal) => {
            const job = this.client.split(bytes, options, (fraction, message) => {
              report(fraction ?? 0, message);
            });
            signal.addEventListener('abort', () => {
              job.cancel();
            });
            return await job.promise;
          },
        ),
    );
    if (!result) return null;
    for (const warning of result.warnings) this.toasts.show({ kind: 'warning', text: warning });
    return result.parts;
  }

  /** The document's top-level bookmarks and the pages they point at, for the split preview. */
  topLevelBookmarks(doc: Document = this.require()): Array<{ title: string; page: number }> {
    return doc.state.outline
      .filter((item) => item.parentId === null)
      .flatMap((item) => {
        const destination = item.destinationId ? doc.destination(item.destinationId) : null;
        const pageId = destination?.pageId ?? null;
        if (pageId === null) return [];
        const index = doc.pageIndex(pageId);
        return index >= 0 ? [{ title: item.title, page: index }] : [];
      })
      .sort((a, b) => a.page - b.page);
  }

  // ---- cropping ---------------------------------------------------------------------------------

  /** Every box a page actually carries, straight from the engine (ADR 0017). */
  async pageBoxes(pageIndex: number, doc: Document = this.require()): Promise<PageBoxes> {
    const page = doc.state.pages[pageIndex];
    const media = page ? page.mediaBox : { x0: 0, y0: 0, x1: 612, y1: 792 };
    const enginePage = page ? doc.enginePage(page.id) : undefined;
    if (enginePage === undefined) {
      return { media, crop: page?.cropBox ?? media, bleed: null, trim: null, art: null };
    }
    try {
      return await doc.engine.pageBoxes(doc.handle, enginePage);
    } catch {
      // An engine without the method is not a reason to refuse to crop; the model's two boxes
      // are enough for everything but showing which of the other three the file carries.
      return { media, crop: page?.cropBox ?? media, bleed: null, trim: null, art: null };
    }
  }

  /**
   * Crops pages. One `SetPageBoxCommand` per page per box, in one undo entry.
   *
   * `rect` is absolute; `margins` are taken off each page's own box, which is what "crop every
   * page by a centimetre" has to mean when the pages are not all the same size.
   */
  async crop(options: {
    readonly target: PageTarget;
    readonly box: PageBoxName;
    readonly rect?: PdfRect;
    readonly margins?: Margins;
    readonly changePageSize?: boolean;
    readonly label?: string;
  }): Promise<number> {
    const doc = this.require();
    const { target } = options;
    if (target.ids.length === 0) return 0;
    const label =
      options.label ??
      (target.ids.length === 1 ? 'Crop page' : `Crop ${countPages(target.ids.length)}`);
    let cropped = 0;
    await doc.batch(label, async () => {
      for (const id of target.ids) {
        const page = doc.pageById(id);
        if (!page) continue;
        const from = boxOf(page, options.box);
        const rect = options.rect
          ? clampRect(options.rect, page.mediaBox)
          : rectFromMargins(from, options.margins ?? { left: 0, right: 0, top: 0, bottom: 0 });
        if (rect.x1 - rect.x0 < 1 || rect.y1 - rect.y0 < 1) continue;
        await doc.apply(new SetPageBoxCommand(doc, id, options.box, rect));
        if (options.changePageSize === true) {
          // The paper becomes the cropped area. CropBox goes with it: a MediaBox smaller than
          // the CropBox is a page every reader draws differently.
          if (options.box !== 'crop') await doc.apply(new SetPageBoxCommand(doc, id, 'crop', rect));
          await doc.apply(new SetPageBoxCommand(doc, id, 'media', rect));
        }
        cropped++;
      }
    });
    this.invalidateRender();
    return cropped;
  }

  /** Where the content of a page actually is — what "remove white margins" offers. */
  async whiteMarginRect(
    pageIndex: number,
    doc: Document = this.require(),
  ): Promise<PdfRect | null> {
    const page = doc.state.pages[pageIndex];
    if (!page) return null;
    const enginePage = doc.enginePage(page.id);
    if (enginePage === undefined) return null;
    const rendered = await renderRaster(doc.engine, doc.handle, enginePage, DETECT_SCALE);
    if (!rendered) return null;
    const bounds = inkBounds(rendered.raster);
    if (!bounds) return null;
    return inkRect(bounds, rendered.raster, rendered.rect, this.settingsValue.cropMarginPoints);
  }

  // ---- straightening ----------------------------------------------------------------------------

  /** Measures the skew of some pages, one render each, cancellable. */
  async detect(
    pages: ReadonlyArray<number>,
    onEach?: (result: PageSkew) => void,
  ): Promise<ReadonlyArray<PageSkew> | null> {
    const doc = this.require();
    return await this.cancellable(
      async () =>
        await this.organise.withProgress(
          { title: 'Straighten pages', text: 'Measuring', pages: pages.length },
          async (report, signal) => {
            const out: PageSkew[] = [];
            for (const [i, index] of pages.entries()) {
              if (signal.aborted) throw new OpCancelled();
              report(i / Math.max(1, pages.length), `Measuring page ${String(index + 1)}`);
              const result = await this.detectOne(index, doc);
              out.push(result);
              onEach?.(result);
            }
            report(1);
            return out;
          },
        ),
    );
  }

  /** One page's skew. Public because the dialog's preview re-measures as the reader nudges. */
  async detectOne(pageIndex: number, doc: Document = this.require()): Promise<PageSkew> {
    const page = doc.state.pages[pageIndex];
    const label = page?.label ?? String(pageIndex + 1);
    const enginePage = page ? doc.enginePage(page.id) : undefined;
    if (enginePage === undefined) {
      return {
        page: pageIndex,
        label,
        angle: 0,
        confidence: 'none',
        reason: 'the page is not in the document',
        ink: 0,
      };
    }
    const rendered = await renderRaster(doc.engine, doc.handle, enginePage, DETECT_SCALE, true);
    if (!rendered) {
      return {
        page: pageIndex,
        label,
        angle: 0,
        confidence: 'none',
        reason: 'the page could not be drawn',
        ink: 0,
      };
    }
    return { page: pageIndex, label, ...detectSkew(rendered.raster) };
  }

  /**
   * Straightens pages by the angles given, keyed by 0-based model page index.
   *
   * Answers how many pages were turned. Pages whose angle is too small to matter are skipped
   * rather than rewritten, so "straighten everything" on an already-straight document does
   * nothing at all and leaves the undo stack alone.
   */
  async deskew(
    angles: Readonly<Record<number, number>>,
    options: { readonly trimEdges?: boolean; readonly background?: number | 'white' | null } = {},
  ): Promise<number> {
    const doc = this.require();
    const pages = Object.keys(angles)
      .map(Number)
      .filter((p) => Number.isInteger(p) && p >= 0 && p < doc.pageCount)
      .filter((p) => Math.abs(angles[p] ?? 0) >= MIN_ANGLE)
      .sort((a, b) => a - b);
    if (pages.length === 0) return 0;
    const label = pages.length === 1 ? 'Straighten page' : `Straighten ${countPages(pages.length)}`;
    const replaced = await this.replacePages({
      pages,
      label,
      title: 'Straighten pages',
      transform: async (bytes, order, report, signal) => {
        // The op keys its angles by *its* page numbers, which are the order they were sliced in.
        const mapped: Record<number, number> = {};
        order.forEach((page, i) => {
          mapped[i] = angles[page] ?? 0;
        });
        const job = this.client.deskew(
          bytes,
          {
            angles: mapped,
            trimEdges: options.trimEdges ?? this.settingsValue.deskewTrimEdges,
            ...(options.background === undefined ? {} : { background: options.background }),
          },
          (fraction, message) => {
            report(fraction ?? 0, message);
          },
        );
        signal.addEventListener('abort', () => {
          job.cancel();
        });
        return (await job.promise).bytes;
      },
    });
    return replaced;
  }

  // ---- flattening -------------------------------------------------------------------------------

  /** Bakes comments and form fields into the pages they are on. */
  async flatten(options: {
    readonly target: PageTarget;
    readonly annotations: boolean;
    readonly forms: boolean;
    readonly remove: boolean;
  }): Promise<number> {
    const doc = this.require();
    const pages = [...options.target.indexes];
    if (pages.length === 0) return 0;
    const label = options.remove
      ? `Remove comments from ${countPages(pages.length)}`
      : pages.length === 1
        ? 'Flatten page'
        : `Flatten ${countPages(pages.length)}`;
    return await this.replacePages({
      pages,
      label,
      title: options.remove ? 'Remove comments' : 'Flatten',
      // A flattened widget is gone from its page, and a field with no widget anywhere is a field
      // no reader can fill. Dropping it goes inside the same undo entry as the pages.
      after: options.forms
        ? async () => {
            const orphans = fieldsWithoutWidgets(doc);
            if (orphans.length > 0) await doc.apply(new DropFieldsCommand(doc, orphans, label));
          }
        : undefined,
      transform: async (bytes, _order, report, signal) => {
        const job = this.client.flatten(
          bytes,
          {
            annotations: options.annotations,
            forms: options.forms,
            remove: options.remove,
          },
          (fraction, message) => {
            report(fraction ?? 0, message);
          },
        );
        signal.addEventListener('abort', () => {
          job.cancel();
        });
        const result = await job.promise;
        for (const warning of result.warnings) {
          this.toasts.show({ kind: 'warning', text: warning });
        }
        this.record({
          ...(this.lastOutcome ?? {}),
          flattened: result.flattened,
          removed: result.removed,
        });
        return result.bytes;
      },
    });
  }

  // ---- the shared machinery ---------------------------------------------------------------------

  /**
   * Replaces some pages with transformed copies of themselves, in one undo entry.
   *
   * Slice → transform → import back → delete the originals → re-aim the destinations. Runs of
   * consecutive pages are handled last-first, so the indexes of the runs still to come do not
   * move as the earlier ones are rebuilt.
   */
  private async replacePages(options: {
    readonly pages: ReadonlyArray<number>;
    readonly label: string;
    readonly title: string;
    readonly transform: (
      bytes: Uint8Array,
      order: ReadonlyArray<number>,
      report: (fraction: number, text?: string) => void,
      signal: AbortSignal,
    ) => Promise<Uint8Array>;
    /** Anything else that belongs in the same undo entry, run after the pages are back. */
    readonly after?: (() => Promise<void>) | undefined;
  }): Promise<number> {
    const doc = this.require();
    const order = [...options.pages].sort((a, b) => a - b);
    const oldIds = order.flatMap((index) => {
      const page = doc.state.pages[index];
      return page ? [page.id] : [];
    });
    if (oldIds.length === 0) return 0;

    const outcome = await this.cancellable(
      async () =>
        await this.organise.withProgress(
          { title: options.title, text: 'Reading the pages', pages: order.length },
          async (report, signal) => {
            const engineIndexes = this.organise.engineIndexes(oldIds, doc);
            if (engineIndexes.length !== oldIds.length) {
              throw new OpFailed('Those pages are not in the document any more');
            }
            const sliced = await slicePages(doc.engine, doc.handle, engineIndexes, {
              withComments: true,
              signal,
              onProgress: (f) => {
                report(f * 0.3, 'Reading the pages');
              },
            });
            const transformed = await options.transform(
              sliced,
              order,
              (fraction, text) => {
                report(0.3 + fraction * 0.5, text);
              },
              signal,
            );
            report(0.85, 'Putting the pages back');
            const sizes = await pageSizesOf(doc.engine, doc.handle, engineIndexes);
            return { transformed, sizes };
          },
        ),
    );
    if (!outcome) return 0;

    /** Where each old page id ends up: filled in as the runs are imported. */
    const replacements = new Map<ModelId, ModelId>();
    await doc.batch(options.label, async () => {
      for (const run of runsOf(order).reverse()) {
        const at = run[0] ?? 0;
        const first = order.indexOf(at);
        const command = new ImportPagesCommand(doc, {
          bytes: outcome.transformed,
          pages: run.map((_, i) => first + i),
          at,
          sizes: run.map((_, i) => outcome.sizes[first + i] ?? { width: 595.276, height: 841.89 }),
          label: options.label,
        });
        await doc.apply(command);
        command.pageIds.forEach((id, i) => {
          const oldId = oldIds[first + i];
          if (oldId !== undefined) replacements.set(oldId, id);
        });
      }
      const repointings: Repointing[] = repointingsFor(doc, replacements);
      await doc.apply(new DeletePagesCommand(doc, oldIds));
      if (repointings.length > 0) {
        await doc.apply(new RepointDestinationsCommand(doc, repointings));
      }
      await options.after?.();
    });

    this.selection.set({
      kind: 'pages',
      pages: [...replacements.values()]
        .map((id) => doc.pageIndex(id))
        .filter((i) => i >= 0)
        .sort((a, b) => a - b),
    });
    this.invalidateRender();
    return oldIds.length;
  }

  // ---- files ------------------------------------------------------------------------------------

  /** Asks the OS for files to combine. Empty when the reader cancelled or there is no bridge. */
  async chooseFiles(): Promise<OpenedFile[]> {
    if (!hasBridge()) return [];
    return await invoke('file:openFilesDialog', {
      title: 'Add files to combine',
      buttonLabel: 'Add',
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

  /** Asks the OS for a folder. `null` when the reader cancelled or there is no bridge. */
  async chooseFolder(title: string): Promise<string | null> {
    if (!hasBridge()) return null;
    return await invoke('dialog:pickFolder', title);
  }

  /**
   * Writes one of a split's parts into a folder, and answers where it went.
   *
   * `file:writeInto` rather than `file:write`: it sanitises every segment and refuses a path
   * that would escape the folder, and a name pattern is a string the reader typed.
   */
  async writeInto(folder: string, name: string, bytes: Uint8Array): Promise<string | null> {
    if (!hasBridge()) return null;
    return await invoke('file:writeInto', folder, name, bytes);
  }

  async askWhereToSave(defaultName: string, title: string): Promise<string | null> {
    if (!hasBridge()) return null;
    return await invoke('file:saveAsDialog', {
      defaultPath: defaultName,
      title,
      buttonLabel: 'Save',
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
  }

  async writeFile(path: string, bytes: Uint8Array): Promise<boolean> {
    if (!hasBridge()) return false;
    await invoke('file:write', path, bytes);
    return true;
  }

  /** Opens bytes as a new, unsaved tab — M40's path, so a combined file behaves like any other. */
  async openInNewTab(bytes: Uint8Array, title: string): Promise<DocumentTab> {
    return await this.organise.openInNewTab(bytes, title);
  }

  /** The active document's name without its extension, for naming what comes out of it. */
  baseName(doc: Document = this.require()): string {
    return baseName(doc.state.title);
  }

  dispose(): void {
    this.clientValue?.dispose();
    this.clientValue = null;
  }
}

/** The box a page carries under a name, with the spec's fallbacks. */
function boxOf(
  page: {
    mediaBox: PdfRect;
    cropBox: PdfRect;
    bleedBox: PdfRect | null;
    trimBox: PdfRect | null;
    artBox: PdfRect | null;
  },
  box: PageBoxName,
): PdfRect {
  switch (box) {
    case 'media':
      return page.mediaBox;
    case 'crop':
      return page.cropBox;
    case 'bleed':
      return page.bleedBox ?? page.cropBox;
    case 'trim':
      return page.trimBox ?? page.cropBox;
    case 'art':
      return page.artBox ?? page.cropBox;
  }
}

/** Consecutive page indexes grouped into runs: `[0,1,2,5,6]` → `[[0,1,2],[5,6]]`. */
export function runsOf(pages: ReadonlyArray<number>): number[][] {
  const sorted = [...new Set(pages)].sort((a, b) => a - b);
  const runs: number[][] = [];
  for (const page of sorted) {
    const last = runs[runs.length - 1];
    if (last && page === (last[last.length - 1] ?? -2) + 1) last.push(page);
    else runs.push([page]);
  }
  return runs;
}

/**
 * Renders a page to the pixels the detectors want.
 *
 * Two paths, because `render` answers with an `ImageBitmap` in a browser and with the raw pixels
 * under the same field in Node (`PdfiumEngine` says so). Drawing the bitmap onto an
 * `OffscreenCanvas` is the only way to read a real one back, and it is cheap next to the render.
 */
export async function renderRaster(
  engine: PdfEngine,
  handle: DocHandle,
  page: number,
  scale: number,
  grayscale = false,
): Promise<{ raster: Raster; rect: PdfRect } | null> {
  let result;
  try {
    result = await engine.render(handle, page, scale, undefined, {
      annotations: false,
      forms: false,
      grayscale,
      background: 0xffffff,
    });
  } catch {
    return null;
  }
  const bitmap = result.bitmap;
  const asPixels = bitmap as unknown as {
    data?: Uint8ClampedArray | Uint8Array;
    width: number;
    height: number;
  };
  if (asPixels.data) {
    return {
      raster: { data: asPixels.data, width: asPixels.width, height: asPixels.height },
      rect: result.rect,
    };
  }
  if (typeof OffscreenCanvas === 'undefined') return null;
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const context = canvas.getContext('2d');
  if (!context) return null;
  context.drawImage(bitmap, 0, 0);
  const image = context.getImageData(0, 0, bitmap.width, bitmap.height);
  bitmap.close();
  return {
    raster: { data: image.data, width: image.width, height: image.height },
    rect: result.rect,
  };
}

/**
 * M40's "was this a cancellation" test, reached without importing the class into a type
 * position it does not need.
 */
function OrganiseService_cancelled(error: unknown): boolean {
  return error instanceof Error && error.name === 'SliceCancelled';
}

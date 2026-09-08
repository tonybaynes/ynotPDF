/**
 * `AnnotationService` (M30) — everything that creates, selects, edits and deletes an annotation.
 * Registered as the service `"annotations"`.
 *
 * What it owns:
 * - **One `AnnotationLayer` per open tab**, kept in step with the document's revision and with
 *   the viewer's panes, plus the set of annotations this session has touched (which is what
 *   decides whether the overlay or the raster draws each one — see `shapes.ts`).
 * - **Creation**, from the text selection for the markup family and from a point or a rectangle
 *   for the rest. Every creation is one `Command`, and the pair that "replace text" means is one
 *   composite so it undoes in a single step.
 * - **Selection and geometry.** Move, resize, nudge, delete, copy, cut and paste — all through
 *   `UpdateAnnotationCommand`, which merges, so a drag is one undo entry.
 * - **Properties**: the values the panel edits, the "set as default" per tool, and the identity
 *   the reader is asked for before their first annotation.
 *
 * It deliberately does no pointer handling: `AnnotationController` listens on the viewport and
 * calls in here, exactly as M13's selection controller does, because a drag that starts on one
 * page must keep producing coordinates after it has left it.
 */

import type { ShellServices } from '@app/services';
import { SERVICE } from '@app/services';
import type { Registry } from '@core/Registry';
import type { Document } from '@core/Document';
import type { ModelId } from '@core/Ids';
import type { ModelAnnotation, AnnotationPatch } from '@core/model';
import {
  AddAnnotationCommand,
  DeleteAnnotationCommand,
  UpdateAnnotationCommand,
  DEFAULT_ANNOTATION_FLAGS,
  draftAnnotation,
} from '@core/commands';
import type { PdfEngine } from '@engine/PdfEngine';
import type { PdfPoint, PdfRect } from '@shared/pdf';
import {
  appearanceInput,
  buildDefaultAppearance,
  buildDefaultStyle,
  calloutNumbers,
  caretRectAt,
  defaultAppearanceService,
  intentOf,
  measureFreeText,
  noteRectAt,
  quadNumbers,
  quadsBounds,
  styleOf,
  type FreeTextStyle,
  type Quad,
} from '@engine/appearance';
import { AnnotationLayer, resizeRect, type BoxHandle } from '@view/AnnotationLayer';
import type { Viewer } from '@modules/M11-viewer/Viewer';
import { VIEWER_SERVICE, type ViewerService } from '@modules/M11-viewer/ViewerService';
import { DOCUMENT_SERVICE, type DocumentService } from '@modules/M20-document-model/manifest';
import {
  SELECT_FIND_SERVICE,
  type SelectFindService,
} from '@modules/M13-select-find-print/SelectFindService';
import { spansForPage } from '@modules/M13-select-find-print/selection/model';
import { quadsForSpan, caretPointAt } from './quads';
import { isOurs, toLayerAnnotation } from './shapes';
import {
  ANNOTATION_TOOLS,
  DEFAULT_ANNOTATION_SETTINGS,
  EMPTY_IDENTITY,
  factoryDefaults,
  ipcSettingsStorage,
  readIdentity,
  readSettings,
  readToolDefaults,
  writeIdentity,
  writeSetting,
  writeToolDefaults,
  type AnnotationSettings,
  type AnnotationToolId,
  type Identity,
  type SettingsStorage,
  type ToolDefaults,
} from './settings';
import { askIdentity } from './identity';
import { decodeAnnotations, encodeAnnotations, type ClipboardAnnotation } from './clipboard';

export const ANNOTATION_SERVICE = 'annotations';
export const PROPERTIES_PANEL_ID = 'props.annotation';

/** What a tool needs to know before it makes something. */
export interface CreationContext {
  readonly document: Document;
  readonly pageId: ModelId;
  readonly page: number;
  readonly defaults: ToolDefaults;
  readonly identity: Identity;
}

interface TabState {
  readonly layer: AnnotationLayer;
  selection: ModelId[];
  readonly edited: Set<string>;
  readonly loaded: Set<number>;
  readonly disposers: Array<() => void>;
  panes: number;
}

/** A listener told whenever the selection or the annotations change. */
export type AnnotationListener = () => void;

export class AnnotationService {
  private readonly registry: Registry;
  private readonly shell: ShellServices;
  private readonly engine: PdfEngine;
  private readonly storage: SettingsStorage;
  private readonly tabs = new Map<string, TabState>();
  private readonly disposers: Array<() => void> = [];
  private readonly listeners = new Set<AnnotationListener>();
  private readonly toolDefaults = new Map<AnnotationToolId, ToolDefaults>();
  private settingsValue: AnnotationSettings = DEFAULT_ANNOTATION_SETTINGS;
  private identityValue: Identity = EMPTY_IDENTITY;
  private identityPrompt: Promise<Identity> | null = null;
  /**
   * The first read of the settings, so a write that arrives before it has finished is not undone
   * by it. `activate` starts `load()` without waiting, which is right — the app must not block on
   * a settings read — but it means a command run in the same tick would otherwise write a value
   * the load then quietly overwrote with the stored one.
   */
  private loading: Promise<void> | null = null;
  /** The tool that made the last annotation, so "keep tool selected" knows what to restore. */
  private lastTool: AnnotationToolId | null = null;

  constructor(options: {
    readonly registry: Registry;
    readonly shell: ShellServices;
    readonly engine: PdfEngine;
    readonly storage?: SettingsStorage;
  }) {
    this.registry = options.registry;
    this.shell = options.shell;
    this.engine = options.engine;
    this.storage = options.storage ?? ipcSettingsStorage();
    for (const tool of ANNOTATION_TOOLS) this.toolDefaults.set(tool, factoryDefaults(tool));

    this.disposers.push(
      this.shell.documents.onClosed((tab) => {
        this.releaseTab(tab.id);
      }),
    );
    this.disposers.push(
      this.shell.documents.subscribe(() => {
        this.syncActive();
      }),
    );
    this.disposers.push(
      this.shell.documents.onAttached(() => {
        this.syncActive();
      }),
    );
  }

  // ---- settings ---------------------------------------------------------------------------------

  get settings(): AnnotationSettings {
    return this.settingsValue;
  }

  get identity(): Identity {
    return this.identityValue;
  }

  async load(): Promise<void> {
    this.loading ??= (async () => {
      this.settingsValue = await readSettings(this.storage);
      this.identityValue = await readIdentity(this.storage);
      for (const tool of ANNOTATION_TOOLS) {
        this.toolDefaults.set(tool, await readToolDefaults(this.storage, tool));
      }
      this.notify();
    })();
    await this.loading;
  }

  /** Waits for the first settings read, so nothing writes into a value it is about to replace. */
  private async settled(): Promise<void> {
    if (this.loading) await this.loading;
  }

  async setSetting<K extends keyof AnnotationSettings>(
    name: K,
    value: AnnotationSettings[K],
  ): Promise<void> {
    await this.settled();
    this.settingsValue = { ...this.settingsValue, [name]: value };
    await writeSetting(this.storage, name, value);
    this.notify();
  }

  defaults(tool: AnnotationToolId): ToolDefaults {
    return this.toolDefaults.get(tool) ?? factoryDefaults(tool);
  }

  /** "Set as default": the current values of a tool, remembered for the next annotation. */
  async setDefaults(tool: AnnotationToolId, patch: Partial<ToolDefaults>): Promise<ToolDefaults> {
    await this.settled();
    const next = { ...this.defaults(tool), ...patch };
    this.toolDefaults.set(tool, next);
    await writeToolDefaults(this.storage, tool, next);
    this.notify();
    return next;
  }

  /**
   * The identity every annotation is signed with, asking for it the first time.
   *
   * The dialog is opened once even if two annotations are made in the same tick — the promise is
   * shared — because two identity dialogs stacked on each other is the sort of thing that makes
   * an app feel broken.
   */
  async requireIdentity(): Promise<Identity> {
    await this.settled();
    if (this.identityValue.asked) return this.identityValue;
    this.identityPrompt ??= (async () => {
      const answered = await askIdentity(this.shell.dialogs, this.identityValue);
      this.identityValue = answered;
      await writeIdentity(this.storage, answered);
      return answered;
    })().finally(() => {
      this.identityPrompt = null;
    });
    return await this.identityPrompt;
  }

  /** Sets the identity from the preferences UI or a test, without a dialog. */
  async setIdentity(identity: Identity): Promise<void> {
    await this.settled();
    this.identityValue = { ...identity, asked: true };
    await writeIdentity(this.storage, this.identityValue);
    this.notify();
  }

  // ---- wiring -----------------------------------------------------------------------------------

  subscribe(listener: AnnotationListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const l of [...this.listeners]) l();
    this.shell.invalidate();
  }

  private viewerService(): ViewerService | null {
    return this.registry.hasService(VIEWER_SERVICE)
      ? this.registry.service<ViewerService>(VIEWER_SERVICE)
      : null;
  }

  private documentService(): DocumentService | null {
    return this.registry.hasService(DOCUMENT_SERVICE)
      ? this.registry.service<DocumentService>(DOCUMENT_SERVICE)
      : null;
  }

  private selectFind(): SelectFindService | null {
    return this.registry.hasService(SELECT_FIND_SERVICE)
      ? this.registry.service<SelectFindService>(SELECT_FIND_SERVICE)
      : null;
  }

  activeViewer(): Viewer | null {
    return this.viewerService()?.active ?? null;
  }

  activeDocument(): Document | null {
    return this.documentService()?.active ?? null;
  }

  activeTabId(): string | null {
    return this.shell.documents.state.active;
  }

  /** The layer of the active tab, creating and binding it the first time. */
  layer(): AnnotationLayer | null {
    this.syncActive();
    const id = this.activeTabId();
    return id ? (this.tabs.get(id)?.layer ?? null) : null;
  }

  /** Binds the active tab's viewer panes, creating its state the first time. */
  private syncActive(): void {
    const tabId = this.shell.documents.state.active;
    if (!tabId) return;
    const viewer = this.viewerService()?.get(tabId);
    const document = this.documentService()?.get(tabId);
    if (!viewer || !document) return;
    const state = this.ensureTab(tabId, document);
    if (state.panes !== viewer.allPanes.length) {
      state.panes = viewer.allPanes.length;
      for (const pane of viewer.allPanes) state.layer.attach(pane);
    }
    void this.refresh(tabId);
  }

  private ensureTab(tabId: string, document: Document): TabState {
    const existing = this.tabs.get(tabId);
    if (existing) return existing;
    const state: TabState = {
      layer: new AnnotationLayer(),
      selection: [],
      edited: new Set(),
      loaded: new Set(),
      disposers: [],
      panes: 0,
    };
    state.disposers.push(
      document.subscribe(() => {
        this.repaint(tabId);
      }),
    );
    this.tabs.set(tabId, state);
    return state;
  }

  private releaseTab(tabId: string): void {
    const state = this.tabs.get(tabId);
    if (!state) return;
    this.tabs.delete(tabId);
    for (const d of state.disposers.splice(0)) d();
    state.layer.dispose();
  }

  private tabState(): { tabId: string; state: TabState; document: Document } | null {
    const tabId = this.activeTabId();
    if (!tabId) return null;
    this.syncActive();
    const state = this.tabs.get(tabId);
    const document = this.documentService()?.get(tabId);
    return state && document ? { tabId, state, document } : null;
  }

  /** Reads the annotations of every mounted page, then repaints. */
  async refresh(tabId?: string): Promise<void> {
    const id = tabId ?? this.activeTabId();
    if (!id) return;
    const state = this.tabs.get(id);
    const document = this.documentService()?.get(id);
    const viewer = this.viewerService()?.get(id);
    if (!state || !document || !viewer) return;
    const pages = new Set<number>();
    for (const pane of viewer.allPanes) {
      for (const rect of pane.layoutTable.rects) pages.add(rect.page);
    }
    let read = false;
    for (const page of pages) {
      if (state.loaded.has(page)) continue;
      const modelPage = document.state.pages[page];
      if (!modelPage) continue;
      state.loaded.add(page);
      await document.loadAnnotations(modelPage.id);
      read = true;
    }
    this.repaint(id);
    if (read) this.notify();
  }

  /** Makes sure a page's annotations have been read, whatever is on screen. */
  async ensurePage(document: Document, page: number): Promise<void> {
    const modelPage = document.state.pages[page];
    if (!modelPage) return;
    const tabId = this.activeTabId();
    const state = tabId ? this.tabs.get(tabId) : undefined;
    if (state?.loaded.has(page)) return;
    state?.loaded.add(page);
    await document.loadAnnotations(modelPage.id);
  }

  private repaint(tabId: string): void {
    const state = this.tabs.get(tabId);
    const document = this.documentService()?.get(tabId);
    if (!state || !document) return;
    const items = [];
    for (const [index, page] of document.state.pages.entries()) {
      for (const a of document.annotations(page.id)) {
        if (!isOurs(a)) continue;
        items.push(
          toLayerAnnotation(a, index, {
            edited: state.edited,
            ...(this.editing === a.id ? { hidden: true } : {}),
          }),
        );
      }
    }
    state.layer.set(items);
    state.layer.setSelection(state.selection);
  }

  /** The annotation whose inline editor is open; the layer hides it so text is not drawn twice. */
  editing: ModelId | null = null;

  setEditing(id: ModelId | null): void {
    this.editing = id;
    const tabId = this.activeTabId();
    if (tabId) this.repaint(tabId);
  }

  // ---- selection --------------------------------------------------------------------------------

  get selection(): ReadonlyArray<ModelId> {
    const tabId = this.activeTabId();
    return tabId ? (this.tabs.get(tabId)?.selection ?? []) : [];
  }

  selectedAnnotations(): ModelAnnotation[] {
    const document = this.activeDocument();
    if (!document) return [];
    return this.selection
      .map((id) => document.annotation(id))
      .filter((a): a is ModelAnnotation => a !== null);
  }

  select(ids: ReadonlyArray<ModelId>, options: { readonly add?: boolean } = {}): void {
    const found = this.tabState();
    if (!found) return;
    const { tabId, state } = found;
    const next = options.add ? [...new Set([...state.selection, ...ids])] : [...ids];
    state.selection = next;
    state.layer.setSelection(next);
    this.publishSelection(next);
    this.repaint(tabId);
    this.notify();
  }

  toggle(id: ModelId): void {
    const found = this.tabState();
    if (!found) return;
    const has = found.state.selection.includes(id);
    this.select(
      has ? found.state.selection.filter((x) => x !== id) : [...found.state.selection, id],
    );
  }

  clearSelection(): void {
    this.select([]);
  }

  /** Every annotation of ours on the page the reader is looking at. */
  selectAllOnPage(): void {
    const found = this.tabState();
    const viewer = this.activeViewer();
    if (!found || !viewer) return;
    const page = found.document.state.pages[viewer.state.page];
    if (!page) return;
    this.select(
      found.document
        .annotations(page.id)
        .filter(isOurs)
        .map((a) => a.id),
    );
  }

  /** Publishes into the shell's `Selection` so `when` clauses everywhere can see it. */
  private publishSelection(ids: ReadonlyArray<ModelId>): void {
    const document = this.activeDocument();
    if (ids.length === 0) {
      if (this.shell.selection.kind === 'annotations') this.shell.selection.clear();
      return;
    }
    const first = document?.annotation(ids[0] ?? ('' as ModelId));
    const page = first ? document?.pageIndex(first.pageId) : undefined;
    this.shell.selection.set({
      kind: 'annotations',
      page: page ?? 0,
      ids: ids.map((id) => String(id)),
    });
  }

  // ---- creation ---------------------------------------------------------------------------------

  /** The document, page and defaults a tool needs, with the identity already asked for. */
  async creationContext(tool: AnnotationToolId, page: number): Promise<CreationContext | null> {
    const document = this.activeDocument();
    if (!document) return null;
    const modelPage = document.state.pages[page];
    if (!modelPage) return null;
    await this.ensurePage(document, page);
    const identity = await this.requireIdentity();
    return {
      document,
      pageId: modelPage.id,
      page,
      defaults: this.defaults(tool),
      identity,
    };
  }

  /** The shared fields every annotation this app makes carries. */
  private stamp(
    context: CreationContext,
  ): Pick<
    ModelAnnotation,
    'author' | 'created' | 'modified' | 'subject' | 'flags' | 'opacity' | 'contents'
  > {
    const now = new Date().toISOString();
    return {
      author: context.identity.name === '' ? null : context.identity.name,
      created: now,
      modified: now,
      subject: context.defaults.subject,
      flags: DEFAULT_ANNOTATION_FLAGS,
      // Solid colours only: the app never writes `/CA` for its own annotations (CLAUDE.md).
      opacity: null,
      contents: null,
    };
  }

  /**
   * Text markup from the current selection.
   *
   * One annotation per page the selection touches, because `/QuadPoints` belong to one page —
   * which is also what Foxit does, and what makes each page's highlight deletable on its own.
   */
  async createMarkup(
    kind: 'Highlight' | 'Underline' | 'Squiggly' | 'StrikeOut',
    tool: AnnotationToolId,
  ): Promise<ModelId[]> {
    const selectFind = this.selectFind();
    const source = selectFind?.activeSource();
    if (!selectFind || !source) return [];
    const state = selectFind.selection;
    const pages = pagesOf(state);
    if (pages.length === 0) return [];
    const created: ModelId[] = [];
    const document = this.activeDocument();
    if (!document) return [];
    const context = await this.creationContext(tool, pages[0] ?? 0);
    if (!context) return [];

    await document.batch(`Add ${kind.toLowerCase()}`, async () => {
      for (const page of pages) {
        const pageText = await selectFind.text.page(source, page);
        const spans = spansForPage(state, page, selectFind.text.lookup(source.key));
        const list: Quad[] = spans.flatMap((span) => quadsForSpan(pageText, span));
        if (list.length === 0) continue;
        const bounds = quadsBounds(list);
        if (!bounds) continue;
        const modelPage = document.state.pages[page];
        if (!modelPage) continue;
        await this.ensurePage(document, page);
        const draft = draftAnnotation(document, modelPage.id, {
          subtype: kind,
          rect: bounds,
          quadPoints: list.flatMap(quadNumbers),
          color: context.defaults.color,
          ...this.stamp(context),
        } as never);
        const command = new AddAnnotationCommand(document, draft);
        await document.apply(command);
        this.markEdited(draft.id);
        created.push(draft.id);
      }
    });
    if (created.length > 0) {
      this.select(created);
      this.afterCreate(tool);
    }
    return created;
  }

  /**
   * "Replace text": a strike-out over the words plus a caret carrying the replacement, which is
   * what a PDF means by it (12.5.6.11) and what Acrobat and Foxit both write. One composite
   * command, so the pair undoes together.
   */
  async createReplace(): Promise<ModelId[]> {
    const selectFind = this.selectFind();
    const source = selectFind?.activeSource();
    const document = this.activeDocument();
    if (!selectFind || !source || !document) return [];
    const state = selectFind.selection;
    const pages = pagesOf(state);
    const page = pages[0];
    if (page === undefined) return [];
    const context = await this.creationContext('replace', page);
    if (!context) return [];
    const pageText = await selectFind.text.page(source, page);
    const spans = spansForPage(state, page, selectFind.text.lookup(source.key));
    const list = spans.flatMap((span) => quadsForSpan(pageText, span));
    const bounds = quadsBounds(list);
    if (!bounds) return [];
    const end = spans[spans.length - 1]?.end ?? 0;
    const caretAt = caretPointAt(pageText, Math.max(0, end - 1), 'after');
    const created: ModelId[] = [];
    await document.batch('Replace text', async () => {
      const strike = draftAnnotation(document, context.pageId, {
        subtype: 'StrikeOut',
        rect: bounds,
        quadPoints: list.flatMap(quadNumbers),
        color: context.defaults.color,
        ...this.stamp(context),
      } as never);
      await document.apply(new AddAnnotationCommand(document, strike));
      created.push(strike.id);
      if (caretAt) {
        const caret = draftAnnotation(document, context.pageId, {
          subtype: 'Caret',
          rect: caretRectAt(caretAt.point, caretAt.lineHeight),
          color: context.defaults.color,
          ...this.stamp(context),
          extra: { intent: 'Replace' },
        } as never);
        await document.apply(new AddAnnotationCommand(document, caret));
        created.push(caret.id);
      }
    });
    for (const id of created) this.markEdited(id);
    this.select(created);
    this.afterCreate('replace');
    if (created[0]) this.openPopup(created[0]);
    return created;
  }

  /** "Insert text": a caret at the insertion point, with the text to insert as its note. */
  async createInsert(): Promise<ModelId | null> {
    const selectFind = this.selectFind();
    const source = selectFind?.activeSource();
    const document = this.activeDocument();
    if (!selectFind || !source || !document) return null;
    const state = selectFind.selection;
    const page = pagesOf(state)[0];
    if (page === undefined) return null;
    const context = await this.creationContext('insert', page);
    if (!context) return null;
    const pageText = await selectFind.text.page(source, page);
    const spans = spansForPage(state, page, selectFind.text.lookup(source.key));
    const start = spans[0]?.start ?? 0;
    const at = caretPointAt(pageText, start, 'before');
    if (!at) return null;
    const draft = draftAnnotation(document, context.pageId, {
      subtype: 'Caret',
      rect: caretRectAt(at.point, at.lineHeight),
      color: context.defaults.color,
      ...this.stamp(context),
      extra: { intent: 'InsertText' },
    } as never);
    await document.apply(new AddAnnotationCommand(document, draft));
    this.markEdited(draft.id);
    this.select([draft.id]);
    this.afterCreate('insert');
    this.openPopup(draft.id);
    return draft.id;
  }

  /** A sticky note at a point on a page. */
  async createNote(page: number, at: PdfPoint): Promise<ModelId | null> {
    const context = await this.creationContext('note', page);
    if (!context) return null;
    const { document } = context;
    const draft = draftAnnotation(document, context.pageId, {
      subtype: 'Text',
      rect: noteRectAt(at),
      color: context.defaults.color,
      ...this.stamp(context),
      extra: { icon: context.defaults.icon },
    } as never);
    await document.apply(new AddAnnotationCommand(document, draft));
    this.markEdited(draft.id);
    await this.pushNoteAppearance(draft.id);
    this.select([draft.id]);
    this.afterCreate('note');
    if (this.settingsValue.openPopupOnCreate) this.openPopup(draft.id);
    return draft.id;
  }

  /**
   * A typewriter, a text box or a callout.
   *
   * `rect` is where the reader dragged, or a default box around where they clicked. A callout
   * also gets its leader line: the tip is where the pointer went down and the box sits away from
   * it, which is the arrangement Foxit starts a callout in.
   */
  async createFreeText(
    tool: 'typewriter' | 'textbox' | 'callout',
    page: number,
    rect: PdfRect,
    callout?: ReadonlyArray<PdfPoint>,
  ): Promise<ModelId | null> {
    const context = await this.creationContext(tool, page);
    if (!context) return null;
    const { document, defaults } = context;
    const style: FreeTextStyle = {
      family: defaults.fontFamily,
      size: defaults.fontSize,
      bold: defaults.bold,
      italic: defaults.italic,
      color: defaults.color,
      align: defaults.align,
      lineSpacing: defaults.lineSpacing,
    };
    const intent =
      tool === 'callout'
        ? 'FreeTextCallout'
        : tool === 'typewriter'
          ? 'FreeTextTypewriter'
          : 'FreeText';
    const extra: Record<string, unknown> = {
      intent,
      defaultAppearance: buildDefaultAppearance(style),
      defaultStyle: buildDefaultStyle(style),
      align: style.align,
    };
    if (tool === 'callout' && callout && callout.length >= 2) {
      extra['callout'] = calloutNumbers(callout);
      extra['lineEnding'] = 'OpenArrow';
    }
    if (defaults.borderStyle === 'dashed') extra['borderStyle'] = 'dashed';
    const draft = draftAnnotation(document, context.pageId, {
      subtype: 'FreeText',
      rect,
      color: tool === 'typewriter' ? null : defaults.color,
      interiorColor: tool === 'typewriter' ? null : defaults.fillColor,
      borderWidth: tool === 'typewriter' ? 0 : defaults.borderWidth,
      ...this.stamp(context),
      contents: '',
      extra,
    } as never);
    await document.apply(new AddAnnotationCommand(document, draft));
    this.markEdited(draft.id);
    this.select([draft.id]);
    this.afterCreate(tool);
    return draft.id;
  }

  /** A default box for a click rather than a drag, sized for one line of the tool's font. */
  defaultFreeTextRect(tool: 'typewriter' | 'textbox' | 'callout', at: PdfPoint): PdfRect {
    const defaults = this.defaults(tool);
    const height = defaults.fontSize * defaults.lineSpacing + 8;
    const width = Math.max(120, defaults.fontSize * 12);
    return { x0: at.x, y0: at.y - height, x1: at.x + width, y1: at.y };
  }

  /** After a creation: back to the Hand tool unless the reader asked us to keep the tool. */
  private afterCreate(tool: AnnotationToolId): void {
    this.lastTool = tool;
    if (!this.settingsValue.keepToolSelected) {
      this.registry.service<{ activate(id: string): void }>(SERVICE.tools).activate('tool.hand');
    }
    this.notify();
  }

  get lastUsedTool(): AnnotationToolId | null {
    return this.lastTool;
  }

  private markEdited(id: ModelId): void {
    const tabId = this.activeTabId();
    this.tabs.get(tabId ?? '')?.edited.add(id);
  }

  /**
   * Hands PDFium the note icon the reader chose.
   *
   * PDFium draws its own appearance for a `Text` annotation and it is one fixed yellow square
   * whatever `/Name` says, so without this the live page shows the wrong icon until the file is
   * saved and reopened. A note icon is pure vector, which is the reason this can go through
   * `setAnnotationAppearance` at all (ADR 0013).
   */
  async pushNoteAppearance(id: ModelId): Promise<void> {
    const document = this.activeDocument();
    const annotation = document?.annotation(id);
    if (!document || annotation?.family !== 'note') return;
    const engineId = document.idTable.engineKey('annotation', id);
    if (engineId === undefined) return;
    const stream = defaultAppearanceService.generate(
      appearanceInput({
        subtype: 'Text',
        rect: annotation.rect,
        color: annotation.color,
        extra: annotation.extra,
      }),
    );
    if (!stream) return;
    try {
      await this.engine.setAnnotationAppearance(document.handle, engineId, stream.content);
    } catch {
      // A backend without the call simply keeps its own appearance; the file still gets ours.
    }
  }

  // ---- editing ----------------------------------------------------------------------------------

  /** Patches every selected annotation, as one undo step. */
  async patchSelection(patch: AnnotationPatch, label = 'Edit annotation'): Promise<void> {
    const found = this.tabState();
    if (!found) return;
    const { document, state } = found;
    const ids = [...state.selection];
    if (ids.length === 0) return;
    const stamped: AnnotationPatch = { ...patch, modified: new Date().toISOString() };
    if (ids.length === 1) {
      const id = ids[0];
      if (id) await document.apply(new UpdateAnnotationCommand(document, id, stamped));
    } else {
      await document.batch(label, async () => {
        for (const id of ids) {
          await document.apply(new UpdateAnnotationCommand(document, id, stamped));
        }
      });
    }
    for (const id of ids) {
      this.markEdited(id);
      if (document.annotation(id)?.family === 'note') await this.pushNoteAppearance(id);
    }
    this.notify();
  }

  /** Patches one annotation by id, whatever the selection is. */
  async patch(id: ModelId, patch: AnnotationPatch): Promise<void> {
    const document = this.activeDocument();
    if (!document?.annotation(id)) return;
    await document.apply(
      new UpdateAnnotationCommand(document, id, { ...patch, modified: new Date().toISOString() }),
    );
    this.markEdited(id);
    if (document.annotation(id)?.family === 'note') await this.pushNoteAppearance(id);
    this.notify();
  }

  /**
   * Moves every selected annotation by a page-space delta.
   *
   * Quads move with the rect, or a highlight would come away from the words it marks; a callout's
   * leader line moves with its box, because dragging the box is meant to take the whole thing.
   */
  async moveSelection(dx: number, dy: number, label = 'Move annotation'): Promise<void> {
    const found = this.tabState();
    if (!found || (dx === 0 && dy === 0)) return;
    const { document, state } = found;
    const ids = [...state.selection];
    const apply = async (): Promise<void> => {
      for (const id of ids) {
        const a = document.annotation(id);
        if (!a || a.flags.locked || a.flags.readOnly) continue;
        await document.apply(new UpdateAnnotationCommand(document, id, movePatch(a, dx, dy)));
        this.markEdited(id);
      }
    };
    if (ids.length === 1) await apply();
    else await document.batch(label, apply);
    for (const id of ids) {
      if (document.annotation(id)?.family === 'note') await this.pushNoteAppearance(id);
    }
    this.notify();
  }

  /** Resizes one annotation by dragging a box handle. */
  async resize(id: ModelId, handle: BoxHandle, to: PdfPoint): Promise<void> {
    const document = this.activeDocument();
    const a = document?.annotation(id);
    if (!document || !a || a.flags.locked) return;
    const rect = normalise(resizeRect(a.rect, handle, to));
    if (rect.x1 - rect.x0 < 4 || rect.y1 - rect.y0 < 4) return;
    await this.patch(id, { rect });
  }

  /** Drags a callout's tip or its knee. */
  async moveCalloutPoint(id: ModelId, which: 'tip' | 'knee', to: PdfPoint): Promise<void> {
    const document = this.activeDocument();
    const a = document?.annotation(id);
    if (!document || a?.family !== 'freeText') return;
    const points = [...calloutPoints(a)];
    if (points.length < 2) return;
    points[which === 'tip' ? 0 : 1] = to;
    await this.patch(id, { extra: { ...a.extra, callout: calloutNumbers(points) } });
  }

  /** Deletes every selected annotation, as one undo step. */
  async deleteSelection(): Promise<number> {
    const found = this.tabState();
    if (!found) return 0;
    const { document, state } = found;
    const ids = state.selection.filter((id) => {
      const a = document.annotation(id);
      return a !== null && !a.flags.locked && !a.flags.readOnly;
    });
    if (ids.length === 0) return 0;
    const remove = async (): Promise<void> => {
      for (const id of ids) await document.apply(new DeleteAnnotationCommand(document, id));
    };
    if (ids.length === 1) await remove();
    else await document.batch(`Delete ${ids.length} annotations`, remove);
    this.select([]);
    return ids.length;
  }

  // ---- clipboard --------------------------------------------------------------------------------

  /** Copies the selection to the system clipboard, in a form another window can paste. */
  async copySelection(): Promise<number> {
    const annotations = this.selectedAnnotations();
    if (annotations.length === 0) return 0;
    const document = this.activeDocument();
    const payload: ClipboardAnnotation[] = annotations.map((a) => ({
      annotation: a,
      page: document?.pageIndex(a.pageId) ?? 0,
    }));
    await writeText(encodeAnnotations(payload));
    return annotations.length;
  }

  async cutSelection(): Promise<number> {
    const n = await this.copySelection();
    if (n > 0) await this.deleteSelection();
    return n;
  }

  /**
   * Pastes annotations from the clipboard onto the page the reader is on.
   *
   * They land where they were, offset by a little when they came from this same page so a paste
   * is visible rather than exactly on top of the original — which is what every editor does.
   */
  async paste(): Promise<ModelId[]> {
    const text = await readText();
    const items = decodeAnnotations(text);
    if (items.length === 0) return [];
    const document = this.activeDocument();
    const viewer = this.activeViewer();
    if (!document || !viewer) return [];
    const page = viewer.state.page;
    const modelPage = document.state.pages[page];
    if (!modelPage) return [];
    await this.ensurePage(document, page);
    const identity = await this.requireIdentity();
    const now = new Date().toISOString();
    const created: ModelId[] = [];
    await document.batch(
      `Paste ${items.length} annotation${items.length === 1 ? '' : 's'}`,
      async () => {
        for (const item of items) {
          const shift = item.page === page ? 12 : 0;
          const source = item.annotation;
          const draft = draftAnnotation(document, modelPage.id, {
            ...toEngineShape(source),
            rect: offsetRect(source.rect, shift, -shift),
            author: identity.name === '' ? source.author : identity.name,
            created: now,
            modified: now,
          } as never);
          await document.apply(new AddAnnotationCommand(document, draft));
          this.markEdited(draft.id);
          if (draft.family === 'note') await this.pushNoteAppearance(draft.id);
          created.push(draft.id);
        }
      },
    );
    if (created.length > 0) this.select(created);
    return created;
  }

  /** Whether the clipboard holds annotations — for the Paste command's `when`. */
  async clipboardHasAnnotations(): Promise<boolean> {
    return decodeAnnotations(await readText()).length > 0;
  }

  // ---- replies and status (data only; M32 builds the panel) ------------------------------------

  /** The replies to an annotation, oldest first. */
  replies(id: ModelId): ModelAnnotation[] {
    const document = this.activeDocument();
    const target = document?.annotation(id);
    if (!document || !target) return [];
    return document
      .annotations(target.pageId)
      .filter((a) => a.inReplyTo === id)
      .sort((a, b) => (a.created ?? '').localeCompare(b.created ?? ''));
  }

  /** Adds a reply to an annotation. The UI for threads is M32's; the data is written here. */
  async reply(id: ModelId, text: string): Promise<ModelId | null> {
    const document = this.activeDocument();
    const target = document?.annotation(id);
    if (!document || !target) return null;
    const identity = await this.requireIdentity();
    const now = new Date().toISOString();
    const draft = draftAnnotation(document, target.pageId, {
      subtype: 'Text',
      rect: target.rect,
      contents: text,
      author: identity.name === '' ? null : identity.name,
      created: now,
      modified: now,
      subject: target.subject,
      flags: { ...DEFAULT_ANNOTATION_FLAGS, hidden: true },
      extra: { icon: 'Comment' },
    } as never);
    const withParent = { ...draft, inReplyTo: id } as ModelAnnotation;
    await document.apply(new AddAnnotationCommand(document, withParent));
    this.markEdited(withParent.id);
    return withParent.id;
  }

  /** Sets the review state of an annotation (`/State` + `/StateModel`). */
  async setState(id: ModelId, state: string, model = 'Review'): Promise<void> {
    const document = this.activeDocument();
    const a = document?.annotation(id);
    if (!document || !a) return;
    await this.patch(id, {
      state,
      extra: { ...a.extra, stateModel: model },
    });
  }

  // ---- popup and inline editor ------------------------------------------------------------------

  private popupOpener: ((id: ModelId) => void) | null = null;
  private editorOpener: ((id: ModelId) => void) | null = null;

  /** The UI registers how a popup and an inline editor are opened; the service only asks. */
  bindOpeners(popup: (id: ModelId) => void, editor: (id: ModelId) => void): void {
    this.popupOpener = popup;
    this.editorOpener = editor;
  }

  openPopup(id: ModelId): void {
    this.popupOpener?.(id);
  }

  openEditor(id: ModelId): void {
    this.editorOpener?.(id);
  }

  dispose(): void {
    for (const d of this.disposers.splice(0)) d();
    for (const id of [...this.tabs.keys()]) this.releaseTab(id);
    this.listeners.clear();
  }
}

// ---- helpers --------------------------------------------------------------------------------------

function pagesOf(state: { readonly anchor: unknown; readonly focus: unknown }): number[] {
  // M13's model exports `selectedPages`, but importing it here would drag the whole module in for
  // one function; the shape is two carets and an optional column, and this is that shape.
  const s = state as {
    anchor: { page: number; offset: number } | null;
    focus: { page: number; offset: number } | null;
    column: { page: number } | null;
  };
  if (s.column) return [s.column.page];
  if (!s.anchor || !s.focus) return [];
  const from = Math.min(s.anchor.page, s.focus.page);
  const to = Math.max(s.anchor.page, s.focus.page);
  const out: number[] = [];
  for (let p = from; p <= to; p++) out.push(p);
  return out;
}

function normalise(r: PdfRect): PdfRect {
  return {
    x0: Math.min(r.x0, r.x1),
    y0: Math.min(r.y0, r.y1),
    x1: Math.max(r.x0, r.x1),
    y1: Math.max(r.y0, r.y1),
  };
}

function offsetRect(r: PdfRect, dx: number, dy: number): PdfRect {
  return { x0: r.x0 + dx, y0: r.y0 + dy, x1: r.x1 + dx, y1: r.y1 + dy };
}

function calloutPoints(a: ModelAnnotation): PdfPoint[] {
  const value = a.extra['callout'];
  if (!Array.isArray(value)) return [];
  const numbers = value.filter((n): n is number => typeof n === 'number');
  const out: PdfPoint[] = [];
  for (let i = 0; i + 1 < numbers.length; i += 2) {
    out.push({ x: numbers[i] ?? 0, y: numbers[i + 1] ?? 0 });
  }
  return out;
}

/** A move as a patch: the rect, and whatever geometry the family keeps beside it. */
export function movePatch(a: ModelAnnotation, dx: number, dy: number): AnnotationPatch {
  const patch: Record<string, unknown> = { rect: offsetRect(a.rect, dx, dy) };
  if ((a.family === 'markup' || a.family === 'link') && a.quadPoints.length > 0) {
    patch['quadPoints'] = a.quadPoints.map((n, i) => n + (i % 2 === 0 ? dx : dy));
  }
  const callout = calloutPoints(a);
  if (callout.length >= 2) {
    patch['extra'] = {
      ...a.extra,
      callout: callout.flatMap((p) => [p.x + dx, p.y + dy]),
    };
  }
  return patch;
}

/** The fields a paste re-creates. Ids, page and thread links are not among them. */
function toEngineShape(a: ModelAnnotation): Record<string, unknown> {
  return {
    subtype: a.subtype,
    rect: a.rect,
    flags: a.flags,
    contents: a.contents,
    color: a.color,
    interiorColor: a.interiorColor,
    opacity: a.opacity,
    borderWidth: a.borderWidth,
    subject: a.subject,
    ...('quadPoints' in a ? { quadPoints: a.quadPoints } : {}),
    ...('paths' in a ? { paths: a.paths } : {}),
    ...('vertices' in a ? { paths: [a.vertices] } : {}),
    extra: a.extra,
  };
}

async function writeText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // A denied clipboard is not an error worth a dialog; the copy simply did not happen.
  }
}

async function readText(): Promise<string> {
  try {
    return await navigator.clipboard.readText();
  } catch {
    return '';
  }
}

/** Re-exported so the panel does not have to reach into the engine for the style shape. */
export { intentOf, styleOf, measureFreeText };

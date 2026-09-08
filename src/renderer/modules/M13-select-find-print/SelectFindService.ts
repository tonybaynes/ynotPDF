/**
 * `SelectFindService` (M13) — what holds selection, find, search, snapshot and printing
 * together, and the single place the manifest's commands call into.
 *
 * Per tab it owns a highlighter, a text-selection controller and a find controller; per window
 * it owns the find bar, the advanced-search panel's state and the print service. The page text
 * itself is shared (`TextService`), so a find and a selection on the same page read the same
 * model rather than each asking the engine for its own copy.
 */

import type { ShellServices } from '@app/services';
import { SERVICE } from '@app/services';
import type { Registry } from '@core/Registry';
import type { Document } from '@core/Document';
import { pageSizeOf } from '@core/model';
import type { SelectionState as CoreSelection, TextRange } from '@core/Selection';
import type { PdfEngine } from '@engine/PdfEngine';
import { hasBridge, invoke, on, type FolderSearchHit } from '@shared/ipc';
import type { PdfRect } from '@shared/pdf';
import type { DocumentView } from '@view/DocumentView';
import { spanRects, spanToRange, type PageText } from '@view/TextLayer';
import { DOCUMENT_SERVICE, type DocumentService } from '@modules/M20-document-model/manifest';
import { VIEWER_SERVICE, type ViewerService } from '@modules/M11-viewer/manifest';
import type { Viewer } from '@modules/M11-viewer/Viewer';
import { TextService, type TextSource } from './TextService';
import { FindBar } from './find/FindBar';
import { FindController, type FindHit, type FindProgress } from './find/FindController';
import { csvBytes } from './find/csv';
import { sortHits, type FindOptions, type SearchHit } from './find/search';
import { EMPTY_PANEL_STATE, type SearchPanelHost, type SearchPanelState } from './find/SearchPanel';
import { Highlighter, type Highlight } from './selection/Highlighter';
import { TextSelectionController } from './selection/TextSelectionController';
import { writeClipboard, writeClipboardImage } from './selection/clipboard';
import {
  EMPTY_SELECTION,
  isEmpty,
  selectAllPages,
  selectColumn,
  selectedPages,
  selectionText,
  spansForPage,
  type SelectionState,
} from './selection/model';
import { selectionToRtf } from './selection/rtf';
import { PrintService } from './print/PrintService';
import { openPrintDialog } from './print/PrintDialog';
import type { PrintPlan } from './print/plan';
import {
  DEFAULT_PRINT_SETTINGS,
  DEFAULT_SELECT_FIND_SETTINGS,
  findOptionsOf,
  ipcSettingsStorage,
  readPrintSettings,
  readSettings,
  writePrintSettings,
  writeSetting,
  type PrintSettings,
  type SearchScope,
  type SelectFindSettings,
  type SettingsStorage,
} from './settings';
import {
  clampRegion,
  renderSnapshot,
  snapshotFileName,
  snapshotPixelSize,
} from './snapshot/snapshot';
import { SELECT_TEXT_TOOL } from './tools';

export const SELECT_FIND_SERVICE = 'selectFind';

/** The advanced-search panel's id. Declared here so the service can open it by name. */
export const SEARCH_PANEL_ID = 'nav.search';

export interface SelectFindServiceOptions {
  readonly registry: Registry;
  readonly shell: ShellServices;
  readonly engine: PdfEngine;
  /** Where the find bar mounts — the document area. */
  readonly host: HTMLElement;
  readonly storage?: SettingsStorage;
}

interface TabState {
  readonly tabId: string;
  readonly highlighter: Highlighter;
  readonly selection: TextSelectionController;
  readonly find: FindController;
  readonly panes: Set<DocumentView>;
}

export class SelectFindService {
  readonly text: TextService;
  readonly print = new PrintService();
  private readonly registry: Registry;
  private readonly shell: ShellServices;
  private readonly engine: PdfEngine;
  private readonly storage: SettingsStorage;
  private readonly tabs = new Map<string, TabState>();
  private readonly disposers: Array<() => void> = [];
  private readonly panelListeners = new Set<(state: SearchPanelState) => void>();
  private settingsValue: SelectFindSettings = DEFAULT_SELECT_FIND_SETTINGS;
  private printSettings: PrintSettings = DEFAULT_PRINT_SETTINGS;
  private panelState: SearchPanelState = EMPTY_PANEL_STATE;
  private findBar: FindBar | null = null;
  private readonly host: HTMLElement;
  private searchJob: string | null = null;
  private folderHits: SearchHit[] = [];
  private lastPointer: { page: number; x: number; y: number } | null = null;
  private queryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: SelectFindServiceOptions) {
    this.registry = options.registry;
    this.shell = options.shell;
    this.engine = options.engine;
    this.host = options.host;
    this.storage = options.storage ?? ipcSettingsStorage();
    this.text = new TextService(options.engine);

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
    this.disposers.push(
      this.shell.ui.select(
        (s) => s.activeTool,
        () => {
          this.onToolChanged();
        },
        { immediate: false },
      ),
    );
    if (hasBridge()) {
      this.disposers.push(
        on('search:results', (payload) => {
          this.onFolderResults(payload.jobId, payload.hits);
        }),
      );
      this.disposers.push(
        on('search:progress', (payload) => {
          if (payload.jobId !== this.searchJob) return;
          this.setPanel({ scanned: payload.scanned, total: payload.total, file: payload.file });
        }),
      );
      this.disposers.push(
        on('search:done', (payload) => {
          if (payload.jobId !== this.searchJob) return;
          this.searchJob = null;
          this.setPanel({
            running: false,
            error: payload.error ?? null,
            truncated: payload.hits >= this.settingsValue.maxHits,
          });
        }),
      );
    }
    // The page under the last right-click, for "Copy image".
    const onPointer = (event: PointerEvent): void => {
      const viewer = this.activeViewer();
      const hit = viewer?.pane.hitTest(event.clientX, event.clientY);
      if (hit) this.lastPointer = hit;
    };
    this.host.addEventListener('pointerdown', onPointer, { capture: true });
    this.disposers.push(() => {
      this.host.removeEventListener('pointerdown', onPointer, { capture: true });
    });
  }

  // ---- settings ---------------------------------------------------------------------------------

  get settings(): SelectFindSettings {
    return this.settingsValue;
  }

  get lastPrintSettings(): PrintSettings {
    return this.printSettings;
  }

  findOptions(): FindOptions {
    return findOptionsOf(this.settingsValue);
  }

  async load(): Promise<void> {
    this.settingsValue = await readSettings(this.storage);
    this.printSettings = await readPrintSettings(this.storage);
    this.setPanel({ scope: this.settingsValue.scope });
    this.findBar?.syncOptions();
  }

  async setSetting<K extends keyof SelectFindSettings>(
    name: K,
    value: SelectFindSettings[K],
  ): Promise<SelectFindSettings[K]> {
    this.settingsValue = { ...this.settingsValue, [name]: value };
    await writeSetting(this.storage, name, value);
    this.findBar?.syncOptions();
    this.notifyPanel();
    return value;
  }

  /** Changing an option re-runs the current query, as Foxit's check boxes do. */
  async setFindOption(name: keyof FindOptions, value: boolean | number): Promise<void> {
    if (name === 'proximity') await this.setSetting('proximity', Number(value));
    else await this.setSetting(name, Boolean(value));
    const bar = this.findBar;
    if (bar?.isOpen && bar.query.length > 0) await this.runFind(bar.query);
  }

  // ---- tabs and panes ---------------------------------------------------------------------------

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

  /** The viewer of the active tab, if there is one. */
  activeViewer(): Viewer | null {
    return this.viewerService()?.active ?? null;
  }

  activeDocument(): Document | null {
    return this.documentService()?.active ?? null;
  }

  /** What the text service and the find controller need to read a document. */
  sourceFor(tabId: string): TextSource | null {
    const document = this.documentService()?.get(tabId);
    if (!document) return null;
    return { key: tabId, handle: document.handle, pageCount: document.pageCount };
  }

  activeSource(): TextSource | null {
    const tab = this.shell.documents.state.active;
    return tab ? this.sourceFor(tab) : null;
  }

  /** Binds the active tab's viewer, creating its state the first time. */
  private syncActive(): void {
    const tabId = this.shell.documents.state.active;
    if (!tabId) return;
    const viewer = this.viewerService()?.get(tabId);
    if (!viewer) return;
    const state = this.ensureTab(tabId);
    for (const pane of viewer.allPanes) {
      if (state.panes.has(pane)) continue;
      state.panes.add(pane);
      state.selection.attach(pane);
    }
    state.selection.repaint(this.findHighlights(state));
  }

  private ensureTab(tabId: string): TabState {
    const existing = this.tabs.get(tabId);
    if (existing) return existing;
    const highlighter = new Highlighter();
    const find = new FindController({
      engine: this.engine,
      text: this.text,
      onUpdate: (progress) => {
        this.onFindUpdate(tabId, progress);
      },
    });
    const selection = new TextSelectionController({
      isActive: () => this.shell.ui.get().activeTool === SELECT_TEXT_TOOL,
      lookup: this.text.lookup(tabId),
      ensure: async (page) => {
        const source = this.sourceFor(tabId);
        if (!source) throw new Error('No document');
        return await this.text.page(source, page);
      },
      onChange: (state) => {
        this.publishSelection(tabId, state);
      },
      highlighter,
    });
    const tab: TabState = { tabId, highlighter, selection, find, panes: new Set() };
    this.tabs.set(tabId, tab);
    return tab;
  }

  private releaseTab(tabId: string): void {
    const state = this.tabs.get(tabId);
    if (!state) return;
    this.tabs.delete(tabId);
    state.selection.dispose();
    state.highlighter.dispose();
    state.find.reset();
    this.text.forget(tabId);
    if (this.tabs.size === 0) this.shell.selection.clear();
  }

  private activeTab(): TabState | null {
    const tabId = this.shell.documents.state.active;
    if (!tabId) return null;
    this.syncActive();
    return this.tabs.get(tabId) ?? null;
  }

  private onToolChanged(): void {
    const state = this.activeTab();
    if (!state) return;
    if (this.shell.ui.get().activeTool === SELECT_TEXT_TOOL) state.selection.prefetchVisible();
    else state.selection.clear();
  }

  // ---- selection --------------------------------------------------------------------------------

  get selection(): SelectionState {
    return this.activeTab()?.selection.selection ?? EMPTY_SELECTION;
  }

  hasSelection(): boolean {
    const state = this.tabs.get(this.shell.documents.state.active ?? '');
    return state ? !state.selection.isEmpty : false;
  }

  /** Pages the selection touches — what "Print selected pages" means. */
  selectedPages(): number[] {
    const state = this.activeTab();
    return state ? selectedPages(state.selection.selection) : [];
  }

  /** Publishes into the shell's `Selection` so `when` clauses everywhere can see it. */
  private publishSelection(tabId: string, state: SelectionState): void {
    if (this.shell.documents.state.active !== tabId) return;
    const ranges: TextRange[] = [];
    for (const page of selectedPages(state)) {
      const text = this.text.peek(tabId, page);
      if (!text) continue;
      for (const span of spansForPage(state, page, this.text.lookup(tabId))) {
        const range = spanToRange(text, span);
        if (range) ranges.push(range);
      }
    }
    const next: CoreSelection = ranges.length > 0 ? { kind: 'text', ranges } : { kind: 'none' };
    this.shell.selection.set(next);
    this.shell.invalidate();
  }

  async selectAll(): Promise<void> {
    const state = this.activeTab();
    const source = this.activeSource();
    if (!state || !source || source.pageCount === 0) return;
    const viewer = this.activeViewer();
    const page = viewer?.state.page ?? 0;
    // Ctrl+A selects the page the reader is on; a second press widens to the document, which is
    // what Foxit does and what stops one keystroke reading a thousand pages off the engine.
    const current = state.selection.selection;
    const wholePage = await this.text.page(source, page);
    const alreadyPage =
      current.anchor?.page === page &&
      current.focus?.page === page &&
      current.anchor.offset === 0 &&
      current.focus.offset === wholePage.text.length;
    if (!alreadyPage) {
      state.selection.apply({
        anchor: { page, offset: 0 },
        focus: { page, offset: wholePage.text.length },
        granularity: 'character',
        column: null,
      });
      return;
    }
    await this.text.all(source);
    const last = await this.text.page(source, source.pageCount - 1);
    state.selection.apply(selectAllPages(0, source.pageCount - 1, last.text.length));
  }

  deselect(): void {
    this.activeTab()?.selection.clear();
  }

  /**
   * Selects a character range — the search results and the tests use it. `endPage` makes it a
   * cross-page selection, which is otherwise only reachable by dragging.
   */
  applySelection(page: number, start: number, end: number, endPage = page): void {
    const state = this.activeTab();
    if (!state) return;
    state.selection.apply({
      anchor: { page, offset: start },
      focus: { page: endPage, offset: end },
      granularity: 'character',
      column: null,
    });
  }

  /** The Alt-drag equivalent, for the tests. */
  applyColumnSelection(page: number, rect: PdfRect): void {
    const state = this.activeTab();
    if (!state) return;
    state.selection.apply(selectColumn(page, rect));
  }

  /** A serialisable description of the selection, for the status line and the tests. */
  async selectionSummary(): Promise<{
    empty: boolean;
    pages: number[];
    length: number;
    text: string;
    ranges: TextRange[];
    rects: number;
  }> {
    const state = this.activeTab();
    const source = this.activeSource();
    if (!state || !source) {
      return { empty: true, pages: [], length: 0, text: '', ranges: [], rects: 0 };
    }
    const selection = state.selection.selection;
    const pages = selectedPages(selection);
    for (const page of pages) await this.text.page(source, page);
    const lookup = this.text.lookup(source.key);
    const ranges: TextRange[] = [];
    let rects = 0;
    for (const page of pages) {
      const pageText = this.text.peek(source.key, page);
      if (!pageText) continue;
      for (const span of spansForPage(selection, page, lookup)) {
        const range = spanToRange(pageText, span);
        if (range) ranges.push(range);
        rects += spanRects(pageText, span).length;
      }
    }
    const text = selectionText(selection, lookup);
    return {
      empty: isEmpty(selection),
      pages,
      length: text.length,
      text,
      ranges,
      rects,
    };
  }

  /** The selected text, reading whatever pages have not been read yet. */
  async selectedText(): Promise<string> {
    const state = this.activeTab();
    const source = this.activeSource();
    if (!state || !source) return '';
    for (const page of selectedPages(state.selection.selection)) await this.text.page(source, page);
    return selectionText(state.selection.selection, this.text.lookup(source.key));
  }

  /** Copy, optionally with formatting (RTF as well as plain text). */
  async copySelection(options: { readonly rtf?: boolean } = {}): Promise<boolean> {
    const state = this.activeTab();
    const source = this.activeSource();
    if (!state || !source || state.selection.isEmpty) return false;
    const selection = state.selection.selection;
    const parts: Array<{ pageText: PageText; spans: Array<{ start: number; end: number }> }> = [];
    for (const page of selectedPages(selection)) {
      const pageText = await this.text.page(source, page);
      const spans = spansForPage(selection, page, this.text.lookup(source.key));
      if (spans.length > 0) parts.push({ pageText, spans });
    }
    const text = selectionText(selection, this.text.lookup(source.key));
    if (text.length === 0) return false;
    await writeClipboard({
      text,
      ...(options.rtf ? { rtf: selectionToRtf(parts) } : {}),
    });
    this.shell.toasts.show({
      kind: 'success',
      text: options.rtf ? 'Copied with formatting' : 'Copied',
    });
    return true;
  }

  /**
   * Copies the image object under the last pointer position as a PNG. Foxit puts this on the
   * right-click menu of an image; the page object list is how we know one is there.
   */
  async copyImageUnderPointer(): Promise<boolean> {
    const source = this.activeSource();
    const point = this.lastPointer;
    if (!source || !point) return false;
    const objects = await this.engine.pageObjects(source.handle, point.page);
    // Topmost first: the object list is in z-order.
    const image = [...objects]
      .reverse()
      .find(
        (o) =>
          o.kind === 'image' &&
          point.x >= o.rect.x0 &&
          point.x <= o.rect.x1 &&
          point.y >= o.rect.y0 &&
          point.y <= o.rect.y1,
      );
    if (!image) {
      this.shell.toasts.show({ kind: 'info', text: 'There is no image here' });
      return false;
    }
    // Render the image's own rectangle at its natural resolution, so a copy is the picture as
    // the file stores it rather than as the current zoom happens to show it.
    const dpi = image.imageWidth
      ? Math.min(1200, Math.max(72, (image.imageWidth / (image.rect.x1 - image.rect.x0)) * 72))
      : this.settingsValue.snapshotDpi;
    const shot = await renderSnapshot({
      engine: this.engine,
      doc: source.handle,
      page: point.page,
      rect: image.rect,
      dpi,
      annotations: false,
      forms: false,
      grayscale: false,
    });
    await writeClipboardImage(shot.png);
    this.shell.toasts.show({ kind: 'success', text: 'Image copied' });
    return true;
  }

  // ---- snapshot ---------------------------------------------------------------------------------

  /** Renders a marquee and puts it where the settings say. */
  async takeSnapshot(
    page: number,
    rect: PdfRect,
  ): Promise<{ width: number; height: number } | null> {
    const source = this.activeSource();
    const document = this.activeDocument();
    if (!source || !document) return null;
    const box = document.state.pages[page]?.cropBox;
    const region = box ? clampRegion(rect, box) : rect;
    const shot = await renderSnapshot({
      engine: this.engine,
      doc: source.handle,
      page,
      rect: region,
      dpi: this.settingsValue.snapshotDpi,
      annotations: true,
      forms: true,
      grayscale: false,
    });
    const target = this.settingsValue.snapshotTarget;
    if (target === 'clipboard' || target === 'both') await writeClipboardImage(shot.png);
    if (target === 'file' || target === 'both') await this.saveSnapshot(shot.png, document, page);
    this.shell.selection.set({ kind: 'region', page, rect: region });
    this.shell.toasts.show({
      kind: 'success',
      text: `Snapshot ${shot.width} × ${shot.height} px`,
    });
    return { width: shot.width, height: shot.height };
  }

  private async saveSnapshot(png: Uint8Array, document: Document, page: number): Promise<void> {
    if (!hasBridge()) return;
    const path = await invoke('file:saveAsDialog', {
      title: 'Save snapshot',
      buttonLabel: 'Save',
      defaultPath: snapshotFileName(document.state.title, page),
      filters: [{ name: 'PNG images', extensions: ['png'] }],
    });
    if (!path) return;
    await invoke('file:write', path, png.slice());
  }

  /** Exposed so the acceptance test can state a size without a canvas. */
  snapshotSize(rect: PdfRect): { width: number; height: number; scale: number } {
    return snapshotPixelSize(rect, this.settingsValue.snapshotDpi);
  }

  // ---- find bar ---------------------------------------------------------------------------------

  private ensureFindBar(): FindBar {
    if (this.findBar) return this.findBar;
    this.findBar = new FindBar({
      host: this.host,
      options: () => this.findOptions(),
      onQuery: (query) => {
        this.scheduleFind(query);
      },
      onNext: () => {
        this.findNext();
      },
      onPrevious: () => {
        this.findPrevious();
      },
      onClose: () => {
        this.closeFind();
      },
      onToggleOption: (name, value) => {
        void this.setFindOption(name, value);
      },
      onOpenPanel: () => {
        void this.openSearchPanel();
      },
    });
    return this.findBar;
  }

  get findBarOpen(): boolean {
    return this.findBar?.isOpen ?? false;
  }

  /** Ctrl+F. A selection becomes the query, as it does in every editor. */
  async openFind(initial?: string): Promise<void> {
    const bar = this.ensureFindBar();
    const seed = initial ?? (await this.seedQuery());
    bar.show(seed);
    if (seed && seed.length > 0) await this.runFind(seed);
  }

  private async seedQuery(): Promise<string> {
    const text = (await this.selectedText()).trim();
    if (text.length === 0 || text.length > 120 || text.includes('\n')) return '';
    return text;
  }

  closeFind(): void {
    this.findBar?.hide();
    const state = this.activeTab();
    state?.find.reset();
    state?.selection.repaint([]);
    this.activeViewer()?.focus();
  }

  private scheduleFind(query: string): void {
    if (this.queryTimer) clearTimeout(this.queryTimer);
    this.queryTimer = setTimeout(() => {
      this.queryTimer = null;
      void this.runFind(query);
    }, 140);
  }

  /** Runs a query over the active document. */
  async runFind(query: string): Promise<FindProgress | null> {
    const state = this.activeTab();
    const source = this.activeSource();
    if (!state || !source) return null;
    const startPage = this.activeViewer()?.state.page ?? 0;
    const progress = await state.find.run(source, query, this.findOptions(), startPage);
    this.revealCurrent(state);
    return progress;
  }

  findNext(): FindHit | null {
    const state = this.activeTab();
    if (!state) return null;
    const hit = state.find.next();
    this.revealCurrent(state);
    return hit;
  }

  findPrevious(): FindHit | null {
    const state = this.activeTab();
    if (!state) return null;
    const hit = state.find.previous();
    this.revealCurrent(state);
    return hit;
  }

  /** The find controller's current state, for the tests and the status bar. */
  findProgress(): FindProgress | null {
    return this.activeTab()?.find.progress ?? null;
  }

  private onFindUpdate(tabId: string, progress: FindProgress): void {
    if (this.shell.documents.state.active !== tabId) return;
    this.findBar?.setProgress(progress);
    const state = this.tabs.get(tabId);
    if (state) state.selection.repaint(this.findHighlights(state));
  }

  /** Every hit on a mounted page, with the current one emphasised. */
  private findHighlights(state: TabState): Highlight[] {
    const out: Highlight[] = [];
    const current = state.find.currentHit;
    for (const hit of state.find.progress.hits) {
      if (hit.source !== 'page') continue;
      const text = this.text.peek(state.tabId, hit.page);
      if (!text) continue;
      const kind = hit === current ? 'find-current' : 'find';
      for (const rect of spanRects(text, { start: hit.start, end: hit.end })) {
        out.push({ page: hit.page, rect, kind });
      }
    }
    return out;
  }

  /** Scrolls the current hit into view and selects it. */
  private revealCurrent(state: TabState): void {
    const hit = state.find.currentHit;
    const viewer = this.activeViewer();
    if (!hit || !viewer) {
      state.selection.repaint(this.findHighlights(state));
      return;
    }
    if (hit.source === 'page') {
      state.selection.apply({
        anchor: { page: hit.page, offset: hit.start },
        focus: { page: hit.page, offset: hit.end },
        granularity: 'character',
        column: null,
      });
      const text = this.text.peek(state.tabId, hit.page);
      const rect = text ? spanRects(text, { start: hit.start, end: hit.end })[0] : undefined;
      if (rect) state.highlighter.reveal(viewer.pane, hit.page, rect);
    } else if (hit.page >= 0) {
      viewer.goToPage(hit.page);
    }
    state.selection.repaint(this.findHighlights(state));
  }

  // ---- advanced search panel ---------------------------------------------------------------------

  get panel(): SearchPanelState {
    return this.panelState;
  }

  /** The interface `mountSearchPanel` renders. */
  panelHost(): SearchPanelHost {
    // A getter rather than a snapshot: the panel re-reads the state every render, and an
    // arrow keeps `this` without aliasing it.
    const currentState = (): SearchPanelState => this.panelState;
    return {
      get state(): SearchPanelState {
        return currentState();
      },
      settings: () => this.settingsValue,
      findOptions: () => this.findOptions(),
      setOption: (name, value) => {
        void this.setFindOption(name, value);
      },
      setProximity: (words) => {
        void this.setSetting('proximity', Math.max(0, Math.round(words)));
      },
      setScope: (scope) => {
        void this.setScope(scope);
      },
      setQuery: (query) => {
        this.setPanel({ query });
      },
      pickFolder: () => this.pickFolder(),
      search: () => this.runPanelSearch(),
      cancel: () => {
        this.cancelPanelSearch();
      },
      openHit: (hit) => this.openHit(hit),
      exportCsv: async () => {
        await this.exportResults();
      },
      subscribe: (listener) => {
        this.panelListeners.add(listener);
        return () => {
          this.panelListeners.delete(listener);
        };
      },
    };
  }

  async setScope(scope: SearchScope): Promise<void> {
    await this.setSetting('scope', scope);
    this.setPanel({ scope });
  }

  /** Sets the folder a folder search will look in, without the native picker. */
  setFolder(path: string): void {
    this.setPanel({ folder: path, scope: 'folder' });
  }

  async pickFolder(): Promise<string | null> {
    if (!hasBridge()) return null;
    const folder = await invoke('dialog:pickFolder', 'Choose a folder to search');
    if (folder) this.setPanel({ folder, scope: 'folder' });
    return folder;
  }

  /**
   * Opens the left pane on the search panel. `panels.show` rather than the generated
   * `panel.nav.search` command: that one *toggles*, so asking for the search panel while it is
   * already showing would put it away — which is not what "Advanced Search" means.
   */
  async openSearchPanel(query?: string): Promise<void> {
    if (query !== undefined) this.setPanel({ query });
    else if (this.findBar?.isOpen) this.setPanel({ query: this.findBar.query });
    try {
      this.registry.service<{ show(id: string): void }>(SERVICE.panels).show(SEARCH_PANEL_ID);
    } catch {
      // The panels service only exists once the shell has mounted; harmless in unit tests.
      await this.shell.run(`panel.${SEARCH_PANEL_ID}`).catch(() => undefined);
    }
  }

  /** Runs the panel's search in whatever scope it is set to. */
  async runPanelSearch(): Promise<void> {
    const query = this.panelState.query.trim();
    if (query.length === 0) {
      this.setPanel({ hits: [], error: 'Type something to search for' });
      return;
    }
    this.cancelPanelSearch();
    this.folderHits = [];
    this.setPanel({ hits: [], error: null, running: true, truncated: false, scanned: 0, total: 0 });
    switch (this.panelState.scope) {
      case 'document':
        await this.searchDocuments([this.shell.documents.state.active].filter(Boolean) as string[]);
        break;
      case 'open':
        await this.searchDocuments(this.shell.documents.tabs.map((t) => t.id));
        break;
      case 'folder':
        await this.searchFolder(query);
        break;
    }
  }

  private async searchDocuments(tabIds: ReadonlyArray<string>): Promise<void> {
    const query = this.panelState.query.trim();
    const options = this.findOptions();
    const hits: SearchHit[] = [];
    try {
      for (const tabId of tabIds) {
        const source = this.sourceFor(tabId);
        const tab = this.shell.documents.get(tabId);
        if (!source || !tab) continue;
        this.setPanel({ total: source.pageCount, file: tab.title });
        const controller = new FindController({
          engine: this.engine,
          text: this.text,
          onUpdate: (progress) => {
            this.setPanel({ scanned: progress.scannedPages });
          },
        });
        const progress = await controller.run(source, query, options, 0);
        for (const hit of progress.hits) {
          hits.push({
            documentId: tab.path ?? tab.id,
            documentName: tab.title,
            page: hit.page,
            source: hit.source,
            start: hit.start,
            end: hit.end,
            snippet: hit.snippet,
            ...(hit.label !== undefined ? { label: hit.label } : {}),
          });
          if (hits.length >= this.settingsValue.maxHits) {
            this.setPanel({ hits: sortHits(hits), running: false, truncated: true });
            return;
          }
        }
      }
      this.setPanel({ hits: sortHits(hits), running: false });
    } catch (error) {
      this.setPanel({
        running: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async searchFolder(query: string): Promise<void> {
    const folder = this.panelState.folder;
    if (!folder) {
      this.setPanel({ running: false, error: 'Choose a folder first' });
      return;
    }
    if (!hasBridge()) {
      this.setPanel({ running: false, error: 'Folder search needs the desktop app' });
      return;
    }
    const options = this.findOptions();
    try {
      this.searchJob = await invoke('search:folder', {
        root: folder,
        query,
        recursive: this.settingsValue.recursive,
        maxHits: this.settingsValue.maxHits,
        options: {
          matchCase: options.matchCase,
          wholeWord: options.wholeWord,
          regex: options.regex,
          ignoreDiacritics: options.ignoreDiacritics,
          proximity: options.proximity,
          includeBookmarks: options.includeBookmarks,
          includeComments: options.includeComments,
          includeFormFields: options.includeFormFields,
        },
      });
    } catch (error) {
      this.setPanel({
        running: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private onFolderResults(jobId: string, hits: ReadonlyArray<FolderSearchHit>): void {
    if (jobId !== this.searchJob) return;
    for (const hit of hits) {
      this.folderHits.push({
        documentId: hit.path,
        documentName: hit.name,
        page: hit.page,
        source: hit.source,
        start: hit.start,
        end: hit.end,
        snippet: hit.snippet,
        ...(hit.label !== undefined ? { label: hit.label } : {}),
      });
    }
    this.setPanel({ hits: sortHits(this.folderHits) });
  }

  cancelPanelSearch(): void {
    if (this.searchJob && hasBridge()) void invoke('search:cancel', this.searchJob);
    this.searchJob = null;
    if (this.panelState.running) this.setPanel({ running: false });
  }

  /** Clicking a result: open the document if it is not open, go to the page, select the hit. */
  async openHit(hit: SearchHit): Promise<void> {
    const open = this.shell.documents.tabs.find(
      (t) => t.path === hit.documentId || t.id === hit.documentId,
    );
    if (!open) {
      if (!hasBridge()) return;
      const file = await invoke('file:read', hit.documentId);
      await this.shell.run('file.openBytes', { file });
    } else {
      this.shell.documents.activate(open.id);
    }
    const tabId = this.shell.documents.state.active;
    if (!tabId) return;
    this.syncActive();
    const state = this.tabs.get(tabId);
    const source = this.sourceFor(tabId);
    const viewer = this.viewerService()?.get(tabId);
    if (!state || !source || !viewer || hit.page < 0) return;
    await this.text.page(source, hit.page);
    if (hit.source === 'page') {
      state.selection.apply({
        anchor: { page: hit.page, offset: hit.start },
        focus: { page: hit.page, offset: hit.end },
        granularity: 'character',
        column: null,
      });
      const text = this.text.peek(tabId, hit.page);
      const rect = text ? spanRects(text, { start: hit.start, end: hit.end })[0] : undefined;
      if (rect) state.highlighter.reveal(viewer.pane, hit.page, rect);
      else viewer.goToPage(hit.page);
    } else {
      viewer.goToPage(hit.page);
    }
  }

  /** Writes the results as CSV. */
  async exportResults(): Promise<string | null> {
    const hits = this.panelState.hits;
    if (hits.length === 0) return null;
    if (!hasBridge()) return null;
    const path = await invoke('file:saveAsDialog', {
      title: 'Export search results',
      buttonLabel: 'Export',
      defaultPath: 'search-results.csv',
      filters: [{ name: 'Comma-separated values', extensions: ['csv'] }],
    });
    if (!path) return null;
    await invoke('file:write', path, csvBytes(hits));
    this.shell.toasts.show({ kind: 'success', text: `Exported ${hits.length} results` });
    return path;
  }

  private setPanel(patch: Partial<SearchPanelState>): void {
    this.panelState = { ...this.panelState, ...patch };
    this.notifyPanel();
  }

  private notifyPanel(): void {
    for (const listener of [...this.panelListeners]) listener(this.panelState);
  }

  // ---- printing ---------------------------------------------------------------------------------

  /** The plan for the active document under some settings — the dialog and the tests read it. */
  planFor(settings: PrintSettings): PrintPlan {
    const document = this.activeDocument();
    const viewer = this.activeViewer();
    const pageSizes = (document?.state.pages ?? []).map((page) => {
      const size = pageSizeOf(page);
      return { width: size.width, height: size.height };
    });
    return this.print.plan({
      settings,
      pageSizes,
      currentPage: viewer?.state.page ?? 0,
      selectedPages: this.selectedPages(),
    });
  }

  /** Opens the print dialog and carries out whatever it says. */
  async openPrint(overrides: Partial<PrintSettings> = {}): Promise<'printed' | 'saved' | null> {
    const document = this.activeDocument();
    const source = this.activeSource();
    if (!document || !source) return null;
    const printers = await this.print.printers();
    const start: PrintSettings = {
      ...(this.settingsValue.rememberPrint ? this.printSettings : DEFAULT_PRINT_SETTINGS),
      ...overrides,
    };
    const result = await openPrintDialog({
      dialogs: this.shell.dialogs,
      settings: start,
      printers,
      pageCount: document.pageCount,
      hasSelection: this.hasSelection(),
      plan: (settings) => this.planFor(settings),
      preview: (sheet, settings) =>
        this.print.previewUrl(
          sheet,
          { engine: this.engine, doc: source.handle, title: document.state.title },
          settings,
        ),
    });
    if (!result) return null;
    this.printSettings = result.settings;
    if (this.settingsValue.rememberPrint) await writePrintSettings(this.storage, result.settings);
    return result.action === 'print'
      ? await this.runPrint(result.settings)
      : await this.runPrintToPdf(result.settings);
  }

  /** Prints without asking — the dialog has already been answered, or a test drove it. */
  async runPrint(settings: PrintSettings, dryRun = false): Promise<'printed' | null> {
    const document = this.activeDocument();
    const source = this.activeSource();
    if (!document || !source) return null;
    const plan = this.planFor(settings);
    if (plan.error) {
      await this.shell.dialogs.error('Print', plan.error);
      return null;
    }
    const progress = this.shell.dialogs.progress({
      title: 'Printing',
      text: `Preparing ${plan.sheets.length} sheets`,
      cancellable: true,
    });
    try {
      const result = await this.print.print({
        source: { engine: this.engine, doc: source.handle, title: document.state.title },
        plan,
        settings,
        signal: progress.signal,
        ...(dryRun ? { dryRun: true } : {}),
        onProgress: (done, total) => {
          progress.set(done / total, `Sheet ${done} of ${total}`);
        },
      });
      progress.close();
      if (result.error) {
        await this.shell.dialogs.error('Print', result.error);
        return null;
      }
      this.shell.toasts.show({
        kind: 'success',
        text: result.printed ? `Sent ${result.sheets} sheets to the printer` : 'Print job prepared',
      });
      return 'printed';
    } catch (error) {
      progress.close();
      await this.shell.dialogs.error(
        'Print',
        error instanceof Error ? error.message : String(error),
      );
      return null;
    }
  }

  /**
   * Builds the whole print job in main — sheets, temporary folder, print document — without
   * sending it to a printer. The e2e suite uses it to prove the pipeline end to end on a
   * machine with no printer attached.
   */
  async printDryRun(settings: PrintSettings): Promise<{
    sheets: number;
    documentPath: string | null;
    error: string | null;
  } | null> {
    const document = this.activeDocument();
    const source = this.activeSource();
    if (!document || !source) return null;
    const plan = this.planFor(settings);
    if (plan.error) return { sheets: 0, documentPath: null, error: plan.error };
    const result = await this.print.print({
      source: { engine: this.engine, doc: source.handle, title: document.state.title },
      plan,
      settings,
      dryRun: true,
    });
    return {
      sheets: result.sheets,
      documentPath: result.documentPath,
      error: result.error ?? null,
    };
  }

  /** "Print to PDF": the same imposition, written to a file. */
  async runPrintToPdf(settings: PrintSettings, path?: string): Promise<'saved' | null> {
    const document = this.activeDocument();
    const source = this.activeSource();
    if (!document || !source) return null;
    const plan = this.planFor(settings);
    if (plan.error) {
      await this.shell.dialogs.error('Print to PDF', plan.error);
      return null;
    }
    let target = path ?? null;
    if (!target) {
      if (!hasBridge()) return null;
      target = await invoke('file:saveAsDialog', {
        title: 'Print to PDF',
        buttonLabel: 'Save',
        defaultPath: document.state.title.replace(/\.pdf$/i, '') + ' (printed).pdf',
      });
    }
    if (!target) return null;
    const progress = this.shell.dialogs.progress({
      title: 'Print to PDF',
      text: `Imposing ${plan.sheets.length} sheets`,
      cancellable: true,
    });
    try {
      const bytes = await this.print.toPdf({
        source: { engine: this.engine, doc: source.handle, title: document.state.title },
        plan,
        settings,
        signal: progress.signal,
        onProgress: (done, total) => {
          progress.set(done / total, `Sheet ${done} of ${total}`);
        },
      });
      if (hasBridge()) await invoke('file:write', target, bytes);
      progress.close();
      this.shell.toasts.show({ kind: 'success', text: `Wrote ${plan.sheets.length} sheets` });
      return 'saved';
    } catch (error) {
      progress.close();
      await this.shell.dialogs.error(
        'Print to PDF',
        error instanceof Error ? error.message : String(error),
      );
      return null;
    }
  }

  // ---- lifecycle --------------------------------------------------------------------------------

  dispose(): void {
    if (this.queryTimer) clearTimeout(this.queryTimer);
    this.cancelPanelSearch();
    for (const d of this.disposers.splice(0)) d();
    for (const tabId of [...this.tabs.keys()]) this.releaseTab(tabId);
    this.findBar?.dispose();
    this.findBar = null;
    this.text.clear();
  }
}

export { SERVICE, isEmpty };

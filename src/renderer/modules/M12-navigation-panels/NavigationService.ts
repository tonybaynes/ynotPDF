/**
 * `NavigationService` (M12) — what the five navigation panels share. Registered as
 * `"navigation"`.
 *
 * It owns:
 * - **the settings**, including `ui.leftPaneOnOpen`, which it applies on every document open —
 *   Pages by default, and a file asking for `/UseOutlines` does not get to override the reader;
 * - **the thumbnail renderer** and its cache, kept out of M11's tile cache on purpose;
 * - **navigation**: turning a destination into a scroll position through `destinationView`, and
 *   describing the current view as a destination for "create from current view";
 * - **attachments and portfolios**: opening an embedded file in a new tab or in the OS, saving
 *   one to disk, and reading the `/Collection` schema a portfolio carries.
 *
 * The panels themselves are DOM and nothing else; every decision is here or in a `Command`.
 */

import type { ShellServices } from '@app/services';
import { SERVICE } from '@app/services';
import type { PanelsService } from '@app/panes/NavPane';
import type { DocumentTab } from '@app/tabs/Documents';
import type { Document } from '@core/Document';
import type { ModelId } from '@core/Ids';
import type { ModelAttachment, ModelDestination } from '@core/model';
import type { Registry } from '@core/Registry';
import type { EngineClient } from '@engine/EngineClient';
import type { PdfCollection } from '@engine/PdfEngine';
import { hasBridge, invoke } from '@shared/ipc';
import { DOCUMENT_SERVICE, type DocumentService } from '@modules/M20-document-model/manifest';
import { VIEWER_SERVICE, type ViewerService } from '@modules/M11-viewer/manifest';
import type { Viewer } from '@modules/M11-viewer/manifest';
import type { DestinationSpec } from './commands';
import {
  destinationFromView,
  destinationView,
  scrollLeftFor,
  scrollTopFor,
} from './destinations/navigate';
import {
  DEFAULT_NAVIGATION_SETTINGS,
  ipcSettingsStorage,
  readNavigationSettings,
  writeNavigationSetting,
  type NavigationSettings,
  type SettingsStorage,
} from './settings';
import { paneWidthFor } from './thumbnails/grid';
import { ThumbnailRenderer } from './thumbnails/ThumbnailRenderer';

export const NAVIGATION_SERVICE = 'navigation';

/** Panel ids, so the commands, the shell and the tests name the same panels. */
export const PANEL_ID = {
  pages: 'nav.pages',
  bookmarks: 'nav.bookmarks',
  layers: 'nav.layers',
  attachments: 'nav.attachments',
  destinations: 'nav.destinations',
} as const;

export interface NavigationServiceOptions {
  readonly registry: Registry;
  readonly shell: ShellServices;
  readonly client: EngineClient;
  readonly storage?: SettingsStorage;
}

/** What a panel needs to know about the document it is showing. */
export interface PanelContext {
  readonly tab: DocumentTab;
  readonly document: Document;
}

export class NavigationService {
  readonly thumbnails: ThumbnailRenderer;
  private readonly registry: Registry;
  private readonly shell: ShellServices;
  private readonly storage: SettingsStorage;
  private settingsValue: NavigationSettings = DEFAULT_NAVIGATION_SETTINGS;
  private readonly settingsListeners = new Set<(settings: NavigationSettings) => void>();
  private readonly disposers: Array<() => void> = [];
  private readonly collections = new Map<string, PdfCollection | null>();
  /** Tabs whose "which panel opens" decision has already been made. */
  private readonly opened = new Set<string>();
  /** Tabs opened from inside a portfolio, so a Save reaches for Save As. */
  readonly fromPortfolio = new Set<string>();
  /**
   * What each panel has selected. The panels own the DOM; the *commands* need to know what a
   * palette entry or a shortcut would act on, and this is where the two meet.
   */
  selectedBookmark: ModelId | null = null;
  selectedDestination: ModelId | null = null;
  selectedAttachment: ModelId | null = null;
  /**
   * The layer visibility each open document started with, so "reset to initial visibility" has
   * something to return to. Filled by the Layers panel the first time it renders a document.
   */
  readonly initialLayerState = new Map<string, Readonly<Record<string, boolean>>>();
  /** Whether the pane has already been sized to one column of thumbnails this session. */
  private paneFitted = false;

  constructor(options: NavigationServiceOptions) {
    this.registry = options.registry;
    this.shell = options.shell;
    this.storage = options.storage ?? ipcSettingsStorage();
    this.thumbnails = new ThumbnailRenderer({
      client: options.client,
      viewerBusy: () => this.viewerBusy(),
    });
    this.disposers.push(
      this.shell.documents.onAttached((tab) => {
        void this.documentOpened(tab);
      }),
      this.shell.documents.onClosed((tab) => {
        this.thumbnails.forget(tab.id);
        this.collections.delete(tab.id);
        this.opened.delete(tab.id);
        this.fromPortfolio.delete(tab.id);
      }),
    );
  }

  // ---- settings ------------------------------------------------------------------------------

  get settings(): NavigationSettings {
    return this.settingsValue;
  }

  async load(): Promise<void> {
    this.settingsValue = await readNavigationSettings(this.storage);
    this.notifySettings();
  }

  async setSetting<K extends keyof NavigationSettings>(
    name: K,
    value: NavigationSettings[K],
  ): Promise<NavigationSettings[K]> {
    this.settingsValue = { ...this.settingsValue, [name]: value };
    await writeNavigationSetting(this.storage, name, value);
    this.notifySettings();
    return value;
  }

  onSettingsChange(listener: (settings: NavigationSettings) => void): () => void {
    this.settingsListeners.add(listener);
    return () => {
      this.settingsListeners.delete(listener);
    };
  }

  private notifySettings(): void {
    for (const listener of Array.from(this.settingsListeners)) listener(this.settingsValue);
  }

  // ---- what a panel subscribes to ---------------------------------------------------------------

  get documents(): ShellServices['documents'] {
    return this.shell.documents;
  }

  get ui(): ShellServices['ui'] {
    return this.shell.ui;
  }

  /** Runs a registered command by id — how a panel's buttons reach the palette's commands. */
  run(commandId: string, args?: Readonly<Record<string, unknown>>): Promise<unknown> {
    return this.shell.run(commandId, args);
  }

  get dialogs(): ShellServices['dialogs'] {
    return this.shell.dialogs;
  }

  /**
   * The one subscription a panel needs: fires when the active tab changes, when the active
   * document changes in any way, and — when `view` is asked for — when the reader moves to
   * another page. Re-subscribes to the new document itself, so a panel never has to.
   */
  watch(listener: () => void, options: { readonly view?: boolean } = {}): () => void {
    let stopDocument: (() => void) | null = null;
    let watched: Document | null = null;
    const rebind = (): void => {
      const document = this.document;
      if (document === watched) return;
      stopDocument?.();
      watched = document;
      stopDocument = document
        ? document.store.subscribe(() => {
            listener();
          })
        : null;
    };
    const stops: Array<() => void> = [
      this.shell.documents.subscribe(() => {
        rebind();
        listener();
      }),
    ];
    if (options.view === true) {
      stops.push(
        this.shell.ui.select(
          (state) => state.view.page,
          () => {
            listener();
          },
          { immediate: false },
        ),
      );
    }
    rebind();
    return () => {
      stopDocument?.();
      for (const stop of stops) stop();
    };
  }

  // ---- the document and the viewer -------------------------------------------------------------

  get panels(): PanelsService | null {
    return this.registry.hasService(SERVICE.panels)
      ? this.registry.service<PanelsService>(SERVICE.panels)
      : null;
  }

  /** The document of the active tab, or null. */
  get document(): Document | null {
    if (!this.registry.hasService(DOCUMENT_SERVICE)) return null;
    return this.registry.service<DocumentService>(DOCUMENT_SERVICE).active;
  }

  /** The document plus its tab, which is what a panel binds to. */
  get context(): PanelContext | null {
    const tab = this.shell.documents.active;
    const document = this.document;
    return tab && document ? { tab, document } : null;
  }

  get viewer(): Viewer | null {
    if (!this.registry.hasService(VIEWER_SERVICE)) return null;
    return this.registry.service<ViewerService>(VIEWER_SERVICE).active;
  }

  /** True while the main view has renders outstanding — thumbnails wait for it. */
  private viewerBusy(): boolean {
    if (!this.registry.hasService(VIEWER_SERVICE)) return false;
    const stats = this.registry.service<ViewerService>(VIEWER_SERVICE).renderer.stats();
    return stats.queued + stats.inFlight > 0;
  }

  /** 0-based current page of the active viewer. */
  get currentPage(): number {
    const page = this.shell.ui.get().view.page;
    return page > 0 ? page - 1 : 0;
  }

  /** Jumps the viewer to a page (0-based). */
  goToPage(page: number): void {
    const viewer = this.viewer;
    if (viewer) viewer.goToPage(page);
    else this.shell.ui.set((s) => ({ view: { ...s.view, page: page + 1 } }));
  }

  /**
   * Navigates to a destination: page, zoom and scroll offset, through the one conversion in
   * `destinations/navigate.ts`. Falls back to the page alone when there is no live viewport —
   * which is what a headless unit test and a document that has not been laid out both have.
   */
  goToDestination(
    dest: Pick<ModelDestination, 'pageId' | 'fit' | 'left' | 'top' | 'zoom' | 'rect'>,
  ): boolean {
    const document = this.document;
    if (!document || dest.pageId === null) return false;
    const index = document.pageIndex(dest.pageId);
    if (index < 0) return false;
    const viewer = this.viewer;
    if (!viewer) {
      this.goToPage(index);
      return true;
    }
    const size = document.pageSize(dest.pageId);
    const scroller = viewer.pane.scroller.getBoundingClientRect();
    const view = destinationView(
      dest,
      { width: size?.width ?? 612, height: size?.height ?? 792 },
      { width: scroller.width, height: scroller.height },
    );
    if (view.fit !== null) viewer.setFit(view.fit);
    else if (view.zoom !== null) viewer.setZoom(Math.round(view.zoom * 100));
    viewer.goToPage(index);
    const rect = viewer.pane.layoutTable.rects.find((r) => r.page === index);
    if (rect) {
      const zoom = viewer.pane.zoom;
      viewer.pane.setScroll({
        left: scrollLeftFor(view, rect.x, zoom) ?? viewer.pane.state.scrollLeft,
        top: scrollTopFor(view, rect.y, zoom),
      });
    }
    viewer.syncOverlays();
    return true;
  }

  /**
   * The current view as a destination — "create from current view", "set destination to current
   * view". `/XYZ` at the live zoom, which is what Foxit records and the only mode that survives
   * a different window size unchanged.
   */
  currentDestination(): DestinationSpec | null {
    const document = this.document;
    if (!document) return null;
    const index = this.currentPage;
    const page = document.state.pages[index];
    if (!page) return null;
    const viewer = this.viewer;
    const size = document.pageSize(page.id) ?? { width: 612, height: 792 };
    if (!viewer) {
      return { pageId: page.id, fit: 'xyz', left: 0, top: size.height, zoom: 1, rect: null };
    }
    const rect = viewer.pane.layoutTable.rects.find((r) => r.page === index);
    const zoom = viewer.pane.zoom;
    const state = viewer.state;
    // How far into the page the top of the viewport has reached, in points.
    const topPoints = rect ? Math.max(0, (state.scrollTop - rect.y) / Math.max(zoom, 0.0001)) : 0;
    const leftPoints = rect ? Math.max(0, (state.scrollLeft - rect.x) / Math.max(zoom, 0.0001)) : 0;
    const spec = destinationFromView({
      page: { width: size.width, height: size.height },
      topPoints,
      leftPoints,
      zoom,
    });
    return { pageId: page.id, ...spec };
  }

  // ---- rendering -----------------------------------------------------------------------------

  /**
   * Everything about a tab's pages may look different now — a layer was toggled, a page rotated.
   * Drops the tab's thumbnails and the viewer's tiles, and repaints.
   */
  invalidateRender(tabId: string): void {
    this.thumbnails.invalidate(tabId);
    if (!this.registry.hasService(VIEWER_SERVICE)) return;
    const service = this.registry.service<ViewerService>(VIEWER_SERVICE);
    service.renderer.forget(tabId);
    service.get(tabId)?.refresh();
  }

  // ---- the left pane -----------------------------------------------------------------------------

  /**
   * Applies `ui.leftPaneOnOpen` to a document that has just opened — the operator's requirement:
   * **Pages, unless the setting says otherwise**. A portfolio is the one exception, because its
   * pages are a cover sheet and its content is the attachment list.
   */
  private async documentOpened(tab: DocumentTab): Promise<void> {
    if (this.opened.has(tab.id)) return;
    const document = this.registry.hasService(DOCUMENT_SERVICE)
      ? this.registry.service<DocumentService>(DOCUMENT_SERVICE).get(tab.id)
      : null;
    if (!document) return;
    this.opened.add(tab.id);
    const collection = await this.loadCollection(tab.id, document);
    const panels = this.panels;
    if (!panels) return;
    if (collection !== null && this.settingsValue.openAttachmentsPanel) {
      panels.show(PANEL_ID.attachments);
      return;
    }
    switch (this.settingsValue.leftPaneOnOpen) {
      case 'pages':
        panels.show(PANEL_ID.pages);
        break;
      case 'bookmarks':
        // Bookmarks with nothing to show would be a blank pane; Pages is the honest fallback.
        panels.show(document.state.outline.length > 0 ? PANEL_ID.bookmarks : PANEL_ID.pages);
        break;
      case 'closed':
        panels.collapse();
        break;
      case 'last-used':
        // M02's own behaviour: whatever was open stays open.
        break;
    }
  }

  /**
   * Sizes the pane to exactly one column the first time the Pages panel is shown in this
   * session — the operator's rule that it "opens as a single column ... the panel's initial
   * width is whatever one thumbnail plus margins needs". Afterwards the reader's own splitter
   * drag is left alone, which is what makes the extra columns theirs to ask for.
   */
  fitPaneToOneColumn(): boolean {
    if (this.paneFitted) return false;
    this.paneFitted = true;
    this.setPaneWidth(paneWidthFor(this.settingsValue.thumbnailSize));
    return true;
  }

  /** Sets the thumbnail size and the pane width that shows exactly one column of it. */
  async setThumbnailSize(size: number): Promise<number> {
    await this.setSetting('thumbnailSize', size);
    this.setPaneWidth(paneWidthFor(size));
    return size;
  }

  /** Widens or narrows the navigation pane (clamped by the shell). */
  setPaneWidth(width: number): void {
    this.shell.ui.set((s) => ({ leftPane: { ...s.leftPane, width, collapsed: false } }));
  }

  // ---- portfolios and attachments -----------------------------------------------------------------

  /** The `/Collection` of a tab's document, read once and remembered. */
  async loadCollection(tabId: string, document: Document): Promise<PdfCollection | null> {
    const cached = this.collections.get(tabId);
    if (cached !== undefined) return cached;
    const collection = await document.engine.collection(document.handle).catch(() => null);
    this.collections.set(tabId, collection);
    return collection;
  }

  /** The active tab's collection, if it has been read. */
  get collection(): PdfCollection | null {
    const tab = this.shell.documents.active;
    return tab ? (this.collections.get(tab.id) ?? null) : null;
  }

  get isPortfolio(): boolean {
    return this.collection !== null;
  }

  /**
   * The open document that holds an attachment — the active one first, then any other tab.
   *
   * Opening an embedded PDF activates the tab it goes into, so a second "open" would otherwise
   * be looking for the next attachment in the file that has just arrived rather than in the
   * portfolio it came from.
   */
  documentOwning(attachmentId: ModelId): Document | null {
    const active = this.document;
    if (active?.attachment(attachmentId)) return active;
    if (!this.registry.hasService(DOCUMENT_SERVICE)) return null;
    for (const document of this.registry.service<DocumentService>(DOCUMENT_SERVICE).all()) {
      if (document.attachment(attachmentId)) return document;
    }
    return null;
  }

  /** The bytes of an attachment. */
  async attachmentBytes(document: Document, attachment: ModelAttachment): Promise<Uint8Array> {
    return await document.engine.attachmentData(document.handle, attachment.engineId);
  }

  /**
   * Opens an attachment. An embedded PDF opens **in a new tab** — the portfolio requirement —
   * with no path, so it is unsaved until the reader chooses where it goes. Anything else is
   * handed to the OS through a temporary file.
   */
  async openAttachment(attachmentId: ModelId): Promise<'tab' | 'os' | 'failed'> {
    const document = this.documentOwning(attachmentId);
    const attachment = document?.attachment(attachmentId);
    if (!document || !attachment) return 'failed';
    const bytes = await this.attachmentBytes(document, attachment);
    if (bytes.length === 0) {
      this.toast('error', `${attachment.name} is empty`);
      return 'failed';
    }
    if (isPdf(attachment.name, attachment.mimeType, bytes)) {
      const opened = await this.openBytesInTab(attachment.name, bytes);
      return opened ? 'tab' : 'failed';
    }
    if (!hasBridge()) return 'failed';
    try {
      await invoke('shell:openTempFile', attachment.name, bytes);
      return 'os';
    } catch (error) {
      this.toast('error', `Could not open ${attachment.name}: ${messageOf(error)}`);
      return 'failed';
    }
  }

  /** Opens PDF bytes as a new, path-less tab (an embedded file from a portfolio). */
  async openBytesInTab(name: string, bytes: Uint8Array): Promise<boolean> {
    if (!this.registry.hasService(DOCUMENT_SERVICE)) return false;
    const service = this.registry.service<DocumentService>(DOCUMENT_SERVICE);
    try {
      // The engine transfers the buffer into its worker, which detaches it — hand it a copy so
      // the panel can still offer "Save as" for the same attachment afterwards.
      const opened = await service.open(bytes.slice(), { path: null, name, title: name });
      this.fromPortfolio.add(opened.tab.id);
      if (this.registry.hasService(VIEWER_SERVICE)) {
        await this.registry
          .service<ViewerService>(VIEWER_SERVICE)
          .attach(opened.tab, opened.document);
      }
      return true;
    } catch (error) {
      this.toast('error', `Could not open ${name}: ${messageOf(error)}`);
      return false;
    }
  }

  /** Saves an attachment to a path the reader chooses. Returns the path, or null. */
  async saveAttachment(attachmentId: ModelId): Promise<string | null> {
    const document = this.documentOwning(attachmentId);
    const attachment = document?.attachment(attachmentId);
    if (!document || !attachment || !hasBridge()) return null;
    const bytes = await this.attachmentBytes(document, attachment);
    const path = await invoke('file:saveAsDialog', {
      defaultPath: attachment.name,
      title: `Save ${attachment.name}`,
      buttonLabel: 'Save',
    });
    if (path === null) return null;
    await invoke('file:write', path, bytes);
    this.toast('success', `Saved ${attachment.name}`);
    return path;
  }

  /**
   * Opens a bookmark's URI action. Only `http(s)` reaches the OS browser — a `file:` or a
   * `javascript:` URL inside a PDF is not something a viewer should follow on a click.
   */
  async openUri(uri: string): Promise<boolean> {
    if (!/^https?:\/\//i.test(uri)) {
      this.toast('error', `This bookmark points at ${uri}, which ynotPDF will not open.`);
      return false;
    }
    if (!hasBridge()) return false;
    try {
      await invoke('shell:openExternal', uri);
      return true;
    } catch (error) {
      this.toast('error', `Could not open ${uri}: ${messageOf(error)}`);
      return false;
    }
  }

  /** Asks for files to attach. Empty when the reader cancelled or there is no shell. */
  async chooseFiles(): Promise<ReadonlyArray<{ name: string; bytes: Uint8Array }>> {
    if (!hasBridge()) return [];
    const files = await invoke('file:openFilesDialog', {
      title: 'Choose files to attach',
      buttonLabel: 'Attach',
      multiple: true,
    });
    return files.map((f) => ({ name: f.name, bytes: f.bytes }));
  }

  /** A worded toast — the kind word is part of the toast itself, never a colour alone. */
  private toast(kind: 'error' | 'success', text: string): void {
    this.shell.toasts.show({ kind, text });
  }

  dispose(): void {
    for (const d of this.disposers.splice(0)) d();
    this.thumbnails.dispose();
    this.settingsListeners.clear();
    this.collections.clear();
  }
}

/**
 * Whether an attachment is a PDF.
 *
 * The extension and the bytes are believed before the declared MIME type, because real files
 * lie about it: the operator's own Foxit-made portfolio declares `/Subtype /text#2Fplain` on
 * three embedded PDFs. A viewer that trusted that would hand a PDF to Notepad.
 */
export function isPdf(
  name: string,
  mimeType: string | null | undefined,
  bytes?: Uint8Array,
): boolean {
  if (name.toLowerCase().endsWith('.pdf')) return true;
  if ((bytes?.length ?? 0) >= 5 && bytes) {
    if (String.fromCharCode(...bytes.subarray(0, 5)) === '%PDF-') return true;
  }
  return mimeType?.toLowerCase().includes('pdf') ?? false;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * `ViewerService` — one `Viewer` per document tab, and the bridge between the viewer and the
 * rest of the app (M11). Registered as the service `"viewer"`.
 *
 * What it owns:
 * - **Opening.** `open(file)` turns bytes into a `Document` (through M20's `DocumentService`),
 *   a tab and a viewport, prompting for a password and retrying while the file asks for one.
 * - **The store.** M02 registered `view.*` commands that write `ui.view`; this service is what
 *   makes them mean something, and it writes the viewport's own state back so the status bar,
 *   the ribbon toggles and the tests all read one object.
 * - **Per-document memory.** Scroll position, zoom, layout and guides are written under a hash
 *   of the document's path and restored when it is reopened.
 * - **Full screen and reading mode**, which are window-level rather than per-tab.
 */

import { icon } from '@app/icons';
import type { ShellServices } from '@app/services';
import { SERVICE } from '@app/services';
import type { Documents, DocumentTab } from '@app/tabs/Documents';
import type { Registry } from '@core/Registry';
import { shallowEqual } from '@core/Store';
import type { Document } from '@core/Document';
import type { EngineClient } from '@engine/EngineClient';
import { hasBridge, invoke, type OpenedFile } from '@shared/ipc';
import type { ToolSpec } from '@shared/module';
import type { ThemeManager } from '@theme/ThemeManager';
import { THEME_SERVICE } from '@modules/M01-theme-system/manifest';
import { DOCUMENT_SERVICE, type DocumentService } from '@modules/M20-document-model/manifest';
import type { OpenedDocument } from '@modules/M20-document-model/DocumentService';
import type {
  PreparedSecurityOpen,
  SecurityService,
} from '@modules/M70-encryption/SecurityService';
// A type, so this import disappears at compile time and M11 gains no dependency on M100 in the
// bundle. The service is optional and looked up by name (ADR 0019 §2).
import type { RepairService } from '@modules/M100-optimise-repair/OptimiseService';
import { megabytes } from '@view/TileCache';
import { TileRenderer, type RenderFlags } from '@view/TileRenderer';
import { FALLBACK_PALETTE, parseColor, type NightPalette } from '@view/night';
import { GuideSet } from '@view/guides';
import type { LayoutMode } from '@view/layout';
import { factor, percent, type FitMode } from '@view/zoom';
import type { ViewportState } from '@view/DocumentView';
import { DEFAULT_OVERLAY_STATE, type OverlayState } from '@view/Overlays';
import type { ViewState } from '@app/ui/UiState';
import { Viewer, type SplitOrientation } from './Viewer';
import { openWithPassword } from './password';
import {
  DEFAULT_SETTINGS,
  ipcSettingsStorage,
  readDocumentState,
  readSettings,
  writeDocumentState,
  writeSetting,
  type SettingsStorage,
  type ViewerSettings,
} from './settings';

export const VIEWER_SERVICE = 'viewer';

export interface ViewerServiceOptions {
  readonly registry: Registry;
  readonly shell: ShellServices;
  readonly host: HTMLElement;
  readonly client: EngineClient;
  readonly storage?: SettingsStorage;
}

export class ViewerService {
  readonly renderer: TileRenderer;
  private readonly registry: Registry;
  private readonly shell: ShellServices;
  private readonly documents: Documents;
  private readonly host: HTMLElement;
  private readonly storage: SettingsStorage;
  private readonly viewers = new Map<string, Viewer>();
  private readonly disposers: Array<() => void> = [];
  private settingsValue: ViewerSettings = DEFAULT_SETTINGS;
  private overlayState: OverlayState = DEFAULT_OVERLAY_STATE;
  private readingMode = false;
  private readingBar: HTMLElement | null = null;
  private pushingState = false;
  private applying = false;
  private invalidatePending = false;
  private disposed = false;
  /** `setTimeout` handles: `number` in the DOM, `Timeout` under Node's types. */
  private readonly rememberTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /**
   * The last state each tab reported. Closing a tab hides its viewport before `onClosed` fires,
   * and a hidden element's `scrollTop` reads 0 — so the place is written from here, not from a
   * live measurement taken after the lights have gone out.
   */
  private readonly lastState = new Map<string, ViewportState>();
  /** Tabs whose remembered place is still being applied; their state is not news yet. */
  private readonly restoring = new Set<string>();

  constructor(options: ViewerServiceOptions) {
    this.registry = options.registry;
    this.shell = options.shell;
    this.documents = options.shell.documents;
    this.host = options.host;
    this.storage = options.storage ?? ipcSettingsStorage();
    this.renderer = new TileRenderer({
      client: options.client,
      cacheBytes: megabytes(DEFAULT_SETTINGS.cacheMegabytes),
      palette: () => this.nightPalette(),
    });
    this.disposers.push(
      this.documents.subscribe((state) => {
        this.showActive(state.active);
      }),
    );
    this.disposers.push(
      this.documents.onClosed((tab) => {
        void this.closeTab(tab);
      }),
    );

    // Night Mode is M01's toggle; the raster follows it live.
    if (this.registry.hasService(THEME_SERVICE)) {
      const themes = this.registry.service<ThemeManager>(THEME_SERVICE);
      this.disposers.push(
        themes.onChange(() => {
          for (const viewer of this.viewers.values()) {
            viewer.setFlags({ night: themes.nightMode });
          }
        }),
      );
    }
  }

  get settings(): ViewerSettings {
    return this.settingsValue;
  }

  get active(): Viewer | null {
    const tab = this.documents.active;
    return tab ? (this.viewers.get(tab.id) ?? null) : null;
  }

  get(tabId: string): Viewer | null {
    return this.viewers.get(tabId) ?? null;
  }

  /** Reads the settings; called once from `activate`. */
  async load(): Promise<void> {
    this.settingsValue = await readSettings(this.storage);
    this.renderer.setCacheBytes(megabytes(this.settingsValue.cacheMegabytes));
    this.renderer.keepImages = this.settingsValue.nightKeepImages;
    this.overlayState = {
      rulers: this.settingsValue.rulers,
      grid: this.settingsValue.grid,
      guides: this.settingsValue.guides,
      unit: this.settingsValue.rulerUnits,
      gridSpacing: this.settingsValue.gridSpacing,
    };
  }

  /** Changes one setting, persists it and applies it to every open viewer. */
  async setSetting<K extends keyof ViewerSettings>(
    name: K,
    value: ViewerSettings[K],
  ): Promise<ViewerSettings[K]> {
    this.settingsValue = { ...this.settingsValue, [name]: value };
    await writeSetting(this.storage, name, value);
    this.applySetting(name);
    return value;
  }

  private applySetting(name: keyof ViewerSettings): void {
    const s = this.settingsValue;
    switch (name) {
      case 'cacheMegabytes':
        this.renderer.setCacheBytes(megabytes(s.cacheMegabytes));
        break;
      case 'nightKeepImages':
        this.renderer.keepImages = s.nightKeepImages;
        break;
      case 'rulers':
      case 'grid':
      case 'guides':
      case 'rulerUnits':
      case 'gridSpacing':
        this.overlayState = {
          rulers: s.rulers,
          grid: s.grid,
          guides: s.guides,
          unit: s.rulerUnits,
          gridSpacing: s.gridSpacing,
        };
        for (const viewer of this.viewers.values()) viewer.setOverlays(this.overlayState);
        break;
      case 'snapToGrid':
        for (const viewer of this.viewers.values()) viewer.snapToGrid = s.snapToGrid;
        break;
      case 'lineWeights':
      case 'smoothText':
      case 'smoothImages':
      case 'smoothPaths':
      case 'grayscale':
        for (const viewer of this.viewers.values()) viewer.setFlags(this.flags());
        break;
      case 'autoScrollSpeed':
        for (const viewer of this.viewers.values()) viewer.setAutoScrollSpeed(s.autoScrollSpeed);
        break;
      default:
        break;
    }
  }

  // ---- opening -----------------------------------------------------------------------------------

  /**
   * Opens a file into a new tab. Returns the tab, or `null` when the reader cancelled the
   * password prompt — cancelling leaves nothing behind.
   */
  async open(
    file: OpenedFile,
    preparedSecurity?: PreparedSecurityOpen,
  ): Promise<DocumentTab | null> {
    const service = this.registry.service<DocumentService>(DOCUMENT_SERVICE);
    const existing = file.path ? this.documents.tabs.find((t) => t.path === file.path) : undefined;
    if (existing) {
      this.documents.activate(existing.id);
      return existing;
    }
    // A certificate-protected document has to be decrypted before PDFium ever sees it: PDFium
    // knows only the standard security handler, so such a file is not "wrong password" to it, it
    // is unreadable. M70 registers the `security` service and does the decryption with the
    // reader's digital ID; without M70 the bytes pass through untouched (ADR 0012).
    const prepared = preparedSecurity ?? (await this.prepareBytes(file));
    if (!prepared) return null;

    const attempt = (bytes: Uint8Array): Promise<OpenedDocument | null> =>
      openWithPassword(
        (password) =>
          // The engine transfers the buffer into its worker, which detaches it — so every attempt
          // gets its own copy, or the second one would find an empty ArrayBuffer.
          service.open(bytes.slice(), {
            path: file.path,
            name: file.name,
            ...(password === undefined ? {} : { password }),
            beforeAttach: (document) => {
              if (prepared.sourceInfo || prepared.openedAs !== null) {
                this.registry.service<SecurityService>('security').noteSource(document, prepared);
              }
            },
          }),
        { dialogs: this.shell.dialogs, name: file.name },
      );

    let opened: OpenedDocument | null;
    try {
      opened = await attempt(prepared.bytes);
    } catch (error) {
      // The engine refused the file for something a password will not fix. M100 registers a
      // `repair` service and offers to rebuild it; without M100 there is no such service and the
      // failure is reported exactly as it was before (ADR 0019 §2).
      const repaired = await this.offerRepair(prepared.bytes, file.name, error);
      if (repaired === null) throw error;
      opened = await attempt(repaired);
    }
    if (!opened) return null;
    await this.attach(opened.tab, opened.document);
    if (hasBridge() && file.path) await invoke('recent:add', file.path).catch(() => []);
    return opened.tab;
  }

  /**
   * Gives a registered `security` service a chance to decrypt the bytes before the engine opens
   * them. Returns `null` when the reader cancelled, which leaves no tab behind and shows no
   * error, because cancelling is not a failure.
   */
  private async prepareBytes(file: OpenedFile): Promise<PreparedSecurityOpen | null> {
    if (!this.registry.hasService('security')) return { bytes: file.bytes, openedAs: null };
    const security = this.registry.service<{
      prepareForOpen(bytes: Uint8Array, name: string): Promise<PreparedSecurityOpen | null>;
    }>('security');
    return security.prepareForOpen(file.bytes, file.name);
  }

  /**
   * Gives a registered `repair` service a chance to rebuild a file the engine refused (M100,
   * ADR 0019 §2). Returns repaired bytes to try again with, or `null` — the reader declined,
   * nothing could be done, or M100 is not in this build — in which case the caller reports the
   * original failure, because a repair that was not wanted is not a new problem.
   */
  private async offerRepair(
    bytes: Uint8Array,
    name: string,
    error: unknown,
  ): Promise<Uint8Array | null> {
    if (!this.registry.hasService('repair')) return null;
    const repair = this.registry.service<RepairService>('repair');
    return repair.offerRepair(bytes, name, error).catch(() => null);
  }

  /** Builds the viewport for a tab whose `Document` already exists. */
  async attach(tab: DocumentTab, document: Document): Promise<Viewer> {
    const existing = this.viewers.get(tab.id);
    if (existing) return existing;
    const remembered = tab.path ? await readDocumentState(this.storage, tab.path) : {};
    const restore = this.settingsValue.restorePosition;
    const layout: LayoutMode =
      (restore ? remembered.layout : undefined) ?? this.settingsValue.defaultLayout;
    const fit: FitMode =
      (restore ? (remembered.fit ?? null) : null) ??
      (this.settingsValue.defaultZoom === 'none' ? null : this.settingsValue.defaultZoom);
    const zoom = restore && remembered.zoom ? remembered.zoom : 1;

    this.restoring.add(tab.id);
    const viewer = new Viewer({
      host: this.host,
      tabId: tab.id,
      document,
      renderer: this.renderer,
      activeTool: () => this.currentTool(),
      flags: this.flags(),
      overlays: this.overlayState,
      layout,
      zoom,
      fit,
      autoScrollSpeed: this.settingsValue.autoScrollSpeed,
      onStateChange: (state) => {
        this.publish(tab.id, state);
      },
      onGuidesChanged: () => {
        void this.remember(tab);
      },
    });
    if (restore && remembered.guides) {
      const set = GuideSet.fromJSON(remembered.guides);
      for (const g of set.all) viewer.guides.add(g.page, g.axis, g.at);
    }
    this.viewers.set(tab.id, viewer);
    this.documents.attach(tab.id, viewer);
    if (restore && typeof remembered.page === 'number') {
      viewer.goToPage(remembered.page, { record: false });
      if (typeof remembered.scrollTop === 'number') {
        viewer.pane.setScroll({
          left: remembered.scrollLeft ?? 0,
          top: remembered.scrollTop,
        });
      }
    }
    viewer.snapToGrid = this.settingsValue.snapToGrid;
    if (this.settingsValue.perfHud) viewer.toggleHud();
    this.restoring.delete(tab.id);
    this.showActive(this.documents.state.active);
    this.publish(tab.id, viewer.state);
    return viewer;
  }

  private async closeTab(tab: DocumentTab): Promise<void> {
    const viewer = this.viewers.get(tab.id);
    if (!viewer) return;
    const pending = this.rememberTimers.get(tab.id);
    if (pending !== undefined) clearTimeout(pending);
    this.rememberTimers.delete(tab.id);
    await this.remember(tab);
    this.viewers.delete(tab.id);
    this.lastState.delete(tab.id);
    this.restoring.delete(tab.id);
    viewer.dispose();
    this.renderer.forget(tab.id);
    if (this.viewers.size === 0) this.resetView();
  }

  /** Writes the per-document memory. */
  private async remember(tab: DocumentTab): Promise<void> {
    const viewer = this.viewers.get(tab.id);
    const state = this.lastState.get(tab.id);
    if (!viewer || !state || !tab.path || !this.settingsValue.restorePosition) return;
    await writeDocumentState(this.storage, tab.path, {
      page: state.page,
      zoom: state.zoom,
      fit: state.fit,
      layout: state.layout,
      scrollTop: state.scrollTop,
      scrollLeft: state.scrollLeft,
      guides: viewer.guides.toJSON(),
    });
  }

  // ---- store bridge ------------------------------------------------------------------------------

  /**
   * Schedules the per-document memory write. Called as the reader moves rather than only on
   * close, so the place is already on disk if the app goes away unexpectedly — and so a tab that
   * is closed and reopened straight away finds it.
   */
  private scheduleRemember(tabId: string): void {
    if (!this.settingsValue.restorePosition) return;
    const existing = this.rememberTimers.get(tabId);
    if (existing !== undefined) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.rememberTimers.delete(tabId);
      const tab = this.documents.get(tabId);
      if (tab) void this.remember(tab);
    }, 250);
    this.rememberTimers.set(tabId, timer);
  }

  /**
   * Viewport → store. Everything the status bar and the ribbon read comes from here.
   *
   * The write is skipped when nothing actually differs. That is not an optimisation: `ui.set`
   * builds a fresh `view` object every time, and the subscription below reads `s.view`, so an
   * unconditional write-back would notify, which would apply, which would publish again.
   */
  private publish(tabId: string, state: ViewportState): void {
    if (!this.restoring.has(tabId)) {
      this.lastState.set(tabId, state);
      this.scheduleRemember(tabId);
    }
    if (this.documents.state.active !== tabId) return;
    const next: ViewState = {
      page: state.pageCount === 0 ? 0 : state.page + 1,
      pageCount: state.pageCount,
      zoom: percent(state.zoom),
      fit: state.fit,
      layout: state.layout,
      rotation: state.rotation,
      split: this.active?.split ?? 'off',
      syncScroll: this.active?.synced ?? true,
    };
    // While a store change is being applied to the viewport, the viewport's *intermediate*
    // states are not news: publishing one would queue a store write that lands after the
    // command has finished and undo it. `install` publishes once when it is done.
    if (this.applying) return;
    if (shallowEqual(next, this.shell.ui.get().view)) return;
    this.pushingState = true;
    try {
      this.shell.ui.set({ view: next });
    } finally {
      this.pushingState = false;
    }
    this.scheduleInvalidate();
  }

  /**
   * Asks the shell to re-evaluate its `when()` and `pressed()` predicates — once per animation
   * frame, however many times the view changed in it.
   *
   * A fast scroll announces a new current page on nearly every frame, and each `invalidate()`
   * walks every command and ribbon control of every module. That grew with each module that
   * landed until, with M12's forty-odd commands on top, it was a measurable share of a frame on a
   * runner with no headroom. Nothing the shell shows needs to be fresher than the next paint.
   */
  private scheduleInvalidate(): void {
    if (this.invalidatePending) return;
    if (typeof requestAnimationFrame !== 'function') {
      this.shell.invalidate();
      return;
    }
    this.invalidatePending = true;
    requestAnimationFrame(() => {
      this.invalidatePending = false;
      if (!this.disposed) this.shell.invalidate();
    });
  }

  /**
   * Store → viewport. M02's `view.*` commands only write `ui.view`; this subscription is what
   * turns those writes into scrolling and zooming, so the commands, the status bar's fields and
   * the palette all end up in the same place.
   */
  install(): () => void {
    const stop = this.shell.ui.select(
      (s) => s.view,
      (view) => {
        if (this.pushingState || this.applying) return;
        // The store defers a `set` made inside a notification, so a listener can be handed a
        // snapshot that has already been superseded — opening a document publishes its first
        // state, then jumps to the remembered page, and the first notification arrives after
        // the second. Applying a stale snapshot would undo the newer one.
        if (!shallowEqual(view, this.shell.ui.get().view)) return;
        const viewer = this.active;
        if (!viewer) return;
        this.applying = true;
        try {
          const state = viewer.state;
          if (view.layout !== state.layout) viewer.setLayout(view.layout);
          if (view.rotation !== state.rotation) viewer.setRotation(view.rotation);
          if (view.fit !== state.fit) viewer.setFit(view.fit);
          // `view.zoom.set` writes the zoom *and* clears the fit in one go, so the zoom has to
          // be applied after the fit rather than instead of it.
          if (!view.fit && view.zoom !== percent(viewer.state.zoom)) viewer.setZoom(view.zoom);
          if (view.pageCount > 0 && view.page - 1 !== state.page) viewer.goToPage(view.page - 1);
          if (view.split !== viewer.split) this.setSplit(view.split);
          if (view.syncScroll !== viewer.synced) viewer.setSyncScroll(view.syncScroll);
        } finally {
          this.applying = false;
        }
        // One write back, describing where the viewport actually ended up.
        this.publish(viewer.tabId, viewer.state);
      },
      // Compared field by field: `ui.set` makes a new `view` object on every write, so an
      // identity comparison would fire this on writes that changed nothing.
      { immediate: false, equals: shallowEqual },
    );
    this.disposers.push(stop);
    return stop;
  }

  /** Clears the view slice when the last document closes. */
  private resetView(): void {
    this.pushingState = true;
    try {
      this.shell.ui.set((s) => ({
        view: { ...s.view, page: 0, pageCount: 0, rotation: 0, split: 'off' },
      }));
    } finally {
      this.pushingState = false;
    }
  }

  private showActive(activeId: string | null): void {
    for (const [id, viewer] of this.viewers) {
      viewer.element.hidden = id !== activeId;
    }
    const viewer = activeId ? this.viewers.get(activeId) : null;
    if (viewer) this.publish(viewer.tabId, viewer.state);
    this.updateReadingBar();
  }

  // ---- window modes -----------------------------------------------------------------------------

  async setFullScreen(on?: boolean): Promise<boolean> {
    if (!hasBridge()) return false;
    const next = await invoke('window:setFullScreen', on);
    return next;
  }

  get isReadingMode(): boolean {
    return this.readingMode;
  }

  /**
   * Reading mode hides the chrome and leaves a small opaque bar with the page controls — Foxit's
   * behaviour, and the reason the bar exists at all is that a full-screen reader with no way out
   * is a trap. Escape leaves.
   */
  setReadingMode(on: boolean): boolean {
    if (on === this.readingMode) return this.readingMode;
    this.readingMode = on;
    const root = document.documentElement;
    if (on) root.dataset['readingMode'] = 'on';
    else delete root.dataset['readingMode'];
    this.updateReadingBar();
    this.active?.focus();
    return this.readingMode;
  }

  private updateReadingBar(): void {
    if (!this.readingMode) {
      this.readingBar?.remove();
      this.readingBar = null;
      return;
    }
    if (!this.readingBar) {
      this.readingBar = buildReadingBar(this.shell);
      document.body.append(this.readingBar);
    }
    const view = this.shell.ui.get().view;
    const label = this.readingBar.querySelector('.viewer-reading-page');
    if (label) label.textContent = view.pageCount ? `${view.page} of ${view.pageCount}` : '';
  }

  // ---- split --------------------------------------------------------------------------------------

  setSplit(orientation: SplitOrientation): void {
    const viewer = this.active;
    if (!viewer) return;
    viewer.setSplit(orientation, {
      host: this.host,
      tabId: viewer.tabId,
      document: viewer.document,
      renderer: this.renderer,
      activeTool: () => this.currentTool(),
      flags: this.flags(),
      overlays: this.overlayState,
      layout: viewer.state.layout,
      zoom: viewer.state.zoom,
      fit: viewer.state.fit,
      autoScrollSpeed: this.settingsValue.autoScrollSpeed,
      onStateChange: (state) => {
        this.publish(viewer.tabId, state);
      },
    });
    this.publish(viewer.tabId, viewer.state);
  }

  // ---- helpers ------------------------------------------------------------------------------------

  /**
   * Whether the raster draws annotation appearance streams. A view flag only — nothing is written
   * to the file — set by M32 when the reader hides comments (ADR 0017). The overlay draws the
   * comments that stay visible while this is off.
   */
  private annotationsVisible = true;

  setAnnotationsVisible(visible: boolean): void {
    if (this.annotationsVisible === visible) return;
    this.annotationsVisible = visible;
    for (const viewer of this.viewers.values()) viewer.setFlags(this.flags());
  }

  /**
   * Whether the raster draws form-field widgets. A view flag only, set by M60 while its widget
   * layer is mounted (ADR 0019): the layer draws every field itself as a real control, and PDFium
   * drawing them too would put two renderers on one page. Print and export are unaffected.
   */
  private formsVisible = true;

  setFormsVisible(visible: boolean): void {
    if (this.formsVisible === visible) return;
    this.formsVisible = visible;
    for (const viewer of this.viewers.values()) viewer.setFlags(this.flags());
  }

  /** The render flags built from the settings plus M01's live Night Mode state. */
  flags(): RenderFlags {
    const s = this.settingsValue;
    return {
      annotations: this.annotationsVisible,
      forms: this.formsVisible,
      grayscale: s.grayscale,
      smoothText: s.smoothText,
      smoothImages: s.smoothImages,
      smoothPaths: s.smoothPaths,
      lineWeights: s.lineWeights,
      night: this.nightMode(),
    };
  }

  nightMode(): boolean {
    if (!this.registry.hasService(THEME_SERVICE)) return false;
    return this.registry.service<ThemeManager>(THEME_SERVICE).nightMode;
  }

  /** Reads `--page-paper-night` / `--page-ink-night` from the live theme. */
  private nightPalette(): NightPalette {
    if (typeof getComputedStyle !== 'function') return FALLBACK_PALETTE;
    const style = getComputedStyle(document.documentElement);
    const paper = parseColor(style.getPropertyValue('--page-paper-night'));
    const ink = parseColor(style.getPropertyValue('--page-ink-night'));
    return {
      paper: paper ?? FALLBACK_PALETTE.paper,
      ink: ink ?? FALLBACK_PALETTE.ink,
    };
  }

  private currentTool(): ToolSpec | null {
    const id = this.shell.ui.get().activeTool;
    if (!id) return null;
    return this.registry.tools().find((t) => t.id === id) ?? null;
  }

  dispose(): void {
    this.disposed = true;
    for (const timer of this.rememberTimers.values()) clearTimeout(timer);
    this.rememberTimers.clear();
    for (const d of this.disposers.splice(0)) d();
    for (const viewer of this.viewers.values()) viewer.dispose();
    this.viewers.clear();
    this.renderer.dispose();
    this.readingBar?.remove();
    delete document.documentElement.dataset['readingMode'];
  }
}

/** The minimal floating bar reading mode leaves behind. Opaque, keyboard-reachable. */
function buildReadingBar(shell: ShellServices): HTMLElement {
  const make = (label: string, iconName: string, command: string): HTMLButtonElement => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'icon-btn';
    b.setAttribute('aria-label', label);
    b.title = label;
    b.dataset['command'] = command;
    b.addEventListener('click', () => void shell.run(command));
    b.append(icon(iconName));
    return b;
  };
  const bar = document.createElement('div');
  bar.className = 'viewer-reading-bar';
  bar.setAttribute('role', 'toolbar');
  bar.setAttribute('aria-label', 'Reading mode');
  const page = document.createElement('span');
  page.className = 'viewer-reading-page';
  bar.append(
    make('Previous page', 'chevron-left', 'view.page.previous'),
    page,
    make('Next page', 'chevron-right', 'view.page.next'),
    make('Zoom out', 'zoom-out', 'view.zoom.out'),
    make('Zoom in', 'zoom-in', 'view.zoom.in'),
    make('Leave reading mode', 'shrink', 'view.readingMode.toggle'),
  );
  return bar;
}

export { factor, SERVICE };

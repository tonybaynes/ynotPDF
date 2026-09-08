/**
 * `Viewer` — everything one document tab owns (M11): one or two `DocumentView` panes, the
 * ruler / grid / guide overlays, the navigation history, auto-scroll, the loupe and the
 * developer HUD, plus the input handling that turns wheels, keys and drags into view changes.
 *
 * The service (`ViewerService`) owns the map from tab to `Viewer` and the store; this class
 * owns the DOM and the behaviour. Split view is two panes over the *same* `Document` and the
 * *same* tile cache, so the second pane costs scroll state and nothing else.
 */

import type { Document } from '@core/Document';
import { pageSizeOf } from '@core/model';
import type { PageSize, Rotation } from '@shared/pdf';
import type { ToolSpec } from '@shared/module';
import { el } from '@app/dom';
import { DocumentView, type ViewportState } from '@view/DocumentView';
import { Loupe } from '@view/Loupe';
import { Overlays, type OverlayState } from '@view/Overlays';
import { PerfHud } from '@view/PerfHud';
import type { RenderFlags, TileRenderer } from '@view/TileRenderer';
import { GuideSet, snapPoint } from '@view/guides';
import { ViewHistory, type ViewPosition } from '@view/history';
import type { LayoutMode } from '@view/layout';
import { clampFactor, stepPercent, wheelZoom, factor, percent, type FitMode } from '@view/zoom';

export type SplitOrientation = 'off' | 'vertical' | 'horizontal';

export interface ViewerOptions {
  readonly host: HTMLElement;
  readonly tabId: string;
  readonly document: Document;
  readonly renderer: TileRenderer;
  readonly activeTool: () => ToolSpec | null;
  readonly flags: RenderFlags;
  readonly overlays: OverlayState;
  readonly layout: LayoutMode;
  readonly zoom: number;
  readonly fit: FitMode;
  readonly autoScrollSpeed: number;
  readonly onStateChange: (state: ViewportState) => void;
  readonly onGuidesChanged?: () => void;
}

export class Viewer {
  readonly tabId: string;
  readonly document: Document;
  readonly element: HTMLElement;
  readonly guides = new GuideSet();
  readonly history = new ViewHistory();

  private readonly renderer: TileRenderer;
  private readonly activeTool: () => ToolSpec | null;
  private readonly onStateChange: (state: ViewportState) => void;
  private readonly onGuidesChanged: (() => void) | undefined;
  private readonly panes: DocumentView[] = [];
  private readonly overlaysByPane: Overlays[] = [];
  private readonly paneHosts: HTMLElement[] = [];
  private readonly disposers: Array<() => void> = [];
  private readonly hud: PerfHud;

  private overlayState: OverlayState;
  private flags: RenderFlags;
  private splitMode: SplitOrientation = 'off';
  private syncScroll = true;
  private activePane = 0;
  private loupe: Loupe | null = null;
  private autoScroll = 0;
  private autoScrollSpeed: number;
  private autoScrollDirection = 1;
  private syncing = false;

  constructor(options: ViewerOptions) {
    this.tabId = options.tabId;
    this.document = options.document;
    this.renderer = options.renderer;
    this.activeTool = options.activeTool;
    this.onStateChange = options.onStateChange;
    this.onGuidesChanged = options.onGuidesChanged;
    this.overlayState = options.overlays;
    this.flags = options.flags;
    this.autoScrollSpeed = options.autoScrollSpeed;
    this.hud = new PerfHud(options.renderer);

    this.element = el('div.viewer-split', {
      'data-orientation': 'off',
      'data-tab': options.tabId,
    });
    options.host.append(this.element);

    const host = el('div.viewer-pane', { 'data-pane': '0', 'data-active': 'true' });
    this.element.append(host);
    this.paneHosts.push(host);
    this.panes.push(this.createPane(host, options));
    this.overlaysByPane.push(this.createOverlays(0));
    this.installInput(0);

    // Keep the pages in step with the model: a rotate or a page insert re-lays out every pane.
    this.disposers.push(
      this.document.store.select(
        (s) => s.pages,
        () => {
          const sizes = this.pageSizes();
          for (const pane of this.panes) pane.setPageSizes(sizes);
          this.syncOverlays();
        },
        { immediate: false },
      ),
    );
  }

  // ---- state ---------------------------------------------------------------------------------

  get pane(): DocumentView {
    const pane = this.panes[this.activePane] ?? this.panes[0];
    if (!pane) throw new Error('Viewer has no pane');
    return pane;
  }

  get allPanes(): ReadonlyArray<DocumentView> {
    return this.panes;
  }

  get split(): SplitOrientation {
    return this.splitMode;
  }

  get synced(): boolean {
    return this.syncScroll;
  }

  get state(): ViewportState {
    return this.pane.state;
  }

  get overlays(): OverlayState {
    return this.overlayState;
  }

  get renderFlags(): RenderFlags {
    return this.flags;
  }

  get hudVisible(): boolean {
    return this.hud.visible;
  }

  /** The perf HUD's live numbers; the acceptance test reads these. */
  perfSample(): ReturnType<PerfHud['sample']> {
    return this.hud.sample();
  }

  resetPerf(): void {
    this.hud.reset();
  }

  toggleHud(): boolean {
    return this.hud.toggle(this.paneHosts[0] ?? this.element);
  }

  focus(): void {
    this.pane.scroller.focus();
  }

  // ---- view commands ---------------------------------------------------------------------------

  setLayout(mode: LayoutMode): void {
    for (const pane of this.panes) pane.setLayout(mode);
    this.syncOverlays();
    this.emit();
  }

  setRotation(rotation: Rotation): void {
    for (const pane of this.panes) pane.setRotation(rotation);
    this.syncOverlays();
    this.emit();
  }

  rotateBy(quarters: number): Rotation {
    const next = this.pane.rotateBy(quarters);
    for (const pane of this.panes) if (pane !== this.pane) pane.setRotation(next);
    this.syncOverlays();
    this.emit();
    return next;
  }

  setZoom(zoomPercent: number, fit: FitMode = null): void {
    this.pane.setZoom(factor(zoomPercent), fit);
    this.syncOverlays();
    this.emit();
  }

  setFit(fit: FitMode): void {
    this.pane.setFit(fit);
    this.syncOverlays();
    this.emit();
  }

  stepZoom(direction: 1 | -1): number {
    const next = stepPercent(percent(this.pane.zoom), direction);
    this.setZoom(next);
    return next;
  }

  setFlags(patch: Partial<RenderFlags>): void {
    this.flags = { ...this.flags, ...patch };
    for (const pane of this.panes) pane.setFlags(patch);
  }

  /** Repaints both panes from the cache (M12, ADR 0011) — see `DocumentView.refresh`. */
  refresh(): void {
    for (const pane of this.panes) pane.refresh();
  }

  setOverlays(patch: Partial<OverlayState>): void {
    this.overlayState = { ...this.overlayState, ...patch };
    for (const o of this.overlaysByPane) o.set(patch);
  }

  /** Jumps to a page, recording the departure so Alt+← comes back to it. */
  goToPage(page: number, options: { readonly record?: boolean } = {}): void {
    if (options.record !== false) this.recordJump();
    this.pane.goToPage(page);
    if (options.record !== false) this.history.push(this.positionOf(this.pane.state));
    this.syncOverlays();
    this.emit();
  }

  scrollByPages(delta: number): void {
    this.pane.scrollByPages(delta);
    this.syncOverlays();
    this.emit();
  }

  /** Alt+← — back to the previous jump. */
  back(): boolean {
    this.recordJump();
    const position = this.history.back();
    if (!position) return false;
    this.restore(position);
    return true;
  }

  forward(): boolean {
    const position = this.history.forward();
    if (!position) return false;
    this.restore(position);
    return true;
  }

  // ---- split view -------------------------------------------------------------------------------

  setSplit(orientation: SplitOrientation, options: ViewerOptions): void {
    if (orientation === this.splitMode) return;
    if (orientation === 'off') {
      const [, second] = this.panes;
      second?.dispose();
      this.overlaysByPane[1]?.dispose();
      this.panes.length = 1;
      this.overlaysByPane.length = 1;
      this.paneHosts[1]?.remove();
      this.paneHosts[2]?.remove();
      this.paneHosts.length = 1;
      this.activePane = 0;
      this.splitMode = 'off';
      this.element.dataset['orientation'] = 'off';
      this.markActivePane();
      return;
    }
    if (this.splitMode === 'off') {
      const divider = el('div.viewer-split-divider', {
        role: 'separator',
        'aria-orientation': orientation === 'vertical' ? 'vertical' : 'horizontal',
        'aria-label': 'Split divider',
      });
      const host = el('div.viewer-pane', { 'data-pane': '1' });
      this.element.append(divider, host);
      this.paneHosts.push(divider, host);
      const second = this.createPane(host, { ...options, host });
      this.panes.push(second);
      this.overlaysByPane.push(this.createOverlays(1));
      this.installInput(1);
      // The new pane starts where the first one is.
      second.setScrollFraction(this.panes[0]?.scrollFraction ?? 0);
    }
    this.splitMode = orientation;
    this.element.dataset['orientation'] = orientation;
    this.markActivePane();
  }

  setSyncScroll(sync: boolean): void {
    this.syncScroll = sync;
    if (sync) this.mirrorScroll(this.activePane);
  }

  setActivePane(index: number): void {
    if (index < 0 || index >= this.panes.length) return;
    this.activePane = index;
    this.markActivePane();
    this.emit();
  }

  // ---- loupe / auto-scroll ------------------------------------------------------------------------

  toggleLoupe(): boolean {
    if (this.loupe) {
      this.loupe.close();
      return false;
    }
    this.loupe = new Loupe({
      view: this.pane,
      onClose: () => {
        this.loupe = null;
      },
    });
    return true;
  }

  cycleLoupeFactor(): number | null {
    return this.loupe ? this.loupe.cycleFactor() : null;
  }

  get loupeOpen(): boolean {
    return this.loupe !== null;
  }

  /** Foxit's auto-scroll: a steady crawl the reader speeds up, slows down or reverses. */
  toggleAutoScroll(): boolean {
    if (this.autoScroll) {
      this.stopAutoScroll();
      return false;
    }
    let last = performance.now();
    // The position is accumulated as a float rather than read back from the scroller: a frame's
    // worth of crawl is about a pixel, and comparing the browser's rounded `scrollTop` before
    // and after would look like "it did not move" and stop on the first frame.
    let position = this.pane.state.scrollTop;
    const step = (now: number): void => {
      if (!this.autoScroll) return;
      // The first frame's timestamp can precede the `performance.now()` taken a moment earlier.
      const dt = Math.max(0, (now - last) / 1000);
      last = now;
      position += this.autoScrollSpeed * 24 * dt * this.autoScrollDirection;
      const range = this.pane.scrollRange;
      // Only the end being travelled towards counts as the end.
      const arrived = this.autoScrollDirection > 0 ? position >= range : position <= 0;
      if (arrived) {
        this.pane.setScroll({ left: this.pane.state.scrollLeft, top: position });
        this.stopAutoScroll();
        return;
      }
      this.pane.setScroll({ left: this.pane.state.scrollLeft, top: position });
      this.pane.scrollBy(0, 0); // repaint at the new position
      this.autoScroll = requestAnimationFrame(step);
    };
    this.autoScroll = requestAnimationFrame(step);
    return true;
  }

  setAutoScrollSpeed(speed: number): number {
    this.autoScrollSpeed = Math.min(10, Math.max(1, speed));
    return this.autoScrollSpeed;
  }

  reverseAutoScroll(): void {
    this.autoScrollDirection = this.autoScrollDirection > 0 ? -1 : 1;
  }

  get autoScrolling(): boolean {
    return this.autoScroll !== 0;
  }

  stopAutoScroll(): void {
    if (this.autoScroll) cancelAnimationFrame(this.autoScroll);
    this.autoScroll = 0;
    this.autoScrollDirection = 1;
  }

  // ---- lifecycle ----------------------------------------------------------------------------------

  pageSizes(): PageSize[] {
    return this.document.state.pages.map(pageSizeOf);
  }

  /**
   * Snaps a page point to the grid and the guides, honouring the current settings. Exposed for
   * the tools later modules bring — M33's measuring, M50's object handles — so "snap" means the
   * same thing everywhere and they do not each reimplement it.
   */
  snap(page: number, point: { readonly x: number; readonly y: number }): { x: number; y: number } {
    return snapPoint(point, {
      ...(this.snapToGrid ? { grid: this.overlayState.gridSpacing } : {}),
      guides: this.guides.forPage(page),
      page,
    });
  }

  /** Whether tools should snap to the grid (the `viewer.grid.snap` setting). */
  snapToGrid = false;

  syncOverlays(): void {
    for (const o of this.overlaysByPane) o.sync();
  }

  dispose(): void {
    this.stopAutoScroll();
    this.loupe?.close();
    this.hud.stop();
    for (const d of this.disposers.splice(0)) d();
    for (const o of this.overlaysByPane) o.dispose();
    for (const pane of this.panes) pane.dispose();
    this.panes.length = 0;
    this.overlaysByPane.length = 0;
    this.element.remove();
  }

  // ---- internals ------------------------------------------------------------------------------------

  private createPane(host: HTMLElement, options: ViewerOptions): DocumentView {
    const index = this.panes.length;
    return new DocumentView({
      host,
      renderer: this.renderer,
      docKey: this.tabId,
      doc: this.document.handle,
      pageSizes: this.pageSizes(),
      flags: this.flags,
      layout: options.layout,
      zoom: options.zoom,
      fit: options.fit,
      activeTool: this.activeTool,
      onStateChange: (state) => {
        if (index === this.activePane) this.onStateChange(state);
        this.overlaysByPane[index]?.sync();
        if (this.syncScroll && this.splitMode !== 'off') this.mirrorScroll(index);
      },
    });
  }

  private createOverlays(index: number): Overlays {
    const pane = this.panes[index];
    if (!pane) throw new Error(`No pane ${index}`);
    const overlays = new Overlays({
      view: pane,
      guides: this.guides,
      pageBox: (page) => this.document.state.pages[page]?.cropBox,
      ...(this.onGuidesChanged ? { onGuidesChanged: this.onGuidesChanged } : {}),
    });
    overlays.set(this.overlayState);
    return overlays;
  }

  /** Copies the active pane's scroll fraction to the other one. */
  private mirrorScroll(from: number): void {
    if (this.syncing) return;
    this.syncing = true;
    try {
      const source = this.panes[from];
      if (!source) return;
      const fraction = source.scrollFraction;
      for (const [index, pane] of this.panes.entries()) {
        if (index !== from) pane.setScrollFraction(fraction);
      }
    } finally {
      this.syncing = false;
    }
  }

  private markActivePane(): void {
    for (const host of this.paneHosts) {
      if (!host.classList.contains('viewer-pane')) continue;
      const paneIndex = Number(host.dataset['pane'] ?? '0');
      host.dataset['active'] =
        this.splitMode === 'off' || paneIndex === this.activePane ? 'true' : 'false';
    }
  }

  private emit(): void {
    this.onStateChange(this.pane.state);
  }

  private positionOf(state: ViewportState): ViewPosition {
    return { page: state.page, left: state.scrollLeft, top: state.scrollTop, zoom: state.zoom };
  }

  /** Stores where the reader is now, so `back()` returns to the exact spot. */
  private recordJump(): void {
    this.history.replace(this.positionOf(this.pane.state));
  }

  private restore(position: ViewPosition): void {
    const pane = this.pane;
    pane.setZoom(position.zoom);
    pane.goToPage(position.page, { top: position.top });
    pane.setScroll({ left: position.left, top: position.top });
    this.syncOverlays();
    this.emit();
  }

  /** Wheel, pinch, middle-drag pan and the keys that belong to the page area. */
  private installInput(index: number): void {
    const pane = this.panes[index];
    if (!pane) return;
    const scroller = pane.scroller;

    const focus = (): void => {
      if (this.splitMode !== 'off' && this.activePane !== index) this.setActivePane(index);
    };
    scroller.addEventListener('pointerdown', focus);
    scroller.addEventListener('focusin', focus);

    const onWheel = (event: WheelEvent): void => {
      // Ctrl/Cmd + wheel is zoom; a trackpad pinch arrives the same way with ctrlKey set.
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const box = scroller.getBoundingClientRect();
      pane.zoomAt(
        wheelZoom(pane.zoom, event.deltaY),
        event.clientX - box.left,
        event.clientY - box.top,
      );
      this.overlaysByPane[index]?.sync();
      if (index === this.activePane) this.onStateChange(pane.state);
    };
    scroller.addEventListener('wheel', onWheel, { passive: false });

    // Middle-button drag pans, as it does in every reader.
    const onMiddleDown = (event: PointerEvent): void => {
      if (event.button !== 1) return;
      event.preventDefault();
      scroller.setPointerCapture(event.pointerId);
      let last = { x: event.clientX, y: event.clientY };
      const move = (e: PointerEvent): void => {
        pane.scrollBy(last.x - e.clientX, last.y - e.clientY);
        last = { x: e.clientX, y: e.clientY };
      };
      const up = (e: PointerEvent): void => {
        scroller.releasePointerCapture?.(e.pointerId);
        scroller.removeEventListener('pointermove', move);
        scroller.removeEventListener('pointerup', up);
      };
      scroller.addEventListener('pointermove', move);
      scroller.addEventListener('pointerup', up);
    };
    scroller.addEventListener('pointerdown', onMiddleDown);

    const onKey = (event: KeyboardEvent): void => {
      if (event.defaultPrevented) return;
      const tool = this.activeTool();
      if (tool?.onKeyDown?.(event)) {
        event.preventDefault();
        return;
      }
      // While auto-scrolling, the digits set the speed and the minus key reverses, as in Foxit.
      if (this.autoScroll) {
        if (/^[0-9]$/.test(event.key)) {
          event.preventDefault();
          this.setAutoScrollSpeed(event.key === '0' ? 10 : Number(event.key));
          return;
        }
        if (event.key === '-' || event.key === '_') {
          event.preventDefault();
          this.reverseAutoScroll();
          return;
        }
        if (event.key === 'Escape') {
          event.preventDefault();
          this.stopAutoScroll();
          return;
        }
      }
      switch (event.key) {
        case 'PageDown':
        case ' ':
          event.preventDefault();
          this.scrollByPages(1);
          break;
        case 'PageUp':
          event.preventDefault();
          this.scrollByPages(-1);
          break;
        // Ctrl/Cmd+Home and Ctrl/Cmd+End are bound in the manifest so they work wherever the
        // focus is; handling them here as well would run the command twice.
        default:
          return;
      }
    };
    scroller.addEventListener('keydown', onKey);

    this.disposers.push(() => {
      scroller.removeEventListener('pointerdown', focus);
      scroller.removeEventListener('focusin', focus);
      scroller.removeEventListener('wheel', onWheel);
      scroller.removeEventListener('pointerdown', onMiddleDown);
      scroller.removeEventListener('keydown', onKey);
    });
  }
}

export { clampFactor };

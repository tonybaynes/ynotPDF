/**
 * `DocumentView` — the scrolling page view (M11). This is the surface every editing tool will
 * eventually draw on, so it is deliberately plain: one scroll container, one absolutely
 * positioned content box, and a `PageView` for each page near the viewport.
 *
 * Invariants worth keeping:
 * - **Scrolling moves DOM and blits cached tiles. It never renders.** The engine is only asked
 *   for pixels when the zoom bucket, rotation, render flags or the set of visible tiles change.
 * - **Only pages near the viewport exist in the DOM.** A 1000-page document has a handful of
 *   `PageView`s, which is what makes the 500-page scroll test possible.
 * - **All view state is reported out**, never read back from the DOM; the store, the status bar
 *   and the tests share one description of where the reader is.
 */

import type { PageSize, PdfRect, Rotation } from '@shared/pdf';
import type { ToolSpec } from '@shared/module';
import type { DocHandle } from '@engine/PdfEngine';
import { PageGeometry } from '@engine/geometry';
import { PageView } from './PageView';
import {
  layoutPages,
  pageAt,
  pagesInBand,
  rectOfPage,
  rowOfPage,
  type LayoutMode,
  type LayoutTable,
} from './layout';
import { bucketKey, bucketZoom, clampFactor, fitZoom, zoomAboutPoint, type FitMode } from './zoom';
import { orderByDistance, tilesForRect, TILE_SIZE, type TileCoord } from './tiles';
import type { RenderFlags, TileRenderer, TileRequest } from './TileRenderer';
import { visibleRowBounds } from './ContentBounds';

/** Gap between pages and padding around the content, CSS px. */
export const PAGE_GAP = 16;
export const CONTENT_PADDING = 16;

export interface ViewportState {
  /** 0-based. */
  readonly page: number;
  readonly pageCount: number;
  /** CSS px per point. */
  readonly zoom: number;
  readonly fit: FitMode;
  readonly layout: LayoutMode;
  readonly rotation: Rotation;
  readonly scrollLeft: number;
  readonly scrollTop: number;
}

export interface DocumentViewOptions {
  /** Element the viewport fills. */
  readonly host: HTMLElement;
  readonly renderer: TileRenderer;
  readonly docKey: string;
  readonly doc: DocHandle;
  readonly pageSizes: ReadonlyArray<PageSize>;
  /** Bounds in unrotated PDF space, supplied by the document's bounded cache. */
  readonly contentBounds?: (page: number) => Promise<PdfRect>;
  readonly flags?: RenderFlags;
  readonly layout?: LayoutMode;
  readonly zoom?: number;
  readonly fit?: FitMode;
  readonly rotation?: Rotation;
  /** The tool the page layers should send pointer events to. */
  readonly activeTool?: () => ToolSpec | null;
  readonly onStateChange?: (state: ViewportState) => void;
  /** Called after every repaint pass, for the perf HUD. */
  readonly onFrame?: () => void;
}

/** How far beyond the viewport pages are kept mounted, in screens. */
const MOUNT_MARGIN = 1;

/** Distinguishes the two halves of a split view to the shared tile renderer. */
let nextViewportId = 0;

export class DocumentView {
  readonly element: HTMLElement;
  readonly scroller: HTMLElement;
  readonly content: HTMLElement;
  readonly overlay: HTMLElement;

  private readonly renderer: TileRenderer;
  /** This viewport's identity to the shared renderer. */
  private readonly viewportId = `viewport-${++nextViewportId}`;
  private readonly docKey: string;
  private readonly doc: DocHandle;
  private sizes: ReadonlyArray<PageSize>;
  private readonly views = new Map<number, PageView>();
  private readonly onStateChange: ((state: ViewportState) => void) | undefined;
  private readonly onFrame: (() => void) | undefined;
  private readonly activeTool: (() => ToolSpec | null) | undefined;
  private readonly disposers: Array<() => void> = [];

  private table: LayoutTable;
  private mode: LayoutMode;
  private zoomFactor: number;
  private fitMode: FitMode;
  private viewRotation: Rotation;
  private flags: RenderFlags;
  private currentPage = 0;
  private contentOffsetX = 0;
  private dpr = globalThis.devicePixelRatio || 1;
  private frame = 0;
  private idle = 0;
  private disposed = false;
  private suppressScroll = false;
  private fitRequest = 0;
  private readonly readContentBounds: DocumentViewOptions['contentBounds'];

  constructor(options: DocumentViewOptions) {
    this.renderer = options.renderer;
    this.docKey = options.docKey;
    this.doc = options.doc;
    this.sizes = options.pageSizes;
    this.readContentBounds = options.contentBounds;
    this.onStateChange = options.onStateChange;
    this.onFrame = options.onFrame;
    this.activeTool = options.activeTool;
    this.mode = options.layout ?? 'continuous';
    this.zoomFactor = options.zoom ?? 1;
    this.fitMode = options.fit ?? null;
    this.viewRotation = options.rotation ?? 0;
    this.flags = options.flags ?? { ...DEFAULT_VIEW_FLAGS };

    this.element = document.createElement('div');
    this.element.className = 'viewer';
    this.scroller = document.createElement('div');
    this.scroller.className = 'viewer-scroll';
    this.scroller.tabIndex = 0;
    this.scroller.setAttribute('role', 'group');
    this.scroller.setAttribute('aria-label', 'Page view');
    this.content = document.createElement('div');
    this.content.className = 'viewer-content';
    this.overlay = document.createElement('div');
    this.overlay.className = 'viewer-overlay';
    this.scroller.append(this.content);
    this.element.append(this.scroller, this.overlay);
    options.host.append(this.element);

    this.table = this.buildTable();
    const onScroll = (): void => {
      if (this.suppressScroll) return;
      this.schedule();
    };
    this.scroller.addEventListener('scroll', onScroll, { passive: true });
    this.disposers.push(() => {
      this.scroller.removeEventListener('scroll', onScroll);
    });

    const resize = new ResizeObserver(() => {
      this.applyFit();
      this.relayout();
    });
    resize.observe(this.scroller);
    this.disposers.push(() => {
      resize.disconnect();
    });

    this.disposers.push(
      this.renderer.onTile((id, request) => {
        if (request.docKey !== this.docKey) return;
        const view = this.views.get(request.page);
        if (!view || view.hasPainted(id)) return;
        const bitmap = this.renderer.peek(id);
        if (bitmap) view.paintTile(request.coord, bitmap, id);
      }),
    );

    this.applyFit();
    this.relayout();
  }

  // ---- state ---------------------------------------------------------------------------------

  get state(): ViewportState {
    return {
      page: this.currentPage,
      pageCount: this.sizes.length,
      zoom: this.zoomFactor,
      fit: this.fitMode,
      layout: this.mode,
      rotation: this.viewRotation,
      scrollLeft: this.scroller.scrollLeft,
      scrollTop: this.scroller.scrollTop,
    };
  }

  get pageCount(): number {
    return this.sizes.length;
  }

  get zoom(): number {
    return this.zoomFactor;
  }

  get layout(): LayoutMode {
    return this.mode;
  }

  get rotation(): Rotation {
    return this.viewRotation;
  }

  get renderFlags(): RenderFlags {
    return this.flags;
  }

  get layoutTable(): LayoutTable {
    return this.table;
  }

  /** The mounted `PageView`s, for tools and later modules. */
  pageView(page: number): PageView | undefined {
    return this.views.get(page);
  }

  // ---- commands ------------------------------------------------------------------------------

  setLayout(mode: LayoutMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    this.applyFit();
    this.relayout({ keepPage: true });
    this.emit();
  }

  setRotation(rotation: Rotation): void {
    if (rotation === this.viewRotation) return;
    this.viewRotation = rotation;
    for (const view of this.views.values()) view.update({ rotation });
    this.applyFit();
    this.relayout({ keepPage: true, rebuild: true });
    this.emit();
  }

  /** Rotates the view by ±90°. */
  rotateBy(quarters: number): Rotation {
    const next = ((((this.viewRotation / 90 + quarters) % 4) + 4) % 4) * 90;
    this.setRotation(next as Rotation);
    return this.viewRotation;
  }

  setFlags(patch: Partial<RenderFlags>): void {
    const next = { ...this.flags, ...patch };
    if (flagsEqual(next, this.flags)) return;
    this.flags = next;
    for (const view of this.views.values()) view.invalidate();
    this.paint({ force: true });
  }

  /**
   * Repaints every mounted page from scratch (M12, ADR 0011). The inputs the tile cache keys on
   * have not changed but the pixels behind them have — a layer was toggled — so `setFlags` would
   * correctly decide there was nothing to do. The caller drops the stale tiles first.
   */
  refresh(): void {
    for (const view of this.views.values()) view.invalidate();
    this.paint({ force: true });
  }

  setFit(fit: FitMode): void {
    this.fitRequest++;
    this.fitMode = fit;
    if (fit) {
      this.applyFit();
      this.relayout({ keepPage: true });
    }
    this.emit();
  }

  /** Sets the zoom, keeping the viewport centre fixed. */
  setZoom(zoom: number, fit: FitMode = null): void {
    const box = this.scroller.getBoundingClientRect();
    this.zoomAt(zoom, box.width / 2, box.height / 2, fit);
  }

  /**
   * Zooms about a point given in viewport coordinates (CSS px from the scroller's top-left).
   * Whatever content was under that point stays under it.
   */
  zoomAt(zoom: number, anchorX: number, anchorY: number, fit: FitMode = null): void {
    this.fitRequest++;
    const target = clampFactor(zoom);
    if (target === this.zoomFactor && fit === this.fitMode) return;
    const box = this.scroller.getBoundingClientRect();
    // The page point under the cursor: this, not a content coordinate, is what must not move.
    // The content padding and the gaps between pages do not scale with the zoom, so treating the
    // content as one uniformly scaling plane drifts by exactly the padding — 16 px, which at 1×
    // is 16 points of page and very visible.
    const anchored = this.hitTest(box.left + anchorX, box.top + anchorY);
    const before = { left: this.scroller.scrollLeft, top: this.scroller.scrollTop };
    const oldOffsetX = this.contentOffsetX;
    const oldZoom = this.zoomFactor;
    this.zoomFactor = target;
    this.fitMode = fit;
    // A first approximation, so the right pages are mounted; the correction below is exact.
    this.relayout({
      scroll: (offsetX) =>
        zoomAboutPoint(
          before,
          { x: anchorX, y: anchorY },
          oldZoom,
          target,
          { x: oldOffsetX, y: 0 },
          { x: offsetX, y: 0 },
        ),
    });
    if (anchored) {
      const view = this.views.get(anchored.page);
      if (view) {
        const pageBox = view.element.getBoundingClientRect();
        const device = view.transform.toDevice({ x: anchored.x, y: anchored.y });
        const nowX = pageBox.left - box.left + device.x;
        const nowY = pageBox.top - box.top + device.y;
        this.setScroll({
          left: this.scroller.scrollLeft + (nowX - anchorX),
          top: this.scroller.scrollTop + (nowY - anchorY),
        });
        this.paint();
      }
    }
    this.emit();
  }

  /** Jumps to a page (0-based), putting its top edge just below the content padding. */
  goToPage(page: number, options: { readonly top?: number } = {}): void {
    this.fitRequest++;
    const target = Math.min(Math.max(0, Math.round(page)), Math.max(0, this.sizes.length - 1));
    this.currentPage = target;
    if (!this.table.continuous) {
      this.relayout({ keepPage: true });
      this.setScroll({ left: this.scroller.scrollLeft, top: options.top ?? 0 });
      this.paint();
      if (this.fitMode === 'visible') this.applyFit();
      this.emit();
      return;
    }
    const rect = rectOfPage(this.table, target);
    if (!rect) return;
    this.setScroll({
      left: this.scroller.scrollLeft,
      top: options.top ?? rect.y - CONTENT_PADDING,
    });
    this.paint();
    if (this.fitMode === 'visible') this.applyFit();
    this.emit();
  }

  /** Scrolls by a fraction of the viewport height; used by Page Up / Page Down and auto-scroll. */
  scrollByPages(delta: number): void {
    const height = this.scroller.clientHeight;
    if (this.table.continuous) {
      this.setScroll({
        left: this.scroller.scrollLeft,
        top: this.scroller.scrollTop + delta * height * 0.92,
      });
      this.paint();
      this.emit();
      return;
    }
    // Non-continuous: scroll within the row, then step to the next one.
    const atEnd =
      delta > 0
        ? this.scroller.scrollTop + height >= this.content.offsetHeight - 1
        : this.scroller.scrollTop <= 0;
    if (!atEnd) {
      this.setScroll({
        left: this.scroller.scrollLeft,
        top: this.scroller.scrollTop + delta * height * 0.92,
      });
      this.paint();
      this.emit();
      return;
    }
    this.stepRow(delta > 0 ? 1 : -1, delta > 0 ? 'top' : 'bottom');
  }

  /** Moves one row (page or spread) in non-continuous layouts. */
  stepRow(direction: 1 | -1, land: 'top' | 'bottom' = 'top'): void {
    const row = rowOfPage(this.table, this.currentPage);
    const next = this.table.rows[row + direction];
    if (!next) return;
    this.currentPage = next.pages[0] ?? this.currentPage;
    this.relayout({ keepPage: true });
    const top =
      land === 'top' ? 0 : Math.max(0, this.content.offsetHeight - this.scroller.clientHeight);
    this.setScroll({ left: this.scroller.scrollLeft, top });
    if (this.fitMode === 'visible') this.applyFit();
    this.emit();
  }

  scrollBy(dx: number, dy: number): void {
    this.setScroll({
      left: this.scroller.scrollLeft + dx,
      top: this.scroller.scrollTop + dy,
    });
    this.paint();
    this.emit();
  }

  setScroll(scroll: { readonly left: number; readonly top: number }): void {
    const maxLeft = Math.max(0, this.content.offsetWidth - this.scroller.clientWidth);
    const maxTop = Math.max(0, this.content.offsetHeight - this.scroller.clientHeight);
    this.suppressScroll = true;
    this.scroller.scrollLeft = Math.min(Math.max(0, scroll.left), maxLeft);
    this.scroller.scrollTop = Math.min(Math.max(0, scroll.top), maxTop);
    this.suppressScroll = false;
    this.updateCurrentPage();
  }

  /** How far this viewport can scroll vertically. */
  get scrollRange(): number {
    return Math.max(0, this.content.offsetHeight - this.scroller.clientHeight);
  }

  /** Fraction of the scrollable height, 0..1 — how split view keeps two panes in step. */
  get scrollFraction(): number {
    const max = Math.max(1, this.content.offsetHeight - this.scroller.clientHeight);
    return this.scroller.scrollTop / max;
  }

  setScrollFraction(fraction: number): void {
    const max = Math.max(0, this.content.offsetHeight - this.scroller.clientHeight);
    this.setScroll({ left: this.scroller.scrollLeft, top: fraction * max });
    this.paint();
  }

  /** The page sizes changed (a page rotated, was inserted or removed). */
  setPageSizes(sizes: ReadonlyArray<PageSize>): void {
    this.fitRequest++;
    this.sizes = sizes;
    for (const [index, view] of [...this.views]) {
      const size = sizes[index];
      if (!size) {
        view.dispose();
        this.views.delete(index);
      } else {
        view.update({ size });
      }
    }
    this.applyFit();
    this.relayout({ keepPage: true, rebuild: true });
    this.emit();
  }

  /** Viewport point → the page under it and its page-space coordinates. */
  hitTest(clientX: number, clientY: number): { page: number; x: number; y: number } | null {
    for (const [index, view] of this.views) {
      const box = view.element.getBoundingClientRect();
      if (clientX < box.left || clientX > box.right || clientY < box.top || clientY > box.bottom) {
        continue;
      }
      const point = view.transform.toPage({ x: clientX - box.left, y: clientY - box.top });
      return { page: index, x: point.x, y: point.y };
    }
    return null;
  }

  /** Content coordinates (CSS px at the current zoom) of a viewport point. */
  toContent(clientX: number, clientY: number): { x: number; y: number } {
    const box = this.scroller.getBoundingClientRect();
    return {
      x: clientX - box.left + this.scroller.scrollLeft,
      y: clientY - box.top + this.scroller.scrollTop,
    };
  }

  dispose(): void {
    this.disposed = true;
    this.renderer.release(this.viewportId);
    if (this.frame) cancelAnimationFrame(this.frame);
    if (this.idle) cancelIdle(this.idle);
    for (const d of this.disposers.splice(0)) d();
    for (const view of this.views.values()) view.dispose();
    this.views.clear();
    this.element.remove();
  }

  // ---- internals -----------------------------------------------------------------------------

  private buildTable(): LayoutTable {
    return layoutPages(this.sizes, {
      mode: this.mode,
      zoom: this.zoomFactor,
      gap: PAGE_GAP,
      padding: CONTENT_PADDING,
      rotation: this.viewRotation,
    });
  }

  private offsetXFor(table: LayoutTable): number {
    return Math.max(0, (this.scroller.clientWidth - table.width) / 2);
  }

  /** Recomputes the fit zoom, if a fit mode is held. */
  private applyFit(): void {
    const request = ++this.fitRequest;
    if (!this.fitMode) return;
    // Build for the *new* layout mode; the displayed table may still be the previous mode.
    const table = this.buildTable();
    const row = table.rows[Math.max(0, rowOfPage(table, this.currentPage))] ?? table.rows[0];
    const pages = row?.pages ?? [0];
    if (this.fitMode === 'visible' && this.readContentBounds) {
      void this.applyVisibleFit(pages, request);
      return;
    }
    const sizes = pages.map((p) => this.sizes[p]).filter((s): s is PageSize => Boolean(s));
    if (sizes.length === 0) return;
    const zoom = fitZoom(
      sizes,
      this.mode,
      this.fitMode,
      {
        width: this.scroller.clientWidth,
        height: this.scroller.clientHeight,
        gap: PAGE_GAP,
        padding: CONTENT_PADDING,
        scrollbar: this.scroller.offsetWidth - this.scroller.clientWidth,
      },
      this.viewRotation,
    );
    this.zoomFactor = zoom;
  }

  /** Edits invalidate both a pending fit and any result already displayed. */
  invalidateContentBounds(): void {
    this.applyFit();
  }

  private async applyVisibleFit(pages: ReadonlyArray<number>, request: number): Promise<void> {
    // Let the synchronous layout/scroll part of the initiating command finish first.
    await Promise.resolve();
    if (this.disposed || request !== this.fitRequest) return;
    const left = this.scroller.scrollLeft;
    const top = this.scroller.scrollTop;
    const read = this.readContentBounds;
    if (!read) return;
    const page = this.currentPage;
    const boxes = await Promise.all(
      pages.map(async (p) => {
        const size = this.sizes[p];
        if (!size) return null;
        // A failed read still leaves a usable page-width fit. Failed cache entries can retry.
        const box = await Promise.resolve()
          .then(() => read(p))
          .catch(() => new PageGeometry(size).box);
        return [p, box] as const;
      }),
    );
    if (
      this.disposed ||
      request !== this.fitRequest ||
      this.fitMode !== 'visible' ||
      page !== this.currentPage ||
      left !== this.scroller.scrollLeft ||
      top !== this.scroller.scrollTop
    )
      return;
    const bounds = new Map(boxes.filter((b) => b !== null));
    const unitTable = layoutPages(this.sizes, {
      mode: this.mode,
      zoom: 1,
      gap: 0,
      padding: 0,
      rotation: this.viewRotation,
    });
    const unit = visibleRowBounds(unitTable, this.sizes, bounds, this.viewRotation);
    if (!unit || unit.width <= 0 || this.scroller.clientWidth <= 0) return;
    const gap = pages.length > 1 ? PAGE_GAP : 0;
    const available = Math.max(1, this.scroller.clientWidth - CONTENT_PADDING * 2 - gap);
    // Round down, so the status bar's whole-percent precision never clips the right edge.
    this.zoomFactor = clampFactor(Math.floor((available / unit.width) * 100) / 100);
    this.relayout();
    const ink = visibleRowBounds(this.table, this.sizes, bounds, this.viewRotation);
    const row = this.table.rows[rowOfPage(this.table, page)];
    if (ink) {
      const rowOffset = this.table.continuous ? 0 : (row?.y ?? 0) - CONTENT_PADDING;
      this.setScroll({
        left: ink.x + this.contentOffsetX - CONTENT_PADDING,
        top: ink.y - rowOffset - CONTENT_PADDING,
      });
    }
    this.paint({ force: true });
    this.emit();
  }

  /**
   * Rebuilds the layout, mounts/unmounts pages and repaints. `keepPage` restores the scroll so
   * the current page stays where it is (what a zoom or a layout change must do).
   */
  private relayout(
    options: {
      readonly keepPage?: boolean;
      readonly rebuild?: boolean;
      readonly scroll?:
        | { readonly left: number; readonly top: number }
        | ((contentOffsetX: number) => { readonly left: number; readonly top: number });
    } = {},
  ): void {
    if (this.disposed) return;
    const previousTop = this.scroller.scrollTop;
    const previousRect = options.keepPage ? rectOfPage(this.table, this.currentPage) : undefined;
    this.table = this.buildTable();
    this.contentOffsetX = this.offsetXFor(this.table);

    const rowIndex = Math.max(0, rowOfPage(this.table, this.currentPage));
    const row = this.table.rows[rowIndex];
    const contentHeight = this.table.continuous
      ? this.table.height
      : (row?.height ?? 0) + CONTENT_PADDING * 2;
    this.content.style.width = `${Math.max(this.table.width, this.scroller.clientWidth)}px`;
    this.content.style.height = `${contentHeight}px`;

    if (options.scroll) {
      this.setScroll(
        typeof options.scroll === 'function' ? options.scroll(this.contentOffsetX) : options.scroll,
      );
    } else if (options.keepPage && previousRect) {
      const nextRect = rectOfPage(this.table, this.currentPage);
      if (nextRect && this.table.continuous) {
        const delta = previousTop - previousRect.y;
        this.setScroll({ left: this.scroller.scrollLeft, top: nextRect.y + delta });
      }
    }
    if (options.rebuild) {
      for (const view of this.views.values()) view.invalidate();
    }
    this.paint({ force: true });
  }

  /** Coalesces scroll events into one repaint per frame. */
  private schedule(): void {
    if (this.frame || this.disposed) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.updateCurrentPage();
      this.paint();
      this.emit();
    });
  }

  private updateCurrentPage(): void {
    if (!this.table.continuous) return;
    const page = pageAt(this.table, this.scroller.scrollTop, this.scroller.clientHeight);
    if (page !== this.currentPage) {
      this.currentPage = page;
      if (this.fitMode === 'visible') this.applyFit();
    }
  }

  /**
   * Mounts the pages near the viewport, moves each canvas window and repaints from the cache,
   * then asks the renderer for whatever is still missing.
   */
  private paint(options: { readonly force?: boolean } = {}): void {
    if (this.disposed) return;
    const top = this.scroller.scrollTop;
    const height = this.scroller.clientHeight;
    const rowIndex = Math.max(0, rowOfPage(this.table, this.currentPage));
    const row = this.table.rows[rowIndex];

    const wanted = this.table.continuous
      ? pagesInBand(this.table, top, height, height * MOUNT_MARGIN)
      : (row?.pages ?? []);

    for (const [index, view] of [...this.views]) {
      if (!wanted.includes(index)) {
        view.dispose();
        this.views.delete(index);
      }
    }

    const rowOffsetY = this.table.continuous ? 0 : (row?.y ?? 0) - CONTENT_PADDING;
    const requests: TileRequest[] = [];
    const bucket = bucketZoom(this.zoomFactor);
    const bucketId = bucketKey(this.zoomFactor);

    for (const page of wanted) {
      const rect = rectOfPage(this.table, page);
      const size = this.sizes[page];
      if (!rect || !size) continue;
      let view = this.views.get(page);
      if (!view) {
        view = new PageView({
          index: page,
          size,
          scale: this.zoomFactor,
          rotation: this.viewRotation,
          dpr: this.dpr,
        });
        if (this.activeTool) view.bindTool(this.activeTool);
        this.views.set(page, view);
        this.content.append(view.element);
      } else if (options.force) {
        view.update({ size, scale: this.zoomFactor, rotation: this.viewRotation, dpr: this.dpr });
      }
      view.place(rect.x + this.contentOffsetX, rect.y - rowOffsetY);

      // The part of this page the reader can see, in the page's own CSS px.
      const visible = {
        x: Math.max(0, this.scroller.scrollLeft - (rect.x + this.contentOffsetX)),
        y: Math.max(0, top - (rect.y - rowOffsetY)),
        width: Math.min(this.scroller.clientWidth, rect.width),
        height: Math.min(height, rect.height),
      };
      const moved = view.setVisible(visible);
      if (moved || options.force) this.repaintFromCache(view, bucketId);

      const focus = {
        x: visible.x + visible.width / 2,
        y: visible.y + visible.height / 2,
      };
      const distanceToViewport = Math.max(0, rect.y - (top + height), top - (rect.y + rect.height));
      for (const coord of orderByDistance(view.visibleTiles(), focus)) {
        requests.push(
          this.tileRequest(view.geometry, page, coord, bucket, bucketId, distanceToViewport, focus),
        );
      }
      void this.ensurePlaceholder(view, page);
    }

    this.renderer.reprioritise(this.viewportId, requests);
    this.schedulePrefetch(wanted, bucket, bucketId);
    this.onFrame?.();
  }

  private tileRequest(
    geometry: PageGeometry,
    page: number,
    coord: TileCoord,
    bucket: number,
    bucketId: number,
    pageDistance: number,
    focus: { readonly x: number; readonly y: number },
  ): TileRequest {
    const cx = (coord.col + 0.5) * TILE_SIZE;
    const cy = (coord.row + 0.5) * TILE_SIZE;
    const priority = pageDistance * 1000 + Math.hypot(cx - focus.x, cy - focus.y);
    return {
      doc: this.doc,
      docKey: this.docKey,
      page,
      geometry,
      coord,
      zoom: bucket,
      bucket: bucketId,
      dpr: this.dpr,
      rotation: this.viewRotation,
      flags: this.flags,
      priority,
    };
  }

  /** Paints every tile of a page that is already in the cache. Pure blitting — no engine. */
  private repaintFromCache(view: PageView, bucketId: number): void {
    for (const coord of view.visibleTiles()) {
      const id = this.renderer.idOf(
        this.tileRequest(
          view.geometry,
          view.index,
          coord,
          bucketZoom(this.zoomFactor),
          bucketId,
          0,
          {
            x: 0,
            y: 0,
          },
        ),
      );
      const bitmap = this.renderer.peek(id);
      if (bitmap) view.paintTile(coord, bitmap, id);
    }
  }

  private async ensurePlaceholder(view: PageView, page: number): Promise<void> {
    if (view.hasPlaceholder) return;
    const bitmap = await this.renderer.placeholder({
      doc: this.doc,
      docKey: this.docKey,
      page,
      geometry: view.geometry,
      rotation: this.viewRotation,
      flags: this.flags,
      maxEdge: 400,
    });
    if (!bitmap || this.disposed) return;
    const live = this.views.get(page);
    if (live === view && !view.hasPlaceholder) view.paintPlaceholder(bitmap);
  }

  /** Warms the neighbouring pages when the machine has a moment to spare. */
  private schedulePrefetch(visible: ReadonlyArray<number>, bucket: number, bucketId: number): void {
    if (this.idle) cancelIdle(this.idle);
    this.idle = requestIdle(() => {
      this.idle = 0;
      if (this.disposed || visible.length === 0) return;
      const first = Math.min(...visible);
      const last = Math.max(...visible);
      const neighbours = [first - 1, last + 1].filter(
        (p) => p >= 0 && p < this.sizes.length && !visible.includes(p),
      );
      const requests: TileRequest[] = [];
      for (const page of neighbours) {
        const size = this.sizes[page];
        const rect = rectOfPage(this.table, page);
        if (!size || !rect) continue;
        // Worked out from the geometry alone: a neighbour that is not on screen has no DOM, and
        // building one just to ask which tiles it would need is a page's worth of elements for
        // a calculation that is three lines of arithmetic.
        const geometry = new PageGeometry(size, this.viewRotation);
        const height = Math.min(rect.height, this.scroller.clientHeight);
        for (const coord of tilesForRect(
          { x: 0, y: 0, width: rect.width, height },
          rect.width,
          rect.height,
        )) {
          requests.push(
            this.tileRequest(geometry, page, coord, bucket, bucketId, 1e6, {
              x: 0,
              y: 0,
            }),
          );
        }
      }
      if (requests.length) this.renderer.prefetch(requests);
    });
  }

  private emit(): void {
    this.onStateChange?.(this.state);
  }
}

/** The viewer's own defaults; `TileRenderer.DEFAULT_FLAGS` is the engine-side shape. */
export const DEFAULT_VIEW_FLAGS: RenderFlags = {
  annotations: true,
  forms: true,
  grayscale: false,
  smoothText: true,
  smoothImages: true,
  smoothPaths: true,
  lineWeights: true,
  night: false,
};

function flagsEqual(a: RenderFlags, b: RenderFlags): boolean {
  return (Object.keys(a) as Array<keyof RenderFlags>).every((k) => a[k] === b[k]);
}

/** `requestIdleCallback` with a timeout fallback for platforms that lack it. */
function requestIdle(fn: () => void): number {
  const ric = (globalThis as { requestIdleCallback?: (cb: () => void, o?: object) => number })
    .requestIdleCallback;
  if (ric) return ric(fn, { timeout: 500 });
  // `setTimeout` is `number` in the DOM and `Timeout` under Node's types; the handle is opaque.
  const handle: unknown = globalThis.setTimeout(fn, 200);
  return handle as number;
}

function cancelIdle(handle: number): void {
  const cic = (globalThis as { cancelIdleCallback?: (h: number) => void }).cancelIdleCallback;
  if (cic) cic(handle);
  else globalThis.clearTimeout(handle);
}

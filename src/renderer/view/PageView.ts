/**
 * `PageView` — one page's DOM: the six overlay layers, the tile canvas and the pointer bridge
 * to the active tool (M00 shell; filled in by M11).
 *
 * The canvas is a **window on to the page, not the page**. At 6400 % an A4 page is roughly
 * 38 000 × 54 000 CSS px, which no canvas can hold; instead the canvas covers the part of the
 * page the viewport can see, grown by a margin, and is repositioned as the reader scrolls.
 * Repositioning repaints from the tile cache, so scrolling never asks the engine for anything —
 * that is what "never re-render on scroll" means in practice.
 *
 * Only the raster layer is populated here. `text` is a host for M13, `annot` for M30, `widget`
 * for M60, `object` for M50; they exist from the start so later modules add behaviour, not DOM.
 */

import type { PageIndex, PageSize, Rotation } from '@shared/pdf';
import { PageGeometry } from '@engine/geometry';
import type { ToolPointerEvent, ToolSpec } from '@shared/module';
import { createPageLayers, resizeLayers, type PageLayers } from './Layers';
import { PageTransform } from './Viewport';
import { TILE_SIZE, tileRect, tilesForRect, type PxRect, type TileCoord } from './tiles';

export interface PageViewOptions {
  readonly index: PageIndex;
  readonly size: PageSize;
  /** CSS pixels per point. */
  readonly scale: number;
  readonly rotation?: Rotation;
  /** Device pixel ratio for the raster canvas. Defaults to the window's. */
  readonly dpr?: number;
}

/** How much of the page beyond the viewport the canvas keeps ready, in CSS px. */
export const CANVAS_MARGIN = TILE_SIZE;

/** Where the raster canvas currently sits inside the page, in CSS px. */
export interface CanvasWindow extends PxRect {}

export class PageView {
  readonly index: PageIndex;
  readonly layers: PageLayers;
  private size: PageSize;
  private scale: number;
  private rotation: Rotation;
  private dpr: number;
  private transformCache: PageTransform;
  private geometryCache: PageGeometry;
  private window: CanvasWindow = { x: 0, y: 0, width: 0, height: 0 };
  private painted = new Set<string>();
  private placeholderPainted = false;
  private toolFor: (() => ToolSpec | null) | null = null;
  private readonly pointerHandlers: Array<[string, EventListener]> = [];

  constructor(options: PageViewOptions) {
    this.index = options.index;
    this.size = options.size;
    this.scale = options.scale;
    this.rotation = options.rotation ?? 0;
    this.dpr = options.dpr ?? (globalThis.devicePixelRatio || 1);
    const root = document.createElement('div');
    root.dataset['page'] = String(options.index);
    root.setAttribute('role', 'img');
    root.setAttribute('aria-label', `Page ${options.index + 1}`);
    this.layers = createPageLayers(root);
    this.transformCache = new PageTransform(this.size, this.scale, this.rotation);
    this.geometryCache = new PageGeometry(this.size, this.rotation);
    this.layout();
  }

  get element(): HTMLElement {
    return this.layers.root;
  }

  get transform(): PageTransform {
    return this.transformCache;
  }

  /** The geometry the tile renderer needs (`/Rotate` + CropBox + the view rotation). */
  get geometry(): PageGeometry {
    return this.geometryCache;
  }

  get widthPx(): number {
    return this.transformCache.widthPx;
  }

  get heightPx(): number {
    return this.transformCache.heightPx;
  }

  get canvasWindow(): CanvasWindow {
    return this.window;
  }

  /** True once the low-resolution whole-page render has been drawn. */
  get hasPlaceholder(): boolean {
    return this.placeholderPainted;
  }

  /** Updates scale / rotation / size. Any change clears the canvas — tiles repaint into it. */
  update(patch: Partial<Pick<PageViewOptions, 'size' | 'scale' | 'rotation' | 'dpr'>>): void {
    const changed =
      (patch.size !== undefined && patch.size !== this.size) ||
      (patch.scale !== undefined && patch.scale !== this.scale) ||
      (patch.rotation !== undefined && patch.rotation !== this.rotation) ||
      (patch.dpr !== undefined && patch.dpr !== this.dpr);
    if (patch.size) this.size = patch.size;
    if (patch.scale !== undefined) this.scale = patch.scale;
    if (patch.rotation !== undefined) this.rotation = patch.rotation;
    if (patch.dpr !== undefined) this.dpr = patch.dpr;
    if (!changed) return;
    this.transformCache = new PageTransform(this.size, this.scale, this.rotation);
    this.geometryCache = new PageGeometry(this.size, this.rotation);
    this.invalidate();
    this.layout();
  }

  /** Places the page box in the scrolling content. */
  place(x: number, y: number): void {
    const style = this.layers.root.style;
    style.left = `${x}px`;
    style.top = `${y}px`;
  }

  /** Forgets what has been painted, so the next `paint*` call redraws everything. */
  invalidate(): void {
    this.painted.clear();
    this.placeholderPainted = false;
  }

  /**
   * Moves the canvas so it covers `visible` (CSS px inside the page) plus a margin. Returns
   * true when the window moved, meaning the caller should repaint from the cache.
   */
  setVisible(visible: PxRect): boolean {
    const w = Math.min(this.widthPx, Math.max(1, visible.width + CANVAS_MARGIN * 2));
    const h = Math.min(this.heightPx, Math.max(1, visible.height + CANVAS_MARGIN * 2));
    // Snap to the tile grid so the window only moves in whole tiles: fewer repaints, and the
    // tiles we paint always line up with the canvas.
    const x = clamp(Math.floor((visible.x - CANVAS_MARGIN) / TILE_SIZE) * TILE_SIZE, 0, this.widthPx - w);
    const y = clamp(Math.floor((visible.y - CANVAS_MARGIN) / TILE_SIZE) * TILE_SIZE, 0, this.heightPx - h);
    const next: CanvasWindow = { x: Math.max(0, x), y: Math.max(0, y), width: w, height: h };
    if (
      next.x === this.window.x &&
      next.y === this.window.y &&
      next.width === this.window.width &&
      next.height === this.window.height
    ) {
      return false;
    }
    this.window = next;
    const canvas = this.layers.raster;
    canvas.style.left = `${next.x}px`;
    canvas.style.top = `${next.y}px`;
    canvas.style.width = `${next.width}px`;
    canvas.style.height = `${next.height}px`;
    canvas.width = Math.max(1, Math.round(next.width * this.dpr));
    canvas.height = Math.max(1, Math.round(next.height * this.dpr));
    this.painted.clear();
    this.placeholderPainted = false;
    return true;
  }

  /** The tiles that would cover the current canvas window. */
  visibleTiles(): TileCoord[] {
    return tilesForRect(this.window, this.widthPx, this.heightPx);
  }

  /** Draws the low-resolution whole-page bitmap under whatever tiles exist. */
  paintPlaceholder(bitmap: ImageBitmap): void {
    const ctx = this.context();
    if (!ctx) return;
    const scaleX = (this.widthPx * this.dpr) / bitmap.width;
    const scaleY = (this.heightPx * this.dpr) / bitmap.height;
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'low';
    ctx.translate(-this.window.x * this.dpr, -this.window.y * this.dpr);
    ctx.scale(scaleX, scaleY);
    ctx.drawImage(bitmap, 0, 0);
    ctx.restore();
    this.placeholderPainted = true;
  }

  /** Draws one tile at its place in the canvas. No-op when it lies outside the window. */
  paintTile(coord: TileCoord, bitmap: ImageBitmap, id: string): void {
    const ctx = this.context();
    if (!ctx) return;
    const rect = tileRect(coord, this.widthPx, this.heightPx);
    if (rect.width <= 0 || rect.height <= 0) return;
    const x = (rect.x - this.window.x) * this.dpr;
    const y = (rect.y - this.window.y) * this.dpr;
    if (
      x + bitmap.width < 0 ||
      y + bitmap.height < 0 ||
      x > this.layers.raster.width ||
      y > this.layers.raster.height
    ) {
      return;
    }
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    // The engine snaps tiles to whole device pixels, so the bitmap may be a pixel bigger than
    // the nominal tile; draw it at its own size rather than stretching it.
    ctx.drawImage(bitmap, Math.round(x), Math.round(y));
    ctx.restore();
    this.painted.add(id);
  }

  hasPainted(id: string): boolean {
    return this.painted.has(id);
  }

  /** Marks the page busy for the "still rendering" affordance and screen readers. */
  setBusy(busy: boolean): void {
    this.layers.root.classList.toggle('page-busy', busy);
    if (busy) this.layers.root.setAttribute('aria-busy', 'true');
    else this.layers.root.removeAttribute('aria-busy');
  }

  /**
   * Sends pointer events on the tool layer to the active tool, in PDF user space. M02 built the
   * tools service but nothing fed it; this is the feed.
   */
  bindTool(activeTool: () => ToolSpec | null): void {
    this.toolFor = activeTool;
    const layer = this.layers.tool;
    const handler =
      (kind: 'onPointerDown' | 'onPointerMove' | 'onPointerUp') =>
      (event: Event): void => {
        const tool = this.toolFor?.();
        const fn = tool?.[kind];
        if (!tool || !fn) return;
        const e = event as PointerEvent;
        const consumed = fn.call(tool, this.toolEvent(e));
        if (consumed) {
          event.preventDefault();
          event.stopPropagation();
        }
      };
    const pairs: Array<[string, EventListener]> = [
      ['pointerdown', handler('onPointerDown')],
      ['pointermove', handler('onPointerMove')],
      ['pointerup', handler('onPointerUp')],
    ];
    for (const [type, fn] of pairs) {
      layer.addEventListener(type, fn);
      this.pointerHandlers.push([type, fn]);
    }
  }

  /** Converts a pointer event on this page into the tool contract's page coordinates. */
  toolEvent(e: PointerEvent): ToolPointerEvent {
    const box = this.layers.root.getBoundingClientRect();
    const clientX = e.clientX - box.left;
    const clientY = e.clientY - box.top;
    const point = this.transformCache.toPage({ x: clientX, y: clientY });
    return {
      page: this.index,
      x: point.x,
      y: point.y,
      clientX,
      clientY,
      buttons: e.buttons,
      shiftKey: e.shiftKey,
      ctrlKey: e.ctrlKey,
      altKey: e.altKey,
      metaKey: e.metaKey,
      original: e,
    };
  }

  dispose(): void {
    for (const [type, fn] of this.pointerHandlers) this.layers.tool.removeEventListener(type, fn);
    this.pointerHandlers.length = 0;
    this.toolFor = null;
    this.layers.root.remove();
  }

  private context(): CanvasRenderingContext2D | null {
    return this.layers.raster.getContext('2d', { alpha: false });
  }

  private layout(): void {
    const t = this.transformCache;
    resizeLayers(this.layers, t.widthPx, t.heightPx);
    this.window = { x: 0, y: 0, width: 0, height: 0 };
    this.setVisible({ x: 0, y: 0, width: t.widthPx, height: t.heightPx });
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

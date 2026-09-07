/**
 * `Viewport` — maps between PDF page space and device pixels (M00 typed shell; M11 builds
 * the scrolling/zooming viewer on top).
 *
 * Page space: points, origin bottom-left, y up (see `src/shared/pdf.ts`).
 * Device space: CSS pixels relative to the page element, origin top-left, y down.
 * `scale` is CSS pixels per point; multiply by `devicePixelRatio` for raster sizes.
 */

import type { PageSize, PdfPoint, PdfRect, Rotation } from '@shared/pdf';

export type ZoomMode = 'custom' | 'fit-page' | 'fit-width' | 'fit-visible';
export type LayoutMode = 'single' | 'continuous' | 'facing' | 'facing-continuous' | 'book';

export interface ViewportState {
  readonly zoom: number;
  readonly zoomMode: ZoomMode;
  readonly layout: LayoutMode;
  /** Extra view rotation applied to every page (View ▸ Rotate), clockwise. */
  readonly rotation: Rotation;
  /** 0-based index of the page most visible in the viewport. */
  readonly currentPage: number;
}

/** Minimum and maximum zoom (Foxit: 1 %..6400 %). */
export const MIN_ZOOM = 0.01;
export const MAX_ZOOM = 64;

/** Zoom steps used by Zoom In / Zoom Out. */
export const ZOOM_STEPS: readonly number[] = [
  0.1, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4, 6, 8, 12, 16, 24, 32, 64,
];

/** Clamp a zoom factor into range. */
export function clampZoom(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

/** The next zoom step above or below `zoom`. */
export function stepZoom(zoom: number, direction: 1 | -1): number {
  if (direction > 0) return ZOOM_STEPS.find((z) => z > zoom + 1e-6) ?? MAX_ZOOM;
  for (let i = ZOOM_STEPS.length - 1; i >= 0; i--) {
    const z = ZOOM_STEPS[i];
    if (z !== undefined && z < zoom - 1e-6) return z;
  }
  return MIN_ZOOM;
}

/**
 * Coordinate transform for one page at a given scale and rotation. All methods are pure.
 * `rotation` is the *total* rotation (page `/Rotate` + view rotation) applied when mapping
 * from unrotated page space to the displayed box.
 */
export class PageTransform {
  readonly scale: number;
  readonly rotation: Rotation;
  /** Unrotated crop box in page space. */
  readonly box: PdfRect;
  /** Displayed width/height in CSS pixels. */
  readonly widthPx: number;
  readonly heightPx: number;

  constructor(size: PageSize, scale: number, extraRotation: Rotation = 0) {
    this.scale = scale;
    this.rotation = ((size.rotation + extraRotation) % 360) as Rotation;
    this.box = size.cropBox;
    const w = (this.box.x1 - this.box.x0) * scale;
    const h = (this.box.y1 - this.box.y0) * scale;
    const swap = this.rotation === 90 || this.rotation === 270;
    this.widthPx = swap ? h : w;
    this.heightPx = swap ? w : h;
  }

  /** Page point → device pixel (origin top-left of the displayed page). */
  toDevice(p: PdfPoint): { x: number; y: number } {
    // First to unrotated device space (y flipped), then rotate clockwise.
    const ux = (p.x - this.box.x0) * this.scale;
    const uy = (this.box.y1 - p.y) * this.scale;
    const w = (this.box.x1 - this.box.x0) * this.scale;
    const h = (this.box.y1 - this.box.y0) * this.scale;
    switch (this.rotation) {
      case 0:
        return { x: ux, y: uy };
      case 90:
        return { x: h - uy, y: ux };
      case 180:
        return { x: w - ux, y: h - uy };
      case 270:
        return { x: uy, y: w - ux };
    }
  }

  /** Device pixel → page point. Inverse of `toDevice`. */
  toPage(d: { x: number; y: number }): PdfPoint {
    const w = (this.box.x1 - this.box.x0) * this.scale;
    const h = (this.box.y1 - this.box.y0) * this.scale;
    let ux: number;
    let uy: number;
    switch (this.rotation) {
      case 0:
        ux = d.x;
        uy = d.y;
        break;
      case 90:
        ux = d.y;
        uy = h - d.x;
        break;
      case 180:
        ux = w - d.x;
        uy = h - d.y;
        break;
      case 270:
        ux = w - d.y;
        uy = d.x;
        break;
    }
    return { x: this.box.x0 + ux / this.scale, y: this.box.y1 - uy / this.scale };
  }

  /** Page rect → device rect `{ left, top, width, height }`. */
  rectToDevice(r: PdfRect): { left: number; top: number; width: number; height: number } {
    const a = this.toDevice({ x: r.x0, y: r.y0 });
    const b = this.toDevice({ x: r.x1, y: r.y1 });
    const left = Math.min(a.x, b.x);
    const top = Math.min(a.y, b.y);
    return { left, top, width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y) };
  }
}

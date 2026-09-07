/**
 * `PageGeometry` — the one place that knows how PDF page space maps to device pixels (M10).
 *
 * Page space: PDF points, origin bottom-left of the *unrotated* page, y up (`@shared/pdf`).
 * Device space: pixels (or CSS px — the caller chooses via `scale`), origin at the top-left
 * corner of the *displayed* page, y down. "Displayed" means the CropBox (clipped to the
 * MediaBox, as PDFium does) after `/Rotate` and any extra view rotation.
 *
 * `scale` is device units per point. The class is pure and cheap; create one per page and keep
 * it. It agrees with `PageTransform` in `src/renderer/view/Viewport.ts` (tested), and adds what
 * the renderer/tiler needs: rect conversions, integer tile snapping and PDFium's rotate code.
 */

import {
  normalizeRect,
  type PageSize,
  type PdfPoint,
  type PdfRect,
  type Rotation,
} from '@shared/pdf';

/** A rectangle in device space (origin top-left, y down). */
export interface DeviceRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface DevicePoint {
  readonly x: number;
  readonly y: number;
}

/** A tile request resolved to integer device pixels plus the page rect it covers. */
export interface Tile {
  /** Integer pixel rect inside the displayed page bitmap. */
  readonly device: DeviceRect;
  /** The page-space rect that `device` covers exactly (may be slightly larger than requested). */
  readonly page: PdfRect;
  /** Full displayed page size in device pixels at this scale (integers). */
  readonly pageWidthPx: number;
  readonly pageHeightPx: number;
}

/** Intersects two normalised rects; falls back to `a` when they do not overlap. */
export function intersectRect(a: PdfRect, b: PdfRect): PdfRect {
  const r = {
    x0: Math.max(a.x0, b.x0),
    y0: Math.max(a.y0, b.y0),
    x1: Math.min(a.x1, b.x1),
    y1: Math.min(a.y1, b.y1),
  };
  return r.x1 > r.x0 && r.y1 > r.y0 ? r : a;
}

/** Normalises any angle to a `Rotation`. */
export function normalizeRotation(deg: number): Rotation {
  const r = (((Math.round(deg / 90) * 90) % 360) + 360) % 360;
  return r as Rotation;
}

export class PageGeometry {
  /** The page's own `/Rotate`. */
  readonly pageRotation: Rotation;
  /** Extra view rotation (View ▸ Rotate), clockwise. */
  readonly extraRotation: Rotation;
  /** Total clockwise rotation applied when displaying. */
  readonly rotation: Rotation;
  /** The displayed box in unrotated page space (CropBox ∩ MediaBox). */
  readonly box: PdfRect;
  /** The raw boxes, normalised. */
  readonly cropBox: PdfRect;
  readonly mediaBox: PdfRect;
  /** Displayed width/height in points (after rotation). */
  readonly width: number;
  readonly height: number;

  constructor(size: PageSize, extraRotation: Rotation = 0) {
    this.pageRotation = size.rotation;
    this.extraRotation = extraRotation;
    this.rotation = normalizeRotation(size.rotation + extraRotation);
    this.cropBox = normalizeRect(size.cropBox);
    this.mediaBox = normalizeRect(size.mediaBox);
    this.box = intersectRect(this.cropBox, this.mediaBox);
    const w = this.box.x1 - this.box.x0;
    const h = this.box.y1 - this.box.y0;
    const swap = this.rotation === 90 || this.rotation === 270;
    this.width = swap ? h : w;
    this.height = swap ? w : h;
  }

  /** Builds the geometry straight from the page boxes and `/Rotate`. */
  static fromBoxes(mediaBox: PdfRect, cropBox: PdfRect, rotate: Rotation, extra: Rotation = 0) {
    const box = intersectRect(normalizeRect(cropBox), normalizeRect(mediaBox));
    const swap = rotate === 90 || rotate === 270;
    const w = box.x1 - box.x0;
    const h = box.y1 - box.y0;
    const size: PageSize = {
      width: swap ? h : w,
      height: swap ? w : h,
      rotation: rotate,
      cropBox: normalizeRect(cropBox),
      mediaBox: normalizeRect(mediaBox),
    };
    return new PageGeometry(size, extra);
  }

  /** The `PageSize` this geometry describes (without the extra view rotation). */
  get pageSize(): PageSize {
    const swap = this.pageRotation === 90 || this.pageRotation === 270;
    const w = this.box.x1 - this.box.x0;
    const h = this.box.y1 - this.box.y0;
    return {
      width: swap ? h : w,
      height: swap ? w : h,
      rotation: this.pageRotation,
      cropBox: this.cropBox,
      mediaBox: this.mediaBox,
    };
  }

  /** PDFium's `rotate` argument for the *extra* rotation (0..3 = 0°, 90°, 180°, 270° cw). */
  get pdfiumRotate(): 0 | 1 | 2 | 3 {
    return (this.extraRotation / 90) as 0 | 1 | 2 | 3;
  }

  /** Displayed size in device pixels, rounded to whole pixels (never below 1×1). */
  devicePageSize(scale: number): { width: number; height: number } {
    return {
      width: Math.max(1, Math.round(this.width * scale)),
      height: Math.max(1, Math.round(this.height * scale)),
    };
  }

  /** Page point → device pixel. */
  toDevice(p: PdfPoint, scale: number): DevicePoint {
    const ux = (p.x - this.box.x0) * scale;
    const uy = (this.box.y1 - p.y) * scale;
    const w = (this.box.x1 - this.box.x0) * scale;
    const h = (this.box.y1 - this.box.y0) * scale;
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

  /** Device pixel → page point. Inverse of {@link toDevice}. */
  toPage(d: DevicePoint, scale: number): PdfPoint {
    const w = (this.box.x1 - this.box.x0) * scale;
    const h = (this.box.y1 - this.box.y0) * scale;
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
    return { x: this.box.x0 + ux / scale, y: this.box.y1 - uy / scale };
  }

  /** Page rect → device rect. */
  rectToDevice(r: PdfRect, scale: number): DeviceRect {
    const a = this.toDevice({ x: r.x0, y: r.y0 }, scale);
    const b = this.toDevice({ x: r.x1, y: r.y1 }, scale);
    return {
      x: Math.min(a.x, b.x),
      y: Math.min(a.y, b.y),
      width: Math.abs(b.x - a.x),
      height: Math.abs(b.y - a.y),
    };
  }

  /** Device rect → page rect (normalised). */
  rectToPage(d: DeviceRect, scale: number): PdfRect {
    const a = this.toPage({ x: d.x, y: d.y }, scale);
    const b = this.toPage({ x: d.x + d.width, y: d.y + d.height }, scale);
    return normalizeRect({ x0: a.x, y0: a.y, x1: b.x, y1: b.y });
  }

  /**
   * Resolves a render request to an integer tile: the requested page rect (whole page when
   * omitted) is mapped to device pixels, snapped outwards to whole pixels and clamped to the
   * page bitmap. The returned `page` rect is what the tile really covers.
   */
  tile(rect: PdfRect | undefined, scale: number): Tile {
    const page = this.devicePageSize(scale);
    if (!rect) {
      return {
        device: { x: 0, y: 0, width: page.width, height: page.height },
        page: this.rectToPage({ x: 0, y: 0, width: page.width, height: page.height }, scale),
        pageWidthPx: page.width,
        pageHeightPx: page.height,
      };
    }
    // Use the *rounded* page size as the scale reference so tiles align with the full bitmap.
    const effScale = this.width > 0 ? page.width / this.width : scale;
    const d = this.rectToDevice(normalizeRect(rect), effScale);
    const x0 = Math.max(0, Math.floor(d.x + 1e-6));
    const y0 = Math.max(0, Math.floor(d.y + 1e-6));
    const x1 = Math.min(page.width, Math.ceil(d.x + d.width - 1e-6));
    const y1 = Math.min(page.height, Math.ceil(d.y + d.height - 1e-6));
    const device = {
      x: x0,
      y: y0,
      width: Math.max(1, x1 - x0),
      height: Math.max(1, y1 - y0),
    };
    return {
      device,
      page: this.rectToPage(device, effScale),
      pageWidthPx: page.width,
      pageHeightPx: page.height,
    };
  }
}

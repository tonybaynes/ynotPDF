/**
 * Where a decoration goes (M53) — pure geometry, no drawing.
 *
 * Everything is worked out in **display space**: the page as the reader sees it, origin at the
 * bottom-left, `/Rotate` already applied. That is the only frame in which "top-right corner"
 * means what a person means by it, and it is why a header stays at the top of a page turned 90°
 * instead of running down its side. {@link displayToPage} is the matrix back.
 */

import type { PdfMatrix, PdfRect } from '@shared/pdf';
import { rectHeight, rectWidth } from '@shared/pdf';
import { multiply } from '../content/matrix';
import type { Margins, PositionName, ZoneName } from './types';

/** The page as the reader sees it: `/Rotate` applied to the crop box. */
export function displaySize(box: PdfRect, rotation: number): { width: number; height: number } {
  const w = rectWidth(box);
  const h = rectHeight(box);
  return normalRotation(rotation) % 180 === 90 ? { width: h, height: w } : { width: w, height: h };
}

/** `/Rotate` reduced to 0, 90, 180 or 270 — a file may write 450, or −90. */
export function normalRotation(rotation: number): number {
  const r = Math.round(rotation / 90) * 90;
  return ((r % 360) + 360) % 360;
}

/**
 * The matrix from display space to page space.
 *
 * Derived rather than guessed: a page with `/Rotate 90` is turned a quarter-turn **clockwise**
 * for display, so the page's own "up" becomes the display's "right". Feeding the four corners of
 * each rotation through these matrices is `test/unit/decorations/layout.test.ts`'s first job.
 */
export function displayToPage(box: PdfRect, rotation: number): PdfMatrix {
  const w = rectWidth(box);
  const h = rectHeight(box);
  switch (normalRotation(rotation)) {
    case 90:
      return [0, 1, -1, 0, box.x0 + w, box.y0];
    case 180:
      return [-1, 0, 0, -1, box.x0 + w, box.y0 + h];
    case 270:
      return [0, -1, 1, 0, box.x0, box.y0 + h];
    default:
      return [1, 0, 0, 1, box.x0, box.y0];
  }
}

/** Whether a zone belongs to the header or the footer. */
export function isHeaderZone(zone: ZoneName): boolean {
  return zone.startsWith('header');
}

/** left / centre / right, from a zone name. */
export function zoneAlign(zone: ZoneName): 'left' | 'centre' | 'right' {
  if (zone.endsWith('left')) return 'left';
  if (zone.endsWith('right')) return 'right';
  return 'centre';
}

/**
 * Where one zone's text sits, in display space.
 *
 * The header's baseline is one cap-height below the top margin and the footer's one descender
 * above the bottom one, so the *ink* respects the margin rather than the font's invisible box —
 * which is what a reader measuring with a ruler expects.
 */
export function zoneBaseline(
  zone: ZoneName,
  page: { readonly width: number; readonly height: number },
  margins: Margins,
  size: number,
): number {
  return isHeaderZone(zone) ? page.height - margins.top - size * 0.8 : margins.bottom + size * 0.22;
}

/** The x a line of `width` starts at, for a zone's alignment. */
export function zoneX(
  zone: ZoneName,
  page: { readonly width: number },
  margins: Margins,
  width: number,
): number {
  switch (zoneAlign(zone)) {
    case 'left':
      return margins.left;
    case 'right':
      return page.width - margins.right - width;
    default: {
      const inner = page.width - margins.left - margins.right;
      return margins.left + Math.max(0, (inner - width) / 2);
    }
  }
}

/** The nine anchor points, as fractions of the page in each axis. */
const ANCHORS: Readonly<Record<PositionName, readonly [number, number]>> = {
  'top-left': [0, 1],
  'top-centre': [0.5, 1],
  'top-right': [1, 1],
  'middle-left': [0, 0.5],
  centre: [0.5, 0.5],
  'middle-right': [1, 0.5],
  'bottom-left': [0, 0],
  'bottom-centre': [0.5, 0],
  'bottom-right': [1, 0],
};

/** The bounding box of `rect` after rotating it by `degrees` about its own centre. */
export function rotatedExtent(
  rect: PdfRect,
  degrees: number,
): { readonly width: number; readonly height: number } {
  const rad = (degrees * Math.PI) / 180;
  const c = Math.abs(Math.cos(rad));
  const s = Math.abs(Math.sin(rad));
  const w = rectWidth(rect);
  const h = rectHeight(rect);
  return { width: w * c + h * s, height: w * s + h * c };
}

export interface PlacementOptions {
  /** Anticlockwise degrees about the decoration's own centre. */
  readonly rotation: number;
  /**
   * The decoration's width as a fraction of the page's width. 0 keeps its natural size. The
   * width is measured *before* rotation, which is what makes "50 %" mean the same thing at 0°
   * and at 45°.
   */
  readonly scale: number;
  readonly position: PositionName;
  readonly offsetX: number;
  readonly offsetY: number;
  /** Keep the whole decoration inside the page after rotation and scaling. */
  readonly clampToPage?: boolean;
}

/**
 * The matrix that puts a decoration's own box on the page, in display space.
 *
 * Order is scale, then rotate about the centre, then translate — so a reader who turns a
 * watermark 45° sees it turn on the spot rather than swing away from where it was.
 */
export function placement(
  bbox: PdfRect,
  page: { readonly width: number; readonly height: number },
  options: PlacementOptions,
): PdfMatrix {
  const w = rectWidth(bbox);
  const h = rectHeight(bbox);
  if (w <= 0 || h <= 0) return [1, 0, 0, 1, 0, 0];
  const factor = options.scale > 0 ? (page.width * options.scale) / w : 1;
  const scaled = { x0: 0, y0: 0, x1: w * factor, y1: h * factor };
  const extent = rotatedExtent(scaled, options.rotation);
  const [ax, ay] = ANCHORS[options.position] ?? ANCHORS.centre;
  let cx = ax * page.width + (0.5 - ax) * extent.width + options.offsetX;
  let cy = ay * page.height + (0.5 - ay) * extent.height + options.offsetY;
  if (options.clampToPage !== false) {
    cx = clamp(cx, extent.width / 2, page.width - extent.width / 2);
    cy = clamp(cy, extent.height / 2, page.height - extent.height / 2);
  }
  const rad = (options.rotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  // Move the box's own centre to the origin, scale, rotate, then move to the anchor.
  const toOrigin: PdfMatrix = [1, 0, 0, 1, -(bbox.x0 + w / 2), -(bbox.y0 + h / 2)];
  const scaleM: PdfMatrix = [factor, 0, 0, factor, 0, 0];
  const rotate: PdfMatrix = [cos, sin, -sin, cos, 0, 0];
  const place: PdfMatrix = [1, 0, 0, 1, cx, cy];
  return multiply(multiply(multiply(toOrigin, scaleM), rotate), place);
}

function clamp(value: number, low: number, high: number): number {
  // A decoration wider than the page has `low > high`; centring it is the least wrong answer.
  return low > high ? (low + high) / 2 : Math.min(high, Math.max(low, value));
}

/**
 * The matrix that shrinks a page's own content into `fraction` of itself, centred.
 *
 * `0` and `1` both mean "leave it alone". The content is centred rather than pinned to a corner
 * because a page shrunk to make room at the top would otherwise lose its bottom margin.
 */
export function shrinkMatrix(box: PdfRect, fraction: number): PdfMatrix | null {
  if (!(fraction > 0) || fraction >= 1) return null;
  const w = rectWidth(box);
  const h = rectHeight(box);
  const cx = box.x0 + w / 2;
  const cy = box.y0 + h / 2;
  return [fraction, 0, 0, fraction, cx - fraction * cx, cy - fraction * cy];
}

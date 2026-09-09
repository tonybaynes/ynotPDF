/**
 * The tools' arithmetic (M31). Pure: constraining a drag with Shift, scaling geometry into a new
 * rect, moving it, and the rect a shape occupies.
 *
 * Everything is page space, points, origin bottom-left. Snapping to the grid is `Viewer.snap()`
 * (M11) and is applied by the tools *before* any of this, so a constrained point is a snapped one.
 */

import type { PdfPoint, PdfRect } from '@shared/pdf';

/** Shift on a rectangle or an ellipse: a square, keeping the corner the drag started from. */
export function constrainBox(from: PdfPoint, to: PdfPoint): PdfPoint {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const side = Math.max(Math.abs(dx), Math.abs(dy));
  return { x: from.x + Math.sign(dx || 1) * side, y: from.y + Math.sign(dy || 1) * side };
}

/** Shift on a line or a polygon edge: snapped to the nearest 45°. */
export function constrainAngle(from: PdfPoint, to: PdfPoint): PdfPoint {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy);
  if (length < 1e-9) return to;
  const angle = Math.atan2(dy, dx);
  const step = Math.PI / 4;
  const snapped = Math.round(angle / step) * step;
  return { x: from.x + length * Math.cos(snapped), y: from.y + length * Math.sin(snapped) };
}

/** The normalised rect between two corners. */
export function rectBetween(a: PdfPoint, b: PdfPoint): PdfRect {
  return {
    x0: Math.min(a.x, b.x),
    y0: Math.min(a.y, b.y),
    x1: Math.max(a.x, b.x),
    y1: Math.max(a.y, b.y),
  };
}

export function offsetRect(r: PdfRect, dx: number, dy: number): PdfRect {
  return { x0: r.x0 + dx, y0: r.y0 + dy, x1: r.x1 + dx, y1: r.y1 + dy };
}

export function offsetPoints(points: ReadonlyArray<PdfPoint>, dx: number, dy: number): PdfPoint[] {
  return points.map((p) => ({ x: p.x + dx, y: p.y + dy }));
}

/**
 * Maps points from one rect to another, so a resize scales a polygon's corners or an ink stroke
 * with the box around it. A rect with no width or height in one direction leaves that axis alone
 * rather than dividing by zero.
 */
export function scalePoints(
  points: ReadonlyArray<PdfPoint>,
  from: PdfRect,
  to: PdfRect,
): PdfPoint[] {
  const fw = from.x1 - from.x0;
  const fh = from.y1 - from.y0;
  const sx = fw > 1e-9 ? (to.x1 - to.x0) / fw : 1;
  const sy = fh > 1e-9 ? (to.y1 - to.y0) / fh : 1;
  return points.map((p) => ({
    x: to.x0 + (p.x - from.x0) * sx,
    y: to.y0 + (p.y - from.y0) * sy,
  }));
}

/** The rect with `pad` taken off every side; never turned inside out. */
export function insetRect(r: PdfRect, pad: number): PdfRect {
  const x0 = Math.min(r.x0 + pad, (r.x0 + r.x1) / 2);
  const y0 = Math.min(r.y0 + pad, (r.y0 + r.y1) / 2);
  return { x0, y0, x1: Math.max(r.x1 - pad, x0), y1: Math.max(r.y1 - pad, y0) };
}

/** A rect at least `min` wide and high, grown from its corner when it is smaller. */
export function atLeast(r: PdfRect, min: number): PdfRect {
  return {
    x0: r.x0,
    y0: r.y0,
    x1: Math.max(r.x1, r.x0 + min),
    y1: Math.max(r.y1, r.y0 + min),
  };
}

/** Whether two points are within `tolerance` of each other. */
export function samePoint(a: PdfPoint, b: PdfPoint, tolerance = 2): boolean {
  return Math.abs(a.x - b.x) <= tolerance && Math.abs(a.y - b.y) <= tolerance;
}

/** The quad (8 numbers, top-left first as `/QuadPoints` wants) covering a rect. */
export function quadOfRect(r: PdfRect): number[] {
  return [r.x0, r.y1, r.x1, r.y1, r.x0, r.y0, r.x1, r.y0];
}

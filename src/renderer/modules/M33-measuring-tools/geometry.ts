/**
 * M33's geometry. Pure, and the only place any of these questions is answered.
 *
 * Four of the five are the ones the brief names — segment intersection, polygon area (shoelace),
 * point-to-segment distance and the length of a path; the shoelace and the path length live in
 * `engine/appearance/measure.ts`, because the appearance generator needs them too, and are
 * re-exported here so a caller has one place to look.
 *
 * Everything is page space, points, origin bottom-left. Nothing here knows about the DOM, the
 * document or the scale: it is arithmetic over points, and it is unit-tested as such.
 */

import type { PdfPoint, PdfRect } from '@shared/pdf';
import { pathLength, polygonArea, shoelace } from '@engine/appearance';

export { pathLength, polygonArea, shoelace };

/** How close two coordinates have to be before they are treated as the same. */
const EPSILON = 1e-9;

/** The point on the segment `a`–`b` nearest to `p`, and how far along it that is (0..1). */
export function nearestOnSegment(
  p: PdfPoint,
  a: PdfPoint,
  b: PdfPoint,
): { readonly point: PdfPoint; readonly t: number } {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared < EPSILON) return { point: { x: a.x, y: a.y }, t: 0 };
  const raw = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSquared;
  const t = Math.max(0, Math.min(1, raw));
  return { point: { x: a.x + dx * t, y: a.y + dy * t }, t };
}

/** The distance from a point to the segment `a`–`b`. */
export function pointSegmentDistance(p: PdfPoint, a: PdfPoint, b: PdfPoint): number {
  const { point } = nearestOnSegment(p, a, b);
  return Math.hypot(p.x - point.x, p.y - point.y);
}

/** The distance from a point to the nearest of a polyline's segments; `Infinity` when it has none. */
export function pointPathDistance(p: PdfPoint, points: ReadonlyArray<PdfPoint>): number {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    if (a && b) best = Math.min(best, pointSegmentDistance(p, a, b));
  }
  return best;
}

/**
 * Where the segments `a1`–`a2` and `b1`–`b2` cross, or null when they do not.
 *
 * Only a true crossing counts — the point has to be **inside both segments**, ends included.
 * Parallel segments never intersect here, collinear overlapping ones included: a reader snapping
 * to "the intersection" of two segments lying on top of each other has no single point in mind,
 * and inventing one would put the marker somewhere arbitrary.
 */
export function segmentIntersection(
  a1: PdfPoint,
  a2: PdfPoint,
  b1: PdfPoint,
  b2: PdfPoint,
): PdfPoint | null {
  const ax = a2.x - a1.x;
  const ay = a2.y - a1.y;
  const bx = b2.x - b1.x;
  const by = b2.y - b1.y;
  const denominator = ax * by - ay * bx;
  if (Math.abs(denominator) < EPSILON) return null;
  const dx = b1.x - a1.x;
  const dy = b1.y - a1.y;
  const t = (dx * by - dy * bx) / denominator;
  const u = (dx * ay - dy * ax) / denominator;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { x: a1.x + ax * t, y: a1.y + ay * t };
}

/** The midpoint of a segment. */
export function midpoint(a: PdfPoint, b: PdfPoint): PdfPoint {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/** The length of the closed path through `points` — a polygon's perimeter. */
export function perimeter(points: ReadonlyArray<PdfPoint>): number {
  if (points.length < 3) return pathLength(points);
  const first = points[0];
  const last = points[points.length - 1];
  const closing = first && last ? Math.hypot(first.x - last.x, first.y - last.y) : 0;
  return pathLength(points) + closing;
}

/** The bounding box of some points, grown by `pad`; null when there are none. */
export function boundsOf(points: ReadonlyArray<PdfPoint>, pad = 0): PdfRect | null {
  if (points.length === 0) return null;
  let x0 = Number.POSITIVE_INFINITY;
  let y0 = Number.POSITIVE_INFINITY;
  let x1 = Number.NEGATIVE_INFINITY;
  let y1 = Number.NEGATIVE_INFINITY;
  for (const p of points) {
    x0 = Math.min(x0, p.x);
    y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x);
    y1 = Math.max(y1, p.y);
  }
  return { x0: x0 - pad, y0: y0 - pad, x1: x1 + pad, y1: y1 + pad };
}

/** Whether a point is inside a rectangle, its edges included. */
export function rectContains(r: PdfRect, p: PdfPoint): boolean {
  return p.x >= r.x0 && p.x <= r.x1 && p.y >= r.y0 && p.y <= r.y1;
}

/** Whether two rectangles overlap at all, touching edges included. */
export function rectsOverlap(a: PdfRect, b: PdfRect): boolean {
  return a.x0 <= b.x1 && b.x0 <= a.x1 && a.y0 <= b.y1 && b.y0 <= a.y1;
}

/** A square rectangle of side `2 × radius` around a point — the window snapping searches. */
export function windowAround(p: PdfPoint, radius: number): PdfRect {
  return { x0: p.x - radius, y0: p.y - radius, x1: p.x + radius, y1: p.y + radius };
}

/** The four corners of a rect, anticlockwise from the bottom-left. */
export function cornersOf(r: PdfRect): PdfPoint[] {
  return [
    { x: r.x0, y: r.y0 },
    { x: r.x1, y: r.y0 },
    { x: r.x1, y: r.y1 },
    { x: r.x0, y: r.y1 },
  ];
}

/** Moves a rect by a delta. */
export function offsetRect(r: PdfRect, dx: number, dy: number): PdfRect {
  return { x0: r.x0 + dx, y0: r.y0 + dy, x1: r.x1 + dx, y1: r.y1 + dy };
}

/** Moves points by a delta. */
export function offsetPoints(points: ReadonlyArray<PdfPoint>, dx: number, dy: number): PdfPoint[] {
  return points.map((p) => ({ x: p.x + dx, y: p.y + dy }));
}

/**
 * Maps points from one rect into another, so a resize takes the measured points with it. A rect
 * with no extent on one axis leaves that axis alone rather than dividing by zero.
 */
export function scalePoints(
  points: ReadonlyArray<PdfPoint>,
  from: PdfRect,
  to: PdfRect,
): PdfPoint[] {
  const fw = from.x1 - from.x0;
  const fh = from.y1 - from.y0;
  const sx = fw > EPSILON ? (to.x1 - to.x0) / fw : 1;
  const sy = fh > EPSILON ? (to.y1 - to.y0) / fh : 1;
  return points.map((p) => ({
    x: to.x0 + (p.x - from.x0) * sx,
    y: to.y0 + (p.y - from.y0) * sy,
  }));
}

/** Whether two points are within `tolerance` of each other. */
export function samePoint(a: PdfPoint, b: PdfPoint, tolerance = 1e-6): boolean {
  return Math.hypot(a.x - b.x, a.y - b.y) <= tolerance;
}

/**
 * Shift on a measurement: the second point moved to the nearest 45° from the first. The same
 * rule M31's shapes use, restated here so this module does not reach into another's tools.
 */
export function constrainAngle(from: PdfPoint, to: PdfPoint): PdfPoint {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy);
  if (length < EPSILON) return to;
  const step = Math.PI / 4;
  const angle = Math.round(Math.atan2(dy, dx) / step) * step;
  return { x: from.x + length * Math.cos(angle), y: from.y + length * Math.sin(angle) };
}

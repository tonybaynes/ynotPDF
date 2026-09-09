/**
 * Ink (M31): smoothing, pressure, and the eraser's arithmetic.
 *
 * The model stores the **raw** points a stroke was drawn with — they are what `/InkList` holds,
 * and what a viewer without our appearance draws as a polyline. Smoothing is derived from them
 * here, deterministically: a Catmull-Rom spline through every point, converted to the cubic
 * Béziers a content stream can draw, so the overlay on screen and the `/AP` in the file are the
 * same curve. Nothing smoothed is ever stored, which is what lets the eraser cut the stroke the
 * reader actually drew rather than an approximation of it.
 *
 * Pressure, when a pen reports it, is kept beside the points (`extra.pressures`, one number per
 * point) and widens the stroke; a PDF has no width per point, so it lives only in the appearance.
 */

import type { PdfPoint, PdfRect } from '@shared/pdf';
import type { PathOp } from './content';
import { dashOf, paintDrawings, pointsBounds, type ShapeDrawing } from './shapes';
import type { AppearanceGenerator, AppearanceInput } from './types';

/** PDF's own default when `/BS /W` is absent. */
const DEFAULT_BORDER = 1;
const DEFAULT_COLOR = 0x000000;

/**
 * How pressure scales the stroke: a light touch at 0 is half the width, a full press at 1 is one
 * and a half times it. The middle, which is what a mouse reports, is the width the reader chose.
 */
export function widthForPressure(base: number, pressure: number): number {
  const p = Math.max(0, Math.min(1, pressure));
  return base * (0.5 + p);
}

/** The pressure lists from `extra.pressures`, or null when the stroke was not pressure-aware. */
export function pressuresOf(extra: Readonly<Record<string, unknown>>): number[][] | null {
  const raw = extra['pressures'];
  if (!Array.isArray(raw)) return null;
  const out: number[][] = [];
  for (const path of raw) {
    if (!Array.isArray(path)) return null;
    const numbers = path.filter((n): n is number => typeof n === 'number' && Number.isFinite(n));
    if (numbers.length !== path.length) return null;
    out.push(numbers);
  }
  return out;
}

// ---- smoothing ---------------------------------------------------------------------------------

/**
 * A Catmull-Rom spline through `points`, as cubic Bézier segments.
 *
 * For each pair `p[i] → p[i+1]` the control points are `p[i] + (p[i+1] − p[i−1]) / 6` and
 * `p[i+1] − (p[i+2] − p[i]) / 6`, with the ends doubled — the standard conversion, and one that
 * passes through every point, so the curve never drifts from what was drawn. Two points make a
 * straight segment; one point makes a zero-length one, which a round cap draws as a dot.
 */
export function smoothStrokeOps(points: ReadonlyArray<PdfPoint>): PathOp[] {
  const first = points[0];
  if (!first) return [];
  if (points.length === 1) {
    return [
      { op: 'M', x: first.x, y: first.y },
      { op: 'L', x: first.x, y: first.y },
    ];
  }
  const ops: PathOp[] = [{ op: 'M', x: first.x, y: first.y }];
  for (const seg of catmullRomSegments(points)) {
    ops.push({
      op: 'C',
      x1: seg.c1.x,
      y1: seg.c1.y,
      x2: seg.c2.x,
      y2: seg.c2.y,
      x: seg.to.x,
      y: seg.to.y,
    });
  }
  return ops;
}

/** One Bézier of a smoothed stroke. */
export interface BezierSegment {
  readonly from: PdfPoint;
  readonly c1: PdfPoint;
  readonly c2: PdfPoint;
  readonly to: PdfPoint;
}

/** The Bézier segments of a Catmull-Rom spline through `points` (see `smoothStrokeOps`). */
export function catmullRomSegments(points: ReadonlyArray<PdfPoint>): BezierSegment[] {
  const out: BezierSegment[] = [];
  const n = points.length;
  for (let i = 0; i + 1 < n; i++) {
    const p0 = points[Math.max(0, i - 1)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(n - 1, i + 2)];
    if (!p0 || !p1 || !p2 || !p3) continue;
    out.push({
      from: p1,
      c1: { x: p1.x + (p2.x - p0.x) / 6, y: p1.y + (p2.y - p0.y) / 6 },
      c2: { x: p2.x - (p3.x - p1.x) / 6, y: p2.y - (p3.y - p1.y) / 6 },
      to: p2,
    });
  }
  return out;
}

// ---- what ink draws -----------------------------------------------------------------------------

function baseWidth(input: AppearanceInput): number {
  const w = input.borderWidth ?? DEFAULT_BORDER;
  return w > 0 ? w : DEFAULT_BORDER;
}

/**
 * The drawings of an ink annotation: one smoothed path per stroke, or — with pressure — one path
 * per run of segments that share a width. Widths are quantised to a tenth of the base so a stroke
 * of two hundred points is a handful of paths, not two hundred.
 */
export function inkDrawings(input: AppearanceInput): ShapeDrawing[] {
  const strokes = input.paths.filter((p) => p.length > 0);
  if (strokes.length === 0) return [];
  const width = baseWidth(input);
  const stroke = input.color ?? DEFAULT_COLOR;
  const dash = dashOf(input.extra);
  const pressures = pressuresOf(input.extra);
  const out: ShapeDrawing[] = [];
  strokes.forEach((points, index) => {
    const pressure = pressures?.[index];
    const usable = pressure !== undefined && pressure.length === points.length;
    if (!usable || points.length < 2) {
      out.push(drawing(smoothStrokeOps(points), stroke, width, dash));
      return;
    }
    const segments = catmullRomSegments(points);
    const quantum = width / 10;
    let run: PathOp[] = [];
    let runWidth = 0;
    const flush = (): void => {
      if (run.length > 1) out.push(drawing(run, stroke, runWidth, dash));
      run = [];
    };
    segments.forEach((seg, i) => {
      const p = ((pressure[i] ?? 0.5) + (pressure[i + 1] ?? 0.5)) / 2;
      const w = Math.max(quantum, Math.round(widthForPressure(width, p) / quantum) * quantum);
      if (run.length === 0 || Math.abs(w - runWidth) > 1e-9) {
        flush();
        runWidth = w;
        run.push({ op: 'M', x: seg.from.x, y: seg.from.y });
      }
      run.push({
        op: 'C',
        x1: seg.c1.x,
        y1: seg.c1.y,
        x2: seg.c2.x,
        y2: seg.c2.y,
        x: seg.to.x,
        y: seg.to.y,
      });
    });
    flush();
  });
  return out;
}

function drawing(
  ops: PathOp[],
  stroke: number,
  width: number,
  dash: ReadonlyArray<number>,
): ShapeDrawing {
  return dash.length > 0 ? { ops, stroke, fill: null, width, dash } : { ops, stroke, fill: null, width };
}

/** `/Ink`: every stroke smoothed, round-capped and round-joined. A single point draws a dot. */
export const inkAppearance: AppearanceGenerator = (input) => paintDrawings(input, inkDrawings(input));

/** The `/Rect` that contains every stroke at its widest. */
export function inkRect(
  paths: ReadonlyArray<ReadonlyArray<PdfPoint>>,
  width: number,
  pressures: ReadonlyArray<ReadonlyArray<number>> | null = null,
): PdfRect {
  const widest = pressures ? widthForPressure(width, 1) : width;
  const all = paths.flat();
  return pointsBounds(all, widest / 2 + 1) ?? { x0: 0, y0: 0, x1: 0, y1: 0 };
}

// ---- the eraser ---------------------------------------------------------------------------------

/** Distance from `p` to the segment `a → b`. */
export function pointSegmentDistance(p: PdfPoint, a: PdfPoint, b: PdfPoint): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq < 1e-12) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSq));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Whether an eraser circle touches a stroke: any point or segment within `radius`. */
export function strokeHit(points: ReadonlyArray<PdfPoint>, center: PdfPoint, radius: number): boolean {
  const first = points[0];
  if (!first) return false;
  if (points.length === 1) return Math.hypot(first.x - center.x, first.y - center.y) <= radius;
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i];
    const b = points[i + 1];
    if (a && b && pointSegmentDistance(center, a, b) <= radius) return true;
  }
  return false;
}

/**
 * Cuts a stroke with an eraser circle: the fragments that remain outside it, in order.
 *
 * A point inside the circle goes; a segment that passes through the circle with both ends
 * outside is cut too, because the reader rubbed across the line and expects it to part. Every
 * fragment keeps at least two points — a lone survivor is a dot the reader did not draw, so it is
 * dropped. A stroke the circle does not touch comes back whole, as one fragment.
 */
export function splitStroke(
  points: ReadonlyArray<PdfPoint>,
  center: PdfPoint,
  radius: number,
): PdfPoint[][] {
  const inside = (p: PdfPoint): boolean => Math.hypot(p.x - center.x, p.y - center.y) <= radius;
  const fragments: PdfPoint[][] = [];
  let current: PdfPoint[] = [];
  const flush = (): void => {
    if (current.length >= 2) fragments.push(current);
    current = [];
  };
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (!p) continue;
    if (inside(p)) {
      flush();
      continue;
    }
    const previous = current[current.length - 1];
    if (previous && pointSegmentDistance(center, previous, p) <= radius) {
      // Both ends are outside but the segment crosses the circle: part it here.
      flush();
    }
    current.push(p);
  }
  flush();
  return fragments;
}

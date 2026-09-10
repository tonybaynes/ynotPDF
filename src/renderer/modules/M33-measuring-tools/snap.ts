/**
 * Snapping (M33). Pure: given some geometry and a pointer, which point should the measurement
 * actually take?
 *
 * Four kinds of candidate, each with its own toggle, because a reader measuring a plan wants a
 * different one from a reader measuring a photograph:
 *
 * - **endpoints** — where a subpath starts and ends, and every vertex on the way;
 * - **midpoints** — the middle of each segment;
 * - **intersections** — where two segments cross;
 * - **paths** — the nearest point *anywhere* along a segment.
 *
 * The first three are exact points and are found first; "paths" is the fallback, so a reader who
 * turns it on still lands on a corner when the pointer is near one. Intersections are the
 * expensive kind, so only segments inside a window around the pointer are paired up — a page with
 * a thousand segments would otherwise be half a million pairs per pointer move.
 *
 * Geometry is page space, points, origin bottom-left. The tolerance arrives in page points, the
 * caller having divided the setting's screen pixels by the zoom.
 */

import type { PdfPoint, PdfRect } from '@shared/pdf';
import {
  midpoint,
  nearestOnSegment,
  rectsOverlap,
  segmentIntersection,
  windowAround,
} from './geometry';
import { SNAP_LABELS, type SnapKind } from './settings';

/** One thing a measurement can snap to. */
export interface SnapCandidate {
  readonly kind: SnapKind;
  readonly point: PdfPoint;
}

/** A snap that happened: the point taken, what kind it was, and how it should be described. */
export interface SnapResult {
  readonly kind: SnapKind;
  readonly point: PdfPoint;
  /** The words the status line and the indicator's accessible name use. */
  readonly label: string;
}

/** Which kinds are switched on. */
export interface SnapKinds {
  readonly endpoints: boolean;
  readonly midpoints: boolean;
  readonly intersections: boolean;
  readonly paths: boolean;
}

/** A polyline to snap against, in page space. */
export type SnapPath = ReadonlyArray<PdfPoint>;

/** The order candidates are preferred in when two are equally near. Exact points beat a path. */
const PRIORITY: Readonly<Record<SnapKind, number>> = {
  endpoints: 3,
  intersections: 2,
  midpoints: 1,
  paths: 0,
};

/** Every segment of every path that comes near the window, as pairs of points. */
export function segmentsNear(
  paths: ReadonlyArray<SnapPath>,
  window: PdfRect,
): Array<readonly [PdfPoint, PdfPoint]> {
  const out: Array<readonly [PdfPoint, PdfPoint]> = [];
  for (const path of paths) {
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1];
      const b = path[i];
      if (!a || !b) continue;
      const box: PdfRect = {
        x0: Math.min(a.x, b.x),
        y0: Math.min(a.y, b.y),
        x1: Math.max(a.x, b.x),
        y1: Math.max(a.y, b.y),
      };
      if (rectsOverlap(box, window)) out.push([a, b]);
    }
  }
  return out;
}

/** How many segment pairs an intersection search will look at. Beyond this it gives up. */
const MAX_INTERSECTION_SEGMENTS = 60;

/**
 * The best point to snap to near `at`, or null when nothing is within `tolerance`.
 *
 * "Best" is the nearest, and a tie is broken by kind: an endpoint beats an intersection beats a
 * midpoint beats a point on the path, because that is the order of how *definite* each one is.
 */
export function snapAt(
  at: PdfPoint,
  paths: ReadonlyArray<SnapPath>,
  tolerance: number,
  kinds: SnapKinds,
): SnapResult | null {
  if (tolerance <= 0) return null;
  const window = windowAround(at, tolerance);
  const segments = segmentsNear(paths, window);
  if (segments.length === 0) return null;
  let bestKind: SnapKind | null = null;
  let bestPoint: PdfPoint | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  const consider = (kind: SnapKind, point: PdfPoint): void => {
    const distance = Math.hypot(point.x - at.x, point.y - at.y);
    if (distance > tolerance) return;
    if (
      bestKind === null ||
      distance < bestDistance - 1e-9 ||
      (Math.abs(distance - bestDistance) <= 1e-9 && PRIORITY[kind] > PRIORITY[bestKind])
    ) {
      bestKind = kind;
      bestPoint = point;
      bestDistance = distance;
    }
  };

  for (const [a, b] of segments) {
    if (kinds.endpoints) {
      consider('endpoints', a);
      consider('endpoints', b);
    }
    if (kinds.midpoints) consider('midpoints', midpoint(a, b));
    if (kinds.paths) consider('paths', nearestOnSegment(at, a, b).point);
  }
  if (kinds.intersections) {
    const n = Math.min(segments.length, MAX_INTERSECTION_SEGMENTS);
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const first = segments[i];
        const second = segments[j];
        if (!first || !second) continue;
        const crossing = segmentIntersection(first[0], first[1], second[0], second[1]);
        if (crossing) consider('intersections', crossing);
      }
    }
  }
  const kind: SnapKind | null = bestKind;
  const point: PdfPoint | null = bestPoint;
  if (kind === null || point === null) return null;
  return { kind, point, label: SNAP_LABELS[kind] };
}

/** Whether any kind is on — a cheap way to skip the whole search. */
export function anySnapKind(kinds: SnapKinds): boolean {
  return kinds.endpoints || kinds.midpoints || kinds.intersections || kinds.paths;
}

/** The four corners of a rect as a closed path, for the fallback when path data is unavailable. */
export function rectPath(r: PdfRect): PdfPoint[] {
  return [
    { x: r.x0, y: r.y0 },
    { x: r.x1, y: r.y0 },
    { x: r.x1, y: r.y1 },
    { x: r.x0, y: r.y1 },
    { x: r.x0, y: r.y0 },
  ];
}

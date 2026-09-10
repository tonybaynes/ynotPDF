/**
 * The maths of moving things about (M50): resize about the opposite handle, rotate and flip
 * about the centre, align to an edge, distribute centres evenly, and snap a move to whatever is
 * nearby. Every result is a `PdfMatrix` in page space, because that is the one thing the engine
 * and the writer both take — a move, a resize, a rotation and a flip are all the same command.
 */

import type { Guide } from '@view/guides';
import { rotation, scaling, translation } from '@engine/content/matrix';
import type { PdfMatrix, PdfPoint, PdfRect } from '@shared/pdf';
import type { BoxHandle } from '@view/AnnotationLayer';

export function unionRect(rects: ReadonlyArray<PdfRect>): PdfRect | null {
  let out: PdfRect | null = null;
  for (const r of rects) {
    out = out
      ? {
          x0: Math.min(out.x0, r.x0),
          y0: Math.min(out.y0, r.y0),
          x1: Math.max(out.x1, r.x1),
          y1: Math.max(out.y1, r.y1),
        }
      : r;
  }
  return out;
}

export function rectCentre(r: PdfRect): PdfPoint {
  return { x: (r.x0 + r.x1) / 2, y: (r.y0 + r.y1) / 2 };
}

export function offsetRect(r: PdfRect, dx: number, dy: number): PdfRect {
  return { x0: r.x0 + dx, y0: r.y0 + dy, x1: r.x1 + dx, y1: r.y1 + dy };
}

/** Smallest size a resize may leave, in points, so a handle can never collapse an object. */
export const MIN_SIZE = 1;

/**
 * The matrix a box-handle drag applies: a scale about the handle's opposite corner or edge.
 * `proportional` (Shift) keeps the aspect ratio, using whichever axis moved more.
 */
export function resizeMatrix(
  bounds: PdfRect,
  handle: BoxHandle,
  to: PdfPoint,
  proportional: boolean,
): PdfMatrix {
  const width = Math.max(bounds.x1 - bounds.x0, 1e-6);
  const height = Math.max(bounds.y1 - bounds.y0, 1e-6);
  const west = handle.includes('w');
  const east = handle.includes('e');
  const north = handle.startsWith('n');
  const south = handle.startsWith('s');
  const anchor: PdfPoint = {
    x: west ? bounds.x1 : east ? bounds.x0 : (bounds.x0 + bounds.x1) / 2,
    y: south ? bounds.y1 : north ? bounds.y0 : (bounds.y0 + bounds.y1) / 2,
  };
  let sx = 1;
  let sy = 1;
  if (west) sx = (bounds.x1 - to.x) / width;
  else if (east) sx = (to.x - bounds.x0) / width;
  if (south) sy = (bounds.y1 - to.y) / height;
  else if (north) sy = (to.y - bounds.y0) / height;
  const minSx = MIN_SIZE / width;
  const minSy = MIN_SIZE / height;
  sx = Math.max(minSx, sx);
  sy = Math.max(minSy, sy);
  if (proportional) {
    const s = Math.abs(sx - 1) >= Math.abs(sy - 1) ? sx : sy;
    sx = west || east ? s : s;
    sy = north || south ? s : s;
  }
  return scaling(sx, sy, anchor);
}

/** Rotation by `degrees` anticlockwise about the centre of `bounds`. */
export function rotateMatrix(bounds: PdfRect, degrees: number): PdfMatrix {
  return rotation(degrees, rectCentre(bounds));
}

/** A mirror about the centre of `bounds`: `horizontal` swaps left and right. */
export function flipMatrix(bounds: PdfRect, axis: 'horizontal' | 'vertical'): PdfMatrix {
  const c = rectCentre(bounds);
  return axis === 'horizontal' ? scaling(-1, 1, c) : scaling(1, -1, c);
}

export type AlignEdge = 'left' | 'centre' | 'right' | 'top' | 'middle' | 'bottom';

/** The translation that brings `rect`'s edge to the same edge of `reference`. */
export function alignDelta(rect: PdfRect, edge: AlignEdge, reference: PdfRect): PdfMatrix {
  switch (edge) {
    case 'left':
      return translation(reference.x0 - rect.x0, 0);
    case 'right':
      return translation(reference.x1 - rect.x1, 0);
    case 'centre':
      return translation(rectCentre(reference).x - rectCentre(rect).x, 0);
    case 'top':
      return translation(0, reference.y1 - rect.y1);
    case 'bottom':
      return translation(0, reference.y0 - rect.y0);
    case 'middle':
      return translation(0, rectCentre(reference).y - rectCentre(rect).y);
  }
}

/**
 * Translations that space the rects' centres evenly along an axis, keeping the first and the
 * last where they are. Needs three or more; fewer get identities.
 */
export function distributeDeltas(
  rects: ReadonlyArray<PdfRect>,
  axis: 'horizontal' | 'vertical',
): PdfMatrix[] {
  const identity = rects.map((): PdfMatrix => [1, 0, 0, 1, 0, 0]);
  if (rects.length < 3) return identity;
  const centre = (r: PdfRect): number =>
    axis === 'horizontal' ? rectCentre(r).x : rectCentre(r).y;
  const order = rects.map((r, i) => ({ i, c: centre(r) })).sort((a, b) => a.c - b.c);
  const first = order[0];
  const last = order[order.length - 1];
  if (!first || !last) return identity;
  const step = (last.c - first.c) / (order.length - 1);
  const out = [...identity];
  order.forEach((entry, k) => {
    const target = first.c + step * k;
    const d = target - entry.c;
    out[entry.i] = axis === 'horizontal' ? translation(d, 0) : translation(0, d);
  });
  return out;
}

export interface SnapGuide {
  readonly axis: 'vertical' | 'horizontal';
  /** Page coordinate of the line. */
  readonly at: number;
  /** What was snapped to, in words, for the status bar. */
  readonly label: string;
}

export interface SnapResult {
  readonly dx: number;
  readonly dy: number;
  readonly guides: ReadonlyArray<SnapGuide>;
}

export interface SnapOptions {
  /** How close, in points, an edge must be to snap. */
  readonly tolerance: number;
  /** Other objects' bounds on the page (smart guides). */
  readonly objects?: ReadonlyArray<PdfRect>;
  /** The page box, for its edges and centre. */
  readonly page?: PdfRect | null;
  /** Ruler guides on this page. */
  readonly guides?: ReadonlyArray<Guide>;
  /** Grid spacing in points; 0 or absent for none. */
  readonly grid?: number;
}

interface Candidate {
  readonly at: number;
  readonly label: string;
}

function axisCandidates(axis: 'vertical' | 'horizontal', options: SnapOptions): Candidate[] {
  const out: Candidate[] = [];
  const lo = axis === 'vertical' ? 'x0' : 'y0';
  const hi = axis === 'vertical' ? 'x1' : 'y1';
  const edges =
    axis === 'vertical'
      ? ['Left edges', 'Centres', 'Right edges']
      : ['Bottom edges', 'Middles', 'Top edges'];
  for (const r of options.objects ?? []) {
    out.push({ at: r[lo], label: edges[0] ?? '' });
    out.push({ at: (r[lo] + r[hi]) / 2, label: edges[1] ?? '' });
    out.push({ at: r[hi], label: edges[2] ?? '' });
  }
  if (options.page) {
    const p = options.page;
    const names =
      axis === 'vertical'
        ? ['Page left', 'Page centre', 'Page right']
        : ['Page bottom', 'Page middle', 'Page top'];
    out.push({ at: p[lo], label: names[0] ?? '' });
    out.push({ at: (p[lo] + p[hi]) / 2, label: names[1] ?? '' });
    out.push({ at: p[hi], label: names[2] ?? '' });
  }
  for (const g of options.guides ?? []) {
    if (g.axis === axis) out.push({ at: g.at, label: 'Guide' });
  }
  return out;
}

/**
 * Snaps a move of `moving` (already offset by the raw drag) to nearby objects, the page, ruler
 * guides and the grid. Each axis snaps independently to the closest candidate within tolerance;
 * the guides returned are the lines to draw and the words to show.
 */
export function snapMove(moving: PdfRect, options: SnapOptions): SnapResult {
  const guides: SnapGuide[] = [];
  const snapAxis = (axis: 'vertical' | 'horizontal'): number => {
    const lo = axis === 'vertical' ? moving.x0 : moving.y0;
    const hi = axis === 'vertical' ? moving.x1 : moving.y1;
    const mid = (lo + hi) / 2;
    const state: { best: { d: number; at: number; label: string } | null } = { best: null };
    const consider = (own: number, at: number, label: string): void => {
      const d = at - own;
      if (Math.abs(d) > options.tolerance) return;
      if (!state.best || Math.abs(d) < Math.abs(state.best.d)) state.best = { d, at, label };
    };
    for (const c of axisCandidates(axis, options)) {
      consider(lo, c.at, c.label);
      consider(mid, c.at, c.label);
      consider(hi, c.at, c.label);
    }
    if (options.grid && options.grid > 0) {
      const g = options.grid;
      consider(lo, Math.round(lo / g) * g, 'Grid');
    }
    const found = state.best;
    if (!found) return 0;
    guides.push({ axis, at: found.at, label: found.label });
    return found.d;
  };
  const dx = snapAxis('vertical');
  const dy = snapAxis('horizontal');
  return { dx, dy, guides };
}

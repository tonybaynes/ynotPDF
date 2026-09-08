/**
 * Guides and the grid (M11). Pure model; `Rulers.ts` draws it.
 *
 * A guide is a line the operator drags out of a ruler. It belongs to a page and is stored in
 * that page's own coordinates (points, origin bottom-left) so it stays put through zoom, view
 * rotation and window resizing. Guides persist for the document session and are written to the
 * settings under the document's path, so reopening a file brings them back.
 */

import type { PdfRect } from '@shared/pdf';
import { snapToGrid } from './units';

export type GuideAxis = 'vertical' | 'horizontal';

export interface Guide {
  readonly id: string;
  readonly page: number;
  readonly axis: GuideAxis;
  /** Position in page points: x for a vertical guide, y for a horizontal one. */
  readonly at: number;
}

/** What gets written to settings — the id is regenerated on load. */
export interface StoredGuide {
  readonly page: number;
  readonly axis: GuideAxis;
  readonly at: number;
}

let counter = 0;

export function newGuideId(): string {
  return `guide-${++counter}`;
}

/** The guide set of one document. Ordinary methods, no events — the view redraws on change. */
export class GuideSet {
  private guides: Guide[] = [];

  get all(): ReadonlyArray<Guide> {
    return this.guides;
  }

  forPage(page: number): ReadonlyArray<Guide> {
    return this.guides.filter((g) => g.page === page);
  }

  add(page: number, axis: GuideAxis, at: number): Guide {
    const guide: Guide = { id: newGuideId(), page, axis, at };
    this.guides.push(guide);
    return guide;
  }

  move(id: string, at: number): void {
    this.guides = this.guides.map((g) => (g.id === id ? { ...g, at } : g));
  }

  remove(id: string): boolean {
    const before = this.guides.length;
    this.guides = this.guides.filter((g) => g.id !== id);
    return this.guides.length < before;
  }

  clear(page?: number): number {
    const before = this.guides.length;
    this.guides = page === undefined ? [] : this.guides.filter((g) => g.page !== page);
    return before - this.guides.length;
  }

  /** The guide nearest `at` on `axis` within `tolerance` points, for grabbing one with the mouse. */
  nearest(page: number, axis: GuideAxis, at: number, tolerance: number): Guide | null {
    let best: Guide | null = null;
    let bestDistance = tolerance;
    for (const g of this.guides) {
      if (g.page !== page || g.axis !== axis) continue;
      const d = Math.abs(g.at - at);
      if (d <= bestDistance) {
        bestDistance = d;
        best = g;
      }
    }
    return best;
  }

  toJSON(): StoredGuide[] {
    return this.guides.map(({ page, axis, at }) => ({ page, axis, at }));
  }

  static fromJSON(stored: unknown): GuideSet {
    const set = new GuideSet();
    if (!Array.isArray(stored)) return set;
    for (const raw of stored) {
      if (!raw || typeof raw !== 'object') continue;
      const g = raw as Partial<StoredGuide>;
      if (typeof g.page !== 'number' || typeof g.at !== 'number') continue;
      if (g.axis !== 'vertical' && g.axis !== 'horizontal') continue;
      set.add(g.page, g.axis, g.at);
    }
    return set;
  }
}

/** Grid line positions in points across `box`, starting from its bottom-left corner. */
export function gridLines(
  box: PdfRect,
  spacingPt: number,
): { vertical: number[]; horizontal: number[] } {
  const vertical: number[] = [];
  const horizontal: number[] = [];
  if (!(spacingPt > 0)) return { vertical, horizontal };
  const limit = 2000;
  for (let i = 0, x = box.x0; x <= box.x1 && i < limit; i++, x = box.x0 + i * spacingPt) {
    vertical.push(x);
  }
  for (let i = 0, y = box.y0; y <= box.y1 && i < limit; i++, y = box.y0 + i * spacingPt) {
    horizontal.push(y);
  }
  return { vertical, horizontal };
}

/**
 * Snaps a page point to the grid and/or to nearby guides — exposed for the tools that later
 * modules bring (M33 measuring, M50 objects), which is why it lives in the view layer.
 */
export function snapPoint(
  point: { readonly x: number; readonly y: number },
  options: {
    readonly grid?: number;
    readonly guides?: ReadonlyArray<Guide>;
    readonly page?: number;
    readonly tolerance?: number;
  } = {},
): { x: number; y: number } {
  let { x, y } = point;
  if (options.grid && options.grid > 0) {
    x = snapToGrid(x, options.grid);
    y = snapToGrid(y, options.grid);
  }
  const tolerance = options.tolerance ?? 6;
  for (const g of options.guides ?? []) {
    if (options.page !== undefined && g.page !== options.page) continue;
    if (g.axis === 'vertical' && Math.abs(g.at - point.x) <= tolerance) x = g.at;
    if (g.axis === 'horizontal' && Math.abs(g.at - point.y) <= tolerance) y = g.at;
  }
  return { x, y };
}

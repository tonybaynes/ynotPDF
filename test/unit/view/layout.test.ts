/**
 * M11 acceptance: "each layout mode produces the expected page rects for 1, 2, 3, 7 pages
 * (unit table test) including book mode."
 *
 * The table below is the specification. Sizes are deliberately mixed so the column-width and
 * row-height rules are actually exercised rather than cancelling out.
 */

import { describe, expect, it } from 'vitest';
import {
  columnOf,
  hasCover,
  isContinuous,
  isFacing,
  layoutPages,
  LAYOUT_MODES,
  pageAt,
  pageBoxPx,
  pagesInBand,
  rectOfPage,
  rowOfPage,
  rowsFor,
  type LayoutMode,
  type LayoutPageSize,
} from '@view/layout';

const GAP = 10;
const PAD = 20;

/** A4 portrait, in points. */
const A4: LayoutPageSize = { width: 100, height: 200 };
/** A wider, shorter page so column widths and row heights differ. */
const WIDE: LayoutPageSize = { width: 160, height: 120 };

function sizes(n: number): LayoutPageSize[] {
  // Pages 0, 2, 4 … are A4; 1, 3, 5 … are wide.
  return Array.from({ length: n }, (_, i) => (i % 2 === 0 ? A4 : WIDE));
}

function layout(n: number, mode: LayoutMode, zoom = 1) {
  return layoutPages(sizes(n), { mode, zoom, gap: GAP, padding: PAD });
}

function rects(n: number, mode: LayoutMode) {
  return layout(n, mode).rects.map((r) => [r.page, r.x, r.y, r.width, r.height]);
}

describe('rows', () => {
  it('groups pages the way each mode says', () => {
    expect(rowsFor(7, 'single')).toEqual([[0], [1], [2], [3], [4], [5], [6]]);
    expect(rowsFor(7, 'continuous')).toEqual([[0], [1], [2], [3], [4], [5], [6]]);
    expect(rowsFor(7, 'facing')).toEqual([[0, 1], [2, 3], [4, 5], [6]]);
    expect(rowsFor(7, 'facingContinuous')).toEqual([[0, 1], [2, 3], [4, 5], [6]]);
    expect(rowsFor(7, 'book')).toEqual([[0], [1, 2], [3, 4], [5, 6]]);
  });

  it('handles the small counts the acceptance test names', () => {
    expect(rowsFor(1, 'facing')).toEqual([[0]]);
    expect(rowsFor(1, 'book')).toEqual([[0]]);
    expect(rowsFor(2, 'book')).toEqual([[0], [1]]);
    expect(rowsFor(3, 'book')).toEqual([[0], [1, 2]]);
    expect(rowsFor(0, 'continuous')).toEqual([]);
  });

  it('describes each mode by its two booleans', () => {
    expect(LAYOUT_MODES.map(isFacing)).toEqual([false, false, true, true, true]);
    expect(LAYOUT_MODES.map(isContinuous)).toEqual([false, true, false, true, true]);
    expect(LAYOUT_MODES.map(hasCover)).toEqual([false, false, false, false, true]);
  });

  it('puts a lone cover in the right column and a lone last page in the left', () => {
    expect(columnOf([0], 0, true)).toBe(1);
    expect(columnOf([6], 6, true)).toBe(0);
    expect(columnOf([2, 3], 2, true)).toBe(0);
    expect(columnOf([2, 3], 3, true)).toBe(1);
  });
});

describe('layout table', () => {
  it('single: one column, pages centred, stacked with the gap', () => {
    // Column width is the widest page (160); each page is centred in it.
    expect(rects(3, 'single')).toEqual([
      [0, 20 + 30, 20, 100, 200],
      [1, 20 + 0, 20 + 200 + 10, 160, 120],
      [2, 20 + 30, 20 + 200 + 10 + 120 + 10, 100, 200],
    ]);
  });

  it('continuous lays out identically to single — only the scrolling differs', () => {
    expect(rects(7, 'continuous')).toEqual(rects(7, 'single'));
    expect(layout(7, 'continuous').continuous).toBe(true);
    expect(layout(7, 'single').continuous).toBe(false);
  });

  it('one page: content is that page plus the padding', () => {
    const table = layout(1, 'continuous');
    expect(table.rects).toEqual([{ page: 0, x: 20, y: 20, width: 100, height: 200 }]);
    expect(table.width).toBe(100 + PAD * 2);
    expect(table.height).toBe(200 + PAD * 2);
    expect(table.rows).toEqual([{ index: 0, pages: [0], y: 20, height: 200 }]);
  });

  it('facing: spine-aligned columns, pages centred in their row', () => {
    // Left column: pages 0, 2, 4, 6 (all A4, 100 wide). Right column: 1, 3, 5 (wide, 160).
    // Row 0 is 200 tall (the A4), so the 120-tall wide page sits 40 px down.
    expect(rects(3, 'facing')).toEqual([
      [0, 20, 20, 100, 200],
      [1, 20 + 100 + 10, 20 + 40, 160, 120],
      [2, 20, 20 + 200 + 10, 100, 200],
    ]);
    const table = layout(3, 'facing');
    expect(table.width).toBe(100 + GAP + 160 + PAD * 2);
  });

  it('facing with an odd page count leaves the last one in the left column', () => {
    const table = layout(7, 'facing');
    const last = rectOfPage(table, 6);
    expect(last?.x).toBe(20);
    const lastRow = table.rows.at(-1);
    expect(lastRow?.index).toBe(3);
    expect(lastRow?.pages).toEqual([6]);
    expect(lastRow?.height).toBe(200);
  });

  it('facingContinuous produces the same rects as facing', () => {
    expect(rects(7, 'facingContinuous')).toEqual(rects(7, 'facing'));
    expect(layout(7, 'facingContinuous').continuous).toBe(true);
  });

  it('book: page 1 alone in the right column, then spreads', () => {
    // Columns: left holds 1, 3, 5 (wide 160 and A4 100 → 160); right holds 0, 2, 4, 6 → 160.
    const table = layout(7, 'book');
    expect(table.rows.map((r) => r.pages)).toEqual([[0], [1, 2], [3, 4], [5, 6]]);
    const cover = rectOfPage(table, 0);
    const leftOfFirstSpread = rectOfPage(table, 1);
    expect(cover).toBeDefined();
    expect(leftOfFirstSpread).toBeDefined();
    // The cover sits in the right column, so its left edge is past the spine.
    expect(cover?.x).toBeGreaterThan(leftOfFirstSpread?.x ?? 0);
    expect(cover?.x).toBe(PAD + 160 + GAP);
  });

  it('book with 1, 2 and 3 pages', () => {
    expect(rects(1, 'book')).toEqual([[0, 20, 20, 100, 200]]);
    expect(rects(2, 'book')).toEqual([
      // Cover alone on the right of a 160-wide left column; page 1 alone on the left.
      [0, 20 + 160 + 10, 20, 100, 200],
      [1, 20, 20 + 200 + 10, 160, 120],
    ]);
    expect(rects(3, 'book')).toEqual([
      [0, 20 + 160 + 10, 20, 100, 200],
      [1, 20, 20 + 200 + 10 + 40, 160, 120],
      [2, 20 + 160 + 10, 20 + 200 + 10, 100, 200],
    ]);
  });

  it('an empty document lays out to nothing but padding', () => {
    for (const mode of LAYOUT_MODES) {
      const table = layoutPages([], { mode, zoom: 1, gap: GAP, padding: PAD });
      expect(table.rects).toEqual([]);
      expect(table.rows).toEqual([]);
      expect(table.width).toBe(PAD * 2);
    }
  });

  it('zoom scales the pages but not the gap or the padding', () => {
    const table = layout(2, 'continuous', 2);
    expect(rectOfPage(table, 0)).toEqual({ page: 0, x: 20 + 60, y: 20, width: 200, height: 400 });
    expect(rectOfPage(table, 1)?.y).toBe(20 + 400 + GAP);
  });

  it('view rotation swaps every page box and re-flows', () => {
    const table = layoutPages([A4], {
      mode: 'continuous',
      zoom: 1,
      gap: GAP,
      padding: PAD,
      rotation: 90,
    });
    expect(rectOfPage(table, 0)).toEqual({ page: 0, x: 20, y: 20, width: 200, height: 100 });
  });

  it('pageBoxPx never returns a zero box', () => {
    expect(pageBoxPx({ width: 0, height: 0 }, 1)).toEqual({ width: 1, height: 1 });
    expect(pageBoxPx(A4, 1, 270)).toEqual({ width: 200, height: 100 });
  });
});

describe('finding a page', () => {
  const table = layout(7, 'continuous');

  it('reports the page that fills most of the visible band', () => {
    expect(pageAt(table, 0, 100)).toBe(0);
    const second = rectOfPage(table, 1);
    expect(pageAt(table, second?.y ?? 0, 100)).toBe(1);
  });

  it('falls back to the nearest page when the band is in a gap or past the end', () => {
    expect(pageAt(table, 1e6, 100)).toBe(6);
    expect(pageAt(table, -1e6, 10)).toBe(0);
  });

  it('lists the pages near a band, with a margin', () => {
    expect(pagesInBand(table, 0, 100)).toEqual([0]);
    expect(pagesInBand(table, 0, 100, 400).length).toBeGreaterThan(1);
  });

  it('maps a page to its row', () => {
    expect(rowOfPage(layout(7, 'book'), 2)).toBe(1);
    expect(rowOfPage(table, 99)).toBe(-1);
    expect(rectOfPage(table, 99)).toBeUndefined();
  });
});

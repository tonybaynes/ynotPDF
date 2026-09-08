/**
 * The thumbnail grid's geometry (M12) — the operator's layout rules as arithmetic.
 *
 * These are the claims the Pages panel is built on: one column at the default size, the pane
 * width that shows exactly one column, columns divided out of whatever width the splitter gives
 * it, and rows virtualised so a thousand pages cost what five do.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_THUMBNAIL_SIZE,
  GRID_PADDING,
  THUMBNAIL_SIZES,
  canStep,
  columnPitch,
  columnsFor,
  keyboardTarget,
  metrics,
  nearestSize,
  pagesInRow,
  paneWidthFor,
  rangeBetween,
  rowHeight,
  scrollToPage,
  stepSize,
  thumbnailBox,
  visibleRows,
} from '@modules/M12-navigation-panels/thumbnails/grid';

describe('the size ladder', () => {
  it('steps up and down, and holds at the ends', () => {
    expect(stepSize(80, 1)).toBe(120);
    expect(stepSize(300, 1)).toBe(300);
    expect(stepSize(80, -1)).toBe(80);
    expect(canStep(80, -1)).toBe(false);
    expect(canStep(80, 1)).toBe(true);
    expect(canStep(300, 1)).toBe(false);
  });

  it('snaps a hand-edited setting to the nearest rung', () => {
    expect(nearestSize(137)).toBe(120);
    expect(nearestSize(1000)).toBe(300);
    expect(nearestSize(Number.NaN)).toBe(DEFAULT_THUMBNAIL_SIZE);
    for (const size of THUMBNAIL_SIZES) expect(nearestSize(size)).toBe(size);
  });
});

describe('the pane width and the column count', () => {
  it('the width of one column shows exactly one column, at every size', () => {
    for (const size of THUMBNAIL_SIZES) {
      expect(columnsFor(paneWidthFor(size), size)).toBe(1);
    }
  });

  it('a wider pane fits more columns, and it never falls below one', () => {
    const size = 120;
    const one = paneWidthFor(size);
    expect(columnsFor(one + columnPitch(size), size)).toBe(2);
    expect(columnsFor(one + 2 * columnPitch(size), size)).toBe(3);
    expect(columnsFor(paneWidthFor(size, 2), size)).toBe(2);
    expect(columnsFor(10, size)).toBe(1);
    expect(columnsFor(Number.NaN, size)).toBe(1);
  });

  it('stepping the size up widens the pane and stepping it down narrows it', () => {
    let width = paneWidthFor(80);
    for (const size of THUMBNAIL_SIZES.slice(1)) {
      const next = paneWidthFor(size);
      expect(next).toBeGreaterThan(width);
      width = next;
    }
  });
});

describe('thumbnail boxes', () => {
  it('fits a portrait page to the width and a landscape page to the height cap', () => {
    const portrait = thumbnailBox({ width: 595, height: 842 }, 120);
    expect(portrait.width).toBeLessThanOrEqual(120);
    expect(portrait.height).toBeLessThanOrEqual(Math.round(120 * 1.6));
    const landscape = thumbnailBox({ width: 842, height: 595 }, 120);
    expect(landscape.width).toBeLessThanOrEqual(120);
    expect(landscape.height).toBeLessThan(landscape.width);
  });

  it('survives a page with no size at all', () => {
    const box = thumbnailBox({ width: 0, height: 0 }, 120);
    expect(box.width).toBeGreaterThan(0);
    expect(box.height).toBeGreaterThan(0);
  });
});

describe('virtualisation', () => {
  it('rows are the ceiling of pages over columns, and the height follows', () => {
    const grid = metrics(10, paneWidthFor(120), 120);
    expect(grid.columns).toBe(1);
    expect(grid.rows).toBe(10);
    expect(grid.rowHeight).toBe(rowHeight(120));
    expect(grid.height).toBeGreaterThan(10 * rowHeight(120) - 20);
    expect(metrics(10, paneWidthFor(120, 3), 120).rows).toBe(4);
    expect(metrics(0, 300, 120).rows).toBe(0);
  });

  it('only the rows near the viewport are asked for', () => {
    const grid = metrics(1000, paneWidthFor(120), 120);
    const view = visibleRows(0, 600, grid);
    expect(view.first).toBe(0);
    expect(view.last).toBeLessThan(10);
    const scrolled = visibleRows(grid.rowHeight * 100, 600, grid);
    expect(scrolled.first).toBeGreaterThan(95);
    expect(scrolled.last - scrolled.first).toBeLessThan(12);
    // An empty document asks for nothing at all.
    expect(visibleRows(0, 600, metrics(0, 300, 120))).toEqual({ first: 0, last: -1 });
  });

  it('a row holds its own pages, and the last row is short', () => {
    expect(pagesInRow(0, 5, 3)).toEqual([0, 1, 2]);
    expect(pagesInRow(1, 5, 3)).toEqual([3, 4]);
    expect(pagesInRow(9, 5, 3)).toEqual([]);
  });
});

describe('keeping the current page in view', () => {
  const grid = metrics(1000, paneWidthFor(120), 120);

  it('says nothing when the page is already on screen', () => {
    expect(scrollToPage(0, 0, 600, grid)).toBeNull();
  });

  it('centres a page that is not', () => {
    const top = scrollToPage(100, 0, 600, grid);
    expect(top).not.toBeNull();
    if (top === null) return;
    const rowTop = GRID_PADDING + 100 * grid.rowHeight;
    expect(top).toBeLessThanOrEqual(rowTop);
    expect(top + 600).toBeGreaterThan(rowTop);
  });
});

describe('keyboard movement', () => {
  const grid = metrics(20, paneWidthFor(120, 3), 120);

  it('moves by one across and by a column down', () => {
    expect(keyboardTarget(0, 'ArrowRight', 20, grid)).toBe(1);
    expect(keyboardTarget(0, 'ArrowDown', 20, grid)).toBe(grid.columns);
    expect(keyboardTarget(0, 'ArrowUp', 20, grid)).toBe(0);
    expect(keyboardTarget(19, 'ArrowRight', 20, grid)).toBe(19);
    expect(keyboardTarget(5, 'Home', 20, grid)).toBe(0);
    expect(keyboardTarget(5, 'End', 20, grid)).toBe(19);
  });

  it('pages by whole screens', () => {
    const far = keyboardTarget(0, 'PageDown', 20, grid, grid.rowHeight * 3);
    expect(far).toBeGreaterThan(grid.columns);
    expect(keyboardTarget(0, 'PageUp', 20, grid, grid.rowHeight * 3)).toBe(0);
  });
});

describe('shift-click ranges', () => {
  it('runs either way round', () => {
    expect(rangeBetween(2, 5)).toEqual([2, 3, 4, 5]);
    expect(rangeBetween(5, 2)).toEqual([2, 3, 4, 5]);
    expect(rangeBetween(3, 3)).toEqual([3]);
  });
});

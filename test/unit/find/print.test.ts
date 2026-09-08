/**
 * The print arithmetic (M13): page ranges and subsets, the imposition itself (n-up, booklet,
 * tiling, scaling, auto-rotate), and the plan the dialog builds from a set of settings.
 */

import { describe, expect, it } from 'vitest';
import {
  applyReverse,
  applySubset,
  allPages,
  formatPageRange,
  parsePageRange,
  resolvePages,
} from '@modules/M13-select-find-print/print/pageRange';
import {
  bookletOrder,
  DEFAULT_IMPOSITION,
  imposePages,
  nUpCells,
  orientPaper,
  placeInCell,
  sheetOrder,
  tileGrid,
  type ImpositionOptions,
  type SourcePage,
} from '@modules/M13-select-find-print/print/imposition';
import {
  autoOrientation,
  buildPrintPlan,
  describePlan,
} from '@modules/M13-select-find-print/print/plan';
import {
  nearestPaper,
  paperById,
  paperOrDefault,
  PAPER_SIZES,
} from '@modules/M13-select-find-print/print/paper';
import { DEFAULT_PRINT_SETTINGS } from '@modules/M13-select-find-print/settings';

const A4 = { width: 595.28, height: 841.89 };
const pagesOf = (n: number, size = A4): SourcePage[] =>
  Array.from({ length: n }, (_, index) => ({ index, ...size }));

describe('page ranges', () => {
  it('an empty field is every page', () => {
    expect(parsePageRange('', 3).pages).toEqual([0, 1, 2]);
    expect(allPages(3)).toEqual([0, 1, 2]);
  });

  it('parses numbers, ranges, open ranges and lists', () => {
    expect(parsePageRange('1', 10).pages).toEqual([0]);
    expect(parsePageRange('2-4', 10).pages).toEqual([1, 2, 3]);
    expect(parsePageRange('8-', 10).pages).toEqual([7, 8, 9]);
    expect(parsePageRange('-3', 10).pages).toEqual([0, 1, 2]);
    expect(parsePageRange(' 1 , 3-4 ; 9 ', 10).pages).toEqual([0, 2, 3, 8]);
  });

  it('accepts an en dash, and a range written backwards', () => {
    expect(parsePageRange('2–4', 10).pages).toEqual([1, 2, 3]);
    expect(parsePageRange('4-2', 10).pages).toEqual([1, 2, 3]);
  });

  it('removes duplicates and sorts', () => {
    expect(parsePageRange('3,1,3,2', 10).pages).toEqual([0, 1, 2]);
  });

  it('reports what it cannot understand rather than printing the wrong pages', () => {
    expect(parsePageRange('x', 10).error).toBeTruthy();
    expect(parsePageRange('99', 10).error).toBeTruthy();
    expect(parsePageRange('1-2-3', 10).error).toBeTruthy();
    expect(parsePageRange('0', 10).error).toBeTruthy();
  });

  it('odd and even are by printed page number', () => {
    expect(applySubset([0, 1, 2, 3], 'odd')).toEqual([0, 2]);
    expect(applySubset([0, 1, 2, 3], 'even')).toEqual([1, 3]);
    expect(applySubset([0, 1], 'all')).toEqual([0, 1]);
  });

  it('reverses when asked', () => {
    expect(applyReverse([0, 1, 2], true)).toEqual([2, 1, 0]);
    expect(applyReverse([0, 1, 2], false)).toEqual([0, 1, 2]);
  });

  it('resolves the whole field', () => {
    const base = {
      text: '',
      pageCount: 6,
      currentPage: 2,
      selectedPages: [1, 4],
      subset: 'all' as const,
      reverse: false,
    };
    expect(resolvePages({ ...base, mode: 'all' }).pages).toEqual([0, 1, 2, 3, 4, 5]);
    expect(resolvePages({ ...base, mode: 'current' }).pages).toEqual([2]);
    expect(resolvePages({ ...base, mode: 'selection' }).pages).toEqual([1, 4]);
    expect(resolvePages({ ...base, mode: 'custom', text: '2-3' }).pages).toEqual([1, 2]);
    expect(resolvePages({ ...base, mode: 'all', subset: 'odd', reverse: true }).pages).toEqual([
      4, 2, 0,
    ]);
    expect(resolvePages({ ...base, mode: 'selection', selectedPages: [] }).error).toBeTruthy();
  });

  it('formats a page list the way the dialog shows it', () => {
    expect(formatPageRange([0, 1, 2, 5])).toBe('1-3, 6');
    expect(formatPageRange([])).toBe('');
  });
});

describe('paper', () => {
  it('has a catalogue with A4 in it', () => {
    expect(PAPER_SIZES.length).toBeGreaterThan(4);
    expect(paperById('a4')?.width).toBeCloseTo(595.28, 2);
    expect(paperById('nope')).toBeNull();
    expect(paperOrDefault('nope').id).toBe('a4');
  });

  it('recognises a page that is already a named size', () => {
    expect(nearestPaper(595.28, 841.89)?.id).toBe('a4');
    expect(nearestPaper(841.89, 595.28)?.id).toBe('a4');
    expect(nearestPaper(100, 100)).toBeNull();
  });

  it('turns paper for landscape and leaves it alone when it already is', () => {
    expect(orientPaper(A4, 'landscape')).toEqual({ width: A4.height, height: A4.width });
    expect(orientPaper(A4, 'portrait')).toEqual(A4);
  });
});

describe('placement', () => {
  const cell = { x: 0, y: 0, width: 300, height: 400 };

  it('shrinks an oversized page and leaves a small one alone', () => {
    const big = placeInCell({ index: 0, width: 600, height: 800 }, cell, DEFAULT_IMPOSITION);
    expect(big.scale).toBeCloseTo(0.5, 5);
    const small = placeInCell({ index: 0, width: 100, height: 100 }, cell, DEFAULT_IMPOSITION);
    expect(small.scale).toBe(1);
  });

  it('fits, fills, keeps actual size or takes a custom scale', () => {
    const page = { index: 0, width: 100, height: 100 };
    const at = (patch: Partial<ImpositionOptions>): number =>
      placeInCell(page, cell, { ...DEFAULT_IMPOSITION, ...patch }).scale;
    expect(at({ scaling: 'fit' })).toBeCloseTo(3, 5);
    expect(at({ scaling: 'fill' })).toBeCloseTo(4, 5);
    expect(at({ scaling: 'actual' })).toBe(1);
    expect(at({ scaling: 'custom', customScale: 75 })).toBeCloseTo(0.75, 5);
  });

  it('turns a landscape page a quarter to fill a portrait cell', () => {
    const placement = placeInCell({ index: 0, width: 800, height: 600 }, cell, {
      ...DEFAULT_IMPOSITION,
      scaling: 'fit',
    });
    expect(placement.rotation).toBe(90);
    expect(placement.width).toBeCloseTo(600 * placement.scale, 5);
  });

  it('leaves the page upright when rotating would not help', () => {
    const placement = placeInCell({ index: 0, width: 600, height: 800 }, cell, {
      ...DEFAULT_IMPOSITION,
      scaling: 'fit',
    });
    expect(placement.rotation).toBe(0);
  });

  it('centres, or tucks into the top-left when centring is off', () => {
    const centred = placeInCell({ index: 0, width: 100, height: 100 }, cell, DEFAULT_IMPOSITION);
    expect(centred.x).toBeCloseTo(100, 5);
    const cornered = placeInCell({ index: 0, width: 100, height: 100 }, cell, {
      ...DEFAULT_IMPOSITION,
      autoCentre: false,
    });
    expect(cornered.x).toBe(0);
    expect(cornered.y).toBeCloseTo(300, 5);
  });
});

describe('n-up', () => {
  const area = { x: 0, y: 0, width: 400, height: 400 };

  it('fills across then down by default, with row 0 at the top', () => {
    const cells = nUpCells(area, { columns: 2, rows: 2, order: 'horizontal', border: false });
    expect(cells.map((c) => [c.x, c.y])).toEqual([
      [0, 200],
      [200, 200],
      [0, 0],
      [200, 0],
    ]);
  });

  it('fills down then across, and reversed', () => {
    const down = nUpCells(area, { columns: 2, rows: 2, order: 'vertical', border: false });
    expect(down.map((c) => [c.x, c.y])).toEqual([
      [0, 200],
      [0, 0],
      [200, 200],
      [200, 0],
    ]);
    const reversed = nUpCells(area, {
      columns: 2,
      rows: 1,
      order: 'horizontalReverse',
      border: false,
    });
    expect(reversed.map((c) => c.x)).toEqual([200, 0]);
  });

  it('puts four pages on one sheet and starts a second for the fifth', () => {
    const sheets = imposePages(pagesOf(5), {
      ...DEFAULT_IMPOSITION,
      nUp: { columns: 2, rows: 2, order: 'horizontal', border: true },
    });
    expect(sheetOrder(sheets)).toEqual([[0, 1, 2, 3], [4]]);
    expect(sheets[0]?.placements[0]?.border).toBe(true);
  });
});

describe('booklet', () => {
  it('folds four pages into two sheets that read in order', () => {
    expect(bookletOrder(4)).toEqual([
      [3, 0],
      [1, 2],
    ]);
  });

  it('pads to a multiple of four with blanks', () => {
    expect(bookletOrder(6)).toEqual([
      [-1, 0],
      [1, -1],
      [7 - 2, 2],
      [3, 4],
    ]);
  });

  it('imposes a booklet two-up on landscape paper', () => {
    const sheets = imposePages(pagesOf(4), {
      ...DEFAULT_IMPOSITION,
      paper: { width: 841.89, height: 595.28 },
      booklet: { subset: 'both', binding: 'left' },
    });
    expect(sheetOrder(sheets)).toEqual([
      [3, 0],
      [1, 2],
    ]);
    const [left, right] = sheets[0]?.placements ?? [];
    expect(left?.x).toBeLessThan(right?.x ?? 0);
  });

  it('right binding swaps the halves', () => {
    const sheets = imposePages(pagesOf(4), {
      ...DEFAULT_IMPOSITION,
      paper: { width: 841.89, height: 595.28 },
      booklet: { subset: 'both', binding: 'right' },
    });
    expect(sheetOrder(sheets)).toEqual([
      [0, 3],
      [2, 1],
    ]);
  });

  it('prints only one side when a subset is asked for', () => {
    const front = imposePages(pagesOf(8), {
      ...DEFAULT_IMPOSITION,
      booklet: { subset: 'front', binding: 'left' },
    });
    const back = imposePages(pagesOf(8), {
      ...DEFAULT_IMPOSITION,
      booklet: { subset: 'back', binding: 'left' },
    });
    expect(front).toHaveLength(2);
    expect(back).toHaveLength(2);
    expect(sheetOrder(front)).toEqual([
      [7, 0],
      [5, 2],
    ]);
  });

  it('drops the blanks rather than drawing an empty page', () => {
    const sheets = imposePages(pagesOf(1), {
      ...DEFAULT_IMPOSITION,
      booklet: { subset: 'both', binding: 'left' },
    });
    expect(sheetOrder(sheets)).toEqual([[0], []]);
  });
});

describe('tiling', () => {
  it('cuts a page into a grid of sheets, top-left first', () => {
    const area = { x: 0, y: 0, width: 100, height: 100 };
    const tiles = tileGrid({ index: 0, width: 200, height: 200 }, area, {
      scale: 1,
      overlap: 0,
      marks: false,
    });
    expect(tiles).toHaveLength(4);
    expect(tiles[0]).toEqual({ x0: 0, y0: 100, x1: 100, y1: 200 });
    expect(tiles[3]).toEqual({ x0: 100, y0: 0, x1: 200, y1: 100 });
  });

  it('overlapping tiles need more of them', () => {
    const area = { x: 0, y: 0, width: 100, height: 100 };
    const tiles = tileGrid({ index: 0, width: 200, height: 100 }, area, {
      scale: 1,
      overlap: 20,
      marks: false,
    });
    expect(tiles.length).toBeGreaterThan(2);
  });

  it('one tile per sheet, each carrying its clip', () => {
    const sheets = imposePages(pagesOf(1, { width: 1200, height: 1200 }), {
      ...DEFAULT_IMPOSITION,
      tile: { scale: 1, overlap: 0, marks: true },
    });
    expect(sheets.length).toBeGreaterThan(1);
    expect(sheets[0]?.placements[0]?.clip).toBeDefined();
    // A 1200 pt square page over A4's 595 × 842 printable area: three columns by two rows.
    expect(sheets[0]?.placements[0]?.label).toBe('1 of 6');
  });
});

describe('the plan', () => {
  const settings = (patch: Partial<typeof DEFAULT_PRINT_SETTINGS> = {}) => ({
    ...DEFAULT_PRINT_SETTINGS,
    ...patch,
  });
  const sizes = Array.from({ length: 6 }, () => A4);

  it('chooses portrait or landscape paper from the pages', () => {
    expect(autoOrientation([A4, A4])).toBe('portrait');
    expect(autoOrientation([{ width: 800, height: 600 }])).toBe('landscape');
  });

  it('prints every page on its own sheet by default', () => {
    const plan = buildPrintPlan({
      settings: settings(),
      pageSizes: sizes,
      currentPage: 0,
      selectedPages: [],
    });
    expect(plan.error).toBeNull();
    expect(plan.pages).toEqual([0, 1, 2, 3, 4, 5]);
    expect(plan.sheets).toHaveLength(6);
    expect(describePlan(plan)).toBe('6 pages on 6 sheets');
  });

  it('puts pages 2-3 two-up on one sheet', () => {
    const plan = buildPrintPlan({
      settings: settings({
        rangeMode: 'custom',
        rangeText: '2-3',
        mode: 'nup',
        nUpColumns: 2,
        nUpRows: 1,
      }),
      pageSizes: sizes,
      currentPage: 0,
      selectedPages: [],
    });
    expect(plan.pages).toEqual([1, 2]);
    expect(sheetOrder(plan.sheets)).toEqual([[1, 2]]);
  });

  it('a booklet always gets landscape paper, whatever the orientation says', () => {
    const plan = buildPrintPlan({
      settings: settings({ mode: 'booklet', orientation: 'portrait' }),
      pageSizes: sizes.slice(0, 4),
      currentPage: 0,
      selectedPages: [],
    });
    expect(plan.paper.width).toBeGreaterThan(plan.paper.height);
    expect(sheetOrder(plan.sheets)).toEqual([
      [3, 0],
      [1, 2],
    ]);
  });

  it('carries a bad range through as an error rather than printing the wrong thing', () => {
    const plan = buildPrintPlan({
      settings: settings({ rangeMode: 'custom', rangeText: '99' }),
      pageSizes: sizes,
      currentPage: 0,
      selectedPages: [],
    });
    expect(plan.error).toBeTruthy();
    expect(plan.sheets).toEqual([]);
    expect(describePlan(plan)).toBe(plan.error);
  });

  it('says so when there is nothing to print', () => {
    const plan = buildPrintPlan({
      settings: settings(),
      pageSizes: [],
      currentPage: 0,
      selectedPages: [],
    });
    expect(plan.error).toBe('No pages to print');
  });
});

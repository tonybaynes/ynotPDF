/**
 * Navigation history, measurement units and guides (M11) — the rest of the pure view layer.
 */

import { describe, expect, it } from 'vitest';
import { HISTORY_LIMIT, ViewHistory, type ViewPosition } from '@view/history';
import {
  formatLength,
  fromPoints,
  PT_PER_UNIT,
  rulerTicks,
  snapToGrid,
  tickStep,
  toPoints,
  UNITS,
  type Unit,
} from '@view/units';
import { GuideSet, gridLines, snapPoint } from '@view/guides';

const at = (page: number, top = page * 100): ViewPosition => ({
  page,
  left: 0,
  top,
  zoom: 1,
});

describe('ViewHistory', () => {
  it('starts empty and refuses to move', () => {
    const h = new ViewHistory();
    expect(h.canGoBack).toBe(false);
    expect(h.canGoForward).toBe(false);
    expect(h.back()).toBeNull();
    expect(h.forward()).toBeNull();
    expect(h.current).toBeNull();
  });

  it('walks back and forward through jumps', () => {
    const h = new ViewHistory();
    h.push(at(0));
    h.push(at(5));
    h.push(at(9));
    expect(h.canGoBack).toBe(true);
    expect(h.back()?.page).toBe(5);
    expect(h.back()?.page).toBe(0);
    expect(h.canGoBack).toBe(false);
    expect(h.forward()?.page).toBe(5);
    expect(h.forward()?.page).toBe(9);
    expect(h.canGoForward).toBe(false);
  });

  it('a new jump after going back drops the forward branch', () => {
    const h = new ViewHistory();
    h.push(at(0));
    h.push(at(1));
    h.push(at(2));
    h.back();
    h.push(at(7));
    expect(h.canGoForward).toBe(false);
    expect(h.toArray().map((p) => p.page)).toEqual([0, 1, 7]);
  });

  it('does not stack a jump that lands where it already is', () => {
    const h = new ViewHistory();
    h.push(at(3));
    h.push(at(3));
    expect(h.length).toBe(1);
    // A different scroll position on the same page is a real jump.
    h.push(at(3, 900));
    expect(h.length).toBe(2);
  });

  it('replace updates the current entry so back returns to the exact spot', () => {
    const h = new ViewHistory();
    h.push(at(0, 0));
    h.replace(at(0, 640)); // the reader scrolled before jumping
    h.push(at(9));
    expect(h.back()?.top).toBe(640);
  });

  it('replace on an empty history pushes instead', () => {
    const h = new ViewHistory();
    h.replace(at(2));
    expect(h.length).toBe(1);
  });

  it('is bounded, dropping the oldest', () => {
    const h = new ViewHistory(5);
    for (let i = 0; i < 20; i++) h.push(at(i));
    expect(h.length).toBe(5);
    expect(h.toArray()[0]?.page).toBe(15);
    expect(new ViewHistory().length).toBe(0);
    expect(HISTORY_LIMIT).toBeGreaterThan(1);
  });

  it('clears', () => {
    const h = new ViewHistory();
    h.push(at(1));
    h.clear();
    expect(h.length).toBe(0);
    expect(h.current).toBeNull();
    expect(h.index).toBe(-1);
  });

  it('reports where the cursor is', () => {
    const h = new ViewHistory();
    h.push(at(0));
    h.push(at(1));
    expect(h.index).toBe(1);
    h.back();
    expect(h.index).toBe(0);
  });
});

describe('units', () => {
  it('round-trips through points', () => {
    for (const { id } of UNITS) {
      expect(toPoints(fromPoints(72, id), id)).toBeCloseTo(72, 9);
    }
    expect(PT_PER_UNIT.in).toBe(72);
    expect(PT_PER_UNIT.mm).toBeCloseTo(72 / 25.4, 9);
  });

  it('formats with the precision each unit deserves', () => {
    expect(formatLength(72, 'in')).toBe('1.00 in');
    expect(formatLength(72, 'pt')).toBe('72 pt');
    expect(formatLength(72, 'mm')).toBe('25 mm');
    expect(formatLength(72, 'cm')).toBe('2.5 cm');
    expect(formatLength(72, 'in', false)).toBe('1.00');
  });

  it('never prints a negative zero', () => {
    expect(formatLength(-0.001, 'cm')).toBe('0.0 cm');
    expect(formatLength(-0.4, 'pt')).toBe('0 pt');
  });

  it('picks a tick step wide enough to read at any zoom', () => {
    for (const unit of ['pt', 'mm', 'cm', 'in'] as Unit[]) {
      for (const zoom of [0.05, 0.5, 1, 4, 32]) {
        const step = tickStep(unit, zoom);
        expect(step * zoom).toBeGreaterThanOrEqual(56);
        expect(Number.isFinite(step)).toBe(true);
      }
    }
  });

  it('produces ticks across a range, majors carrying labels', () => {
    const ticks = rulerTicks(0, 720, 'in', 1);
    expect(ticks.length).toBeGreaterThan(0);
    const majors = ticks.filter((t) => t.major);
    expect(majors.length).toBeGreaterThan(1);
    expect(majors.every((t) => t.label !== '')).toBe(true);
    expect(ticks.filter((t) => !t.major).every((t) => t.label === '')).toBe(true);
    // Positions rise and stay inside the range.
    for (const [i, t] of ticks.entries()) {
      expect(t.px).toBeCloseTo(t.points, 9);
      if (i > 0) expect(t.points).toBeGreaterThan(ticks[i - 1]?.points ?? -1);
      expect(t.points).toBeLessThan(720);
    }
  });

  it('handles a negative start (the ruler runs left of the page)', () => {
    const ticks = rulerTicks(-200, 200, 'mm', 1);
    expect(ticks.some((t) => t.points < 0)).toBe(true);
    expect(ticks.some((t) => t.major && t.points === 0)).toBe(true);
  });

  it('returns nothing rather than looping for a degenerate range', () => {
    expect(rulerTicks(0, 0, 'mm', 1)).toEqual([]);
    expect(rulerTicks(10, 0, 'mm', 1)).toEqual([]);
  });

  it('snaps to a grid', () => {
    expect(snapToGrid(37, 36)).toBe(36);
    expect(snapToGrid(55, 36)).toBe(72);
    expect(snapToGrid(37, 0)).toBe(37);
  });
});

describe('guides', () => {
  const box = { x0: 0, y0: 0, x1: 100, y1: 200 };

  it('adds, moves and removes', () => {
    const set = new GuideSet();
    const g = set.add(0, 'vertical', 50);
    expect(set.forPage(0)).toHaveLength(1);
    set.move(g.id, 60);
    expect(set.all[0]?.at).toBe(60);
    expect(set.remove(g.id)).toBe(true);
    expect(set.remove(g.id)).toBe(false);
    expect(set.all).toHaveLength(0);
  });

  it('clears one page or all of them', () => {
    const set = new GuideSet();
    set.add(0, 'vertical', 10);
    set.add(1, 'vertical', 10);
    expect(set.clear(0)).toBe(1);
    expect(set.all).toHaveLength(1);
    expect(set.clear()).toBe(1);
  });

  it('finds the nearest guide within a tolerance', () => {
    const set = new GuideSet();
    const near = set.add(0, 'vertical', 50);
    set.add(0, 'vertical', 90);
    expect(set.nearest(0, 'vertical', 52, 5)?.id).toBe(near.id);
    expect(set.nearest(0, 'vertical', 70, 5)).toBeNull();
    expect(set.nearest(1, 'vertical', 50, 5)).toBeNull();
    expect(set.nearest(0, 'horizontal', 50, 5)).toBeNull();
  });

  it('survives a round trip through settings', () => {
    const set = new GuideSet();
    set.add(0, 'vertical', 10);
    set.add(2, 'horizontal', 33.5);
    const back = GuideSet.fromJSON(JSON.parse(JSON.stringify(set.toJSON())));
    expect(back.all.map((g) => [g.page, g.axis, g.at])).toEqual([
      [0, 'vertical', 10],
      [2, 'horizontal', 33.5],
    ]);
  });

  it('ignores rubbish in the stored value instead of throwing', () => {
    expect(GuideSet.fromJSON(null).all).toEqual([]);
    expect(GuideSet.fromJSON('nope').all).toEqual([]);
    expect(
      GuideSet.fromJSON([
        { page: 'x', axis: 'vertical', at: 1 },
        { page: 0 },
        null,
        { page: 0, axis: 'diagonal', at: 1 },
      ]).all,
    ).toEqual([]);
  });

  it('draws grid lines across a page box', () => {
    const lines = gridLines(box, 50);
    expect(lines.vertical).toEqual([0, 50, 100]);
    expect(lines.horizontal).toEqual([0, 50, 100, 150, 200]);
    expect(gridLines(box, 0)).toEqual({ vertical: [], horizontal: [] });
  });

  it('snaps a point to the grid and to nearby guides', () => {
    const set = new GuideSet();
    set.add(0, 'vertical', 41);
    expect(snapPoint({ x: 37, y: 37 }, { grid: 36 })).toEqual({ x: 36, y: 36 });
    expect(snapPoint({ x: 40, y: 5 }, { guides: set.all, page: 0, tolerance: 3 })).toEqual({
      x: 41,
      y: 5,
    });
    // A guide on another page does not attract.
    expect(snapPoint({ x: 40, y: 5 }, { guides: set.all, page: 1, tolerance: 3 }).x).toBe(40);
    expect(snapPoint({ x: 40, y: 5 })).toEqual({ x: 40, y: 5 });
  });
});

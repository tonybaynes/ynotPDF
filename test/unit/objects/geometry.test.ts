/**
 * M50's arithmetic: resize about the opposite handle, rotate and flip about the centre, align
 * and distribute, and snapping — including the acceptance line "align/distribute six objects
 * ⇒ positions match computed expectations".
 */

import { describe, expect, it } from 'vitest';
import { applyToRect } from '@engine/content/matrix';
import type { PdfRect } from '@shared/pdf';
import {
  alignDelta,
  distributeDeltas,
  flipMatrix,
  resizeMatrix,
  rotateMatrix,
  snapMove,
  unionRect,
} from '@modules/M50-object-model/geometry';

const R: PdfRect = { x0: 100, y0: 100, x1: 300, y1: 200 };

function close(a: PdfRect, b: PdfRect): void {
  expect(a.x0).toBeCloseTo(b.x0, 6);
  expect(a.y0).toBeCloseTo(b.y0, 6);
  expect(a.x1).toBeCloseTo(b.x1, 6);
  expect(a.y1).toBeCloseTo(b.y1, 6);
}

describe('resizeMatrix', () => {
  it('drags the south-east handle and keeps the north-west corner', () => {
    const m = resizeMatrix(R, 'se', { x: 400, y: 50 }, false);
    close(applyToRect(m, R), { x0: 100, y0: 50, x1: 400, y1: 200 });
  });

  it('drags an edge handle on one axis only', () => {
    const m = resizeMatrix(R, 'w', { x: 50, y: 999 }, false);
    close(applyToRect(m, R), { x0: 50, y0: 100, x1: 300, y1: 200 });
    const n = resizeMatrix(R, 'n', { x: 999, y: 300 }, false);
    close(applyToRect(n, R), { x0: 100, y0: 100, x1: 300, y1: 300 });
  });

  it('keeps the aspect ratio with Shift, from the axis that moved more', () => {
    const m = resizeMatrix(R, 'se', { x: 500, y: 150 }, true);
    const r = applyToRect(m, R);
    expect(r.x1 - r.x0).toBeCloseTo(400, 6);
    expect(r.y1 - r.y0).toBeCloseTo(200, 6);
    expect(r.x0).toBeCloseTo(100, 6);
    expect(r.y1).toBeCloseTo(200, 6);
  });

  it('never collapses below the minimum size', () => {
    const m = resizeMatrix(R, 'e', { x: -1000, y: 0 }, false);
    const r = applyToRect(m, R);
    expect(r.x1 - r.x0).toBeCloseTo(1, 6);
  });
});

describe('rotate and flip', () => {
  it('rotates about the centre', () => {
    const r = applyToRect(rotateMatrix(R, 90), R);
    close(r, { x0: 150, y0: 50, x1: 250, y1: 250 });
  });

  it('flips about the centre and leaves the box where it was', () => {
    close(applyToRect(flipMatrix(R, 'horizontal'), R), R);
    close(applyToRect(flipMatrix(R, 'vertical'), R), R);
    const m = flipMatrix(R, 'horizontal');
    expect(m[0]).toBe(-1);
  });
});

describe('align and distribute six objects', () => {
  const six: PdfRect[] = [
    { x0: 10, y0: 10, x1: 30, y1: 40 },
    { x0: 50, y0: 20, x1: 90, y1: 30 },
    { x0: 120, y0: 5, x1: 130, y1: 60 },
    { x0: 200, y0: 15, x1: 260, y1: 45 },
    { x0: 300, y0: 25, x1: 310, y1: 35 },
    { x0: 400, y0: 0, x1: 500, y1: 100 },
  ];
  const reference = unionRect(six);

  it('aligns every edge to the selection', () => {
    if (!reference) throw new Error('no union');
    const left = six.map((r) => applyToRect(alignDelta(r, 'left', reference), r));
    for (const r of left) expect(r.x0).toBeCloseTo(10, 6);
    const right = six.map((r) => applyToRect(alignDelta(r, 'right', reference), r));
    for (const r of right) expect(r.x1).toBeCloseTo(500, 6);
    const centre = six.map((r) => applyToRect(alignDelta(r, 'centre', reference), r));
    for (const r of centre) expect((r.x0 + r.x1) / 2).toBeCloseTo(255, 6);
    const top = six.map((r) => applyToRect(alignDelta(r, 'top', reference), r));
    for (const r of top) expect(r.y1).toBeCloseTo(100, 6);
    const bottom = six.map((r) => applyToRect(alignDelta(r, 'bottom', reference), r));
    for (const r of bottom) expect(r.y0).toBeCloseTo(0, 6);
    const middle = six.map((r) => applyToRect(alignDelta(r, 'middle', reference), r));
    for (const r of middle) expect((r.y0 + r.y1) / 2).toBeCloseTo(50, 6);
    // Sizes never change.
    left.forEach((r, i) => {
      const o = six[i];
      if (o) expect(r.x1 - r.x0).toBeCloseTo(o.x1 - o.x0, 6);
    });
  });

  it('spaces centres evenly, first and last fixed', () => {
    const deltas = distributeDeltas(six, 'horizontal');
    const moved = six.map((r, i) => {
      const d = deltas[i];
      return d ? applyToRect(d, r) : r;
    });
    const centres = moved.map((r) => (r.x0 + r.x1) / 2);
    expect(centres[0]).toBeCloseTo(20, 6);
    expect(centres[5]).toBeCloseTo(450, 6);
    const step = (450 - 20) / 5;
    centres.forEach((c, i) => {
      expect(c).toBeCloseTo(20 + step * i, 6);
    });
    // Vertical: nothing moves horizontally.
    const vertical = distributeDeltas(six, 'vertical');
    for (const d of vertical) expect(d[4]).toBe(0);
  });

  it('does nothing with fewer than three', () => {
    const two = distributeDeltas(six.slice(0, 2), 'horizontal');
    for (const d of two) expect(d).toEqual([1, 0, 0, 1, 0, 0]);
  });
});

describe('snapMove', () => {
  const others: PdfRect[] = [{ x0: 200, y0: 300, x1: 260, y1: 340 }];

  it('snaps a left edge to another left edge and names it', () => {
    const r = snapMove({ x0: 203, y0: 10, x1: 223, y1: 40 }, { tolerance: 4, objects: others });
    expect(r.dx).toBeCloseTo(-3, 6);
    expect(r.dy).toBe(0);
    expect(r.guides.map((g) => g.label)).toEqual(['Left edges']);
    expect(r.guides[0]?.axis).toBe('vertical');
    expect(r.guides[0]?.at).toBe(200);
  });

  it('snaps centres to the page centre', () => {
    const page: PdfRect = { x0: 0, y0: 0, x1: 600, y1: 800 };
    const r = snapMove({ x0: 272, y0: 10, x1: 332, y1: 40 }, { tolerance: 4, page });
    expect(r.dx).toBeCloseTo(-2, 6);
    expect(r.guides[0]?.label).toBe('Page centre');
  });

  it('takes the nearest candidate, and none outside tolerance', () => {
    const r = snapMove(
      { x0: 100, y0: 100, x1: 150, y1: 150 },
      {
        tolerance: 4,
        objects: [
          { x0: 103, y0: 0, x1: 120, y1: 1 },
          { x0: 101, y0: 0, x1: 120, y1: 1 },
        ],
      },
    );
    expect(r.dx).toBeCloseTo(1, 6);
    const none = snapMove(
      { x0: 100, y0: 100, x1: 150, y1: 150 },
      { tolerance: 4, objects: [{ x0: 110, y0: 500, x1: 120, y1: 501 }] },
    );
    expect(none.dx).toBe(0);
    expect(none.guides).toEqual([]);
  });

  it('snaps to ruler guides and to the grid', () => {
    const r = snapMove(
      { x0: 97, y0: 51, x1: 150, y1: 150 },
      { tolerance: 4, guides: [{ id: 'g', page: 0, axis: 'vertical', at: 100 }], grid: 50 },
    );
    expect(r.dx).toBeCloseTo(3, 6);
    expect(r.dy).toBeCloseTo(-1, 6);
    expect(r.guides.map((g) => g.label).sort()).toEqual(['Grid', 'Guide']);
  });
});

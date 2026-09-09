/**
 * Ink (M31): the smoothing is deterministic and passes through every raw point; pressure widens
 * the stroke; and the eraser cuts the raw points — the acceptance line about a split yielding two
 * strokes with the expected point counts starts here, at the arithmetic.
 */

import { describe, expect, it } from 'vitest';
import {
  appearanceInput,
  catmullRomSegments,
  defaultAppearanceService,
  inkDrawings,
  inkRect,
  pointSegmentDistance,
  pressuresOf,
  smoothStrokeOps,
  splitStroke,
  strokeHit,
  widthForPressure,
} from '@engine/appearance';
import type { PdfPoint } from '@shared/pdf';

const LINE: PdfPoint[] = Array.from({ length: 11 }, (_v, i) => ({ x: i * 10, y: 0 }));
const WIGGLE: PdfPoint[] = [
  { x: 0, y: 0 },
  { x: 10, y: 8 },
  { x: 20, y: -3 },
  { x: 30, y: 5 },
  { x: 40, y: 0 },
];

describe('smoothing', () => {
  it('is deterministic and passes through every point', () => {
    const a = smoothStrokeOps(WIGGLE);
    const b = smoothStrokeOps(WIGGLE);
    expect(a).toEqual(b);
    const ends = a
      .filter((o) => o.op === 'C')
      .map((o) => (o.op === 'C' ? { x: o.x, y: o.y } : null));
    expect(ends).toEqual(WIGGLE.slice(1));
    expect(a[0]).toEqual({ op: 'M', x: 0, y: 0 });
  });

  it('a single point is a dot and two points a straight segment', () => {
    expect(smoothStrokeOps([{ x: 5, y: 5 }])).toEqual([
      { op: 'M', x: 5, y: 5 },
      { op: 'L', x: 5, y: 5 },
    ]);
    expect(smoothStrokeOps([])).toEqual([]);
    const [seg] = catmullRomSegments([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
    ]);
    expect(seg?.c1).toEqual({ x: 10 / 6, y: 0 });
    expect(seg?.c2).toEqual({ x: 10 - 10 / 6, y: 0 });
  });

  it('a straight run of points stays straight', () => {
    for (const op of smoothStrokeOps(LINE)) {
      if (op.op === 'C') {
        expect(op.y1).toBe(0);
        expect(op.y2).toBe(0);
      }
    }
  });
});

describe('pressure', () => {
  it('scales the width from half to one and a half, and reads the lists strictly', () => {
    expect(widthForPressure(2, 0)).toBe(1);
    expect(widthForPressure(2, 0.5)).toBe(2);
    expect(widthForPressure(2, 1)).toBe(3);
    expect(widthForPressure(2, 4)).toBe(3);
    expect(pressuresOf({})).toBeNull();
    expect(pressuresOf({ pressures: [[0.1, 0.2]] })).toEqual([[0.1, 0.2]]);
    expect(pressuresOf({ pressures: [[0.1, 'x']] })).toBeNull();
    expect(pressuresOf({ pressures: ['not a list'] })).toBeNull();
  });

  it('splits a stroke into runs of one width, and one path without pressure', () => {
    const plain = inkDrawings(
      appearanceInput({
        subtype: 'Ink',
        rect: { x0: 0, y0: 0, x1: 100, y1: 10 },
        paths: [LINE],
        borderWidth: 2,
      }),
    );
    expect(plain.length).toBe(1);
    const pressed = inkDrawings(
      appearanceInput({
        subtype: 'Ink',
        rect: { x0: 0, y0: 0, x1: 100, y1: 10 },
        paths: [LINE],
        borderWidth: 2,
        extra: { pressures: [LINE.map((_p, i) => (i < 5 ? 0.2 : 0.9))] },
      }),
    );
    expect(pressed.length).toBeGreaterThan(1);
    const widths = new Set(pressed.map((d) => d.width));
    expect(widths.size).toBeGreaterThan(1);
    // Every run starts with a move and is a Bézier chain.
    for (const d of pressed) {
      expect(d.ops[0]?.op).toBe('M');
      expect(d.ops.slice(1).every((o) => o.op === 'C')).toBe(true);
    }
    // A pressure list of the wrong length is ignored rather than mis-applied.
    const wrong = inkDrawings(
      appearanceInput({
        subtype: 'Ink',
        rect: { x0: 0, y0: 0, x1: 100, y1: 10 },
        paths: [LINE],
        extra: { pressures: [[0.5]] },
      }),
    );
    expect(wrong.length).toBe(1);
  });

  it('the rect allows for the widest the stroke can get', () => {
    const plain = inkRect([LINE], 4);
    const pressed = inkRect([LINE], 4, [[]]);
    expect(pressed.y1).toBeGreaterThan(plain.y1);
    expect(inkRect([], 1)).toEqual({ x0: 0, y0: 0, x1: 0, y1: 0 });
  });

  it('the generator smooths, rounds the caps, and honours a dash', () => {
    const stream = defaultAppearanceService.generate(
      appearanceInput({
        subtype: 'Ink',
        rect: { x0: 0, y0: -10, x1: 40, y1: 10 },
        paths: [WIGGLE],
        borderWidth: 2,
        extra: { dashArray: [4, 4] },
      }),
    );
    expect(stream?.content).toContain('1 J');
    expect(stream?.content).toContain('[4 4] 0 d');
    expect(stream?.content).toMatch(/ c$/m);
  });
});

describe('the eraser', () => {
  it('measures the distance to a segment, including its ends', () => {
    expect(pointSegmentDistance({ x: 5, y: 3 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBe(3);
    expect(pointSegmentDistance({ x: -3, y: 4 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBe(5);
    expect(pointSegmentDistance({ x: 3, y: 4 }, { x: 0, y: 0 }, { x: 0, y: 0 })).toBe(5);
  });

  it('hits a stroke when any segment comes within the radius', () => {
    expect(strokeHit(LINE, { x: 55, y: 4 }, 5)).toBe(true);
    expect(strokeHit(LINE, { x: 55, y: 6 }, 5)).toBe(false);
    expect(strokeHit([{ x: 1, y: 1 }], { x: 3, y: 1 }, 2)).toBe(true);
    expect(strokeHit([], { x: 0, y: 0 }, 5)).toBe(false);
  });

  it('cuts a stroke in the middle into two fragments with the expected point counts', () => {
    // Points at x = 0..100 step 10; a radius-12 eraser at x = 50 takes 40, 50 and 60.
    const fragments = splitStroke(LINE, { x: 50, y: 0 }, 12);
    expect(fragments.length).toBe(2);
    expect(fragments[0]?.length).toBe(4);
    expect(fragments[1]?.length).toBe(4);
    expect(fragments[0]?.[3]).toEqual({ x: 30, y: 0 });
    expect(fragments[1]?.[0]).toEqual({ x: 70, y: 0 });
  });

  it('leaves an untouched stroke whole and takes an end cleanly', () => {
    expect(splitStroke(LINE, { x: 50, y: 40 }, 5)).toEqual([LINE]);
    const tail = splitStroke(LINE, { x: 100, y: 0 }, 12);
    expect(tail.length).toBe(1);
    expect(tail[0]?.length).toBe(9);
  });

  it('parts a segment the circle crosses even when both its ends are outside', () => {
    const sparse: PdfPoint[] = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 200, y: 0 },
      { x: 300, y: 0 },
    ];
    const fragments = splitStroke(sparse, { x: 150, y: 0 }, 5);
    expect(fragments.length).toBe(2);
    expect(fragments[0]).toEqual([
      { x: 0, y: 0 },
      { x: 100, y: 0 },
    ]);
    expect(fragments[1]).toEqual([
      { x: 200, y: 0 },
      { x: 300, y: 0 },
    ]);
  });

  it('drops a lone surviving point rather than leaving a dot the reader did not draw', () => {
    const three: PdfPoint[] = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 20, y: 0 },
    ];
    expect(splitStroke(three, { x: 10, y: 0 }, 3)).toEqual([]);
  });
});

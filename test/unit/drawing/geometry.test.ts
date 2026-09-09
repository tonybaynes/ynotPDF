/**
 * The tools' arithmetic (M31): what Shift does, how geometry scales into a new box, and the small
 * helpers every tool shares.
 */

import { describe, expect, it } from 'vitest';
import {
  atLeast,
  constrainAngle,
  constrainBox,
  insetRect,
  offsetPoints,
  offsetRect,
  quadOfRect,
  rectBetween,
  samePoint,
  scalePoints,
} from '@modules/M31-shapes-ink-stamps/geometry';

describe('Shift constraints', () => {
  it('makes a box square, keeping the corner the drag started from', () => {
    expect(constrainBox({ x: 10, y: 10 }, { x: 40, y: 20 })).toEqual({ x: 40, y: 40 });
    expect(constrainBox({ x: 10, y: 10 }, { x: -20, y: 5 })).toEqual({ x: -20, y: -20 });
    // A drag with no movement in one axis still picks a direction rather than dividing by zero.
    expect(constrainBox({ x: 0, y: 0 }, { x: 0, y: 0 })).toEqual({ x: 0, y: 0 });
  });

  it('snaps a line to the nearest 45°, keeping its length', () => {
    const to = constrainAngle({ x: 0, y: 0 }, { x: 100, y: 10 });
    expect(to.x).toBeCloseTo(Math.hypot(100, 10), 6);
    expect(to.y).toBeCloseTo(0, 6);
    const diagonal = constrainAngle({ x: 0, y: 0 }, { x: 50, y: 60 });
    expect(diagonal.x).toBeCloseTo(diagonal.y, 6);
    // A zero-length drag is left alone.
    expect(constrainAngle({ x: 5, y: 5 }, { x: 5, y: 5 })).toEqual({ x: 5, y: 5 });
  });
});

describe('rects and points', () => {
  it('normalises a rect between two corners', () => {
    expect(rectBetween({ x: 10, y: 20 }, { x: 0, y: 5 })).toEqual({ x0: 0, y0: 5, x1: 10, y1: 20 });
  });

  it('offsets a rect and a list of points', () => {
    expect(offsetRect({ x0: 0, y0: 0, x1: 1, y1: 1 }, 2, 3)).toEqual({
      x0: 2,
      y0: 3,
      x1: 3,
      y1: 4,
    });
    expect(offsetPoints([{ x: 1, y: 1 }], -1, 1)).toEqual([{ x: 0, y: 2 }]);
  });

  it('scales points from one rect into another, axis by axis', () => {
    const from = { x0: 0, y0: 0, x1: 100, y1: 50 };
    const to = { x0: 10, y0: 10, x1: 210, y1: 60 };
    expect(scalePoints([{ x: 50, y: 25 }], from, to)).toEqual([{ x: 110, y: 35 }]);
    // A flat source rect leaves that axis where it is rather than dividing by zero.
    const flat = { x0: 0, y0: 5, x1: 100, y1: 5 };
    expect(scalePoints([{ x: 50, y: 5 }], flat, to)[0]?.y).toBe(to.y0);
  });

  it('insets a rect without turning it inside out', () => {
    expect(insetRect({ x0: 0, y0: 0, x1: 10, y1: 10 }, 2)).toEqual({ x0: 2, y0: 2, x1: 8, y1: 8 });
    const tiny = insetRect({ x0: 0, y0: 0, x1: 2, y1: 2 }, 5);
    expect(tiny.x1).toBeGreaterThanOrEqual(tiny.x0);
    expect(tiny.y1).toBeGreaterThanOrEqual(tiny.y0);
  });

  it('grows a rect to a minimum size from its corner', () => {
    expect(atLeast({ x0: 0, y0: 0, x1: 2, y1: 30 }, 10)).toEqual({ x0: 0, y0: 0, x1: 10, y1: 30 });
  });

  it('compares points with a tolerance', () => {
    expect(samePoint({ x: 0, y: 0 }, { x: 1.5, y: -1.5 })).toBe(true);
    expect(samePoint({ x: 0, y: 0 }, { x: 3, y: 0 })).toBe(false);
    expect(samePoint({ x: 0, y: 0 }, { x: 3, y: 0 }, 4)).toBe(true);
  });

  it('writes a rect as one quad, top-left first as /QuadPoints wants', () => {
    expect(quadOfRect({ x0: 1, y0: 2, x1: 3, y1: 4 })).toEqual([1, 4, 3, 4, 1, 2, 3, 2]);
  });
});

/**
 * The shape family (M31): what a rectangle, an ellipse, a line with its endings, a polygon, a
 * polyline and a cloudy border draw — as the one list of drawings the overlay paints and the
 * writer bakes — and the acceptance line about arrow heads: **they are at the line's own angle,
 * so a resize or a turn of the line turns the head with it.**
 */

import { describe, expect, it } from 'vitest';
import {
  appearanceInput,
  arcOps,
  cloudIntensityOf,
  cloudOps,
  cloudOverhang,
  cloudRadius,
  dashOf,
  defaultAppearanceService,
  ellipseOps,
  ellipsePoints,
  endingSize,
  isLineEnding,
  LINE_ENDINGS,
  LINE_ENDING_LABELS,
  lineEndingDrawing,
  lineEndingsOf,
  opsBounds,
  paintDrawings,
  pointsBounds,
  polygonOps,
  rectPoints,
  shapeDrawings,
  shapeRectFor,
  signedArea,
  type PathOp,
} from '@engine/appearance';
import type { PdfPoint } from '@shared/pdf';
import { must } from '../find/helpers';

const RECT = { x0: 0, y0: 0, x1: 100, y1: 60 };

/** The direction of a head's wing relative to the line, in degrees. */
function wingAngle(ops: ReadonlyArray<PathOp>, tip: PdfPoint): number {
  const first = ops[0];
  if (!first || first.op === 'Z' || first.op === 'C') throw new Error('unexpected op');
  return (Math.atan2(first.y - tip.y, first.x - tip.x) * 180) / Math.PI;
}

describe('reading the extras', () => {
  it('parses the endings, the cloud and the dash, with safe defaults', () => {
    expect(lineEndingsOf({})).toEqual(['None', 'None']);
    expect(lineEndingsOf({ lineEndings: ['OpenArrow', 'nonsense'] })).toEqual([
      'OpenArrow',
      'None',
    ]);
    expect(lineEndingsOf({ lineEndings: ['OpenArrow'] })).toEqual(['None', 'None']);
    expect(cloudIntensityOf({})).toBe(0);
    expect(cloudIntensityOf({ cloudy: 5 })).toBe(2);
    expect(cloudIntensityOf({ cloudy: -1 })).toBe(0);
    expect(dashOf({ dashArray: [3, 0, 'x', 2, -1] })).toEqual([3, 2]);
    expect(dashOf({})).toEqual([]);
  });

  it('knows every ending name and a label for each', () => {
    for (const ending of LINE_ENDINGS) {
      expect(isLineEnding(ending)).toBe(true);
      expect(LINE_ENDING_LABELS[ending]).toBeTruthy();
    }
    expect(isLineEnding('Arrow')).toBe(false);
  });
});

describe('primitive geometry', () => {
  it('an arc is at most a quarter turn per Bézier and starts with a move unless continuing', () => {
    const quarter = arcOps({ x: 0, y: 0 }, 10, 0, Math.PI / 2);
    expect(quarter[0]).toEqual({ op: 'M', x: 10, y: 0 });
    expect(quarter.filter((o) => o.op === 'C').length).toBe(1);
    const full = arcOps({ x: 0, y: 0 }, 10, 0, Math.PI * 2, true);
    expect(full[0]?.op).toBe('C');
    expect(full.length).toBe(4);
    const last = full[full.length - 1];
    if (last?.op === 'C') {
      expect(last.x).toBeCloseTo(10, 6);
      expect(last.y).toBeCloseTo(0, 6);
    }
  });

  it('an ellipse is four Béziers, closed, through the four extremes', () => {
    const ops = ellipseOps(RECT);
    expect(ops.filter((o) => o.op === 'C').length).toBe(4);
    expect(ops[ops.length - 1]?.op).toBe('Z');
    const points = ellipsePoints(RECT, 8);
    expect(points.length).toBe(8);
    expect(points[0]).toEqual({ x: 100, y: 30 });
    expect(ellipsePoints(RECT, 2).length).toBe(4);
  });

  it('rect points run anticlockwise, and the signed area says so', () => {
    const points = rectPoints(RECT);
    expect(signedArea(points)).toBeGreaterThan(0);
    expect(signedArea([...points].reverse())).toBeLessThan(0);
    expect(polygonOps(points).length).toBe(5);
    expect(polygonOps(points, false).length).toBe(4);
    expect(polygonOps([]).length).toBe(0);
  });

  it('bounds of ops and of points', () => {
    expect(opsBounds([])).toBeNull();
    expect(opsBounds([{ op: 'M', x: 1, y: 2 }, { op: 'L', x: 5, y: -1 }, { op: 'Z' }])).toEqual({
      x0: 1,
      y0: -1,
      x1: 5,
      y1: 2,
    });
    expect(
      opsBounds([
        { op: 'M', x: 0, y: 0 },
        { op: 'C', x1: 9, y1: 9, x2: 1, y2: 1, x: 2, y: 2 },
      ])?.x1,
    ).toBe(9);
    expect(pointsBounds([], 1)).toBeNull();
    expect(pointsBounds([{ x: 1, y: 1 }], 2)).toEqual({ x0: -1, y0: -1, x1: 3, y1: 3 });
  });
});

describe('clouds', () => {
  it('has a radius that grows with the intensity, and an overhang to pad a rect by', () => {
    expect(cloudRadius(1)).toBeLessThan(cloudRadius(2));
    expect(cloudOverhang(1)).toBeGreaterThan(0);
    expect(cloudOverhang(2)).toBeGreaterThan(cloudOverhang(1));
  });

  it('bulges outward whichever way round the polygon runs, and closes', () => {
    const square = rectPoints({ x0: 0, y0: 0, x1: 100, y1: 100 });
    for (const points of [square, [...square].reverse()]) {
      const ops = cloudOps(points, 1);
      expect(ops[ops.length - 1]?.op).toBe('Z');
      const bounds = must(opsBounds(ops), 'bounds');
      // Every bump sticks out beyond the square, on every side.
      expect(bounds.x0).toBeLessThan(0);
      expect(bounds.y0).toBeLessThan(0);
      expect(bounds.x1).toBeGreaterThan(100);
      expect(bounds.y1).toBeGreaterThan(100);
      // And not by more than the overhang plus the Bézier's own slack.
      expect(bounds.x1 - 100).toBeLessThan(cloudOverhang(1) + cloudRadius(1));
    }
  });

  it('puts a whole number of bumps on every edge, more on a longer one', () => {
    const wide = cloudOps(rectPoints({ x0: 0, y0: 0, x1: 300, y1: 20 }), 1);
    const narrow = cloudOps(rectPoints({ x0: 0, y0: 0, x1: 30, y1: 20 }), 1);
    expect(wide.length).toBeGreaterThan(narrow.length);
    expect(cloudOps([{ x: 0, y: 0 }], 1)).toEqual([]);
    // A degenerate edge is skipped rather than dividing by zero.
    expect(
      cloudOps(
        [
          { x: 0, y: 0 },
          { x: 0, y: 0 },
          { x: 10, y: 0 },
        ],
        1,
      ).length,
    ).toBeGreaterThan(0);
  });
});

describe('line endings', () => {
  const from = { x: 0, y: 0 };

  it('sizes with the stroke, with a floor', () => {
    expect(endingSize(0.5)).toBe(6);
    expect(endingSize(3)).toBe(18);
  });

  it('draws every kind, and None draws nothing', () => {
    for (const kind of LINE_ENDINGS) {
      const drawing = lineEndingDrawing(kind, { x: 50, y: 0 }, from, 1);
      if (kind === 'None') {
        expect(drawing).toBeNull();
        continue;
      }
      expect(drawing?.ops.length, kind).toBeGreaterThan(1);
    }
    expect(lineEndingDrawing('OpenArrow', from, from, 1)).toBeNull();
  });

  it('an arrow head is at the line’s own angle, whichever way the line points', () => {
    for (const angle of [0, 30, 90, 135, 200, 300]) {
      const rad = (angle * Math.PI) / 180;
      const tip = { x: 80 * Math.cos(rad), y: 80 * Math.sin(rad) };
      const head = must(lineEndingDrawing('OpenArrow', tip, from, 2), 'head');
      // The wing leaves the tip back along the line, 30° to one side of it.
      const wing = wingAngle(head.ops, tip);
      const back = ((angle + 180) % 360) - 360 * ((angle + 180) % 360 > 180 ? 1 : 0);
      const diff = Math.abs(((wing - back + 540) % 360) - 180);
      expect(diff, `at ${angle}°`).toBeCloseTo(30, 0);
    }
  });

  it('a closed head is filled and shortens the line; an open one does not', () => {
    const closed = must(lineEndingDrawing('ClosedArrow', { x: 50, y: 0 }, from, 1), 'closed');
    const open = must(lineEndingDrawing('OpenArrow', { x: 50, y: 0 }, from, 1), 'open');
    expect(closed.closed).toBe(true);
    expect(closed.trim).toBeGreaterThan(0);
    expect(open.closed).toBe(false);
    expect(open.trim).toBe(0);
    const circle = must(lineEndingDrawing('Circle', { x: 50, y: 0 }, from, 1), 'circle');
    expect(circle.ops.filter((o) => o.op === 'C').length).toBe(4);
  });
});

describe('what a shape draws', () => {
  it('a rectangle strokes inside its rect and fills when it has a colour', () => {
    const drawings = shapeDrawings(
      appearanceInput({
        subtype: 'Square',
        rect: RECT,
        color: 0xff0000,
        interiorColor: 0x0000ff,
        borderWidth: 4,
      }),
    );
    expect(drawings.length).toBe(1);
    const d = must(drawings[0], 'drawing');
    expect(d.stroke).toBe(0xff0000);
    expect(d.fill).toBe(0x0000ff);
    expect(must(opsBounds(d.ops), 'bounds')).toEqual({ x0: 2, y0: 2, x1: 98, y1: 58 });
  });

  it('a rectangle too small for its border, or with nothing to paint, draws nothing', () => {
    expect(
      shapeDrawings(
        appearanceInput({
          subtype: 'Square',
          rect: { x0: 0, y0: 0, x1: 2, y1: 2 },
          borderWidth: 8,
        }),
      ),
    ).toEqual([]);
    expect(
      shapeDrawings(appearanceInput({ subtype: 'Circle', rect: RECT, borderWidth: 0 })),
    ).toEqual([]);
  });

  it('a cloudy rectangle and a cloudy oval are arcs, still inside the rect', () => {
    for (const subtype of ['Square', 'Circle'] as const) {
      const [d] = shapeDrawings(
        appearanceInput({ subtype, rect: RECT, color: 0, borderWidth: 1, extra: { cloudy: 1 } }),
      );
      expect(
        d?.ops.some((o) => o.op === 'C'),
        subtype,
      ).toBe(true);
      const bounds = must(opsBounds(must(d, 'drawing').ops), 'bounds');
      expect(bounds.x0).toBeGreaterThanOrEqual(-0.01);
      expect(bounds.x1).toBeLessThanOrEqual(100.01);
    }
    // Too small for a cloud: nothing rather than an inside-out one.
    expect(
      shapeDrawings(
        appearanceInput({
          subtype: 'Square',
          rect: { x0: 0, y0: 0, x1: 1, y1: 1 },
          color: 0,
          extra: { cloudy: 2 },
        }),
      ),
    ).toEqual([]);
  });

  it('a line draws its stroke and its heads, filling a closed head with the interior colour', () => {
    const drawings = shapeDrawings(
      appearanceInput({
        subtype: 'Line',
        rect: RECT,
        color: 0x112233,
        interiorColor: 0xffffff,
        borderWidth: 2,
        vertices: [
          { x: 0, y: 0 },
          { x: 100, y: 0 },
        ],
        extra: { lineEndings: ['Circle', 'ClosedArrow'], dashArray: [4, 2] },
      }),
    );
    expect(drawings.length).toBe(3);
    const [line, start, end] = drawings;
    expect(line?.dash).toEqual([4, 2]);
    // The line stops short of both closed heads.
    const lb = must(opsBounds(must(line, 'line').ops), 'line bounds');
    expect(lb.x0).toBeGreaterThan(0);
    expect(lb.x1).toBeLessThan(100);
    expect(start?.fill).toBe(0xffffff);
    expect(end?.fill).toBe(0xffffff);
    expect(end?.dash).toBeUndefined();
  });

  it('a line with no vertices falls back to the rect’s diagonal', () => {
    const [line] = shapeDrawings(
      appearanceInput({ subtype: 'Line', rect: { x0: 1, y0: 2, x1: 30, y1: 40 } }),
    );
    expect(line?.ops[0]).toEqual({ op: 'M', x: 1, y: 2 });
  });

  it('a polygon needs three points, a polyline two, and a polyline is never filled', () => {
    const two = [
      { x: 0, y: 0 },
      { x: 10, y: 10 },
    ];
    expect(
      shapeDrawings(appearanceInput({ subtype: 'Polygon', rect: RECT, vertices: two })),
    ).toEqual([]);
    const [poly] = shapeDrawings(
      appearanceInput({ subtype: 'PolyLine', rect: RECT, interiorColor: 0xff0000, vertices: two }),
    );
    expect(poly?.fill).toBeNull();
    const [cloud] = shapeDrawings(
      appearanceInput({
        subtype: 'Polygon',
        rect: RECT,
        color: 0,
        vertices: [...two, { x: 0, y: 10 }],
        extra: { cloudy: 2 },
      }),
    );
    expect(cloud?.ops.some((o) => o.op === 'C')).toBe(true);
  });

  it('a polyline draws heads at both ends from its own first and last segments', () => {
    const drawings = shapeDrawings(
      appearanceInput({
        subtype: 'PolyLine',
        rect: RECT,
        color: 0,
        vertices: [
          { x: 0, y: 0 },
          { x: 50, y: 0 },
          { x: 50, y: 50 },
        ],
        extra: { lineEndings: ['OpenArrow', 'OpenArrow'] },
      }),
    );
    expect(drawings.length).toBe(3);
  });

  it('other subtypes draw nothing here', () => {
    expect(shapeDrawings(appearanceInput({ subtype: 'Text', rect: RECT }))).toEqual([]);
  });
});

describe('the rect a shape needs', () => {
  it('contains the points, the stroke and any heads', () => {
    const vertices = [
      { x: 10, y: 10 },
      { x: 90, y: 10 },
    ];
    const plain = shapeRectFor('Line', vertices, 2, {});
    const arrow = shapeRectFor('Line', vertices, 2, { lineEndings: ['None', 'OpenArrow'] });
    expect(plain.x0).toBeLessThan(10);
    expect(arrow.x1 - plain.x1).toBeCloseTo(endingSize(2), 6);
    const cloud = shapeRectFor('Polygon', [...vertices, { x: 50, y: 50 }], 0, { cloudy: 1 });
    expect(cloud.y0).toBeLessThan(10 - cloudOverhang(1));
    expect(shapeRectFor('PolyLine', [], 1, {})).toEqual({ x0: 0, y0: 0, x1: 0, y1: 0 });
  });
});

describe('the generators', () => {
  const service = defaultAppearanceService;

  it('registers Stamp as well as the shapes', () => {
    for (const subtype of ['Square', 'Circle', 'Line', 'Polygon', 'PolyLine', 'Stamp'] as const) {
      expect(service.has(subtype), subtype).toBe(true);
    }
  });

  it('paints nothing for an empty list, and skips a drawing with neither stroke nor fill', () => {
    const input = appearanceInput({ subtype: 'Square', rect: RECT });
    expect(paintDrawings(input, [])).toBeNull();
    expect(
      paintDrawings(input, [
        { ops: [{ op: 'M', x: 0, y: 0 }], stroke: null, fill: null, width: 1 },
      ]),
    ).toBeNull();
  });

  it('applies the annotation’s opacity as a graphics state, and only then', () => {
    const solid = service.generate(
      appearanceInput({ subtype: 'Square', rect: RECT, color: 0, borderWidth: 1 }),
    );
    expect(solid?.content).not.toContain('gs');
    const faint = service.generate(
      appearanceInput({ subtype: 'Square', rect: RECT, color: 0, borderWidth: 1, opacity: 0.5 }),
    );
    expect(faint?.content).toContain('gs');
  });

  it('an arrow’s bbox grows to hold its head', () => {
    const input = appearanceInput({
      subtype: 'Line',
      rect: { x0: 0, y0: -1, x1: 100, y1: 1 },
      color: 0,
      borderWidth: 3,
      vertices: [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
      ],
      extra: { lineEndings: ['None', 'OpenArrow'] },
    });
    const stream = must(service.generate(input), 'stream');
    expect(stream.bbox.y1).toBeGreaterThan(5);
    expect(stream.bbox.y0).toBeLessThan(-5);
  });

  it('a dashed cloud writes the dash and the arcs', () => {
    const stream = service.generate(
      appearanceInput({
        subtype: 'Square',
        rect: RECT,
        color: 0,
        borderWidth: 1,
        extra: { cloudy: 1, dashArray: [3, 2] },
      }),
    );
    expect(stream?.content).toContain('[3 2] 0 d');
    expect(stream?.content).toMatch(/ c$/m);
  });
});

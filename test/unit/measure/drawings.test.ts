/**
 * What a measurement measures, and what it draws (M33).
 *
 * The value first — a 100 mm line really is 100 mm, a 50 × 20 mm rectangle really is 1000 mm² —
 * and then the dimension line: the leaders where `/LL`, `/LLE` and `/LLO` put them, and the
 * caption where `/Cap` and `/CP` put it.
 */

import { describe, expect, it } from 'vitest';
import { must } from '../find/helpers';
import {
  DEFAULT_MEASURE_SCALE,
  DEFAULT_MEASURE_STYLE,
  MEASURE_INTENTS,
  appearanceInput,
  centroid,
  createAppearanceService,
  dimensionLine,
  isMeasureIntent,
  isMeasurement,
  kindOfIntent,
  measureDrawings,
  measureIntentOf,
  measureRectFor,
  captionAnchor,
  captionHandle,
  captionOffsetFor,
  measureStyleOf,
  measurementOf,
  midpointAlong,
  readableAngle,
  shapeDrawings,
  type AppearanceInput,
} from '@engine/appearance';
import type { PdfPoint } from '@shared/pdf';

const MM = 72 / 25.4;
const p = (xmm: number, ymm: number): PdfPoint => ({ x: xmm * MM, y: ymm * MM });

function input(patch: Partial<AppearanceInput>): AppearanceInput {
  return appearanceInput({
    subtype: 'Line',
    rect: { x0: 0, y0: 0, x1: 100, y1: 100 },
    color: 0x5b2d91,
    borderWidth: 1,
    ...patch,
  });
}

const scaled = { measure: DEFAULT_MEASURE_SCALE };

describe('what a measurement measures', () => {
  it('a 100 mm line measures 100.0 mm', () => {
    const measurement = measurementOf({
      subtype: 'Line',
      vertices: [p(20, 250), p(120, 250)],
      extra: { ...scaled, intent: MEASURE_INTENTS.Line },
    });
    expect(measurement?.kind).toBe('length');
    expect(measurement?.value).toBeCloseTo(100, 6);
    expect(measurement?.text).toBe('100.0 mm');
  });

  it('a 50 x 20 mm rectangle measures 1000.0 mm²', () => {
    const measurement = measurementOf({
      subtype: 'Polygon',
      vertices: [p(20, 200), p(70, 200), p(70, 220), p(20, 220)],
      extra: { ...scaled, intent: MEASURE_INTENTS.Polygon },
    });
    expect(measurement?.kind).toBe('area');
    expect(measurement?.value).toBeCloseTo(1000, 6);
    expect(measurement?.text).toBe('1,000.0 mm²');
  });

  it('a perimeter adds up its segments', () => {
    const measurement = measurementOf({
      subtype: 'PolyLine',
      vertices: [p(30, 120), p(90, 120), p(30, 165), p(30, 120)],
      extra: { ...scaled, intent: MEASURE_INTENTS.PolyLine },
    });
    expect(measurement?.value).toBeCloseTo(180, 6);
    expect(measurement?.text).toBe('180.0 mm');
  });

  it("measures at whatever scale the annotation carries, not the app's", () => {
    const measurement = measurementOf({
      subtype: 'Line',
      vertices: [p(0, 0), p(100, 0)],
      extra: {
        intent: MEASURE_INTENTS.Line,
        measure: {
          fromValue: 1,
          fromUnit: 'mm',
          toValue: 50,
          toUnit: 'mm',
          precision: 0,
          denominator: 0,
        },
      },
    });
    expect(measurement?.text).toBe('5,000 mm');
  });

  it('is nothing at all when the intent and the subtype disagree', () => {
    expect(
      measurementOf({
        subtype: 'Polygon',
        vertices: [p(0, 0), p(1, 0), p(0, 1)],
        extra: { intent: MEASURE_INTENTS.Line },
      }),
    ).toBeNull();
    expect(isMeasurement('Line', { intent: 'LineArrow' })).toBe(false);
    expect(isMeasurement('Line', {})).toBe(false);
    expect(isMeasurement('Line', { intent: MEASURE_INTENTS.Line })).toBe(true);
  });

  it('knows its own intents', () => {
    expect(isMeasureIntent('LineDimension')).toBe(true);
    expect(isMeasureIntent('PolygonCloud')).toBe(false);
    expect(measureIntentOf({ intent: 'PolygonDimension' })).toBe('PolygonDimension');
    expect(measureIntentOf({})).toBeNull();
    expect(kindOfIntent('PolygonDimension')).toBe('area');
    expect(kindOfIntent('PolyLineDimension')).toBe('length');
  });
});

describe('the style an annotation carries', () => {
  it('defaults every field, and clamps the ones that have a range', () => {
    expect(measureStyleOf({})).toEqual(DEFAULT_MEASURE_STYLE);
    const style = measureStyleOf({
      leaderLength: -8,
      leaderExtend: -4,
      leaderOffset: -2,
      caption: false,
      captionPosition: 'Inline',
      captionOffset: [1, 2],
      fontSize: 500,
    });
    // A negative `/LL` is meaningful — the other side of the line — but `/LLE` and `/LLO` are not.
    expect(style.leaderLength).toBe(-8);
    expect(style.leaderExtend).toBe(0);
    expect(style.leaderOffset).toBe(0);
    expect(style.caption).toBe(false);
    expect(style.captionPosition).toBe('Inline');
    expect(style.captionOffset).toEqual([1, 2]);
    expect(style.fontSize).toBe(72);
  });

  it('ignores a caption offset that is not two numbers', () => {
    expect(measureStyleOf({ captionOffset: [1] }).captionOffset).toEqual([0, 0]);
    expect(measureStyleOf({ captionOffset: ['a', 'b'] }).captionOffset).toEqual([0, 0]);
  });
});

const service = createAppearanceService();

describe('what a dimension draws', () => {
  const from = { x: 100, y: 100 };
  const to = { x: 300, y: 100 };
  const base = {
    subtype: 'Line' as const,
    vertices: [from, to],
    extra: {
      ...scaled,
      intent: MEASURE_INTENTS.Line,
      leaderLength: 20,
      leaderExtend: 5,
      leaderOffset: 2,
      caption: true,
      captionPosition: 'Top',
    },
  };

  it('offsets the line proper by /LL, clockwise for a positive value', () => {
    // Walking left to right, clockwise is downwards in page space.
    const line = dimensionLine(from, to, 20);
    expect(line.from).toEqual({ x: 100, y: 80 });
    expect(line.to).toEqual({ x: 300, y: 80 });
    const other = dimensionLine(from, to, -20);
    expect(other.from).toEqual({ x: 100, y: 120 });
  });

  it('draws a leader at each end, from /LLO past the line by /LLE', () => {
    const drawn = measureDrawings(input(base));
    expect(drawn).not.toBeNull();
    if (!drawn) return;
    // Two leaders and the line proper.
    expect(drawn.paths).toHaveLength(3);
    const leader = drawn.paths[0];
    expect(leader?.ops[0]).toEqual({ op: 'M', x: 100, y: 98 });
    expect(leader?.ops[1]).toEqual({ op: 'L', x: 100, y: 75 });
  });

  it('draws no leaders when every leader entry is zero', () => {
    const drawn = measureDrawings(
      input({
        ...base,
        extra: { ...base.extra, leaderLength: 0, leaderExtend: 0, leaderOffset: 0 },
      }),
    );
    expect(drawn?.paths).toHaveLength(1);
  });

  it('breaks the line for an inline caption, and leaves it whole for one on top', () => {
    const inline = measureDrawings(
      input({ ...base, extra: { ...base.extra, captionPosition: 'Inline' } }),
    );
    // Two leaders plus the two halves of the line.
    expect(inline?.paths).toHaveLength(4);
    const top = measureDrawings(input(base));
    expect(top?.paths).toHaveLength(3);
  });

  it('puts the caption on the line, turned so it never reads upside down', () => {
    const drawn = measureDrawings(input(base));
    expect(drawn?.caption?.text).toBe('70.6 mm');
    expect(drawn?.caption?.rotate).toBe(0);
    const backwards = measureDrawings(input({ ...base, vertices: [to, from] }));
    // Right to left is drawn as if left to right: 180° would be upside down.
    expect(backwards?.caption?.rotate).toBe(0);
    expect(readableAngle(-1, 0)).toBe(0);
    expect(readableAngle(0, 1)).toBe(90);
    expect(readableAngle(0, -1)).toBe(90);
  });

  it('draws a /LE ending on each end of the *line proper*, not on the measured points', () => {
    const withHeads = measureDrawings(
      input({ ...base, extra: { ...base.extra, lineEndings: ['None', 'OpenArrow'] } }),
    );
    // Two leaders, the line, and one head.
    expect(withHeads?.paths).toHaveLength(4);
    const head = must(withHeads?.paths[3], 'head');
    const tip = head.ops[1];
    if (tip?.op !== 'L') throw new Error('unexpected head');
    // The head's tip is on the line proper, which /LL has moved 20 points across.
    expect(tip.x).toBeCloseTo(300, 6);
    expect(tip.y).toBeCloseTo(80, 6);
    // A closed head is filled and the line stops short of it, so the stroke does not show through.
    const closed = measureDrawings(
      input({
        ...base,
        interiorColor: 0x5b2d91,
        extra: { ...base.extra, lineEndings: ['ClosedArrow', 'None'] },
      }),
    );
    // Two leaders, then the line proper, then the head.
    const line = must(closed?.paths[2], 'line');
    const start = line.ops[0];
    if (start?.op !== 'M') throw new Error('unexpected line');
    expect(start.x).toBeGreaterThan(100);
    expect(must(closed?.paths[closed.paths.length - 1], 'head').fill).toBe(0x5b2d91);
  });

  it('leaves the caption out when /Cap is false', () => {
    const drawn = measureDrawings(input({ ...base, extra: { ...base.extra, caption: false } }));
    expect(drawn?.caption).toBeNull();
  });

  it("puts a polygon's caption at its centre and a polyline's half way along", () => {
    const square = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 100 },
      { x: 0, y: 100 },
    ];
    expect(centroid(square)).toEqual({ x: 50, y: 50 });
    expect(
      midpointAlong([
        { x: 0, y: 0 },
        { x: 100, y: 0 },
      ]),
    ).toEqual({ x: 50, y: 0 });
    expect(midpointAlong([])).toBeNull();
    expect(centroid([])).toBeNull();
    const drawn = measureDrawings(
      input({
        subtype: 'Polygon',
        vertices: square,
        extra: { ...scaled, intent: MEASURE_INTENTS.Polygon },
      }),
    );
    // Centred on the middle: the baseline is half the text width to the left of it.
    expect(drawn?.caption?.x).toBeLessThan(50);
    expect(drawn?.caption?.y).toBeCloseTo(50 - 9 * 0.35, 6);
    // A polygon's own outline is not the measurement's job — only the caption is.
    expect(drawn?.paths).toHaveLength(0);
  });

  it('is nothing at all for a shape that is not a measurement', () => {
    expect(measureDrawings(input({ extra: {} }))).toBeNull();
    expect(measureDrawings(input({ subtype: 'Square', extra: { ...scaled } }))).toBeNull();
  });

  it('gives the stream a /BBox equal to the /Rect, so no viewer scales the caption', () => {
    /*
     * A viewer maps an appearance's `/BBox` on to the annotation's `/Rect` (PDF 12.5.5). The two
     * disagreeing by a point scales everything the stream draws — invisible on a plain outline,
     * but a caption that has moved. So the rect the model stores *is* the bbox the stream carries.
     */
    for (const source of [
      input(base),
      input({ ...base, extra: { ...base.extra, captionPosition: 'Inline' } }),
      input({
        subtype: 'Polygon',
        vertices: [
          { x: 0, y: 0 },
          { x: 120, y: 0 },
          { x: 120, y: 80 },
          { x: 0, y: 80 },
        ],
        extra: { ...scaled, intent: MEASURE_INTENTS.Polygon },
      }),
      input({
        subtype: 'PolyLine',
        vertices: [
          { x: 0, y: 0 },
          { x: 120, y: 0 },
          { x: 120, y: 80 },
        ],
        extra: { ...scaled, intent: MEASURE_INTENTS.PolyLine },
      }),
    ]) {
      const rect = measureRectFor(source, source.rect, shapeDrawings);
      const stream = service.generate({ ...source, rect });
      expect(stream, source.subtype).not.toBeNull();
      for (const key of ['x0', 'y0', 'x1', 'y1'] as const) {
        expect(stream?.bbox[key], `${source.subtype}.${key}`).toBeCloseTo(rect[key], 9);
      }
      // And the measured points are inside it, as a reader expects of `/L` and `/Vertices`.
      for (const point of source.vertices) {
        expect(point.x, source.subtype).toBeGreaterThanOrEqual(rect.x0);
        expect(point.x, source.subtype).toBeLessThanOrEqual(rect.x1);
        expect(point.y, source.subtype).toBeGreaterThanOrEqual(rect.y0);
        expect(point.y, source.subtype).toBeLessThanOrEqual(rect.y1);
      }
    }
  });

  it('grows the rect to hold the leaders and the caption', () => {
    const source = input(base);
    const tight = { x0: 100, y0: 100, x1: 300, y1: 100 };
    const grown = measureRectFor({ ...source, rect: tight }, tight);
    // The leaders run down to y = 75, so the rect has to reach at least that far.
    expect(grown.y0).toBeLessThanOrEqual(75);
    expect(grown.y1).toBeGreaterThanOrEqual(100);
    // A shape that is not a measurement keeps the rect it was given.
    expect(measureRectFor(input({ extra: {} }), tight)).toEqual(tight);
  });
});

describe('moving the caption', () => {
  const distance = input({
    subtype: 'Line',
    vertices: [
      { x: 100, y: 100 },
      { x: 300, y: 100 },
    ],
    extra: { ...scaled, intent: MEASURE_INTENTS.Line, leaderLength: 20 },
  });
  const area = input({
    subtype: 'Polygon',
    vertices: [
      { x: 0, y: 0 },
      { x: 200, y: 0 },
      { x: 200, y: 100 },
      { x: 0, y: 100 },
    ],
    extra: { ...scaled, intent: MEASURE_INTENTS.Polygon },
  });

  it('puts the handle past the end of the text, so it hides no digit', () => {
    const drawn = must(measureDrawings(distance), 'drawings');
    const caption = must(drawn.caption, 'caption');
    const at = captionAnchor(caption);
    // Clear of the last glyph, and at the height of the text's middle.
    expect(at.x).toBeGreaterThan(caption.x + caption.width);
    expect(at.y).toBeGreaterThan(caption.y);
    expect(captionHandle(distance)).toEqual(at);
  });

  it('has no handle when there is no caption to move', () => {
    expect(
      captionHandle(input({ ...distance, extra: { ...distance.extra, caption: false } })),
    ).toBeNull();
    expect(captionHandle(input({ extra: {} }))).toBeNull();
    expect(captionOffsetFor(input({ extra: {} }), { x: 0, y: 0 })).toBeNull();
  });

  it('works out the /CO that puts the caption where it was dragged, and back again', () => {
    for (const source of [distance, area]) {
      const start = must(captionHandle(source), 'handle');
      const to = { x: start.x + 17, y: start.y - 23 };
      const offset = must(captionOffsetFor(source, to), 'offset');
      const moved = input({
        ...source,
        extra: { ...source.extra, captionOffset: [...offset] },
      });
      const landed = must(captionHandle(moved), 'moved handle');
      expect(landed.x, source.subtype).toBeCloseTo(to.x, 6);
      expect(landed.y, source.subtype).toBeCloseTo(to.y, 6);
      // Asking for where it already is gives no offset at all.
      expect(must(captionOffsetFor(source, start), 'zero')[0]).toBeCloseTo(0, 9);
      expect(must(captionOffsetFor(source, start), 'zero')[1]).toBeCloseTo(0, 9);
    }
  });

  it('nudges a distance along its own line, so the caption turns with it', () => {
    // Dragged 10 points along the line and 4 across it…
    const start = must(captionHandle(distance), 'handle');
    const offset = must(captionOffsetFor(distance, { x: start.x + 10, y: start.y - 4 }), 'offset');
    expect(offset[0]).toBeCloseTo(10, 6);
    expect(offset[1]).toBeCloseTo(4, 6);
    // …and the same `/CO` on the same line drawn backwards keeps the caption on the same side of
    // it, because the frame is the line's, not the page's.
    const reversed = input({
      ...distance,
      vertices: [
        { x: 300, y: 100 },
        { x: 100, y: 100 },
      ],
      extra: { ...distance.extra, captionOffset: [...offset] },
    });
    const drawn = must(measureDrawings(reversed), 'drawings');
    expect(must(drawn.caption, 'caption').text).toBe('70.6 mm');
  });

  it('never changes what the measurement says', () => {
    const before = must(measurementOf({ ...distance }), 'before');
    const offset = must(captionOffsetFor(distance, { x: 500, y: 500 }), 'offset');
    const after = must(
      measurementOf({
        subtype: 'Line',
        vertices: distance.vertices,
        extra: { ...distance.extra, captionOffset: [...offset] },
      }),
      'after',
    );
    expect(after.value).toBe(before.value);
    expect(after.text).toBe(before.text);
  });

  it('grows the rect to hold a caption that has been dragged off the line', () => {
    const offset = must(captionOffsetFor(distance, { x: 200, y: 260 }), 'offset');
    const moved = input({
      ...distance,
      extra: { ...distance.extra, captionOffset: [...offset] },
    });
    const rect = measureRectFor(moved, moved.rect, shapeDrawings);
    expect(rect.y1).toBeGreaterThan(250);
  });
});

describe('the appearance stream', () => {
  it('draws a dimension with its caption, and a plain line without one', () => {
    const dimension = service.generate(
      input({
        vertices: [
          { x: 100, y: 100 },
          { x: 300, y: 100 },
        ],
        extra: { ...scaled, intent: MEASURE_INTENTS.Line, caption: true },
      }),
    );
    expect(dimension?.content).toContain('Tj');
    expect(dimension?.content).toContain('(70.6 mm)');
    const plain = service.generate(
      input({
        vertices: [
          { x: 100, y: 100 },
          { x: 300, y: 100 },
        ],
        extra: {},
      }),
    );
    expect(plain?.content).not.toContain('Tj');
  });

  it('keeps the outline of a measured polygon and adds its caption', () => {
    const stream = service.generate(
      input({
        subtype: 'Polygon',
        vertices: [
          { x: 0, y: 0 },
          { x: 100, y: 0 },
          { x: 100, y: 100 },
          { x: 0, y: 100 },
        ],
        extra: { ...scaled, intent: MEASURE_INTENTS.Polygon },
      }),
    );
    expect(stream?.content).toContain('S');
    expect(stream?.content).toContain('Tj');
    expect(Object.keys(stream?.resources.fonts ?? {})).toHaveLength(1);
  });

  it('is deterministic: the same input twice is the same bytes', () => {
    const source = input({
      vertices: [
        { x: 100, y: 100 },
        { x: 300, y: 160 },
      ],
      extra: { ...scaled, intent: MEASURE_INTENTS.Line, leaderLength: 12 },
    });
    expect(service.generate(source)?.content).toBe(service.generate(source)?.content);
  });
});

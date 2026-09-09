/**
 * `/QuadPoints` from a text selection (M30) — the module's first acceptance test.
 *
 * "Highlight across a line break on a rotated page yields correct QuadPoints" is the line the
 * brief asks for, and it is really two claims: one quad per line rather than one box around
 * both, and quads in the *line's own* axes rather than the axis-aligned box containing them.
 * Both are checked here, on horizontal text and on text rotated by 90° and by 30°.
 */

import { describe, expect, it } from 'vitest';
import type { TextRun } from '@engine/PdfEngine';
import type { PdfPoint, PdfRect } from '@shared/pdf';
import { buildPageText, type PageText } from '@view/TextLayer';
import { quads, quadNumbers, quadsBounds } from '@engine/appearance';
import { caretPointAt, quadsForSpan, quadsForSpans } from '@modules/M30-markup-annotations/quads';
import { must } from '../find/helpers';

/**
 * A run of evenly spaced characters at an angle, with genuinely rotated character boxes.
 *
 * M13's own helper keeps its boxes axis-aligned, which is right for the text model's purposes
 * and useless here: the whole point of this file is what happens when they are not.
 */
function rotatedRun(spec: {
  readonly text: string;
  readonly x: number;
  readonly y: number;
  readonly angle: number;
  readonly size?: number;
  readonly advance?: number;
  readonly index?: number;
}): TextRun {
  const size = spec.size ?? 10;
  const advance = spec.advance ?? size * 0.6;
  const cos = Math.cos(spec.angle);
  const sin = Math.sin(spec.angle);
  const at = (along: number, up: number): PdfPoint => ({
    x: spec.x + along * cos - up * sin,
    y: spec.y + along * sin + up * cos,
  });
  const chars: PdfRect[] = [];
  const glyphs = Array.from(spec.text);
  for (let i = 0; i < glyphs.length; i++) {
    const corners = [
      at(i * advance, 0),
      at((i + 1) * advance, 0),
      at(i * advance, size),
      at((i + 1) * advance, size),
    ];
    chars.push({
      x0: Math.min(...corners.map((c) => c.x)),
      y0: Math.min(...corners.map((c) => c.y)),
      x1: Math.max(...corners.map((c) => c.x)),
      y1: Math.max(...corners.map((c) => c.y)),
    });
  }
  const xs = chars.flatMap((c) => [c.x0, c.x1]);
  const ys = chars.flatMap((c) => [c.y0, c.y1]);
  return {
    text: spec.text,
    rect: { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) },
    chars,
    origin: { x: spec.x, y: spec.y },
    matrix: [cos, sin, -sin, cos, spec.x, spec.y],
    fontName: 'Helvetica',
    fontSize: size,
    color: 0,
    objectIndex: spec.index ?? 0,
    angle: spec.angle,
  };
}

function pageOfRuns(runs: ReadonlyArray<TextRun>): PageText {
  return buildPageText(0, runs);
}

/** The whole page's text as one span. */
function wholePage(text: PageText): { start: number; end: number } {
  return { start: 0, end: text.text.length };
}

/** How far a quad's corners are from where they should be. */
function distance(a: PdfPoint, b: PdfPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

describe('quads from a selection', () => {
  it('gives one quad per line, not one box round both', () => {
    const text = pageOfRuns([
      rotatedRun({ text: 'first line', x: 72, y: 700, angle: 0, index: 0 }),
      rotatedRun({ text: 'second line', x: 72, y: 686, angle: 0, index: 1 }),
    ]);
    const list = quadsForSpan(text, wholePage(text));
    expect(list.length).toBe(2);
    // Each quad is one line high, not the 24 points the two lines span together.
    for (const q of list) {
      expect(distance(q.ul, q.ll)).toBeCloseTo(10, 4);
    }
    // Together they cover both lines.
    const bounds = must(quadsBounds(list), 'bounds');
    expect(bounds.y0).toBeCloseTo(686, 4);
    expect(bounds.y1).toBeCloseTo(710, 4);
  });

  it('a quad over horizontal text is the rectangle the words sit in', () => {
    const text = pageOfRuns([rotatedRun({ text: 'abc', x: 100, y: 500, angle: 0, advance: 6 })]);
    const [q] = quadsForSpan(text, wholePage(text));
    const quad = must(q, 'quad');
    expect(quad.ul).toEqual({ x: 100, y: 510 });
    expect(quad.ur).toEqual({ x: 118, y: 510 });
    expect(quad.ll).toEqual({ x: 100, y: 500 });
    expect(quad.lr).toEqual({ x: 118, y: 500 });
  });

  it('a quad over 90°-rotated text is rotated too, not the column that contains it', () => {
    const angle = Math.PI / 2;
    const text = pageOfRuns([rotatedRun({ text: 'abc', x: 100, y: 500, angle, advance: 6 })]);
    const [q] = quadsForSpan(text, wholePage(text));
    const quad = must(q, 'quad');
    // Along the line is +y; across it is -x. The quad is 18 long and 10 across, the same
    // dimensions as the horizontal case, rather than the 18 × 10 box swapped into 10 × 18.
    expect(distance(quad.ul, quad.ur)).toBeCloseTo(18, 3);
    expect(distance(quad.ul, quad.ll)).toBeCloseTo(10, 3);
    // The "upper" edge is the one further along the line's own up axis, which points at -x here.
    expect(quad.ul.x).toBeCloseTo(90, 3);
    expect(quad.ll.x).toBeCloseTo(100, 3);
    expect(quad.ul.y).toBeCloseTo(500, 3);
    expect(quad.ur.y).toBeCloseTo(518, 3);
  });

  it('a quad over text at 30° is a parallelogram, and its box is much bigger than it', () => {
    const angle = Math.PI / 6;
    const text = pageOfRuns([rotatedRun({ text: 'abcdefgh', x: 100, y: 300, angle, advance: 6 })]);
    const [q] = quadsForSpan(text, wholePage(text));
    const quad = must(q, 'quad');
    expect(distance(quad.ul, quad.ur)).toBeGreaterThan(45);
    expect(distance(quad.ul, quad.ll)).toBeCloseTo(10, 1);
    const bounds = must(quadsBounds([quad]), 'bounds');
    const boxArea = (bounds.x1 - bounds.x0) * (bounds.y1 - bounds.y0);
    const quadArea = distance(quad.ul, quad.ur) * distance(quad.ul, quad.ll);
    // The axis-aligned box a naive implementation would use is half again as large.
    expect(boxArea).toBeGreaterThan(quadArea * 1.4);
  });

  it('a highlight across a line break on a rotated page has one quad per line, both rotated', () => {
    const angle = Math.PI / 2;
    const text = pageOfRuns([
      rotatedRun({ text: 'first line', x: 100, y: 300, angle, index: 0 }),
      rotatedRun({ text: 'second line', x: 114, y: 300, angle, index: 1 }),
    ]);
    const list = quadsForSpan(text, wholePage(text));
    expect(list.length).toBe(2);
    for (const q of list) {
      expect(distance(q.ul, q.ll)).toBeCloseTo(10, 3);
      // Rotated: the two "upper" corners share an x, not a y.
      expect(q.ul.x).toBeCloseTo(q.ur.x, 3);
      expect(q.ul.y).not.toBeCloseTo(q.ur.y, 3);
    }
  });

  it('the line separators the text model invents get no quad of their own', () => {
    const text = pageOfRuns([
      rotatedRun({ text: 'one', x: 72, y: 700, angle: 0, index: 0 }),
      rotatedRun({ text: 'two', x: 72, y: 686, angle: 0, index: 1 }),
    ]);
    // The model's text ends every line with a `\n`; selecting all of it must still give two.
    expect(text.text).toContain('\n');
    expect(quadsForSpan(text, wholePage(text)).length).toBe(2);
  });

  it('an empty span produces nothing at all', () => {
    const text = pageOfRuns([rotatedRun({ text: 'abc', x: 0, y: 0, angle: 0 })]);
    expect(quadsForSpan(text, { start: 2, end: 2 })).toEqual([]);
    expect(quadsForSpans(text, [])).toEqual([]);
  });

  it('round-trips through the eight numbers a PDF stores', () => {
    const text = pageOfRuns([
      rotatedRun({ text: 'abc', x: 10, y: 20, angle: Math.PI / 4, advance: 6 }),
    ]);
    const [q] = quadsForSpan(text, wholePage(text));
    const quad = must(q, 'quad');
    const numbers = quadNumbers(quad);
    expect(numbers.length).toBe(8);
    const [back] = quads(numbers);
    expect(back).toEqual(quad);
  });
});

describe('caret placement', () => {
  it('a caret before a character sits at its leading edge, on the baseline', () => {
    const text = pageOfRuns([rotatedRun({ text: 'abc', x: 100, y: 500, angle: 0, advance: 6 })]);
    const at = must(caretPointAt(text, 1, 'before'), 'caret');
    expect(at.point.x).toBeCloseTo(106, 4);
    expect(at.point.y).toBeCloseTo(500, 4);
    expect(at.lineHeight).toBeCloseTo(10, 4);
  });

  it('a caret after a character sits at its trailing edge', () => {
    const text = pageOfRuns([rotatedRun({ text: 'abc', x: 100, y: 500, angle: 0, advance: 6 })]);
    const at = must(caretPointAt(text, 1, 'after'), 'caret');
    expect(at.point.x).toBeCloseTo(112, 4);
  });

  it('follows the line when the text is rotated', () => {
    const angle = Math.PI / 2;
    const text = pageOfRuns([rotatedRun({ text: 'abc', x: 100, y: 500, angle, advance: 6 })]);
    const at = must(caretPointAt(text, 1, 'before'), 'caret');
    // Along the line is +y, so "before the second character" is six points up the page.
    expect(at.point.y).toBeCloseTo(506, 3);
    expect(at.point.x).toBeCloseTo(100, 3);
  });

  it('an empty page has no caret to offer', () => {
    expect(caretPointAt(buildPageText(0, []), 0)).toBeNull();
  });
});

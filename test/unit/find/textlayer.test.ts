/**
 * The text layer (M13): reading order, line and paragraph grouping, hit testing, selection
 * rectangles, column select and the mapping back to `core/Selection`'s run ranges.
 */

import { describe, expect, it } from 'vitest';
import {
  buildPageText,
  columnSpans,
  emptyPageText,
  lineAt,
  lineAtPoint,
  mergeSpans,
  offsetAt,
  paragraphAt,
  paragraphSpanAt,
  rangeToSpan,
  spanRects,
  spanText,
  spanToRange,
  wholePageSpan,
  wordAt,
} from '@view/TextLayer';
import { must, pageOf, run, TWO_LINES } from './helpers';

describe('buildPageText', () => {
  it('is empty for a page with no runs', () => {
    const model = emptyPageText(3);
    expect(model.page).toBe(3);
    expect(model.text).toBe('');
    expect(model.lines).toHaveLength(0);
  });

  it('keeps one character box per UTF-16 unit, including outside the BMP', () => {
    const model = pageOf([{ text: 'a\u{1F600}b', x: 0, y: 0 }]);
    expect(model.chars.length).toBe(model.text.length);
    // The emoji is two units sharing one box.
    expect(model.chars[1]?.rect).toEqual(model.chars[2]?.rect);
    expect(model.chars[1]?.offsetInRun).toBe(1);
    expect(model.chars[2]?.offsetInRun).toBe(1);
  });

  it('reads top to bottom and left to right, whatever order the runs arrive in', () => {
    const model = pageOf([
      { text: 'world', x: 140, y: 700 },
      { text: 'second line', x: 72, y: 686 },
      { text: 'hello', x: 72, y: 700 },
    ]);
    expect(model.text).toBe('hello world\nsecond line\n');
  });

  it('puts a space between runs the file only separates by a gap', () => {
    const model = pageOf([
      { text: 'left', x: 72, y: 700, advance: 5 },
      // 40 pt further on: a gap far wider than a fifth of an em.
      { text: 'right', x: 132, y: 700, advance: 5 },
    ]);
    expect(model.text).toBe('left right\n');
  });

  it('does not insert a space when the runs already touch', () => {
    const model = pageOf([
      { text: 'con', x: 72, y: 700, advance: 5 },
      { text: 'joined', x: 87, y: 700, advance: 5 },
    ]);
    expect(model.text).toBe('conjoined\n');
  });

  it('ends every line with a separator that has a zero-width box', () => {
    const model = pageOf(TWO_LINES);
    expect(model.text.endsWith('\n')).toBe(true);
    const breaks = model.chars.filter((c) => c.synthetic);
    expect(breaks.length).toBeGreaterThanOrEqual(2);
    const first = model.chars[model.lines[0]?.end ?? 0];
    expect(first?.synthetic).toBe(true);
    expect(first?.rect.x1).toBe(first?.rect.x0);
  });

  it('groups consecutive body lines into one paragraph', () => {
    const model = pageOf([
      { text: 'The quick brown fox jumps over', x: 72, y: 700, size: 11 },
      { text: 'the lazy dog and keeps running', x: 72, y: 686, size: 11 },
      { text: 'until it reaches the far bank.', x: 72, y: 672, size: 11 },
    ]);
    expect(model.lines).toHaveLength(3);
    expect(model.paragraphs).toHaveLength(1);
    expect(model.paragraphs[0]?.lines).toEqual([0, 1, 2]);
  });

  it('starts a new paragraph at a heading, a size change and a big gap', () => {
    const model = pageOf([
      { text: 'A Heading', x: 72, y: 740, size: 24 },
      { text: 'Body text that runs the width of', x: 72, y: 700, size: 11 },
      { text: 'the column and then continues.', x: 72, y: 686, size: 11 },
      { text: 'A separate block much lower on', x: 72, y: 500, size: 11 },
    ]);
    expect(model.paragraphs.map((p) => p.lines)).toEqual([[0], [1, 2], [3]]);
  });

  it('keeps rotated text on its own line', () => {
    const model = pageOf([
      { text: 'horizontal', x: 72, y: 700 },
      { text: 'sideways', x: 300, y: 700, angle: Math.PI / 2 },
    ]);
    expect(model.lines).toHaveLength(2);
    expect(model.text).toContain('horizontal');
    expect(model.text).toContain('sideways');
  });

  it('falls back to the run rectangle when the engine gives no character boxes', () => {
    const bare = { ...run({ text: 'abc', x: 10, y: 20 }, 0), chars: [] };
    const model = buildPageText(0, [bare]);
    expect(model.chars).toHaveLength(4); // three letters plus the line break
    expect(model.chars[0]?.rect).toEqual(bare.rect);
  });
});

describe('hit testing', () => {
  const model = pageOf(TWO_LINES);

  it('returns null for a page with no text', () => {
    expect(offsetAt(emptyPageText(0), { x: 1, y: 1 })).toBeNull();
  });

  it('lands on the character under the point', () => {
    const box = model.chars[4]?.rect;
    expect(box).toBeDefined();
    const at = offsetAt(model, {
      x: (box?.x0 ?? 0) + 0.1,
      y: ((box?.y0 ?? 0) + (box?.y1 ?? 0)) / 2,
    });
    expect(at).toBe(4);
  });

  it('selects the gap after a character when the point is past its middle', () => {
    const box = model.chars[4]?.rect;
    const at = offsetAt(model, {
      x: (box?.x1 ?? 0) - 0.1,
      y: ((box?.y0 ?? 0) + (box?.y1 ?? 0)) / 2,
    });
    expect(at).toBe(5);
  });

  it('finds the line a point is on, and the one an offset is in', () => {
    const second = must(model.lines[1], 'second line');
    const point = { x: 200, y: (second.rect.y0 + second.rect.y1) / 2 };
    expect(lineAtPoint(model, point)?.index).toBe(1);
    expect(lineAt(model, second.start)?.index).toBe(1);
    expect(paragraphAt(model, second.start)).not.toBeNull();
  });

  it('a click in the left margin lands on that line, not the one above', () => {
    const second = must(model.lines[1], 'second line');
    const at = offsetAt(model, { x: 0, y: (second.rect.y0 + second.rect.y1) / 2 });
    expect(at).toBe(second.start);
  });
});

describe('word and paragraph selection', () => {
  const model = pageOf(TWO_LINES);

  it('a double click takes the whole word', () => {
    const at = model.text.indexOf('quick') + 2;
    expect(spanText(model, wordAt(model, at))).toBe('quick');
  });

  it('a click just after a word still takes that word', () => {
    const at = model.text.indexOf('quick') + 'quick'.length;
    expect(spanText(model, wordAt(model, at))).toBe('quick');
  });

  /*
   * A click just after a word and a click on the space that follows it produce the *same*
   * insertion offset — `offsetAt` cannot tell them apart, because they are the same place. The
   * word wins, which is what a reader double-clicking near the end of a word wants. A space with
   * no word before it selects itself.
   */
  it('a space with a word before it selects that word', () => {
    const at = model.text.indexOf(' ');
    expect(spanText(model, wordAt(model, at))).toBe('The');
  });

  it('a space with no word before it selects itself', () => {
    const spaced = pageOf([{ text: '  x', x: 0, y: 0, advance: 4 }]);
    expect(spanText(spaced, wordAt(spaced, 1))).toBe(' ');
  });

  it('a triple click takes the paragraph', () => {
    const span = paragraphSpanAt(model, 3);
    expect(spanText(model, span)).toBe('The quick brown fox\njumps over the dog');
  });

  it('the whole page is a span too', () => {
    expect(spanText(model, wholePageSpan(model))).toBe(model.text);
  });
});

describe('selection rectangles', () => {
  const model = pageOf(TWO_LINES);

  it('gives one rectangle per line', () => {
    const rects = spanRects(model, { start: 0, end: model.text.length });
    expect(rects).toHaveLength(2);
    const first = must(rects[0], 'rectangle');
    expect(first.x1).toBeGreaterThan(first.x0);
  });

  it('merges the characters of one line into one rectangle', () => {
    const rects = spanRects(model, { start: 4, end: 9 });
    expect(rects).toHaveLength(1);
    const only = must(rects[0], 'rectangle');
    expect(only.x0).toBeCloseTo(must(model.chars[4], 'char').rect.x0, 5);
    expect(only.x1).toBeCloseTo(must(model.chars[8], 'char').rect.x1, 5);
  });

  it('gives a line break a visible sliver so a wrapped selection reads as wrapped', () => {
    const line = must(model.lines[0], 'line');
    const rects = spanRects(model, { start: line.end, end: line.end + 1 });
    expect(rects).toHaveLength(1);
    const only = must(rects[0], 'rectangle');
    expect(only.x1).toBeGreaterThan(only.x0);
  });
});

describe('column selection', () => {
  it('takes only the characters inside the marquee, one span per line', () => {
    const model = pageOf([
      { text: 'AAAA BBBB', x: 0, y: 100, advance: 10 },
      { text: 'CCCC DDDD', x: 0, y: 80, advance: 10 },
    ]);
    // The first four characters of each line are 0..40.
    const spans = columnSpans(model, { x0: -1, y0: 70, x1: 39, y1: 120 });
    expect(spans).toHaveLength(2);
    expect(spanText(model, must(spans[0], 'span'))).toBe('AAAA');
    expect(spanText(model, must(spans[1], 'span'))).toBe('CCCC');
  });

  it('normalises a marquee dragged the other way', () => {
    const model = pageOf([{ text: 'ABCD', x: 0, y: 100, advance: 10 }]);
    const spans = columnSpans(model, { x0: 39, y0: 120, x1: -1, y1: 70 });
    expect(spanText(model, must(spans[0], 'span'))).toBe('ABCD');
  });
});

describe('run ranges', () => {
  const model = pageOf(TWO_LINES);

  it('converts a span to a run range and back', () => {
    const span = { start: 4, end: 9 };
    const range = must(spanToRange(model, span), 'range');
    expect(range.page).toBe(0);
    expect(rangeToSpan(model, range)).toEqual(span);
  });

  it('ignores the synthetic separators at the edges of a span', () => {
    const line = must(model.lines[0], 'line');
    const range = spanToRange(model, { start: line.end, end: line.end + 1 });
    expect(range).toBeNull();
  });

  it('spans that touch are merged', () => {
    expect(
      mergeSpans([
        { start: 5, end: 10 },
        { start: 0, end: 5 },
        { start: 20, end: 25 },
        { start: 3, end: 3 },
      ]),
    ).toEqual([
      { start: 0, end: 10 },
      { start: 20, end: 25 },
    ]);
  });
});

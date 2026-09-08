/**
 * `TextLayer` — turns the engine's `textRuns(page)` into the model everything textual works
 * from (M13): a flat, reading-order string with one box per character, grouped into lines and
 * paragraphs.
 *
 * It lives in `view/` rather than in M13's folder because it is shared: M13 selects, searches
 * and copies from it, M51 will reflow from the same line/paragraph grouping, M54 replaces
 * inside it and M111 reads it aloud. It is **pure** — no DOM, no engine, no async — so all of it
 * is unit-tested in Node.
 *
 * Invariants worth relying on:
 * - `chars.length === text.length`. A character outside the BMP is two UTF-16 units and gets the
 *   *same* box twice, so a string offset is always a valid index into `chars` and no caller has
 *   to think about surrogates.
 * - Offsets are into `text`. `CharBox.run` / `CharBox.offsetInRun` map back to the engine's
 *   `TextRun.chars` (which is indexed by **code point**), which is what `core/Selection`'s
 *   `TextRange` is expressed in.
 * - Line and paragraph separators are real characters in `text` (`\n`), with a zero-width box
 *   parked at the end of the line they close, so a selection that runs over a line break has
 *   somewhere to draw and `text.slice(a, b)` is already the text to copy.
 *
 * Reading order is the content stream's order sorted into lines: runs are bucketed by their
 * angle, then by position *across* the writing direction (down the page for horizontal text),
 * then *along* it. That handles rotated text without a special case, because "down" and "along"
 * are just the two components of the run's own direction vector.
 */

import type { TextRun } from '@engine/PdfEngine';
import type { PageIndex, PdfPoint, PdfRect } from '@shared/pdf';

/** One character's box. `synthetic` marks the separators this module inserts. */
export interface CharBox {
  readonly rect: PdfRect;
  /** Index into `PageText.runs`. */
  readonly run: number;
  /** Code-point index inside that run — the same indexing as `TextRun.chars`. */
  readonly offsetInRun: number;
  /** True for the `\n` separators, which are not in the file. */
  readonly synthetic: boolean;
}

/** A line of text: a maximal group of runs sharing an angle and a baseline. */
export interface TextLine {
  readonly index: number;
  /** Offsets into `PageText.text`; `end` is exclusive and excludes the separator. */
  readonly start: number;
  readonly end: number;
  readonly rect: PdfRect;
  /** Rotation of the line in radians, counter-clockwise; 0 for horizontal text. */
  readonly angle: number;
  /** Typical font size on the line, in points. */
  readonly fontSize: number;
}

/** A paragraph: consecutive lines that read as one block. */
export interface TextParagraph {
  readonly index: number;
  readonly start: number;
  readonly end: number;
  readonly rect: PdfRect;
  /** Indexes into `PageText.lines`. */
  readonly lines: ReadonlyArray<number>;
}

/** Everything textual about one page. */
export interface PageText {
  readonly page: PageIndex;
  readonly runs: ReadonlyArray<TextRun>;
  /** Reading-order text. Every line ends with `\n`, including the last. */
  readonly text: string;
  /** One entry per UTF-16 unit of `text`. */
  readonly chars: ReadonlyArray<CharBox>;
  readonly lines: ReadonlyArray<TextLine>;
  readonly paragraphs: ReadonlyArray<TextParagraph>;
}

/** A half-open span of `PageText.text`. */
export interface Span {
  readonly start: number;
  readonly end: number;
}

const EMPTY_RECT: PdfRect = { x0: 0, y0: 0, x1: 0, y1: 0 };

/** Angle bucket width: 15°, which is coarse enough to keep a slightly skewed line together. */
const ANGLE_BUCKET = Math.PI / 12;

/** The empty model, for pages the engine has not been asked about yet. */
export function emptyPageText(page: PageIndex): PageText {
  return { page, runs: [], text: '', chars: [], lines: [], paragraphs: [] };
}

// ---- building -------------------------------------------------------------------------------

interface Placed {
  readonly run: TextRun;
  readonly index: number;
  readonly angle: number;
  readonly bucket: number;
  /** Position along the writing direction, and across it (increasing = further down the page). */
  readonly along: number;
  readonly across: number;
  readonly fontSize: number;
}

function angleOf(run: TextRun): number {
  if (typeof run.angle === 'number' && Number.isFinite(run.angle)) return run.angle;
  const [a, b] = run.matrix;
  if (a === 0 && b === 0) return 0;
  return Math.atan2(b, a);
}

/**
 * Projects a run's origin onto its own writing direction. `across` is negated so that "larger
 * across" means "further down the page" for every angle — PDF y grows upwards.
 */
function place(run: TextRun, index: number): Placed {
  const angle = angleOf(run);
  const bucket = Math.round(angle / ANGLE_BUCKET);
  const quantised = bucket * ANGLE_BUCKET;
  const cos = Math.cos(quantised);
  const sin = Math.sin(quantised);
  const { x, y } = run.origin;
  return {
    run,
    index,
    angle: quantised,
    bucket,
    along: x * cos + y * sin,
    across: -(-x * sin + y * cos),
    fontSize: run.fontSize > 0 ? run.fontSize : 1,
  };
}

function unionRect(a: PdfRect, b: PdfRect): PdfRect {
  return {
    x0: Math.min(a.x0, b.x0),
    y0: Math.min(a.y0, b.y0),
    x1: Math.max(a.x1, b.x1),
    y1: Math.max(a.y1, b.y1),
  };
}

/** The zero-width box a separator gets: the trailing edge of the box before it. */
function collapseToEnd(rect: PdfRect): PdfRect {
  return { x0: rect.x1, y0: rect.y0, x1: rect.x1, y1: rect.y1 };
}

/**
 * Builds the page model. `runs` is the engine's list, in content-stream order; nothing is
 * assumed about that order beyond it being stable.
 */
export function buildPageText(page: PageIndex, runs: ReadonlyArray<TextRun>): PageText {
  const placed = runs.map((run, index) => place(run, index)).filter((p) => p.run.text.length > 0);

  // Lines: same angle bucket, and baselines within half a font size of each other.
  placed.sort(
    (a, b) => a.bucket - b.bucket || a.across - b.across || a.along - b.along || a.index - b.index,
  );
  const groups: Placed[][] = [];
  for (const p of placed) {
    const current = groups[groups.length - 1];
    const last = current?.[current.length - 1];
    const tolerance = Math.min(p.fontSize, last?.fontSize ?? p.fontSize) * 0.5;
    if (current && last?.bucket === p.bucket && Math.abs(p.across - last.across) <= tolerance) {
      current.push(p);
    } else {
      groups.push([p]);
    }
  }
  for (const group of groups) group.sort((a, b) => a.along - b.along || a.index - b.index);

  const chars: CharBox[] = [];
  const lines: TextLine[] = [];
  let text = '';

  groups.forEach((group, lineIndex) => {
    const start = text.length;
    let rect: PdfRect | null = null;
    let previousEnd: number | null = null;
    let previousSize = group[0]?.fontSize ?? 1;

    for (const p of group) {
      const run = p.run;
      const codePoints = Array.from(run.text);
      // A space where the file only implies one: a gap wider than a fifth of an em between two
      // runs on the same line is a word break, not kerning.
      const gap = previousEnd === null ? 0 : p.along - previousEnd;
      if (
        previousEnd !== null &&
        gap > previousSize * 0.2 &&
        !/\s$/.test(text) &&
        !/^\s/.test(run.text)
      ) {
        const lastRect = chars[chars.length - 1]?.rect ?? run.rect;
        chars.push({
          rect: collapseToEnd(lastRect),
          run: p.index,
          offsetInRun: 0,
          synthetic: true,
        });
        text += ' ';
      }
      codePoints.forEach((cp, cpIndex) => {
        const box = run.chars[cpIndex] ?? run.rect;
        rect = rect ? unionRect(rect, box) : box;
        for (const _unit of cp.split('')) {
          chars.push({ rect: box, run: p.index, offsetInRun: cpIndex, synthetic: false });
        }
        text += cp;
      });
      previousEnd = p.along + advanceOf(run);
      previousSize = p.fontSize;
    }

    const end = text.length;
    lines.push({
      index: lineIndex,
      start,
      end,
      rect: rect ?? EMPTY_RECT,
      angle: group[0]?.angle ?? 0,
      fontSize: group[0]?.fontSize ?? 0,
    });
    // Every line ends with a separator, including the last: it makes `text.slice()` of a whole
    // line come back with its break, which is what a copy of it should contain.
    const lastRect = chars[chars.length - 1]?.rect ?? EMPTY_RECT;
    const owner = group[group.length - 1]?.index ?? 0;
    chars.push({ rect: collapseToEnd(lastRect), run: owner, offsetInRun: 0, synthetic: true });
    text += '\n';
  });

  const paragraphs = groupParagraphs(lines);
  return { page, runs, text, chars, lines, paragraphs };
}

/** How far a run advances along its baseline, from its own bounding box. */
function advanceOf(run: TextRun): number {
  const w = run.rect.x1 - run.rect.x0;
  const h = run.rect.y1 - run.rect.y0;
  const angle = angleOf(run);
  // For a rotated run the box is axis-aligned, so project its diagonal onto the direction.
  return Math.abs(w * Math.cos(angle)) + Math.abs(h * Math.sin(angle));
}

/**
 * Paragraph grouping. Two consecutive lines continue the same paragraph when they are close
 * enough vertically to be consecutive lines of one block (no blank line between them) and the
 * later one does not start a new block by indenting or by following a short line.
 */
function groupParagraphs(lines: ReadonlyArray<TextLine>): TextParagraph[] {
  const out: TextParagraph[] = [];
  let current: number[] = [];

  const flush = (): void => {
    if (current.length === 0) return;
    const first = lines[current[0] ?? 0];
    const last = lines[current[current.length - 1] ?? 0];
    if (!first || !last) {
      current = [];
      return;
    }
    let rect = first.rect;
    for (const i of current) {
      const line = lines[i];
      if (line) rect = unionRect(rect, line.rect);
    }
    out.push({ index: out.length, start: first.start, end: last.end, rect, lines: [...current] });
    current = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const previous = i > 0 ? lines[i - 1] : undefined;
    if (previous && !continuesParagraph(previous, line, lines)) flush();
    current.push(i);
  }
  flush();
  return out;
}

function continuesParagraph(
  previous: TextLine,
  line: TextLine,
  lines: ReadonlyArray<TextLine>,
): boolean {
  if (previous.angle !== line.angle) return false;
  const size = Math.max(previous.fontSize, line.fontSize, 1);
  // Vertical distance between baselines, measured on the boxes (which is all we have).
  const gap = distanceBetween(previous, line);
  if (gap > size * 2.2) return false;
  // A line that is much shorter than the block's width ends its paragraph, unless it is the
  // block's first line (a heading followed by its body is two paragraphs anyway).
  const width = Math.max(...lines.map((l) => l.rect.x1 - l.rect.x0), 1);
  const previousWidth = previous.rect.x1 - previous.rect.x0;
  if (previousWidth < width * 0.55) return false;
  // An indent of more than an em starts a new paragraph.
  const indent = Math.abs(line.rect.x0 - previous.rect.x0);
  if (indent > size * 1.2) return false;
  // A size change is a change of block.
  return Math.abs(previous.fontSize - line.fontSize) <= Math.max(0.5, size * 0.15);
}

function distanceBetween(a: TextLine, b: TextLine): number {
  const cos = Math.cos(a.angle);
  const sin = Math.sin(a.angle);
  const project = (line: TextLine): number => {
    const cx = (line.rect.x0 + line.rect.x1) / 2;
    const cy = (line.rect.y0 + line.rect.y1) / 2;
    return -(-cx * sin + cy * cos);
  };
  return Math.abs(project(b) - project(a));
}

// ---- hit testing ----------------------------------------------------------------------------

/** Squared distance from a point to a rectangle (0 inside it). */
function distanceToRect(point: PdfPoint, rect: PdfRect): number {
  const dx = Math.max(rect.x0 - point.x, 0, point.x - rect.x1);
  const dy = Math.max(rect.y0 - point.y, 0, point.y - rect.y1);
  return dx * dx + dy * dy;
}

/**
 * The character offset nearest `point`. Returns an *insertion* offset: a point past the middle
 * of a character selects the gap after it, which is what a caret does. `null` for a page with no
 * text at all.
 */
export function offsetAt(pageText: PageText, point: PdfPoint): number | null {
  if (pageText.chars.length === 0) return null;
  // Prefer the line whose band contains the point, so a click in the left margin lands on the
  // start of that line rather than on the nearest glyph diagonally above it.
  const line = lineAtPoint(pageText, point);
  const range: ReadonlyArray<number> = line
    ? rangeIndexes(line.start, line.end)
    : rangeIndexes(0, pageText.chars.length);
  let best = range[0] ?? 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const i of range) {
    const box = pageText.chars[i];
    if (!box || box.synthetic) continue;
    const d = distanceToRect(point, box.rect);
    if (d < bestDistance) {
      bestDistance = d;
      best = i;
    }
  }
  const box = pageText.chars[best];
  if (!box) return best;
  const mid = (box.rect.x0 + box.rect.x1) / 2;
  return point.x > mid ? best + 1 : best;
}

function rangeIndexes(start: number, end: number): number[] {
  const out: number[] = [];
  for (let i = start; i < end; i++) out.push(i);
  return out;
}

/** The line whose vertical band contains `point`, if any. */
export function lineAtPoint(pageText: PageText, point: PdfPoint): TextLine | null {
  let best: TextLine | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const line of pageText.lines) {
    if (point.y >= line.rect.y0 && point.y <= line.rect.y1) {
      const d = distanceToRect(point, line.rect);
      if (d < bestDistance) {
        bestDistance = d;
        best = line;
      }
    }
  }
  return best;
}

/** The line containing an offset. */
export function lineAt(pageText: PageText, offset: number): TextLine | null {
  for (const line of pageText.lines) {
    if (offset >= line.start && offset <= line.end) return line;
  }
  return pageText.lines[pageText.lines.length - 1] ?? null;
}

export function paragraphAt(pageText: PageText, offset: number): TextParagraph | null {
  for (const p of pageText.paragraphs) {
    if (offset >= p.start && offset <= p.end) return p;
  }
  return pageText.paragraphs[pageText.paragraphs.length - 1] ?? null;
}

const WORD_RE = /[\p{L}\p{N}_'’-]/u;

/** The word around an offset — what a double click selects. */
export function wordAt(pageText: PageText, offset: number): Span {
  const text = pageText.text;
  if (text.length === 0) return { start: 0, end: 0 };
  let at = Math.min(Math.max(offset, 0), text.length - 1);
  if (!WORD_RE.test(text[at] ?? '') && at > 0 && WORD_RE.test(text[at - 1] ?? '')) at -= 1;
  if (!WORD_RE.test(text[at] ?? '')) return { start: at, end: at + 1 };
  let start = at;
  let end = at + 1;
  while (start > 0 && WORD_RE.test(text[start - 1] ?? '')) start--;
  while (end < text.length && WORD_RE.test(text[end] ?? '')) end++;
  return { start, end };
}

/** The paragraph around an offset — what a triple click selects. */
export function paragraphSpanAt(pageText: PageText, offset: number): Span {
  const paragraph = paragraphAt(pageText, offset);
  if (!paragraph) return { start: 0, end: pageText.text.length };
  return { start: paragraph.start, end: paragraph.end };
}

/** The whole page. */
export function wholePageSpan(pageText: PageText): Span {
  return { start: 0, end: pageText.text.length };
}

// ---- rectangles -----------------------------------------------------------------------------

/**
 * The rectangles that draw a span: one per line, merged from the character boxes so a selection
 * is a few rectangles rather than one per glyph. Zero-width separators are grown to a thin
 * sliver so a selection that ends in a line break still shows the break as selected.
 */
export function spanRects(pageText: PageText, span: Span): PdfRect[] {
  const out: PdfRect[] = [];
  const start = Math.max(0, Math.min(span.start, span.end));
  const end = Math.min(pageText.chars.length, Math.max(span.start, span.end));
  let current: PdfRect | null = null;
  let currentLine = -1;
  for (let i = start; i < end; i++) {
    const box = pageText.chars[i];
    if (!box) continue;
    const line = lineIndexOf(pageText, i);
    let rect = box.rect;
    if (box.synthetic) {
      const height = pageText.lines[line]?.fontSize ?? rect.y1 - rect.y0;
      rect = { ...rect, x1: rect.x1 + Math.max(2, height * 0.25) };
    }
    if (current && line === currentLine) {
      current = unionRect(current, rect);
    } else {
      if (current) out.push(current);
      current = rect;
      currentLine = line;
    }
  }
  if (current) out.push(current);
  return out.filter((r) => r.x1 > r.x0 && r.y1 >= r.y0);
}

function lineIndexOf(pageText: PageText, offset: number): number {
  for (const line of pageText.lines) {
    if (offset >= line.start && offset <= line.end) return line.index;
  }
  return -1;
}

// ---- column (block) selection ----------------------------------------------------------------

/**
 * Alt-drag: every character whose box falls inside `rect`, as one span per line. This is what
 * lets a column of a table be copied without the columns beside it.
 */
export function columnSpans(pageText: PageText, rect: PdfRect): Span[] {
  const box: PdfRect = {
    x0: Math.min(rect.x0, rect.x1),
    y0: Math.min(rect.y0, rect.y1),
    x1: Math.max(rect.x0, rect.x1),
    y1: Math.max(rect.y0, rect.y1),
  };
  const spans: Span[] = [];
  for (const line of pageText.lines) {
    let start: number | null = null;
    let end = 0;
    for (let i = line.start; i < line.end; i++) {
      const c = pageText.chars[i];
      if (!c || c.synthetic) continue;
      const centreX = (c.rect.x0 + c.rect.x1) / 2;
      const centreY = (c.rect.y0 + c.rect.y1) / 2;
      const inside =
        centreX >= box.x0 && centreX <= box.x1 && centreY >= box.y0 && centreY <= box.y1;
      if (inside) {
        start ??= i;
        end = i + 1;
      }
    }
    if (start !== null) spans.push({ start, end });
  }
  return spans;
}

// ---- `TextRange` conversion --------------------------------------------------------------------

/** `core/Selection`'s range shape, re-declared here so this module stays dependency-free. */
export interface RunRange {
  readonly page: PageIndex;
  readonly startRun: number;
  readonly startChar: number;
  readonly endRun: number;
  readonly endChar: number;
}

/** A span as the run/character range `core/Selection` stores. */
export function spanToRange(pageText: PageText, span: Span): RunRange | null {
  const start = Math.max(0, Math.min(span.start, span.end));
  const end = Math.min(pageText.chars.length, Math.max(span.start, span.end));
  if (end <= start) return null;
  const first = firstReal(pageText, start, end);
  const last = lastReal(pageText, start, end);
  if (first === null || last === null) return null;
  const a = pageText.chars[first];
  const b = pageText.chars[last];
  if (!a || !b) return null;
  return {
    page: pageText.page,
    startRun: a.run,
    startChar: a.offsetInRun,
    endRun: b.run,
    endChar: b.offsetInRun + 1,
  };
}

function firstReal(pageText: PageText, start: number, end: number): number | null {
  for (let i = start; i < end; i++) if (!pageText.chars[i]?.synthetic) return i;
  return null;
}

function lastReal(pageText: PageText, start: number, end: number): number | null {
  for (let i = end - 1; i >= start; i--) if (!pageText.chars[i]?.synthetic) return i;
  return null;
}

/** The span a run/character range covers. Inverse of {@link spanToRange}. */
export function rangeToSpan(pageText: PageText, range: RunRange): Span | null {
  let start: number | null = null;
  let end: number | null = null;
  for (let i = 0; i < pageText.chars.length; i++) {
    const c = pageText.chars[i];
    if (!c || c.synthetic) continue;
    const afterStart =
      c.run > range.startRun || (c.run === range.startRun && c.offsetInRun >= range.startChar);
    const beforeEnd =
      c.run < range.endRun || (c.run === range.endRun && c.offsetInRun < range.endChar);
    if (afterStart && beforeEnd) {
      start ??= i;
      end = i + 1;
    }
  }
  return start === null || end === null ? null : { start, end };
}

/** Text of a span, with the synthetic separators included (they are what a copy wants). */
export function spanText(pageText: PageText, span: Span): string {
  const start = Math.max(0, Math.min(span.start, span.end));
  const end = Math.min(pageText.text.length, Math.max(span.start, span.end));
  return pageText.text.slice(start, end);
}

/** Merges overlapping or touching spans and sorts them. */
export function mergeSpans(spans: ReadonlyArray<Span>): Span[] {
  const sorted = [...spans]
    .map((s) => ({ start: Math.min(s.start, s.end), end: Math.max(s.start, s.end) }))
    .filter((s) => s.end > s.start)
    .sort((a, b) => a.start - b.start);
  const out: Span[] = [];
  for (const span of sorted) {
    const last = out[out.length - 1];
    if (last && span.start <= last.end) {
      out[out.length - 1] = { start: last.start, end: Math.max(last.end, span.end) };
    } else {
      out.push(span);
    }
  }
  return out;
}

/**
 * Text spans → `/QuadPoints` (M30). Pure, and the acceptance test's target: a highlight drawn
 * across a line break on a rotated page has to produce the quads the words actually occupy.
 *
 * The rule is one quad per **run of characters on one line**, built in that line's own axes
 * rather than as the axis-aligned box containing it. M13's `TextLine.angle` is where the axes
 * come from, and it is already the direction of the run's own text matrix — so text rotated
 * inside a page and a page rotated by `/Rotate` are the same case, not two.
 *
 * Why it matters: over 90°-rotated text, the box containing a line is a tall thin column. Marking
 * it as a rectangle would highlight everything beside the words as well; marking the quad marks
 * the words.
 */

import type { PdfPoint, PdfRect } from '@shared/pdf';
import type { PageText, Span } from '@view/TextLayer';
import { type Quad } from '@engine/appearance';

/** Two unit vectors: along the writing direction, and up across it. */
interface Axes {
  readonly along: PdfPoint;
  readonly up: PdfPoint;
}

function axesFor(angle: number): Axes {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return { along: { x: cos, y: sin }, up: { x: -sin, y: cos } };
}

function dot(p: PdfPoint, v: PdfPoint): number {
  return p.x * v.x + p.y * v.y;
}

/**
 * The half-width and half-height of the *unrotated* glyph box behind an axis-aligned one.
 *
 * The engine reports each character as an axis-aligned rectangle, which for rotated text is the
 * box that contains the glyph rather than the glyph's own box — at 30° that is half as large
 * again. The two are related exactly, though: a `w × h` rectangle at angle θ has an axis-aligned
 * box of `(w·|cos| + h·|sin|) × (w·|sin| + h·|cos|)`, so `w` and `h` come back by solving the
 * pair. The system is singular at 45°, where the two axes contribute equally and nothing can be
 * recovered; there the box itself is used, which is the only honest answer available.
 */
function unrotate(box: PdfRect, angle: number): { readonly along: number; readonly up: number } {
  const width = box.x1 - box.x0;
  const height = box.y1 - box.y0;
  const c = Math.abs(Math.cos(angle));
  const s = Math.abs(Math.sin(angle));
  const determinant = c * c - s * s;
  if (Math.abs(determinant) < 1e-3) return { along: width / 2, up: height / 2 };
  const w = (width * c - height * s) / determinant;
  const h = (height * c - width * s) / determinant;
  return { along: Math.max(0, w) / 2, up: Math.max(0, h) / 2 };
}

function centreOf(r: PdfRect): PdfPoint {
  return { x: (r.x0 + r.x1) / 2, y: (r.y0 + r.y1) / 2 };
}

/**
 * One quad from a group of character boxes sharing a line.
 *
 * Each box is turned back into the glyph box it was before the page rotated it, then projected on
 * to the line's two axes; the quad is the extreme of those projections, mapped back. For
 * horizontal text that is exactly the bounding rectangle, and for rotated text it is the rotated
 * rectangle the glyphs sit in rather than the larger box that contains it.
 */
function quadFromBoxes(boxes: ReadonlyArray<PdfRect>, angle: number): Quad | null {
  const { along, up } = axesFor(angle);
  let minA = Infinity;
  let maxA = -Infinity;
  let minU = Infinity;
  let maxU = -Infinity;
  let any = false;
  for (const box of boxes) {
    const centre = centreOf(box);
    const half = unrotate(box, angle);
    const a = dot(centre, along);
    const u = dot(centre, up);
    minA = Math.min(minA, a - half.along);
    maxA = Math.max(maxA, a + half.along);
    minU = Math.min(minU, u - half.up);
    maxU = Math.max(maxU, u + half.up);
    any = true;
  }
  if (!any || maxA - minA <= 0 || maxU - minU <= 0) return null;
  const at = (a: number, u: number): PdfPoint => ({
    x: along.x * a + up.x * u,
    y: along.y * a + up.y * u,
  });
  // PDF 12.5.6.10's order: upper-left, upper-right, lower-left, lower-right — "upper" being
  // further along the line's own up axis, not further up the page.
  return {
    ul: at(minA, maxU),
    ur: at(maxA, maxU),
    ll: at(minA, minU),
    lr: at(maxA, minU),
  };
}

/**
 * The quads of one span of a page's text: one per line the span crosses, in reading order.
 *
 * Characters the model invented — the `\n` line separators — are skipped: a quad around a
 * zero-width separator would mark a sliver of paper past the end of the line, which is what a
 * selection wants to draw but not what a highlight should write into the file.
 */
export function quadsForSpan(pageText: PageText, span: Span): Quad[] {
  const start = Math.max(0, Math.min(span.start, span.end));
  const end = Math.min(pageText.chars.length, Math.max(span.start, span.end));
  const out: Quad[] = [];
  let group: PdfRect[] = [];
  let groupLine = -1;
  const flush = (): void => {
    if (group.length === 0) return;
    const line = pageText.lines[groupLine];
    const quad = quadFromBoxes(group, line?.angle ?? 0);
    if (quad) out.push(quad);
    group = [];
  };
  for (let i = start; i < end; i++) {
    const box = pageText.chars[i];
    if (!box || box.synthetic) continue;
    const line = lineIndexOf(pageText, i);
    if (line !== groupLine) {
      flush();
      groupLine = line;
    }
    group.push(box.rect);
  }
  flush();
  return out;
}

/** Every quad of several spans on one page. */
export function quadsForSpans(pageText: PageText, spans: ReadonlyArray<Span>): Quad[] {
  return spans.flatMap((span) => quadsForSpan(pageText, span));
}

function lineIndexOf(pageText: PageText, offset: number): number {
  for (const line of pageText.lines) {
    if (offset >= line.start && offset <= line.end) return line.index;
  }
  return -1;
}

/**
 * The insertion point for a caret at a text offset: the foot of the character there, on the side
 * the reader clicked. Used by Insert Text and by Replace Text, which both mark a position rather
 * than a range.
 */
export function caretPointAt(
  pageText: PageText,
  offset: number,
  side: 'before' | 'after' = 'before',
): { readonly point: PdfPoint; readonly lineHeight: number } | null {
  const index = Math.max(0, Math.min(offset, pageText.chars.length - 1));
  const box = pageText.chars[index];
  if (!box) return null;
  const line = pageText.lines[lineIndexOf(pageText, index)];
  const angle = line?.angle ?? 0;
  const { along, up } = axesFor(angle);
  const height = Math.max(line?.fontSize ?? box.rect.y1 - box.rect.y0, 1);
  // Along the line, the leading or trailing edge of the glyph; across it, the baseline. Measured
  // from the glyph's own box, recovered from the axis-aligned one exactly as a quad's is.
  const centre = centreOf(box.rect);
  const half = unrotate(box.rect, angle);
  const a = dot(centre, along) + (side === 'before' ? -half.along : half.along);
  const u = dot(centre, up) - half.up;
  return {
    point: { x: along.x * a + up.x * u, y: along.y * a + up.y * u },
    lineHeight: height,
  };
}

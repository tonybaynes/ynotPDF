/**
 * Text-markup appearances that honour the quad, not its bounding box (M30).
 *
 * M21's generators take each group of eight `/QuadPoints` numbers and draw the axis-aligned
 * rectangle that contains it. That is right for horizontal text and wrong for anything else: over
 * a line of rotated text the box that contains the quad is far larger than the quad, so a
 * highlight covers the lines above and below and an underline runs diagonally through the words.
 *
 * These draw the quad itself — a parallelogram with its own two axes — so rotated text, a page
 * with `/Rotate`, and a slightly skewed scan all mark exactly the glyphs the reader selected.
 *
 * Also here: the `Caret` that marks an insertion point, and the pair of annotations that "replace
 * text" means in a PDF (a strike-out over the words plus a caret carrying the replacement).
 */

import type { PdfPoint, PdfRect } from '@shared/pdf';
import { ContentBuilder } from './content';
import { normaliseRect, type AppearanceGenerator, type AppearanceInput } from './types';

/** The four corners of one quad, in the order the PDF stores them. */
export interface Quad {
  /** Upper-left, upper-right, lower-left, lower-right — PDF 12.5.6.10's order. */
  readonly ul: PdfPoint;
  readonly ur: PdfPoint;
  readonly ll: PdfPoint;
  readonly lr: PdfPoint;
}

/** Every group of eight numbers as a quad. Incomplete trailing numbers are ignored. */
export function quads(quadPoints: ReadonlyArray<number>): Quad[] {
  const out: Quad[] = [];
  for (let i = 0; i + 7 < quadPoints.length; i += 8) {
    const n = quadPoints.slice(i, i + 8);
    if (n.some((v) => typeof v !== 'number' || !Number.isFinite(v))) continue;
    out.push({
      ul: { x: n[0] ?? 0, y: n[1] ?? 0 },
      ur: { x: n[2] ?? 0, y: n[3] ?? 0 },
      ll: { x: n[4] ?? 0, y: n[5] ?? 0 },
      lr: { x: n[6] ?? 0, y: n[7] ?? 0 },
    });
  }
  return out;
}

/** The eight numbers a quad is stored as. */
export function quadNumbers(q: Quad): number[] {
  return [q.ul.x, q.ul.y, q.ur.x, q.ur.y, q.ll.x, q.ll.y, q.lr.x, q.lr.y];
}

/** A quad from an axis-aligned rectangle — the horizontal-text case. */
export function quadFromRect(r: PdfRect): Quad {
  const n = normaliseRect(r);
  return {
    ul: { x: n.x0, y: n.y1 },
    ur: { x: n.x1, y: n.y1 },
    ll: { x: n.x0, y: n.y0 },
    lr: { x: n.x1, y: n.y0 },
  };
}

/** The smallest rectangle containing every quad — what `/Rect` has to be. */
export function quadsBounds(list: ReadonlyArray<Quad>): PdfRect | null {
  const points = list.flatMap((q) => [q.ul, q.ur, q.ll, q.lr]);
  const first = points[0];
  if (!first) return null;
  let box: PdfRect = { x0: first.x, y0: first.y, x1: first.x, y1: first.y };
  for (const p of points) {
    box = {
      x0: Math.min(box.x0, p.x),
      y0: Math.min(box.y0, p.y),
      x1: Math.max(box.x1, p.x),
      y1: Math.max(box.y1, p.y),
    };
  }
  return box;
}

/** The quads of an input, falling back to its rect so a markup annotation always draws. */
function inputQuads(input: AppearanceInput): Quad[] {
  const list = quads(input.quadPoints);
  return list.length > 0 ? list : [quadFromRect(input.rect)];
}

/** Point `t` of the way from `a` to `b`. */
function lerp(a: PdfPoint, b: PdfPoint, t: number): PdfPoint {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

/** The height of a quad measured across the text, which is what every rule width scales with. */
function quadHeight(q: Quad): number {
  return Math.max(Math.hypot(q.ul.x - q.ll.x, q.ul.y - q.ll.y), 1e-6);
}

/**
 * A rule across a quad at `t` of its height (0 = baseline edge, 1 = top edge), drawn along the
 * quad's own direction so rotated text gets a rotated rule.
 */
function rule(q: Quad, t: number): [PdfPoint, PdfPoint] {
  return [lerp(q.ll, q.ul, t), lerp(q.lr, q.ur, t)];
}

const DEFAULT_MARKUP_COLOR = 0xffff00;

/**
 * `/CA` as a graphics state, when the file has one.
 *
 * The app never writes `/CA` for its own annotations — solid colours only, CLAUDE.md — but a
 * translucent highlight that arrived from another editor is rendered as it was made, which is
 * what the brief asks for. `blendMode` is separate because a highlight needs Multiply whether or
 * not it is translucent.
 */
function applyOpacity(b: ContentBuilder, input: AppearanceInput, blendMode?: string): void {
  const alpha = input.opacity;
  const opaque = alpha === null || alpha >= 1;
  if (opaque && blendMode === undefined) return;
  b.graphicsState({
    ...(opaque ? {} : { fillAlpha: alpha, strokeAlpha: alpha }),
    ...(blendMode === undefined ? {} : { blendMode }),
  });
}

/** `/Highlight`: the quads filled in Multiply, so the words underneath still read. */
export const highlightAppearance: AppearanceGenerator = (input) => {
  const list = inputQuads(input);
  const b = new ContentBuilder();
  b.save();
  // `Multiply` is what keeps a fully opaque paint readable: it darkens the paper and leaves the
  // ink. The app never writes `/CA`, so this is the only reason a highlight is not a solid block.
  applyOpacity(b, input, 'Multiply');
  b.fillColor(input.color ?? DEFAULT_MARKUP_COLOR);
  for (const q of list) {
    b.polyline([q.ul, q.ur, q.lr, q.ll]).closePath();
  }
  b.fill();
  b.restore();
  return finish(input, b, list);
};

/** `/Underline`: a rule along the bottom sixteenth of each quad. */
export const underlineAppearance: AppearanceGenerator = (input) =>
  ruleAppearance(input, 1 / 16, 1 / 14);

/** `/StrikeOut`: the same rule through the middle. */
export const strikeOutAppearance: AppearanceGenerator = (input) =>
  ruleAppearance(input, 0.5, 1 / 14);

function ruleAppearance(
  input: AppearanceInput,
  at: number,
  thickness: number,
): ReturnType<AppearanceGenerator> {
  const list = inputQuads(input);
  const b = new ContentBuilder();
  b.save();
  applyOpacity(b, input);
  b.strokeColor(input.color ?? 0x000000).lineCap(0);
  for (const q of list) {
    const h = quadHeight(q);
    b.lineWidth(Math.max(0.5, h * thickness));
    const [from, to] = rule(q, at);
    b.moveTo(from.x, from.y).lineTo(to.x, to.y).stroke();
  }
  b.restore();
  return finish(input, b, list);
}

/** `/Squiggly`: a zigzag along the foot of each quad, in the quad's own direction. */
export const squigglyAppearance: AppearanceGenerator = (input) => {
  const list = inputQuads(input);
  const b = new ContentBuilder();
  b.save();
  applyOpacity(b, input);
  b.strokeColor(input.color ?? 0x000000)
    .lineCap(1)
    .lineJoin(1);
  for (const q of list) {
    const h = quadHeight(q);
    const amplitude = Math.max(1, h / 8);
    b.lineWidth(Math.max(0.5, amplitude / 3));
    const [from, to] = rule(q, amplitude / h);
    const [upFrom, upTo] = rule(q, (amplitude * 2) / h);
    const length = Math.hypot(to.x - from.x, to.y - from.y);
    if (length < 1e-6) continue;
    const step = (amplitude * 1.5) / length;
    b.moveTo(from.x, from.y);
    let up = true;
    for (let t = step; t < 1; t += step) {
      const p = up ? lerp(upFrom, upTo, t) : lerp(from, to, t);
      b.lineTo(p.x, p.y);
      up = !up;
    }
    b.stroke();
  }
  b.restore();
  return finish(input, b, list);
};

/**
 * `/Caret` — the insertion mark. `/RD` says how much of `/Rect` is padding around the symbol, so
 * the caret is drawn inside what is left, as the spec has it.
 */
export const caretAppearance: AppearanceGenerator = (input) => {
  const rect = normaliseRect(input.rect);
  const rd = paddingOf(input.extra);
  const box: PdfRect = {
    x0: rect.x0 + rd[0],
    y0: rect.y0 + rd[3],
    x1: rect.x1 - rd[2],
    y1: rect.y1 - rd[1],
  };
  const inner = box.x1 > box.x0 && box.y1 > box.y0 ? box : rect;
  if (inner.x1 <= inner.x0 || inner.y1 <= inner.y0) return null;
  const b = new ContentBuilder();
  b.save();
  applyOpacity(b, input);
  b.fillColor(input.color ?? 0x000000);
  // A proofreader's caret: two strokes rising to a point, hollowed by a notch at the foot.
  const w = inner.x1 - inner.x0;
  const h = inner.y1 - inner.y0;
  const at = (fx: number, fy: number): [number, number] => [inner.x0 + fx * w, inner.y0 + fy * h];
  b.moveTo(...at(0, 0));
  b.lineTo(...at(0.5, 1));
  b.lineTo(...at(1, 0));
  b.lineTo(...at(0.72, 0));
  b.lineTo(...at(0.5, 0.42));
  b.lineTo(...at(0.28, 0));
  b.closePath().fill();
  b.restore();
  if (b.isEmpty) return null;
  return {
    bbox: { x0: rect.x0 - 0.5, y0: rect.y0 - 0.5, x1: rect.x1 + 0.5, y1: rect.y1 + 0.5 },
    content: b.build(),
    resources: b.resources,
  };
};

function paddingOf(extra: Readonly<Record<string, unknown>>): [number, number, number, number] {
  const value = extra['padding'];
  if (!Array.isArray(value) || value.length < 4) return [0, 0, 0, 0];
  const n = value.map((v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0));
  return [n[0] ?? 0, n[1] ?? 0, n[2] ?? 0, n[3] ?? 0];
}

/** The BBox: everything the quads reach, grown by half a rule so nothing is clipped. */
function finish(
  input: AppearanceInput,
  b: ContentBuilder,
  list: ReadonlyArray<Quad>,
): ReturnType<AppearanceGenerator> {
  if (b.isEmpty) return null;
  const bounds = quadsBounds(list) ?? normaliseRect(input.rect);
  const pad = 1;
  return {
    bbox: {
      x0: Math.min(bounds.x0, input.rect.x0) - pad,
      y0: Math.min(bounds.y0, input.rect.y0) - pad,
      x1: Math.max(bounds.x1, input.rect.x1) + pad,
      y1: Math.max(bounds.y1, input.rect.y1) + pad,
    },
    content: b.build(),
    resources: b.resources,
  };
}

/** The caret's nominal size beside a line of text, in points. */
export const CARET_SIZE = 8;

/** A caret rect at an insertion point on a line whose height is `lineHeight`. */
export function caretRectAt(at: PdfPoint, lineHeight: number): PdfRect {
  const h = Math.max(4, Math.min(CARET_SIZE, lineHeight * 0.6));
  const w = h * 0.9;
  return { x0: at.x - w / 2, y0: at.y, x1: at.x + w / 2, y1: at.y + h };
}

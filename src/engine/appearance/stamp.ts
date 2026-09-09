/**
 * Stamps (M31): the catalogue's drawings, dynamic tokens, and the appearance that places one.
 *
 * A stamp is a **Form XObject embedded once per document** (ADR 0015). What this file makes is
 * two things:
 *
 * 1. The XObject itself — `stampForm()`: a rounded box with bold text in one colour, drawn from a
 *    catalogue definition in its own box `[0 0 w h]`, deterministically, so ten placements of
 *    "APPROVED" share one object and `scripts/make-stamps.ts` writes the same picture to
 *    `resources/stamps/<id>.pdf`.
 * 2. The annotation's `/AP` — `stampAppearance`: `q <matrix> cm /Fm1 Do Q`, where the matrix
 *    fits the stamp's natural box into `/Rect` at the annotation's rotation. A custom stamp from
 *    an image or a PDF page is the same stream over a different XObject; only its size differs.
 *
 * Dynamic tokens — `{name}`, `{initials}`, `{date}`, `{time}` — are resolved when the stamp is
 * placed, and the resolved text is what gets drawn.
 */

import type { PdfMatrix, PdfPoint, PdfRect } from '@shared/pdf';
import { ContentBuilder, type PathOp } from './content';
import { textWidth } from './metrics';
import { arcOps, opsBounds, type ShapeDrawing } from './shapes';
import type { AppearanceGenerator, AppearanceStream, StandardFontName } from './types';

// ---- the catalogue -------------------------------------------------------------------------------

/** One stamp as `resources/stamps/catalogue.json` describes it. */
export interface StampDefinition {
  /** Stable id; also the annotation's `/Name`. The PDF-standard names are used where they exist. */
  readonly id: string;
  readonly label: string;
  readonly category: string;
  /** Lines of text; the first is the big one. May carry dynamic tokens. */
  readonly lines: ReadonlyArray<string>;
  /** `0xRRGGBB`, the border and the text. */
  readonly color: number;
}

export interface StampCategory {
  readonly id: string;
  readonly label: string;
}

export interface StampCatalogue {
  readonly categories: ReadonlyArray<StampCategory>;
  readonly stamps: ReadonlyArray<StampDefinition>;
}

/** Reads the catalogue's JSON shape, dropping anything malformed rather than throwing. */
export function parseStampCatalogue(raw: unknown): StampCatalogue {
  const root = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const categories: StampCategory[] = [];
  if (Array.isArray(root['categories'])) {
    for (const c of root['categories']) {
      if (!c || typeof c !== 'object') continue;
      const r = c as Record<string, unknown>;
      if (typeof r['id'] === 'string' && typeof r['label'] === 'string') {
        categories.push({ id: r['id'], label: r['label'] });
      }
    }
  }
  const stamps: StampDefinition[] = [];
  if (Array.isArray(root['stamps'])) {
    for (const s of root['stamps']) {
      if (!s || typeof s !== 'object') continue;
      const r = s as Record<string, unknown>;
      const lines = Array.isArray(r['lines'])
        ? r['lines'].filter((l): l is string => typeof l === 'string')
        : [];
      if (typeof r['id'] !== 'string' || typeof r['label'] !== 'string' || lines.length === 0) {
        continue;
      }
      const color = typeof r['color'] === 'string' ? Number.parseInt(r['color'], 16) : Number.NaN;
      stamps.push({
        id: r['id'],
        label: r['label'],
        category: typeof r['category'] === 'string' ? r['category'] : 'business',
        lines,
        color: Number.isFinite(color) ? color & 0xffffff : 0x000000,
      });
    }
  }
  return { categories, stamps };
}

// ---- dynamic tokens ------------------------------------------------------------------------------

/** What the tokens resolve to. */
export interface StampTokenContext {
  readonly name: string;
  readonly initials: string;
  readonly now: Date;
}

export const STAMP_TOKENS = ['{name}', '{initials}', '{date}', '{time}'] as const;

/** `{name}`, `{initials}`, `{date}` and `{time}`, in en-GB, as the brief and PLAN §9 want. */
export function resolveStampTokens(line: string, context: StampTokenContext): string {
  const date = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium' }).format(context.now);
  const time = new Intl.DateTimeFormat('en-GB', { timeStyle: 'short' }).format(context.now);
  return line
    .replaceAll('{name}', context.name === '' ? 'Unnamed' : context.name)
    .replaceAll('{initials}', context.initials === '' ? '—' : context.initials)
    .replaceAll('{date}', date)
    .replaceAll('{time}', time);
}

/** Whether a definition carries any token, which is what makes it "dynamic". */
export function isDynamicStamp(definition: StampDefinition): boolean {
  return definition.lines.some((line) => STAMP_TOKENS.some((t) => line.includes(t)));
}

// ---- the drawing ---------------------------------------------------------------------------------

/** One line of text as the drawing places it, baseline at `(x, y)`, size in points. */
export interface StampText {
  readonly text: string;
  readonly x: number;
  readonly y: number;
  readonly size: number;
  readonly font: StandardFontName;
  readonly color: number;
}

/** A stamp's picture in its own box `[0 0 width height]`. */
export interface StampDrawing {
  readonly width: number;
  readonly height: number;
  readonly drawings: ReadonlyArray<ShapeDrawing>;
  readonly texts: ReadonlyArray<StampText>;
}

export const STAMP_FONT: StandardFontName = 'Helvetica-Bold';
const BIG = 26;
const SMALL = 10;
const PAD_X = 14;
const PAD_Y = 8;
const BORDER = 2.5;
const CORNER = 7;
const GAP = 4;

/** A rounded rectangle, anticlockwise from the bottom edge. */
export function roundedRectOps(r: PdfRect, radius: number): PathOp[] {
  const rad = Math.max(0, Math.min(radius, (r.x1 - r.x0) / 2, (r.y1 - r.y0) / 2));
  if (rad <= 0) {
    return [
      { op: 'M', x: r.x0, y: r.y0 },
      { op: 'L', x: r.x1, y: r.y0 },
      { op: 'L', x: r.x1, y: r.y1 },
      { op: 'L', x: r.x0, y: r.y1 },
      { op: 'Z' },
    ];
  }
  const ops: PathOp[] = [{ op: 'M', x: r.x0 + rad, y: r.y0 }];
  ops.push({ op: 'L', x: r.x1 - rad, y: r.y0 });
  ops.push(...arcOps({ x: r.x1 - rad, y: r.y0 + rad }, rad, -Math.PI / 2, 0, true));
  ops.push({ op: 'L', x: r.x1, y: r.y1 - rad });
  ops.push(...arcOps({ x: r.x1 - rad, y: r.y1 - rad }, rad, 0, Math.PI / 2, true));
  ops.push({ op: 'L', x: r.x0 + rad, y: r.y1 });
  ops.push(...arcOps({ x: r.x0 + rad, y: r.y1 - rad }, rad, Math.PI / 2, Math.PI, true));
  ops.push({ op: 'L', x: r.x0, y: r.y0 + rad });
  ops.push(...arcOps({ x: r.x0 + rad, y: r.y0 + rad }, rad, Math.PI, Math.PI * 1.5, true));
  ops.push({ op: 'Z' });
  return ops;
}

/**
 * The Foxit-style business stamp: a rounded box and bold, centred, upper-case text in one
 * colour, sized to its longest line. The first line is the big one; any others are small and
 * sit under it — which is what a dynamic stamp's "by whom, when" line is.
 */
export function stampDrawing(lines: ReadonlyArray<string>, color: number): StampDrawing {
  const texts = lines.map((line, i) => ({
    text: i === 0 ? line.toUpperCase() : line,
    size: i === 0 ? BIG : SMALL,
  }));
  const widest = Math.max(1, ...texts.map((t) => textWidth(t.text, STAMP_FONT, t.size)));
  const textHeight = texts.reduce((sum, t, i) => sum + t.size + (i > 0 ? GAP : 0), 0);
  const width = Math.ceil(widest + PAD_X * 2 + BORDER * 2);
  const height = Math.ceil(textHeight + PAD_Y * 2 + BORDER * 2);
  const box: PdfRect = {
    x0: BORDER / 2,
    y0: BORDER / 2,
    x1: width - BORDER / 2,
    y1: height - BORDER / 2,
  };
  const placed: StampText[] = [];
  // Lay the lines out from the top: the big line's cap height sits under the top padding.
  let top = height - BORDER - PAD_Y;
  texts.forEach((t) => {
    const w = textWidth(t.text, STAMP_FONT, t.size);
    // Baseline: the ascent of Helvetica-Bold is about 0.72 em; the descent leaves room below.
    const baseline = top - t.size * 0.78;
    placed.push({
      text: t.text,
      x: (width - w) / 2,
      y: baseline,
      size: t.size,
      font: STAMP_FONT,
      color,
    });
    top = baseline - t.size * 0.22 - GAP;
  });
  return {
    width,
    height,
    drawings: [{ ops: roundedRectOps(box, CORNER), stroke: color, fill: null, width: BORDER }],
    texts: placed,
  };
}

/** The drawing's form XObject: the shared object every placement refers to. */
export function stampForm(drawing: StampDrawing): AppearanceStream {
  const b = new ContentBuilder();
  for (const d of drawing.drawings) {
    b.save();
    if (d.stroke !== null) b.strokeColor(d.stroke).lineWidth(d.width).lineJoin(1);
    if (d.fill !== null) b.fillColor(d.fill);
    b.path(d.ops);
    if (d.stroke !== null && d.fill !== null) b.fillAndStroke();
    else if (d.fill !== null) b.fill();
    else b.stroke();
    b.restore();
  }
  for (const t of drawing.texts) {
    b.save();
    b.fillColor(t.color);
    b.text(t.text, { font: t.font, size: t.size, x: t.x, y: t.y });
    b.restore();
  }
  return {
    bbox: { x0: 0, y0: 0, x1: drawing.width, y1: drawing.height },
    content: b.build(),
    resources: b.resources,
  };
}

/** A stable key for a drawing: the same lines and colour share one embedded object. */
export function stampKey(id: string, lines: ReadonlyArray<string>, color: number): string {
  let hash = 5381;
  for (const ch of `${lines.join('\n')}|${color}`)
    hash = ((hash << 5) + hash + ch.charCodeAt(0)) | 0;
  return `stamp:${id}:${(hash >>> 0).toString(16)}`;
}

// ---- placing one ---------------------------------------------------------------------------------

/**
 * The matrix that fits a picture of natural size `size` into `rect`, turned by `rotate` degrees
 * anticlockwise about the rect's centre. Aspect is kept: the picture is scaled so its turned
 * bounding box fills the rect in one direction and is centred in the other.
 */
export function stampMatrix(
  rect: PdfRect,
  size: { readonly width: number; readonly height: number },
  rotate: number,
): PdfMatrix {
  const theta = (rotate * Math.PI) / 180;
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  const w = Math.max(1e-6, size.width);
  const h = Math.max(1e-6, size.height);
  const boxW = w * Math.abs(c) + h * Math.abs(s);
  const boxH = w * Math.abs(s) + h * Math.abs(c);
  const scale = Math.max(1e-6, Math.min((rect.x1 - rect.x0) / boxW, (rect.y1 - rect.y0) / boxH));
  const cx = (rect.x0 + rect.x1) / 2;
  const cy = (rect.y0 + rect.y1) / 2;
  // translate(cx, cy) · rotate(theta) · scale(s) · translate(-w/2, -h/2)
  const a = scale * c;
  const b = scale * s;
  const cc = -scale * s;
  const d = scale * c;
  const e = cx - (a * w) / 2 - (cc * h) / 2;
  const f = cy - (b * w) / 2 - (d * h) / 2;
  return [a, b, cc, d, e, f];
}

/** Applies a matrix to a point. */
export function applyMatrix(m: PdfMatrix, p: PdfPoint): PdfPoint {
  return { x: m[0] * p.x + m[2] * p.y + m[4], y: m[1] * p.x + m[3] * p.y + m[5] };
}

/** Applies a matrix to every point of a path. */
export function transformOps(ops: ReadonlyArray<PathOp>, m: PdfMatrix): PathOp[] {
  return ops.map((op) => {
    if (op.op === 'Z') return op;
    const p = applyMatrix(m, { x: op.x, y: op.y });
    if (op.op === 'C') {
      const c1 = applyMatrix(m, { x: op.x1, y: op.y1 });
      const c2 = applyMatrix(m, { x: op.x2, y: op.y2 });
      return { op: 'C', x1: c1.x, y1: c1.y, x2: c2.x, y2: c2.y, x: p.x, y: p.y };
    }
    return { op: op.op, x: p.x, y: p.y };
  });
}

/** The uniform scale a matrix applies (its column length). */
export function matrixScale(m: PdfMatrix): number {
  return Math.hypot(m[0], m[1]);
}

/** The rect a stamp of natural `size` occupies when its centre and scale are given. */
export function stampRectAt(
  center: PdfPoint,
  size: { readonly width: number; readonly height: number },
  scale: number,
  rotate: number,
): PdfRect {
  const theta = (rotate * Math.PI) / 180;
  const w = size.width * scale;
  const h = size.height * scale;
  const boxW = w * Math.abs(Math.cos(theta)) + h * Math.abs(Math.sin(theta));
  const boxH = w * Math.abs(Math.sin(theta)) + h * Math.abs(Math.cos(theta));
  return {
    x0: center.x - boxW / 2,
    y0: center.y - boxH / 2,
    x1: center.x + boxW / 2,
    y1: center.y + boxH / 2,
  };
}

/** The keys a stamp annotation keeps in `extra`. */
export const STAMP_KEY = 'stampKey';
export const STAMP_SIZE = 'stampSize';

/** The natural size of a stamp from `extra.stampSize`, or null. */
export function stampSizeOf(
  extra: Readonly<Record<string, unknown>>,
): { width: number; height: number } | null {
  const raw = extra[STAMP_SIZE];
  if (!Array.isArray(raw) || raw.length !== 2) return null;
  const w: unknown = raw[0];
  const h: unknown = raw[1];
  if (typeof w !== 'number' || typeof h !== 'number' || !(w > 0) || !(h > 0)) return null;
  return { width: w, height: h };
}

/** The stamp's rotation from `extra.rotate`, degrees anticlockwise. */
export function stampRotationOf(extra: Readonly<Record<string, unknown>>): number {
  const raw = extra['rotate'];
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : 0;
}

/**
 * `/Stamp`: the shared XObject named by `extra.stampKey`, fitted into `/Rect`. An annotation
 * without a key — one from another producer, or a custom stamp reopened from a file — draws
 * nothing, so the writer keeps whatever appearance the file already had.
 */
export const stampAppearance: AppearanceGenerator = (input) => {
  const key = input.extra[STAMP_KEY];
  const size = stampSizeOf(input.extra);
  if (typeof key !== 'string' || key === '' || !size) return null;
  if (input.rect.x1 <= input.rect.x0 || input.rect.y1 <= input.rect.y0) return null;
  const b = new ContentBuilder();
  if (input.opacity !== null && input.opacity < 1) {
    b.graphicsState({ fillAlpha: input.opacity, strokeAlpha: input.opacity });
  }
  b.drawXObject(key, stampMatrix(input.rect, size, stampRotationOf(input.extra)));
  return { bbox: input.rect, content: b.build(), resources: b.resources };
};

/** The bounds of a drawing's paths and text, for a preview that has no box of its own. */
export function drawingBounds(drawing: StampDrawing): PdfRect {
  const all = drawing.drawings.flatMap((d) => [...d.ops]);
  return opsBounds(all) ?? { x0: 0, y0: 0, x1: drawing.width, y1: drawing.height };
}

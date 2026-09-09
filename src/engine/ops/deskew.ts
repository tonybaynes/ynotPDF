/**
 * Deskew — straighten scanned pages (M41).
 *
 * The operator's files are mostly scans, and a scan is almost never square on the glass. A
 * degree and a half is invisible until you try to read a column of figures, and it is what makes
 * OCR guess. Straightening is therefore two separate jobs, and they are separate here:
 *
 * **Detecting** the angle — {@link detectSkew} — is pure over pixels. Render the page grey,
 * shrink it, decide what counts as ink, and then keep only the *coordinates* of the ink. For
 * every candidate angle, project those coordinates onto the vertical axis
 * (`y' = y·cosθ + x·sinθ`), bucket them into one-pixel rows and score the profile by the sum of
 * the squares of the bucket counts. When the page is straight, every line of text lands in a few
 * rows and the score peaks sharply; when it is not, the lines smear across many rows and the
 * score falls. That is Postl's projection-profile variance method, and it is textbook — nothing
 * here was learned from any product.
 *
 * Working from the ink coordinates rather than from the image is what makes it fast enough to
 * offer on a whole document: a page of text is a few per cent ink, so each candidate angle costs
 * a few tens of thousands of additions instead of half a million. A coarse sweep of ±15° at 0.5°
 * followed by a fine sweep at 0.02° gets to a tenth of a degree in about eighty passes.
 *
 * **Applying** it — {@link deskewPages} — is pure over bytes and rotates nothing but a matrix.
 * The page's existing content streams are left exactly as they are; two small streams go round
 * them, one holding `q  cosθ sinθ −sinθ cosθ tx ty  cm` and one holding `Q`. An image XObject is
 * never decoded, so it comes out byte-identical, and an OCR text layer rotates with the words it
 * sits on because both are in the same content. Annotations move too: their `/Rect` becomes the
 * bounding box of its rotated corners and their `/QuadPoints` are rotated point by point, so a
 * highlight stays on its word.
 *
 * The corners the rotation exposes are filled by a page-sized rectangle painted *underneath*
 * everything, in the page's own background colour rather than always white — a scan of cream
 * paper with white wedges looks worse than it did crooked.
 */

import type { PDFRef } from 'pdf-lib';
import { PDFArray, PDFDict, PDFName, PDFNumber, type PDFContext } from 'pdf-lib';
import type { PdfRect } from '@shared/pdf';
import { effectiveBox, loadPdf, pageLeaves, savePdf, writeBoxes } from './pdfdoc';
import { OpFailed, checkCancelled, type OpContext, type OpResult, type Raster } from './types';

// ---- detection ---------------------------------------------------------------------------------

export interface DetectOptions {
  /** Widest skew considered, degrees. Default 15 — beyond that it is a rotated page, not a skew. */
  readonly maxAngle?: number;
  /** Long edge of the image the detector works on, in pixels. Default 700. */
  readonly workingSize?: number;
  /** Minimum fraction of the page that must be ink before an answer is offered. Default 0.004. */
  readonly minInk?: number;
  /** Maximum fraction; above this the page is a photograph, not text. Default 0.6. */
  readonly maxInk?: number;
}

/** How much the detector trusts its answer, in words — never a bare number, never a colour. */
export type SkewConfidence = 'clear' | 'uncertain' | 'none';

export interface SkewEstimate {
  /**
   * Clockwise degrees the page is *rotated by*, so straightening means rotating by `-angle`.
   * Zero when there is nothing to measure.
   */
  readonly angle: number;
  readonly confidence: SkewConfidence;
  /** A sentence for the reader, e.g. "not enough content to tell". */
  readonly reason: string;
  /** Fraction of the working image that was ink. */
  readonly ink: number;
}

const DEFAULTS = {
  maxAngle: 15,
  workingSize: 700,
  minInk: 0.004,
  maxInk: 0.6,
};

/** The words for a confidence, for a table cell or a status line. */
export const CONFIDENCE_WORDS: Readonly<Record<SkewConfidence, string>> = {
  clear: 'Clear',
  uncertain: 'Uncertain',
  none: 'Skipped',
};

export function detectSkew(raster: Raster, options: DetectOptions = {}): SkewEstimate {
  const opts = { ...DEFAULTS, ...options };
  const binary = binarise(raster, opts.workingSize);
  if (!binary) {
    return { angle: 0, confidence: 'none', reason: 'the page could not be read', ink: 0 };
  }
  const { xs, ys, width, height, ink } = binary;
  if (ink < opts.minInk) {
    return {
      angle: 0,
      confidence: 'none',
      reason: 'not enough content to tell',
      ink,
    };
  }
  if (ink > opts.maxInk) {
    return {
      angle: 0,
      confidence: 'none',
      reason: 'the page is a picture rather than lines of text',
      ink,
    };
  }

  const score = (degrees: number): number => projectionScore(xs, ys, width, height, degrees);
  const coarse = sweep(score, -opts.maxAngle, opts.maxAngle, 0.5);
  const fine = sweep(score, coarse.angle - 0.6, coarse.angle + 0.6, 0.02);
  const flat = score(fine.angle) / Math.max(1e-9, coarse.mean);
  // The sweep finds the angle that *straightens* the page; the reader is told how far the page
  // leans, which is the other one.
  const skew = -fine.angle;

  // A straight page's peak stands well clear of the sweep's own average; a page of pictures, or
  // one with three words on it, produces a profile that barely moves and must not be trusted.
  const confidence: SkewConfidence = flat >= 1.5 ? 'clear' : flat >= 1.15 ? 'uncertain' : 'none';
  const reason =
    confidence === 'clear'
      ? 'lines of text line up'
      : confidence === 'uncertain'
        ? 'the lines are faint or few, so check the preview'
        : 'no clear lines of text to measure against';
  return {
    // A skew of exactly zero is the common case for a page that was never crooked; rounding to
    // hundredths stops the table showing "0.004°" and inviting a pointless rewrite.
    angle: confidence === 'none' ? 0 : Math.round(skew * 100) / 100,
    confidence,
    reason,
    ink,
  };
}

/** Best angle in `[from, to]` at `step`, and the mean score over the sweep. */
function sweep(
  score: (degrees: number) => number,
  from: number,
  to: number,
  step: number,
): { angle: number; best: number; mean: number } {
  let angle = 0;
  let best = -Infinity;
  let total = 0;
  let count = 0;
  for (let a = from; a <= to + 1e-9; a += step) {
    const value = score(a);
    total += value;
    count++;
    if (value > best) {
      best = value;
      angle = a;
    }
  }
  return { angle, best, mean: count > 0 ? total / count : 0 };
}

/**
 * The projection-profile score at one angle: how concentrated the ink is once rotated back.
 *
 * Squaring the bucket counts is what turns "the ink is spread over n rows" into a number that
 * peaks when it is spread over as few as possible. It is the same quantity as the variance of
 * the profile, up to a constant that does not depend on the angle.
 */
function projectionScore(
  xs: Int32Array,
  ys: Int32Array,
  width: number,
  height: number,
  degrees: number,
): number {
  const radians = (degrees * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  // Enough rows for the rotated page's full height, with the origin shifted so nothing is negative.
  const span = Math.ceil(Math.abs(height * cos) + Math.abs(width * sin)) + 2;
  const offset = Math.ceil(Math.abs(width * sin)) + 1;
  const buckets = new Int32Array(span + offset);
  for (let i = 0; i < xs.length; i++) {
    const row = Math.round((ys[i] ?? 0) * cos + (xs[i] ?? 0) * sin) + offset;
    if (row >= 0 && row < buckets.length) buckets[row] = (buckets[row] ?? 0) + 1;
  }
  let sum = 0;
  for (const n of buckets) sum += n * n;
  // Divided by the row count so sweeps at different angles, which have different spans, compare.
  return sum / buckets.length;
}

interface Binarised {
  readonly xs: Int32Array;
  readonly ys: Int32Array;
  readonly width: number;
  readonly height: number;
  readonly ink: number;
}

/**
 * Downsamples to `longEdge`, thresholds with Otsu's method and keeps the dark pixels' positions.
 *
 * Otsu rather than a fixed level because a scan's "white" is rarely 255 and its "black" is rarely
 * 0; a fixed threshold turns a grey scan either into a solid block or into nothing.
 */
export function binarise(raster: Raster, longEdge: number): Binarised | null {
  const { data, width, height } = raster;
  if (width <= 1 || height <= 1 || data.length < width * height * 4) return null;
  const scale = Math.min(1, longEdge / Math.max(width, height));
  const w = Math.max(2, Math.round(width * scale));
  const h = Math.max(2, Math.round(height * scale));

  // Box-average down: sampling every nth pixel would drop thin strokes entirely and with them
  // the very lines the profile is measuring.
  const grey = new Uint8Array(w * h);
  const histogram = new Int32Array(256);
  const stepX = width / w;
  const stepY = height / h;
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor(y * stepY);
    const y1 = Math.max(y0 + 1, Math.floor((y + 1) * stepY));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x * stepX);
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * stepX));
      let total = 0;
      let n = 0;
      for (let sy = y0; sy < y1 && sy < height; sy++) {
        for (let sx = x0; sx < x1 && sx < width; sx++) {
          const at = (sy * width + sx) * 4;
          // Rec. 601 luma: the weights a scanner's own greyscale uses.
          total +=
            0.299 * (data[at] ?? 255) +
            0.587 * (data[at + 1] ?? 255) +
            0.114 * (data[at + 2] ?? 255);
          n++;
        }
      }
      const value = n > 0 ? Math.round(total / n) : 255;
      grey[y * w + x] = value;
      histogram[value] = (histogram[value] ?? 0) + 1;
    }
  }

  const threshold = otsu(histogram, w * h);
  const xs: number[] = [];
  const ys: number[] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if ((grey[y * w + x] ?? 255) <= threshold) {
        xs.push(x - w / 2);
        ys.push(y - h / 2);
      }
    }
  }
  return {
    xs: Int32Array.from(xs),
    ys: Int32Array.from(ys),
    width: w,
    height: h,
    ink: xs.length / (w * h),
  };
}

/** Otsu's threshold: the level that best separates the histogram into two classes. */
export function otsu(histogram: Int32Array, total: number): number {
  if (total <= 0) return 128;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * (histogram[i] ?? 0);
  let sumBackground = 0;
  let weightBackground = 0;
  let best = 0;
  let threshold = 128;
  for (let i = 0; i < 256; i++) {
    weightBackground += histogram[i] ?? 0;
    if (weightBackground === 0) continue;
    const weightForeground = total - weightBackground;
    if (weightForeground === 0) break;
    sumBackground += i * (histogram[i] ?? 0);
    const meanBackground = sumBackground / weightBackground;
    const meanForeground = (sum - sumBackground) / weightForeground;
    const between = weightBackground * weightForeground * (meanBackground - meanForeground) ** 2;
    if (between > best) {
      best = between;
      threshold = i;
    }
  }
  return threshold;
}

// ---- applying ----------------------------------------------------------------------------------

/** `0xRRGGBB`, or `'white'`, or `null` to leave the exposed corners transparent. */
export type DeskewBackground = number | 'white' | null;

export interface DeskewOptions {
  /**
   * Clockwise degrees each page is rotated *by*, keyed by 0-based page index. Straightening a
   * page skewed by +2.3° means passing `{ 0: 2.3 }`; the content is turned by −2.3°.
   */
  readonly angles: Readonly<Record<number, number>>;
  /** Colour painted behind the content to fill the exposed corners. Default white. */
  readonly background?: DeskewBackground;
  /** Shrink the CropBox by the width of the exposed wedges. Default false. */
  readonly trimEdges?: boolean;
}

export interface DeskewResult extends OpResult {
  /** Pages that were actually turned, with the angle used. */
  readonly applied: ReadonlyArray<{ readonly page: number; readonly angle: number }>;
}

/** Below this the turn is not worth a rewrite: a hundredth of a degree moves nothing visible. */
export const MIN_ANGLE = 0.01;

export async function deskewPages(
  bytes: Uint8Array,
  options: DeskewOptions,
  ctx: OpContext = {},
): Promise<DeskewResult> {
  const doc = await loadPdf(bytes, 'The document');
  const leaves = pageLeaves(doc);
  if (leaves.length === 0) throw new OpFailed('The document has no pages to straighten');
  const entries = Object.entries(options.angles)
    .map(([page, angle]) => ({ page: Number(page), angle }))
    .filter(
      (e) =>
        Number.isInteger(e.page) &&
        e.page >= 0 &&
        e.page < leaves.length &&
        Number.isFinite(e.angle) &&
        Math.abs(e.angle) >= MIN_ANGLE,
    )
    .sort((a, b) => a.page - b.page);
  const warnings: string[] = [];
  const applied: Array<{ page: number; angle: number }> = [];

  for (const [i, entry] of entries.entries()) {
    checkCancelled(ctx.signal);
    ctx.progress?.(i / entries.length, `Straightening page ${String(entry.page + 1)}`);
    const leaf = leaves[entry.page]?.leaf;
    if (!leaf) continue;
    const crop = effectiveBox(leaf, 'crop');
    const media = effectiveBox(leaf, 'media');
    const matrix = rotationAbout(-entry.angle, centreOf(crop));

    const ctxObj = doc.context;
    const before: string[] = [];
    const background = paintBackground(options.background ?? 'white', media);
    if (background) before.push(background);
    before.push(
      `q ${num(matrix[0])} ${num(matrix[1])} ${num(matrix[2])} ${num(matrix[3])} ${num(matrix[4])} ${num(matrix[5])} cm`,
    );
    wrapContent(ctxObj, leaf, before.join('\n'), 'Q');

    for (const annot of annotationsOf(ctxObj, leaf)) rotateAnnotation(ctxObj, annot, matrix);

    if (options.trimEdges === true) {
      const inset = wedgeInset(crop, entry.angle);
      writeBoxes(leaf, {
        crop: {
          x0: crop.x0 + inset.x,
          y0: crop.y0 + inset.y,
          x1: crop.x1 - inset.x,
          y1: crop.y1 - inset.y,
        },
      });
    }
    applied.push(entry);
  }

  if (applied.length === 0) {
    warnings.push('None of those pages needed straightening');
  }
  ctx.progress?.(1, 'Done');
  return {
    bytes: await savePdf(doc),
    pageCount: leaves.length,
    warnings,
    applied,
  };
}

/** The matrix that turns content clockwise by `degrees` about `centre`. */
export function rotationAbout(
  degrees: number,
  centre: { readonly x: number; readonly y: number },
): [number, number, number, number, number, number] {
  // PDF's y axis points up, so a *clockwise* turn on the page is a negative angle in user space.
  const radians = (-degrees * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return [
    cos,
    sin,
    -sin,
    cos,
    centre.x - centre.x * cos + centre.y * sin,
    centre.y - centre.x * sin - centre.y * cos,
  ];
}

export function centreOf(rect: PdfRect): { x: number; y: number } {
  return { x: (rect.x0 + rect.x1) / 2, y: (rect.y0 + rect.y1) / 2 };
}

/** Applies a matrix to a point. */
export function applyMatrix(
  m: readonly [number, number, number, number, number, number],
  x: number,
  y: number,
): { x: number; y: number } {
  return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] };
}

/**
 * How far in from each edge the exposed wedge reaches, for "trim edges".
 *
 * A rectangle `w × h` turned by θ leaves a triangular wedge along each edge; the deepest point of
 * the wedge on the vertical edges is `(h/2)·|sin θ|` and on the horizontal edges `(w/2)·|sin θ|`.
 * Trimming by that much is the smallest cut that removes every wedge.
 */
export function wedgeInset(rect: PdfRect, degrees: number): { x: number; y: number } {
  const s = Math.abs(Math.sin((degrees * Math.PI) / 180));
  return { x: ((rect.y1 - rect.y0) / 2) * s, y: ((rect.x1 - rect.x0) / 2) * s };
}

/** A filled rectangle covering the whole page, or `''` when the caller asked for none. */
function paintBackground(colour: DeskewBackground, media: PdfRect): string {
  if (colour === null) return '';
  const [r, g, b] =
    colour === 'white'
      ? [1, 1, 1]
      : [((colour >> 16) & 0xff) / 255, ((colour >> 8) & 0xff) / 255, (colour & 0xff) / 255];
  const w = media.x1 - media.x0;
  const h = media.y1 - media.y0;
  return `q ${num(r)} ${num(g)} ${num(b)} rg ${num(media.x0)} ${num(media.y0)} ${num(w)} ${num(h)} re f Q`;
}

/**
 * Puts `before` in front of a page's content and `after` behind it, as separate streams.
 *
 * Separate streams matter: the page's own content is neither decoded nor re-encoded, so an image
 * XObject it references comes through untouched and a content stream we cannot parse cannot be
 * corrupted by us. A `/Contents` that is already an array is extended; a single stream becomes
 * one.
 */
function wrapContent(
  ctx: PDFContext,
  leaf: { get(key: PDFName): unknown; set(key: PDFName, value: unknown): void },
  before: string,
  after: string,
): void {
  const key = PDFName.of('Contents');
  const existing = leaf.get(key);
  const head = ctx.register(ctx.flateStream(`${before}\n`));
  const tail = ctx.register(ctx.flateStream(`\n${after}\n`));
  const asArray = ctx.lookupMaybe(existing as never, PDFArray);
  const middle: unknown[] = [];
  if (asArray) {
    for (let i = 0; i < asArray.size(); i++) middle.push(asArray.get(i));
  } else if (existing !== undefined) {
    middle.push(existing);
  }
  leaf.set(key, ctx.obj([head, ...middle, tail] as never));
}

/** The annotation dictionaries of a page. */
function annotationsOf(ctx: PDFContext, leaf: { get(key: PDFName): unknown }): PDFDict[] {
  const array = ctx.lookupMaybe(leaf.get(PDFName.of('Annots')) as never, PDFArray);
  if (!array) return [];
  const out: PDFDict[] = [];
  for (let i = 0; i < array.size(); i++) {
    const dict = ctx.lookupMaybe(array.get(i), PDFDict);
    if (dict) out.push(dict);
  }
  return out;
}

/**
 * Moves one annotation with the page.
 *
 * `/Rect` is axis-aligned by definition, so it becomes the bounding box of its four rotated
 * corners — a highlight on a line of text ends up very slightly larger, which is right: the box
 * has to contain the turned mark. `/QuadPoints`, `/Vertices`, `/L` and `/InkList` are real
 * geometry and rotate exactly, so the mark itself does not grow.
 */
function rotateAnnotation(
  ctx: PDFContext,
  annot: PDFDict,
  m: readonly [number, number, number, number, number, number],
): void {
  const rectArray = ctx.lookupMaybe(annot.get(PDFName.of('Rect')), PDFArray);
  if (rectArray && rectArray.size() >= 4) {
    const n = (i: number): number => ctx.lookupMaybe(rectArray.get(i), PDFNumber)?.asNumber() ?? 0;
    const corners = [
      applyMatrix(m, n(0), n(1)),
      applyMatrix(m, n(2), n(1)),
      applyMatrix(m, n(2), n(3)),
      applyMatrix(m, n(0), n(3)),
    ];
    const xs = corners.map((p) => p.x);
    const ys = corners.map((p) => p.y);
    annot.set(
      PDFName.of('Rect'),
      ctx.obj([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]),
    );
  }

  for (const key of ['QuadPoints', 'Vertices', 'L', 'CL'] as const) {
    rotateNumberArray(ctx, annot, key, m);
  }

  const ink = ctx.lookupMaybe(annot.get(PDFName.of('InkList')), PDFArray);
  if (ink) {
    const paths: unknown[] = [];
    for (let i = 0; i < ink.size(); i++) {
      const path = ctx.lookupMaybe(ink.get(i), PDFArray);
      paths.push(path ? ctx.obj(rotatedNumbers(ctx, path, m)) : ink.get(i));
    }
    annot.set(PDFName.of('InkList'), ctx.obj(paths as never));
  }

  // An appearance stream is drawn into `/Rect`, so it follows the rectangle. Its own `/Matrix`
  // would have to change only if the mark itself were being turned relative to its box, which it
  // is not: the whole page turns, box and all.
}

function rotateNumberArray(
  ctx: PDFContext,
  annot: PDFDict,
  key: string,
  m: readonly [number, number, number, number, number, number],
): void {
  const array = ctx.lookupMaybe(annot.get(PDFName.of(key)), PDFArray);
  if (!array || array.size() < 2) return;
  annot.set(PDFName.of(key), ctx.obj(rotatedNumbers(ctx, array, m)));
}

function rotatedNumbers(
  ctx: PDFContext,
  array: PDFArray,
  m: readonly [number, number, number, number, number, number],
): number[] {
  const out: number[] = [];
  for (let i = 0; i + 1 < array.size(); i += 2) {
    const x = ctx.lookupMaybe(array.get(i), PDFNumber)?.asNumber() ?? 0;
    const y = ctx.lookupMaybe(array.get(i + 1), PDFNumber)?.asNumber() ?? 0;
    const p = applyMatrix(m, x, y);
    out.push(p.x, p.y);
  }
  return out;
}

/** A number as a content stream wants it. */
function num(value: number): string {
  if (!Number.isFinite(value)) return '0';
  const rounded = Math.round(value * 1e6) / 1e6;
  return Number.isInteger(rounded) ? String(rounded) : String(rounded);
}

/** Re-exported so a caller can name the type without reaching into pdf-lib. */
export type { PDFRef };

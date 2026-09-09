/**
 * Crop (M41). Two halves that have nothing to do with each other:
 *
 * 1. **`inkBounds`** — where the content on a rendered page actually is. Pure over pixels, so a
 *    unit test can hand it a picture it drew itself; the app hands it a PDFium render. This is
 *    what "remove white margins" is: find the ink, add a little breathing room, and offer the
 *    result as a rectangle the reader can still drag.
 * 2. **`cropPages`** — set boxes on a document's pages, over bytes, for M120's batch and M121's
 *    CLI. The interactive path does *not* come through here: a crop the reader performs is a
 *    `SetPageBoxCommand` on the open document, so it is undoable and visible at once.
 *
 * Cropping never re-encodes anything. It writes rectangles; the content stream, the images and
 * the fonts are untouched, which is why a cropped page can always be un-cropped.
 */

import type { PageBoxName, PdfRect } from '@shared/pdf';
import { normalizeRect } from '@shared/pdf';
import { effectiveBox, loadPdf, pageLeaves, readBox, savePdf, writeBoxes } from './pdfdoc';
import { OpFailed, checkCancelled, type OpContext, type OpResult, type Raster } from './types';

export interface InkBoundsOptions {
  /**
   * How far a pixel may be from the page's background before it counts as ink, 0..255 per
   * channel. 12 is generous enough to ignore JPEG mottling and scanner noise on a white page
   * without losing faint grey text.
   */
  readonly tolerance?: number;
  /**
   * A row or column counts as content when this fraction of it is ink. A hair above zero, so a
   * single stuck pixel or a scanner's black edge line does not defeat the whole scan.
   */
  readonly minCoverage?: number;
}

/** Where the ink is, in pixels of the raster: `null` when the page is blank. */
export interface InkBounds {
  readonly left: number;
  readonly top: number;
  /** Exclusive, as a slice bound. */
  readonly right: number;
  readonly bottom: number;
}

const DEFAULT_TOLERANCE = 12;
const DEFAULT_MIN_COVERAGE = 0.002;

/**
 * The bounding box of everything that is not the page's background.
 *
 * The background is taken from the four corners rather than assumed white: a scan on cream
 * paper, a page with a coloured fill and an inverted title slide all have margins worth
 * trimming, and calling only white "empty" would refuse all three. The median of the corners
 * is used so one corner carrying a logo does not become the background.
 */
export function inkBounds(raster: Raster, options: InkBoundsOptions = {}): InkBounds | null {
  const { data, width, height } = raster;
  if (width <= 0 || height <= 0 || data.length < width * height * 4) return null;
  const tolerance = options.tolerance ?? DEFAULT_TOLERANCE;
  const minCoverage = options.minCoverage ?? DEFAULT_MIN_COVERAGE;
  const background = cornerBackground(raster);

  const isInk = (x: number, y: number): boolean => {
    const at = (y * width + x) * 4;
    return (
      Math.abs((data[at] ?? 0) - background[0]) > tolerance ||
      Math.abs((data[at + 1] ?? 0) - background[1]) > tolerance ||
      Math.abs((data[at + 2] ?? 0) - background[2]) > tolerance
    );
  };

  const rowInk = new Int32Array(height);
  const colInk = new Int32Array(width);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!isInk(x, y)) continue;
      rowInk[y] = (rowInk[y] ?? 0) + 1;
      colInk[x] = (colInk[x] ?? 0) + 1;
    }
  }

  const rowFloor = Math.max(1, Math.round(width * minCoverage));
  const colFloor = Math.max(1, Math.round(height * minCoverage));
  let top = 0;
  while (top < height && (rowInk[top] ?? 0) < rowFloor) top++;
  if (top === height) return null;
  let bottom = height;
  while (bottom > top && (rowInk[bottom - 1] ?? 0) < rowFloor) bottom--;
  let left = 0;
  while (left < width && (colInk[left] ?? 0) < colFloor) left++;
  let right = width;
  while (right > left && (colInk[right - 1] ?? 0) < colFloor) right--;
  if (right <= left || bottom <= top) return null;
  return { left, top, right, bottom };
}

/** The median of the four corner pixels, as `[r, g, b]`. */
function cornerBackground(raster: Raster): [number, number, number] {
  const { data, width, height } = raster;
  const corners: Array<[number, number]> = [
    [0, 0],
    [width - 1, 0],
    [0, height - 1],
    [width - 1, height - 1],
  ];
  const channel = (index: number): number => {
    const values = corners
      .map(([x, y]) => data[(y * width + x) * 4 + index] ?? 255)
      .sort((a, b) => a - b);
    // Four values: the mean of the middle two is the median, and it survives one odd corner.
    return Math.round(((values[1] ?? 255) + (values[2] ?? 255)) / 2);
  };
  return [channel(0), channel(1), channel(2)];
}

/**
 * Turns a pixel box from {@link inkBounds} into a page-space rectangle, with a margin.
 *
 * `pageRect` is the page-space rectangle the raster covers (what `render` reports), so this
 * works for a whole page and for a tile. Pixels count downwards and PDF space counts upwards,
 * which is the only thing that makes this more than a multiplication.
 */
export function inkRect(
  bounds: InkBounds,
  raster: { readonly width: number; readonly height: number },
  pageRect: PdfRect,
  marginPoints = 0,
): PdfRect {
  const sx = (pageRect.x1 - pageRect.x0) / raster.width;
  const sy = (pageRect.y1 - pageRect.y0) / raster.height;
  const rect: PdfRect = {
    x0: pageRect.x0 + bounds.left * sx - marginPoints,
    x1: pageRect.x0 + bounds.right * sx + marginPoints,
    y0: pageRect.y1 - bounds.bottom * sy - marginPoints,
    y1: pageRect.y1 - bounds.top * sy + marginPoints,
  };
  return clampRect(rect, pageRect);
}

/** Keeps `rect` inside `bounds`, and never lets it collapse to nothing. */
export function clampRect(rect: PdfRect, bounds: PdfRect): PdfRect {
  const r = normalizeRect(rect);
  const b = normalizeRect(bounds);
  const x0 = Math.min(Math.max(r.x0, b.x0), b.x1);
  const x1 = Math.max(Math.min(r.x1, b.x1), b.x0);
  const y0 = Math.min(Math.max(r.y0, b.y0), b.y1);
  const y1 = Math.max(Math.min(r.y1, b.y1), b.y0);
  const minimum = 1;
  return {
    x0,
    y0,
    x1: x1 - x0 >= minimum ? x1 : Math.min(b.x1, x0 + minimum),
    y1: y1 - y0 >= minimum ? y1 : Math.min(b.y1, y0 + minimum),
  };
}

/** Margins in points, measured inwards from each edge of a box. */
export interface Margins {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
}

export const NO_MARGINS: Margins = { left: 0, right: 0, top: 0, bottom: 0 };

/** The rectangle `margins` leave of `outer`. Top and bottom are in reading order, not PDF order. */
export function rectFromMargins(outer: PdfRect, margins: Margins): PdfRect {
  const x0 = outer.x0 + margins.left;
  const x1 = outer.x1 - margins.right;
  const y0 = outer.y0 + margins.bottom;
  const y1 = outer.y1 - margins.top;
  // Margins that meet in the middle mean "crop it all away". The answer is an empty rectangle,
  // which the caller reports in words; normalising it would swap the edges round and hand back
  // the whole page, which is the opposite of what was asked for.
  if (x1 <= x0 || y1 <= y0) return { x0, y0, x1: x0, y1: y0 };
  return clampRect({ x0, y0, x1, y1 }, outer);
}

/** The margins that turn `outer` into `inner`. The inverse of {@link rectFromMargins}. */
export function marginsFromRect(outer: PdfRect, inner: PdfRect): Margins {
  return {
    left: inner.x0 - outer.x0,
    right: outer.x1 - inner.x1,
    top: outer.y1 - inner.y1,
    bottom: inner.y0 - outer.y0,
  };
}

/**
 * Grows or shrinks `rect` about its centre until it has the given width-to-height ratio, staying
 * inside `bounds`. Shrinking is what a constrained drag needs: it can never leave the page.
 */
export function constrainRatio(rect: PdfRect, ratio: number, bounds: PdfRect): PdfRect {
  if (!(ratio > 0) || !Number.isFinite(ratio)) return rect;
  const r = normalizeRect(rect);
  const width = r.x1 - r.x0;
  const height = r.y1 - r.y0;
  if (width <= 0 || height <= 0) return r;
  const cx = (r.x0 + r.x1) / 2;
  const cy = (r.y0 + r.y1) / 2;
  // Shrink the long side rather than grow the short one, so the result is always inside `rect`.
  const [w, h] = width / height > ratio ? [height * ratio, height] : [width, width / ratio];
  return clampRect({ x0: cx - w / 2, x1: cx + w / 2, y0: cy - h / 2, y1: cy + h / 2 }, bounds);
}

export interface CropOptions {
  /** Which pages, 0-based. Absent means every page. */
  readonly pages?: ReadonlyArray<number>;
  /** Which box the rectangle is written to. */
  readonly box: PageBoxName;
  /**
   * The rectangle, either absolute in page space or as margins taken off the page's current
   * box. Margins are what a "crop every page by 1 cm" batch action means, since the pages may
   * not all be the same size.
   */
  readonly rect?: PdfRect;
  readonly margins?: Margins;
  /**
   * Also set the MediaBox to the same rectangle — Foxit's "change page size". Without it a
   * cropped page still carries its original paper, which is what lets the crop be undone in
   * another reader.
   */
  readonly changePageSize?: boolean;
}

/**
 * Sets a box on some pages of a document, over bytes (M120, M121).
 *
 * A page whose box would end up outside its MediaBox is clamped rather than refused: a batch
 * over a folder of mixed page sizes should crop what it can and say what it did.
 */
export async function cropPages(
  bytes: Uint8Array,
  options: CropOptions,
  ctx: OpContext = {},
): Promise<OpResult> {
  if (!options.rect && !options.margins) {
    throw new OpFailed('Cropping needs either a rectangle or margins');
  }
  const doc = await loadPdf(bytes, 'The document');
  const leaves = pageLeaves(doc);
  if (leaves.length === 0) throw new OpFailed('The document has no pages to crop');
  const wanted =
    options.pages && options.pages.length > 0
      ? [...new Set(options.pages)].filter((p) => p >= 0 && p < leaves.length).sort((a, b) => a - b)
      : leaves.map((_, i) => i);
  const warnings: string[] = [];

  for (const [i, index] of wanted.entries()) {
    checkCancelled(ctx.signal);
    ctx.progress?.(i / wanted.length, `Cropping page ${String(index + 1)}`);
    const entry = leaves[index];
    if (!entry) continue;
    const media = effectiveBox(entry.leaf, 'media');
    const from = effectiveBox(entry.leaf, options.box);
    const target = options.rect
      ? clampRect(options.rect, media)
      : rectFromMargins(from, options.margins ?? NO_MARGINS);
    if (target.x1 - target.x0 < 1 || target.y1 - target.y0 < 1) {
      warnings.push(
        `Page ${String(index + 1)} would have been cropped away to nothing, so it was left alone`,
      );
      continue;
    }
    const patch = { [options.box]: target } as Record<PageBoxName, PdfRect>;
    if (options.changePageSize === true) {
      patch.media = target;
      patch.crop = target;
    }
    writeBoxes(entry.leaf, patch);
    // A TrimBox left outside a shrunken CropBox is invalid; drop the ones that no longer fit.
    for (const name of ['bleed', 'trim', 'art'] as const) {
      if (name === options.box) continue;
      const existing = readBox(entry.leaf, name);
      if (existing && !contains(target, existing)) writeBoxes(entry.leaf, { [name]: null });
    }
  }

  ctx.progress?.(1, 'Done');
  return { bytes: await savePdf(doc), pageCount: leaves.length, warnings };
}

function contains(outer: PdfRect, inner: PdfRect): boolean {
  return (
    inner.x0 >= outer.x0 - 0.01 &&
    inner.y0 >= outer.y0 - 0.01 &&
    inner.x1 <= outer.x1 + 0.01 &&
    inner.y1 <= outer.y1 + 0.01
  );
}

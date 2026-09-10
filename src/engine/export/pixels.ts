/**
 * Colour reduction for the image export (M92): RGBA in, RGBA / grey / bilevel out.
 *
 * This is one pipeline shared by every format rather than a setting inside each encoder, so
 * "150 dpi, greyscale" means exactly the same thing in a PNG, a TIFF and a BMP — and so that all
 * of it is provable in Node against a picture a test drew itself.
 *
 * Greyscale is Rec. 601 luma (`0.299 R + 0.587 G + 0.114 B`), the same weighting
 * `engine/imageHash.ts` uses, so a page's grey never depends on which part of the app asked for
 * it. Monochrome is either a plain threshold or Floyd–Steinberg error diffusion; a scan of text
 * thresholds cleanly, and a photograph needs the dithering to survive at all.
 */

import type { Raster } from './types';

/** What the reader chose in the dialog's Colour row. */
export type ColourMode = 'colour' | 'grey' | 'mono';

/** How a monochrome conversion decides between black and white. */
export type Dither = 'none' | 'floyd-steinberg';

export interface MonoOptions {
  /** Luma at or above this is white. 0–255. */
  readonly threshold: number;
  readonly dither: Dither;
}

export const DEFAULT_MONO: MonoOptions = { threshold: 128, dither: 'floyd-steinberg' };

/** One channel of grey per pixel, rows top-down. */
export interface GreyRaster {
  readonly data: Uint8Array;
  readonly width: number;
  readonly height: number;
}

/**
 * One bit per pixel, rows top-down, **packed MSB-first with each row starting on a byte** — the
 * row padding both PNG and TIFF want, and BMP's own padding is applied on top by its writer.
 * A set bit is white, which is PNG colour type 0 and TIFF `PhotometricInterpretation = 1`.
 */
export interface MonoRaster {
  readonly data: Uint8Array;
  readonly width: number;
  readonly height: number;
  /** Bytes per row, `ceil(width / 8)`. */
  readonly stride: number;
}

/** Rec. 601 luma of one RGB triple, 0–255. */
export function luma(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/**
 * Flattens RGBA onto a white ground.
 *
 * A page render is already opaque, but an exported *image object* need not be, and JPEG, BMP and
 * bilevel TIFF have nowhere to put an alpha channel. White is the right ground because it is
 * what paper is; the alternative — leaving the premultiplied colour — turns a transparent logo
 * into a black one.
 */
export function flatten(raster: Raster): Uint8Array {
  const { width, height } = raster;
  const src = raster.data;
  const out = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const at = i * 4;
    const a = src[at + 3] ?? 255;
    if (a === 255) {
      out[at] = src[at] ?? 0;
      out[at + 1] = src[at + 1] ?? 0;
      out[at + 2] = src[at + 2] ?? 0;
    } else {
      const k = a / 255;
      out[at] = Math.round((src[at] ?? 0) * k + 255 * (1 - k));
      out[at + 1] = Math.round((src[at + 1] ?? 0) * k + 255 * (1 - k));
      out[at + 2] = Math.round((src[at + 2] ?? 0) * k + 255 * (1 - k));
    }
    out[at + 3] = 255;
  }
  return out;
}

/** RGBA → one grey channel per pixel, over a white ground. */
export function toGrey(raster: Raster): GreyRaster {
  const { width, height } = raster;
  const src = raster.data;
  const out = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const at = i * 4;
    const a = src[at + 3] ?? 255;
    const value = luma(src[at] ?? 0, src[at + 1] ?? 0, src[at + 2] ?? 0);
    out[i] = Math.round(a === 255 ? value : value * (a / 255) + 255 * (1 - a / 255));
  }
  return { data: out, width, height };
}

/**
 * Grey → one bit per pixel, packed MSB-first, a set bit meaning white.
 *
 * Floyd–Steinberg pushes each pixel's error to the four neighbours ahead of it in scan order
 * (7/16 right, 3/16 down-left, 5/16 down, 1/16 down-right). The error buffer is a float row pair
 * rather than the image itself, so the input is never modified and the same raster can be
 * exported twice.
 */
export function toMono(grey: GreyRaster, options: MonoOptions = DEFAULT_MONO): MonoRaster {
  const { width, height } = grey;
  const stride = Math.ceil(width / 8);
  const out = new Uint8Array(stride * height);
  const threshold = Math.min(255, Math.max(0, options.threshold));
  if (options.dither === 'none') {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if ((grey.data[y * width + x] ?? 0) >= threshold) {
          out[y * stride + (x >> 3)] = (out[y * stride + (x >> 3)] ?? 0) | (0x80 >> (x & 7));
        }
      }
    }
    return { data: out, width, height, stride };
  }
  let current = new Float32Array(width);
  let next = new Float32Array(width);
  for (let x = 0; x < width; x++) current[x] = grey.data[x] ?? 0;
  for (let y = 0; y < height; y++) {
    next.fill(0);
    const nextRow = (y + 1) * width;
    for (let x = 0; x < width; x++) {
      if (y + 1 < height) next[x] = (next[x] ?? 0) + (grey.data[nextRow + x] ?? 0);
    }
    for (let x = 0; x < width; x++) {
      const value = current[x] ?? 0;
      const white = value >= threshold;
      if (white) out[y * stride + (x >> 3)] = (out[y * stride + (x >> 3)] ?? 0) | (0x80 >> (x & 7));
      const error = value - (white ? 255 : 0);
      if (x + 1 < width) current[x + 1] = (current[x + 1] ?? 0) + (error * 7) / 16;
      if (y + 1 < height) {
        if (x > 0) next[x - 1] = (next[x - 1] ?? 0) + (error * 3) / 16;
        next[x] = (next[x] ?? 0) + (error * 5) / 16;
        if (x + 1 < width) next[x + 1] = (next[x + 1] ?? 0) + error / 16;
      }
    }
    const swap = current;
    current = next;
    next = swap;
  }
  return { data: out, width, height, stride };
}

/** Grey back to RGBA, for a format that has no grey mode. */
export function greyToRgba(grey: GreyRaster): Uint8Array {
  const out = new Uint8Array(grey.width * grey.height * 4);
  for (let i = 0; i < grey.width * grey.height; i++) {
    const v = grey.data[i] ?? 0;
    out[i * 4] = v;
    out[i * 4 + 1] = v;
    out[i * 4 + 2] = v;
    out[i * 4 + 3] = 255;
  }
  return out;
}

/** Bilevel back to grey, for a format that has no 1-bit mode. */
export function monoToGrey(mono: MonoRaster): GreyRaster {
  const out = new Uint8Array(mono.width * mono.height);
  for (let y = 0; y < mono.height; y++) {
    for (let x = 0; x < mono.width; x++) {
      const bit = ((mono.data[y * mono.stride + (x >> 3)] ?? 0) >> (7 - (x & 7))) & 1;
      out[y * mono.width + x] = bit ? 255 : 0;
    }
  }
  return { data: out, width: mono.width, height: mono.height };
}

/**
 * The one conversion every encoder starts from: a raster reduced to the reader's colour mode.
 *
 * A union rather than three functions because the encoders switch on it, and because it keeps
 * "what colour is this picture" in one place where the dialog, the file and the test agree.
 */
export type Reduced =
  | {
      readonly mode: 'colour';
      readonly rgba: Uint8Array;
      readonly width: number;
      readonly height: number;
    }
  | { readonly mode: 'grey'; readonly grey: GreyRaster }
  | { readonly mode: 'mono'; readonly mono: MonoRaster };

export function reduce(
  raster: Raster,
  mode: ColourMode,
  mono: MonoOptions = DEFAULT_MONO,
): Reduced {
  if (mode === 'colour') {
    return { mode, rgba: flatten(raster), width: raster.width, height: raster.height };
  }
  const grey = toGrey(raster);
  return mode === 'grey' ? { mode, grey } : { mode: 'mono', mono: toMono(grey, mono) };
}

/** The reduced raster's size, whichever branch it is. */
export function reducedSize(r: Reduced): { readonly width: number; readonly height: number } {
  if (r.mode === 'colour') return { width: r.width, height: r.height };
  if (r.mode === 'grey') return { width: r.grey.width, height: r.grey.height };
  return { width: r.mono.width, height: r.mono.height };
}

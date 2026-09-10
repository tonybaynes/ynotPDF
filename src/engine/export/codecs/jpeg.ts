/**
 * JPEG writer (M92) — `jpeg-js` (BSD-3), the library the brief chose, wrapped in the two things
 * it does not do.
 *
 * 1. It hands back a `Buffer` when it can see a CommonJS `module`, which a bundled Worker can.
 *    `./installBuffer` gives it one; the return value is normalised to a `Uint8Array` here so
 *    nothing downstream has to care which it got.
 * 2. It writes no resolution. A JFIF `APP0` has a density field, and a 150 dpi export that does
 *    not say 150 dpi prints at the wrong size — so the segment is patched afterwards, the same
 *    way `scripts/make-fixtures.ts` already does it for the corpus.
 *
 * JPEG has no greyscale-only or bilevel mode here: `jpeg-js` encodes 4:2:0 colour, and a grey
 * image encoded as colour is grey. The dialog says so rather than pretending otherwise.
 */

import './installBuffer';
import { encode } from 'jpeg-js';

export interface JpegOptions {
  /** 1–100; `jpeg-js`'s own scale. 85 is the dialog's default. */
  readonly quality?: number;
  readonly dpi?: { readonly x: number; readonly y: number };
}

/** Encodes RGBA pixels (alpha ignored — JPEG has none). */
export function encodeJpeg(
  rgba: Uint8Array,
  width: number,
  height: number,
  options: JpegOptions = {},
): Uint8Array {
  const quality = Math.min(100, Math.max(1, Math.round(options.quality ?? 85)));
  // `unknown` on purpose: the published types promise a `Buffer`, and what actually arrives is
  // whatever `installBuffer` handed the encoder — a real `Buffer` in Node, a `Uint8Array` here.
  const raw: unknown = encode({ data: rgba, width, height }, quality).data;
  const out =
    raw instanceof Uint8Array ? new Uint8Array(raw) : Uint8Array.from(raw as ArrayLike<number>);
  return options.dpi ? withJfifDensity(out, options.dpi.x, options.dpi.y) : out;
}

/**
 * Writes a dots-per-inch density into the file's JFIF `APP0`.
 *
 * The segment layout after the two length bytes is `"JFIF\0"`, version (2 bytes), units (1),
 * X density (2), Y density (2) — units 1 meaning dots per inch. `jpeg-js` always writes an
 * `APP0` with units 0 and density 1×1, so this is a patch in place rather than an insertion;
 * a file without one is returned untouched rather than corrupted.
 */
export function withJfifDensity(jpeg: Uint8Array, dpiX: number, dpiY: number): Uint8Array {
  const at = findJfifApp0(jpeg);
  if (at < 0) return jpeg;
  const out = jpeg.slice();
  // marker(2) length(2) JFIF + NUL (5 bytes) version(2) → units, then the two densities.
  const units = at + 11;
  out[units] = 1;
  out[units + 1] = (Math.round(dpiX) >> 8) & 0xff;
  out[units + 2] = Math.round(dpiX) & 0xff;
  out[units + 3] = (Math.round(dpiY) >> 8) & 0xff;
  out[units + 4] = Math.round(dpiY) & 0xff;
  return out;
}

/** Offset of the `APP0` marker of a JFIF segment, or `-1`. */
function findJfifApp0(jpeg: Uint8Array): number {
  if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) return -1;
  let at = 2;
  while (at + 4 < jpeg.length && jpeg[at] === 0xff) {
    const marker = jpeg[at + 1] ?? 0;
    const length = ((jpeg[at + 2] ?? 0) << 8) | (jpeg[at + 3] ?? 0);
    if (marker === 0xe0 && jpeg[at + 4] === 0x4a && jpeg[at + 5] === 0x46) return at;
    if (marker === 0xda || marker === 0xd9) return -1; // scan data starts; no APP0 before it
    at += 2 + length;
  }
  return -1;
}

/** The density a JPEG declares, in dots per inch, or `null` when it declares none. */
export function readJfifDensity(jpeg: Uint8Array): { x: number; y: number } | null {
  const at = findJfifApp0(jpeg);
  if (at < 0) return null;
  const units = jpeg[at + 11] ?? 0;
  const x = ((jpeg[at + 12] ?? 0) << 8) | (jpeg[at + 13] ?? 0);
  const y = ((jpeg[at + 14] ?? 0) << 8) | (jpeg[at + 15] ?? 0);
  if (units === 1) return { x, y };
  // Units 2 is dots per centimetre; units 0 is an aspect ratio and says nothing about size.
  if (units === 2) return { x: Math.round(x * 2.54), y: Math.round(y * 2.54) };
  return null;
}

/** Pixel size from a JPEG's frame header (`SOFn`), for tests and for a size check. */
export function readJpegSize(jpeg: Uint8Array): { width: number; height: number } | null {
  if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) return null;
  let at = 2;
  while (at + 9 < jpeg.length && jpeg[at] === 0xff) {
    const marker = jpeg[at + 1] ?? 0;
    const length = ((jpeg[at + 2] ?? 0) << 8) | (jpeg[at + 3] ?? 0);
    // SOF0..SOF15, skipping the four that are not frame headers (DHT, JPG, DAC, RST).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return {
        height: ((jpeg[at + 5] ?? 0) << 8) | (jpeg[at + 6] ?? 0),
        width: ((jpeg[at + 7] ?? 0) << 8) | (jpeg[at + 8] ?? 0),
      };
    }
    if (marker === 0xda) return null;
    at += 2 + length;
  }
  return null;
}

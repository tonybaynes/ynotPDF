/**
 * `nativeImage` as a last-resort raster decoder for `image:decode` (M91, ADR 0011): the only
 * route to HEIC, and only where the OS has a codec. Returns `null` for anything it cannot read.
 */

import { nativeImage } from 'electron';
import type { DecodedRaster } from '../../shared/create';

/** Larger pictures are refused rather than decoded: 50 megapixels is 200 MB of RGBA. */
const MAX_PIXELS = 50_000_000;

/**
 * Converts `nativeImage.toBitmap()` output — 8-bit BGRA, row-major, top-left first — to RGBA
 * by swapping the blue and red channels. The bitmap may carry premultiplied alpha on some
 * platforms (macOS in particular); this does not un-premultiply, so a translucent pixel keeps
 * its darkened colour. `bitmap` must hold exactly `width * height * 4` bytes.
 */
export function bgraToRgba(bitmap: Uint8Array, width: number, height: number): Uint8Array {
  const pixels = width * height;
  const rgba = new Uint8Array(pixels * 4);
  const n = Math.min(bitmap.length, rgba.length);
  for (let i = 0; i + 3 < n; i += 4) {
    rgba[i] = bitmap[i + 2] ?? 0;
    rgba[i + 1] = bitmap[i + 1] ?? 0;
    rgba[i + 2] = bitmap[i] ?? 0;
    rgba[i + 3] = bitmap[i + 3] ?? 0;
  }
  return rgba;
}

/**
 * Decodes with the platform's codecs. `null` when the bytes are not an image the OS can read,
 * or when the picture is over {@link MAX_PIXELS}.
 */
export function decodeWithNativeImage(bytes: Uint8Array): DecodedRaster | null {
  const image = nativeImage.createFromBuffer(Buffer.from(bytes));
  if (image.isEmpty()) return null;
  const { width, height } = image.getSize();
  if (width <= 0 || height <= 0) return null;
  if (width * height > MAX_PIXELS) {
    console.warn(`image:decode refused a ${width}x${height} picture (over ${MAX_PIXELS} pixels)`);
    return null;
  }
  const bitmap = image.toBitmap();
  if (bitmap.length < width * height * 4) return null;
  return { width, height, rgba: bgraToRgba(new Uint8Array(bitmap), width, height) };
}

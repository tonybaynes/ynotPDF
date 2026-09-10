/**
 * Reading and writing the pixel data inside a PDF image (M100).
 *
 * A PDF image XObject is a stream of samples with a filter chain on top of it, and this file is
 * the whole of what M100 knows about those filters: inflate and deflate, the two predictors, and
 * baseline JPEG through jpeg-js. Everything above it works in {@link Samples} — interleaved
 * 8-bit components, top-left origin, no filter and no predictor — so the resampler and the
 * encoders never see a `/DecodeParms` in their lives.
 *
 * What is deliberately **not** here: JPEG 2000 and JBIG2 encoding (out of scope, per the brief),
 * and LZW. An image in a filter this file cannot read is left exactly as it was and named in the
 * report, because a picture that survives is better than a smaller one that does not.
 */

import * as pako from 'pako';
import { decode as decodeJpegRaw, encode as encodeJpegRaw } from 'jpeg-js';

/**
 * Decoded pixels: `components` interleaved 8-bit values per pixel, row by row from the top.
 *
 * 8 bits per component even for a 1-bit image, which is expanded on the way in and packed on the
 * way out. Every arithmetic step above this — averaging, thresholding, encoding — is then one
 * implementation rather than one per bit depth, and a mono image is small enough that the
 * eightfold expansion costs nothing worth counting.
 */
export interface Samples {
  readonly data: Uint8Array;
  readonly width: number;
  readonly height: number;
  /** 1 for grey or a stencil mask, 3 for RGB. Nothing above this file handles any other count. */
  readonly components: 1 | 3;
}

// ---- flate ----------------------------------------------------------------------------------

export function inflate(bytes: Uint8Array): Uint8Array {
  return pako.inflate(bytes);
}

/**
 * Deflate at the highest level. Deterministic: pako's output is a pure function of its input and
 * its options, so optimising the same file twice gives the same bytes.
 */
export function deflate(bytes: Uint8Array): Uint8Array {
  return pako.deflate(bytes, { level: 9 });
}

// ---- predictors -----------------------------------------------------------------------------

export interface PredictorParams {
  /** `/Predictor`: 1 none, 2 TIFF, 10–15 PNG. */
  readonly predictor: number;
  readonly colors: number;
  readonly bitsPerComponent: number;
  readonly columns: number;
}

/**
 * Undoes a `/DecodeParms` predictor, which is what makes flate worth using on an image in the
 * first place — and what makes the raw bytes meaningless until it is undone.
 *
 * PNG predictors (10–15) carry a filter type byte per row and are undone row by row against the
 * row above; TIFF predictor 2 is a horizontal difference with no per-row byte. Anything else is
 * returned untouched, which is right for predictor 1 and safe for a value we do not know.
 */
export function undoPredictor(data: Uint8Array, params: PredictorParams): Uint8Array {
  const { predictor, colors, bitsPerComponent, columns } = params;
  if (predictor <= 1) return data;
  const bpp = Math.max(1, Math.ceil((colors * bitsPerComponent) / 8));
  const rowLength = Math.ceil((colors * bitsPerComponent * columns) / 8);

  if (predictor === 2) {
    // TIFF predictor: only the 8-bit case is defined for us; sub-byte components would need bit
    // arithmetic for a case no producer we have met emits.
    if (bitsPerComponent !== 8) return data;
    const out = Uint8Array.from(data);
    const rows = Math.floor(out.length / rowLength);
    for (let r = 0; r < rows; r++) {
      const base = r * rowLength;
      for (let i = bpp; i < rowLength; i++) {
        out[base + i] = ((out[base + i] ?? 0) + (out[base + i - bpp] ?? 0)) & 0xff;
      }
    }
    return out;
  }

  // PNG predictors: one extra byte per row saying which filter that row used.
  const stride = rowLength + 1;
  const rows = Math.floor(data.length / stride);
  const out = new Uint8Array(rows * rowLength);
  let previous = new Uint8Array(rowLength);
  for (let r = 0; r < rows; r++) {
    const type = data[r * stride] ?? 0;
    const src = data.subarray(r * stride + 1, r * stride + 1 + rowLength);
    const row = new Uint8Array(rowLength);
    for (let i = 0; i < rowLength; i++) {
      const raw = src[i] ?? 0;
      const left = i >= bpp ? (row[i - bpp] ?? 0) : 0;
      const up = previous[i] ?? 0;
      const upLeft = i >= bpp ? (previous[i - bpp] ?? 0) : 0;
      let value: number;
      switch (type) {
        case 0:
          value = raw;
          break;
        case 1:
          value = raw + left;
          break;
        case 2:
          value = raw + up;
          break;
        case 3:
          value = raw + ((left + up) >> 1);
          break;
        case 4:
          value = raw + paeth(left, up, upLeft);
          break;
        default:
          value = raw;
          break;
      }
      row[i] = value & 0xff;
    }
    out.set(row, r * rowLength);
    previous = row;
  }
  return out;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

// ---- unpacking and packing --------------------------------------------------------------------

/**
 * Turns unfiltered sample bytes into 8-bit-per-component {@link Samples}.
 *
 * Every row of a PDF image starts on a byte boundary (ISO 32000-1 §8.9.3), so a 1-bit 100-pixel
 * row occupies 13 bytes and the last four bits are padding — which is why this cannot simply
 * walk the buffer as a bit stream.
 */
export function unpack(
  data: Uint8Array,
  width: number,
  height: number,
  components: number,
  bits: number,
): Uint8Array {
  const out = new Uint8Array(width * height * components);
  if (bits === 8) {
    const rowLength = width * components;
    for (let y = 0; y < height; y++) {
      const src = y * rowLength;
      out.set(data.subarray(src, src + rowLength), y * rowLength);
    }
    return out;
  }
  const max = (1 << bits) - 1;
  const rowBytes = Math.ceil((width * components * bits) / 8);
  for (let y = 0; y < height; y++) {
    let bit = 0;
    const base = y * rowBytes;
    for (let i = 0; i < width * components; i++) {
      let value = 0;
      for (let b = 0; b < bits; b++) {
        const byte = data[base + (bit >> 3)] ?? 0;
        value = (value << 1) | ((byte >> (7 - (bit & 7))) & 1);
        bit++;
      }
      // Scale to 0–255 so everything downstream is one range. 16-bit samples lose their low byte,
      // which is invisible on paper and on a screen and saves half the memory.
      out[y * width * components + i] = bits === 16 ? value >> 8 : Math.round((value * 255) / max);
    }
  }
  return out;
}

/** Packs 8-bit samples back to one bit per component, rows byte-aligned. */
export function packMono(samples: Samples): Uint8Array {
  const rowBytes = Math.ceil(samples.width / 8);
  const out = new Uint8Array(rowBytes * samples.height);
  for (let y = 0; y < samples.height; y++) {
    for (let x = 0; x < samples.width; x++) {
      // 1 is white in DeviceGray, and a 1-bit image is DeviceGray unless it says otherwise.
      if ((samples.data[y * samples.width + x] ?? 0) >= 128) {
        out[y * rowBytes + (x >> 3)] = (out[y * rowBytes + (x >> 3)] ?? 0) | (0x80 >> (x & 7));
      }
    }
  }
  return out;
}

// ---- JPEG -------------------------------------------------------------------------------------

/** Decodes baseline JPEG. Returns `null` for anything jpeg-js will not read (CMYK, arithmetic). */
export function decodeJpeg(bytes: Uint8Array): Samples | null {
  try {
    const raw = decodeJpegRaw(bytes, { useTArray: true, tolerantDecoding: true });
    const { width, height, data } = raw;
    if (width <= 0 || height <= 0) return null;
    // jpeg-js hands back RGBA whatever the source was; the alpha byte is always 255 for a JPEG.
    if (data.length < width * height * 4) return null;
    const rgb = new Uint8Array(width * height * 3);
    for (let i = 0, j = 0; i < width * height; i++, j += 3) {
      rgb[j] = data[i * 4] ?? 0;
      rgb[j + 1] = data[i * 4 + 1] ?? 0;
      rgb[j + 2] = data[i * 4 + 2] ?? 0;
    }
    return { data: rgb, width, height, components: 3 };
  } catch {
    return null;
  }
}

/**
 * Encodes baseline JPEG at `quality` (1–100).
 *
 * jpeg-js writes three components whatever it is given, so a greyscale image comes out as a
 * three-channel JPEG whose chroma planes are flat. That costs a few hundred bytes — flat planes
 * subsample and run-length away to almost nothing — and it keeps one encoder rather than two;
 * the caller sets `/DeviceRGB` to match.
 */
export function encodeJpeg(samples: Samples, quality: number): Uint8Array {
  const { width, height } = samples;
  const rgba = new Uint8Array(width * height * 4);
  if (samples.components === 1) {
    for (let i = 0; i < width * height; i++) {
      const v = samples.data[i] ?? 0;
      rgba[i * 4] = v;
      rgba[i * 4 + 1] = v;
      rgba[i * 4 + 2] = v;
      rgba[i * 4 + 3] = 255;
    }
  } else {
    for (let i = 0; i < width * height; i++) {
      rgba[i * 4] = samples.data[i * 3] ?? 0;
      rgba[i * 4 + 1] = samples.data[i * 3 + 1] ?? 0;
      rgba[i * 4 + 2] = samples.data[i * 3 + 2] ?? 0;
      rgba[i * 4 + 3] = 255;
    }
  }
  const encoded = encodeJpegRaw({ data: rgba, width, height }, clampQuality(quality));
  return Uint8Array.from(encoded.data);
}

function clampQuality(quality: number): number {
  if (!Number.isFinite(quality)) return 75;
  return Math.max(1, Math.min(100, Math.round(quality)));
}

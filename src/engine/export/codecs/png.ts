/**
 * PNG writer (M92). In-house on `pako`, which is already a dependency (M91 installs it so utif
 * can find its inflate).
 *
 * The brief suggested `pngjs`; it is a Node stream API around `Buffer` and `zlib`, and this code
 * has to run inside a Worker. PNG is small enough to own: a signature, `IHDR`, an optional `pHYs`,
 * one `IDAT` of deflated filtered scanlines, `IEND`. Owning it is also the only way to get the
 * two things the export dialog offers — a real resolution recorded in the file, and a chosen
 * compression level.
 *
 * Filtering is the adaptive heuristic from the PNG specification's own recommendation (minimum
 * sum of absolute differences over the five filter types, per row). It costs one pass over the
 * row per filter and typically saves a fifth of the file on a page of text.
 *
 * Colour types: 0 (grey, 1 or 8 bits), 2 (RGB) and 6 (RGBA). Page exports use opaque
 * rasters; extracted embedded pictures use RGBA so their image masks survive in PNG.
 */

import { deflate } from 'pako';
import type { GreyRaster, MonoRaster } from '../pixels';

/**
 * A zlib compression level as `pako` types it. Kept here rather than inline because the TIFF
 * writer needs the same clamp and neither should be able to pass 11.
 */
export type DeflateLevel = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;

/** Clamps anything to a level `pako` will accept; 6 is zlib's own default. */
export function deflateLevel(level: number | undefined): DeflateLevel {
  const n = Math.round(level ?? 6);
  return (Number.isFinite(n) ? Math.min(9, Math.max(0, n)) : 6) as DeflateLevel;
}

/** Resolution to record in a `pHYs` chunk. */
export interface PngDpi {
  readonly x: number;
  readonly y: number;
}

export interface PngOptions {
  /** zlib level 0–9; 6 is zlib's own default and the one the dialog starts at. */
  readonly level?: number;
  readonly dpi?: PngDpi;
}

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** CRC-32 as PNG defines it (the standard IEEE polynomial, reflected). */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = (CRC_TABLE[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** Dots per inch → dots per metre, which is the unit `pHYs` records. */
export function dpiToMetre(dpi: number): number {
  return Math.max(1, Math.round(dpi / 0.0254));
}

function physChunk(dpi: PngDpi): Uint8Array {
  const data = new Uint8Array(9);
  const view = new DataView(data.buffer);
  view.setUint32(0, dpiToMetre(dpi.x));
  view.setUint32(4, dpiToMetre(dpi.y));
  data[8] = 1; // unit: metres
  return chunk('pHYs', data);
}

/**
 * One row, filtered by whichever of the five filters gives the smallest sum of absolute
 * differences — the heuristic the PNG specification recommends. `bpp` is the byte distance to the
 * pixel on the left (1 for grey, 3 for RGB, and 1 for sub-byte depths, where "the pixel to the
 * left" is the byte to the left).
 */
function filterRow(row: Uint8Array, previous: Uint8Array, bpp: number, out: Uint8Array): number {
  const n = row.length;
  let best = 0;
  let bestScore = Infinity;
  const candidate = new Uint8Array(n);
  for (let type = 0; type <= 4; type++) {
    let score = 0;
    for (let i = 0; i < n; i++) {
      const raw = row[i] ?? 0;
      const left = i >= bpp ? (row[i - bpp] ?? 0) : 0;
      const up = previous[i] ?? 0;
      const upLeft = i >= bpp ? (previous[i - bpp] ?? 0) : 0;
      let value: number;
      switch (type) {
        case 0:
          value = raw;
          break;
        case 1:
          value = raw - left;
          break;
        case 2:
          value = raw - up;
          break;
        case 3:
          value = raw - ((left + up) >> 1);
          break;
        default: {
          const p = left + up - upLeft;
          const pa = Math.abs(p - left);
          const pb = Math.abs(p - up);
          const pc = Math.abs(p - upLeft);
          value = raw - (pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft);
          break;
        }
      }
      const byte = value & 0xff;
      candidate[i] = byte;
      // Signed magnitude: the specification's heuristic sums |value| treating bytes as signed.
      score += byte < 128 ? byte : 256 - byte;
      if (score >= bestScore) break;
    }
    if (score < bestScore) {
      bestScore = score;
      best = type;
      out.set(candidate.subarray(0, n));
    }
  }
  return best;
}

function encode(
  width: number,
  height: number,
  colourType: 0 | 2 | 6,
  bitDepth: 1 | 8,
  rows: (y: number) => Uint8Array,
  rowBytes: number,
  bpp: number,
  options: PngOptions,
): Uint8Array {
  const raw = new Uint8Array((rowBytes + 1) * height);
  const previous = new Uint8Array(rowBytes);
  const filtered = new Uint8Array(rowBytes);
  for (let y = 0; y < height; y++) {
    const row = rows(y);
    const type = filterRow(row, previous, bpp, filtered);
    raw[y * (rowBytes + 1)] = type;
    raw.set(filtered, y * (rowBytes + 1) + 1);
    previous.set(row);
  }
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr[8] = bitDepth;
  ihdr[9] = colourType;
  const idat = deflate(raw, { level: deflateLevel(options.level) });
  const parts: Uint8Array[] = [
    Uint8Array.from(SIGNATURE),
    chunk('IHDR', ihdr),
    ...(options.dpi ? [physChunk(options.dpi)] : []),
    chunk('IDAT', idat),
    chunk('IEND', new Uint8Array(0)),
  ];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** 8-bit RGBA PNG preserving straight (unassociated) alpha, including transparent pixels. */
export function encodePngRgba(
  rgba: Uint8Array,
  width: number,
  height: number,
  options: PngOptions = {},
): Uint8Array {
  return encode(
    width,
    height,
    6,
    8,
    (y) => rgba.subarray(y * width * 4, (y + 1) * width * 4),
    width * 4,
    4,
    options,
  );
}

/** 8-bit truecolour PNG from opaque RGBA pixels; the alpha channel is dropped. */
export function encodePngRgb(
  rgba: Uint8Array,
  width: number,
  height: number,
  options: PngOptions = {},
): Uint8Array {
  const row = new Uint8Array(width * 3);
  return encode(
    width,
    height,
    2,
    8,
    (y) => {
      const base = y * width * 4;
      for (let x = 0; x < width; x++) {
        row[x * 3] = rgba[base + x * 4] ?? 0;
        row[x * 3 + 1] = rgba[base + x * 4 + 1] ?? 0;
        row[x * 3 + 2] = rgba[base + x * 4 + 2] ?? 0;
      }
      return row;
    },
    width * 3,
    3,
    options,
  );
}

/** 8-bit greyscale PNG. */
export function encodePngGrey(grey: GreyRaster, options: PngOptions = {}): Uint8Array {
  return encode(
    grey.width,
    grey.height,
    0,
    8,
    (y) => grey.data.subarray(y * grey.width, (y + 1) * grey.width),
    grey.width,
    1,
    options,
  );
}

/** 1-bit greyscale PNG — a set bit is white, which is exactly `MonoRaster`'s packing. */
export function encodePngMono(mono: MonoRaster, options: PngOptions = {}): Uint8Array {
  return encode(
    mono.width,
    mono.height,
    0,
    1,
    (y) => mono.data.subarray(y * mono.stride, (y + 1) * mono.stride),
    mono.stride,
    1,
    options,
  );
}

/** The header fields of a PNG, for tests and for "what did we just write". */
export interface PngHeader {
  readonly width: number;
  readonly height: number;
  readonly bitDepth: number;
  readonly colourType: number;
  /** Pixels per metre from `pHYs`, when the file has one. */
  readonly pixelsPerMetreX?: number;
  readonly pixelsPerMetreY?: number;
}

/** Reads a PNG's `IHDR` and `pHYs`. Throws when the bytes are not a PNG. */
export function readPngHeader(bytes: Uint8Array): PngHeader {
  for (let i = 0; i < SIGNATURE.length; i++) {
    if (bytes[i] !== SIGNATURE[i]) throw new Error('not a PNG');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 8;
  let header: PngHeader | null = null;
  let phys: { x: number; y: number } | null = null;
  while (at + 8 <= bytes.length) {
    const length = view.getUint32(at);
    const type = String.fromCharCode(
      bytes[at + 4] ?? 0,
      bytes[at + 5] ?? 0,
      bytes[at + 6] ?? 0,
      bytes[at + 7] ?? 0,
    );
    const data = at + 8;
    if (type === 'IHDR') {
      header = {
        width: view.getUint32(data),
        height: view.getUint32(data + 4),
        bitDepth: bytes[data + 8] ?? 0,
        colourType: bytes[data + 9] ?? 0,
      };
    } else if (type === 'pHYs' && bytes[data + 8] === 1) {
      phys = { x: view.getUint32(data), y: view.getUint32(data + 4) };
    } else if (type === 'IEND') break;
    at = data + length + 4;
  }
  if (!header) throw new Error('the PNG has no IHDR');
  return phys ? { ...header, pixelsPerMetreX: phys.x, pixelsPerMetreY: phys.y } : header;
}

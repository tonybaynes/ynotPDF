/**
 * BMP writer (M92). In-house, because a Windows bitmap is a 14-byte file header, a 40-byte
 * `BITMAPINFOHEADER`, an optional palette and uncompressed bottom-up rows — there is no library
 * worth a dependency here.
 *
 * Three depths, matching the export dialog's colour row: 24-bit BGR, 8-bit greyscale through a
 * 256-entry grey palette, and 1-bit through a two-entry palette. Rows are padded to four bytes,
 * and are written **bottom-up** (a positive height), which is what every reader expects; the
 * top-down form with a negative height exists but is not universally supported.
 *
 * The resolution goes in `biXPelsPerMeter` / `biYPelsPerMeter`, so a 150 dpi export prints at the
 * size it was exported at.
 */

import type { GreyRaster, MonoRaster } from '../pixels';
import { dpiToMetre } from './png';

export interface BmpOptions {
  readonly dpi?: { readonly x: number; readonly y: number };
}

const FILE_HEADER = 14;
const INFO_HEADER = 40;

function build(
  width: number,
  height: number,
  bitCount: 1 | 8 | 24,
  palette: Uint8Array,
  rows: (y: number, out: Uint8Array) => void,
  options: BmpOptions,
): Uint8Array {
  const rowBits = width * bitCount;
  const stride = ((rowBits + 31) >> 5) * 4;
  const pixelsAt = FILE_HEADER + INFO_HEADER + palette.length;
  const size = pixelsAt + stride * height;
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  out[0] = 0x42; // 'B'
  out[1] = 0x4d; // 'M'
  view.setUint32(2, size, true);
  view.setUint32(10, pixelsAt, true);
  view.setUint32(14, INFO_HEADER, true);
  view.setInt32(18, width, true);
  view.setInt32(22, height, true);
  view.setUint16(26, 1, true); // planes
  view.setUint16(28, bitCount, true);
  view.setUint32(30, 0, true); // BI_RGB, uncompressed
  view.setUint32(34, stride * height, true);
  view.setInt32(38, options.dpi ? dpiToMetre(options.dpi.x) : 0, true);
  view.setInt32(42, options.dpi ? dpiToMetre(options.dpi.y) : 0, true);
  view.setUint32(46, palette.length / 4, true);
  view.setUint32(50, palette.length / 4, true);
  out.set(palette, FILE_HEADER + INFO_HEADER);
  const row = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    row.fill(0);
    rows(y, row);
    // Bottom-up: source row 0 is the last row in the file.
    out.set(row, pixelsAt + (height - 1 - y) * stride);
  }
  return out;
}

/** 24-bit BMP from RGBA pixels; the alpha channel is dropped. */
export function encodeBmpRgb(
  rgba: Uint8Array,
  width: number,
  height: number,
  options: BmpOptions = {},
): Uint8Array {
  return build(
    width,
    height,
    24,
    new Uint8Array(0),
    (y, row) => {
      const base = y * width * 4;
      for (let x = 0; x < width; x++) {
        row[x * 3] = rgba[base + x * 4 + 2] ?? 0;
        row[x * 3 + 1] = rgba[base + x * 4 + 1] ?? 0;
        row[x * 3 + 2] = rgba[base + x * 4] ?? 0;
      }
    },
    options,
  );
}

/** 8-bit BMP through a 256-entry grey palette. */
export function encodeBmpGrey(grey: GreyRaster, options: BmpOptions = {}): Uint8Array {
  const palette = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    palette[i * 4] = i;
    palette[i * 4 + 1] = i;
    palette[i * 4 + 2] = i;
  }
  return build(
    grey.width,
    grey.height,
    8,
    palette,
    (y, row) => {
      row.set(grey.data.subarray(y * grey.width, (y + 1) * grey.width));
    },
    options,
  );
}

/** 1-bit BMP; palette entry 0 is black and entry 1 is white, matching `MonoRaster`'s packing. */
export function encodeBmpMono(mono: MonoRaster, options: BmpOptions = {}): Uint8Array {
  const palette = new Uint8Array(2 * 4);
  palette[4] = 0xff;
  palette[5] = 0xff;
  palette[6] = 0xff;
  return build(
    mono.width,
    mono.height,
    1,
    palette,
    (y, row) => {
      row.set(mono.data.subarray(y * mono.stride, (y + 1) * mono.stride));
    },
    options,
  );
}

/** The header fields of a BMP, for tests. */
export interface BmpHeader {
  readonly width: number;
  readonly height: number;
  readonly bitCount: number;
  readonly pixelsPerMetreX: number;
  readonly pixelsPerMetreY: number;
  readonly paletteEntries: number;
}

export function readBmpHeader(bytes: Uint8Array): BmpHeader {
  if (bytes[0] !== 0x42 || bytes[1] !== 0x4d) throw new Error('not a BMP');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    width: view.getInt32(18, true),
    height: view.getInt32(22, true),
    bitCount: view.getUint16(28, true),
    pixelsPerMetreX: view.getInt32(38, true),
    pixelsPerMetreY: view.getInt32(42, true),
    paletteEntries: view.getUint32(46, true),
  };
}

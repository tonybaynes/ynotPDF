/**
 * TIFF writer (M92). In-house, and the brief asked for exactly this check first:
 *
 * > TIFF writer in-house or `utif` (encode) — verify multi-page support.
 *
 * **`utif` cannot write a multi-page TIFF.** `UTIF.encode(ifds)` builds the IFD chain inside a
 * fixed 20 000-byte array, and `UTIF.encodeImage` glues one image's pixels on at a hard-coded
 * strip offset of 1000 — so a second page has nowhere to put its strips. utif stays where M91
 * left it, decoding; this writes.
 *
 * What it writes: little-endian ("II"), one IFD per page chained through the next-IFD pointer,
 * one strip per page, and three sample layouts — 1-bit bilevel, 8-bit greyscale and 24-bit RGB.
 * Compression is None, PackBits (baseline TIFF 6), CCITT Group 4 for bilevel, or Deflate (tag 8, the Adobe extension every
 * reader worth the name supports, and what `pako` gives us for nothing). Resolution goes in
 * `XResolution` / `YResolution` with `ResolutionUnit = 2` (inches).
 *
 * Group 4 reuses M100's public encoder with unpacked samples; its TIFF photometric is WhiteIsZero.
 */

import { deflate } from 'pako';
import { encodeGroup4 } from '../../optimise';
import { monoToGrey } from '../pixels';
import { ExportFailed } from '../types';
import type { GreyRaster, MonoRaster } from '../pixels';
import { deflateLevel } from './png';

export type TiffCompression = 'none' | 'packbits' | 'deflate' | 'group4';

export interface TiffOptions {
  readonly compression?: TiffCompression;
  readonly dpi?: { readonly x: number; readonly y: number };
  /** zlib level for `deflate`, 0–9. */
  readonly level?: number;
}

/** One frame of a TIFF: pixels already reduced to the colour the file will hold. */
export type TiffFrame =
  | {
      readonly kind: 'rgb';
      readonly rgba: Uint8Array;
      readonly width: number;
      readonly height: number;
    }
  | { readonly kind: 'grey'; readonly grey: GreyRaster }
  | { readonly kind: 'mono'; readonly mono: MonoRaster };

const TAG = {
  imageWidth: 256,
  imageLength: 257,
  bitsPerSample: 258,
  compression: 259,
  photometric: 262,
  fillOrder: 266,
  stripOffsets: 273,
  samplesPerPixel: 277,
  rowsPerStrip: 278,
  stripByteCounts: 279,
  xResolution: 282,
  yResolution: 283,
  planarConfig: 284,
  t6Options: 293,
  resolutionUnit: 296,
  sampleFormat: 339,
} as const;

const TYPE = { short: 3, long: 4, rational: 5 } as const;

const COMPRESSION_CODE: Readonly<Record<TiffCompression, number>> = {
  none: 1,
  packbits: 32773,
  deflate: 8,
  group4: 4,
};

interface Entry {
  readonly tag: number;
  readonly type: number;
  readonly count: number;
  /** Values as numbers; a rational is two numbers (numerator, denominator). */
  readonly values: ReadonlyArray<number>;
}

/**
 * PackBits run-length encoding (TIFF 6 §9). Literal runs are `n-1` followed by `n` bytes; repeat
 * runs are `257-n` followed by the byte. Rows are encoded independently, as the specification
 * requires, so a decoder that resets at every row boundary still reads it.
 */
export function packBits(row: Uint8Array): Uint8Array {
  const out: number[] = [];
  let i = 0;
  while (i < row.length) {
    let run = 1;
    while (i + run < row.length && row[i + run] === row[i] && run < 128) run++;
    if (run >= 2) {
      out.push(257 - run, row[i] ?? 0);
      i += run;
      continue;
    }
    // A literal run ends where a run of three identical bytes begins.
    let literal = 1;
    while (
      i + literal < row.length &&
      literal < 128 &&
      !(
        i + literal + 2 < row.length &&
        row[i + literal] === row[i + literal + 1] &&
        row[i + literal] === row[i + literal + 2]
      )
    ) {
      literal++;
    }
    out.push(literal - 1);
    for (let k = 0; k < literal; k++) out.push(row[i + k] ?? 0);
    i += literal;
  }
  return Uint8Array.from(out);
}

/** The frame's rows as the file stores them, before compression. */
function frameRows(frame: TiffFrame): {
  width: number;
  height: number;
  stride: number;
  bitsPerSample: number[];
  samplesPerPixel: number;
  photometric: number;
  row: (y: number, out: Uint8Array) => void;
} {
  if (frame.kind === 'rgb') {
    return {
      width: frame.width,
      height: frame.height,
      stride: frame.width * 3,
      bitsPerSample: [8, 8, 8],
      samplesPerPixel: 3,
      photometric: 2, // RGB
      row: (y, out) => {
        const base = y * frame.width * 4;
        for (let x = 0; x < frame.width; x++) {
          out[x * 3] = frame.rgba[base + x * 4] ?? 0;
          out[x * 3 + 1] = frame.rgba[base + x * 4 + 1] ?? 0;
          out[x * 3 + 2] = frame.rgba[base + x * 4 + 2] ?? 0;
        }
      },
    };
  }
  if (frame.kind === 'grey') {
    return {
      width: frame.grey.width,
      height: frame.grey.height,
      stride: frame.grey.width,
      bitsPerSample: [8],
      samplesPerPixel: 1,
      photometric: 1, // BlackIsZero
      row: (y, out) => {
        out.set(frame.grey.data.subarray(y * frame.grey.width, (y + 1) * frame.grey.width));
      },
    };
  }
  return {
    width: frame.mono.width,
    height: frame.mono.height,
    stride: frame.mono.stride,
    bitsPerSample: [1],
    samplesPerPixel: 1,
    photometric: 1, // BlackIsZero: a set bit is white, matching MonoRaster
    row: (y, out) => {
      out.set(frame.mono.data.subarray(y * frame.mono.stride, (y + 1) * frame.mono.stride));
    },
  };
}

/**
 * Writes one TIFF holding every frame, in order.
 *
 * The layout is: header, then for each frame its strip, its IFD and its extra tag values —
 * strips first so the IFD can point at bytes that are already placed. Every IFD's "next IFD"
 * pointer is filled in once the following one has been positioned.
 */
export function encodeTiff(
  frames: ReadonlyArray<TiffFrame>,
  options: TiffOptions = {},
): Uint8Array {
  if (frames.length === 0) throw new Error('a TIFF needs at least one frame');
  const compression = options.compression ?? 'deflate';
  if (compression === 'group4' && frames.some((frame) => frame.kind !== 'mono')) {
    throw new ExportFailed('CCITT Group 4 requires black and white (1-bit) TIFF pages.');
  }
  const code = COMPRESSION_CODE[compression];
  const strips: Uint8Array[] = [];
  for (const frame of frames) {
    if (compression === 'group4' && frame.kind === 'mono') {
      // Ignore packed-row padding; the encoder takes one 0/255 sample per real pixel.
      strips.push(encodeGroup4({ ...monoToGrey(frame.mono), components: 1 }));
      continue;
    }
    const shape = frameRows(frame);
    const raw = new Uint8Array(shape.stride * shape.height);
    const row = new Uint8Array(shape.stride);
    for (let y = 0; y < shape.height; y++) {
      row.fill(0);
      shape.row(y, row);
      raw.set(row, y * shape.stride);
    }
    if (compression === 'none') {
      strips.push(raw);
    } else if (compression === 'deflate') {
      strips.push(deflate(raw, { level: deflateLevel(options.level) }));
    } else {
      const rows: Uint8Array[] = [];
      let total = 0;
      for (let y = 0; y < shape.height; y++) {
        const packed = packBits(raw.subarray(y * shape.stride, (y + 1) * shape.stride));
        rows.push(packed);
        total += packed.length;
      }
      const joined = new Uint8Array(total);
      let at = 0;
      for (const r of rows) {
        joined.set(r, at);
        at += r.length;
      }
      strips.push(joined);
    }
  }

  // Lay the file out: 8-byte header, then per frame the strip, the IFD and its overflow values.
  let offset = 8;
  const stripOffsets: number[] = [];
  for (const strip of strips) {
    stripOffsets.push(offset);
    offset += strip.length;
    if (offset & 1) offset++; // IFDs must begin on a word boundary
  }
  const ifdOffsets: number[] = [];
  const ifds: Uint8Array[] = [];
  for (const [i, frame] of frames.entries()) {
    const shape = frameRows(frame);
    const dpi = options.dpi;
    const entries: Entry[] = [
      { tag: TAG.imageWidth, type: TYPE.long, count: 1, values: [shape.width] },
      { tag: TAG.imageLength, type: TYPE.long, count: 1, values: [shape.height] },
      {
        tag: TAG.bitsPerSample,
        type: TYPE.short,
        count: shape.bitsPerSample.length,
        values: shape.bitsPerSample,
      },
      { tag: TAG.compression, type: TYPE.short, count: 1, values: [code] },
      {
        tag: TAG.photometric,
        type: TYPE.short,
        count: 1,
        values: [compression === 'group4' ? 0 : shape.photometric],
      },
      ...(compression === 'group4'
        ? [
            { tag: TAG.fillOrder, type: TYPE.short, count: 1, values: [1] },
            { tag: TAG.t6Options, type: TYPE.long, count: 1, values: [0] },
          ]
        : []),
      { tag: TAG.stripOffsets, type: TYPE.long, count: 1, values: [stripOffsets[i] ?? 0] },
      { tag: TAG.samplesPerPixel, type: TYPE.short, count: 1, values: [shape.samplesPerPixel] },
      { tag: TAG.rowsPerStrip, type: TYPE.long, count: 1, values: [shape.height] },
      {
        tag: TAG.stripByteCounts,
        type: TYPE.long,
        count: 1,
        values: [strips[i]?.length ?? 0],
      },
      ...(dpi
        ? [
            { tag: TAG.xResolution, type: TYPE.rational, count: 1, values: [Math.round(dpi.x), 1] },
            { tag: TAG.yResolution, type: TYPE.rational, count: 1, values: [Math.round(dpi.y), 1] },
          ]
        : []),
      { tag: TAG.planarConfig, type: TYPE.short, count: 1, values: [1] },
      ...(dpi ? [{ tag: TAG.resolutionUnit, type: TYPE.short, count: 1, values: [2] }] : []),
      {
        tag: TAG.sampleFormat,
        type: TYPE.short,
        count: shape.samplesPerPixel,
        values: shape.bitsPerSample.map(() => 1),
      },
    ].sort((a, b) => a.tag - b.tag);
    const ifd = buildIfd(entries, offset);
    ifdOffsets.push(offset);
    ifds.push(ifd);
    offset += ifd.length;
    if (offset & 1) offset++;
  }

  const total = offset;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  out[0] = 0x49; // 'I'
  out[1] = 0x49; // 'I'
  view.setUint16(2, 42, true);
  view.setUint32(4, ifdOffsets[0] ?? 8, true);
  for (const [i, strip] of strips.entries()) out.set(strip, stripOffsets[i] ?? 0);
  for (const [i, ifd] of ifds.entries()) {
    const at = ifdOffsets[i] ?? 0;
    out.set(ifd, at);
    // The next-IFD pointer sits after the entries: 2 + 12·n.
    const count = view.getUint16(at, true);
    view.setUint32(at + 2 + 12 * count, ifdOffsets[i + 1] ?? 0, true);
  }
  return out;
}

/** One IFD as bytes, with values that do not fit in four bytes placed after the entries. */
function buildIfd(entries: ReadonlyArray<Entry>, base: number): Uint8Array {
  const sizes: Record<number, number> = { [TYPE.short]: 2, [TYPE.long]: 4, [TYPE.rational]: 8 };
  const directory = 2 + entries.length * 12 + 4;
  let overflow = directory;
  const overflowAt: number[] = [];
  for (const entry of entries) {
    const bytes = (sizes[entry.type] ?? 4) * entry.count;
    if (bytes > 4) {
      overflowAt.push(overflow);
      overflow += bytes;
    } else {
      overflowAt.push(-1);
    }
  }
  const out = new Uint8Array(overflow);
  const view = new DataView(out.buffer);
  view.setUint16(0, entries.length, true);
  entries.forEach((entry, i) => {
    const at = 2 + i * 12;
    view.setUint16(at, entry.tag, true);
    view.setUint16(at + 2, entry.type, true);
    view.setUint32(at + 4, entry.count, true);
    const place = overflowAt[i] ?? -1;
    if (place >= 0) {
      view.setUint32(at + 8, base + place, true);
      writeValues(view, place, entry);
    } else {
      writeValues(view, at + 8, entry);
    }
  });
  return out;
}

function writeValues(view: DataView, at: number, entry: Entry): void {
  if (entry.type === TYPE.short) {
    entry.values.forEach((v, i) => {
      view.setUint16(at + i * 2, v, true);
    });
  } else if (entry.type === TYPE.long) {
    entry.values.forEach((v, i) => {
      view.setUint32(at + i * 4, v, true);
    });
  } else {
    for (let i = 0; i < entry.values.length; i += 2) {
      view.setUint32(at + i * 4, entry.values[i] ?? 0, true);
      view.setUint32(at + i * 4 + 4, entry.values[i + 1] ?? 1, true);
    }
  }
}

/** One frame's tags as a reader sees them, for tests. */
export interface TiffFrameHeader {
  readonly width: number;
  readonly height: number;
  readonly bitsPerSample: ReadonlyArray<number>;
  readonly samplesPerPixel: number;
  readonly compression: number;
  readonly photometric: number;
  readonly xResolution: number | null;
  readonly yResolution: number | null;
  readonly resolutionUnit: number | null;
  readonly stripOffset: number;
  readonly stripByteCount: number;
}

/**
 * Reads every IFD of a little-endian TIFF. Deliberately minimal — enough to prove that the frames
 * are there, that they are chained, and that each one says what it should.
 */
export function readTiffFrames(bytes: Uint8Array): TiffFrameHeader[] {
  if (bytes[0] !== 0x49 || bytes[1] !== 0x49) throw new Error('not a little-endian TIFF');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint16(2, true) !== 42) throw new Error('not a TIFF');
  const frames: TiffFrameHeader[] = [];
  let at = view.getUint32(4, true);
  const seen = new Set<number>();
  while (at !== 0 && at + 2 <= bytes.length && !seen.has(at)) {
    seen.add(at);
    const count = view.getUint16(at, true);
    const values = new Map<number, number[]>();
    for (let i = 0; i < count; i++) {
      const entry = at + 2 + i * 12;
      const tag = view.getUint16(entry, true);
      const type = view.getUint16(entry + 2, true);
      const n = view.getUint32(entry + 4, true);
      const size = type === TYPE.short ? 2 : type === TYPE.rational ? 8 : 4;
      const place = size * n > 4 ? view.getUint32(entry + 8, true) : entry + 8;
      const out: number[] = [];
      for (let k = 0; k < n; k++) {
        if (type === TYPE.short) out.push(view.getUint16(place + k * 2, true));
        else if (type === TYPE.rational) {
          const num = view.getUint32(place + k * 8, true);
          const den = view.getUint32(place + k * 8 + 4, true) || 1;
          out.push(num / den);
        } else out.push(view.getUint32(place + k * 4, true));
      }
      values.set(tag, out);
    }
    const one = (tag: number): number | null => values.get(tag)?.[0] ?? null;
    frames.push({
      width: one(TAG.imageWidth) ?? 0,
      height: one(TAG.imageLength) ?? 0,
      bitsPerSample: values.get(TAG.bitsPerSample) ?? [],
      samplesPerPixel: one(TAG.samplesPerPixel) ?? 1,
      compression: one(TAG.compression) ?? 1,
      photometric: one(TAG.photometric) ?? 1,
      xResolution: one(TAG.xResolution),
      yResolution: one(TAG.yResolution),
      resolutionUnit: one(TAG.resolutionUnit),
      stripOffset: one(TAG.stripOffsets) ?? 0,
      stripByteCount: one(TAG.stripByteCounts) ?? 0,
    });
    at = view.getUint32(at + 2 + count * 12, true);
  }
  return frames;
}

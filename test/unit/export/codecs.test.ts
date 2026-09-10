/**
 * The four image writers (M92), each proved against a picture the test drew itself: the bytes are
 * decoded back and compared pixel for pixel, so a header field that lies shows up here rather
 * than in an image viewer.
 *
 * The PNG and JPEG decoders used to read them back are the ones the repository already has —
 * `pako` for PNG's IDAT and `jpeg-js` for JPEG — so a round trip is not this module marking its
 * own homework with its own arithmetic.
 */

import { describe, expect, it } from 'vitest';
import { inflate } from 'pako';
import { decode as decodeJpeg } from 'jpeg-js';
import {
  encodeBmpGrey,
  encodeBmpMono,
  encodeBmpRgb,
  encodeJpeg,
  encodePngGrey,
  encodePngMono,
  encodePngRgb,
  encodeTiff,
  packBits,
  readBmpHeader,
  readJfifDensity,
  readJpegSize,
  readPngHeader,
  readTiffFrames,
} from '@engine/export';
import { toGrey, toMono } from '@engine/export/pixels';

/** A test picture: a red-to-blue gradient with a black diagonal, so no filter is trivially best. */
function gradient(width: number, height: number): Uint8Array {
  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * 4;
      const diagonal = Math.abs(x - y) < 2;
      out[at] = diagonal ? 0 : Math.round((x / Math.max(1, width - 1)) * 255);
      out[at + 1] = diagonal ? 0 : 0x40;
      out[at + 2] = diagonal ? 0 : Math.round((y / Math.max(1, height - 1)) * 255);
      out[at + 3] = 255;
    }
  }
  return out;
}

/** Undoes PNG's per-row filtering, so the pixels can be compared with what went in. */
function decodePngPixels(bytes: Uint8Array): {
  width: number;
  height: number;
  bitDepth: number;
  colourType: number;
  rows: Uint8Array[];
} {
  const header = readPngHeader(bytes);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 8;
  const idat: Uint8Array[] = [];
  while (at + 8 <= bytes.length) {
    const length = view.getUint32(at);
    const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    if (type === 'IDAT') idat.push(bytes.subarray(at + 8, at + 8 + length));
    if (type === 'IEND') break;
    at += 12 + length;
  }
  const joined = new Uint8Array(idat.reduce((n, c) => n + c.length, 0));
  let offset = 0;
  for (const chunk of idat) {
    joined.set(chunk, offset);
    offset += chunk.length;
  }
  const raw = inflate(joined);
  const samples = header.colourType === 2 ? 3 : 1;
  const rowBytes = Math.ceil((header.width * samples * header.bitDepth) / 8);
  const bpp = Math.max(1, Math.ceil((samples * header.bitDepth) / 8));
  const rows: Uint8Array[] = [];
  let previous = new Uint8Array(rowBytes);
  for (let y = 0; y < header.height; y++) {
    const filter = raw[y * (rowBytes + 1)] ?? 0;
    const row = new Uint8Array(rowBytes);
    for (let i = 0; i < rowBytes; i++) {
      const value = raw[y * (rowBytes + 1) + 1 + i] ?? 0;
      const left = i >= bpp ? (row[i - bpp] ?? 0) : 0;
      const up = previous[i] ?? 0;
      const upLeft = i >= bpp ? (previous[i - bpp] ?? 0) : 0;
      let out: number;
      switch (filter) {
        case 1:
          out = value + left;
          break;
        case 2:
          out = value + up;
          break;
        case 3:
          out = value + ((left + up) >> 1);
          break;
        case 4: {
          const p = left + up - upLeft;
          const pa = Math.abs(p - left);
          const pb = Math.abs(p - up);
          const pc = Math.abs(p - upLeft);
          out = value + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft);
          break;
        }
        default:
          out = value;
      }
      row[i] = out & 0xff;
    }
    rows.push(row);
    previous = row;
  }
  return { ...header, rows };
}

describe('PNG', () => {
  it('round-trips truecolour pixels exactly, whatever the filter chose', () => {
    const width = 37;
    const height = 23;
    const rgba = gradient(width, height);
    const png = encodePngRgb(rgba, width, height);
    const decoded = decodePngPixels(png);
    expect(decoded.width).toBe(width);
    expect(decoded.height).toBe(height);
    expect(decoded.colourType).toBe(2);
    expect(decoded.bitDepth).toBe(8);
    for (let y = 0; y < height; y++) {
      const row = decoded.rows[y] ?? new Uint8Array(0);
      for (let x = 0; x < width; x++) {
        expect([row[x * 3], row[x * 3 + 1], row[x * 3 + 2]]).toEqual([
          rgba[(y * width + x) * 4],
          rgba[(y * width + x) * 4 + 1],
          rgba[(y * width + x) * 4 + 2],
        ]);
      }
    }
  });

  it('records the resolution in pHYs, in dots per metre', () => {
    const png = encodePngRgb(gradient(4, 4), 4, 4, { dpi: { x: 150, y: 150 } });
    const header = readPngHeader(png);
    // 150 / 0.0254 = 5905.5…
    expect(header.pixelsPerMetreX).toBe(5906);
    expect(header.pixelsPerMetreY).toBe(5906);
  });

  it('writes no pHYs when no resolution was asked for', () => {
    expect(readPngHeader(encodePngRgb(gradient(4, 4), 4, 4)).pixelsPerMetreX).toBeUndefined();
  });

  it('writes 8-bit grey as colour type 0', () => {
    const grey = toGrey({ data: gradient(9, 5), width: 9, height: 5 });
    const decoded = decodePngPixels(encodePngGrey(grey));
    expect([decoded.colourType, decoded.bitDepth]).toEqual([0, 8]);
    for (let y = 0; y < 5; y++) {
      expect([...(decoded.rows[y] ?? [])]).toEqual([...grey.data.subarray(y * 9, y * 9 + 9)]);
    }
  });

  it('writes 1-bit mono as colour type 0 at depth 1, a set bit meaning white', () => {
    const grey = toGrey({ data: gradient(17, 3), width: 17, height: 3 });
    const mono = toMono(grey, { threshold: 128, dither: 'none' });
    const decoded = decodePngPixels(encodePngMono(mono));
    expect([decoded.colourType, decoded.bitDepth, decoded.width]).toEqual([0, 1, 17]);
    expect(decoded.rows[0]?.length).toBe(3); // ceil(17 / 8)
    for (let y = 0; y < 3; y++) {
      expect([...(decoded.rows[y] ?? [])]).toEqual([
        ...mono.data.subarray(y * mono.stride, (y + 1) * mono.stride),
      ]);
    }
  });

  it('compresses harder at level 9 than at level 0', () => {
    const rgba = gradient(200, 200);
    const loose = encodePngRgb(rgba, 200, 200, { level: 0 });
    const tight = encodePngRgb(rgba, 200, 200, { level: 9 });
    expect(tight.length).toBeLessThan(loose.length);
  });
});

describe('JPEG', () => {
  it('encodes pixels a decoder reads back at the right size and roughly the right colour', () => {
    const rgba = gradient(32, 16);
    const jpeg = encodeJpeg(rgba, 32, 16, { quality: 95 });
    expect(readJpegSize(jpeg)).toEqual({ width: 32, height: 16 });
    const decoded = decodeJpeg(jpeg, { useTArray: true });
    expect([decoded.width, decoded.height]).toEqual([32, 16]);
    // A corner well away from the black diagonal, within JPEG's own error.
    const at = (8 * 32 + 28) * 4;
    expect(Math.abs((decoded.data[at] ?? 0) - (rgba[at] ?? 0))).toBeLessThan(24);
  });

  it('writes the resolution into the JFIF APP0', () => {
    const jpeg = encodeJpeg(gradient(16, 16), 16, 16, { dpi: { x: 150, y: 300 } });
    expect(readJfifDensity(jpeg)).toEqual({ x: 150, y: 300 });
  });

  it('says nothing about resolution when none was asked for', () => {
    // jpeg-js writes units 0 (aspect ratio only), which is not a resolution.
    expect(readJfifDensity(encodeJpeg(gradient(16, 16), 16, 16))).toBeNull();
  });

  it('is smaller at low quality than at high', () => {
    const rgba = gradient(64, 64);
    expect(encodeJpeg(rgba, 64, 64, { quality: 20 }).length).toBeLessThan(
      encodeJpeg(rgba, 64, 64, { quality: 95 }).length,
    );
  });
});

describe('BMP', () => {
  /** A BMP's rows, top-down, undoing the bottom-up storage and the four-byte padding. */
  function bmpRows(bytes: Uint8Array): Uint8Array[] {
    const header = readBmpHeader(bytes);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const start = view.getUint32(10, true);
    const stride = ((header.width * header.bitCount + 31) >> 5) * 4;
    const rows: Uint8Array[] = [];
    for (let y = 0; y < header.height; y++) {
      const at = start + (header.height - 1 - y) * stride;
      rows.push(bytes.subarray(at, at + stride));
    }
    return rows;
  }

  it('writes 24-bit BGR bottom-up with padded rows and the resolution in the header', () => {
    const rgba = gradient(5, 3);
    const bmp = encodeBmpRgb(rgba, 5, 3, { dpi: { x: 96, y: 96 } });
    const header = readBmpHeader(bmp);
    expect([header.width, header.height, header.bitCount]).toEqual([5, 3, 24]);
    expect(header.pixelsPerMetreX).toBe(3780); // 96 / 0.0254
    expect(header.paletteEntries).toBe(0);
    const rows = bmpRows(bmp);
    expect(rows[0]?.length).toBe(16); // 5 × 3 = 15, padded to 16
    for (let y = 0; y < 3; y++) {
      for (let x = 0; x < 5; x++) {
        const row = rows[y] ?? new Uint8Array(0);
        expect([row[x * 3 + 2], row[x * 3 + 1], row[x * 3]]).toEqual([
          rgba[(y * 5 + x) * 4],
          rgba[(y * 5 + x) * 4 + 1],
          rgba[(y * 5 + x) * 4 + 2],
        ]);
      }
    }
  });

  it('writes 8-bit grey through a 256-entry grey palette', () => {
    const grey = toGrey({ data: gradient(6, 2), width: 6, height: 2 });
    const header = readBmpHeader(encodeBmpGrey(grey));
    expect([header.bitCount, header.paletteEntries]).toEqual([8, 256]);
  });

  it('writes 1-bit mono through a two-entry palette, entry 1 being white', () => {
    const mono = toMono(toGrey({ data: gradient(12, 2), width: 12, height: 2 }), {
      threshold: 128,
      dither: 'none',
    });
    const bmp = encodeBmpMono(mono);
    const header = readBmpHeader(bmp);
    expect([header.bitCount, header.paletteEntries]).toEqual([1, 2]);
    const view = new DataView(bmp.buffer, bmp.byteOffset, bmp.byteLength);
    const palette = 14 + 40;
    expect([bmp[palette], bmp[palette + 1], bmp[palette + 2]]).toEqual([0, 0, 0]);
    expect([bmp[palette + 4], bmp[palette + 5], bmp[palette + 6]]).toEqual([255, 255, 255]);
    expect(view.getUint32(10, true)).toBe(palette + 8);
  });
});

describe('PackBits', () => {
  it('shortens a run and leaves a literal alone', () => {
    expect([...packBits(Uint8Array.from([7, 7, 7, 7, 7]))]).toEqual([252, 7]);
    expect([...packBits(Uint8Array.from([1, 2, 3]))]).toEqual([2, 1, 2, 3]);
  });

  it('round-trips every byte of a mixed row', () => {
    const row = Uint8Array.from([1, 1, 1, 4, 5, 6, 6, 6, 6, 9, 8, 8, 8, 8, 8, 8, 0]);
    const packed = packBits(row);
    const out: number[] = [];
    let i = 0;
    while (i < packed.length) {
      const n = packed[i] ?? 0;
      if (n < 128) {
        for (let k = 0; k <= n; k++) out.push(packed[i + 1 + k] ?? 0);
        i += 2 + n;
      } else {
        for (let k = 0; k < 257 - n; k++) out.push(packed[i + 1] ?? 0);
        i += 2;
      }
    }
    expect(out).toEqual([...row]);
  });
});

describe('TIFF', () => {
  /** One frame's pixel bytes, undoing whichever compression it declares. */
  function frameBytes(tiff: Uint8Array, index: number): Uint8Array {
    const frames = readTiffFrames(tiff);
    const frame = frames[index];
    if (!frame) throw new Error(`the TIFF has no frame ${String(index + 1)}`);
    const strip = tiff.subarray(frame.stripOffset, frame.stripOffset + frame.stripByteCount);
    if (frame.compression === 1) return strip;
    if (frame.compression === 8) return inflate(strip);
    const out: number[] = [];
    let i = 0;
    while (i < strip.length) {
      const n = strip[i] ?? 0;
      if (n < 128) {
        for (let k = 0; k <= n; k++) out.push(strip[i + 1 + k] ?? 0);
        i += 2 + n;
      } else {
        for (let k = 0; k < 257 - n; k++) out.push(strip[i + 1] ?? 0);
        i += 2;
      }
    }
    return Uint8Array.from(out);
  }

  it('chains three frames in one file, each with its own size', () => {
    const tiff = encodeTiff([
      { kind: 'rgb', rgba: gradient(4, 3), width: 4, height: 3 },
      { kind: 'grey', grey: toGrey({ data: gradient(6, 2), width: 6, height: 2 }) },
      {
        kind: 'mono',
        mono: toMono(toGrey({ data: gradient(9, 5), width: 9, height: 5 }), {
          threshold: 128,
          dither: 'none',
        }),
      },
    ]);
    const frames = readTiffFrames(tiff);
    expect(frames).toHaveLength(3);
    expect(frames.map((f) => [f.width, f.height])).toEqual([
      [4, 3],
      [6, 2],
      [9, 5],
    ]);
    expect(frames.map((f) => f.samplesPerPixel)).toEqual([3, 1, 1]);
    expect(frames.map((f) => [...f.bitsPerSample])).toEqual([[8, 8, 8], [8], [1]]);
    expect(frames.map((f) => f.photometric)).toEqual([2, 1, 1]);
  });

  it('round-trips RGB pixels through each compression', () => {
    const rgba = gradient(11, 7);
    for (const compression of ['none', 'packbits', 'deflate'] as const) {
      const tiff = encodeTiff([{ kind: 'rgb', rgba, width: 11, height: 7 }], { compression });
      const bytes = frameBytes(tiff, 0);
      expect(bytes.length, compression).toBe(11 * 7 * 3);
      for (let i = 0; i < 11 * 7; i++) {
        expect(
          [bytes[i * 3], bytes[i * 3 + 1], bytes[i * 3 + 2]],
          `${compression} pixel ${String(i)}`,
        ).toEqual([rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]]);
      }
    }
  });

  it('records the resolution in inches', () => {
    const tiff = encodeTiff([{ kind: 'rgb', rgba: gradient(4, 4), width: 4, height: 4 }], {
      dpi: { x: 150, y: 150 },
    });
    const frame = readTiffFrames(tiff)[0];
    expect([frame?.xResolution, frame?.yResolution, frame?.resolutionUnit]).toEqual([150, 150, 2]);
  });

  it('refuses to write a file with no frames', () => {
    expect(() => encodeTiff([])).toThrow(/at least one frame/);
  });
});

/**
 * Image headers, the awkward cases (M91).
 *
 * `images.test.ts` reads the fixtures; this file builds the headers no fixture has — HEIC and
 * WebP in their three flavours, a JFIF that measures in centimetres, EXIF in big-endian, a PNG
 * whose transparency is a `tRNS` chunk, a BMP with the old 12-byte header — because a header
 * parser is only as good as what it does with a file it has never seen.
 */

import { describe, expect, it } from 'vitest';
import { readHeader, sniffFormat, type ImageFormat } from '@engine/create/images/headers';

/** A little-endian buffer builder, so each case reads as the bytes it is. */
function bytes(...parts: ReadonlyArray<number | string | Uint8Array>): Uint8Array {
  const out: number[] = [];
  for (const part of parts) {
    if (typeof part === 'number') out.push(part & 0xff);
    else if (typeof part === 'string') for (const ch of part) out.push(ch.charCodeAt(0));
    else out.push(...part);
  }
  return Uint8Array.from(out);
}

const u16le = (n: number): Uint8Array => Uint8Array.from([n & 0xff, (n >> 8) & 0xff]);
const u16be = (n: number): Uint8Array => Uint8Array.from([(n >> 8) & 0xff, n & 0xff]);
const u32le = (n: number): Uint8Array =>
  Uint8Array.from([n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff]);
const u32be = (n: number): Uint8Array =>
  Uint8Array.from([(n >> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]);

const PNG_MAGIC = bytes(0x89, 'PNG', 0x0d, 0x0a, 0x1a, 0x0a);

/** A PNG with the chunks given, each `[type, payload]`; the CRCs are not read, so they are zero. */
function png(...chunks: ReadonlyArray<readonly [string, Uint8Array]>): Uint8Array {
  const parts: Uint8Array[] = [PNG_MAGIC];
  for (const [type, payload] of chunks) {
    parts.push(u32be(payload.length), bytes(type), payload, u32be(0));
  }
  return bytes(...parts);
}

function ihdr(width: number, height: number, colourType: number): readonly [string, Uint8Array] {
  return ['IHDR', bytes(u32be(width), u32be(height), 8, colourType, 0, 0, 0)];
}

/** A JPEG made of the markers given, after SOI. */
function jpeg(...segments: ReadonlyArray<readonly [number, Uint8Array]>): Uint8Array {
  const parts: Uint8Array[] = [bytes(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10)];
  // The opening APP0 above is a JFIF-less filler so the magic bytes are right; skip its payload.
  parts.push(bytes('JFIF', 0, 1, 1, 0, u16be(1), u16be(1), 0, 0));
  for (const [marker, payload] of segments) {
    parts.push(bytes(0xff, marker), u16be(payload.length + 2), payload);
  }
  parts.push(bytes(0xff, 0xd9));
  return bytes(...parts);
}

describe('sniffing', () => {
  it('knows a HEIC and an AVIF by their brand, and refuses another ftyp box', () => {
    const heic = bytes(u32be(24), 'ftyp', 'heic', u32be(0), 'mif1heic');
    expect(sniffFormat(heic)).toBe('heic');
    const avif = bytes(u32be(24), 'ftyp', 'avif', u32be(0), 'mif1avif');
    expect(sniffFormat(avif)).toBe('heic');
    const mp4 = bytes(u32be(24), 'ftyp', 'isom', u32be(0), 'isomiso2');
    expect(sniffFormat(mp4)).toBe('unknown');
  });

  it('knows a big-endian TIFF as well as a little-endian one', () => {
    expect(sniffFormat(bytes(0x4d, 0x4d, 0x00, 0x2a, u32be(8)))).toBe('tiff');
    expect(sniffFormat(bytes(0x49, 0x49, 0x2a, 0x00, u32le(8)))).toBe('tiff');
    expect(sniffFormat(bytes(0x49, 0x49, 0x2b, 0x00))).toBe('unknown');
  });

  it('needs the whole RIFF/WEBP pair, not just RIFF', () => {
    expect(sniffFormat(bytes('RIFF', u32le(20), 'WEBPVP8 '))).toBe('webp');
    expect(sniffFormat(bytes('RIFF', u32le(20), 'WAVEfmt '))).toBe('unknown');
  });

  it('says nothing about a HEIC beyond its format, because nothing else is readable here', () => {
    const heic = bytes(u32be(24), 'ftyp', 'heic', u32be(0), 'mif1heic');
    expect(readHeader(heic)).toEqual({ format: 'heic', orientation: 1 });
  });
});

describe('PNG', () => {
  it('takes transparency from a tRNS chunk on a palette image', () => {
    const file = png(ihdr(10, 20, 3), ['tRNS', bytes(0, 1, 2)], ['IDAT', bytes(0)]);
    expect(readHeader(file)).toMatchObject({ width: 10, height: 20, hasAlpha: true });
  });

  it('ignores a pHYs in metres and one that measures nothing', () => {
    const unitless = png(
      ihdr(4, 4, 2),
      ['pHYs', bytes(u32be(2835), u32be(2835), 0)],
      ['IDAT', bytes(0)],
    );
    expect(readHeader(unitless).dpiX).toBeUndefined();
    const zero = png(ihdr(4, 4, 2), ['pHYs', bytes(u32be(0), u32be(0), 1)], ['IDAT', bytes(0)]);
    expect(readHeader(zero).dpiX).toBeUndefined();
  });

  it('stops at IEND and survives a truncated chunk', () => {
    const ended = png(ihdr(4, 4, 6), ['IEND', bytes()]);
    expect(readHeader(ended)).toMatchObject({ width: 4, hasAlpha: true });
    const cut = bytes(PNG_MAGIC, u32be(13), 'IHDR', bytes(0, 0));
    expect(readHeader(cut).format).toBe('png');
  });
});

describe('JPEG', () => {
  it('reads a JFIF density given in centimetres', () => {
    const file = bytes(
      0xff,
      0xd8,
      0xff,
      0xe0,
      u16be(16),
      'JFIF',
      0,
      1,
      1,
      2,
      u16be(100),
      u16be(100),
      0,
      0,
      0xff,
      0xc0,
      u16be(11),
      8,
      u16be(50),
      u16be(60),
      1,
      0xff,
      0xd9,
    );
    const header = readHeader(file);
    expect(header.dpiX).toBeCloseTo(254, 0);
    expect(header).toMatchObject({ width: 60, height: 50 });
  });

  it('skips padding bytes, restart markers and a segment it does not know', () => {
    const file = bytes(
      0xff,
      0xd8,
      0xff,
      0xff, // a fill byte
      0xff,
      0xd0, // a restart marker: no payload
      0xff,
      0xfe,
      u16be(4),
      0x41,
      0x42, // a comment
      0xff,
      0xc2, // progressive SOF
      u16be(11),
      8,
      u16be(30),
      u16be(40),
      1,
      0xff,
      0xda, // SOS: the header is over
      u16be(2),
      0xff,
      0xd9,
    );
    expect(readHeader(file)).toMatchObject({ format: 'jpeg', width: 40, height: 30 });
  });

  it('prefers the camera EXIF resolution to the encoder JFIF one, in either byte order', () => {
    // IFD0: XResolution and YResolution as RATIONAL 300/1, ResolutionUnit inches.
    const exifLittle = bytes(
      'Exif',
      0,
      0,
      'II',
      u16le(42),
      u32le(8),
      u16le(3),
      u16le(0x011a),
      u16le(5),
      u32le(1),
      u32le(50),
      u16le(0x011b),
      u16le(5),
      u32le(1),
      u32le(58),
      u16le(0x0128),
      u16le(3),
      u32le(1),
      u32le(2),
      u32le(0),
      u32le(300),
      u32le(1),
      u32le(300),
      u32le(1),
    );
    expect(readHeader(jpeg([0xe1, exifLittle])).dpiX).toBe(300);

    const exifBig = bytes(
      'Exif',
      0,
      0,
      'MM',
      u16be(42),
      u32be(8),
      u16be(2),
      u16be(0x0112),
      u16be(3),
      u32be(1),
      u16be(8),
      u16be(0),
      u16be(0x0128),
      u16be(3),
      u32be(1),
      u16be(2),
      u16be(0),
      u32be(0),
    );
    expect(readHeader(jpeg([0xe1, exifBig])).orientation).toBe(8);
  });

  it('ignores EXIF that is malformed, out of range or measured in centimetres', () => {
    const notTiff = bytes('Exif', 0, 0, 'XX', u16le(42), u32le(8));
    expect(readHeader(jpeg([0xe1, notTiff])).orientation).toBe(1);
    const badMagic = bytes('Exif', 0, 0, 'II', u16le(43), u32le(8), u16le(0));
    expect(readHeader(jpeg([0xe1, badMagic])).orientation).toBe(1);
    const badOrientation = bytes(
      'Exif',
      0,
      0,
      'II',
      u16le(42),
      u32le(8),
      u16le(1),
      u16le(0x0112),
      u16le(3),
      u32le(1),
      u32le(99),
      u32le(0),
    );
    expect(readHeader(jpeg([0xe1, badOrientation])).orientation).toBe(1);
    // ResolutionUnit 3 is centimetres: 100 per cm is 254 dpi.
    const centimetres = bytes(
      'Exif',
      0,
      0,
      'II',
      u16le(42),
      u32le(8),
      u16le(3),
      u16le(0x011a),
      u16le(5),
      u32le(1),
      u32le(50),
      u16le(0x011b),
      u16le(5),
      u32le(1),
      u32le(58),
      u16le(0x0128),
      u16le(3),
      u32le(1),
      u32le(3),
      u32le(0),
      u32le(100),
      u32le(1),
      u32le(100),
      u32le(1),
    );
    expect(readHeader(jpeg([0xe1, centimetres])).dpiX).toBeCloseTo(254, 0);
  });
});

describe('TIFF', () => {
  /** A TIFF whose single IFD holds the tags given as `[tag, type, value]`. */
  function tiff(
    tags: ReadonlyArray<readonly [number, number, number]>,
    extra: Uint8Array = bytes(),
  ): Uint8Array {
    const entries: Uint8Array[] = [];
    for (const [tag, type, value] of tags) {
      entries.push(
        bytes(
          u16le(tag),
          u16le(type),
          u32le(1),
          type === 3 ? bytes(u16le(value), u16le(0)) : u32le(value),
        ),
      );
    }
    return bytes(
      'II',
      u16le(42),
      u32le(8),
      u16le(tags.length),
      ...entries,
      u32le(0), // no next IFD
      extra,
    );
  }

  it('reads width, height, orientation and a resolution in centimetres', () => {
    const offset = 8 + 2 + 5 * 12 + 4;
    const file = tiff(
      [
        [256, 3, 40],
        [257, 3, 30],
        [274, 3, 6],
        [296, 3, 3],
        [282, 5, offset],
      ],
      bytes(u32le(100), u32le(1)),
    );
    expect(readHeader(file)).toMatchObject({
      format: 'tiff',
      width: 40,
      height: 30,
      orientation: 6,
      pages: 1,
    });
    expect(readHeader(file).dpiX).toBeCloseTo(254, 0);
  });

  it('reads a LONG width as well as a SHORT one, and ignores an orientation out of range', () => {
    const file = tiff([
      [256, 4, 1000],
      [257, 4, 800],
      [274, 3, 42],
    ]);
    expect(readHeader(file)).toMatchObject({ width: 1000, height: 800, orientation: 1 });
  });

  it('ignores a resolution whose denominator is zero', () => {
    const offset = 8 + 2 + 12 + 4;
    const file = tiff([[282, 5, offset]], bytes(u32le(100), u32le(0)));
    expect(readHeader(file).dpiX).toBeUndefined();
  });

  it('does not loop for ever on a directory chain that points at itself', () => {
    const file = bytes('II', u16le(42), u32le(8), u16le(0), u32le(8));
    expect(readHeader(file).pages).toBe(1);
  });
});

describe('GIF, BMP and WebP', () => {
  it('reads a GIF screen size', () => {
    const gif = bytes('GIF89a', u16le(64), u16le(48), 0, 0, 0);
    expect(readHeader(gif)).toMatchObject({ format: 'gif', width: 64, height: 48 });
  });

  it('reads the old 12-byte BMP header and a top-down bitmap', () => {
    const core = bytes('BM', u32le(30), u32le(0), u32le(26), u32le(12), u16le(20), u16le(10));
    expect(readHeader(core)).toMatchObject({ format: 'bmp', width: 20, height: 10 });
    const topDown = bytes(
      'BM',
      u32le(70),
      u32le(0),
      u32le(54),
      u32le(40),
      u32le(32),
      u32le(-24 >>> 0),
      u16le(1),
      u16le(24),
      u32le(0),
      u32le(0),
      u32le(3780),
      u32le(3780),
      u32le(0),
      u32le(0),
    );
    const header = readHeader(topDown);
    expect(header).toMatchObject({ width: 32, height: 24 });
    expect(header.dpiX).toBeCloseTo(96, 0);
  });

  it('reads all three WebP flavours and gives up on a fourth', () => {
    const extended = bytes(
      'RIFF',
      u32le(40),
      'WEBP',
      'VP8X',
      u32le(10),
      0x10,
      0,
      0,
      0,
      99,
      0,
      0,
      74,
      0,
      0,
    );
    expect(readHeader(extended)).toMatchObject({
      format: 'webp',
      width: 100,
      height: 75,
      hasAlpha: true,
    });

    const lossless = bytes(
      'RIFF',
      u32le(30),
      'WEBP',
      'VP8L',
      u32le(12),
      0x2f,
      u32le(((1 << 28) | (49 << 14) | 63) >>> 0),
    );
    expect(readHeader(lossless)).toMatchObject({
      format: 'webp',
      width: 64,
      height: 50,
      hasAlpha: true,
    });

    const lossy = bytes(
      'RIFF',
      u32le(40),
      'WEBP',
      'VP8 ',
      u32le(20),
      0,
      0,
      0,
      0x9d,
      0x01,
      0x2a,
      u16le(80),
      u16le(60),
    );
    expect(readHeader(lossy)).toMatchObject({ format: 'webp', width: 80, height: 60 });

    const unknownChunk = bytes('RIFF', u32le(20), 'WEBP', 'ANIM', u32le(4), 0, 0, 0, 0);
    expect(readHeader(unknownChunk)).toEqual({ format: 'webp', orientation: 1 });
  });
});

describe('every format returns something', () => {
  it('never throws, whatever the bytes are', () => {
    const formats: ImageFormat[] = ['png', 'jpeg', 'tiff', 'gif', 'bmp', 'webp', 'heic', 'unknown'];
    const truncations = [
      PNG_MAGIC,
      bytes(0xff, 0xd8, 0xff),
      bytes('II', u16le(42)),
      bytes('GIF89'),
      bytes('BM'),
      bytes('RIFF', u32le(0), 'WEBP'),
      bytes(u32be(16), 'ftyp', 'heic'),
      bytes(0),
    ];
    for (const b of truncations) {
      const header = readHeader(b);
      expect(formats).toContain(header.format);
      expect(header.orientation).toBe(1);
    }
  });
});

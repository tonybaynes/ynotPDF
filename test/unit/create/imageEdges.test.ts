/**
 * The image path when things go wrong (M91).
 *
 * The fixtures cover the happy road; these are the turnings off it — a JPEG whose header is
 * readable but whose scan is not, a TIFF with a thumbnail directory in front of the real page,
 * a decoder that throws rather than declining, a raster that lies about its own size. Each one
 * has to end in a sentence a reader could act on, never in a blank page.
 */

import { PDFDocument } from 'pdf-lib';
import { describe, expect, it, vi } from 'vitest';
import { ImageConverter } from '@engine/create/images/ImageConverter';
import { embedRaster } from '@engine/create/images/raster';
import { decodeTiffPages } from '@engine/create/images/tiff';
import { ConvertUnsupported, type ConvertInput } from '@engine/create/types';

const converter = new ImageConverter();

/** A 2×2 red square with one translucent corner, as a decoded raster. */
const raster = {
  width: 2,
  height: 2,
  rgba: Uint8Array.from([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 10, 20, 30, 128]),
};

/** A PNG signature followed by nothing pdf-lib can read. */
const brokenPng: ConvertInput = {
  name: 'broken.png',
  bytes: Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52,
  ]),
};

/** A JPEG signature followed by nothing pdf-lib can read. */
const brokenJpeg: ConvertInput = {
  name: 'broken.jpg',
  bytes: Uint8Array.from([
    0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0,
  ]),
};

describe('a picture pdf-lib will not embed', () => {
  it('is decoded by the host instead, and the reader is told', async () => {
    const decoder = vi.fn().mockResolvedValue(raster);
    const result = await converter.convert([brokenPng], converter.defaults(), {
      env: { rasterDecoder: decoder },
    });
    expect(result.pageCount).toBe(1);
    expect(result.warnings[0]).toMatch(/broken\.png was decoded rather than embedded/);
    expect(decoder).toHaveBeenCalledOnce();
  });

  it('is refused in words when there is no host decoder either', async () => {
    await expect(
      converter.convert([brokenJpeg], converter.defaults(), { env: {} }),
    ).rejects.toMatchObject({
      name: 'ConvertUnsupported',
      reason: 'no-decoder',
    });
  });

  it('takes the same road for a JPEG', async () => {
    const result = await converter.convert([brokenJpeg], converter.defaults(), {
      env: { rasterDecoder: () => Promise.resolve(raster) },
    });
    expect(result.warnings[0]).toMatch(/broken\.jpg was decoded rather than embedded/);
  });
});

describe('a decoder that fails', () => {
  it('has its own words carried to the reader when it throws', async () => {
    const decoder = vi.fn().mockRejectedValue(new Error('the codec is not installed'));
    await expect(
      converter.convert(
        [
          {
            name: 'photo.heic',
            bytes: Uint8Array.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63]),
          },
        ],
        converter.defaults(),
        {
          env: { rasterDecoder: decoder },
        },
      ),
    ).rejects.toMatchObject({ reason: 'corrupt' });
    await expect(
      converter.convert([brokenPng], converter.defaults(), {
        env: { rasterDecoder: () => Promise.reject(new Error('the codec is not installed')) },
      }),
    ).rejects.toThrow(/the codec is not installed/);
  });

  it('names the format when it declines a picture it should know', async () => {
    await expect(
      converter.convert(
        [
          {
            name: 'x.webp',
            bytes: Uint8Array.from([0x52, 0x49, 0x46, 0x46, 4, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]),
          },
        ],
        converter.defaults(),
        {
          env: { rasterDecoder: () => Promise.resolve(null) },
        },
      ),
    ).rejects.toMatchObject({ reason: 'no-decoder' });
    await expect(
      converter.convert(
        [
          {
            name: 'x.webp',
            bytes: Uint8Array.from([0x52, 0x49, 0x46, 0x46, 4, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]),
          },
        ],
        converter.defaults(),
        {
          env: { rasterDecoder: () => Promise.resolve(null) },
        },
      ),
    ).rejects.toThrow(/WEBP/);
  });
});

describe('embedRaster', () => {
  it('refuses a raster that is shorter than its own size, or has none', async () => {
    const doc = await PDFDocument.create();
    expect(() => embedRaster(doc, { width: 4, height: 4, rgba: new Uint8Array(8) })).toThrow(
      /shorter than/,
    );
    expect(() => embedRaster(doc, { width: 0, height: 4, rgba: new Uint8Array(0) })).toThrow(
      /no size/,
    );
  });

  it('writes a soft mask only when a pixel is not opaque', async () => {
    const doc = await PDFDocument.create();
    const opaque = embedRaster(doc, { width: 1, height: 1, rgba: Uint8Array.from([1, 2, 3, 255]) });
    const translucent = embedRaster(doc, raster);
    const smaskOf = (ref: { toString(): string }): boolean =>
      JSON.stringify(doc.context.lookup(ref as never)?.toString() ?? '').includes('SMask');
    expect(smaskOf(opaque.ref)).toBe(false);
    expect(smaskOf(translucent.ref)).toBe(true);
  });
});

describe('TIFF directories', () => {
  /** A little-endian TIFF whose directories are described by the tag lists given. */
  function tiff(
    directories: ReadonlyArray<ReadonlyArray<readonly [number, number, number]>>,
  ): Uint8Array {
    const parts: number[] = [];
    const push16 = (n: number): void => {
      parts.push(n & 0xff, (n >> 8) & 0xff);
    };
    const push32 = (n: number): void => {
      parts.push(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff);
    };
    parts.push(0x49, 0x49);
    push16(42);
    push32(8);
    // Every directory is written one after another; each says where the next one is.
    const offsets: number[] = [];
    let at = 8;
    for (const tags of directories) {
      offsets.push(at);
      at += 2 + tags.length * 12 + 4;
    }
    for (const [index, tags] of directories.entries()) {
      push16(tags.length);
      for (const [tag, type, value] of tags) {
        push16(tag);
        push16(type);
        push32(1);
        if (type === 3) {
          push16(value);
          push16(0);
        } else push32(value);
      }
      push32(offsets[index + 1] ?? 0);
    }
    return Uint8Array.from(parts);
  }

  it('skips a thumbnail directory when there is a real page as well', () => {
    // A thumbnail (NewSubfileType bit 0) with no pixels, then a page with none either: the
    // thumbnail is skipped before it is decoded, and the page is the one that fails.
    const file = tiff([
      [
        [254, 4, 1],
        [256, 3, 8],
        [257, 3, 8],
      ],
      [
        [256, 3, 16],
        [257, 3, 16],
      ],
    ]);
    expect(() => decodeTiffPages(file, 'thumbs.tif')).toThrow(
      /Page 2 of thumbs\.tif|has no pixels/,
    );
  });

  it('keeps a lone thumbnail rather than producing nothing', () => {
    const file = tiff([
      [
        [254, 4, 1],
        [256, 3, 8],
        [257, 3, 8],
      ],
    ]);
    // It is not skipped (there is nothing else), so it fails on its missing pixels instead.
    expect(() => decodeTiffPages(file, 'thumb.tif')).toThrow(ConvertUnsupported);
  });

  it('says so when a directory has no pixels at all', () => {
    const file = tiff([[[256, 3, 0]]]);
    expect(() => decodeTiffPages(file, 'empty.tif')).toThrow(ConvertUnsupported);
  });

  it('names the file when the bytes are not a TIFF at all', () => {
    expect(() => decodeTiffPages(Uint8Array.from([0x49, 0x49, 0x2a, 0x00]))).toThrow(/the TIFF/);
  });
});

/**
 * Images → PDF (M91).
 *
 * The acceptance test — five mixed images become one document with the right page sizes and
 * orientations, a three-page TIFF becomes three pages — runs here against the real engine, so
 * what PDFium reports is what is asserted. The header parsers and the geometry are pure and
 * get their own cases.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PDFDict, PDFDocument, PDFName, PDFRawStream } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { ImageConverter } from '@engine/create/images/ImageConverter';
import { readHeader, sniffFormat, orientationSwaps } from '@engine/create/images/headers';
import { layoutImage, naturalSize, DEFAULT_IMAGE_LAYOUT } from '@engine/create/images/layout';
import { apply, orientationMatrix } from '@engine/create/images/raster';
import { decodeTiffPages } from '@engine/create/images/tiff';
import { ConvertUnsupported, type ConvertInput } from '@engine/create/types';
import { mmToPt } from '@shared/pdf';
import { engine, FIXTURES } from '../engine/helpers';

const CREATE = join(FIXTURES, 'create');

function input(name: string): ConvertInput {
  return {
    name,
    bytes: new Uint8Array(readFileSync(join(CREATE, name))),
    path: join(CREATE, name),
  };
}

const A4 = { width: mmToPt(210), height: mmToPt(297) };

describe('image headers', () => {
  it('sniffs every format from its magic bytes, not its name', () => {
    expect(sniffFormat(input('photo-landscape.jpg').bytes)).toBe('jpeg');
    expect(sniffFormat(input('chart-300dpi.png').bytes)).toBe('png');
    expect(sniffFormat(input('pages-3.tif').bytes)).toBe('tiff');
    expect(sniffFormat(input('tiny.bmp').bytes)).toBe('bmp');
    expect(sniffFormat(input('not-an-image.png').bytes)).toBe('unknown');
    expect(sniffFormat(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))).toBe('gif');
    expect(sniffFormat(new Uint8Array(0))).toBe('unknown');
  });

  it('reads size and DPI from a JPEG', () => {
    const h = readHeader(input('photo-landscape.jpg').bytes);
    expect(h).toMatchObject({
      format: 'jpeg',
      width: 300,
      height: 200,
      dpiX: 72,
      dpiY: 72,
      orientation: 1,
    });
  });

  it('reads EXIF orientation and resolution from a JPEG', () => {
    const h = readHeader(input('photo-exif-rotated.jpg').bytes);
    expect(h).toMatchObject({
      format: 'jpeg',
      width: 200,
      height: 300,
      orientation: 6,
      dpiX: 150,
      dpiY: 150,
    });
    expect(orientationSwaps(6)).toBe(true);
    expect(orientationSwaps(1)).toBe(false);
  });

  it('reads pHYs from a PNG and notices alpha', () => {
    expect(readHeader(input('chart-300dpi.png').bytes)).toMatchObject({
      format: 'png',
      width: 600,
      height: 450,
      dpiX: 300,
      dpiY: 300,
      hasAlpha: false,
    });
    expect(readHeader(input('logo-alpha.png').bytes)).toMatchObject({
      width: 128,
      height: 128,
      hasAlpha: true,
    });
  });

  it('counts TIFF directories and reads the first one', () => {
    expect(readHeader(input('pages-3.tif').bytes)).toMatchObject({
      format: 'tiff',
      pages: 3,
      width: 120,
      height: 80,
      dpiX: 96,
    });
  });

  it('reads a BMP header', () => {
    expect(readHeader(input('tiny.bmp').bytes)).toMatchObject({
      format: 'bmp',
      width: 32,
      height: 24,
    });
  });

  it('never throws on garbage', () => {
    expect(
      readHeader(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2])),
    ).toMatchObject({ format: 'png' });
    expect(readHeader(new Uint8Array([0xff, 0xd8, 0xff]))).toMatchObject({ format: 'jpeg' });
  });
});

describe('orientation matrices', () => {
  it('turn the stored top-left corner where EXIF says it goes', () => {
    // Stored top-left is (0,1) in the unit square (y up).
    expect(apply(orientationMatrix(1), 0, 1)).toEqual({ x: 0, y: 1 });
    expect(apply(orientationMatrix(6), 0, 1)).toEqual({ x: 1, y: 1 }); // 90° CW → top-right
    expect(apply(orientationMatrix(8), 0, 1)).toEqual({ x: 0, y: 0 }); // 90° CCW → bottom-left
    expect(apply(orientationMatrix(3), 0, 1)).toEqual({ x: 1, y: 0 }); // 180° → bottom-right
    expect(apply(orientationMatrix(2), 0, 1)).toEqual({ x: 1, y: 1 }); // mirror → top-right
    expect(apply(orientationMatrix(4), 0, 1)).toEqual({ x: 0, y: 0 }); // flip → bottom-left
    expect(apply(orientationMatrix(5), 0, 1)).toEqual({ x: 0, y: 1 }); // transpose keeps top-left
    expect(apply(orientationMatrix(7), 0, 1)).toEqual({ x: 1, y: 0 }); // transverse → bottom-right
  });

  it('keep the unit square a unit square', () => {
    for (const o of [1, 2, 3, 4, 5, 6, 7, 8] as const) {
      const corners = [apply(orientationMatrix(o), 0, 0), apply(orientationMatrix(o), 1, 1)];
      for (const c of corners) {
        expect(c.x === 0 || c.x === 1).toBe(true);
        expect(c.y === 0 || c.y === 1).toBe(true);
      }
    }
  });
});

describe('layoutImage', () => {
  it('sizes the page to the image at its DPI in image mode', () => {
    const l = layoutImage(
      { widthPx: 300, heightPx: 200, dpiX: 72, dpiY: 72 },
      {
        ...DEFAULT_IMAGE_LAYOUT,
        pageMode: 'image',
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
      },
    );
    expect(l.page).toEqual({ width: 300, height: 200 });
    expect(l.rect).toEqual({ x: 0, y: 0, width: 300, height: 200 });
    expect(l.clip).toBeNull();
  });

  it('adds margins around an image-sized page', () => {
    const l = layoutImage(
      { widthPx: 600, heightPx: 450, dpiX: 300, dpiY: 300 },
      {
        ...DEFAULT_IMAGE_LAYOUT,
        pageMode: 'image',
        margins: { top: 10, right: 10, bottom: 10, left: 10 },
      },
    );
    expect(l.page.width).toBeCloseTo(144 + 2 * mmToPt(10), 3);
    expect(l.page.height).toBeCloseTo(108 + 2 * mmToPt(10), 3);
    expect(l.rect.x).toBeCloseTo(mmToPt(10), 3);
  });

  it('assumes the default DPI when the image has none', () => {
    expect(naturalSize({ widthPx: 96, heightPx: 96 }, 96)).toMatchObject({ width: 72, height: 72 });
    expect(naturalSize({ widthPx: 96, heightPx: 96, dpiX: 0 }, 150).dpiX).toBe(150);
    expect(naturalSize({ widthPx: 96, heightPx: 96 }, 0).dpiX).toBe(96);
  });

  it('fits inside the margins of a fixed page and picks the orientation from the aspect', () => {
    const landscape = layoutImage({ widthPx: 300, heightPx: 200 }, DEFAULT_IMAGE_LAYOUT);
    expect(landscape.page.width).toBeCloseTo(A4.height, 3);
    expect(landscape.page.height).toBeCloseTo(A4.width, 3);
    const box = { w: A4.height - 2 * mmToPt(10), h: A4.width - 2 * mmToPt(10) };
    expect(landscape.rect.width).toBeCloseTo(box.w, 3);
    expect(landscape.rect.height).toBeCloseTo((box.w * 200) / 300, 3);
    expect(landscape.clip).toBeNull();

    const portrait = layoutImage({ widthPx: 200, heightPx: 300 }, DEFAULT_IMAGE_LAYOUT);
    expect(portrait.page.width).toBeCloseTo(A4.width, 3);
    expect(portrait.page.height).toBeCloseTo(A4.height, 3);
  });

  it('honours a forced orientation', () => {
    const l = layoutImage(
      { widthPx: 300, heightPx: 200 },
      { ...DEFAULT_IMAGE_LAYOUT, orientation: 'portrait' },
    );
    expect(l.page.width).toBeCloseTo(A4.width, 3);
  });

  it('fills and clips in fill mode', () => {
    const l = layoutImage(
      { widthPx: 300, heightPx: 100 },
      { ...DEFAULT_IMAGE_LAYOUT, fit: 'fill' },
    );
    expect(l.clip).not.toBeNull();
    expect(l.rect.width).toBeGreaterThan(l.page.width);
  });

  it('keeps actual size unless it would not fit', () => {
    const small = layoutImage(
      { widthPx: 72, heightPx: 72, dpiX: 72, dpiY: 72 },
      { ...DEFAULT_IMAGE_LAYOUT, fit: 'actual' },
    );
    expect(small.rect.width).toBeCloseTo(72, 3);
    const huge = layoutImage(
      { widthPx: 7200, heightPx: 7200, dpiX: 72, dpiY: 72 },
      { ...DEFAULT_IMAGE_LAYOUT, fit: 'actual' },
    );
    expect(huge.rect.width).toBeLessThan(huge.page.width);
    expect(huge.clip).toBeNull();
  });
});

describe('TIFF decoding', () => {
  it('decodes every page of a multi-page TIFF with its DPI', () => {
    const pages = decodeTiffPages(input('pages-3.tif').bytes, 'pages-3.tif');
    expect(pages.map((p) => [p.width, p.height])).toEqual([
      [120, 80],
      [80, 120],
      [100, 100],
    ]);
    expect(pages[0]?.dpiX).toBe(96);
    expect(pages[0]?.rgba.length).toBe(120 * 80 * 4);
  });

  it('inflates a deflate-compressed TIFF', () => {
    const [page] = decodeTiffPages(input('deflate.tif').bytes);
    expect(page).toMatchObject({ width: 64, height: 64 });
    // A gradient: the first and last pixels differ.
    const rgba = page?.rgba ?? new Uint8Array();
    expect(rgba[0]).not.toBe(rgba[rgba.length - 4]);
  });

  it('refuses something that is not a TIFF', () => {
    expect(() => decodeTiffPages(new Uint8Array([1, 2, 3, 4]), 'x.tif')).toThrow(
      ConvertUnsupported,
    );
  });
});

describe('ImageConverter', () => {
  const converter = new ImageConverter();
  const ctx = { env: {} };

  it('accepts by extension or MIME type', () => {
    expect(converter.accepts({ name: 'a.JPG' })).toBe(true);
    expect(converter.accepts({ name: 'a.tiff' })).toBe(true);
    expect(converter.accepts({ mime: 'image/webp' })).toBe(true);
    expect(converter.accepts({ name: 'a.txt' })).toBe(false);
    expect(converter.accepts({})).toBe(false);
  });

  it('turns five mixed images into one document with the right page sizes and rotations', async () => {
    const inputs = [
      input('photo-landscape.jpg'),
      input('photo-exif-rotated.jpg'),
      input('chart-300dpi.png'),
      input('logo-alpha.png'),
      input('scan-gray.png'),
    ];
    const progress: string[] = [];
    const result = await converter.convert(inputs, converter.defaults(), {
      env: {},
      progress: (_f, message) => progress.push(message),
    });
    expect(result.pageCount).toBe(5);
    expect(result.title).toBe('photo-landscape');
    expect(progress.length).toBeGreaterThan(5);

    const pdf = await engine();
    const doc = await pdf.open(result.bytes);
    try {
      expect(await pdf.pageCount(doc)).toBe(5);
      const sizes = await Promise.all([0, 1, 2, 3, 4].map((i) => pdf.pageSize(doc, i)));
      // Landscape photo → landscape A4.
      expect(sizes[0]?.width).toBeCloseTo(A4.height, 1);
      expect(sizes[0]?.height).toBeCloseTo(A4.width, 1);
      // Stored 200×300 with orientation 6 displays as 300×200: landscape.
      expect(sizes[1]?.width).toBeCloseTo(A4.height, 1);
      // 600×450 chart is landscape; a square logo is portrait; a tall scan is portrait.
      expect(sizes[2]?.width).toBeCloseTo(A4.height, 1);
      expect(sizes[3]?.width).toBeCloseTo(A4.width, 1);
      expect(sizes[4]?.width).toBeCloseTo(A4.width, 1);
      // No /Rotate anywhere — orientation is drawn, not declared.
      for (const s of sizes) expect(s?.rotation).toBe(0);
      const meta = await pdf.metadata(doc);
      expect(meta.title).toBe('photo-landscape');
    } finally {
      await pdf.close(doc);
    }
  });

  it('embeds JPEG bytes as DCTDecode and gives alpha PNGs a soft mask', async () => {
    const result = await converter.convert(
      [input('photo-landscape.jpg'), input('logo-alpha.png')],
      converter.defaults(),
      ctx,
    );
    const doc = await PDFDocument.load(result.bytes);
    const filters: string[] = [];
    let smasks = 0;
    for (const page of doc.getPages()) {
      const xobjects = page.node.Resources()?.lookupMaybe(PDFName.of('XObject'), PDFDict);
      if (!xobjects) continue;
      for (const [, value] of xobjects.entries()) {
        const stream = doc.context.lookup(value);
        if (!(stream instanceof PDFRawStream)) continue;
        filters.push(String(stream.dict.get(PDFName.of('Filter'))));
        if (stream.dict.get(PDFName.of('SMask'))) smasks++;
      }
    }
    expect(filters).toContain('/DCTDecode');
    expect(filters).toContain('/FlateDecode');
    expect(smasks).toBe(1);
  });

  it('makes one page per TIFF directory, each its own size in image mode', async () => {
    const result = await converter.convert(
      [input('pages-3.tif')],
      {
        ...converter.defaults(),
        pageMode: 'image',
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
      },
      ctx,
    );
    expect(result.pageCount).toBe(3);
    const pdf = await engine();
    const doc = await pdf.open(result.bytes);
    try {
      const sizes = await Promise.all([0, 1, 2].map((i) => pdf.pageSize(doc, i)));
      // 96 dpi: 120 px → 90 pt.
      expect(sizes[0]?.width).toBeCloseTo(90, 1);
      expect(sizes[0]?.height).toBeCloseTo(60, 1);
      expect(sizes[1]?.width).toBeCloseTo(60, 1);
      expect(sizes[2]?.width).toBeCloseTo(75, 1);
    } finally {
      await pdf.close(doc);
    }
  });

  it('uses the host decoder for a BMP and says so when there is none', async () => {
    await expect(
      converter.convert([input('tiny.bmp')], converter.defaults(), ctx),
    ).rejects.toMatchObject({
      name: 'ConvertUnsupported',
      reason: 'no-decoder',
    });
    const decoded = {
      width: 2,
      height: 2,
      rgba: new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 0, 0, 0, 128]),
    };
    const result = await converter.convert([input('tiny.bmp')], converter.defaults(), {
      env: { rasterDecoder: () => Promise.resolve(decoded) },
    });
    expect(result.pageCount).toBe(1);
  });

  it('names a file that is not an image', async () => {
    await expect(
      converter.convert([input('not-an-image.png')], converter.defaults(), ctx),
    ).rejects.toMatchObject({
      name: 'ConvertUnsupported',
    });
    await expect(
      converter.convert([input('not-an-image.png')], converter.defaults(), {
        env: { rasterDecoder: () => Promise.resolve(null) },
      }),
    ).rejects.toMatchObject({ reason: 'corrupt' });
  });

  it('refuses an empty list and an empty file', async () => {
    await expect(converter.convert([], converter.defaults(), ctx)).rejects.toMatchObject({
      reason: 'empty',
    });
    await expect(
      converter.convert([{ name: 'e.png', bytes: new Uint8Array(0) }], converter.defaults(), ctx),
    ).rejects.toMatchObject({ reason: 'empty' });
  });

  it('warns when the DPI matters and the image has none', async () => {
    const result = await converter.convert(
      [input('photo-landscape.jpg')],
      { ...converter.defaults(), pageMode: 'image' },
      ctx,
    );
    expect(result.warnings).toEqual([]);
    const decoded = { width: 2, height: 2, rgba: new Uint8Array(16).fill(255) };
    const gif = {
      name: 'x.gif',
      bytes: new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 2, 0, 2, 0, 0, 0, 0]),
    };
    const noDpi = await converter.convert(
      [gif],
      { ...converter.defaults(), fit: 'actual' },
      {
        env: { rasterDecoder: () => Promise.resolve(decoded) },
      },
    );
    expect(noDpi.warnings[0]).toMatch(/96 dpi was assumed/);
  });

  it('stops when cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      converter.convert([input('photo-landscape.jpg')], converter.defaults(), {
        env: {},
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'ConvertCancelled' });
  });
});

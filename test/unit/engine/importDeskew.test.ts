import { describe, expect, it, vi } from 'vitest';
import { PDFDocument, PDFName, PDFRawStream } from 'pdf-lib';
import { ImageConverter } from '@engine/create/images/ImageConverter';
import { DEFAULT_IMAGE_LAYOUT } from '@engine/create/images/layout';
import { encodePngRgb } from '@engine/export/codecs/png';
import { detectSkew } from '@engine/ops/deskew';
import { straightenImportedImages } from '@engine/ops/importDeskew';
import { engine, fixture } from './helpers';
import { scanImage } from '../create/scanImage';

async function images(bytes: Uint8Array): Promise<string[]> {
  const pdf = await PDFDocument.load(bytes);
  return pdf.context
    .enumerateIndirectObjects()
    .flatMap(([, object]) =>
      object instanceof PDFRawStream &&
      object.dict.get(PDFName.of('Subtype'))?.toString() === '/Image'
        ? [Buffer.from(object.contents).toString('base64')]
        : [],
    )
    .sort();
}

async function angles(bytes: Uint8Array): Promise<number[]> {
  const e = await engine();
  const handle = await e.open(bytes);
  try {
    const out: number[] = [];
    for (let page = 0; page < (await e.pageCount(handle)); page++) {
      const raw = await e.renderRaw(handle, page, 1.5);
      out.push(detectSkew({ data: raw.rgba, width: raw.width, height: raw.height }).angle);
    }
    return out;
  } finally {
    await e.close(handle);
  }
}

describe('automatic image import straightening', () => {
  it('measures anisotropic DPI after layout and preserves already-straight input exactly', async () => {
    const converter = new ImageConverter();
    const converted = await converter.convert(
      [{ name: 'unequal-dpi.png', bytes: scanImage(2.3, { x: 150, y: 300 }) }],
      { ...DEFAULT_IMAGE_LAYOUT, pageMode: 'image' },
      { env: {} },
    );
    const expected = (Math.atan((Math.tan((2.3 * Math.PI) / 180) * 150) / 300) * 180) / Math.PI;
    expect(Math.abs(((await angles(converted.bytes))[0] ?? NaN) - expected)).toBeLessThanOrEqual(
      0.2,
    );
    const result = await straightenImportedImages(converted.bytes, await engine());
    expect(Math.abs((await angles(result.bytes))[0] ?? NaN)).toBeLessThanOrEqual(0.2);
    expect(await images(result.bytes)).toEqual(await images(converted.bytes));
    expect((await PDFDocument.load(result.bytes)).getPage(0).getSize()).toEqual(
      (await PDFDocument.load(converted.bytes)).getPage(0).getSize(),
    );
    const straight = await converter.convert(
      [{ name: 'straight.png', bytes: scanImage(0) }],
      DEFAULT_IMAGE_LAYOUT,
      { env: {} },
    );
    expect((await straightenImportedImages(straight.bytes, await engine())).bytes).toBe(
      straight.bytes,
    );
  });
  it('corrects known positive and negative imported scan angles and preserves all image streams and page boxes', async () => {
    const e = await engine();
    const source = await e.open(fixture('skewed.pdf'));
    const inputs = [];
    try {
      for (let page = 0; page < 4; page++) {
        const raw = await e.renderRaw(source, page, 1.5);
        inputs.push({
          name: `scan-${page}.png`,
          bytes: encodePngRgb(new Uint8Array(raw.rgba), raw.width, raw.height),
        });
      }
    } finally {
      await e.close(source);
    }
    const converted = await new ImageConverter().convert(inputs, DEFAULT_IMAGE_LAYOUT, { env: {} });
    const before = await angles(converted.bytes);
    [2.3, -1.1, 7.5].forEach((expected, page) => {
      expect(Math.abs((before[page] ?? 0) - expected)).toBeLessThanOrEqual(0.2);
    });
    const progress: number[] = [];
    const result = await straightenImportedImages(converted.bytes, e, {
      progress: (fraction) => {
        if (fraction !== null) progress.push(fraction);
      },
    });
    expect(result.pageCount).toBe(4);
    expect(result.warnings).toContain('Page 4 was not straightened: not enough content to tell.');
    const after = await angles(result.bytes);
    after.slice(0, 3).forEach((angle) => {
      expect(Math.abs(angle)).toBeLessThanOrEqual(0.2);
    });
    expect(await images(result.bytes)).toEqual(await images(converted.bytes));
    const original = await PDFDocument.load(converted.bytes);
    const saved = await PDFDocument.load(result.bytes);
    expect(saved.getPages().map((page) => page.getSize())).toEqual(
      original.getPages().map((page) => page.getSize()),
    );
    expect(progress).toEqual([...progress].sort((a, b) => a - b));
    expect(progress.at(-1)).toBe(1);
    const second = await straightenImportedImages(result.bytes, e);
    expect(second.bytes).toBe(result.bytes);
  }, 120_000);

  it('keeps multipage TIFF geometry and streams, including image-sized DPI layout', async () => {
    const converted = await new ImageConverter().convert(
      [
        { name: 'pages-3.tif', bytes: fixture('create/pages-3.tif') },
        { name: 'photo.jpg', bytes: fixture('create/photo-exif-rotated.jpg') },
      ],
      { ...DEFAULT_IMAGE_LAYOUT, pageMode: 'image' },
      { env: {} },
    );
    const result = await straightenImportedImages(converted.bytes, await engine());
    expect(result.pageCount).toBe(4);
    expect(await images(result.bytes)).toEqual(await images(converted.bytes));
    expect((await PDFDocument.load(result.bytes)).getPages().map((page) => page.getSize())).toEqual(
      (await PDFDocument.load(converted.bytes)).getPages().map((page) => page.getSize()),
    );
  });

  it('leaves a blank document byte-identical and closes it', async () => {
    const pdf = await PDFDocument.create();
    pdf.addPage();
    const bytes = await pdf.save();
    const result = await straightenImportedImages(bytes, await engine());
    expect(result.bytes).toBe(bytes);
    expect(result.warnings).toHaveLength(1);
  });

  it('closes a cancelled render, reports a failed page without losing the import, and never opens a pre-cancelled job', async () => {
    const e = await engine();
    const controller = new AbortController();
    const close = vi.fn(e.close.bind(e));
    const adapter = {
      open: e.open.bind(e),
      close,
      pageCount: e.pageCount.bind(e),
      pageSize: e.pageSize.bind(e),
      cancelCurrent: vi.fn(),
      renderRaw: vi.fn(() => {
        controller.abort();
        return Promise.reject(new Error('cancelled'));
      }),
    };
    await expect(
      straightenImportedImages(fixture('skewed.pdf'), adapter, { signal: controller.signal }),
    ).rejects.toThrow();
    expect(close).toHaveBeenCalledTimes(1);
    expect(adapter.cancelCurrent).toHaveBeenCalledTimes(1);
    const open = vi.fn(e.open.bind(e));
    await expect(
      straightenImportedImages(
        fixture('skewed.pdf'),
        { ...adapter, open },
        { signal: controller.signal },
      ),
    ).rejects.toThrow();
    expect(open).not.toHaveBeenCalled();
    const bytes = fixture('skewed.pdf');
    const failed = await straightenImportedImages(bytes, {
      ...adapter,
      renderRaw: vi.fn(() => Promise.reject(new Error('unavailable renderer'))),
    });
    expect(failed.bytes).toBe(bytes);
    expect(failed.warnings).toHaveLength(4);
    expect(failed.warnings[0]).toContain('unavailable renderer');
  });
});

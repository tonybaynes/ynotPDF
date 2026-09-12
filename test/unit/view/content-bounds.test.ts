import { describe, expect, it, vi } from 'vitest';
import { PDFDocument, degrees } from 'pdf-lib';
import type { PageObject } from '@engine/PdfEngine';
import type { PdfRect, Rotation } from '@shared/pdf';
import { PageGeometry } from '@engine/geometry';
import { contentBounds, ContentBoundsCache, visibleRowBounds } from '@view/ContentBounds';
import { layoutPages } from '@view/layout';
import { engine } from '../engine/helpers';

const size = PageGeometry.fromBoxes(
  { x0: 0, y0: 0, x1: 600, y1: 800 },
  { x0: 50, y0: 100, x1: 550, y1: 700 },
  0,
).pageSize;
const ink = { x0: 150, y0: 200, x1: 350, y1: 500 };
function object(rect: PdfRect, extra: Partial<PageObject> = {}): PageObject {
  return { index: 0, kind: 'path', matrix: [1, 0, 0, 1, 0, 0], rect, ...extra };
}

describe('content bounds', () => {
  it('retains horizontal and vertical hairlines but ignores point-only degenerate objects', () => {
    expect(contentBounds([object({ x0: 100, x1: 400, y0: 300, y1: 300 })], size)).toEqual({
      x0: 100,
      x1: 400,
      y0: 299.5,
      y1: 300.5,
    });
    expect(contentBounds([object({ x0: 300, x1: 300, y0: 200, y1: 500 })], size)).toEqual({
      x0: 299.5,
      x1: 300.5,
      y0: 200,
      y1: 500,
    });
    expect(contentBounds([object({ x0: 300, x1: 300, y0: 300, y1: 300 })], size)).toEqual(
      size.cropBox,
    );
  });
  it('unions text, images, paths and forms, clipping to the displayed CropBox', () => {
    expect(
      contentBounds(
        [
          object(ink, { kind: 'text' }),
          object({ x0: 300, y0: 400, x1: 900, y1: 900 }, { kind: 'image' }),
          object({ x0: 0, y0: 0, x1: 20, y1: 30 }, { kind: 'form' }),
        ],
        size,
      ),
    ).toEqual({ x0: 150, y0: 200, x1: 550, y1: 700 });
  });
  it('ignores malformed, transparent and hidden-layer objects; blank falls back to page', () => {
    expect(
      contentBounds(
        [
          object(ink, { layerId: 'hidden' }),
          object(ink, { fillAlpha: 0, strokeAlpha: 0 }),
          object({ ...ink, x0: NaN }),
          object({ x0: 900, y0: 900, x1: 950, y1: 950 }),
        ],
        size,
        new Set(['hidden']),
      ),
    ).toEqual(size.cropBox);
    expect(contentBounds([object({ x0: 350, y0: 500, x1: 150, y1: 200 })], size)).toEqual(ink);
  });
  it.each([0, 90, 180, 270] as Rotation[])(
    'uses real PDFium bounds with CropBox and /Rotate %s',
    async (rotation) => {
      const pdf = await PDFDocument.create();
      const page = pdf.addPage([600, 800]);
      page.setCropBox(50, 100, 500, 600);
      page.setRotation(degrees(rotation));
      page.drawRectangle({ x: 150, y: 200, width: 200, height: 300, borderWidth: 0 });
      const e = await engine();
      const doc = await e.open(await pdf.save());
      try {
        const actualSize = await e.pageSize(doc, 0);
        const bounds = contentBounds(await e.pageObjects(doc, 0), actualSize);
        expect(bounds).toEqual(ink);
        for (const extra of [0, 90, 180, 270] as Rotation[]) {
          const table = layoutPages([actualSize], {
            mode: 'single',
            zoom: 2,
            gap: 16,
            padding: 16,
            rotation: extra,
          });
          const rect = visibleRowBounds(table, [actualSize], new Map([[0, bounds]]), extra);
          const displayed = new PageGeometry(actualSize, extra).rectToDevice(ink, 2);
          expect(rect).toEqual({ ...displayed, x: displayed.x + 16, y: displayed.y + 16 });
        }
      } finally {
        await e.close(doc);
      }
    },
  );
  it('preserves facing inner margins and fixed gap, including mixed heights and book cover', () => {
    const table = layoutPages([size, size], { mode: 'facing', zoom: 2, gap: 16, padding: 16 });
    const bounds = new Map([
      [0, ink],
      [1, ink],
    ]);
    expect(visibleRowBounds(table, [size, size], bounds, 0)).toEqual({
      x: 216,
      y: 416,
      width: 1416,
      height: 600,
    });
    const book = layoutPages([size, size, size], { mode: 'book', zoom: 1, gap: 16, padding: 16 });
    expect(visibleRowBounds(book, [size, size, size], new Map([[0, ink]]), 0)?.width).toBe(200);
    expect(visibleRowBounds(book, [], bounds, 0)).toBeNull();
  });
});

describe('bounded asynchronous bounds cache', () => {
  it('deduplicates reads, retains hot entries and evicts old pages', async () => {
    const cache = new ContentBoundsCache(2);
    const read = vi.fn(() => Promise.resolve(ink));
    const first = cache.get('a', read);
    expect(cache.get('a', read)).toBe(first);
    await first;
    await cache.get('b', read);
    await cache.get('a', read);
    await cache.get('c', read);
    await cache.get('a', read);
    expect(read).toHaveBeenCalledTimes(3);
    await cache.get('b', read);
    expect(read).toHaveBeenCalledTimes(4);
  });
  it('an outstanding old read cannot replace fresh edited bounds', async () => {
    const cache = new ContentBoundsCache();
    let finish!: (box: PdfRect) => void;
    const old = cache.get(
      'a',
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await Promise.resolve();
    cache.clear();
    const fresh = cache.get('a', () => Promise.resolve(size.cropBox));
    finish(ink);
    await old;
    expect(cache.get('a', () => Promise.resolve(ink))).toBe(fresh);
    expect(await fresh).toEqual(size.cropBox);
  });
  it('failed reads retry, and an old failure cannot delete a new entry', async () => {
    const cache = new ContentBoundsCache();
    await expect(cache.get('a', () => Promise.reject(new Error('read failed')))).rejects.toThrow(
      'read failed',
    );
    expect(await cache.get('a', () => Promise.resolve(ink))).toEqual(ink);
    let fail!: (error: Error) => void;
    const old = cache.get(
      'b',
      () =>
        new Promise((_resolve, reject) => {
          fail = reject;
        }),
    );
    await Promise.resolve();
    cache.clear();
    const fresh = cache.get('b', () => Promise.resolve(ink));
    fail(new Error('old'));
    await expect(old).rejects.toThrow('old');
    expect(cache.get('b', () => Promise.resolve(size.cropBox))).toBe(fresh);
    expect(() => new ContentBoundsCache(0)).toThrow('capacity');
  });
});

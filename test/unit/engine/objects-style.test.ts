/**
 * Path styling and geometry through PDFium (M50): a colour change shows in the render, and a
 * path's points come back in page space with how it is painted.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import type { DocHandle } from '@engine/PdfEngine';
import type { PdfiumEngine } from '@engine/pdfium/PdfiumEngine';
import { engine, fixture } from './helpers';

let pdfium: PdfiumEngine;

beforeAll(async () => {
  pdfium = await engine();
});

async function withDoc<T>(name: string, fn: (doc: DocHandle) => Promise<T> | T): Promise<T> {
  const doc = pdfium.openSync(fixture(name));
  try {
    return await fn(doc);
  } finally {
    await pdfium.close(doc);
  }
}

describe('setObjectStyle', () => {
  it('changes a path’s stroke colour and width, and the render follows', async () => {
    await withDoc('multipage.pdf', async (doc) => {
      const objects = await pdfium.pageObjects(doc, 0);
      const rect = objects.find((o) => o.kind === 'path');
      if (!rect) throw new Error('no path');
      await pdfium.setObjectStyle(doc, 0, rect.index, {
        strokeColor: 0x0000ff,
        strokeWidth: 6,
        dash: [4, 2],
      });
      const after = (await pdfium.pageObjects(doc, 0))[rect.index];
      expect(after?.strokeColor).toBe(0x0000ff);
      expect(after?.strokeWidth).toBeCloseTo(6, 3);
      const { height } = await pdfium.pageSize(doc, 0);
      const render = await pdfium.renderRaw(doc, 0, 1);
      // Sample the left edge of the frame: a wide blue stroke means blue pixels there.
      const x = Math.round(rect.rect.x0);
      const y = Math.round(height - (rect.rect.y0 + rect.rect.y1) / 2);
      let blue = 0;
      for (let dx = -3; dx <= 3; dx++) {
        const i = (y * render.width + x + dx) * 4;
        const r = render.rgba[i] ?? 255;
        const b = render.rgba[i + 2] ?? 0;
        if (b > 150 && r < 100) blue++;
      }
      expect(blue).toBeGreaterThan(0);
      // A saved copy carries the change too.
      const saved = pdfium.openSync(await pdfium.save(doc));
      try {
        expect((await pdfium.pageObjects(saved, 0))[rect.index]?.strokeColor).toBe(0x0000ff);
      } finally {
        await pdfium.close(saved);
      }
    });
  });

  it('leaves absent fields alone', async () => {
    await withDoc('multipage.pdf', async (doc) => {
      const objects = await pdfium.pageObjects(doc, 0);
      const rect = objects.find((o) => o.kind === 'path');
      if (!rect) throw new Error('no path');
      await pdfium.setObjectStyle(doc, 0, rect.index, { fillColor: 0x00ff00 });
      const after = (await pdfium.pageObjects(doc, 0))[rect.index];
      expect(after?.strokeWidth).toBeCloseTo(rect.strokeWidth ?? 1, 3);
      expect(after?.fillColor).toBe(0x00ff00);
    });
  });
});

describe('objectPath', () => {
  it('reports a rectangle’s corners in page space and how it is painted', async () => {
    await withDoc('multipage.pdf', async (doc) => {
      const objects = await pdfium.pageObjects(doc, 0);
      const rect = objects.find((o) => o.kind === 'path');
      if (!rect) throw new Error('no path');
      const path = await pdfium.objectPath(doc, 0, rect.index);
      expect(path.stroke).toBe(true);
      expect(typeof path.fill).toBe('boolean');
      expect(path.points.length).toBeGreaterThanOrEqual(4);
      expect(path.points[0]?.type).toBe('move');
      const xs = path.points.map((p) => p.x);
      const ys = path.points.map((p) => p.y);
      expect(Math.min(...xs)).toBeCloseTo(36, 1);
      // The fixture frames an A4 page 36 pt in from each edge.
      expect(Math.max(...xs)).toBeCloseTo(595.28 - 36, 1);
      expect(Math.min(...ys)).toBeCloseTo(36, 1);
    });
  });

  it('refuses an object that is not a path', async () => {
    await withDoc('image.pdf', async (doc) => {
      const image = (await pdfium.pageObjects(doc, 0)).find((o) => o.kind === 'image');
      if (!image) throw new Error('no image');
      await expect(pdfium.objectPath(doc, 0, image.index)).rejects.toMatchObject({
        code: 'invalid-argument',
      });
    });
  });
});

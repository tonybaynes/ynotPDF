/**
 * The engine half of M50 against real PDFium: an object moves, goes, comes back, changes place
 * in the z-order and travels to another document — and in every case the *render* agrees, not
 * just the object list.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { EngineError, type DocHandle } from '@engine/PdfEngine';
import type { PdfiumEngine } from '@engine/pdfium/PdfiumEngine';
import { parse, scanObjects } from '@engine/content';
import { dhash, engine, fixture, hamming, inkCoverage } from './helpers';

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

/** Where a page-space rect lands in a 1 px/pt render (device y grows downwards). */
function device(
  r: { x0: number; y0: number; x1: number; y1: number },
  pageHeight: number,
): { x: number; y: number; width: number; height: number } {
  return { x: r.x0, y: pageHeight - r.y1, width: r.x1 - r.x0, height: r.y1 - r.y0 };
}

describe('pageContent', () => {
  it('hands back the decoded content stream of a page', async () => {
    await withDoc('image.pdf', async (doc) => {
      const { content, resources } = await pdfium.pageContent(doc, 0);
      expect(resources).toContain('/XObject');
      const text = new TextDecoder('latin1').decode(content);
      expect(text).toContain(' Do');
      expect(text).toContain(' Tj');
      const scan = scanObjects(parse(content).ops);
      const objects = await pdfium.pageObjects(doc, 0);
      expect(scan.objects.length).toBe(objects.length);
    });
  });

  it('refuses a page that is not there', async () => {
    await withDoc('blank.pdf', async (doc) => {
      await expect(pdfium.pageContent(doc, 5)).rejects.toBeInstanceOf(EngineError);
    });
  });
});

describe('transformObject', () => {
  it('moves an image 10 pt and the render follows', async () => {
    await withDoc('image.pdf', async (doc) => {
      const before = await pdfium.pageObjects(doc, 0);
      const image = before.find((o) => o.kind === 'image');
      expect(image).toBeDefined();
      if (!image) return;
      const { height } = await pdfium.pageSize(doc, 0);
      const renderBefore = await pdfium.renderRaw(doc, 0, 1);

      await pdfium.transformObject(doc, 0, image.index, [1, 0, 0, 1, 10, 0]);

      const after = await pdfium.pageObjects(doc, 0);
      const moved = after[image.index];
      expect(moved?.rect.x0).toBeCloseTo(image.rect.x0 + 10, 3);
      expect(moved?.rect.x1).toBeCloseTo(image.rect.x1 + 10, 3);
      expect(moved?.rect.y0).toBeCloseTo(image.rect.y0, 3);
      const renderAfter = await pdfium.renderRaw(doc, 0, 1);
      expect(hamming(dhash(renderBefore), dhash(renderAfter))).toBeGreaterThan(0);
      // The strip the image vacated is now paper.
      const vacated = device(
        { x0: image.rect.x0, y0: image.rect.y0, x1: image.rect.x0 + 8, y1: image.rect.y1 },
        height,
      );
      expect(inkCoverage(renderAfter, vacated)).toBeLessThan(0.05);
      expect(inkCoverage(renderBefore, vacated)).toBeGreaterThan(0.5);
    });
  });

  it('persists through a save and a reopen', async () => {
    await withDoc('image.pdf', async (doc) => {
      const before = await pdfium.pageObjects(doc, 0);
      const image = before.find((o) => o.kind === 'image');
      if (!image) throw new Error('no image');
      await pdfium.transformObject(doc, 0, image.index, [1, 0, 0, 1, 10, 0]);
      const bytes = await pdfium.save(doc);
      const reopened = pdfium.openSync(bytes);
      try {
        const objects = await pdfium.pageObjects(reopened, 0);
        expect(objects[image.index]?.rect.x0).toBeCloseTo(image.rect.x0 + 10, 3);
      } finally {
        await pdfium.close(reopened);
      }
    });
  });

  it('setObjectMatrix replaces the matrix outright', async () => {
    await withDoc('image.pdf', async (doc) => {
      const image = (await pdfium.pageObjects(doc, 0)).find((o) => o.kind === 'image');
      if (!image) throw new Error('no image');
      const target = [
        image.matrix[0],
        image.matrix[1],
        image.matrix[2],
        image.matrix[3],
        20,
        30,
      ] as const;
      await pdfium.setObjectMatrix(doc, 0, image.index, target);
      const after = (await pdfium.pageObjects(doc, 0))[image.index];
      expect(after?.matrix[4]).toBeCloseTo(20, 3);
      expect(after?.matrix[5]).toBeCloseTo(30, 3);
    });
  });

  it('rejects an index that is out of range', async () => {
    await withDoc('image.pdf', async (doc) => {
      await expect(pdfium.transformObject(doc, 0, 99, [1, 0, 0, 1, 0, 0])).rejects.toMatchObject({
        code: 'invalid-argument',
      });
    });
  });
});

describe('removeObject / restoreObject', () => {
  it('takes an object out, then puts the same object back', async () => {
    await withDoc('multipage.pdf', async (doc) => {
      const before = await pdfium.pageObjects(doc, 0);
      const rect = before.find((o) => o.kind === 'path');
      if (!rect) throw new Error('no path');
      const { height } = await pdfium.pageSize(doc, 0);
      const edge = device(
        { x0: rect.rect.x0, y0: rect.rect.y0, x1: rect.rect.x0 + 3, y1: rect.rect.y1 },
        height,
      );
      expect(inkCoverage(await pdfium.renderRaw(doc, 0, 1), edge)).toBeGreaterThan(0.1);

      const token = await pdfium.removeObject(doc, 0, rect.index);
      const gone = await pdfium.pageObjects(doc, 0);
      expect(gone.length).toBe(before.length - 1);
      expect(inkCoverage(await pdfium.renderRaw(doc, 0, 1), edge)).toBe(0);

      await pdfium.restoreObject(doc, 0, token, rect.index);
      const back = await pdfium.pageObjects(doc, 0);
      expect(back.length).toBe(before.length);
      expect(back[rect.index]?.kind).toBe('path');
      expect(back[rect.index]?.rect).toEqual(rect.rect);
      expect(inkCoverage(await pdfium.renderRaw(doc, 0, 1), edge)).toBeGreaterThan(0.1);
      // The token is spent.
      await expect(pdfium.restoreObject(doc, 0, token, 0)).rejects.toMatchObject({
        code: 'invalid-argument',
      });
    });
  });

  it('survives the page being unloaded and reloaded in between', async () => {
    await withDoc('multipage.pdf', async (doc) => {
      const before = await pdfium.pageObjects(doc, 0);
      const rect = before.find((o) => o.kind === 'path');
      if (!rect) throw new Error('no path');
      const token = await pdfium.removeObject(doc, 0, rect.index);
      // Rotating reloads the page (M20's mutations drop it from the cache).
      await pdfium.setPageRotation(doc, 0, 90);
      await pdfium.setPageRotation(doc, 0, 0);
      expect((await pdfium.pageObjects(doc, 0)).length).toBe(before.length - 1);
      await pdfium.restoreObject(doc, 0, token, rect.index);
      expect((await pdfium.pageObjects(doc, 0)).length).toBe(before.length);
    });
  });
});

describe('reorderObjects', () => {
  it('puts the other of two overlapping rectangles on top', async () => {
    await withDoc('blank.pdf', async (doc) => {
      // Two filled squares that overlap: black drawn first, then white over it.
      const black = await squarePdf(0, 0, 0);
      const white = await squarePdf(1, 1, 1);
      await pdfium.insertObject(doc, 0, { pdf: black, matrix: [1, 0, 0, 1, 0, 0] });
      await pdfium.insertObject(doc, 0, { pdf: white, matrix: [1, 0, 0, 1, 20, 20] });
      const { height } = await pdfium.pageSize(doc, 0);
      const overlap = device({ x0: 125, y0: 125, x1: 175, y1: 175 }, height);
      expect(inkCoverage(await pdfium.renderRaw(doc, 0, 1), overlap)).toBeLessThan(0.05);

      await pdfium.reorderObjects(doc, 0, [1, 0]);
      expect(inkCoverage(await pdfium.renderRaw(doc, 0, 1), overlap)).toBeGreaterThan(0.95);
      const objects = await pdfium.pageObjects(doc, 0);
      expect(objects.map((o) => o.kind)).toEqual(['form', 'form']);
    });
  });

  it('refuses anything that is not a permutation', async () => {
    await withDoc('multipage.pdf', async (doc) => {
      const count = (await pdfium.pageObjects(doc, 0)).length;
      await expect(pdfium.reorderObjects(doc, 0, [0, 0])).rejects.toMatchObject({
        code: 'invalid-argument',
      });
      await expect(pdfium.reorderObjects(doc, 0, [count])).rejects.toMatchObject({
        code: 'invalid-argument',
      });
    });
  });
});

/** A one-page A4 PDF with one filled 100 pt square at (100, 100), for pasting. */
async function squarePdf(r: number, g: number, b: number): Promise<Uint8Array> {
  const { PDFDocument, rgb } = await import('pdf-lib');
  const doc = await PDFDocument.create();
  const page = doc.addPage([595.28, 841.89]);
  page.drawRectangle({ x: 100, y: 100, width: 100, height: 100, color: rgb(r, g, b) });
  return doc.save({ useObjectStreams: false });
}

describe('objectAsPdf / insertObject', () => {
  it('copies a path to another document where it renders the same', async () => {
    await withDoc('multipage.pdf', async (source) => {
      const objects = await pdfium.pageObjects(source, 0);
      const rect = objects.find((o) => o.kind === 'path');
      if (!rect) throw new Error('no path');
      const pdf = await pdfium.objectAsPdf(source, 0, rect.index);
      expect(pdf.length).toBeGreaterThan(100);

      // The copy is a one-page document holding just that object.
      const copy = pdfium.openSync(pdf);
      try {
        expect(await pdfium.pageCount(copy)).toBe(1);
        const only = await pdfium.pageObjects(copy, 0);
        expect(only.map((o) => o.kind)).toEqual(['path']);
        expect(only[0]?.rect).toEqual(rect.rect);
        expect((await pdfium.annotations(copy, 0)).length).toBe(0);
      } finally {
        await pdfium.close(copy);
      }

      await withDoc('blank.pdf', async (target) => {
        const { height } = await pdfium.pageSize(target, 0);
        const index = await pdfium.insertObject(target, 0, { pdf, matrix: [1, 0, 0, 1, 0, 0] });
        expect(index).toBe(0);
        const pasted = await pdfium.pageObjects(target, 0);
        expect(pasted[0]?.kind).toBe('form');
        expect(pasted[0]?.rect.x0).toBeCloseTo(rect.rect.x0, 1);
        expect(pasted[0]?.rect.y1).toBeCloseTo(rect.rect.y1, 1);
        const edge = device(
          { x0: rect.rect.x0, y0: rect.rect.y0, x1: rect.rect.x0 + 3, y1: rect.rect.y1 },
          height,
        );
        const sourceRender = await pdfium.renderRaw(source, 0, 1);
        const targetRender = await pdfium.renderRaw(target, 0, 1);
        expect(inkCoverage(targetRender, edge)).toBeCloseTo(inkCoverage(sourceRender, edge), 1);
        // And it survives a save.
        const saved = pdfium.openSync(await pdfium.save(target));
        try {
          expect((await pdfium.pageObjects(saved, 0))[0]?.kind).toBe('form');
        } finally {
          await pdfium.close(saved);
        }
      });
    });
  });

  it('places a pasted object under its matrix and at an index', async () => {
    await withDoc('multipage.pdf', async (doc) => {
      const objects = await pdfium.pageObjects(doc, 0);
      const rect = objects.find((o) => o.kind === 'path');
      if (!rect) throw new Error('no path');
      const pdf = await pdfium.objectAsPdf(doc, 0, rect.index);
      const index = await pdfium.insertObject(doc, 0, { pdf, matrix: [1, 0, 0, 1, 5, 7] }, 0);
      expect(index).toBe(0);
      const after = await pdfium.pageObjects(doc, 0);
      expect(after.length).toBe(objects.length + 1);
      expect(after[0]?.rect.x0).toBeCloseTo(rect.rect.x0 + 5, 1);
      expect(after[0]?.rect.y0).toBeCloseTo(rect.rect.y0 + 7, 1);
    });
  });

  it('refuses bytes that are not a PDF and an object that is not there', async () => {
    await withDoc('blank.pdf', async (doc) => {
      await expect(
        pdfium.insertObject(doc, 0, { pdf: new Uint8Array([1, 2, 3]), matrix: [1, 0, 0, 1, 0, 0] }),
      ).rejects.toMatchObject({ code: 'invalid-argument' });
      await expect(pdfium.objectAsPdf(doc, 0, 3)).rejects.toMatchObject({
        code: 'invalid-argument',
      });
      await expect(pdfium.objectAsPdf(doc, 4, 0)).rejects.toMatchObject({ code: 'invalid-page' });
    });
  });
});

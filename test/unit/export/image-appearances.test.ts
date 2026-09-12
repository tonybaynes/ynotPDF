import { expect, it } from 'vitest';
import { PDFDocument, degrees } from 'pdf-lib';
import { engine } from '../engine/helpers';
import { appearanceFixture } from './appearance-fixtures';
import type { EmbeddedImage } from '@engine/PdfEngine';

function pixel(image: EmbeddedImage | undefined, x: number, y: number): number[] {
  if (!image) throw new Error('Missing appearance');
  return [...image.data.slice((y * image.width + x) * 4, (y * image.width + x) * 4 + 4)];
}

it('HTML appearances preserve complex-colour rotation/clip/opacity and nested state, excluding sibling paths, read-only', async () => {
  const e = await engine();
  const doc = await e.open(await appearanceFixture());
  try {
    const before = await e.save(doc);
    const images = await e.pageImages(doc, 0, { purpose: 'appearance' });
    expect(images).toHaveLength(2);
    expect(
      images.map(({ width, height, rect, index }) => ({ width, height, rect, index })),
    ).toEqual([
      { width: 20, height: 20, rect: { x0: 20, y0: 10, x1: 40, y1: 30 }, index: 0 },
      { width: 20, height: 20, rect: { x0: 55, y0: 10, x1: 75, y1: 30 }, index: 2 },
    ]);
    expect(pixel(images[0], 5, 5)).toEqual([0, 255, 0, 128]);
    expect(pixel(images[0], 5, 15)).toEqual([255, 0, 0, 128]);
    expect(pixel(images[0], 15, 5)[3]).toBe(0);
    expect(pixel(images[1], 5, 5)[3]).toBe(0);
    // PDFium's nested group compositing floors its two half-alpha factors.
    expect(pixel(images[1], 5, 15)).toEqual([255, 0, 0, 63]);
    expect(pixel(images[1], 15, 15)[3]).toBe(0); // ancestor/page clip, independent of the inner clip
    expect(await e.save(doc)).toEqual(before);
    const intrinsic = await e.pageImages(doc, 0, { output: 'png' });
    expect(intrinsic.map((i) => [i.width, i.height])).toEqual([
      [2, 2],
      [2, 2],
    ]);
    expect(pixel(intrinsic[0], 0, 0)).toEqual([255, 0, 0, 255]);
    await e.setObjectMatrix(doc, 0, 0, [0, 20, -20, 0, 42, 10]);
    const edited = await e.save(doc);
    const moved = await e.pageImages(doc, 0, { purpose: 'appearance' });
    expect(moved[0]?.rect).toEqual({ x0: 22, y0: 10, x1: 42, y1: 30 });
    expect(pixel(moved[0], 3, 5)).toEqual([0, 255, 0, 128]);
    expect(await e.save(doc)).toEqual(edited);
  } finally {
    await e.close(doc);
  }
});

it('appearance pixels keep original page coordinates under a nonzero CropBox and page rotation', async () => {
  const pdf = await PDFDocument.load(await appearanceFixture());
  const page = pdf.getPage(0);
  page.setCropBox(22, 12, 50, 25);
  page.setRotation(degrees(90));
  const e = await engine();
  const doc = await e.open(await pdf.save());
  try {
    const images = await e.pageImages(doc, 0, { purpose: 'appearance' });
    expect(images[0]?.rect).toEqual({ x0: 22, y0: 12, x1: 40, y1: 30 });
    expect(pixel(images[0], 3, 3)).toEqual([0, 255, 0, 128]);
    expect(pixel(images[0], 3, 13)).toEqual([255, 0, 0, 128]);
    expect(pixel(images[0], 13, 3)[3]).toBe(0);
  } finally {
    await e.close(doc);
  }
});

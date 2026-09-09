/**
 * Crop (M41). The geometry is all pure, so most of this file hands `inkBounds` a picture it drew
 * itself rather than a PDF: the question "where is the ink" has nothing to do with PDF, and a
 * test that has to render one cannot say what it means when it fails.
 *
 * The acceptance line — "crop to a rect ⇒ CropBox equals rect (±0.01 pt)" — is proved twice: here
 * over bytes, and in `test/unit/ops/commands.test.ts` through the undoable command the reader
 * actually runs.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import {
  clampRect,
  constrainRatio,
  cropPages,
  inkBounds,
  inkRect,
  marginsFromRect,
  rectFromMargins,
} from '@engine/ops/crop';
import { effectiveBox, readBox } from '@engine/ops/pdfdoc';
import { OpFailed, type Raster } from '@engine/ops/types';

const FIXTURES = join(process.cwd(), 'test', 'fixtures');

function fixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(FIXTURES, name)));
}

/** A raster with a background and an optional filled rectangle of "ink" in it. */
function picture(
  width: number,
  height: number,
  background: [number, number, number],
  ink?: {
    left: number;
    top: number;
    right: number;
    bottom: number;
    color: [number, number, number];
  },
): Raster {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const inside =
        ink !== undefined && x >= ink.left && x < ink.right && y >= ink.top && y < ink.bottom;
      const [r, g, b] = inside ? ink.color : background;
      const at = (y * width + x) * 4;
      data[at] = r;
      data[at + 1] = g;
      data[at + 2] = b;
      data[at + 3] = 255;
    }
  }
  return { data, width, height };
}

describe('inkBounds', () => {
  it('finds a black block on white paper', () => {
    const raster = picture(100, 80, [255, 255, 255], {
      left: 20,
      top: 10,
      right: 60,
      bottom: 50,
      color: [0, 0, 0],
    });
    expect(inkBounds(raster)).toEqual({ left: 20, top: 10, right: 60, bottom: 50 });
  });

  it('answers nothing for a blank page', () => {
    expect(inkBounds(picture(50, 50, [255, 255, 255]))).toBeNull();
  });

  it('takes the background from the corners, so cream paper still has margins', () => {
    const raster = picture(100, 80, [242, 236, 216], {
      left: 30,
      top: 20,
      right: 70,
      bottom: 60,
      color: [20, 20, 20],
    });
    expect(inkBounds(raster)).toEqual({ left: 30, top: 20, right: 70, bottom: 60 });
  });

  it('trims the white margins of an inverted page too', () => {
    const raster = picture(60, 60, [10, 10, 10], {
      left: 5,
      top: 15,
      right: 40,
      bottom: 45,
      color: [250, 250, 250],
    });
    expect(inkBounds(raster)).toEqual({ left: 5, top: 15, right: 40, bottom: 45 });
  });

  it('ignores noise below the tolerance', () => {
    const raster = picture(40, 40, [255, 255, 255], {
      left: 10,
      top: 10,
      right: 20,
      bottom: 20,
      color: [250, 250, 250],
    });
    expect(inkBounds(raster)).toBeNull();
  });

  it('refuses a raster whose data is too short to be what it claims', () => {
    expect(inkBounds({ data: new Uint8ClampedArray(8), width: 100, height: 100 })).toBeNull();
  });
});

describe('inkRect', () => {
  const page = { x0: 0, y0: 0, x1: 200, y1: 400 };

  it('turns pixels into page space, upside the right way up', () => {
    // A raster 100×200 over a 200×400 page: two points per pixel.
    const rect = inkRect(
      { left: 10, top: 20, right: 90, bottom: 180 },
      { width: 100, height: 200 },
      page,
    );
    expect(rect.x0).toBeCloseTo(20, 6);
    expect(rect.x1).toBeCloseTo(180, 6);
    // Pixel row 20 from the top is 40 pt from the top, i.e. y = 360.
    expect(rect.y1).toBeCloseTo(360, 6);
    expect(rect.y0).toBeCloseTo(40, 6);
  });

  it('adds a margin without leaving the page', () => {
    const rect = inkRect(
      { left: 0, top: 0, right: 100, bottom: 200 },
      { width: 100, height: 200 },
      page,
      20,
    );
    expect(rect).toEqual(page);
  });
});

describe('clampRect', () => {
  const bounds = { x0: 0, y0: 0, x1: 100, y1: 100 };

  it('keeps a rectangle inside its bounds', () => {
    expect(clampRect({ x0: -10, y0: -10, x1: 110, y1: 110 }, bounds)).toEqual(bounds);
  });

  it('never lets a rectangle collapse to nothing', () => {
    const r = clampRect({ x0: 50, y0: 50, x1: 50, y1: 50 }, bounds);
    expect(r.x1 - r.x0).toBeGreaterThan(0);
    expect(r.y1 - r.y0).toBeGreaterThan(0);
  });
});

describe('margins', () => {
  const outer = { x0: 0, y0: 0, x1: 100, y1: 200 };

  it('round-trip: rect → margins → rect', () => {
    const inner = { x0: 10, y0: 20, x1: 90, y1: 150 };
    expect(rectFromMargins(outer, marginsFromRect(outer, inner))).toEqual(inner);
  });

  it('measures top from the top of the page, not from the PDF origin', () => {
    expect(marginsFromRect(outer, { x0: 0, y0: 0, x1: 100, y1: 180 }).top).toBe(20);
  });
});

describe('constrainRatio', () => {
  const bounds = { x0: 0, y0: 0, x1: 1000, y1: 1000 };

  it('shrinks the long side, so a constrained drag stays where it was', () => {
    const r = constrainRatio({ x0: 0, y0: 0, x1: 200, y1: 100 }, 1, bounds);
    expect(r.x1 - r.x0).toBeCloseTo(100, 6);
    expect(r.y1 - r.y0).toBeCloseTo(100, 6);
    // About the centre: (100, 50).
    expect((r.x0 + r.x1) / 2).toBeCloseTo(100, 6);
    expect((r.y0 + r.y1) / 2).toBeCloseTo(50, 6);
  });

  it('leaves a rectangle that already has the ratio alone', () => {
    const r = { x0: 0, y0: 0, x1: 300, y1: 200 };
    expect(constrainRatio(r, 1.5, bounds)).toEqual(r);
  });

  it('ignores a ratio that is not a number', () => {
    const r = { x0: 0, y0: 0, x1: 10, y1: 10 };
    expect(constrainRatio(r, 0, bounds)).toEqual(r);
    expect(constrainRatio(r, Number.NaN, bounds)).toEqual(r);
  });
});

describe('cropPages', () => {
  it('sets the CropBox to exactly the rectangle asked for', async () => {
    // Inside every page of the fixture, whose sizes and orientations differ: a rectangle that
    // hung over the edge of one of them would be clamped, and the test would be about clamping.
    const rect = { x0: 40.25, y0: 60.5, x1: 400.75, y1: 500.125 };
    const result = await cropPages(fixture('multipage.pdf'), { box: 'crop', rect });
    const doc = await PDFDocument.load(result.bytes);
    for (const page of doc.getPages()) {
      const box = effectiveBox(page.node, 'crop');
      expect(box?.x0).toBeCloseTo(rect.x0, 2);
      expect(box?.y0).toBeCloseTo(rect.y0, 2);
      expect(box?.x1).toBeCloseTo(rect.x1, 2);
      expect(box?.y1).toBeCloseTo(rect.y1, 2);
    }
  });

  it('crops only the pages it is given', async () => {
    const before = await PDFDocument.load(fixture('multipage.pdf'));
    const wide = effectiveBox(before.getPage(1).node, 'crop');
    const result = await cropPages(fixture('multipage.pdf'), {
      box: 'crop',
      rect: { x0: 0, y0: 0, x1: 100, y1: 100 },
      pages: [0],
    });
    const doc = await PDFDocument.load(result.bytes);
    expect(effectiveBox(doc.getPage(0).node, 'crop').x1).toBeCloseTo(100, 2);
    expect(effectiveBox(doc.getPage(1).node, 'crop').x1).toBeCloseTo(wide.x1, 2);
  });

  it('takes margins off each page’s own box, whatever size it is', async () => {
    const result = await cropPages(fixture('multipage.pdf'), {
      box: 'crop',
      margins: { left: 10, right: 20, top: 30, bottom: 40 },
    });
    const before = await PDFDocument.load(fixture('multipage.pdf'));
    const after = await PDFDocument.load(result.bytes);
    for (const [i, page] of after.getPages().entries()) {
      const was = effectiveBox(before.getPage(i).node, 'crop');
      const now = effectiveBox(page.node, 'crop');
      expect(now.x0).toBeCloseTo(was.x0 + 10, 2);
      expect(now.x1).toBeCloseTo(was.x1 - 20, 2);
      expect(now.y1).toBeCloseTo(was.y1 - 30, 2);
      expect(now.y0).toBeCloseTo(was.y0 + 40, 2);
    }
  });

  it('writes the MediaBox too when the page size is meant to change', async () => {
    const rect = { x0: 20, y0: 20, x1: 300, y1: 400 };
    const result = await cropPages(fixture('blank.pdf'), {
      box: 'crop',
      rect,
      changePageSize: true,
    });
    const doc = await PDFDocument.load(result.bytes);
    expect(readBox(doc.getPage(0).node, 'media')?.x1).toBeCloseTo(300, 2);
  });

  it('can set one of the other three boxes without touching the CropBox', async () => {
    const before = await PDFDocument.load(fixture('blank.pdf'));
    const crop = effectiveBox(before.getPage(0).node, 'crop');
    const result = await cropPages(fixture('blank.pdf'), {
      box: 'trim',
      rect: { x0: 30, y0: 30, x1: 400, y1: 500 },
    });
    const doc = await PDFDocument.load(result.bytes);
    expect(readBox(doc.getPage(0).node, 'trim')?.x1).toBeCloseTo(400, 2);
    expect(effectiveBox(doc.getPage(0).node, 'crop').x1).toBeCloseTo(crop.x1, 2);
  });

  it('drops a Trim/Bleed/Art box the new CropBox no longer contains', async () => {
    // Page 4 of the fixture is the one that carries Trim, Bleed and Art.
    const before = await PDFDocument.load(fixture('mixed-boxes.pdf'));
    expect(readBox(before.getPage(3).node, 'trim')).not.toBeNull();
    const result = await cropPages(fixture('mixed-boxes.pdf'), {
      box: 'crop',
      rect: { x0: 0, y0: 0, x1: 20, y1: 20 },
      pages: [3],
    });
    const doc = await PDFDocument.load(result.bytes);
    expect(readBox(doc.getPage(3).node, 'trim')).toBeNull();
  });

  it('says so rather than cropping a page away to nothing', async () => {
    const result = await cropPages(fixture('blank.pdf'), {
      box: 'crop',
      margins: { left: 1000, right: 1000, top: 0, bottom: 0 },
    });
    expect(result.warnings.join(' ')).toContain('nothing');
  });

  it('needs to be told what to crop to', async () => {
    await expect(cropPages(fixture('blank.pdf'), { box: 'crop' })).rejects.toBeInstanceOf(OpFailed);
  });
});

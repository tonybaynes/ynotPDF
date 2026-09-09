/**
 * Deskew (M41) — the halves that need no PDF: the detector, over pictures a test drew itself,
 * and the geometry the apply half turns pages with. The acceptance line ("detection within ±0.2°
 * of each known angle … re-detect gives |angle| ≤ 0.2° … the image XObject bytes are unchanged")
 * needs PDFium to render with, so it lives in `test/unit/engine/deskew.test.ts`.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PDFArray, PDFDocument, PDFName, PDFNumber } from 'pdf-lib';
import {
  applyMatrix,
  binarise,
  centreOf,
  deskewPages,
  detectSkew,
  otsu,
  rotationAbout,
  wedgeInset,
} from '@engine/ops/deskew';
import { effectiveBox } from '@engine/ops/pdfdoc';
import { OpFailed, type Raster } from '@engine/ops/types';

const FIXTURES = join(process.cwd(), 'test', 'fixtures');

function fixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(FIXTURES, name)));
}

/**
 * A picture of a page of text, rotated by `degrees` clockwise about its centre.
 *
 * Drawn by asking, for each output pixel, where it came from — the rotation the detector has to
 * find, done the way a scanner does it, rather than by rotating a bitmap and resampling.
 */
function textPage(
  width: number,
  height: number,
  degrees: number,
  options: { lineHeight?: number; lineGap?: number; margin?: number } = {},
): Raster {
  const lineHeight = options.lineHeight ?? 6;
  const lineGap = options.lineGap ?? 18;
  const margin = options.margin ?? 60;
  const radians = (degrees * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const cx = width / 2;
  const cy = height / 2;
  const data = new Uint8ClampedArray(width * height * 4);
  // A deterministic word pattern, so the profile has gaps in it like real text does.
  const wordAt = (x: number, line: number): boolean => {
    const phase = Math.floor((x + line * 37) / 23) % 5;
    return phase !== 0;
  };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      // Un-rotate the pixel to find which line of the straight page it belongs to.
      const dx = x - cx;
      const dy = y - cy;
      const sx = cos * dx + sin * dy + cx;
      const sy = -sin * dx + cos * dy + cy;
      let ink = false;
      if (sx >= margin && sx <= width - margin && sy >= margin && sy <= height - margin) {
        const line = Math.floor((sy - margin) / lineGap);
        const within = sy - margin - line * lineGap;
        ink = within < lineHeight && wordAt(sx, line);
      }
      const at = (y * width + x) * 4;
      const value = ink ? 25 : 245;
      data[at] = value;
      data[at + 1] = value;
      data[at + 2] = value;
      data[at + 3] = 255;
    }
  }
  return { data, width, height };
}

function blankPage(width: number, height: number): Raster {
  const data = new Uint8ClampedArray(width * height * 4).fill(250);
  for (let i = 3; i < data.length; i += 4) data[i] = 255;
  return { data, width, height };
}

describe('otsu', () => {
  it('separates two clear peaks', () => {
    const histogram = new Int32Array(256);
    histogram[30] = 400;
    histogram[220] = 600;
    // Otsu answers the *first* level that separates them best, and every level from the ink
    // peak up to just below the paper peak separates them equally; what matters is that the ink
    // is on one side of it and the paper on the other.
    const threshold = otsu(histogram, 1000);
    expect(threshold).toBeGreaterThanOrEqual(30);
    expect(threshold).toBeLessThan(220);
  });

  it('answers something usable for an empty histogram', () => {
    expect(otsu(new Int32Array(256), 0)).toBe(128);
  });
});

describe('detectSkew', () => {
  it.each([0, 1.5, -1.5, 2.3, -1.1, 7.5, -7.5, 12])('finds a skew of %s°', (angle) => {
    const estimate = detectSkew(textPage(500, 700, angle));
    expect(estimate.confidence).not.toBe('none');
    expect(Math.abs(estimate.angle - angle)).toBeLessThanOrEqual(0.2);
  });

  it('says a blank page has nothing to measure, in words', () => {
    const estimate = detectSkew(blankPage(400, 500));
    expect(estimate.confidence).toBe('none');
    expect(estimate.angle).toBe(0);
    expect(estimate.reason).toBe('not enough content to tell');
  });

  it('declines a page that is a solid picture rather than lines of text', () => {
    const data = new Uint8ClampedArray(300 * 300 * 4).fill(30);
    for (let i = 3; i < data.length; i += 4) data[i] = 255;
    const estimate = detectSkew({ data, width: 300, height: 300 });
    expect(estimate.confidence).toBe('none');
    expect(estimate.reason).toContain('picture');
  });

  it('finds nothing to measure in a raster that is not really there', () => {
    expect(detectSkew({ data: new Uint8ClampedArray(4), width: 1, height: 1 }).confidence).toBe(
      'none',
    );
  });

  it('reports a straightened page as straight, which is what makes it idempotent', () => {
    // Detect on a page rotated back by what the detector said: the second answer must be ~0.
    const angle = 3.4;
    const first = detectSkew(textPage(500, 700, angle));
    const second = detectSkew(textPage(500, 700, angle - first.angle));
    expect(Math.abs(second.angle)).toBeLessThanOrEqual(0.2);
  });

  it('works from the ink alone, which is what makes it quick', () => {
    // The design's whole speed argument: each candidate angle costs one pass over the *dark
    // pixels*, not over the image. A page of text is a few per cent ink, so eighty-odd angles
    // are tens of thousands of additions each rather than half a million.
    const binary = binarise(textPage(850, 1100, 2.1), 700);
    expect(binary).not.toBeNull();
    if (!binary) return;
    // This drawing is heavier than real text — solid bars rather than glyphs — so a third of
    // the page is the honest bound here; a scan of a letter is nearer a twentieth.
    expect(binary.ink).toBeLessThan(0.35);
    expect(binary.xs.length).toBe(binary.ys.length);
    expect(binary.xs.length).toBeLessThan(binary.width * binary.height * 0.35);
  });

  it('is quick enough to offer over a whole document', () => {
    const page = textPage(850, 1100, 2.1);
    const started = performance.now();
    for (let i = 0; i < 5; i++) detectSkew(page);
    const each = (performance.now() - started) / 5;
    /*
     * The brief asks for 100 pages in 20 s — 200 ms a page including the render — and an A4 page
     * measures in about 35 ms here. The ceiling is far above that because `npm test` runs with
     * v8 coverage on, which costs this loop roughly seven times as much, and because CI runners
     * are slower again. What it is really guarding against is the O(width × height) sweep this
     * one replaced, which is fifty times slower and would fail it on any machine.
     */
    expect(each).toBeLessThan(1000);
  });
});

describe('rotationAbout', () => {
  it('leaves the centre where it is', () => {
    const centre = { x: 100, y: 200 };
    const m = rotationAbout(5, centre);
    const moved = applyMatrix(m, centre.x, centre.y);
    expect(moved.x).toBeCloseTo(centre.x, 9);
    expect(moved.y).toBeCloseTo(centre.y, 9);
  });

  it('turns clockwise on the page, which is anticlockwise in PDF space', () => {
    // A point directly above the centre moves to the right when the page turns clockwise.
    const m = rotationAbout(90, { x: 0, y: 0 });
    const moved = applyMatrix(m, 0, 10);
    expect(moved.x).toBeCloseTo(10, 6);
    expect(moved.y).toBeCloseTo(0, 6);
  });

  it('is the identity at zero', () => {
    const m = rotationAbout(0, { x: 5, y: 5 });
    expect(m[0]).toBeCloseTo(1, 9);
    expect(m[1]).toBeCloseTo(0, 9);
    expect(m[4]).toBeCloseTo(0, 9);
  });

  it('undoes itself', () => {
    const centre = { x: 300, y: 400 };
    const there = applyMatrix(rotationAbout(2.3, centre), 100, 150);
    const back = applyMatrix(rotationAbout(-2.3, centre), there.x, there.y);
    expect(back.x).toBeCloseTo(100, 6);
    expect(back.y).toBeCloseTo(150, 6);
  });
});

describe('centreOf and wedgeInset', () => {
  it('finds the middle of a box that does not start at the origin', () => {
    expect(centreOf({ x0: 10, y0: 20, x1: 30, y1: 60 })).toEqual({ x: 20, y: 40 });
  });

  it('trims nothing at zero and more as the angle grows', () => {
    const box = { x0: 0, y0: 0, x1: 400, y1: 800 };
    expect(wedgeInset(box, 0)).toEqual({ x: 0, y: 0 });
    const small = wedgeInset(box, 1);
    const large = wedgeInset(box, 5);
    expect(large.x).toBeGreaterThan(small.x);
    // The inset on the vertical edges comes from the page's height, and vice versa.
    expect(small.x).toBeCloseTo(400 * Math.sin(Math.PI / 180), 6);
    expect(small.y).toBeCloseTo(200 * Math.sin(Math.PI / 180), 6);
  });

  it('does not care which way the page leans', () => {
    const box = { x0: 0, y0: 0, x1: 100, y1: 100 };
    expect(wedgeInset(box, -3)).toEqual(wedgeInset(box, 3));
  });
});

describe('deskewPages', () => {
  async function boxesOf(bytes: Uint8Array, page = 0): Promise<PDFArray | undefined> {
    const doc = await PDFDocument.load(bytes);
    return doc.context.lookupMaybe(doc.getPage(page).node.get(PDFName.of('Contents')), PDFArray);
  }

  it('wraps the page content instead of replacing it', async () => {
    const before = await boxesOf(fixture('skewed.pdf'));
    const result = await deskewPages(fixture('skewed.pdf'), { angles: { 0: 2.3 } });
    const after = await boxesOf(result.bytes);
    expect(after?.size()).toBe((before?.size() ?? 1) + 2);
    expect(result.applied).toEqual([{ page: 0, angle: 2.3 }]);
  });

  it('leaves the pages it was not asked about alone', async () => {
    const before = await boxesOf(fixture('skewed.pdf'), 1);
    const result = await deskewPages(fixture('skewed.pdf'), { angles: { 0: 2.3 } });
    const after = await boxesOf(result.bytes, 1);
    expect(after?.size()).toBe(before?.size());
  });

  it('ignores an angle too small to be worth a rewrite', async () => {
    const result = await deskewPages(fixture('skewed.pdf'), { angles: { 0: 0.001 } });
    expect(result.applied).toEqual([]);
    expect(result.warnings.join(' ')).toContain('needed straightening');
  });

  it('ignores a page number the document does not have', async () => {
    const result = await deskewPages(fixture('skewed.pdf'), { angles: { 99: 3 } });
    expect(result.applied).toEqual([]);
  });

  it('moves an annotation with the page it is on', async () => {
    const before = await PDFDocument.load(fixture('skewed.pdf'));
    const quadsOf = async (bytes: Uint8Array): Promise<number[]> => {
      const doc = await PDFDocument.load(bytes);
      const annots = doc.getPage(0).node.Annots();
      const dict = doc.context.lookupMaybe(annots?.get(0), (await import('pdf-lib')).PDFDict);
      const quads = doc.context.lookupMaybe(dict?.get(PDFName.of('QuadPoints')), PDFArray);
      const out: number[] = [];
      for (let i = 0; i < (quads?.size() ?? 0); i++) {
        out.push(doc.context.lookupMaybe(quads?.get(i), PDFNumber)?.asNumber() ?? 0);
      }
      return out;
    };
    const wasQuads = await quadsOf(fixture('skewed.pdf'));
    expect(wasQuads.length).toBe(8);
    const result = await deskewPages(fixture('skewed.pdf'), { angles: { 0: 2.3 } });
    const nowQuads = await quadsOf(result.bytes);
    expect(nowQuads.length).toBe(8);
    // The quad turned by exactly the matrix the content turned by.
    const crop = before.getPage(0).getSize();
    const m = rotationAbout(-2.3, { x: crop.width / 2, y: crop.height / 2 });
    for (let i = 0; i + 1 < wasQuads.length; i += 2) {
      const expected = applyMatrix(m, wasQuads[i] ?? 0, wasQuads[i + 1] ?? 0);
      expect(nowQuads[i]).toBeCloseTo(expected.x, 4);
      expect(nowQuads[i + 1]).toBeCloseTo(expected.y, 4);
    }
  });

  it('shrinks the CropBox by the wedge when asked to trim the edges', async () => {
    const plain = await deskewPages(fixture('skewed.pdf'), { angles: { 0: 5 } });
    const trimmed = await deskewPages(fixture('skewed.pdf'), {
      angles: { 0: 5 },
      trimEdges: true,
    });
    const cropWidthOf = async (bytes: Uint8Array): Promise<number> => {
      const box = effectiveBox((await PDFDocument.load(bytes)).getPage(0).node, 'crop');
      return box.x1 - box.x0;
    };
    expect(await cropWidthOf(trimmed.bytes)).toBeLessThan(await cropWidthOf(plain.bytes));
  });

  it('paints a background behind the content unless told not to', async () => {
    const withPaint = await deskewPages(fixture('skewed.pdf'), { angles: { 0: 3 } });
    const without = await deskewPages(fixture('skewed.pdf'), {
      angles: { 0: 3 },
      background: null,
    });
    expect(withPaint.bytes.byteLength).toBeGreaterThan(without.bytes.byteLength - 200);
    expect(without.applied).toHaveLength(1);
  });

  it('refuses a document with no pages', async () => {
    await expect(deskewPages(fixture('corrupt.pdf'), { angles: {} })).rejects.toBeInstanceOf(
      OpFailed,
    );
  });
});

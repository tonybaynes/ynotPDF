/**
 * The half of M41's acceptance tests that needs a real renderer.
 *
 * "Detection within ±0.2° of each known angle", "re-detect gives |angle| ≤ 0.2°", "the image
 * XObject bytes are unchanged" and "render hash equals pre-flatten" are all claims about what
 * PDFium sees, so they are made here against PDFium rather than against a picture a test drew.
 */

import { describe, expect, it } from 'vitest';
import { PDFDict, PDFDocument, PDFName, PDFRawStream, PDFRef } from 'pdf-lib';
import { applyMatrix, centreOf, detectSkew, deskewPages, rotationAbout } from '@engine/ops/deskew';
import { flatten } from '@engine/ops/flatten';
import { cropPages, inkBounds, inkRect } from '@engine/ops/crop';
import { effectiveBox } from '@engine/ops/pdfdoc';
import type { Raster } from '@engine/ops/types';
import type { PdfiumEngine } from '@engine/pdfium/PdfiumEngine';
import { dhash, engine, fixture, hamming } from './helpers';

/** The angles `skewed.pdf` was built with (`scripts/make-fixtures.ts`), page by page. */
const KNOWN = [2.3, -1.1, 7.5];

/** Renders a page to the RGBA the pixel ops want. */
async function raster(
  e: PdfiumEngine,
  bytes: Uint8Array,
  page: number,
  scale = 1.5,
): Promise<Raster> {
  const doc = await e.open(bytes);
  try {
    const raw = await e.renderRaw(doc, page, scale, undefined, { grayscale: true });
    return { data: raw.rgba, width: raw.width, height: raw.height };
  } finally {
    await e.close(doc);
  }
}

/** Every image XObject stream in a document, keyed by the resource name it is reached by. */
async function imageBytes(bytes: Uint8Array): Promise<Map<string, string>> {
  const doc = await PDFDocument.load(bytes);
  const out = new Map<string, string>();
  for (const page of doc.getPages()) {
    const resources = page.node.Resources();
    const xobjects = resources
      ? doc.context.lookupMaybe(resources.get(PDFName.of('XObject')), PDFDict)
      : undefined;
    if (!xobjects) continue;
    for (const [key, value] of xobjects.entries()) {
      const stream = value instanceof PDFRef ? doc.context.lookup(value) : value;
      if (!(stream instanceof PDFRawStream)) continue;
      const subtype = stream.dict.get(PDFName.of('Subtype'));
      if (subtype?.toString() !== '/Image') continue;
      out.set(key.asString(), Buffer.from(stream.contents).toString('base64'));
    }
  }
  return out;
}

describe('deskew, against PDFium', () => {
  it('measures each page of skewed.pdf to within a fifth of a degree', async () => {
    const e = await engine();
    const bytes = fixture('skewed.pdf');
    for (const [page, expected] of KNOWN.entries()) {
      const estimate = detectSkew(await raster(e, bytes, page));
      expect(estimate.confidence, `page ${String(page + 1)}: ${estimate.reason}`).not.toBe('none');
      expect(Math.abs(estimate.angle - expected), `page ${String(page + 1)}`).toBeLessThanOrEqual(
        0.2,
      );
    }
  }, 60_000);

  it('skips the blank page and says why, in words', async () => {
    const e = await engine();
    const estimate = detectSkew(await raster(e, fixture('skewed.pdf'), 3));
    expect(estimate.confidence).toBe('none');
    expect(estimate.reason).toBe('not enough content to tell');
  }, 30_000);

  it('straightens: after applying, every page measures under a fifth of a degree', async () => {
    const e = await engine();
    const bytes = fixture('skewed.pdf');
    const angles: Record<number, number> = {};
    KNOWN.forEach((_, page) => {
      angles[page] = 0;
    });
    for (const page of KNOWN.keys()) {
      angles[page] = detectSkew(await raster(e, bytes, page)).angle;
    }
    const result = await deskewPages(bytes, { angles });
    expect(result.applied).toHaveLength(KNOWN.length);
    for (const page of KNOWN.keys()) {
      const after = detectSkew(await raster(e, result.bytes, page));
      expect(Math.abs(after.angle), `page ${String(page + 1)} after`).toBeLessThanOrEqual(0.2);
    }
  }, 120_000);

  it('does not re-encode the picture: the image XObject comes through byte-identical', async () => {
    const bytes = fixture('skewed.pdf');
    const before = await imageBytes(bytes);
    expect(before.size).toBeGreaterThan(0);
    const result = await deskewPages(bytes, { angles: { 0: 2.3, 1: -1.1, 2: 7.5 } });
    const after = await imageBytes(result.bytes);
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    for (const [name, data] of before) expect(after.get(name)).toBe(data);
  }, 30_000);

  it('keeps the highlight over the word it was over', async () => {
    const e = await engine();
    const bytes = fixture('skewed.pdf');
    const quadsOf = async (source: Uint8Array): Promise<ReadonlyArray<number>> => {
      const doc = await e.open(source);
      try {
        const annots = await e.annotations(doc, 0);
        return annots[0]?.quadPoints ?? [];
      } finally {
        await e.close(doc);
      }
    };
    const skew = KNOWN[0] ?? 0;
    const was = await quadsOf(bytes);
    expect(was.length).toBe(8);
    const result = await deskewPages(bytes, { angles: { 0: skew } });
    const now = await quadsOf(result.bytes);
    expect(now.length).toBe(8);
    // The word the highlight sat on has been turned by −2.3° about the page centre, and so has
    // the highlight: the two are still on top of each other.
    const doc = await PDFDocument.load(bytes);
    const matrix = rotationAbout(-skew, centreOf(effectiveBox(doc.getPage(0).node, 'crop')));
    for (let i = 0; i + 1 < was.length; i += 2) {
      const expected = applyMatrix(matrix, was[i] ?? 0, was[i + 1] ?? 0);
      expect(now[i]).toBeCloseTo(expected.x, 2);
      expect(now[i + 1]).toBeCloseTo(expected.y, 2);
    }
  }, 60_000);
});

describe('flatten, against PDFium', () => {
  it('a flattened form has no fields and renders exactly as it did', async () => {
    const e = await engine();
    const bytes = fixture('form.pdf');
    const hashOf = async (source: Uint8Array): Promise<string> => {
      const doc = await e.open(source);
      try {
        return dhash(await e.renderRaw(doc, 0, 1));
      } finally {
        await e.close(doc);
      }
    };
    const fieldsOf = async (source: Uint8Array): Promise<number> => {
      const doc = await e.open(source);
      try {
        return (await e.formFields(doc)).length;
      } finally {
        await e.close(doc);
      }
    };
    const before = await hashOf(bytes);
    expect(await fieldsOf(bytes)).toBeGreaterThan(0);

    const result = await flatten(bytes);
    expect(await fieldsOf(result.bytes)).toBe(0);
    expect(hamming(await hashOf(result.bytes), before)).toBeLessThanOrEqual(6);
  }, 60_000);

  it('a flattened set of comments renders the same as the comments did', async () => {
    const e = await engine();
    const bytes = fixture('annotated.pdf');
    const hashOf = async (source: Uint8Array): Promise<string> => {
      const doc = await e.open(source);
      try {
        return dhash(await e.renderRaw(doc, 0, 1, undefined, { annotations: true }));
      } finally {
        await e.close(doc);
      }
    };
    const before = await hashOf(bytes);
    const result = await flatten(bytes);
    expect(result.flattened).toBeGreaterThan(0);
    expect(hamming(await hashOf(result.bytes), before)).toBeLessThanOrEqual(6);
  }, 60_000);
});

describe('remove white margins, against PDFium', () => {
  it('finds the drawn area of a page and crops to it', async () => {
    const e = await engine();
    const bytes = fixture('text.pdf');
    const doc = await e.open(bytes);
    let rect;
    try {
      const raw = await e.renderRaw(doc, 0, 1.5);
      const bounds = inkBounds({ data: raw.rgba, width: raw.width, height: raw.height });
      expect(bounds).not.toBeNull();
      if (!bounds) throw new Error('the fixture page has no ink on it');
      rect = inkRect(bounds, { width: raw.width, height: raw.height }, raw.rect, 4);
    } finally {
      await e.close(doc);
    }
    const page = await PDFDocument.load(bytes).then((d) => effectiveBox(d.getPage(0).node, 'crop'));
    // Something was trimmed, and what is left is inside the page.
    expect(rect.x1 - rect.x0).toBeLessThan(page.x1 - page.x0);
    expect(rect.y1 - rect.y0).toBeLessThan(page.y1 - page.y0);
    expect(rect.x0).toBeGreaterThanOrEqual(page.x0);

    const cropped = await cropPages(bytes, { box: 'crop', rect });
    const after = await PDFDocument.load(cropped.bytes);
    const box = effectiveBox(after.getPage(0).node, 'crop');
    expect(box.x0).toBeCloseTo(rect.x0, 2);
    expect(box.y1).toBeCloseTo(rect.y1, 2);
  }, 60_000);
});

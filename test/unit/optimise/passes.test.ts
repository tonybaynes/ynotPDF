/**
 * The individual passes (M100): discard, duplicate merging, and the codec arithmetic underneath
 * the image pipeline.
 *
 * These are the parts that read and write PDF structure rather than pixels, so they are checked
 * against documents built here and against the corpus — and, where it matters, by putting the
 * result back through PDFium, because "pdf-lib accepted it" and "a reader can open it" are not
 * the same statement.
 */

import { describe, expect, it } from 'vitest';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream } from 'pdf-lib';
import {
  NO_CHANGE,
  dedupe,
  discard,
  optimise,
  repairBytes,
  type DiscardOptions,
} from '@engine/optimise';
import { deflate, inflate, packMono, undoPredictor, unpack } from '@engine/optimise/images/codecs';
import { decodeJpeg, encodeJpeg } from '@engine/optimise/images/codecs';
import { factsOf, fixture, structureHook } from './helpers';

const NOTHING: DiscardOptions = NO_CHANGE.discard;

async function load(name: string): Promise<PDFDocument> {
  return PDFDocument.load(fixture(name), {
    ignoreEncryption: true,
    updateMetadata: false,
    throwOnInvalidObject: false,
  });
}

describe('discarding', () => {
  it('removes the bookmarks and nothing else', async () => {
    const doc = await load('outline.pdf');
    expect(doc.catalog.get(PDFName.of('Outlines'))).toBeDefined();
    const outcome = discard(doc, { ...NOTHING, bookmarks: true });
    expect(outcome.removed['bookmarks']).toBe(1);
    expect(doc.catalog.get(PDFName.of('Outlines'))).toBeUndefined();
    expect(doc.getPageCount()).toBe(3);
  });

  it('removes comments but leaves links and form fields where they are', async () => {
    const doc = await load('annotations-all.pdf');
    const before = countAnnots(doc);
    const outcome = discard(doc, { ...NOTHING, comments: true });
    expect(outcome.removed['comments']).toBeGreaterThan(0);
    const after = annotSubtypes(doc);
    expect(after.every((s) => s === '/Link' || s === '/Widget')).toBe(true);
    expect(countAnnots(doc)).toBeLessThan(before);
  });

  it('removes links and leaves the rest', async () => {
    const doc = await load('links.pdf');
    const outcome = discard(doc, { ...NOTHING, links: true });
    expect(outcome.removed['links']).toBeGreaterThan(0);
    expect(annotSubtypes(doc)).not.toContain('/Link');
  });

  it('removes the form and says what that costs', async () => {
    const doc = await load('forms-all.pdf');
    const outcome = discard(doc, { ...NOTHING, forms: true });
    expect(doc.catalog.get(PDFName.of('AcroForm'))).toBeUndefined();
    expect(outcome.warnings.join(' ')).toMatch(/typed into them is gone/i);
    expect(annotSubtypes(doc)).not.toContain('/Widget');
  });

  it('removes the attachments, and says so when the document was a portfolio', async () => {
    const doc = await load('portfolio.pdf');
    const outcome = discard(doc, { ...NOTHING, embeddedFiles: true });
    expect(outcome.removed['embeddedFiles']).toBeGreaterThan(0);
    expect(outcome.warnings.join(' ')).toMatch(/portfolio/i);
    expect(doc.catalog.get(PDFName.of('Collection'))).toBeUndefined();
  });

  it('removes the metadata and the information dictionary together', async () => {
    const doc = await load('initial-view.pdf');
    const outcome = discard(doc, { ...NOTHING, metadata: true });
    expect(outcome.removed['metadata']).toBeGreaterThan(0);
    expect(doc.catalog.get(PDFName.of('Metadata'))).toBeUndefined();
    expect(doc.context.trailerInfo.Info).toBeUndefined();
  });

  it('removes document JavaScript', async () => {
    const doc = await load('javascript.pdf');
    const outcome = discard(doc, { ...NOTHING, javascript: true });
    expect(outcome.removed['javascript']).toBeGreaterThan(0);
  });

  it('removes thumbnails and private data', async () => {
    const doc = await load('bloated.pdf');
    const outcome = discard(doc, { ...NOTHING, thumbnails: true, privateData: true });
    expect(outcome.removed['thumbnails']).toBe(3);
    expect(outcome.removed['privateData']).toBeGreaterThan(0);
    expect(doc.catalog.get(PDFName.of('PieceInfo'))).toBeUndefined();
  });

  it('does nothing at all when it is told to discard nothing', async () => {
    const doc = await load('annotations-all.pdf');
    const before = countAnnots(doc);
    const outcome = discard(doc, NOTHING);
    expect(outcome.removed).toEqual({});
    expect(outcome.warnings).toEqual([]);
    expect(countAnnots(doc)).toBe(before);
  });

  it('leaves a document that still opens after everything has gone', async () => {
    const bytes = fixture('annotations-all.pdf');
    const before = await factsOf(bytes);
    const everything: DiscardOptions = {
      thumbnails: true,
      alternateImages: true,
      metadata: true,
      bookmarks: true,
      links: true,
      comments: true,
      forms: true,
      embeddedFiles: true,
      javascript: true,
      privateData: true,
    };
    const result = await optimise(
      bytes,
      { ...NO_CHANGE, discard: everything },
      { structure: structureHook() },
    );
    const after = await factsOf(result.bytes);
    expect(after.pages).toBe(before.pages);
    expect(after.text).toEqual(before.text);
  });
});

describe('merging duplicates', () => {
  it('merges the three identical pictures in the bloated fixture into one', async () => {
    const doc = await load('bloated.pdf');
    const before = imageRefs(doc).length;
    expect(before).toBe(3);
    const outcome = dedupe(doc, { images: true, fonts: true, xobjects: true });
    // Four merges, not two: the fixture also carries three identical page thumbnails.
    expect(outcome.images).toBe(4);
    expect(outcome.saved).toBeGreaterThan(0);
    expect(imageRefs(doc)).toHaveLength(1);
  });

  it('leaves them alone when it is told not to', async () => {
    const doc = await load('bloated.pdf');
    const outcome = dedupe(doc, { images: false, fonts: false, xobjects: false });
    expect(outcome).toMatchObject({ images: 0, fonts: 0, xobjects: 0, saved: 0 });
    expect(imageRefs(doc)).toHaveLength(3);
  });

  it('leaves a document whose pages still draw the right picture', async () => {
    const bytes = fixture('bloated.pdf');
    const result = await optimise(
      bytes,
      { ...NO_CHANGE, dedupe: { images: true, fonts: true, xobjects: true } },
      { structure: structureHook() },
    );
    const doc = await PDFDocument.load(result.bytes, { ignoreEncryption: true });
    expect(doc.getPageCount()).toBe(3);
    // Every page still names an image, and they are all the same one.
    const named = doc.getPages().map((page) => {
      const resources = page.node.Resources();
      const xobjects = resources?.lookupMaybe(PDFName.of('XObject'), PDFDict);
      return [...(xobjects?.entries() ?? [])].map(([, ref]) => ref.toString()).join(',');
    });
    expect(new Set(named).size).toBe(1);
  });
});

describe('codecs', () => {
  it('round-trips flate', () => {
    const data = new Uint8Array(1024).map((_, i) => (i * 37) % 251);
    expect(inflate(deflate(data))).toEqual(data);
  });

  it('round-trips JPEG closely enough to see it is the same picture', () => {
    const width = 32;
    const height = 32;
    const rgb = new Uint8Array(width * height * 3);
    for (let i = 0; i < width * height; i++) {
      rgb[i * 3] = (i * 3) % 256;
      rgb[i * 3 + 1] = 128;
      rgb[i * 3 + 2] = 255 - ((i * 3) % 256);
    }
    const encoded = encodeJpeg({ data: rgb, width, height, components: 3 }, 95);
    const decoded = decodeJpeg(encoded);
    expect(decoded).not.toBeNull();
    expect(decoded?.width).toBe(width);
    expect(decoded?.height).toBe(height);
    // A high-quality JPEG of a smooth ramp should be within a few levels everywhere.
    let worst = 0;
    for (let i = 0; i < rgb.length; i++) {
      worst = Math.max(worst, Math.abs((decoded?.data[i] ?? 0) - (rgb[i] ?? 0)));
    }
    expect(worst).toBeLessThan(40);
  });

  it('refuses bytes that are not a JPEG', () => {
    expect(decodeJpeg(new Uint8Array([1, 2, 3, 4]))).toBeNull();
  });

  it('undoes a PNG predictor', () => {
    // Two rows of three RGB pixels, filter type 1 (Sub) on both.
    const raw = new Uint8Array([
      1,
      10,
      20,
      30,
      1,
      1,
      1,
      2,
      2,
      2, // row 0: 10,20,30 then +1 then +2
      1,
      5,
      5,
      5,
      0,
      0,
      0,
      0,
      0,
      0, // row 1: 5,5,5 then unchanged twice
    ]);
    const out = undoPredictor(raw, {
      predictor: 12,
      colors: 3,
      bitsPerComponent: 8,
      columns: 3,
    });
    expect([...out]).toEqual([10, 20, 30, 11, 21, 31, 13, 23, 33, 5, 5, 5, 5, 5, 5, 5, 5, 5]);
  });

  it('undoes a TIFF predictor', () => {
    const raw = new Uint8Array([10, 1, 2, 20, 3, 4]);
    const out = undoPredictor(raw, {
      predictor: 2,
      colors: 1,
      bitsPerComponent: 8,
      columns: 3,
    });
    expect([...out]).toEqual([10, 11, 13, 20, 23, 27]);
  });

  it('leaves data alone when there is no predictor', () => {
    const raw = new Uint8Array([1, 2, 3]);
    expect(
      undoPredictor(raw, { predictor: 1, colors: 1, bitsPerComponent: 8, columns: 3 }),
    ).toEqual(raw);
  });

  it('unpacks sub-byte samples with rows aligned to a byte', () => {
    // 5 pixels of 1 bit each: 10110___, so two bytes' worth of rows.
    const raw = new Uint8Array([0b10110000, 0b01001000]);
    const out = unpack(raw, 5, 2, 1, 1);
    expect([...out]).toEqual([255, 0, 255, 255, 0, 0, 255, 0, 0, 255]);
  });

  it('packs one-bit samples back the way it found them', () => {
    const data = new Uint8Array([255, 0, 255, 255, 0]);
    const packed = packMono({ data, width: 5, height: 1, components: 1 });
    expect(packed).toHaveLength(1);
    expect(packed[0]).toBe(0b10110000);
  });

  it('scales a 4-bit sample to the full range', () => {
    // One 4-bit pixel of value 15 is white; one of value 0 is black.
    const out = unpack(new Uint8Array([0xf0]), 2, 1, 1, 4);
    expect([...out]).toEqual([255, 0]);
  });
});

describe('repair, when neither engine is available', () => {
  it('says a file is beyond repair rather than returning it unchanged', async () => {
    await expect(repairBytes(fixture('corrupt.pdf'), {})).rejects.toThrow(/too badly damaged/i);
  });

  it('quotes what the check said when it has one', async () => {
    await expect(
      repairBytes(fixture('corrupt.pdf'), {}, ['the cross-reference table is missing']),
    ).rejects.toThrow(/cross-reference table is missing/);
  });

  it('falls through to the second engine when the first refuses', async () => {
    const result = await repairBytes(new Uint8Array([1, 2, 3]), {
      reopen: () => Promise.reject(new Error('PDFium said no')),
      rewrite: () =>
        Promise.resolve({ bytes: new Uint8Array([4, 5, 6]), repaired: true, warnings: [] }),
    });
    expect([...result.bytes]).toEqual([4, 5, 6]);
  });

  it('warns that a rebuilt file is not the file it was', async () => {
    const result = await repairBytes(new Uint8Array([1]), {
      reopen: (bytes) => Promise.resolve(bytes),
    });
    expect(result.warnings.join(' ')).toMatch(/compare it with the original/i);
  });
});

// ---- helpers ---------------------------------------------------------------------------------

function annotSubtypes(doc: PDFDocument): string[] {
  const out: string[] = [];
  for (const page of doc.getPages()) {
    const annots = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
    for (const item of annots?.asArray() ?? []) {
      const dict = doc.context.lookupMaybe(item, PDFDict);
      const subtype = dict?.lookupMaybe(PDFName.of('Subtype'), PDFName)?.asString();
      if (subtype) out.push(subtype);
    }
  }
  return out;
}

function countAnnots(doc: PDFDocument): number {
  return annotSubtypes(doc).length;
}

/** Every image XObject named by a page, de-duplicated by reference. */
function imageRefs(doc: PDFDocument): string[] {
  const seen = new Set<string>();
  for (const page of doc.getPages()) {
    const xobjects = page.node.Resources()?.lookupMaybe(PDFName.of('XObject'), PDFDict);
    for (const [, ref] of xobjects?.entries() ?? []) {
      const stream = doc.context.lookup(ref);
      if (!(stream instanceof PDFRawStream)) continue;
      const subtype = stream.dict.lookupMaybe(PDFName.of('Subtype'), PDFName);
      if (subtype?.asString() !== '/Image') continue;
      seen.add(ref.toString());
    }
  }
  return [...seen];
}

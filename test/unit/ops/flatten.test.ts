/**
 * Flatten (M41). The acceptance line is "flatten a form fixture ⇒ no fields, render hash equals
 * pre-flatten", and the second half of it is the whole point: flattening must be invisible.
 * Rendering is PDFium's job, so that half runs against the real engine in
 * `test/unit/engine/ops-flatten.test.ts`; here the structure is checked, plus the placement
 * matrix from PDF 12.5.5, which is the arithmetic everything else rests on.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PDFStream } from 'pdf-lib';
import { PDFArray, PDFDict, PDFDocument, PDFName } from 'pdf-lib';
import { flatten, placementMatrix } from '@engine/ops/flatten';
import { OpCancelled } from '@engine/ops/types';

const FIXTURES = join(process.cwd(), 'test', 'fixtures');

function fixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(FIXTURES, name)));
}

function annotationCount(doc: PDFDocument, page = 0): number {
  return doc.getPage(page).node.Annots()?.size() ?? 0;
}

function xobjectNames(doc: PDFDocument, page = 0): string[] {
  const resources = doc.getPage(page).node.Resources();
  const xobjects = resources
    ? doc.context.lookupMaybe(resources.get(PDFName.of('XObject')), PDFDict)
    : undefined;
  return xobjects ? xobjects.entries().map(([key]) => key.asString()) : [];
}

/** How many content streams the page has, so "did anything get appended" is answerable. */
function contentStreams(doc: PDFDocument, page = 0): number {
  const contents = doc.getPage(page).node.get(PDFName.of('Contents'));
  const array = doc.context.lookupMaybe(contents, PDFArray);
  return array ? array.size() : contents === undefined ? 0 : 1;
}

describe('placementMatrix', () => {
  /** A form XObject with a BBox and an optional Matrix, as an appearance stream is. */
  async function stream(
    bbox: number[],
    matrix?: number[],
  ): Promise<{ ctx: PDFDocument['context']; stream: PDFStream }> {
    const doc = await PDFDocument.create();
    const s = doc.context.flateStream('', {
      Type: 'XObject',
      Subtype: 'Form',
      BBox: bbox,
      ...(matrix ? { Matrix: matrix } : {}),
    });
    return { ctx: doc.context, stream: s };
  }

  it('maps an unrotated BBox onto the Rect', async () => {
    const { ctx, stream: s } = await stream([0, 0, 10, 20]);
    const m = placementMatrix(ctx, s, { x0: 100, y0: 200, x1: 120, y1: 240 });
    expect(m).toEqual([2, 0, 0, 2, 100, 200]);
  });

  it('accounts for the appearance’s own Matrix', async () => {
    // Rotated 90°: the 10×20 box becomes 20 wide and 10 tall.
    const { ctx, stream: s } = await stream([0, 0, 10, 20], [0, 1, -1, 0, 0, 0]);
    const m = placementMatrix(ctx, s, { x0: 0, y0: 0, x1: 40, y1: 20 });
    expect(m[0]).toBeCloseTo(2, 6);
    expect(m[3]).toBeCloseTo(2, 6);
    // The rotated box runs from x = −20 to 0, so it has to be shifted right by 40.
    expect(m[4]).toBeCloseTo(40, 6);
  });

  it('translates rather than scaling by infinity when the BBox is degenerate', async () => {
    const { ctx, stream: s } = await stream([5, 5, 5, 5]);
    const m = placementMatrix(ctx, s, { x0: 10, y0: 20, x1: 30, y1: 40 });
    expect(m).toEqual([1, 0, 0, 1, 5, 15]);
  });

  it('is the identity when there is no BBox at all', async () => {
    const doc = await PDFDocument.create();
    const s = doc.context.flateStream('', { Type: 'XObject', Subtype: 'Form' });
    expect(placementMatrix(doc.context, s, { x0: 0, y0: 0, x1: 1, y1: 1 })).toEqual([
      1, 0, 0, 1, 0, 0,
    ]);
  });
});

describe('flatten', () => {
  it('leaves a form with no fields, and draws them into the page instead', async () => {
    const before = await PDFDocument.load(fixture('form.pdf'));
    expect(before.getForm().getFields().length).toBeGreaterThan(0);
    const streamsBefore = contentStreams(before);

    const result = await flatten(fixture('form.pdf'));
    const after = await PDFDocument.load(result.bytes);
    // The catalogue is asked first: pdf-lib's `getForm()` *creates* an `/AcroForm` when the
    // document has none, so asking it first would prove nothing about what was written.
    expect(after.catalog.get(PDFName.of('AcroForm'))).toBeUndefined();
    expect(after.getForm().getFields()).toHaveLength(0);
    expect(result.flattened).toBeGreaterThan(0);
    expect(contentStreams(after)).toBeGreaterThan(streamsBefore);
    expect(xobjectNames(after).some((n) => n.startsWith('/Fx'))).toBe(true);
  });

  it('bakes markup annotations and leaves none behind', async () => {
    const result = await flatten(fixture('annotated.pdf'));
    const after = await PDFDocument.load(result.bytes);
    expect(annotationCount(after)).toBe(0);
    expect(result.flattened).toBeGreaterThan(0);
  });

  it('removes rather than draws when told to', async () => {
    const result = await flatten(fixture('annotated.pdf'), { remove: true });
    const after = await PDFDocument.load(result.bytes);
    expect(annotationCount(after)).toBe(0);
    expect(result.flattened).toBe(0);
    expect(result.removed).toBeGreaterThan(0);
    expect(xobjectNames(after).some((n) => n.startsWith('/Fx'))).toBe(false);
  });

  it('keeps links: a flattened link would be a deleted link', async () => {
    const before = await PDFDocument.load(fixture('links.pdf'));
    const result = await flatten(fixture('links.pdf'));
    const after = await PDFDocument.load(result.bytes);
    const linksOf = (doc: PDFDocument): number => {
      const annots = doc.getPage(0).node.Annots();
      if (!annots) return 0;
      let n = 0;
      for (let i = 0; i < annots.size(); i++) {
        const dict = doc.context.lookupMaybe(annots.get(i), PDFDict);
        if (dict?.get(PDFName.of('Subtype'))?.toString() === '/Link') n++;
      }
      return n;
    };
    expect(linksOf(after)).toBe(linksOf(before));
  });

  it('flattens annotations without touching the form when asked for only one', async () => {
    const result = await flatten(fixture('forms-all.pdf'), { forms: false, annotations: true });
    const after = await PDFDocument.load(result.bytes);
    expect(after.getForm().getFields().length).toBeGreaterThan(0);
  });

  it('only touches the pages it is given', async () => {
    const result = await flatten(fixture('annotations-all.pdf'), { pages: [99] });
    expect(result.flattened).toBe(0);
    expect(result.removed).toBe(0);
  });

  it('drops a hidden annotation rather than making it appear', async () => {
    // `annotations-all.pdf` carries one with the Hidden flag set (M10's fixture).
    const result = await flatten(fixture('annotations-all.pdf'));
    expect(result.removed).toBeGreaterThan(0);
  });

  it('says in words when an annotation has no drawing of its own', async () => {
    const result = await flatten(fixture('annotations-all.pdf'));
    // Every warning is a sentence, not a code.
    for (const warning of result.warnings) expect(warning).toMatch(/^[A-Z].* .*/);
  });

  it('leaves a document with no annotations exactly as it was', async () => {
    const result = await flatten(fixture('blank.pdf'));
    expect(result.flattened).toBe(0);
    expect(result.removed).toBe(0);
    expect(result.warnings).toEqual([]);
  });

  it('stops when the signal says so', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      flatten(fixture('annotated.pdf'), {}, { signal: controller.signal }),
    ).rejects.toBeInstanceOf(OpCancelled);
  });
});

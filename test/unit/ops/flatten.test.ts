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
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName } from 'pdf-lib';
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

describe('drawing what the file did not', () => {
  /** A document with one annotation that has no `/AP` of its own. */
  async function undrawn(
    subtype: string,
    extra: Record<string, unknown> = {},
  ): Promise<Uint8Array> {
    const doc = await PDFDocument.create();
    const page = doc.addPage([200, 200]);
    const ctx = doc.context;
    page.node.set(
      PDFName.of('Annots'),
      ctx.obj([
        ctx.obj({
          Type: 'Annot',
          Subtype: subtype,
          Rect: [20, 20, 120, 80],
          C: [1, 0, 0],
          F: 4,
          ...extra,
        }),
      ]),
    );
    return await doc.save({ addDefaultPage: false, updateFieldAppearances: false });
  }

  it('draws a square the file left to the viewer, with the same generators M21 uses', async () => {
    const result = await flatten(await undrawn('Square'));
    expect(result.flattened).toBe(1);
    const after = await PDFDocument.load(result.bytes);
    expect(annotationCount(after)).toBe(0);
    expect(xobjectNames(after).some((n) => n.startsWith('/Fx'))).toBe(true);
  });

  it('draws a highlight from its quads', async () => {
    const result = await flatten(
      await undrawn('Highlight', { QuadPoints: [20, 80, 120, 80, 20, 20, 120, 20] }),
    );
    expect(result.flattened).toBe(1);
  });

  it('draws an ink stroke from its paths', async () => {
    const result = await flatten(
      await undrawn('Ink', { InkList: [[20, 20, 60, 60, 100, 30]], BS: { W: 3 } }),
    );
    expect(result.flattened).toBe(1);
  });

  it('leaves a subtype nothing knows how to draw, and says so', async () => {
    const result = await flatten(await undrawn('Screen'));
    expect(result.flattened).toBe(0);
    expect(result.warnings.join(' ')).toContain('no drawing of its own');
    expect(annotationCount(await PDFDocument.load(result.bytes))).toBe(1);
  });

  it('leaves an annotation with no position alone', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([200, 200]);
    page.node.set(
      PDFName.of('Annots'),
      doc.context.obj([doc.context.obj({ Type: 'Annot', Subtype: 'Square', C: [0, 0, 1] })]),
    );
    const bytes = await doc.save({ addDefaultPage: false, updateFieldAppearances: false });
    const result = await flatten(bytes);
    expect(result.flattened).toBe(0);
    expect(result.warnings.join(' ')).toMatch(/no position|no drawing/);
  });

  it('removes an unticked box rather than leaving it as a live field', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([200, 200]);
    const ctx = doc.context;
    // `/AS /Off` with an `/AP /N` that has only an "on" state: nothing to draw.
    const on = ctx.register(
      ctx.flateStream('', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 10, 10] }),
    );
    const widget = ctx.register(
      ctx.obj({
        Type: 'Annot',
        Subtype: 'Widget',
        FT: 'Btn',
        T: PDFHexString.fromText('agree'),
        Rect: [10, 10, 30, 30],
        AS: 'Off',
        AP: ctx.obj({ N: ctx.obj({ Yes: on }) }),
      }),
    );
    page.node.set(PDFName.of('Annots'), ctx.obj([widget]));
    doc.catalog.set(PDFName.of('AcroForm'), ctx.obj({ Fields: ctx.obj([widget]) }));
    const bytes = await doc.save({ addDefaultPage: false, updateFieldAppearances: false });

    const result = await flatten(bytes);
    expect(result.flattened).toBe(0);
    expect(result.removed).toBe(1);
    const after = await PDFDocument.load(result.bytes);
    expect(annotationCount(after)).toBe(0);
    expect(after.catalog.get(PDFName.of('AcroForm'))).toBeUndefined();
  });

  it('uses the appearance the host supplies for a widget that has none (M61’s hook)', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([200, 200]);
    const ctx = doc.context;
    const widget = ctx.register(
      ctx.obj({
        Type: 'Annot',
        Subtype: 'Widget',
        FT: 'Tx',
        T: PDFHexString.fromText('city'),
        V: PDFHexString.fromText('York'),
        Rect: [10, 10, 110, 40],
      }),
    );
    page.node.set(PDFName.of('Annots'), ctx.obj([widget]));
    doc.catalog.set(PDFName.of('AcroForm'), ctx.obj({ Fields: ctx.obj([widget]) }));
    const bytes = await doc.save({ addDefaultPage: false, updateFieldAppearances: false });

    const asked: string[] = [];
    const result = await flatten(bytes, {
      appearances: (field) => {
        asked.push(`${field.fieldType} ${field.fieldName}=${field.value}`);
        return Promise.resolve(new TextEncoder().encode('0 0 1 rg 0 0 100 30 re f'));
      },
    });
    expect(asked).toEqual(['/Tx city=York']);
    expect(result.flattened).toBe(1);
    const after = await PDFDocument.load(result.bytes);
    expect(annotationCount(after)).toBe(0);
  });

  it('keeps a widget the host declines to draw', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([200, 200]);
    const ctx = doc.context;
    const widget = ctx.register(
      ctx.obj({ Type: 'Annot', Subtype: 'Widget', FT: 'Tx', Rect: [10, 10, 110, 40] }),
    );
    page.node.set(PDFName.of('Annots'), ctx.obj([widget]));
    doc.catalog.set(PDFName.of('AcroForm'), ctx.obj({ Fields: ctx.obj([widget]) }));
    const bytes = await doc.save({ addDefaultPage: false, updateFieldAppearances: false });

    const result = await flatten(bytes, { appearances: () => Promise.resolve(null) });
    expect(result.flattened).toBe(0);
    const after = await PDFDocument.load(result.bytes);
    expect(annotationCount(after)).toBe(1);
    expect(after.catalog.get(PDFName.of('AcroForm'))).toBeDefined();
  });
});

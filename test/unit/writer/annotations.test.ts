/**
 * Annotation entries the engine could not change (M21).
 *
 * `PdfEngine.updateAnnotation` takes a patch, and a patch says what a value *becomes* — it can
 * never say "and empty that one". So clearing a note's text, an ink list or a colour reaches the
 * writer instead, and this is where that is checked, together with the rule that keeps it safe:
 * the plan's index is a hint, and an annotation the writer cannot identify beyond doubt is left
 * exactly as it was.
 */

import { describe, expect, it } from 'vitest';
import type { PDFRef } from 'pdf-lib';
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFPageLeaf,
  PDFString,
} from 'pdf-lib';
import { emptyWritePlan, type WritePlan } from '@engine/Writer';
import { FullRewriteWriter } from '@engine/writers/FullRewriteWriter';
import type { PdfRect } from '@shared/pdf';

const RECT: PdfRect = { x0: 10, y0: 10, x1: 110, y1: 60 };

async function blankPage(): Promise<PDFDocument> {
  const pdf = await PDFDocument.create({ updateMetadata: false });
  pdf.addPage([300, 400]);
  return pdf;
}

const save = (pdf: PDFDocument): Promise<Uint8Array> =>
  pdf.save({ useObjectStreams: false, updateFieldAppearances: false });

const write = (bytes: Uint8Array, plan: WritePlan) =>
  new FullRewriteWriter().write({ bytes, plan, options: { objectStreams: false } });

const plan = (over: Partial<WritePlan> = {}): WritePlan => ({ ...emptyWritePlan(1), ...over });

function firstLeaf(pdf: PDFDocument): PDFPageLeaf {
  const out: PDFPageLeaf[] = [];
  pdf.catalog.Pages().traverse((node) => {
    if (node instanceof PDFPageLeaf) out.push(node);
  });
  const leaf = out[0];
  if (!leaf) throw new Error('no page');
  return leaf;
}

/** One annotation carrying every entry the writer knows how to remove. */
async function withAnnotation(subtype: string): Promise<Uint8Array> {
  const pdf = await blankPage();
  const annot = pdf.context.obj({});
  annot.set(PDFName.of('Type'), PDFName.of('Annot'));
  annot.set(PDFName.of('Subtype'), PDFName.of(subtype));
  annot.set(PDFName.of('Rect'), pdf.context.obj([RECT.x0, RECT.y0, RECT.x1, RECT.y1]));
  annot.set(PDFName.of('Contents'), PDFHexString.fromText('something'));
  annot.set(PDFName.of('T'), PDFHexString.fromText('An author'));
  annot.set(PDFName.of('Subj'), PDFHexString.fromText('A subject'));
  annot.set(PDFName.of('NM'), PDFHexString.fromText('nm-1'));
  annot.set(PDFName.of('State'), PDFHexString.fromText('Accepted'));
  annot.set(PDFName.of('C'), pdf.context.obj([1, 0, 0]));
  annot.set(PDFName.of('IC'), pdf.context.obj([0, 0, 1]));
  annot.set(PDFName.of('CA'), pdf.context.obj(0.5));
  annot.set(PDFName.of('AS'), PDFName.of('Off'));
  annot.set(PDFName.of('QuadPoints'), pdf.context.obj([0, 0, 1, 1, 2, 2, 3, 3]));
  annot.set(PDFName.of('InkList'), pdf.context.obj([pdf.context.obj([0, 0, 1, 1])]));
  annot.set(PDFName.of('Vertices'), pdf.context.obj([0, 0, 5, 5]));
  const bs = pdf.context.obj({});
  bs.set(PDFName.of('W'), pdf.context.obj(3));
  annot.set(PDFName.of('BS'), bs);
  firstLeaf(pdf).set(PDFName.of('Annots'), pdf.context.obj([pdf.context.register(annot)]));
  return save(pdf);
}

async function firstAnnot(bytes: Uint8Array): Promise<{ pdf: PDFDocument; dict: PDFDict }> {
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  const annots = firstLeaf(pdf).lookupMaybe(PDFName.of('Annots'), PDFArray);
  const dict = pdf.context.lookupMaybe(annots?.get(0), PDFDict);
  if (!dict) throw new Error('no annotation');
  return { pdf, dict };
}

describe('removing an entry', () => {
  it('a null removes each one, which is the one thing an engine patch cannot say', async () => {
    const result = await write(
      await withAnnotation('Square'),
      plan({
        pages: [
          {
            source: 0,
            annotations: [
              {
                index: 0,
                subtype: 'Square',
                rect: RECT,
                properties: {
                  contents: null,
                  author: null,
                  subject: null,
                  name: null,
                  state: null,
                  color: null,
                  interiorColor: null,
                  opacity: null,
                  borderWidth: null,
                  quadPoints: null,
                  paths: null,
                  vertices: null,
                },
              },
            ],
          },
        ],
      }),
    );
    const { dict } = await firstAnnot(result.bytes);
    const gone = [
      'Contents',
      'T',
      'Subj',
      'NM',
      'State',
      'C',
      'IC',
      'CA',
      'BS',
      'QuadPoints',
      'InkList',
      'Vertices',
    ];
    for (const key of gone) expect(dict.get(PDFName.of(key)), key).toBeUndefined();
    // The annotation itself is still there: emptying a value is not deleting the thing.
    expect(dict.lookupMaybe(PDFName.of('Subtype'), PDFName)?.decodeText()).toBe('Square');
  });
});

describe('writing an entry', () => {
  it('each value lands in the shape the spec asks for', async () => {
    const result = await write(
      await withAnnotation('Square'),
      plan({
        pages: [
          {
            source: 0,
            annotations: [
              {
                index: 0,
                subtype: 'Square',
                rect: RECT,
                properties: {
                  contents: 'Rewritten',
                  author: 'Someone else',
                  subject: 'A new subject',
                  name: 'nm-2',
                  state: 'Rejected',
                  color: 0x3392ff,
                  interiorColor: 0x000000,
                  opacity: 0.25,
                  borderWidth: 2,
                  quadPoints: [1, 2, 3, 4, 5, 6, 7, 8],
                  paths: [
                    [
                      { x: 1, y: 2 },
                      { x: 3, y: 4 },
                    ],
                  ],
                  vertices: [
                    { x: 9, y: 9 },
                    { x: 8, y: 8 },
                  ],
                },
              },
            ],
          },
        ],
      }),
    );
    const { pdf, dict } = await firstAnnot(result.bytes);
    const text = (key: string): string | undefined =>
      dict.lookupMaybe(PDFName.of(key), PDFString, PDFHexString)?.decodeText();
    expect(text('Contents')).toBe('Rewritten');
    expect(text('T')).toBe('Someone else');
    expect(text('Subj')).toBe('A new subject');
    expect(text('NM')).toBe('nm-2');
    expect(text('State')).toBe('Rejected');
    expect(dict.lookupMaybe(PDFName.of('C'), PDFArray)?.size()).toBe(3);
    expect(dict.lookupMaybe(PDFName.of('IC'), PDFArray)?.size()).toBe(3);
    expect(dict.lookupMaybe(PDFName.of('CA'), PDFNumber)?.asNumber()).toBeCloseTo(0.25, 5);
    expect(
      dict
        .lookupMaybe(PDFName.of('BS'), PDFDict)
        ?.lookupMaybe(PDFName.of('W'), PDFNumber)
        ?.asNumber(),
    ).toBe(2);
    expect(dict.lookupMaybe(PDFName.of('QuadPoints'), PDFArray)?.size()).toBe(8);
    // `/InkList` is an array of arrays; `/Vertices` is one flat list.
    const ink = dict.lookupMaybe(PDFName.of('InkList'), PDFArray);
    expect(pdf.context.lookupMaybe(ink?.get(0), PDFArray)?.size()).toBe(4);
    expect(dict.lookupMaybe(PDFName.of('Vertices'), PDFArray)?.size()).toBe(4);
  });

  it('a border width on an annotation with no /BS makes one', async () => {
    const pdf = await blankPage();
    const annot = pdf.context.obj({});
    annot.set(PDFName.of('Subtype'), PDFName.of('Square'));
    annot.set(PDFName.of('Rect'), pdf.context.obj([RECT.x0, RECT.y0, RECT.x1, RECT.y1]));
    firstLeaf(pdf).set(PDFName.of('Annots'), pdf.context.obj([pdf.context.register(annot)]));

    const result = await write(
      await save(pdf),
      plan({
        pages: [
          {
            source: 0,
            annotations: [
              { index: 0, subtype: 'Square', rect: RECT, properties: { borderWidth: 4 } },
            ],
          },
        ],
      }),
    );
    const { dict } = await firstAnnot(result.bytes);
    const bs = dict.lookupMaybe(PDFName.of('BS'), PDFDict);
    expect(bs?.lookupMaybe(PDFName.of('W'), PDFNumber)?.asNumber()).toBe(4);
    expect(bs?.lookupMaybe(PDFName.of('Type'), PDFName)?.decodeText()).toBe('Border');
  });

  it('a Line writes its two points to /L, which is where a Line keeps them', async () => {
    const result = await write(
      await withAnnotation('Line'),
      plan({
        pages: [
          {
            source: 0,
            annotations: [
              {
                index: 0,
                subtype: 'Line',
                rect: RECT,
                properties: {
                  vertices: [
                    { x: 10, y: 10 },
                    { x: 110, y: 60 },
                  ],
                },
              },
            ],
          },
        ],
      }),
    );
    const { dict } = await firstAnnot(result.bytes);
    expect(dict.lookupMaybe(PDFName.of('L'), PDFArray)?.size()).toBe(4);
  });
});

describe('finding the right annotation', () => {
  it('the index is a hint: one that moved is still found when it is unambiguous', async () => {
    const result = await write(
      await withAnnotation('Square'),
      plan({
        pages: [
          {
            source: 0,
            // The plan thinks it is second; it is first, and nothing else looks like it.
            annotations: [
              { index: 1, subtype: 'Square', rect: RECT, properties: { contents: null } },
            ],
          },
        ],
      }),
    );
    expect(result.warnings).toEqual([]);
    const { dict } = await firstAnnot(result.bytes);
    expect(dict.get(PDFName.of('Contents'))).toBeUndefined();
  });

  it('two that both match are left alone rather than guessed between', async () => {
    const pdf = await blankPage();
    const make = (): PDFRef => {
      const annot = pdf.context.obj({});
      annot.set(PDFName.of('Subtype'), PDFName.of('Square'));
      annot.set(PDFName.of('Rect'), pdf.context.obj([RECT.x0, RECT.y0, RECT.x1, RECT.y1]));
      annot.set(PDFName.of('Contents'), PDFHexString.fromText('kept'));
      return pdf.context.register(annot);
    };
    firstLeaf(pdf).set(PDFName.of('Annots'), pdf.context.obj([make(), make()]));

    const result = await write(
      await save(pdf),
      plan({
        pages: [
          {
            source: 0,
            annotations: [
              { index: 9, subtype: 'Square', rect: RECT, properties: { contents: null } },
            ],
          },
        ],
      }),
    );
    expect(result.warnings.join(' ')).toMatch(/left as (it|they) (was|were)/);
    const { dict } = await firstAnnot(result.bytes);
    expect(dict.lookupMaybe(PDFName.of('Contents'), PDFString, PDFHexString)?.decodeText()).toBe(
      'kept',
    );
  });

  it('one whose subtype does not match the plan is left alone', async () => {
    const result = await write(
      await withAnnotation('Square'),
      plan({
        pages: [
          {
            source: 0,
            annotations: [
              { index: 0, subtype: 'Circle', rect: RECT, properties: { contents: null } },
            ],
          },
        ],
      }),
    );
    expect(result.warnings.join(' ')).toMatch(/left as (it|they) (was|were)/);
  });

  it('a page with no annotations at all is reported rather than silently skipped', async () => {
    const result = await write(
      await save(await blankPage()),
      plan({ pages: [{ source: 0, annotations: [{ index: 0, subtype: 'Square', rect: RECT }] }] }),
    );
    expect(result.warnings.join(' ')).toContain('could not be found');
  });
});

describe('the appearance stream it attaches', () => {
  it('carries the font and the alpha the generator asked for, and clears a stale /AS', async () => {
    const result = await write(
      await withAnnotation('FreeText'),
      plan({
        pages: [
          {
            source: 0,
            annotations: [
              {
                index: 0,
                subtype: 'FreeText',
                rect: RECT,
                appearance: {
                  input: {
                    subtype: 'FreeText',
                    rect: RECT,
                    color: 0x000000,
                    interiorColor: 0xffffff,
                    opacity: 0.5,
                    borderWidth: 1,
                    quadPoints: [],
                    paths: [],
                    vertices: [],
                    contents: 'Typed into the page',
                    extra: { fontSize: 10 },
                  },
                  replace: true,
                },
              },
            ],
          },
        ],
      }),
    );
    expect(result.appearances).toBe(1);

    const { pdf, dict } = await firstAnnot(result.bytes);
    const form = pdf.context.lookup(
      dict.lookupMaybe(PDFName.of('AP'), PDFDict)?.get(PDFName.of('N')),
    ) as unknown as { dict: PDFDict };
    const resources = form.dict.lookupMaybe(PDFName.of('Resources'), PDFDict);

    const fonts = resources?.lookupMaybe(PDFName.of('Font'), PDFDict);
    const fontKey = fonts?.keys()[0];
    const font = fontKey ? pdf.context.lookupMaybe(fonts?.get(fontKey), PDFDict) : undefined;
    expect(font?.lookupMaybe(PDFName.of('BaseFont'), PDFName)?.decodeText()).toBe('Helvetica');
    expect(font?.lookupMaybe(PDFName.of('Encoding'), PDFName)?.decodeText()).toBe(
      'WinAnsiEncoding',
    );

    const gs = resources?.lookupMaybe(PDFName.of('ExtGState'), PDFDict);
    const gsKey = gs?.keys()[0];
    const state = gsKey ? pdf.context.lookupMaybe(gs?.get(gsKey), PDFDict) : undefined;
    expect(state?.lookupMaybe(PDFName.of('ca'), PDFNumber)?.asNumber()).toBeCloseTo(0.5, 5);

    // A stale `/AS` would name a state the single `/N` stream does not have, and the viewer
    // would draw nothing at all.
    expect(dict.get(PDFName.of('AS'))).toBeUndefined();
  });

  it('a generator that has nothing to draw attaches nothing', async () => {
    const result = await write(
      await withAnnotation('Polygon'),
      plan({
        pages: [
          {
            source: 0,
            annotations: [
              {
                index: 0,
                subtype: 'Polygon',
                rect: RECT,
                appearance: {
                  input: {
                    subtype: 'Polygon',
                    rect: RECT,
                    color: null,
                    interiorColor: null,
                    opacity: null,
                    borderWidth: null,
                    quadPoints: [],
                    paths: [],
                    // A polygon needs three points; two is not a shape.
                    vertices: [
                      { x: 0, y: 0 },
                      { x: 1, y: 1 },
                    ],
                    contents: null,
                    extra: {},
                  },
                  replace: true,
                },
              },
            ],
          },
        ],
      }),
    );
    expect(result.appearances).toBe(0);
    const { dict } = await firstAnnot(result.bytes);
    expect(dict.get(PDFName.of('AP'))).toBeUndefined();
  });
});

/**
 * What the writer does for M31 (ADR 0015): a shared XObject is embedded once however many
 * annotations name it; `/LE` is an array of names; `/BE` is a dictionary; a dash merges into the
 * `/BS` the border width wrote; and `/FS` is resolved to the embedded file, which leaves the name
 * tree as it moves.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFRef,
  PDFStream,
  type PDFContext,
} from 'pdf-lib';
import { appearanceInput, STAMP_KEY, STAMP_SIZE } from '@engine/appearance';
import {
  emptyWritePlan,
  type PlannedAnnotation,
  type PlannedXObject,
  type WritePlan,
} from '@engine/Writer';
import { FullRewriteWriter } from '@engine/writers/FullRewriteWriter';
import { toBase64 } from '@modules/M31-shapes-ink-stamps/stampImport';
import { must } from '../find/helpers';

const PNG = new Uint8Array(
  readFileSync(join(process.cwd(), 'test', 'fixtures', 'create', 'logo-alpha.png')),
);

async function blankPage(): Promise<PDFDocument> {
  const pdf = await PDFDocument.create({ updateMetadata: false });
  pdf.addPage([400, 400]);
  return pdf;
}

const save = (pdf: PDFDocument): Promise<Uint8Array> =>
  pdf.save({ useObjectStreams: false, updateFieldAppearances: false });

const write = (bytes: Uint8Array, plan: WritePlan) =>
  new FullRewriteWriter().write({ bytes, plan, options: { objectStreams: false } });

function plan(
  annotations: ReadonlyArray<PlannedAnnotation>,
  xobjects: Record<string, PlannedXObject> | null = null,
): WritePlan {
  const base = emptyWritePlan(1);
  return {
    ...base,
    pages: [{ source: 0, annotations }],
    xobjects,
  };
}

function stampEntry(index: number, key: string, size: [number, number]): PlannedAnnotation {
  const rect = { x0: 10 + index * 30, y0: 10, x1: 30 + index * 30, y1: 30 };
  return {
    index,
    subtype: 'Stamp',
    rect,
    insert: true,
    appearance: {
      input: appearanceInput({
        subtype: 'Stamp',
        rect,
        extra: { [STAMP_KEY]: key, [STAMP_SIZE]: size },
      }),
      replace: true,
    },
  };
}

async function annots(
  bytes: Uint8Array,
): Promise<{ pdf: PDFDocument; ctx: PDFContext; dicts: PDFDict[] }> {
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  const ctx = pdf.context;
  const array = pdf.getPage(0).node.Annots();
  const dicts: PDFDict[] = [];
  for (let i = 0; i < (array?.size() ?? 0); i++) {
    const d = ctx.lookupMaybe(array?.get(i), PDFDict);
    if (d) dicts.push(d);
  }
  return { pdf, ctx, dicts };
}

/**
 * Every indirect object that is a stream of the given `/Subtype`. An image's soft mask is an
 * image object too, so the masks are left out of an 'Image' count: the question is how many
 * pictures there are.
 */
function streamsOf(ctx: PDFContext, subtype: string): PDFRef[] {
  const out: PDFRef[] = [];
  const masks = new Set<string>();
  for (const [ref, object] of ctx.enumerateIndirectObjects()) {
    if (
      object instanceof PDFStream &&
      object.dict.get(PDFName.of('Subtype'))?.toString() === `/${subtype}`
    ) {
      out.push(ref);
      const mask = object.dict.get(PDFName.of('SMask'));
      if (mask instanceof PDFRef) masks.add(mask.toString());
    }
  }
  return out.filter((ref) => !masks.has(ref.toString()));
}

/** The XObject the annotation's appearance draws, by the name in its content. */
function drawnXObject(ctx: PDFContext, annot: PDFDict): PDFRef | undefined {
  const ap = annot.lookupMaybe(PDFName.of('AP'), PDFDict);
  const n = ap ? ctx.lookupMaybe(ap.get(PDFName.of('N')), PDFStream) : undefined;
  const resources = n?.dict.lookupMaybe(PDFName.of('Resources'), PDFDict);
  const xobjects = resources?.lookupMaybe(PDFName.of('XObject'), PDFDict);
  const ref = xobjects?.get(PDFName.of('Fm1'));
  return ref instanceof PDFRef ? ref : undefined;
}

describe('shared XObjects', () => {
  it('embeds a PNG once for ten stamps, and every appearance draws that one object', async () => {
    const bytes = await save(await blankPage());
    const entries = Array.from({ length: 10 }, (_v, i) => stampEntry(i, 'image:logo', [120, 60]));
    const result = await write(
      bytes,
      plan(entries, {
        'image:logo': { kind: 'image', format: 'png', data: toBase64(PNG), width: 120, height: 60 },
      }),
    );
    expect(result.warnings).toEqual([]);
    expect(result.appearances).toBe(10);
    const { ctx, dicts } = await annots(result.bytes);
    expect(dicts.length).toBe(10);
    expect(streamsOf(ctx, 'Image').length).toBe(1);
    const refs = new Set(dicts.map((d) => drawnXObject(ctx, d)?.toString()));
    expect(refs.size).toBe(1);
    expect([...refs][0]).toBeDefined();
    // The PNG's alpha is kept: pdf-lib writes it as a soft mask on the image.
    const image = ctx.lookupMaybe(must(streamsOf(ctx, 'Image')[0], 'image'), PDFStream);
    expect(image?.dict.get(PDFName.of('SMask'))).toBeDefined();
  });

  it('embeds a drawing once for two stamps, with its own font resources', async () => {
    const bytes = await save(await blankPage());
    const form: PlannedXObject = {
      kind: 'form',
      content: '0 0 1 rg 0 0 100 40 re f BT /F1 12 Tf 1 0 0 1 4 4 Tm (STAMP) Tj ET',
      bbox: { x0: 0, y0: 0, x1: 100, y1: 40 },
      resources: { extGState: {}, fonts: { F1: 'Helvetica-Bold' } },
    };
    const result = await write(
      bytes,
      plan([stampEntry(0, 'stamp:x', [100, 40]), stampEntry(1, 'stamp:x', [100, 40])], {
        'stamp:x': form,
      }),
    );
    expect(result.warnings).toEqual([]);
    const { ctx, dicts } = await annots(result.bytes);
    const [a, b] = dicts.map((d) => drawnXObject(ctx, d));
    expect(a).toBeDefined();
    expect(a?.toString()).toBe(b?.toString());
    const shared = ctx.lookupMaybe(must(a, 'ref'), PDFStream);
    const fonts = shared?.dict
      .lookupMaybe(PDFName.of('Resources'), PDFDict)
      ?.lookupMaybe(PDFName.of('Font'), PDFDict);
    expect(fonts?.get(PDFName.of('F1'))).toBeDefined();
    // Two appearance forms plus the one shared form.
    expect(streamsOf(ctx, 'Form').length).toBe(3);
  });

  it('a key the plan does not carry, or bytes that will not decode, leaves the annotation alone', async () => {
    const bytes = await save(await blankPage());
    const missing = await write(bytes, plan([stampEntry(0, 'image:gone', [10, 10])], null));
    expect(missing.appearances).toBe(0);
    expect(missing.warnings.some((w) => w.includes('picture is not in the document'))).toBe(true);
    const broken = await write(
      bytes,
      plan([stampEntry(0, 'image:bad', [10, 10])], {
        'image:bad': {
          kind: 'image',
          format: 'png',
          data: toBase64(new Uint8Array([1, 2, 3])),
          width: 1,
          height: 1,
        },
      }),
    );
    expect(broken.appearances).toBe(0);
    expect(broken.warnings.some((w) => w.includes('could not be embedded'))).toBe(true);
    // A key nothing names is not embedded at all.
    const unused = await write(
      bytes,
      plan([], {
        'image:idle': { kind: 'image', format: 'png', data: toBase64(PNG), width: 1, height: 1 },
      }),
    );
    const { ctx } = await annots(unused.bytes);
    expect(streamsOf(ctx, 'Image').length).toBe(0);
  });
});

describe('the shape family’s entries', () => {
  it('writes /LE as names, /BE as a dictionary, and merges a dash into /BS beside the width', async () => {
    const bytes = await save(await blankPage());
    const rect = { x0: 10, y0: 10, x1: 110, y1: 60 };
    const result = await write(
      bytes,
      plan([
        {
          index: 0,
          subtype: 'Line',
          rect,
          insert: true,
          properties: {
            borderWidth: 3,
            vertices: [
              { x: 10, y: 10 },
              { x: 110, y: 60 },
            ],
            entries: {
              LE: { kind: 'names', value: ['None', 'OpenArrow'] },
              BE: {
                kind: 'dict',
                value: { S: { kind: 'name', value: 'C' }, I: { kind: 'number', value: 1 } },
              },
              BS: {
                kind: 'dict',
                value: { S: { kind: 'name', value: 'D' }, D: { kind: 'numbers', value: [3, 2] } },
              },
            },
          },
        },
      ]),
    );
    expect(result.warnings).toEqual([]);
    const { ctx, dicts } = await annots(result.bytes);
    const line = must(dicts[0], 'line');
    const le = must(line.lookupMaybe(PDFName.of('LE'), PDFArray), 'LE');
    expect(le.asArray().map((n) => n.toString())).toEqual(['/None', '/OpenArrow']);
    const be = must(line.lookupMaybe(PDFName.of('BE'), PDFDict), 'BE');
    expect(be.get(PDFName.of('S'))?.toString()).toBe('/C');
    const bs = must(line.lookupMaybe(PDFName.of('BS'), PDFDict), 'BS');
    expect(ctx.lookupMaybe(bs.get(PDFName.of('W')), PDFNumber)?.asNumber()).toBe(3);
    expect(bs.get(PDFName.of('S'))?.toString()).toBe('/D');
    expect(bs.lookupMaybe(PDFName.of('D'), PDFArray)?.asArray().length).toBe(2);

    // Back to solid: the dash goes, the width stays.
    const again = await write(
      result.bytes,
      plan([
        {
          index: 0,
          subtype: 'Line',
          rect,
          properties: {
            entries: {
              BS: { kind: 'dict', value: { S: { kind: 'name', value: 'S' }, D: null } },
              BE: null,
            },
          },
        },
      ]),
    );
    const solid = must((await annots(again.bytes)).dicts[0], 'line');
    const bs2 = must(solid.lookupMaybe(PDFName.of('BS'), PDFDict), 'BS');
    expect(bs2.get(PDFName.of('D'))).toBeUndefined();
    expect(bs2.get(PDFName.of('W'))).toBeDefined();
    expect(solid.get(PDFName.of('BE'))).toBeUndefined();
  });

  it('a stray non-dictionary where a dictionary is expected is replaced, not a crash', async () => {
    const pdf = await blankPage();
    const annot = pdf.context.obj({});
    annot.set(PDFName.of('Type'), PDFName.of('Annot'));
    annot.set(PDFName.of('Subtype'), PDFName.of('Square'));
    annot.set(PDFName.of('Rect'), pdf.context.obj([10, 10, 50, 50]));
    annot.set(PDFName.of('BS'), PDFNumber.of(3));
    pdf.getPage(0).node.set(PDFName.of('Annots'), pdf.context.obj([pdf.context.register(annot)]));
    const result = await write(
      await save(pdf),
      plan([
        {
          index: 0,
          subtype: 'Square',
          rect: { x0: 10, y0: 10, x1: 50, y1: 50 },
          properties: {
            entries: { BS: { kind: 'dict', value: { S: { kind: 'name', value: 'D' } } } },
          },
        },
      ]),
    );
    const { dicts } = await annots(result.bytes);
    expect(dicts[0]?.lookupMaybe(PDFName.of('BS'), PDFDict)?.get(PDFName.of('S'))?.toString()).toBe(
      '/D',
    );
  });
});

describe('the attached file', () => {
  async function withEmbeddedFile(): Promise<Uint8Array> {
    const pdf = await blankPage();
    await pdf.attach(new Uint8Array([104, 105]), 'notes.txt', {
      description: 'my notes',
      mimeType: 'text/plain',
    });
    return save(pdf);
  }

  function treeNames(pdf: PDFDocument): string[] {
    const root = pdf.catalog.lookupMaybe(PDFName.of('Names'), PDFDict);
    const tree = root?.lookupMaybe(PDFName.of('EmbeddedFiles'), PDFDict);
    const names = tree?.lookupMaybe(PDFName.of('Names'), PDFArray)?.asArray() ?? [];
    const out: string[] = [];
    for (let i = 0; i < names.length; i += 2) out.push(String(names[i]));
    return out;
  }

  it('moves the file specification from the name tree on to the annotation', async () => {
    const bytes = await withEmbeddedFile();
    const rect = { x0: 10, y0: 10, x1: 30, y1: 30 };
    const result = await write(
      bytes,
      plan([
        {
          index: 0,
          subtype: 'FileAttachment',
          rect,
          insert: true,
          properties: {
            entries: {
              FS: { kind: 'embeddedFile', value: 'notes.txt' },
              Name: { kind: 'name', value: 'PushPin' },
            },
          },
          appearance: {
            input: appearanceInput({ subtype: 'FileAttachment', rect, color: 0 }),
            replace: true,
          },
        },
      ]),
    );
    expect(result.warnings).toEqual([]);
    const { pdf, ctx, dicts } = await annots(result.bytes);
    const annot = must(dicts[0], 'annotation');
    const spec = ctx.lookupMaybe(annot.get(PDFName.of('FS')), PDFDict);
    expect(spec?.get(PDFName.of('Type'))?.toString()).toBe('/Filespec');
    expect(treeNames(pdf)).toEqual([]);
    expect(annot.get(PDFName.of('AP'))).toBeDefined();
  });

  it('says so when the file is not there', async () => {
    const bytes = await withEmbeddedFile();
    const result = await write(
      bytes,
      plan([
        {
          index: 0,
          subtype: 'FileAttachment',
          rect: { x0: 10, y0: 10, x1: 30, y1: 30 },
          insert: true,
          properties: { entries: { FS: { kind: 'embeddedFile', value: 'missing.txt' } } },
        },
      ]),
    );
    expect(result.warnings.some((w) => w.includes('missing.txt'))).toBe(true);
    const { pdf } = await annots(result.bytes);
    expect(treeNames(pdf).length).toBe(1);
  });
});

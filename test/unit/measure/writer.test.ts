/**
 * What the writer does with the two `DictValue` kinds M33 added (ADR 0018): a boolean, and an
 * array whose members are dictionaries.
 *
 * The full `/Measure` is proved end to end in `roundtrip.test.ts`; this file is the two kinds on
 * their own, including the cases the round trip cannot reach — `false` as a value rather than an
 * absence, an array replacing what the file had, and a nested array of names.
 */

import { describe, expect, it } from 'vitest';
import { PDFArray, PDFBool, PDFDict, PDFDocument, PDFName, PDFNumber } from 'pdf-lib';
import type { PDFContext } from 'pdf-lib';
import { appearanceInput } from '@engine/appearance';
import type { DictValue } from '@engine/appearance/dict';
import { emptyWritePlan, type PlannedAnnotation, type WritePlan } from '@engine/Writer';
import { FullRewriteWriter } from '@engine/writers/FullRewriteWriter';
import { must } from '../find/helpers';

async function blankPage(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create({ updateMetadata: false });
  pdf.addPage([400, 400]);
  return await pdf.save({ useObjectStreams: false, updateFieldAppearances: false });
}

const write = (bytes: Uint8Array, plan: WritePlan) =>
  new FullRewriteWriter().write({ bytes, plan, options: { objectStreams: false } });

function plan(entries: Record<string, DictValue | null>): WritePlan {
  const rect = { x0: 10, y0: 10, x1: 200, y1: 40 };
  const annotation: PlannedAnnotation = {
    index: 0,
    subtype: 'Line',
    rect,
    insert: true,
    properties: {
      color: 0x5b2d91,
      borderWidth: 1,
      vertices: [
        { x: 10, y: 20 },
        { x: 200, y: 20 },
      ],
      entries,
    },
    appearance: {
      input: appearanceInput({ subtype: 'Line', rect, color: 0x5b2d91, borderWidth: 1 }),
      replace: true,
    },
  };
  return { ...emptyWritePlan(1), pages: [{ source: 0, annotations: [annotation] }] };
}

async function firstAnnot(bytes: Uint8Array): Promise<{ ctx: PDFContext; dict: PDFDict }> {
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  const array = must(pdf.getPage(0).node.Annots(), 'annots');
  return { ctx: pdf.context, dict: must(pdf.context.lookupMaybe(array.get(0), PDFDict), 'annot') };
}

describe('a boolean entry', () => {
  it('writes true and false, both as values', async () => {
    const base = await blankPage();
    const yes = await write(base, plan({ Cap: { kind: 'bool', value: true } }));
    expect(yes.warnings).toEqual([]);
    expect((await firstAnnot(yes.bytes)).dict.get(PDFName.of('Cap'))).toBe(PDFBool.True);
    const no = await write(base, plan({ Cap: { kind: 'bool', value: false } }));
    expect((await firstAnnot(no.bytes)).dict.get(PDFName.of('Cap'))).toBe(PDFBool.False);
  });

  it('removes the entry when the value is null', async () => {
    const written = await write(await blankPage(), plan({ Cap: null }));
    expect((await firstAnnot(written.bytes)).dict.get(PDFName.of('Cap'))).toBeUndefined();
  });
});

describe('an array entry', () => {
  const numberFormat: DictValue = {
    kind: 'dict',
    value: {
      Type: { kind: 'name', value: 'NumberFormat' },
      U: { kind: 'string', value: 'mm' },
      C: { kind: 'number', value: 0.352778 },
      F: { kind: 'name', value: 'D' },
      FD: { kind: 'bool', value: false },
    },
  };

  it('writes an array of dictionaries, each with its own entries', async () => {
    const written = await write(
      await blankPage(),
      plan({ Measure: { kind: 'dict', value: { D: { kind: 'array', value: [numberFormat] } } } }),
    );
    expect(written.warnings).toEqual([]);
    const { ctx, dict } = await firstAnnot(written.bytes);
    const measure = must(dict.lookupMaybe(PDFName.of('Measure'), PDFDict), 'Measure');
    const array = must(measure.lookupMaybe(PDFName.of('D'), PDFArray), 'D');
    expect(array.size()).toBe(1);
    const format = must(ctx.lookupMaybe(array.get(0), PDFDict), 'format');
    expect(format.lookupMaybe(PDFName.of('Type'), PDFName)?.decodeText()).toBe('NumberFormat');
    expect(format.lookupMaybe(PDFName.of('C'), PDFNumber)?.asNumber()).toBeCloseTo(0.352778, 9);
    expect(format.get(PDFName.of('FD'))).toBe(PDFBool.False);
  });

  it('takes an array of names, numbers and nested arrays too', async () => {
    const written = await write(
      await blankPage(),
      plan({
        Mixed: {
          kind: 'array',
          value: [
            { kind: 'name', value: 'One' },
            { kind: 'number', value: 2 },
            { kind: 'array', value: [{ kind: 'number', value: 3 }] },
          ],
        },
      }),
    );
    const { ctx, dict } = await firstAnnot(written.bytes);
    const array = must(dict.lookupMaybe(PDFName.of('Mixed'), PDFArray), 'Mixed');
    expect(array.size()).toBe(3);
    expect((array.get(0) as PDFName).decodeText()).toBe('One');
    expect((array.get(1) as PDFNumber).asNumber()).toBe(2);
    const nested = must(ctx.lookupMaybe(array.get(2), PDFArray), 'nested');
    expect((nested.get(0) as PDFNumber).asNumber()).toBe(3);
  });

  it('leaves out a member that can only be resolved at the top level', async () => {
    const written = await write(
      await blankPage(),
      plan({
        Odd: {
          kind: 'array',
          value: [
            { kind: 'embeddedFile', value: 'nowhere.txt' },
            { kind: 'annotationRef', value: 'nobody' },
            { kind: 'number', value: 1 },
          ],
        },
      }),
    );
    // No warning: nothing was lost that the model asked for — those two kinds are meaningless
    // inside an array, and the writer says so by skipping them.
    const { dict } = await firstAnnot(written.bytes);
    const array = must(dict.lookupMaybe(PDFName.of('Odd'), PDFArray), 'Odd');
    expect(array.size()).toBe(1);
    expect((array.get(0) as PDFNumber).asNumber()).toBe(1);
  });
});

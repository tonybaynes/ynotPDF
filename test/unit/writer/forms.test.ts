/**
 * The designed form, written and read back (M60, ADR 0019).
 *
 * Two readers check the same file. **pdf-lib** checks the dictionaries — the `/T` hierarchy, the
 * `/Ff` bits, `/Opt`, `/MK`, the two-state `/AP /N` of a check box, `/DR /Font`, `/Tabs` and the
 * `/Annots` order that a manual tab order is made of. **PDFium** — the engine this app renders
 * with, and the one Chrome's viewer is — then opens the same bytes and reports the fields, which
 * is the acceptance test's "opens and fills in Chrome's viewer" reduced to something a test can
 * actually assert.
 */

import { describe, expect, it } from 'vitest';
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFString,
} from 'pdf-lib';
import { widgetAppearance } from '@engine/forms/appearance';
import { formatDefaultAppearance } from '@engine/forms/da';
import {
  BUTTON_FLAGS,
  CHOICE_FLAGS,
  COMMON_FLAGS,
  TEXT_FLAGS,
  defaultFieldDesign,
  defaultWidgetAppearance,
  flagBit,
  type FieldRole,
} from '@engine/forms/model';
import { BARCODE_KEY, ROLE_KEY } from '@engine/pdfium/rawform';
import {
  emptyWritePlan,
  type PlannedForm,
  type PlannedFormField,
  type PlannedFormWidget,
  type WritePlan,
} from '@engine/Writer';
import { FullRewriteWriter } from '@engine/writers/FullRewriteWriter';
import type { PdfRect } from '@shared/pdf';
import { engine } from '../engine/helpers';

async function blank(pages = 1): Promise<Uint8Array> {
  const pdf = await PDFDocument.create({ updateMetadata: false });
  for (let i = 0; i < pages; i++) pdf.addPage([595, 842]);
  return await pdf.save({ useObjectStreams: false, updateFieldAppearances: false });
}

const write = (bytes: Uint8Array, form: PlannedForm, pages = 1) => {
  const plan: WritePlan = { ...emptyWritePlan(pages), form };
  return new FullRewriteWriter().write({ bytes, plan, options: { objectStreams: false } });
};

function widget(
  role: FieldRole,
  page: number,
  rect: PdfRect,
  over: Partial<PlannedFormWidget> = {},
): PlannedFormWidget {
  const appearance = defaultWidgetAppearance(role);
  const design = defaultFieldDesign(role);
  const toggling = role === 'checkbox' || role === 'radio';
  return {
    page,
    tabIndex: 0,
    rect,
    flags: 4,
    borderColor: appearance.borderColor,
    fillColor: appearance.fillColor,
    borderWidth: appearance.borderWidth,
    borderStyle: appearance.borderStyle,
    dashArray: appearance.dashArray,
    rotation: 0,
    caption: appearance.caption,
    rolloverCaption: null,
    downCaption: null,
    layout: 0,
    iconKey: null,
    highlight: 'invert',
    exportValue: appearance.exportValue,
    on: false,
    appearance: widgetAppearance({
      rect,
      design,
      widget: appearance,
      value: '',
      ...(toggling ? { state: 'on' as const } : {}),
    }),
    ...(toggling
      ? {
          offAppearance: widgetAppearance({
            rect,
            design,
            widget: appearance,
            value: '',
            state: 'off',
          }),
        }
      : {}),
    ...over,
  };
}

function field(
  name: string,
  role: FieldRole,
  over: Partial<PlannedFormField> = {},
): PlannedFormField {
  const design = defaultFieldDesign(role);
  return {
    name,
    type:
      role === 'checkbox' || role === 'radio' || role === 'button'
        ? 'Btn'
        : role === 'combobox' || role === 'listbox'
          ? 'Ch'
          : role === 'signature'
            ? 'Sig'
            : 'Tx',
    flags: design.flags,
    value: null,
    defaultValue: null,
    tooltip: null,
    defaultAppearance: formatDefaultAppearance({
      font: design.font,
      size: design.fontSize,
      color: design.textColor,
    }),
    align: 0,
    maxLength: null,
    topIndex: null,
    options: [],
    actions: [],
    widgets: [widget(role, 0, { x0: 100, y0: 700, x1: 300, y1: 724 })],
    ...over,
  };
}

const form = (fields: PlannedFormField[], over: Partial<PlannedForm> = {}): PlannedForm => ({
  fields,
  tabs: [null],
  defaultAppearance: '/Helv 9 Tf 0 g',
  quadding: null,
  ...over,
});

async function reopen(bytes: Uint8Array): Promise<PDFDocument> {
  return await PDFDocument.load(bytes, { updateMetadata: false, throwOnInvalidObject: false });
}

function acroForm(pdf: PDFDocument): PDFDict {
  const dict = pdf.catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict);
  if (!dict) throw new Error('no AcroForm');
  return dict;
}

/** Every field dictionary by fully-qualified name. */
function fieldsByName(pdf: PDFDocument): Map<string, PDFDict> {
  const ctx = pdf.context;
  const out = new Map<string, PDFDict>();
  const walk = (array: PDFArray | undefined, prefix: string): void => {
    if (!array) return;
    for (const item of array.asArray()) {
      const dict = ctx.lookupMaybe(item, PDFDict);
      if (!dict) continue;
      const raw = dict.lookup(PDFName.of('T'));
      const partial =
        raw instanceof PDFString || raw instanceof PDFHexString ? raw.decodeText() : '';
      const name = partial === '' ? prefix : prefix === '' ? partial : `${prefix}.${partial}`;
      if (partial !== '') out.set(name, dict);
      walk(dict.lookupMaybe(PDFName.of('Kids'), PDFArray), name);
    }
  };
  walk(acroForm(pdf).lookupMaybe(PDFName.of('Fields'), PDFArray), '');
  return out;
}

describe('writing a designed form', () => {
  it('writes a text field a viewer can find, fill and print', async () => {
    const result = await write(
      await blank(),
      form([field('order.reference', 'text', { value: 'ABC-1', tooltip: 'Your order number' })]),
    );
    expect(result.applied).toContain('form');
    const pdf = await reopen(result.bytes);
    const dict = fieldsByName(pdf).get('order.reference');
    expect(dict).toBeDefined();
    expect(dict?.lookupMaybe(PDFName.of('FT'), PDFName)?.decodeText()).toBe('Tx');
    expect(dict?.lookup(PDFName.of('V'), PDFHexString).decodeText()).toBe('ABC-1');
    expect(dict?.lookup(PDFName.of('TU'), PDFHexString).decodeText()).toBe('Your order number');
    // `/F` bit 3: the widget prints. A form field nobody can print is not a form field.
    expect(dict?.lookupMaybe(PDFName.of('F'), PDFNumber)?.asNumber()).toBe(4);
    expect(dict?.lookupMaybe(PDFName.of('AP'), PDFDict)).toBeDefined();
  });

  it('builds the `/T` hierarchy a dotted name means', async () => {
    const result = await write(
      await blank(),
      form([
        field('address.city', 'text'),
        field('address.postcode', 'text', {
          widgets: [widget('text', 0, { x0: 100, y0: 660, x1: 300, y1: 684 })],
        }),
      ]),
    );
    const pdf = await reopen(result.bytes);
    const byName = fieldsByName(pdf);
    expect([...byName.keys()].sort()).toEqual(['address', 'address.city', 'address.postcode']);
    // The parent is one node with two kids, not two nodes both called "address".
    const parent = byName.get('address');
    expect(parent?.lookupMaybe(PDFName.of('Kids'), PDFArray)?.size()).toBe(2);
    expect(parent?.get(PDFName.of('FT'))).toBeUndefined();
  });

  it('writes a check box as two appearance states with `/AS` naming the one showing', async () => {
    const result = await write(
      await blank(),
      form([
        field('agree', 'checkbox', {
          value: 'Yes',
          widgets: [
            widget(
              'checkbox',
              0,
              { x0: 100, y0: 700, x1: 114, y1: 714 },
              {
                on: true,
                exportValue: 'Yes',
              },
            ),
          ],
        }),
      ]),
    );
    const pdf = await reopen(result.bytes);
    const dict = fieldsByName(pdf).get('agree');
    expect(dict?.lookupMaybe(PDFName.of('V'), PDFName)?.decodeText()).toBe('Yes');
    expect(dict?.lookupMaybe(PDFName.of('AS'), PDFName)?.decodeText()).toBe('Yes');
    const normal = dict
      ?.lookupMaybe(PDFName.of('AP'), PDFDict)
      ?.lookupMaybe(PDFName.of('N'), PDFDict);
    expect(
      normal
        ?.keys()
        .map((k) => k.decodeText())
        .sort(),
    ).toEqual(['Off', 'Yes']);
  });

  it('writes a radio group as one field with a kid per button', async () => {
    const result = await write(
      await blank(),
      form([
        field('colour', 'radio', {
          flags: flagBit(BUTTON_FLAGS.radio),
          value: 'green',
          widgets: [
            widget('radio', 0, { x0: 100, y0: 700, x1: 114, y1: 714 }, { exportValue: 'red' }),
            widget(
              'radio',
              0,
              { x0: 130, y0: 700, x1: 144, y1: 714 },
              {
                exportValue: 'green',
                on: true,
              },
            ),
          ],
        }),
      ]),
    );
    const pdf = await reopen(result.bytes);
    const dict = fieldsByName(pdf).get('colour');
    const kids = dict?.lookupMaybe(PDFName.of('Kids'), PDFArray);
    expect(kids?.size()).toBe(2);
    const states = [0, 1].map((i) =>
      pdf.context
        .lookupMaybe(kids?.get(i), PDFDict)
        ?.lookupMaybe(PDFName.of('AS'), PDFName)
        ?.decodeText(),
    );
    expect(states).toEqual(['Off', 'green']);
  });

  it('writes a choice field’s options as export/label pairs', async () => {
    const result = await write(
      await blank(),
      form([
        field('size', 'combobox', {
          type: 'Ch',
          flags: flagBit(CHOICE_FLAGS.combo) | flagBit(CHOICE_FLAGS.sort),
          value: 'l',
          options: [
            { value: 's', label: 'Small' },
            { value: 'l', label: 'Large' },
          ],
        }),
      ]),
    );
    const pdf = await reopen(result.bytes);
    const dict = fieldsByName(pdf).get('size');
    const opt = dict?.lookupMaybe(PDFName.of('Opt'), PDFArray);
    expect(opt?.size()).toBe(2);
    const pair = pdf.context.lookupMaybe(opt?.get(0), PDFArray);
    expect(pair?.size()).toBe(2);
    expect(dict?.lookupMaybe(PDFName.of('Ff'), PDFNumber)?.asNumber()).toBe(
      flagBit(CHOICE_FLAGS.combo) | flagBit(CHOICE_FLAGS.sort),
    );
  });

  it('records the three roles AcroForm has no `/FT` for', async () => {
    const result = await write(
      await blank(),
      form([
        field('when', 'date', {
          actions: [{ trigger: 'F', type: 'JavaScript', value: 'AFDate_FormatEx("dd/mm/yyyy");' }],
          entries: { [ROLE_KEY]: { kind: 'name', value: 'date' } },
        }),
        field('code', 'barcode', {
          widgets: [widget('barcode', 0, { x0: 100, y0: 600, x1: 244, y1: 672 })],
          entries: {
            [ROLE_KEY]: { kind: 'name', value: 'barcode' },
            [BARCODE_KEY]: {
              kind: 'dict',
              value: {
                Symbology: { kind: 'name', value: 'qrcode' },
                EC: { kind: 'number', value: 2 },
                CellSize: { kind: 'number', value: 1 },
              },
            },
          },
        }),
      ]),
    );
    const pdf = await reopen(result.bytes);
    const byName = fieldsByName(pdf);
    expect(byName.get('when')?.lookupMaybe(PDFName.of(ROLE_KEY), PDFName)?.decodeText()).toBe(
      'date',
    );
    const aa = byName.get('when')?.lookupMaybe(PDFName.of('AA'), PDFDict);
    const format = aa?.lookupMaybe(PDFName.of('F'), PDFDict);
    expect(format?.lookup(PDFName.of('JS'), PDFHexString).decodeText()).toContain('dd/mm/yyyy');
    const barcode = byName.get('code')?.lookupMaybe(PDFName.of(BARCODE_KEY), PDFDict);
    expect(barcode?.lookupMaybe(PDFName.of('Symbology'), PDFName)?.decodeText()).toBe('qrcode');
    expect(barcode?.lookupMaybe(PDFName.of('EC'), PDFNumber)?.asNumber()).toBe(2);
  });

  it('puts the fonts its streams used into `/DR /Font`, and leaves `/NeedAppearances` off', async () => {
    const design = { ...defaultFieldDesign('text'), font: 'Times-Bold' as const };
    const rect = { x0: 100, y0: 700, x1: 300, y1: 724 };
    const result = await write(
      await blank(),
      form([
        field('name', 'text', {
          value: 'Ada',
          defaultAppearance: formatDefaultAppearance({
            font: design.font,
            size: 9,
            color: 0x000000,
          }),
          widgets: [
            widget('text', 0, rect, {
              appearance: widgetAppearance({
                rect,
                design,
                widget: defaultWidgetAppearance('text'),
                value: 'Ada',
              }),
            }),
          ],
        }),
      ]),
    );
    const pdf = await reopen(result.bytes);
    const acro = acroForm(pdf);
    expect(acro.get(PDFName.of('NeedAppearances'))).toBeUndefined();
    const fonts = acro
      .lookupMaybe(PDFName.of('DR'), PDFDict)
      ?.lookupMaybe(PDFName.of('Font'), PDFDict);
    expect(fonts?.keys().map((k) => k.decodeText())).toContain('TiBo');
  });

  it('writes `/Tabs` and orders `/Annots` by the tab index, which is what a manual order is', async () => {
    const result = await write(
      await blank(),
      form(
        [
          field('third', 'text', {
            widgets: [widget('text', 0, { x0: 100, y0: 600, x1: 300, y1: 624 }, { tabIndex: 2 })],
          }),
          field('first', 'text', {
            widgets: [widget('text', 0, { x0: 100, y0: 700, x1: 300, y1: 724 }, { tabIndex: 0 })],
          }),
          field('second', 'text', {
            widgets: [widget('text', 0, { x0: 100, y0: 650, x1: 300, y1: 674 }, { tabIndex: 1 })],
          }),
        ],
        { tabs: ['manual'] },
      ),
    );
    const pdf = await reopen(result.bytes);
    const page = pdf.getPages()[0];
    expect(page?.node.get(PDFName.of('Tabs'))).toBeUndefined();
    const annots = page?.node.Annots();
    const names = (annots?.asArray() ?? []).map((ref) => {
      const dict = pdf.context.lookupMaybe(ref, PDFDict);
      const raw = dict?.lookup(PDFName.of('T'));
      return raw instanceof PDFHexString || raw instanceof PDFString ? raw.decodeText() : '';
    });
    expect(names).toEqual(['first', 'second', 'third']);
  });

  it('writes `/Tabs /R` when the page orders by row', async () => {
    const result = await write(await blank(), form([field('one', 'text')], { tabs: ['row'] }));
    const pdf = await reopen(result.bytes);
    expect(pdf.getPages()[0]?.node.lookupMaybe(PDFName.of('Tabs'), PDFName)?.decodeText()).toBe(
      'R',
    );
  });

  it('replaces the widgets a file already had rather than adding to them', async () => {
    // Two passes over the same bytes: the second must not leave the first pass's widgets behind.
    const once = await write(await blank(), form([field('a', 'text')]));
    const twice = await write(once.bytes, form([field('b', 'text')]));
    const pdf = await reopen(twice.bytes);
    expect([...fieldsByName(pdf).keys()]).toEqual(['b']);
    expect(pdf.getPages()[0]?.node.Annots()?.size()).toBe(1);
  });

  it('leaves an annotation that is not a widget alone', async () => {
    const base = await PDFDocument.create({ updateMetadata: false });
    const page = base.addPage([595, 842]);
    const note = base.context.obj({});
    note.set(PDFName.of('Type'), PDFName.of('Annot'));
    note.set(PDFName.of('Subtype'), PDFName.of('Text'));
    note.set(PDFName.of('Rect'), base.context.obj([10, 10, 30, 30]));
    page.node.set(PDFName.of('Annots'), base.context.obj([base.context.register(note)]));
    const bytes = await base.save({ useObjectStreams: false, updateFieldAppearances: false });

    const result = await write(bytes, form([field('a', 'text')]));
    const pdf = await reopen(result.bytes);
    const subtypes = (pdf.getPages()[0]?.node.Annots()?.asArray() ?? []).map((ref) =>
      pdf.context
        .lookupMaybe(ref, PDFDict)
        ?.lookupMaybe(PDFName.of('Subtype'), PDFName)
        ?.decodeText(),
    );
    expect(subtypes.sort()).toEqual(['Text', 'Widget']);
  });
});

describe('PDFium reads back what we wrote', () => {
  it('reports every field type, its value and its design', async () => {
    const rect = (y: number): PdfRect => ({ x0: 100, y0: y, x1: 300, y1: y + 24 });
    const result = await write(
      await blank(),
      form([
        field('person.name', 'text', {
          value: 'Ada Lovelace',
          widgets: [widget('text', 0, rect(700))],
        }),
        field('person.note', 'text', {
          flags: flagBit(TEXT_FLAGS.multiline) | flagBit(COMMON_FLAGS.required),
          value: 'Line one\nLine two',
          widgets: [widget('text', 0, rect(640))],
        }),
        field('agree', 'checkbox', {
          value: 'Yes',
          widgets: [
            widget(
              'checkbox',
              0,
              { x0: 100, y0: 600, x1: 114, y1: 614 },
              {
                on: true,
                exportValue: 'Yes',
              },
            ),
          ],
        }),
        field('size', 'combobox', {
          type: 'Ch',
          flags: flagBit(CHOICE_FLAGS.combo),
          value: 'l',
          options: [
            { value: 's', label: 'Small' },
            { value: 'l', label: 'Large' },
          ],
          widgets: [widget('combobox', 0, rect(560))],
        }),
        field('sign', 'signature', {
          type: 'Sig',
          widgets: [widget('signature', 0, rect(500))],
        }),
      ]),
    );
    expect(result.warnings).toEqual([]);

    const pdfium = await engine();
    const handle = await pdfium.open(result.bytes);
    try {
      const fields = await pdfium.formFields(handle);
      const byName = new Map(fields.map((f) => [f.name, f]));
      expect([...byName.keys()].sort()).toEqual([
        'agree',
        'person.name',
        'person.note',
        'sign',
        'size',
      ]);
      expect(byName.get('person.name')?.type).toBe('text');
      expect(byName.get('person.name')?.value).toBe('Ada Lovelace');
      expect(byName.get('person.note')?.required).toBe(true);
      expect(byName.get('agree')?.type).toBe('checkbox');
      expect(byName.get('agree')?.value).toBe('Yes');
      expect(byName.get('size')?.type).toBe('combobox');
      expect(byName.get('size')?.options?.map((o) => o.label)).toEqual(['Small', 'Large']);
      expect(byName.get('sign')?.type).toBe('signature');
      // The design comes back through the raw pass, which is what makes a reopen editable.
      expect(byName.get('person.note')?.design?.role).toBe('text');
      expect(byName.get('size')?.design?.options).toEqual([
        { value: 's', label: 'Small' },
        { value: 'l', label: 'Large' },
      ]);
      expect(byName.get('person.name')?.widgets[0]?.appearance?.borderWidth).toBe(1);
    } finally {
      await pdfium.close(handle);
    }
  });

  it('renders the widgets it wrote, and only when the form environment is asked to draw them', async () => {
    const result = await write(
      await blank(),
      form([
        field('name', 'text', {
          value: 'Ada',
          widgets: [
            widget('text', 0, { x0: 100, y0: 700, x1: 300, y1: 724 }, { fillColor: 0xffff00 }),
          ],
        }),
      ]),
    );
    const pdfium = await engine();
    const handle = await pdfium.open(result.bytes);
    try {
      const withForms = await pdfium.renderRaw(handle, 0, 1, undefined, { forms: true });
      const without = await pdfium.renderRaw(handle, 0, 1, undefined, { forms: false });
      const ink = (rgba: Uint8ClampedArray): number => {
        let n = 0;
        for (let i = 0; i < rgba.length; i += 4) if ((rgba[i] ?? 255) < 250) n++;
        return n;
      };
      // A widget annotation is drawn by the form-fill environment, not by the page: PDFium puts
      // nothing on the raster for one when `forms` is off. That is exactly what M60 relies on —
      // the widget layer draws every field itself and the viewer turns this flag off while it is
      // mounted, so the two never draw the same field twice (ADR 0019). Printing and export leave
      // it on, which is why the field is on paper.
      expect(ink(withForms.rgba)).toBeGreaterThan(0);
      expect(ink(without.rgba)).toBe(0);
    } finally {
      await pdfium.close(handle);
    }
  });

  it('reads a barcode field back as a barcode field, with its symbology', async () => {
    const design = { ...defaultFieldDesign('barcode') };
    const rect = { x0: 100, y0: 600, x1: 244, y1: 672 };
    const result = await write(
      await blank(),
      form([
        field('code', 'barcode', {
          value: 'ORDER-4711',
          widgets: [
            widget('barcode', 0, rect, {
              appearance: widgetAppearance({
                rect,
                design,
                widget: defaultWidgetAppearance('barcode'),
                value: 'ORDER-4711',
              }),
            }),
          ],
          entries: {
            [ROLE_KEY]: { kind: 'name', value: 'barcode' },
            [BARCODE_KEY]: {
              kind: 'dict',
              value: {
                Symbology: { kind: 'name', value: 'pdf417' },
                EC: { kind: 'number', value: 5 },
                CellSize: { kind: 'number', value: 1 },
              },
            },
          },
        }),
      ]),
    );
    const pdfium = await engine();
    const handle = await pdfium.open(result.bytes);
    try {
      const fields = await pdfium.formFields(handle);
      const code = fields.find((f) => f.name === 'code');
      expect(code?.design?.role).toBe('barcode');
      expect(code?.design?.barcode?.symbology).toBe('pdf417');
      expect(code?.value).toBe('ORDER-4711');
    } finally {
      await pdfium.close(handle);
    }
  });
});

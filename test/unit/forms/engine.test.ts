/**
 * Reading a real form back out of PDFium (M60).
 *
 * The design a properties dialog edits is not in PDFium's form API at all — it is read from the
 * bytes and joined on the field name — so this checks the join over the fixture that has one of
 * every field type, and pins the two readings that were wrong before this module looked at them.
 */

import { describe, expect, it } from 'vitest';
import type { FormField } from '@engine/PdfEngine';
import { CHOICE_FLAGS, COMMON_FLAGS, TEXT_FLAGS, hasFlag } from '@engine/forms/model';
import { engine, fixture } from '../engine/helpers';

async function readFields(name: string): Promise<Map<string, FormField>> {
  const pdfium = await engine();
  const handle = await pdfium.open(fixture(name));
  try {
    const fields = await pdfium.formFields(handle);
    return new Map(fields.map((f) => [f.name, f]));
  } finally {
    await pdfium.close(handle);
  }
}

describe('reading a form', () => {
  it('reports every field of the fixture with its type and value', async () => {
    const byName = await readFields('forms-all.pdf');
    expect(byName.get('fields.text')?.value).toBe('Hello');
    expect(byName.get('fields.multiline')?.value).toContain('Line two');
    expect(byName.get('fields.combo')?.type).toBe('combobox');
    expect(byName.get('fields.list')?.type).toBe('listbox');
    expect(byName.get('fields.button')?.type).toBe('button');
    expect(byName.get('fields.signature')?.type).toBe('signature');
  });

  it('reads `/Ff` in full, not just read-only and required', async () => {
    const byName = await readFields('forms-all.pdf');
    const flagsOf = (name: string): number => byName.get(name)?.design?.flags ?? 0;
    expect(hasFlag(flagsOf('fields.multiline'), TEXT_FLAGS.multiline)).toBe(true);
    expect(hasFlag(flagsOf('fields.password'), TEXT_FLAGS.password)).toBe(true);
    expect(hasFlag(flagsOf('fields.readonly'), COMMON_FLAGS.readOnly)).toBe(true);
    expect(hasFlag(flagsOf('fields.readonly'), COMMON_FLAGS.required)).toBe(true);
    expect(hasFlag(flagsOf('fields.combo'), CHOICE_FLAGS.combo)).toBe(true);
    expect(hasFlag(flagsOf('fields.combo'), CHOICE_FLAGS.edit)).toBe(true);
    expect(hasFlag(flagsOf('fields.list'), CHOICE_FLAGS.multiSelect)).toBe(true);
  });

  it('reads `/MaxLen` and the `/DA` parts a properties dialog edits', async () => {
    const byName = await readFields('forms-all.pdf');
    expect(byName.get('fields.text')?.design?.maxLength).toBe(40);
    const design = byName.get('fields.text')?.design;
    expect(design?.role).toBe('text');
    expect(typeof design?.fontSize).toBe('number');
    expect(design?.textColor).toBe(0x000000);
  });

  it('gives every widget its own `/MK` and border', async () => {
    const byName = await readFields('forms-all.pdf');
    const widget = byName.get('fields.text')?.widgets[0];
    expect(widget?.appearance).toBeDefined();
    expect(widget?.appearance?.borderWidth).toBeGreaterThanOrEqual(0);
    expect(widget?.index).toBeGreaterThanOrEqual(0);
  });

  /**
   * A radio group is one field with a widget per button, and PDFium answers the value per
   * *widget* — so the group used to read as "Off" whenever the chosen button was not the first
   * one enumerated. The fixture chooses the third.
   */
  it('reports a radio group’s value from the button that is actually chosen', async () => {
    const byName = await readFields('forms-all.pdf');
    const radio = byName.get('fields.radio');
    expect(radio?.type).toBe('radio');
    expect(radio?.value).toBe('blue');
    expect(radio?.widgets).toHaveLength(3);
  });

  /**
   * A radio group may name its appearance states by their index into `/Opt` rather than by the
   * value they export (PDF 12.7.4.2.1). Read as-is, a group of three buttons exports "0", "1"
   * and "2" — which is what the file says and not what the form means.
   */
  it('maps a radio button’s state through `/Opt` to the value it exports', async () => {
    const byName = await readFields('forms-all.pdf');
    const radio = byName.get('fields.radio');
    expect(radio?.widgets.map((w) => w.appearance?.exportValue)).toEqual(['red', 'green', 'blue']);
    expect(radio?.design?.options.map((o) => o.value)).toEqual(['red', 'green', 'blue']);
  });

  it('reads a check box’s export value, and tells the on one from the off one', async () => {
    const byName = await readFields('forms-all.pdf');
    expect(byName.get('fields.checkbox')?.value).toBe('Yes');
    expect(byName.get('fields.checkbox2')?.value).toBe('Off');
    expect(byName.get('fields.checkbox2')?.widgets[0]?.appearance?.exportValue).toBe('Yes');
  });

  it('reads a choice field’s options as export/label pairs', async () => {
    const byName = await readFields('forms-all.pdf');
    expect(byName.get('fields.combo')?.design?.options.map((o) => o.label)).toEqual([
      'Alpha',
      'Beta',
      'Gamma',
    ]);
  });

  it('says nothing about a document that has no form', async () => {
    const byName = await readFields('multipage.pdf');
    expect(byName.size).toBe(0);
  });
});

describe('writing a value back', () => {
  it('replaces a list box’s selection rather than adding to it', async () => {
    const pdfium = await engine();
    const handle = await pdfium.open(fixture('forms-all.pdf'));
    try {
      // The fixture selects Two and Four. Setting Three must leave *only* Three.
      await pdfium.setFieldValue(handle, 'fields.list', 'Three');
      const fields = await pdfium.formFields(handle);
      expect(fields.find((f) => f.name === 'fields.list')?.value).toBe('Three');
    } finally {
      await pdfium.close(handle);
    }
  });

  it('takes a newline-separated value for a multi-select list', async () => {
    const pdfium = await engine();
    const handle = await pdfium.open(fixture('forms-all.pdf'));
    try {
      await pdfium.setFieldValue(handle, 'fields.list', 'One\nThree');
      const fields = await pdfium.formFields(handle);
      // PDFium reports the first selected option; both are set, and neither of the fixture's is.
      expect(fields.find((f) => f.name === 'fields.list')?.value).toBe('One');
    } finally {
      await pdfium.close(handle);
    }
  });

  it('refuses an option a list box does not have, in words', async () => {
    const pdfium = await engine();
    const handle = await pdfium.open(fixture('forms-all.pdf'));
    try {
      await expect(pdfium.setFieldValue(handle, 'fields.list', 'Nine')).rejects.toThrow(/Nine/);
    } finally {
      await pdfium.close(handle);
    }
  });
});

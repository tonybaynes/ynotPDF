/**
 * The `/DA` round trip and the appearance streams every field type draws.
 *
 * The streams are checked as *operators* rather than by rendering, because that is what the file
 * carries and what a second viewer will read: if the text is in the box, the border is the width
 * the field asked for and the check glyph is the one the style names, then Acrobat and Chrome
 * show what we showed. The rendering itself is covered end to end by the writer round-trip test.
 */

import { describe, expect, it } from 'vitest';
import {
  DA_FONT_KEYS,
  daFontKey,
  formatDefaultAppearance,
  parseDefaultAppearance,
} from '@engine/forms/da';
import {
  centredBaseline,
  contentBox,
  effectiveBorderWidth,
  layoutValue,
  widgetAppearance,
} from '@engine/forms/appearance';
import {
  CHECK_STYLE_GLYPH,
  CHOICE_FLAGS,
  TEXT_FLAGS,
  defaultFieldDesign,
  defaultWidgetAppearance,
  flagBit,
  type FieldDesign,
  type WidgetAppearance,
} from '@engine/forms/model';

const RECT = { x0: 100, y0: 700, x1: 300, y1: 724 };

function draw(
  design: Partial<FieldDesign>,
  widget: Partial<WidgetAppearance> = {},
  value = '',
  state?: 'on' | 'off',
): string {
  return drawIn(RECT, design, widget, value, state);
}

function drawIn(
  rect: typeof RECT,
  design: Partial<FieldDesign>,
  widget: Partial<WidgetAppearance> = {},
  value = '',
  state?: 'on' | 'off',
): string {
  const role = design.role ?? 'text';
  const stream = widgetAppearance({
    rect,
    design: { ...defaultFieldDesign(role), ...design },
    widget: { ...defaultWidgetAppearance(role), ...widget },
    value,
    ...(state ? { state } : {}),
  });
  return stream?.content ?? '';
}

describe('`/DA`', () => {
  it('round-trips a font, a size and a colour', () => {
    const da = formatDefaultAppearance({ font: 'Helvetica-Bold', size: 11, color: 0x336699 });
    expect(da).toBe('/HeBo 11 Tf 0.2 0.4 0.6 rg');
    const back = parseDefaultAppearance(da);
    expect(back.font).toBe('Helvetica-Bold');
    expect(back.size).toBe(11);
    expect(back.color).toBe(0x336699);
  });

  it('writes a neutral colour as grey, the way a form usually carries it', () => {
    expect(formatDefaultAppearance({ font: 'Helvetica', size: 0, color: 0x000000 })).toBe(
      '/Helv 0 Tf 0 g',
    );
    expect(parseDefaultAppearance('/Helv 0 Tf 0 g').color).toBe(0x000000);
    expect(parseDefaultAppearance('/Helv 9 Tf 1 g').color).toBe(0xffffff);
  });

  it('reads a CMYK `/DA`, which is what a print-shop form carries', () => {
    expect(parseDefaultAppearance('/Helv 9 Tf 0 1 1 0 k').color).toBe(0xff0000);
  });

  it('falls back rather than throwing on a `/DA` it cannot make sense of', () => {
    expect(parseDefaultAppearance('').size).toBe(0);
    expect(parseDefaultAppearance('nonsense').font).toBe('Helvetica');
    expect(parseDefaultAppearance(null).color).toBe(0x000000);
  });

  it('knows every standard-14 resource key, and keeps a system family as its own', () => {
    expect(Object.keys(DA_FONT_KEYS)).toHaveLength(14);
    expect(daFontKey('ZapfDingbats')).toBe('ZaDb');
    expect(daFontKey({ baseFont: 'Segoe UI', fallback: 'Helvetica' })).toBe('SegoeUI');
  });
});

describe('geometry', () => {
  it('takes the border and the padding off the content box', () => {
    const box = contentBox(RECT, { ...defaultWidgetAppearance('text'), borderWidth: 2 });
    expect(box.x0).toBe(3);
    expect(box.x1).toBe(197);
    expect(box.y1).toBe(21);
  });

  it('draws no border at all when the field has no border colour', () => {
    expect(effectiveBorderWidth({ ...defaultWidgetAppearance('text'), borderColor: null })).toBe(0);
    expect(effectiveBorderWidth(defaultWidgetAppearance('text'))).toBe(1);
  });

  it('gives a bevel at least one point, because a bevel of nothing is not a bevel', () => {
    expect(
      effectiveBorderWidth({
        ...defaultWidgetAppearance('text'),
        borderStyle: 'beveled',
        borderWidth: 0,
      }),
    ).toBe(1);
  });

  it('centres one line on the box rather than on its own em square', () => {
    const box = { x0: 0, y0: 0, x1: 100, y1: 20 };
    const baseline = centredBaseline(box, 10);
    expect(baseline).toBeCloseTo(10 - 3.6, 5);
    const laid = layoutValue('Hello', { font: 'Helvetica', size: 10, color: 0 }, box, {
      multiline: false,
      align: 0,
    });
    expect(laid.lines).toHaveLength(1);
    expect(laid.lines[0]?.y).toBeCloseTo(baseline, 5);
  });

  it('wraps a multiline value from the top down', () => {
    const box = { x0: 0, y0: 0, x1: 60, y1: 60 };
    const laid = layoutValue(
      'one two three four five six',
      { font: 'Helvetica', size: 10, color: 0 },
      box,
      { multiline: true, align: 0 },
    );
    expect(laid.lines.length).toBeGreaterThan(1);
    const ys = laid.lines.map((l) => l.y);
    expect(ys[0]).toBeGreaterThan(ys[1] ?? 0);
  });

  it('picks a size that fits when the field asks for auto', () => {
    const box = { x0: 0, y0: 0, x1: 200, y1: 12 };
    const laid = layoutValue('Hello', { font: 'Helvetica', size: 0, color: 0 }, box, {
      multiline: false,
      align: 0,
    });
    expect(laid.size).toBeGreaterThanOrEqual(4);
    expect(laid.size).toBeLessThanOrEqual(12);
  });

  it('aligns right and centre from the box, not from the origin', () => {
    const box = { x0: 0, y0: 0, x1: 100, y1: 20 };
    const right = layoutValue('Hi', { font: 'Helvetica', size: 10, color: 0 }, box, {
      multiline: false,
      align: 2,
    });
    const centre = layoutValue('Hi', { font: 'Helvetica', size: 10, color: 0 }, box, {
      multiline: false,
      align: 1,
    });
    expect(right.lines[0]?.x).toBeGreaterThan(centre.lines[0]?.x ?? 0);
    expect(centre.lines[0]?.x).toBeGreaterThan(0);
  });
});

describe('the streams', () => {
  it('fills and strokes the box in the colours `/MK` names', () => {
    const content = draw({}, { fillColor: 0xffffff, borderColor: 0xff0000, borderWidth: 2 });
    expect(content).toContain('1 1 1 rg');
    expect(content).toContain('1 0 0 RG');
    expect(content).toContain('2 w');
  });

  it('draws nothing but the content when the field is transparent', () => {
    // The only `re` left is the clip: no fill and no stroke, so whatever the page draws behind a
    // transparent field still shows through — which is what most form boxes actually are.
    const content = draw({}, { fillColor: null, borderColor: null }, 'Hello');
    expect(content).not.toMatch(/re\n[fSB]/);
    expect(content).toContain('(Hello) Tj');
  });

  it('draws a text value clipped to the content box', () => {
    const content = draw({}, {}, 'Hello');
    expect(content).toContain('W');
    expect(content).toContain('(Hello) Tj');
  });

  it('shows bullets for a password rather than the value', () => {
    const design = { flags: flagBit(TEXT_FLAGS.password) };
    const content = draw(design, {}, 'secret');
    expect(content).not.toContain('secret');
    // WinAnsi byte 0x95 — a U+2022 bullet would reach the file as a question mark.
    expect(content).toContain(`(${'\u0095'.repeat(6)}) Tj`);
  });

  it('draws a comb one character per cell, with a separator between them', () => {
    const content = draw({ flags: flagBit(TEXT_FLAGS.comb), maxLength: 4 }, {}, 'AB');
    expect(content).toContain('(A) Tj');
    expect(content).toContain('(B) Tj');
    // Three separators for four cells.
    expect(content.match(/ l\nS/g)?.length).toBe(3);
  });

  it('draws the check glyph the style names, and nothing at all when off', () => {
    const on = draw({ role: 'checkbox' }, { checkStyle: 'cross' }, 'Yes', 'on');
    expect(on).toContain(`(${CHECK_STYLE_GLYPH.cross}) Tj`);
    const off = draw({ role: 'checkbox' }, { checkStyle: 'cross' }, 'Off', 'off');
    expect(off).not.toContain('Tj');
  });

  it('draws a radio dot as a circle rather than as a glyph, so it reads at any size', () => {
    const on = draw({ role: 'radio' }, { checkStyle: 'circle' }, 'Yes', 'on');
    expect(on).toContain(' c');
    expect(on).not.toContain('Tj');
  });

  it('draws a combo box’s value and its arrow', () => {
    const content = draw({ role: 'combobox', options: [{ value: 'b', label: 'Beta' }] }, {}, 'b');
    expect(content).toContain('(Beta) Tj');
    // The arrow is a filled triangle: three points and a close.
    expect(content).toMatch(/h\nf/);
  });

  it('draws a list box’s options with a band behind the chosen ones', () => {
    const content = drawIn(
      { x0: 100, y0: 640, x1: 300, y1: 724 },
      {
        role: 'listbox',
        flags: flagBit(CHOICE_FLAGS.multiSelect),
        options: [
          { value: '1', label: 'One' },
          { value: '2', label: 'Two' },
        ],
      },
      {},
      '2',
    );
    expect(content).toContain('(One) Tj');
    expect(content).toContain('(Two) Tj');
    expect(content).toContain(' re');
  });

  it('draws a push button’s caption in the middle', () => {
    const content = draw({ role: 'button' }, { caption: 'Send' });
    expect(content).toContain('(Send) Tj');
  });

  it('draws a signature field as an empty box', () => {
    const content = draw({ role: 'signature' });
    expect(content).not.toContain('Tj');
    expect(content).toContain(' re');
  });

  it('gives every widget a BBox at the origin, whatever the rect', () => {
    const stream = widgetAppearance({
      rect: RECT,
      design: defaultFieldDesign('text'),
      widget: defaultWidgetAppearance('text'),
      value: 'x',
    });
    expect(stream?.bbox).toEqual({ x0: 0, y0: 0, x1: 200, y1: 24 });
  });

  it('has nothing to draw for a hidden widget', () => {
    const stream = widgetAppearance({
      rect: RECT,
      design: defaultFieldDesign('text'),
      widget: { ...defaultWidgetAppearance('text'), hidden: true },
      value: 'x',
    });
    expect(stream).toBeNull();
  });

  it('names the fonts it used, so the writer can put them in `/DR`', () => {
    const stream = widgetAppearance({
      rect: RECT,
      design: { ...defaultFieldDesign('text'), font: 'Times-Bold' },
      widget: defaultWidgetAppearance('text'),
      value: 'x',
    });
    expect(Object.values(stream?.resources.fonts ?? {})).toContain('Times-Bold');
  });
});

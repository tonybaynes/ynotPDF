/**
 * M60's pure model: the `/Ff` bit table, the roles that AcroForm has no `/FT` for, field names
 * and the hierarchy they build, and the tab order a page sorts into.
 *
 * Every bit number here is checked against ISO 32000-1's own tables rather than against our
 * arithmetic, which is the whole reason the table stores 1-based bit *numbers*.
 */

import { describe, expect, it } from 'vitest';
import {
  BUTTON_FLAGS,
  CHOICE_FLAGS,
  COMMON_FLAGS,
  TEXT_FLAGS,
  defaultFieldDesign,
  defaultFieldSize,
  defaultWidgetAppearance,
  fieldNameProblem,
  fieldTypeOf,
  flagBit,
  hasFlag,
  isComb,
  isFillable,
  isMultiSelect,
  isReadOnly,
  isRequired,
  joinFieldName,
  nextFreeName,
  parentName,
  partialName,
  splitFieldName,
  tabModeOf,
  tabSort,
  tabsName,
  withFlag,
} from '@engine/forms/model';

describe('the `/Ff` bit table', () => {
  it('numbers bits the way the PDF tables do — 1-based', () => {
    expect(flagBit(1)).toBe(1);
    expect(flagBit(2)).toBe(2);
    expect(flagBit(13)).toBe(4096);
    expect(flagBit(17)).toBe(65_536);
    expect(flagBit(25)).toBe(16_777_216);
    expect(flagBit(0)).toBe(0);
  });

  it('reads and writes a bit without touching its neighbours', () => {
    let flags = 0;
    flags = withFlag(flags, COMMON_FLAGS.required, true);
    flags = withFlag(flags, TEXT_FLAGS.multiline, true);
    expect(hasFlag(flags, COMMON_FLAGS.required)).toBe(true);
    expect(hasFlag(flags, TEXT_FLAGS.multiline)).toBe(true);
    expect(hasFlag(flags, COMMON_FLAGS.readOnly)).toBe(false);
    flags = withFlag(flags, TEXT_FLAGS.multiline, false);
    expect(hasFlag(flags, TEXT_FLAGS.multiline)).toBe(false);
    expect(hasFlag(flags, COMMON_FLAGS.required)).toBe(true);
  });

  it('keeps the button, choice and text meanings of the overlapping bits apart', () => {
    // Bit 22 is "do not scroll" on a text field and "multi-select" on a choice field: the two
    // tables are what stop one flat list from telling a lie.
    expect(TEXT_FLAGS.doNotScroll).toBe(24);
    expect(CHOICE_FLAGS.multiSelect).toBe(22);
    expect(BUTTON_FLAGS.pushButton).toBe(17);
    expect(BUTTON_FLAGS.radio).toBe(16);
  });
});

describe('roles', () => {
  it('writes the three roles AcroForm has no `/FT` for as the field they really are', () => {
    expect(fieldTypeOf('image')).toBe('button');
    expect(fieldTypeOf('date')).toBe('text');
    expect(fieldTypeOf('barcode')).toBe('text');
    expect(fieldTypeOf('listbox')).toBe('listbox');
  });

  it('gives a new field of each role the flags its type needs', () => {
    expect(hasFlag(defaultFieldDesign('button').flags, BUTTON_FLAGS.pushButton)).toBe(true);
    expect(hasFlag(defaultFieldDesign('image').flags, BUTTON_FLAGS.pushButton)).toBe(true);
    expect(hasFlag(defaultFieldDesign('radio').flags, BUTTON_FLAGS.radio)).toBe(true);
    expect(hasFlag(defaultFieldDesign('combobox').flags, CHOICE_FLAGS.combo)).toBe(true);
    expect(defaultFieldDesign('checkbox').flags).toBe(0);
  });

  it('gives a date field a format and a barcode field a symbology', () => {
    expect(defaultFieldDesign('date').dateFormat).toBe('dd/mm/yyyy');
    expect(defaultFieldDesign('barcode').barcode?.symbology).toBe('pdf417');
    expect(defaultFieldDesign('text').barcode).toBeNull();
  });

  it('sizes a clicked field the way its type wants to be sized', () => {
    expect(defaultFieldSize('checkbox')).toEqual({ width: 14, height: 14 });
    expect(defaultFieldSize('listbox').height).toBeGreaterThan(defaultFieldSize('text').height);
  });

  it('gives a push button a caption and a check box an export value', () => {
    expect(defaultWidgetAppearance('button').caption).toBe('Button');
    expect(defaultWidgetAppearance('checkbox').exportValue).toBe('Yes');
    expect(defaultWidgetAppearance('image').layout).toBe('icon-only');
  });
});

describe('flags as questions', () => {
  it('needs a maximum length and a single line before a comb is a comb', () => {
    const base = defaultFieldDesign('text');
    const comb = { ...base, flags: withFlag(base.flags, TEXT_FLAGS.comb, true), maxLength: 8 };
    expect(isComb(comb)).toBe(true);
    expect(isComb({ ...comb, maxLength: null })).toBe(false);
    expect(isComb({ ...comb, flags: withFlag(comb.flags, TEXT_FLAGS.multiline, true) })).toBe(
      false,
    );
  });

  it('reads read-only, required and multi-select off `/Ff`', () => {
    const list = defaultFieldDesign('listbox');
    expect(isMultiSelect({ ...list, flags: flagBit(CHOICE_FLAGS.multiSelect) })).toBe(true);
    expect(isReadOnly({ ...list, flags: flagBit(COMMON_FLAGS.readOnly) })).toBe(true);
    expect(isRequired({ ...list, flags: flagBit(COMMON_FLAGS.required) })).toBe(true);
  });

  it('calls a button, an image field and a signature unfillable, and a read-only field too', () => {
    expect(isFillable(defaultFieldDesign('button'))).toBe(false);
    expect(isFillable(defaultFieldDesign('image'))).toBe(false);
    expect(isFillable(defaultFieldDesign('signature'))).toBe(false);
    expect(isFillable(defaultFieldDesign('text'))).toBe(true);
    const locked = defaultFieldDesign('text');
    expect(isFillable({ ...locked, flags: flagBit(COMMON_FLAGS.readOnly) })).toBe(false);
  });
});

describe('field names', () => {
  it('splits and rejoins a dotted name', () => {
    expect(splitFieldName('a.b.c')).toEqual(['a', 'b', 'c']);
    expect(joinFieldName(['a', 'b', 'c'])).toBe('a.b.c');
    expect(partialName('a.b.c')).toBe('c');
    expect(parentName('a.b.c')).toBe('a.b');
    expect(parentName('a')).toBe('');
  });

  it('refuses an empty name, a stray dot and a control character', () => {
    expect(fieldNameProblem('', [])).toMatch(/needs a name/);
    expect(fieldNameProblem('a..b', [])).toMatch(/dot/);
    expect(fieldNameProblem('.a', [])).toMatch(/dot/);
    expect(fieldNameProblem('a.', [])).toMatch(/dot/);
    expect(fieldNameProblem('ab', [])).toMatch(/control/);
  });

  it('refuses a name another field already has, and says why', () => {
    expect(fieldNameProblem('city', ['city', 'town'])).toMatch(/sharing a value/);
    // Renaming a field to the name it already has is not a clash.
    expect(fieldNameProblem('city', ['city'], 'city')).toBeNull();
  });

  it('finds the next free name beside one that is taken', () => {
    expect(nextFreeName('Text 1', [])).toBe('Text 1');
    expect(nextFreeName('Text 1', ['Text 1'])).toBe('Text 2');
    expect(nextFreeName('Text 1', ['Text 1', 'Text 2'])).toBe('Text 3');
    expect(nextFreeName('order.city', ['order.city'])).toBe('order.city 2');
  });
});

describe('tab order', () => {
  const box = (x0: number, y0: number, w = 100, h = 20) =>
    ({ rect: { x0, y0, x1: x0 + w, y1: y0 + h } }) as const;

  it('names `/Tabs` for the three rules and nothing for a manual order', () => {
    expect(tabsName('row')).toBe('R');
    expect(tabsName('column')).toBe('C');
    expect(tabsName('structure')).toBe('S');
    expect(tabsName('manual')).toBeNull();
    expect(tabModeOf('R')).toBe('row');
    expect(tabModeOf(undefined)).toBeNull();
  });

  it('reads by row, top to bottom then left to right', () => {
    const items = [box(300, 700), box(100, 700), box(100, 600)];
    expect(tabSort(items, 'row', (i) => i.rect).map((i) => i.rect.x0)).toEqual([100, 300, 100]);
    expect(tabSort(items, 'row', (i) => i.rect).map((i) => i.rect.y0)).toEqual([700, 700, 600]);
  });

  it('bands a row rather than sorting on `y` alone', () => {
    // Two boxes three points apart vertically are on the same line to any reader; a sort on `y`
    // would put the second one on a row of its own and tab through the form in the wrong order.
    const items = [box(300, 700), box(100, 703)];
    expect(tabSort(items, 'row', (i) => i.rect).map((i) => i.rect.x0)).toEqual([100, 300]);
  });

  it('reads by column, left to right then top to bottom', () => {
    const items = [box(100, 600), box(300, 700), box(100, 700)];
    expect(tabSort(items, 'column', (i) => i.rect).map((i) => [i.rect.x0, i.rect.y0])).toEqual([
      [100, 700],
      [100, 600],
      [300, 700],
    ]);
  });
});

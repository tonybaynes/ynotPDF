/**
 * The app-wide unit and the interface font (M130) — the pure halves. Registering a `FontFace`
 * needs a document, so that part is proved by Playwright; what is decided here is which option
 * an id resolves to and what CSS the choice becomes.
 */

import { describe, expect, it } from 'vitest';
import { UNITS } from '@view/units';
import {
  DEFAULT_UNIT,
  isUnit,
  readUnit,
  RULER_UNITS_KEY,
  UNIT_LABELS,
  unitOptions,
  UNITS_KEY,
  unitsSetting,
} from '@modules/M130-preferences/units';
import {
  DEFAULT_UI_FONT,
  fontStack,
  isUiFont,
  SYSTEM_FONT,
  UI_FONTS,
  uiFont,
} from '@modules/M130-preferences/fonts';

describe('units', () => {
  it('defaults to millimetres — the operator works in metric', () => {
    expect(DEFAULT_UNIT).toBe('mm');
    expect(unitsSetting()['units']?.default).toBe('mm');
  });

  it('offers every unit the rulers understand, and nothing else', () => {
    expect(unitOptions().map((o) => o.value)).toEqual(UNITS.map((u) => u.id));
    for (const unit of UNITS) expect(UNIT_LABELS[unit.id]()).not.toBe('');
  });

  it('recognises a real unit and falls back for anything else', () => {
    expect(isUnit('in')).toBe(true);
    expect(isUnit('furlong')).toBe(false);
    expect(readUnit('cm')).toBe('cm');
    expect(readUnit(undefined)).toBe(DEFAULT_UNIT);
    expect(readUnit(42)).toBe(DEFAULT_UNIT);
  });

  it('keeps its own key separate from the ruler key it mirrors', () => {
    expect(UNITS_KEY).toBe('app.units');
    expect(RULER_UNITS_KEY).toBe('viewer.rulers.units');
  });

  it('is declared as live, because changing it redraws the rulers at once', () => {
    expect(unitsSetting()['units']?.live).toBe(true);
  });
});

describe('the interface font', () => {
  it('has a system default and at least one bundled alternative', () => {
    expect(DEFAULT_UI_FONT).toBe('system');
    expect(UI_FONTS.length).toBeGreaterThan(1);
    expect(uiFont(DEFAULT_UI_FONT).family).toBeNull();
  });

  it('falls back to the system font for an id it does not know', () => {
    expect(uiFont('comic-papyrus')).toBe(SYSTEM_FONT);
    expect(isUiFont('comic-papyrus')).toBe(false);
    expect(isUiFont(DEFAULT_UI_FONT)).toBe(true);
    expect(isUiFont(7)).toBe(false);
  });

  it('puts the bundled family first and keeps the fallback stack behind it', () => {
    const liberation = uiFont('liberation-sans');
    expect(liberation.family).not.toBeNull();
    const stack = fontStack(liberation);
    expect(stack.startsWith(`'${liberation.family ?? ''}'`)).toBe(true);
    expect(stack).toContain(liberation.stack);
  });

  it('gives the system font no leading family, so it is the OS stack exactly', () => {
    expect(fontStack(SYSTEM_FONT)).toBe(SYSTEM_FONT.stack);
  });

  it('every option ends in a generic family, so nothing can render as nothing', () => {
    for (const font of UI_FONTS) {
      expect(font.stack).toMatch(/(sans-serif|serif|monospace)\s*$/);
      expect(font.label).not.toBe('');
    }
  });

  it('names four faces for every bundled family, so bold and italic are real', () => {
    for (const font of UI_FONTS) {
      if (!font.files) continue;
      expect(Object.values(font.files).filter(Boolean)).toHaveLength(4);
      expect(font.family).not.toBeNull();
    }
  });
});

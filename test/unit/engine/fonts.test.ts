import { describe, expect, it } from 'vitest';
import { CHARSET, PITCH_FAMILY, normalizeFaceName, resolveSubstitute } from '@engine/pdfium/fonts';
import { loadSubstitutions } from './helpers';

const table = loadSubstitutions();

describe('font substitution table', () => {
  it('normalises face names', () => {
    expect(normalizeFaceName('Arial-BoldMT')).toEqual({ key: 'arial', bold: true, italic: false });
    expect(normalizeFaceName('ABCDEF+TimesNewRomanPS-BoldItalicMT')).toEqual({
      key: 'timesnewromanps',
      bold: true,
      italic: true,
    });
    expect(normalizeFaceName('Courier New,Bold')).toEqual({
      key: 'couriernew',
      bold: true,
      italic: false,
    });
    expect(normalizeFaceName('Helvetica-Oblique')).toEqual({
      key: 'helvetica',
      bold: false,
      italic: true,
    });
    expect(normalizeFaceName('Verdana')).toEqual({ key: 'verdana', bold: false, italic: false });
  });

  it('maps the common Windows and base-14 names to Liberation', () => {
    expect(resolveSubstitute(table, 'Arial', 400, false, CHARSET.ansi, 0)?.file).toBe(
      'LiberationSans-Regular.ttf',
    );
    expect(resolveSubstitute(table, 'Arial', 700, true, CHARSET.ansi, 0)?.file).toBe(
      'LiberationSans-BoldItalic.ttf',
    );
    expect(resolveSubstitute(table, 'TimesNewRoman', 400, true, CHARSET.ansi, 0)?.file).toBe(
      'LiberationSerif-Italic.ttf',
    );
    expect(resolveSubstitute(table, 'Courier New', 700, false, CHARSET.ansi, 0)?.file).toBe(
      'LiberationMono-Bold.ttf',
    );
    const helv = resolveSubstitute(table, 'Helvetica', 400, false, CHARSET.ansi, 0);
    expect(helv?.family.name).toBe('Liberation Sans');
    expect(helv?.exact).toBe(true);
  });

  it('falls back by charset and generic family, and leaves unknown Latin faces to PDFium', () => {
    expect(resolveSubstitute(table, 'SomeCorporateFont', 400, false, CHARSET.ansi, 0)).toBeNull();
    const cyr = resolveSubstitute(table, 'SomeCorporateFont', 400, false, CHARSET.cyrillic, 0);
    expect(cyr?.family.name).toBe('DejaVu Sans');
    expect(cyr?.exact).toBe(false);
    const cyrSerif = resolveSubstitute(
      table,
      'Unknown',
      400,
      false,
      CHARSET.greek,
      PITCH_FAMILY.roman,
    );
    expect(cyrSerif?.family.name).toBe('DejaVu Serif');
    const cyrMono = resolveSubstitute(
      table,
      'Unknown',
      700,
      false,
      CHARSET.cyrillic,
      PITCH_FAMILY.fixedPitch,
    );
    expect(cyrMono?.file).toBe('DejaVuSansMono-Bold.ttf');
  });

  it('every file named in the table follows the fetched release naming', () => {
    for (const fam of table.families) {
      for (const file of Object.values(fam.files)) {
        expect(file).toMatch(/^(Liberation|DejaVu)[A-Za-z]+(-[A-Za-z]+)?\.ttf$/);
      }
      expect(fam.aliases.every((a) => a === a.toLowerCase() && !/[\s\-_]/.test(a))).toBe(true);
    }
    for (const name of Object.values(table.charsetFallback)) {
      expect(table.families.some((f) => f.name === name)).toBe(true);
    }
  });
});

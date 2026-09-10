/**
 * The localisation framework (M130): the lookup, the extractor that fills the catalogue from the
 * code, and the spelling table that generates the American variant.
 *
 * The catalogues on disk are checked too — `npm run lint` runs the extractor with `--check`, so a
 * string added without regenerating them fails the build; these tests prove the generated files
 * are the shape `t()` expects and that the variant really differs.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  availableLanguages,
  catalogue,
  interpolate,
  isLanguage,
  language,
  setLanguage,
  SOURCE_LANGUAGE,
  t,
} from '@modules/M130-preferences/i18n';
import {
  catalogueJson,
  extractStrings,
  respell,
  spellingVariant,
  unescapeLiteral,
} from '../../../scripts/lib/i18n-extract';

const I18N = join(process.cwd(), 'resources', 'i18n');
const readJson = (name: string): { language: string; strings: Record<string, string> } =>
  JSON.parse(readFileSync(join(I18N, name), 'utf8')) as {
    language: string;
    strings: Record<string, string>;
  };

describe('t()', () => {
  it('answers with the catalogue entry when there is one', () => {
    const key = Object.keys(catalogue(SOURCE_LANGUAGE) ?? {})[0] ?? '';
    expect(t(key, 'a fallback nobody wrote')).toBe(catalogue(SOURCE_LANGUAGE)?.[key]);
  });

  it('answers with the call site’s English when the key is unknown', () => {
    expect(t('nothing.here.at.all', 'Plain English')).toBe('Plain English');
  });

  it('fills placeholders and leaves an unmatched one visible', () => {
    expect(t('nothing.here', '{n} of {total}', { n: 2, total: 9 })).toBe('2 of 9');
    expect(interpolate('{a} and {b}', { a: 'x' })).toBe('x and {b}');
  });

  it('starts in the source language', () => {
    expect(language()).toBe(SOURCE_LANGUAGE);
  });
});

describe('languages', () => {
  it('offers the two that ship, both with a catalogue', () => {
    const ids = availableLanguages().map((l) => l.id);
    expect(ids).toContain('en-GB');
    expect(ids).toContain('en-US');
    for (const id of ids) expect(catalogue(id)).toBeDefined();
  });

  it('recognises a shipped id and refuses anything else', () => {
    expect(isLanguage('en-US')).toBe(true);
    expect(isLanguage('fr-FR')).toBe(false);
    expect(isLanguage(7)).toBe(false);
  });

  it('switches, and an unknown id falls back to the source language', () => {
    try {
      expect(setLanguage('en-US')).toBe('en-US');
      // The generated variant is the proof: the same key, a different spelling.
      expect(t('units.mm', 'Millimetres')).toBe('Millimeters');
      expect(t('prefs.moreHeading', 'Customisation and files')).toBe('Customization and files');
      // A key the variant does not carry falls back to en-GB, not to nothing.
      expect(t('prefs.title', 'x')).toBe(catalogue('en-GB')?.['prefs.title']);
      expect(setLanguage('kl-KL')).toBe(SOURCE_LANGUAGE);
      expect(t('units.mm', 'Millimetres')).toBe('Millimetres');
    } finally {
      setLanguage(SOURCE_LANGUAGE);
    }
  });
});

describe('the catalogues on disk', () => {
  it('en-GB carries the module’s own strings, keyed the way the code asks for them', () => {
    const file = readJson('en-GB.json');
    expect(file.language).toBe('en-GB');
    expect(Object.keys(file.strings).length).toBeGreaterThan(50);
    expect(file.strings['prefs.title']).toBe('Preferences');
  });

  it('en-US lists only the strings that differ', () => {
    const gb = readJson('en-GB.json');
    const us = readJson('en-US.json');
    expect(Object.keys(us.strings).length).toBeGreaterThan(0);
    for (const [key, text] of Object.entries(us.strings)) {
      expect(gb.strings[key]).toBeDefined();
      expect(text).not.toBe(gb.strings[key]);
    }
  });

  it('the keys are sorted, so a regenerated file has a readable diff', () => {
    const keys = Object.keys(readJson('en-GB.json').strings);
    expect(keys).toEqual([...keys].sort());
  });
});

describe('the extractor', () => {
  it('finds a call site with either quote style, across lines, with or without variables', () => {
    const source = [
      "const a = t('one.key', 'One');",
      'const b = t("two.key", "Two");',
      "const c = t(\n  'three.key',\n  'Three',\n  { n: 1 },\n);",
    ].join('\n');
    const { found } = extractStrings(source, 'x.ts');
    expect(found.map((f) => [f.key, f.text])).toEqual([
      ['one.key', 'One'],
      ['two.key', 'Two'],
      ['three.key', 'Three'],
    ]);
  });

  it('handles an escaped quote inside the English', () => {
    const { found } = extractStrings("t('k', 'It\\'s here');", 'x.ts');
    expect(found[0]?.text).toBe("It's here");
    expect(unescapeLiteral('a\\nb')).toBe('a\nb');
  });

  it('reports a call whose key is not a literal, because it can never be translated', () => {
    expect(extractStrings('t(key, fallback);', 'x.ts').suspects).toBe(1);
    expect(extractStrings('t(`a${b}`, "x");', 'x.ts').suspects).toBe(1);
  });

  it('does not report the helper’s own declaration as a call site', () => {
    const source = 'export function t(\n  key: string,\n  fallback: string,\n): string {}';
    expect(extractStrings(source, 'i18n.ts').suspects).toBe(0);
  });

  it('ignores an unrelated identifier that ends in t', () => {
    expect(extractStrings('format(x); await(y);', 'x.ts').suspects).toBe(0);
  });
});

describe('respell', () => {
  const words = { colour: 'color', customise: 'customize', millimetres: 'millimeters' };

  it('keeps the original word’s capitalisation', () => {
    expect(respell('colour', words)).toBe('color');
    expect(respell('Colour', words)).toBe('Color');
    expect(respell('COLOUR', words)).toBe('COLOR');
  });

  it('replaces whole words only', () => {
    expect(respell('colourblindness', words)).toBe('colourblindness');
    expect(respell('The colour of it', words)).toBe('The color of it');
  });

  it('leaves an abbreviation beside a replaced word alone', () => {
    expect(respell('millimetres (mm)', words)).toBe('millimeters (mm)');
  });

  it('changes nothing it has no entry for', () => {
    expect(respell('nothing to do here', words)).toBe('nothing to do here');
  });

  it('a variant carries only the strings that changed', () => {
    const variant = spellingVariant({ a: 'A colour', b: 'Nothing here' }, words);
    expect(variant).toEqual({ a: 'A color' });
  });

  it('writes a catalogue with sorted keys and a trailing newline', () => {
    const text = catalogueJson('en-US', { b: '2', a: '1' }, 'note');
    expect(text.endsWith('\n')).toBe(true);
    expect(Object.keys((JSON.parse(text) as { strings: object }).strings)).toEqual(['a', 'b']);
  });
});

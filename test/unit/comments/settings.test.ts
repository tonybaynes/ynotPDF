/**
 * M32: the stored preferences, and the two value layers underneath the exchange formats.
 *
 * The settings are all *view* preferences — nothing here can change a document — and the point
 * of the tests is that an older or hand-edited store is upgraded rather than rejected. The
 * lexer and the value conversions get the awkward inputs a file from elsewhere actually
 * contains: octal escapes, nested parentheses, an odd-length hex string, a dictionary with a
 * stray value where a key should be, and a date with a real time-zone offset.
 */

import { describe, expect, it } from 'vitest';
import {
  COMMENT_SETTINGS_SCHEMA,
  DEFAULT_COMMENT_SETTINGS,
  memorySettingsStorage,
  readCommentSettings,
  writeCommentSetting,
} from '@modules/M32-comments-panel/settings';
import {
  asArray,
  asDict,
  asName,
  asNumber,
  asNumbers,
  asString,
  binaryToBytes,
  bytesToBinary,
  decodePdfText,
  dict,
  encodePdfText,
  pdfArray,
  pdfName,
  pdfNumber,
  pdfNumbers,
  pdfString,
  PdfLexer,
  writeValue,
  type PdfValue,
} from '@engine/xfdf/pdfsyntax';
import {
  colorComponents,
  flatten,
  flagWordList,
  fmt,
  formatColor,
  formatFlagWords,
  formatPoints,
  formatRect,
  isoToPdfDate,
  num,
  numberList,
  packColorComponents,
  packFlagBits,
  parseColor,
  parseFlagWords,
  parsePoints,
  parseRect,
  pdfDateToIso,
  unpackFlagBits,
} from '@engine/xfdf/values';

describe('comment settings', () => {
  it('reads the factory defaults from an empty store', async () => {
    expect(await readCommentSettings(memorySettingsStorage())).toEqual(DEFAULT_COMMENT_SETTINGS);
  });

  it('reads what was written, one key at a time', async () => {
    const storage = memorySettingsStorage();
    await writeCommentSetting(storage, 'group', 'author');
    await writeCommentSetting(storage, 'showReplies', false);
    await writeCommentSetting(storage, 'summaryFontSize', 12);
    const read = await readCommentSettings(storage);
    expect(read.group).toBe('author');
    expect(read.showReplies).toBe(false);
    expect(read.summaryFontSize).toBe(12);
    // Everything else is still the default.
    expect(read.sort).toBe(DEFAULT_COMMENT_SETTINGS.sort);
  });

  it('ignores a stored value of the wrong type rather than refusing to start', async () => {
    const storage = memorySettingsStorage({
      'comments.showReplies': 'yes please',
      'comments.summaryFontSize': null,
      'comments.group': 'author',
    });
    const read = await readCommentSettings(storage);
    expect(read.showReplies).toBe(DEFAULT_COMMENT_SETTINGS.showReplies);
    expect(read.summaryFontSize).toBe(DEFAULT_COMMENT_SETTINGS.summaryFontSize);
    expect(read.group).toBe('author');
  });

  it('the schema M130 renders matches the defaults it describes', () => {
    expect(COMMENT_SETTINGS_SCHEMA.namespace).toBe('comments');
    const properties = COMMENT_SETTINGS_SCHEMA.properties;
    expect(properties['group']?.default).toBe(DEFAULT_COMMENT_SETTINGS.group);
    expect(properties['sort']?.default).toBe(DEFAULT_COMMENT_SETTINGS.sort);
    expect(properties['showReplies']?.default).toBe(DEFAULT_COMMENT_SETTINGS.showReplies);
    expect(properties['summaryFontSize']?.default).toBe(DEFAULT_COMMENT_SETTINGS.summaryFontSize);
    expect(properties['summaryDpi']?.default).toBe(DEFAULT_COMMENT_SETTINGS.summaryDpi);
    // Every enum's default is one of its own options.
    for (const spec of Object.values(properties)) {
      if (spec.type !== 'enum') continue;
      expect(spec.options.map((o) => o.value)).toContain(spec.default);
    }
  });
});

describe('the PDF object lexer', () => {
  const read = (source: string): PdfValue | undefined =>
    new PdfLexer(source).readValue() ?? undefined;

  it('reads the scalar forms', () => {
    expect(read('true')).toEqual({ kind: 'bool', value: true });
    expect(read('false')).toEqual({ kind: 'bool', value: false });
    expect(read('null')).toEqual({ kind: 'null' });
    expect(read('42')).toEqual({ kind: 'number', value: 42 });
    expect(read('-3.5')).toEqual({ kind: 'number', value: -3.5 });
    expect(read('.5')).toEqual({ kind: 'number', value: 0.5 });
    expect(read('/Name')).toEqual({ kind: 'name', value: 'Name' });
    // A `#`-escaped name, which a file with a space in a key uses.
    expect(read('/A#20B')).toEqual({ kind: 'name', value: 'A B' });
  });

  it('reads an indirect reference, and a bare integer that only looks like one', () => {
    expect(read('12 0 R')).toEqual({ kind: 'ref', number: 12, generation: 0 });
    expect(read('12 0')).toEqual({ kind: 'number', value: 12 });
    expect(read('12 zero R')).toEqual({ kind: 'number', value: 12 });
  });

  it('reads a literal string with every escape a producer uses', () => {
    expect(asString(read('(plain)'))).toBe('plain');
    expect(asString(read('(a\\nb\\tc\\rd\\be\\ff)'))).toBe('a\nb\tc\rd\be\ff');
    expect(asString(read('(nested (parens) inside)'))).toBe('nested (parens) inside');
    expect(asString(read('(escaped \\( and \\))'))).toBe('escaped ( and )');
    expect(asString(read('(octal \\101\\102)'))).toBe('octal AB');
    // A backslash before a newline is a line continuation, not a character.
    expect(asString(read('(one \\\ntwo)'))).toBe('one two');
  });

  it('reads a hex string, padding an odd number of digits', () => {
    expect(asString(read('<414243>'))).toBe('ABC');
    expect(asString(read('<4142 43>'))).toBe('ABC');
    // `<41 4>` is `<4140>`, per the spec's "pad with a zero".
    expect(asString(read('<414>'))).toBe('A@');
  });

  it('reads arrays and dictionaries, and steps over what it cannot use', () => {
    expect(asNumbers(read('[1 2 3]'))).toEqual([1, 2, 3]);
    expect(asArray(read('[]'))).toEqual([]);
    const d = asDict(read('<< /A 1 /B (two) /C [3 4] >>'));
    expect(asNumber(d?.get('A'))).toBe(1);
    expect(asString(d?.get('B'))).toBe('two');
    expect(asNumbers(d?.get('C'))).toEqual([3, 4]);
    // A stray value where a key should be is skipped rather than hanging the reader.
    const odd = asDict(read('<< 5 /A 1 >>'));
    expect(asNumber(odd?.get('A'))).toBe(1);
  });

  it('skips comments and whitespace', () => {
    expect(asNumber(read('% a comment\n  7'))).toBe(7);
  });

  it('does not spin on a closer or on unterminated input', () => {
    expect(read(']')).toBeUndefined();
    expect(read('>>')).toBeUndefined();
    expect(asString(read('(unterminated'))).toBe('unterminated');
    expect(read('')).toBeUndefined();
  });

  it('walks a whole object with readWord and position', () => {
    const lexer = new PdfLexer('1 0 obj\n<< /A 1 >>\nendobj\n');
    lexer.position = '1 0 obj'.length;
    const value = asDict(lexer.readValue() ?? undefined);
    expect(asNumber(value?.get('A'))).toBe(1);
    expect(lexer.readWord()).toBe('endobj');
    expect(lexer.done).toBe(true);
  });

  it('round-trips every value it can write', () => {
    const value = dict({
      Name: pdfName('Comment'),
      Text: pdfString('a (tricky) \\ string'),
      Unicode: pdfString('Ελληνικά'),
      Count: pdfNumber(3.25),
      List: pdfNumbers([1, 2, 3]),
      Names: pdfArray([pdfName('None'), pdfName('OpenArrow')]),
      Ref: { kind: 'ref', number: 4, generation: 0 },
      Nothing: null,
    });
    const back = asDict(read(writeValue(value)));
    expect(asName(back?.get('Name'))).toBe('Comment');
    expect(asString(back?.get('Text'))).toBe('a (tricky) \\ string');
    expect(asString(back?.get('Unicode'))).toBe('Ελληνικά');
    expect(asNumber(back?.get('Count'))).toBe(3.25);
    expect(asNumbers(back?.get('List'))).toEqual([1, 2, 3]);
    expect(back?.has('Nothing')).toBe(false);
    expect(back?.get('Ref')).toEqual({ kind: 'ref', number: 4, generation: 0 });
  });

  it('writes a name that needs escaping', () => {
    expect(writeValue(pdfName('A B'))).toBe('/A#20B');
    expect(writeValue(pdfNumber(-0))).toBe('0');
  });

  it('encodes text as PDFDocEncoding when it can and UTF-16 when it cannot', () => {
    expect(decodePdfText(encodePdfText('plain'))).toBe('plain');
    // A typographic quote is in PDFDocEncoding's 0x80–0x9F block, so it stays one byte.
    expect(encodePdfText('“quoted”').length).toBe(8);
    expect(decodePdfText(encodePdfText('“quoted”'))).toBe('“quoted”');
    // Greek is not, so it takes the BOM and two bytes a character.
    expect(encodePdfText('Ελληνικά').startsWith('þÿ')).toBe(true);
    expect(decodePdfText(encodePdfText('Ελληνικά'))).toBe('Ελληνικά');
  });

  it('turns bytes into a binary string and back without loss', () => {
    const bytes = new Uint8Array([0, 1, 65, 200, 255]);
    expect(binaryToBytes(bytesToBinary(bytes))).toEqual(bytes);
  });
});

describe('the shared value conversions', () => {
  it('numbers', () => {
    expect(num('12.5')).toBe(12.5);
    expect(num(7)).toBe(7);
    expect(num('   ')).toBeNull();
    expect(num('banana')).toBeNull();
    expect(num(Number.NaN)).toBeNull();
    expect(num(null)).toBeNull();
    expect(numberList('1, 2,3')).toEqual([1, 2, 3]);
    expect(numberList('1 2 3')).toEqual([1, 2, 3]);
    // One bad entry makes the whole list empty rather than half-read.
    expect(numberList('1, banana, 3')).toEqual([]);
    expect(numberList(42)).toEqual([]);
    expect(fmt(1 / 3)).toBe('0.3333');
    expect(fmt(-0)).toBe('0');
    expect(fmt(Number.POSITIVE_INFINITY)).toBe('0');
  });

  it('rectangles and points', () => {
    expect(parseRect('10,20,0,5')).toEqual({ x0: 0, y0: 5, x1: 10, y1: 20 });
    expect(parseRect('1,2')).toBeNull();
    expect(parseRect(null)).toBeNull();
    expect(formatRect({ x0: 1, y0: 2, x1: 3, y1: 4 })).toBe('1,2,3,4');
    expect(parsePoints('1,2;3,4')).toEqual([
      { x: 1, y: 2 },
      { x: 3, y: 4 },
    ]);
    // The flat form some producers write instead.
    expect(parsePoints('1,2,3,4')).toEqual([
      { x: 1, y: 2 },
      { x: 3, y: 4 },
    ]);
    expect(parsePoints('1,2,3')).toEqual([]);
    expect(parsePoints(7)).toEqual([]);
    expect(formatPoints([{ x: 1, y: 2 }])).toBe('1,2');
    expect(flatten([{ x: 1, y: 2 }])).toEqual([1, 2]);
  });

  it('colours', () => {
    expect(parseColor('#FF8800')).toBe(0xff8800);
    expect(parseColor('f80')).toBe(0xff8800);
    expect(parseColor('#12345')).toBeNull();
    expect(parseColor(12)).toBeNull();
    expect(formatColor(0x00ff00)).toBe('#00FF00');
    expect(packColorComponents([1, 0, 0])).toBe(0xff0000);
    expect(packColorComponents([0.5])).toBe(0x808080);
    expect(packColorComponents([])).toBeNull();
    // CMYK, as a few producers write it.
    expect(packColorComponents([0, 1, 1, 0])).toBe(0xff0000);
    expect(colorComponents(0xff0000)).toEqual([1, 0, 0]);
  });

  it('dates', () => {
    expect(pdfDateToIso("D:20260901101500Z00'00'")).toBe('2026-09-01T10:15:00Z');
    expect(pdfDateToIso("D:20260902090000+01'00'")).toBe('2026-09-02T09:00:00+01:00');
    expect(pdfDateToIso('D:2026')).toBe('2026-01-01T00:00:00Z');
    expect(pdfDateToIso('not a date')).toBeNull();
    expect(pdfDateToIso('')).toBeNull();
    expect(pdfDateToIso(7)).toBeNull();
    expect(isoToPdfDate('2026-09-01T10:15:00Z')).toBe("D:20260901101500Z00'00'");
    expect(isoToPdfDate('nonsense')).toBeNull();
    expect(isoToPdfDate(null)).toBeNull();
  });

  it('flags, as words and as bits', () => {
    const flags = parseFlagWords('print,hidden');
    expect(flags).toEqual({
      hidden: true,
      print: true,
      noView: false,
      readOnly: false,
      locked: false,
    });
    expect(formatFlagWords(flags)).toBe('hidden,print');
    // An attribute that is present replaces the default set outright.
    expect(parseFlagWords('hidden').print).toBe(false);
    expect(parseFlagWords(null).print).toBe(true);
    expect(packFlagBits(flags)).toBe(2 | 4);
    expect(unpackFlagBits(2 | 4 | 32 | 64 | 128)).toEqual({
      hidden: true,
      print: true,
      noView: true,
      readOnly: true,
      locked: true,
    });
    expect(flagWordList()).toContain('nozoom');
  });
});

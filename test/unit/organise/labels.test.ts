/**
 * Page-label numbering (M40 + the engine's `/PageLabels` half).
 *
 * The property that matters most is **reversibility**: whatever `pageLabelNums` decides to write,
 * a reader has to get the original strings back. A range written as `/S /r /St 3` and rendered by
 * some other viewer must produce "iii", or the numbering the reader set is quietly wrong in every
 * application but ours. So the last test in this file re-renders every entry the function emits
 * and compares it with the labels it was given, over a few hundred generated documents.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  decodeLabel,
  fromAlpha,
  fromRoman,
  numeral,
  pageLabelNums,
  toAlpha,
  toRoman,
  type LabelStyle,
} from '@engine/pageLabels';
import {
  DEFAULT_LABEL_SPEC,
  LABEL_STYLES,
  defaultLabels,
  formatLabel,
  labelsForRange,
} from '@modules/M40-organise-pages/labels';

describe('roman numerals', () => {
  it('writes the classical forms', () => {
    const cases: Array<[number, string]> = [
      [1, 'I'],
      [4, 'IV'],
      [9, 'IX'],
      [14, 'XIV'],
      [40, 'XL'],
      [90, 'XC'],
      [400, 'CD'],
      [900, 'CM'],
      [1987, 'MCMLXXXVII'],
      [3999, 'MMMCMXCIX'],
    ];
    for (const [n, text] of cases) expect(toRoman(n)).toBe(text);
  });

  it('reads them back', () => {
    for (const n of [1, 4, 9, 14, 40, 90, 400, 900, 1987, 3999]) {
      expect(fromRoman(toRoman(n))).toBe(n);
    }
  });

  it('goes past 3999 with repeated thousands, because a PDF has no overbar', () => {
    expect(toRoman(4000)).toBe('MMMM');
    expect(fromRoman('MMMM')).toBe(4000);
  });

  it('refuses text that is not a numeral', () => {
    expect(fromRoman('ABC')).toBeNull();
    expect(fromRoman('')).toBeNull();
  });

  it('round-trips every value up to a thousand', () => {
    for (let n = 1; n <= 1000; n++) expect(fromRoman(toRoman(n))).toBe(n);
  });
});

describe('alphabetic numbering', () => {
  it('repeats the letter rather than carrying it, as the format says', () => {
    expect(toAlpha(1)).toBe('A');
    expect(toAlpha(26)).toBe('Z');
    expect(toAlpha(27)).toBe('AA');
    expect(toAlpha(52)).toBe('ZZ');
    expect(toAlpha(53)).toBe('AAA');
  });

  it('reads them back', () => {
    for (let n = 1; n <= 200; n++) expect(fromAlpha(toAlpha(n))).toBe(n);
  });

  it('refuses mixed letters, which are not a label', () => {
    expect(fromAlpha('AB')).toBeNull();
    expect(fromAlpha('A1')).toBeNull();
  });
});

describe('decodeLabel', () => {
  it('prefers decimal, because "12" is a number and never a numeral', () => {
    expect(decodeLabel('12')).toEqual({ prefix: '', style: 'decimal', value: 12 });
    expect(decodeLabel('A-12')).toEqual({ prefix: 'A-', style: 'decimal', value: 12 });
  });

  it('reads roman as roman, so "I, II, III" is a run and not three stray letters', () => {
    expect(decodeLabel('iii')).toEqual({ prefix: '', style: 'romanLower', value: 3 });
    expect(decodeLabel('III')).toEqual({ prefix: '', style: 'romanUpper', value: 3 });
  });

  it('reads a repeated letter as alphabetic', () => {
    expect(decodeLabel('c')).toEqual({ prefix: '', style: 'romanLower', value: 100 });
    expect(decodeLabel('bb')).toEqual({ prefix: '', style: 'alphaLower', value: 28 });
    expect(decodeLabel('BB')).toEqual({ prefix: '', style: 'alphaUpper', value: 28 });
  });

  it('refuses a leading zero, which no numbering style can reproduce', () => {
    expect(decodeLabel('007')).toBeNull();
  });

  it('refuses a non-canonical numeral, which would come back different', () => {
    // "IIX" is not a canonical numeral and not a repeated letter either, so it is neither.
    expect(decodeLabel('IIX')).toBeNull();
    // "IIII" is not canonical roman — but it *is* the 87th alphabetic label, and reading it as
    // one reproduces the string exactly, so that is what it means.
    expect(decodeLabel('IIII')).toEqual({ prefix: '', style: 'alphaUpper', value: 87 });
  });

  it('refuses a label that is only words', () => {
    expect(decodeLabel('Cover')).toBeNull();
    expect(decodeLabel('')).toBeNull();
  });
});

describe('formatLabel and labelsForRange', () => {
  it('puts the prefix in front of the numbering', () => {
    expect(formatLabel({ style: 'decimal', prefix: 'A-', start: 1 }, 0)).toBe('A-1');
    expect(formatLabel({ style: 'decimal', prefix: 'A-', start: 1 }, 2)).toBe('A-3');
    expect(formatLabel({ style: 'romanLower', prefix: '', start: 1 }, 2)).toBe('iii');
    expect(formatLabel({ style: 'alphaUpper', prefix: 'Appendix ', start: 1 }, 1)).toBe(
      'Appendix B',
    );
  });

  it('honours the starting value', () => {
    expect(formatLabel({ style: 'decimal', prefix: '', start: 7 }, 0)).toBe('7');
    expect(formatLabel({ style: 'romanUpper', prefix: '', start: 4 }, 1)).toBe('V');
  });

  it('writes only the prefix for the "no number" style', () => {
    expect(formatLabel({ style: 'none', prefix: 'Cover', start: 1 }, 0)).toBe('Cover');
  });

  it('renumbers a range in document order and leaves everything else alone', () => {
    const current = defaultLabels(6);
    const next = labelsForRange(current, [4, 1, 2], { style: 'romanLower', prefix: '', start: 1 });
    // Pages 2, 3 and 5 (1-based) become i, ii, iii — in document order, whatever order was asked.
    expect(next).toEqual(['1', 'i', 'ii', '4', 'iii', '6']);
  });

  it('ignores pages the document does not have', () => {
    expect(labelsForRange(defaultLabels(3), [0, 99], DEFAULT_LABEL_SPEC)).toEqual(['1', '2', '3']);
  });

  it('offers every style the format has, each named by an example', () => {
    expect(LABEL_STYLES).toHaveLength(6);
    for (const style of LABEL_STYLES) expect(style.label).toMatch(/—|prefix/u);
  });
});

describe('pageLabelNums — what the writer puts in the file', () => {
  it('collapses a plain run to one decimal range', () => {
    expect(pageLabelNums(['1', '2', '3'])).toEqual([{ index: 0, entry: { S: 'D', St: 1 } }]);
  });

  it('keeps a shared prefix on the range rather than repeating it per page', () => {
    expect(pageLabelNums(['A-1', 'A-2', 'A-3'])).toEqual([
      { index: 0, entry: { S: 'D', P: 'A-', St: 1 } },
    ]);
  });

  it('writes a roman run as /S /r rather than as one literal per page', () => {
    expect(pageLabelNums(['i', 'ii', 'iii', 'iv'])).toEqual([
      { index: 0, entry: { S: 'r', St: 1 } },
    ]);
  });

  it('writes a capital roman run as /S /R', () => {
    expect(pageLabelNums(['I', 'II', 'III'])).toEqual([{ index: 0, entry: { S: 'R', St: 1 } }]);
  });

  it('writes an alphabetic run as /S /a and /S /A', () => {
    expect(pageLabelNums(['a', 'b', 'c'])).toEqual([{ index: 0, entry: { S: 'a', St: 1 } }]);
    expect(pageLabelNums(['A', 'B', 'C'])).toEqual([{ index: 0, entry: { S: 'A', St: 1 } }]);
  });

  it('starts a new range when the style, the prefix or the count changes', () => {
    expect(pageLabelNums(['i', 'ii', '1', '2', 'A-1'])).toEqual([
      { index: 0, entry: { S: 'r', St: 1 } },
      { index: 2, entry: { S: 'D', St: 1 } },
      { index: 4, entry: { S: 'D', P: 'A-', St: 1 } },
    ]);
  });

  it('breaks a run where the numbering jumps', () => {
    expect(pageLabelNums(['1', '2', '9'])).toEqual([
      { index: 0, entry: { S: 'D', St: 1 } },
      { index: 2, entry: { S: 'D', St: 9 } },
    ]);
  });

  it('falls back to a literal for anything it cannot describe', () => {
    expect(pageLabelNums(['Cover', '007', ''])).toEqual([
      { index: 0, entry: { P: 'Cover' } },
      { index: 1, entry: { P: '007' } },
      { index: 2, entry: { P: '' } },
    ]);
  });

  it('handles a document with no pages', () => {
    expect(pageLabelNums([])).toEqual([]);
  });
});

/** Re-renders one `/Nums` entry the way a conforming reader would, to prove reversibility. */
function renderRange(entry: { S?: string; P?: string; St?: number }, offset: number): string {
  const styles: Readonly<Record<string, LabelStyle>> = {
    D: 'decimal',
    r: 'romanLower',
    R: 'romanUpper',
    a: 'alphaLower',
    A: 'alphaUpper',
  };
  const prefix = entry.P ?? '';
  if (entry.S === undefined) return prefix;
  const style = styles[entry.S] ?? 'decimal';
  return `${prefix}${numeral(style, (entry.St ?? 1) + offset)}`;
}

/** Every page's label, as a reader would render the tree `pageLabelNums` produced. */
function renderAll(labels: ReadonlyArray<string>): string[] {
  const ranges = pageLabelNums(labels);
  const out: string[] = [];
  ranges.forEach((range, i) => {
    const end = ranges[i + 1]?.index ?? labels.length;
    for (let page = range.index; page < end; page++) {
      out.push(renderRange(range.entry, page - range.index));
    }
  });
  return out;
}

describe('pageLabelNums is exactly reversible', () => {
  it('re-renders the labels it was given, for the hand-written cases', () => {
    const cases = [
      ['1', '2', '3'],
      ['i', 'ii', 'iii', '1', '2'],
      ['A-1', 'A-2', 'B-1'],
      ['Cover', 'i', 'ii', '1', '2', '3'],
      ['007', '008'],
      ['I', 'II', 'III', 'IV', 'V'],
      ['a', 'b', 'c', 'aa'],
      [''],
    ];
    for (const labels of cases) expect(renderAll(labels)).toEqual(labels);
  });

  it('re-renders any labels a reader could produce with the dialog', () => {
    const spec = fc.record({
      style: fc.constantFrom<LabelStyle>(
        'decimal',
        'romanLower',
        'romanUpper',
        'alphaLower',
        'alphaUpper',
        'none',
      ),
      prefix: fc.constantFrom('', 'A-', 'Appendix ', 'x'),
      start: fc.integer({ min: 1, max: 60 }),
    });
    fc.assert(
      fc.property(fc.array(spec, { minLength: 1, maxLength: 6 }), (specs) => {
        // Each spec numbers a run of pages, as the dialog would over a range.
        const labels: string[] = [];
        for (const one of specs) {
          for (let i = 0; i < 4; i++) labels.push(formatLabel(one, i));
        }
        expect(renderAll(labels)).toEqual(labels);
      }),
      { numRuns: 200 },
    );
  });

  it('re-renders arbitrary strings, which is what a file already in the wild carries', () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ maxLength: 8 }), { minLength: 1, maxLength: 12 }),
        (labels) => {
          expect(renderAll(labels)).toEqual(labels);
        },
      ),
      { numRuns: 300 },
    );
  });
});

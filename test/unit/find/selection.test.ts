/**
 * The selection model and the RTF writer (M13). Both are pure, so the rules a reader actually
 * feels — a drag that crosses a page, a double click that extends word by word, Alt-drag, and
 * what a word processor receives — are proved here rather than clicked at.
 */

import { describe, expect, it } from 'vitest';
import type { PageText } from '@view/TextLayer';
import {
  EMPTY_SELECTION,
  extendTo,
  isEmpty,
  ordered,
  selectAllPages,
  selectColumn,
  selectedPages,
  selectionLength,
  selectionText,
  selectPage,
  spansForPage,
  startAt,
} from '@modules/M13-select-find-print/selection/model';
import {
  baseFontName,
  buildRtf,
  escapeRtf,
  familyOf,
  selectionToRtf,
  spansToRtf,
  spansToRtfRuns,
  styleFromName,
} from '@modules/M13-select-find-print/selection/rtf';
import { moveCaret } from '@modules/M13-select-find-print/selection/TextSelectionController';
import { must, pageOf, TWO_LINES } from './helpers';

const page0 = pageOf(TWO_LINES, 0);
const page1 = pageOf([{ text: 'second page text', x: 72, y: 700 }], 1);
const lookup = (page: number): PageText | undefined =>
  page === 0 ? page0 : page === 1 ? page1 : undefined;

describe('selection model', () => {
  it('starts empty', () => {
    expect(isEmpty(EMPTY_SELECTION)).toBe(true);
    expect(selectedPages(EMPTY_SELECTION)).toEqual([]);
    expect(ordered(EMPTY_SELECTION)).toBeNull();
  });

  it('a click that goes nowhere selects nothing', () => {
    expect(isEmpty(startAt({ page: 0, offset: 5 }))).toBe(true);
  });

  it('a drag selects between the two carets, whichever way round', () => {
    const forwards = extendTo(startAt({ page: 0, offset: 4 }), { page: 0, offset: 9 });
    const backwards = extendTo(startAt({ page: 0, offset: 9 }), { page: 0, offset: 4 });
    expect(spansForPage(forwards, 0, lookup)).toEqual([{ start: 4, end: 9 }]);
    expect(spansForPage(backwards, 0, lookup)).toEqual([{ start: 4, end: 9 }]);
  });

  it('extending with no anchor starts a fresh selection', () => {
    const state = extendTo(EMPTY_SELECTION, { page: 0, offset: 3 });
    expect(state.anchor).toEqual({ page: 0, offset: 3 });
  });

  it('a word-granularity drag grows both ends to whole words', () => {
    const at = page0.text.indexOf('quick') + 1;
    const state = extendTo(startAt({ page: 0, offset: at }, 'word'), { page: 0, offset: at + 2 });
    const span = must(spansForPage(state, 0, lookup)[0], 'span');
    expect(page0.text.slice(span.start, span.end)).toBe('quick');
  });

  it('a paragraph-granularity click takes the paragraph', () => {
    const state = startAt({ page: 0, offset: 3 }, 'paragraph');
    const span = must(spansForPage(state, 0, lookup)[0], 'span');
    expect(page0.text.slice(span.start, span.end)).toBe('The quick brown fox\njumps over the dog');
  });

  it('a selection that crosses a page takes the tail of one and the head of the next', () => {
    const state = extendTo(startAt({ page: 0, offset: 4 }), { page: 1, offset: 6 });
    expect(selectedPages(state)).toEqual([0, 1]);
    expect(spansForPage(state, 0, lookup)).toEqual([{ start: 4, end: page0.text.length }]);
    expect(spansForPage(state, 1, lookup)).toEqual([{ start: 0, end: 6 }]);
    expect(selectionText(state, lookup)).toBe(`${page0.text.slice(4)}second`);
  });

  it('a page in the middle of a cross-page selection is taken whole', () => {
    const three = extendTo(startAt({ page: 0, offset: 2 }), { page: 2, offset: 1 });
    expect(spansForPage(three, 1, lookup)).toEqual([{ start: 0, end: page1.text.length }]);
  });

  it('Select All on one page, then on the document', () => {
    const one = selectPage(0, page0);
    expect(spansForPage(one, 0, lookup)).toEqual([{ start: 0, end: page0.text.length }]);
    const all = selectAllPages(0, 1, page1.text.length);
    expect(selectedPages(all)).toEqual([0, 1]);
    expect(selectionLength(all, lookup)).toBe(page0.text.length + page1.text.length);
  });

  it('a column selection is one span per line and belongs to one page', () => {
    const grid = pageOf(
      [
        { text: 'AAAA BBBB', x: 0, y: 100, advance: 10 },
        { text: 'CCCC DDDD', x: 0, y: 80, advance: 10 },
      ],
      0,
    );
    const state = selectColumn(0, { x0: -1, y0: 70, x1: 39, y1: 120 });
    expect(isEmpty(state)).toBe(false);
    expect(selectedPages(state)).toEqual([0]);
    const spans = spansForPage(state, 0, (p) => (p === 0 ? grid : undefined));
    expect(spans.map((s) => grid.text.slice(s.start, s.end))).toEqual(['AAAA', 'CCCC']);
    expect(spansForPage(state, 1, lookup)).toEqual([]);
  });

  it('a page that has not been read yet contributes nothing rather than throwing', () => {
    const state = extendTo(startAt({ page: 0, offset: 0 }), { page: 5, offset: 3 });
    expect(spansForPage(state, 5, lookup)).toEqual([]);
  });
});

describe('caret movement', () => {
  it('moves by character and steps to the next page at the end', () => {
    expect(moveCaret(page0, { page: 0, offset: 3 }, 'ArrowRight', 2)).toEqual({
      page: 0,
      offset: 4,
    });
    expect(moveCaret(page0, { page: 0, offset: page0.text.length }, 'ArrowRight', 2)).toEqual({
      page: 1,
      offset: 0,
    });
    expect(moveCaret(page0, { page: 1, offset: 0 }, 'ArrowLeft', 2)).toEqual({
      page: 0,
      offset: 0,
    });
  });

  it('moves by line, keeping the column', () => {
    const down = moveCaret(page0, { page: 0, offset: 4 }, 'ArrowDown', 1);
    expect(down?.offset).toBe((page0.lines[1]?.start ?? 0) + 4);
    expect(moveCaret(page0, { page: 0, offset: 4 }, 'ArrowUp', 1)).toBeNull();
  });

  it('Home and End go to the ends of the line', () => {
    const line = must(page0.lines[1], 'line');
    expect(moveCaret(page0, { page: 0, offset: line.start + 3 }, 'Home', 1)?.offset).toBe(
      line.start,
    );
    expect(moveCaret(page0, { page: 0, offset: line.start + 3 }, 'End', 1)?.offset).toBe(line.end);
  });

  it('ignores keys it does not own', () => {
    expect(moveCaret(page0, { page: 0, offset: 0 }, 'a', 1)).toBeNull();
  });
});

describe('RTF', () => {
  it('escapes what RTF reserves, and encodes anything above ASCII', () => {
    expect(escapeRtf('a\\b{c}d')).toBe('a\\\\b\\{c\\}d');
    expect(escapeRtf('one\ntwo')).toBe('one\\par\ntwo');
    expect(escapeRtf('é')).toBe('\\u233?');
    expect(escapeRtf('\t')).toBe('\\tab ');
  });

  it('reads a base font name out of a subset-tagged, style-suffixed one', () => {
    expect(baseFontName('ABCDEF+Helvetica-BoldOblique')).toBe('Helvetica');
    expect(baseFontName('Times-Roman')).toBe('Times');
    expect(baseFontName('')).toBe('Serif');
  });

  it('guesses the RTF family from the font name', () => {
    expect(familyOf('Courier New')).toBe('modern');
    expect(familyOf('Times New Roman')).toBe('roman');
    expect(familyOf('Helvetica')).toBe('swiss');
    expect(familyOf('Zapfino')).toBe('nil');
  });

  it('reads bold and italic out of a font name when the flags are missing', () => {
    expect(styleFromName('Arial-BoldItalic')).toEqual({ bold: true, italic: true });
    expect(styleFromName('Arial')).toEqual({ bold: false, italic: false });
  });

  it('writes a document with a font table, a colour table and the text', () => {
    const rtf = buildRtf([
      { text: 'Hello ', fontName: 'Helvetica', fontSize: 12, bold: false, italic: false, color: 0 },
      {
        text: 'world',
        fontName: 'Times',
        fontSize: 18,
        bold: true,
        italic: false,
        color: 0xff0000,
      },
    ]);
    expect(rtf.startsWith('{\\rtf1\\ansi')).toBe(true);
    expect(rtf).toContain('{\\f0\\fswiss\\fcharset0 Helvetica;}');
    expect(rtf).toContain('{\\f1\\froman\\fcharset0 Times;}');
    expect(rtf).toContain('\\red255\\green0\\blue0;');
    expect(rtf).toContain('\\f0\\fs24\\cf0 Hello');
    expect(rtf).toContain('\\fs36\\cf1\\b world');
    expect(rtf.endsWith('\\par}')).toBe(true);
  });

  it('groups characters that share their attributes into one run', () => {
    const model = pageOf([
      { text: 'plain ', x: 0, y: 0, advance: 5 },
      { text: 'bold', x: 40, y: 0, advance: 5, bold: true },
    ]);
    const runs = spansToRtfRuns(model, [{ start: 0, end: model.text.length }]);
    // The trailing line break shares the bold run's attributes, so it joins it.
    expect(runs.map((r) => [r.text, r.bold])).toEqual([
      ['plain ', false],
      ['bold\n', true],
    ]);
  });

  it('a page and a multi-page selection produce the same shape', () => {
    const one = spansToRtf(page0, [{ start: 0, end: 3 }]);
    const two = selectionToRtf([
      { pageText: page0, spans: [{ start: 0, end: 3 }] },
      { pageText: page1, spans: [{ start: 0, end: 6 }] },
    ]);
    expect(one).toContain('The');
    expect(two).toContain('The');
    expect(two).toContain('second');
  });

  it('an empty selection still produces a valid document', () => {
    expect(buildRtf([])).toBe(
      '{\\rtf1\\ansi\\ansicpg1252\\uc1\\deff0{\\fonttbl}{\\colortbl ;}\\viewkind4\\pard\\par}',
    );
  });
});

/**
 * Plain text → PDF (M91). Decoding and wrapping are pure and get their own cases; the
 * converter's output is opened with the real engine so the pages, the header and the text
 * asserted are what PDFium reads back.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PDFDocument, StandardFonts, type PDFFont } from 'pdf-lib';
import { beforeAll, describe, expect, it } from 'vitest';
import { decodeText, expandTabs, splitLines } from '@engine/create/text/decode';
import {
  convertText,
  DEFAULT_TEXT_OPTIONS,
  TextConverter,
  wrapLine,
  type TextConvertOptions,
} from '@engine/create/text/TextConverter';
import { ConvertCancelled, type ConvertInput } from '@engine/create/types';
import { mmToPt } from '@shared/pdf';
import { engine, FIXTURES } from '../engine/helpers';

const CREATE = join(FIXTURES, 'create');

function input(name: string): ConvertInput {
  return {
    name,
    bytes: new Uint8Array(readFileSync(join(CREATE, name))),
    path: join(CREATE, name),
  };
}

/** Every text run on a page, joined. */
async function pageText(bytes: Uint8Array, page: number): Promise<string> {
  const pdf = await engine();
  const doc = await pdf.open(bytes);
  try {
    const runs = await pdf.textRuns(doc, page);
    return runs.map((r) => r.text).join('');
  } finally {
    await pdf.close(doc);
  }
}

describe('decodeText', () => {
  const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

  it('decodes plain UTF-8', () => {
    expect(decodeText(utf8('café'))).toBe('café');
    expect(decodeText(new Uint8Array(0))).toBe('');
  });

  it('honours a UTF-8 BOM', () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...utf8('hi')]);
    expect(decodeText(bytes)).toBe('hi');
  });

  it('honours a UTF-16LE BOM', () => {
    const bytes = new Uint8Array([0xff, 0xfe, 0x68, 0x00, 0x69, 0x00, 0xe9, 0x00]);
    expect(decodeText(bytes)).toBe('hié');
  });

  it('honours a UTF-16BE BOM', () => {
    const bytes = new Uint8Array([0xfe, 0xff, 0x00, 0x68, 0x00, 0x69, 0x00, 0xe9]);
    expect(decodeText(bytes)).toBe('hié');
  });

  it('replaces bytes that are not UTF-8 rather than failing', () => {
    expect(decodeText(new Uint8Array([0x61, 0xff, 0x62]))).toBe('a\uFFFDb');
  });
});

describe('splitLines', () => {
  it('splits on CRLF, CR and LF', () => {
    expect(splitLines('a\r\nb\rc\nd')).toEqual(['a', 'b', 'c', 'd']);
  });

  it('drops the single empty line a final newline leaves', () => {
    expect(splitLines('a\nb\n')).toEqual(['a', 'b']);
    expect(splitLines('a\r\n')).toEqual(['a']);
    expect(splitLines('a\n\n')).toEqual(['a', '']);
    expect(splitLines('')).toEqual(['']);
    expect(splitLines('\n')).toEqual(['']);
  });
});

describe('expandTabs', () => {
  it('expands to the next multiple of the tab size', () => {
    expect(expandTabs('\ta', 4)).toBe('    a');
    expect(expandTabs('ab\tc', 4)).toBe('ab  c');
    expect(expandTabs('abcd\te', 4)).toBe('abcd    e');
    expect(expandTabs('a\tb\tc', 2)).toBe('a b c');
  });

  it('leaves lines without tabs alone and tolerates odd sizes', () => {
    expect(expandTabs('plain', 4)).toBe('plain');
    expect(expandTabs('a\tb', 0)).toBe('a b');
    expect(expandTabs('a\tb', 2.9)).toBe('a b');
  });
});

describe('wrapLine', () => {
  let font: PDFFont;
  // Courier is 600/1000 em wide: at 10 pt every glyph is 6 pt, so a width of 60 holds 10.
  const size = 10;
  const width = 60;

  beforeAll(async () => {
    const doc = await PDFDocument.create();
    font = await doc.embedFont(StandardFonts.Courier);
  });

  it('leaves a short line and an empty line as they are', () => {
    expect(wrapLine('short', font, size, width)).toEqual(['short']);
    expect(wrapLine('exactly-10', font, size, width)).toEqual(['exactly-10']);
    expect(wrapLine('', font, size, width)).toEqual(['']);
  });

  it('wraps greedily at whitespace', () => {
    expect(wrapLine('aaa bbb ccc ddd', font, size, width)).toEqual(['aaa bbb', 'ccc ddd']);
    expect(wrapLine('aaaa bbbb cc', font, size, width)).toEqual(['aaaa bbbb', 'cc']);
  });

  it('breaks a token longer than the line by character', () => {
    expect(wrapLine('abcdefghijklmnopqrstuvwxyz', font, size, width)).toEqual([
      'abcdefghij',
      'klmnopqrst',
      'uvwxyz',
    ]);
    expect(wrapLine('ab abcdefghijklmnop cd', font, size, width)).toEqual([
      'ab',
      'abcdefghij',
      'klmnop cd',
    ]);
  });

  it('drops run-on whitespace at a line end and never carries it over', () => {
    expect(wrapLine('aaaaaaaa    bbb', font, size, width)).toEqual(['aaaaaaaa', 'bbb']);
    expect(wrapLine('            ', font, size, width)).toEqual(['']);
    expect(wrapLine('aaaaaaaaaa   ', font, size, width)).toEqual(['aaaaaaaaaa']);
  });
});

describe('TextConverter', () => {
  const converter = new TextConverter();
  const ctx = { env: {} };

  it('accepts by extension or MIME type', () => {
    expect(converter.accepts({ name: 'a.TXT' })).toBe(true);
    expect(converter.accepts({ name: 'a.log' })).toBe(true);
    expect(converter.accepts({ name: 'a.json' })).toBe(true);
    expect(converter.accepts({ mime: 'text/plain' })).toBe(true);
    expect(converter.accepts({ mime: 'TEXT/CSV' })).toBe(true);
    expect(converter.accepts({ name: 'a.md' })).toBe(false);
    expect(converter.accepts({ name: 'a.png', mime: 'image/png' })).toBe(false);
    expect(converter.accepts({})).toBe(false);
  });

  it('has defaults that are a copy', () => {
    const d = converter.defaults();
    expect(d).toEqual(DEFAULT_TEXT_OPTIONS);
    expect(d).not.toBe(DEFAULT_TEXT_OPTIONS);
    expect(converter.id).toBe('text');
    expect(converter.multi).toBe(false);
  });

  it('refuses an empty list', async () => {
    await expect(converter.convert([], converter.defaults(), ctx)).rejects.toMatchObject({
      reason: 'empty',
    });
  });

  it('paginates long.txt at A4/10pt with a header on every page', async () => {
    const progress: string[] = [];
    const result = await converter.convert([input('long.txt')], converter.defaults(), {
      env: {},
      progress: (_f, message) => progress.push(message),
    });
    expect(result.pageCount).toBeGreaterThan(1);
    expect(result.title).toBe('long');
    expect(result.warnings).toEqual([]);
    expect(progress.some((m) => m.startsWith('Laying out line'))).toBe(true);
    expect(progress.some((m) => m.startsWith('Writing page'))).toBe(true);

    const pdf = await engine();
    const doc = await pdf.open(result.bytes);
    try {
      const count = await pdf.pageCount(doc);
      expect(count).toBe(result.pageCount);
      const size = await pdf.pageSize(doc, 0);
      expect(size.width).toBeCloseTo(mmToPt(210), 1);
      expect(size.height).toBeCloseTo(mmToPt(297), 1);
      const page2 = (await pdf.textRuns(doc, 1)).map((r) => r.text).join('');
      expect(page2).toContain('long.txt');
      expect(page2).toContain(`Page 2 of ${count}`);
      const page1 = (await pdf.textRuns(doc, 0)).map((r) => r.text).join('');
      expect(page1).toContain('Line 001: The quick brown fox');
      expect((await pdf.metadata(doc)).title).toBe('long');
    } finally {
      await pdf.close(doc);
    }
  });

  it('leaves the header out when asked', async () => {
    const result = await converter.convert(
      [input('long.txt')],
      { ...converter.defaults(), header: false },
      ctx,
    );
    const text = await pageText(result.bytes, 0);
    expect(text).not.toContain('Page 1 of');
    expect(text).toContain('Line 001');
  });

  it('makes fewer pages without wrapping', async () => {
    const wrapped = await converter.convert([input('long.txt')], converter.defaults(), ctx);
    const unwrapped = await converter.convert(
      [input('long.txt')],
      { ...converter.defaults(), wrap: false },
      ctx,
    );
    expect(unwrapped.pageCount).toBeLessThan(wrapped.pageCount);
    // The unbreakable token survives whole on one line when not wrapped.
    const text = await pageText(unwrapped.bytes, 0);
    expect(text).toContain(
      'abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnopqrstuvwxyz0123456789',
    );
  });

  it('replaces what the standard fonts cannot show and says so', async () => {
    const result = await converter.convert([input('unicode.txt')], converter.defaults(), ctx);
    expect(result.pageCount).toBe(1);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(
      /\d+ characters the standard fonts cannot show were replaced by "\?"/,
    );
    const text = await pageText(result.bytes, 0);
    expect(text).toContain('?');
    expect(text).toContain('caf');
    expect(text).toContain('12.50');
  });

  it('counts a single replaced character in the singular', async () => {
    const result = await convertText('one \u{1F642} here', 'x.txt', converter.defaults(), ctx);
    expect(result.warnings).toEqual([
      '1 character the standard fonts cannot show was replaced by "?"',
    ]);
  });

  it('sets in the sans and serif fonts too', async () => {
    for (const font of ['sans', 'serif'] as const) {
      const result = await converter.convert(
        [input('unicode.txt')],
        { ...converter.defaults(), font },
        ctx,
      );
      expect(result.pageCount).toBe(1);
      const text = await pageText(result.bytes, 0);
      expect(text).toContain('ASCII only');
      expect(text).toContain('Page 1 of 1');
    }
  });

  it('turns an empty input into one page', async () => {
    const result = await converter.convert(
      [{ name: 'empty.txt', bytes: new Uint8Array(0) }],
      converter.defaults(),
      ctx,
    );
    expect(result.pageCount).toBe(1);
    const pdf = await engine();
    const doc = await pdf.open(result.bytes);
    try {
      expect(await pdf.pageCount(doc)).toBe(1);
    } finally {
      await pdf.close(doc);
    }
  });

  it('takes the title from the stem unless one is given', async () => {
    const stem = await convertText('hi', 'C:\\docs\\report.final.txt', converter.defaults(), ctx);
    expect(stem.title).toBe('report.final');
    const given = await convertText(
      'hi',
      'report.txt',
      { ...converter.defaults(), title: 'My title' },
      ctx,
    );
    expect(given.title).toBe('My title');
    const pdf = await engine();
    const doc = await pdf.open(given.bytes);
    try {
      expect((await pdf.metadata(doc)).title).toBe('My title');
    } finally {
      await pdf.close(doc);
    }
  });

  it('fills in defaults for options left out', async () => {
    const partial = { font: 'sans' } as TextConvertOptions;
    const result = await converter.convert(
      [{ name: 'a.txt', bytes: new TextEncoder().encode('x') }],
      partial,
      ctx,
    );
    expect(result.pageCount).toBe(1);
  });

  it('clamps the font size and spacing and shortens a long name in the header', async () => {
    const longName = `${'n'.repeat(300)}.txt`;
    const result = await convertText(
      'a\nb',
      longName,
      { ...converter.defaults(), fontSize: Number.NaN, lineSpacing: 100 },
      ctx,
    );
    expect(result.pageCount).toBe(1);
    const text = await pageText(result.bytes, 0);
    expect(text).toContain('...');
    expect(text).not.toContain('n'.repeat(300));
  });

  it('draws no name in the header when the margins leave no room', async () => {
    const result = await convertText(
      'x',
      'name.txt',
      {
        ...converter.defaults(),
        pageSize: { kind: 'custom', widthMm: 30, heightMm: 100 },
        margins: { top: 5, right: 14, bottom: 5, left: 14 },
      },
      ctx,
    );
    const text = await pageText(result.bytes, 0);
    expect(text).not.toContain('name');
  });

  it('honours the page size, orientation and tab size', async () => {
    const result = await convertText(
      '\tx',
      'a.txt',
      {
        ...converter.defaults(),
        pageSize: { kind: 'preset', id: 'Letter' },
        orientation: 'landscape',
        tabSize: 8,
      },
      ctx,
    );
    const pdf = await engine();
    const doc = await pdf.open(result.bytes);
    try {
      const size = await pdf.pageSize(doc, 0);
      expect(size.width).toBeCloseTo(792, 1);
      expect(size.height).toBeCloseTo(612, 1);
    } finally {
      await pdf.close(doc);
    }
  });

  it('stops when cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      converter.convert([input('long.txt')], converter.defaults(), {
        env: {},
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(ConvertCancelled);
  });
});

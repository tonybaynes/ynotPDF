/**
 * Text, HTML, RTF and "export all images" (M92) — the four exports that read a document rather
 * than draw it.
 *
 * The pages here are built with M13's own `buildPageText` over hand-made `TextRun`s, so the
 * reading order under test is the reading order the find bar and the selection use. That is the
 * point of sharing the model: if this file and the find bar ever disagreed about what page 1
 * says, one of them would be wrong.
 */

import { describe, expect, it } from 'vitest';
import { buildPageText } from '@view/TextLayer';
import type { TextRun } from '@engine/PdfEngine';
import {
  DEFAULT_EMBEDDED_PATTERN,
  contentKey,
  documentToParagraphs,
  documentToText,
  encodePngRgb,
  encodeText,
  escapeHtml,
  escapeRtf,
  exportEmbeddedImages,
  exportHtml,
  exportRtf,
  exportText,
  fontStack,
  hexColour,
  readPngHeader,
  type EmbeddedImageLike,
  type ExportPage,
} from '@engine/export';

const A4 = { width: 595.28, height: 841.89 };

/**
 * One text run laid out on a baseline. `y` is the baseline in PDF space (origin bottom-left), so
 * a *smaller* y is further down the page — which is what makes reading order worth testing.
 */
function run(
  text: string,
  x: number,
  y: number,
  options: Partial<Pick<TextRun, 'fontName' | 'fontSize' | 'color' | 'bold' | 'italic'>> = {},
): TextRun {
  const size = options.fontSize ?? 12;
  const advance = size * 0.5;
  // One box per code point, which is what `TextRun.chars` is indexed by.
  const chars: Array<{ x0: number; y0: number; x1: number; y1: number }> = [];
  for (const _ of text) {
    const i = chars.length;
    chars.push({ x0: x + i * advance, y0: y, x1: x + (i + 1) * advance, y1: y + size });
  }
  return {
    text,
    rect: { x0: x, y0: y, x1: x + text.length * advance, y1: y + size },
    chars,
    origin: { x, y },
    matrix: [1, 0, 0, 1, x, y],
    fontName: options.fontName ?? 'Helvetica',
    fontSize: size,
    color: options.color ?? 0,
    objectIndex: 0,
    ...(options.bold === undefined ? {} : { bold: options.bold }),
    ...(options.italic === undefined ? {} : { italic: options.italic }),
  };
}

function page(index: number, runs: ReadonlyArray<TextRun>, label?: string): ExportPage {
  return {
    index,
    width: A4.width,
    height: A4.height,
    text: buildPageText(index, runs),
    ...(label === undefined ? {} : { label }),
  };
}

/** Two pages: a heading and two body lines that are one paragraph, then a second page. */
const PAGE_ONE = page(0, [
  run('Quarterly report', 72, 760, { fontSize: 24, fontName: 'Helvetica-Bold', bold: true }),
  run('The first line of the body text', 72, 700, { fontName: 'Times-Roman' }),
  run('runs on to a second line.', 72, 686, { fontName: 'Times-Roman' }),
]);
const PAGE_TWO = page(1, [run('Page two.', 72, 760, { fontName: 'Times-Roman' })], 'ii');
const PAGES: ExportPage[] = [PAGE_ONE, PAGE_TWO];

describe('text export', () => {
  it('writes the lines in reading order, top of the page first', () => {
    expect(documentToText([PAGE_ONE])).toBe(
      'Quarterly report\nThe first line of the body text\nruns on to a second line.',
    );
  });

  it('separates pages the way the reader asked', () => {
    const both = PAGES;
    expect(documentToText(both, { pageSeparator: 'none' })).toContain('line.\nPage two.');
    expect(documentToText(both, { pageSeparator: 'blank-line' })).toContain('line.\n\nPage two.');
    expect(documentToText(both, { pageSeparator: 'form-feed' })).toContain('line.\n\fPage two.');
    expect(documentToText(both, { pageSeparator: 'numbered' })).toContain('[Page ii]');
    expect(documentToText(both, { pageSeparator: 'rule' })).toMatch(/─+/);
  });

  it('writes UTF-8 without a mark by default and with one when asked', () => {
    const plain = encodeText('Aé', 'utf-8', false);
    expect([...plain]).toEqual([0x41, 0xc3, 0xa9]);
    expect([...encodeText('A', 'utf-8', true)].slice(0, 3)).toEqual([0xef, 0xbb, 0xbf]);
  });

  it('always gives UTF-16 a byte-order mark, in the endianness it names', () => {
    expect([...encodeText('A', 'utf-16le', false)]).toEqual([0xff, 0xfe, 0x41, 0x00]);
    expect([...encodeText('A', 'utf-16be', false)]).toEqual([0xfe, 0xff, 0x00, 0x41]);
  });

  it('honours CRLF without leaving stray carriage returns', () => {
    const result = exportText(PAGES, { documentName: 'report', lineEnding: 'crlf' });
    const text = new TextDecoder().decode(result.files[0]?.bytes);
    expect(text).toContain('Quarterly report\r\nThe first line');
    expect(/\r(?!\n)/.exec(text)).toBeNull();
  });

  it('names the file after the document and calls it text/plain', () => {
    const result = exportText(PAGES, { documentName: 'Quarterly Report' });
    expect(result.files[0]?.name).toBe('Quarterly Report.txt');
    expect(result.files[0]?.mediaType).toBe('text/plain');
    expect(result.warnings).toEqual([]);
  });

  it('says a scan has no text layer rather than writing an empty file silently', () => {
    const result = exportText([page(0, [])], { documentName: 'scan' });
    expect(result.warnings.join(' ')).toMatch(/no text layer/);
  });

  it('can drop blank lines', () => {
    const withBlank = page(0, [run('One', 72, 700), run('   ', 72, 680), run('Two', 72, 660)]);
    expect(documentToText([withBlank], { skipBlankLines: true })).toBe('One\nTwo');
    expect(documentToText([withBlank])).toBe('One\n   \nTwo');
  });
});

describe('HTML export', () => {
  it('places every line at its own coordinates in positioned mode', () => {
    const result = exportHtml(PAGES, { documentName: 'report', layout: 'positioned' });
    const html = new TextDecoder().decode(result.files[0]?.bytes);
    expect(html).toContain('<!doctype html>');
    expect(html).toContain(`width:${String(Math.round(A4.width * 100) / 100)}pt`);
    // The heading's baseline is at y = 760 with a 24 pt box, so its top is 841.89 − 784 = 57.89.
    expect(html).toContain('left:72pt;top:57.89pt');
    expect(html).toContain('Quarterly report');
    expect(html).toContain("font-family:'Helvetica', sans-serif");
  });

  it('joins a paragraph back into one flowing block, dropping the typesetter’s line breaks', () => {
    const result = exportHtml(PAGES, { documentName: 'report', layout: 'flowing' });
    const html = new TextDecoder().decode(result.files[0]?.bytes);
    expect(html).toContain('The first line of the body text runs on to a second line.');
    expect(html).not.toContain('class="line"');
  });

  it('writes one file per page when asked, each a complete document', () => {
    const result = exportHtml(PAGES, { documentName: 'report', perPage: true });
    expect(result.files.map((f) => f.name)).toEqual(['report_page1.html', 'report_page2.html']);
    for (const file of result.files) {
      expect(new TextDecoder().decode(file.bytes)).toContain('<!doctype html>');
    }
  });

  it('declares its own tokens on :root and uses var() rather than literals in the rules', () => {
    const html = new TextDecoder().decode(
      exportHtml(PAGES, { documentName: 'report' }).files[0]?.bytes,
    );
    expect(html).toContain('--page-bg:');
    expect(html).toContain('--ink:');
    expect(html).toContain('background: var(--page-bg)');
    expect(html).toContain('color: var(--ink)');
  });

  it('embeds a picture as a data URI, positioned where the PDF drew it', () => {
    const png = encodePngRgb(Uint8Array.from([255, 0, 0, 255]), 1, 1);
    const withImage: ExportPage = {
      ...PAGE_ONE,
      images: [
        {
          rect: { x0: 100, y0: 500, x1: 300, y1: 700 },
          mediaType: 'image/png',
          bytes: png,
          alt: 'A red square',
        },
      ],
    };
    const html = new TextDecoder().decode(
      exportHtml([withImage], { documentName: 'report' }).files[0]?.bytes,
    );
    expect(html).toContain('src="data:image/png;base64,');
    expect(html).toContain('alt="A red square"');
    expect(html).toContain('left:100pt;top:141.89pt;width:200pt;height:200pt');
  });

  it('leaves pictures out rather than writing a file no browser will open, and says so', () => {
    const png = encodePngRgb(new Uint8Array(64 * 64 * 4).fill(200), 64, 64);
    const withImage: ExportPage = {
      ...PAGE_ONE,
      images: [{ rect: { x0: 0, y0: 0, x1: 10, y1: 10 }, mediaType: 'image/png', bytes: png }],
    };
    const result = exportHtml([withImage], { documentName: 'report', imageBudget: 8 });
    expect(result.warnings.join(' ')).toMatch(/left out/);
    expect(new TextDecoder().decode(result.files[0]?.bytes)).not.toContain('data:image/png');
  });

  it('escapes everything that would otherwise be markup', () => {
    expect(escapeHtml('<b>&"\'</b>')).toBe('&lt;b&gt;&amp;&quot;&#39;&lt;/b&gt;');
    const injected = page(0, [run('<script>alert(1)</script>', 72, 700)]);
    const html = new TextDecoder().decode(
      exportHtml([injected], { documentName: 'x' }).files[0]?.bytes,
    );
    expect(html).not.toContain('<script>alert');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('turns a PDF content colour into a hex literal and a font name into a stack', () => {
    expect(hexColour(0x1a2b3c)).toBe('#1a2b3c');
    expect(hexColour(0)).toBe('#000000');
    expect(fontStack('ABCDEF+Courier-Bold')).toBe("'Courier', monospace");
    expect(fontStack('Times-Roman')).toBe("'Times', serif");
    expect(fontStack('')).toBe('serif');
  });

  /**
   * A font stack quoted with double quotes closes the `style="..."` attribute it sits in and
   * turns the rest of the line into stray markup. It looked fine in a reading-order test, because
   * the words were still there — they were just no longer in a positioned box.
   */
  it('never puts a double quote inside an attribute value', () => {
    for (const layout of ['positioned', 'flowing'] as const) {
      const html = new TextDecoder().decode(
        exportHtml(PAGES, { documentName: 'report', layout }).files[0]?.bytes,
      );
      const body = html.slice(html.indexOf('<body>'));
      for (const attribute of body.matchAll(/\s(?:style|alt|aria-label)="([^"]*)"/g)) {
        expect(attribute[1], attribute[0]).not.toContain('"');
      }
      // A tag name is followed by a space or the bracket; nothing may open inside a tag.
      for (const tag of body.matchAll(/<(?:div|section|p|img)[ >]([^>]*)>/g)) {
        expect(tag[1], tag[0]).not.toContain('<');
      }
    }
  });

  it('names a rotation the way a person would, not as 330 degrees the other way', () => {
    const rotated = page(0, [
      {
        ...run('Sideways', 200, 400),
        angle: Math.PI / 6,
        matrix: [0.866, 0.5, -0.5, 0.866, 200, 400],
      },
    ]);
    const html = new TextDecoder().decode(
      exportHtml([rotated], { documentName: 'r' }).files[0]?.bytes,
    );
    const match = /rotate\((-?\d+)deg\)/.exec(html);
    expect(match, 'the line is rotated').not.toBeNull();
    expect(Math.abs(Number(match?.[1] ?? 0))).toBeLessThanOrEqual(180);
  });
});

describe('RTF export', () => {
  it('writes a header, a font table and one paragraph per paragraph', () => {
    const rtf = new TextDecoder().decode(
      exportRtf(PAGES, { documentName: 'report' }).files[0]?.bytes,
    );
    expect(rtf.startsWith('{\\rtf1\\ansi')).toBe(true);
    expect(rtf).toContain('{\\fonttbl');
    expect(rtf).toContain('Quarterly report');
    expect(rtf.endsWith('}')).toBe(true);
    expect((rtf.match(/\\pard/g) ?? []).length).toBe(documentToParagraphs(PAGES, true).length);
  });

  it('keeps bold, the size and the font of each run', () => {
    const rtf = new TextDecoder().decode(
      exportRtf(PAGES, { documentName: 'report' }).files[0]?.bytes,
    );
    expect(rtf).toContain('\\fs48'); // 24 pt heading, in half-points
    expect(rtf).toContain('\\b');
    expect(rtf).toContain('Helvetica');
    expect(rtf).toContain('Times');
  });

  it('starts each page on a new one when asked, and not when not', () => {
    const withBreaks = new TextDecoder().decode(
      exportRtf(PAGES, { documentName: 'report', pageBreaks: true }).files[0]?.bytes,
    );
    const without = new TextDecoder().decode(
      exportRtf(PAGES, { documentName: 'report', pageBreaks: false }).files[0]?.bytes,
    );
    expect(withBreaks).toContain('\\page');
    expect(without).not.toContain('\\page');
  });

  it('writes the paper size in twips', () => {
    const rtf = new TextDecoder().decode(exportRtf(PAGES, { documentName: 'r' }).files[0]?.bytes);
    expect(rtf).toContain(`\\paperw${String(Math.round(A4.width * 20))}`);
    expect(rtf).toContain(`\\paperh${String(Math.round(A4.height * 20))}`);
  });

  it('escapes the four characters RTF reserves, and everything above ASCII', () => {
    expect(escapeRtf('a\\b{c}d')).toBe('a\\\\b\\{c\\}d');
    expect(escapeRtf('é')).toBe('\\u233?');
    // Outside the BMP: two signed 16-bit units.
    expect(escapeRtf('😀')).toBe('\\u-10179?\\u-8704?');
  });

  it('is pure ASCII, so any RTF reader can open it whatever it thinks the code page is', () => {
    const accented = page(0, [run('Café — naïve résumé', 72, 700)]);
    const bytes = exportRtf([accented], { documentName: 'r' }).files[0]?.bytes ?? new Uint8Array(0);
    expect([...bytes].every((b) => b < 0x80)).toBe(true);
  });

  it('joins the lines of a paragraph rather than breaking them where the typesetter did', () => {
    const paragraphs = documentToParagraphs([PAGE_ONE], false);
    const body = paragraphs.map((p) => p.runs.map((r) => r.text).join('')).join('|');
    expect(body).toContain('The first line of the body text runs on to a second line.');
  });

  it('says a scan has no text layer', () => {
    expect(exportRtf([page(0, [])], { documentName: 'scan' }).warnings.join(' ')).toMatch(
      /no text layer/,
    );
  });
});

describe('export all images', () => {
  const jpegBytes = (marker: number): Uint8Array =>
    Uint8Array.from([0xff, 0xd8, 0xff, 0xdb, marker, 0xff, 0xd9]);

  function embedded(
    over: Partial<EmbeddedImageLike> & Pick<EmbeddedImageLike, 'page' | 'index'>,
  ): EmbeddedImageLike {
    return {
      width: 64,
      height: 64,
      dpiX: 150,
      dpiY: 150,
      encoding: 'jpeg',
      data: jpegBytes(1),
      ...over,
    };
  }

  it('writes a DCT image byte for byte, with a .jpg name', () => {
    const data = jpegBytes(3);
    const result = exportEmbeddedImages([embedded({ page: 0, index: 0, data })], {
      documentName: 'doc',
      pageCount: 1,
    });
    expect(result.files).toHaveLength(1);
    expect(result.files[0]?.name).toBe('doc_p1_img1.jpg');
    expect([...(result.files[0]?.bytes ?? [])]).toEqual([...data]);
    expect(result.files[0]?.mediaType).toBe('image/jpeg');
  });

  it('encodes a decoded image as PNG at the resolution it was drawn at', () => {
    const rgba = new Uint8Array(20 * 20 * 4).fill(120);
    const result = exportEmbeddedImages(
      [
        embedded({
          page: 2,
          index: 0,
          encoding: 'rgba',
          data: rgba,
          width: 20,
          height: 20,
          dpiX: 300,
          dpiY: 300,
        }),
      ],
      { documentName: 'doc', pageCount: 4 },
    );
    expect(result.files[0]?.name).toBe('doc_p3_img1.png');
    const header = readPngHeader(result.files[0]?.bytes ?? new Uint8Array(0));
    expect([header.width, header.height]).toEqual([20, 20]);
    expect(header.pixelsPerMetreX).toBe(11811); // 300 dpi
  });

  it('calls a JPEG 2000 stream .jp2 and leaves it alone', () => {
    const data = Uint8Array.from([0x00, 0x00, 0x00, 0x0c, 0x6a, 0x50]);
    const result = exportEmbeddedImages([embedded({ page: 0, index: 0, encoding: 'jp2', data })], {
      documentName: 'doc',
      pageCount: 1,
    });
    expect(result.files[0]?.name).toBe('doc_p1_img1.jp2');
    expect([...(result.files[0]?.bytes ?? [])]).toEqual([...data]);
  });

  it('writes one file for a logo that is drawn on every page, and says how many it merged', () => {
    const logo = jpegBytes(9);
    const images = [0, 1, 2, 3].map((p) => embedded({ page: p, index: 0, data: logo }));
    const result = exportEmbeddedImages(images, { documentName: 'doc', pageCount: 4 });
    expect(result.files).toHaveLength(1);
    expect(result.warnings.join(' ')).toMatch(/3 pictures were the same image/);
  });

  it('keeps every placement when the reader asks for duplicates', () => {
    const logo = jpegBytes(9);
    const images = [0, 1].map((p) => embedded({ page: p, index: 0, data: logo }));
    const result = exportEmbeddedImages(images, {
      documentName: 'doc',
      pageCount: 2,
      keepDuplicates: true,
    });
    expect(result.files.map((f) => f.name)).toEqual(['doc_p1_img1.jpg', 'doc_p2_img1.jpg']);
  });

  it('leaves out the spacer pixels and rules that are not pictures', () => {
    const result = exportEmbeddedImages(
      [
        embedded({ page: 0, index: 0, width: 1, height: 1, data: jpegBytes(2) }),
        embedded({ page: 0, index: 1, data: jpegBytes(4) }),
      ],
      { documentName: 'doc', pageCount: 1 },
    );
    expect(result.files).toHaveLength(1);
    expect(result.warnings.join(' ')).toMatch(/1 picture was smaller than 16 pixels/);
  });

  it('numbers pictures within their page, not across the document', () => {
    const result = exportEmbeddedImages(
      [
        embedded({ page: 0, index: 0, data: jpegBytes(1) }),
        embedded({ page: 0, index: 1, data: jpegBytes(2) }),
        embedded({ page: 3, index: 0, data: jpegBytes(3) }),
      ],
      { documentName: 'doc', pageCount: 4 },
    );
    expect(result.files.map((f) => f.name)).toEqual([
      'doc_p1_img1.jpg',
      'doc_p1_img2.jpg',
      'doc_p4_img1.jpg',
    ]);
    expect(DEFAULT_EMBEDDED_PATTERN).toBe('{name}_p{page}_img{index}');
  });

  it('says plainly when there is nothing to export', () => {
    const result = exportEmbeddedImages([], { documentName: 'doc', pageCount: 1 });
    expect(result.files).toEqual([]);
    expect(result.warnings).toEqual(['This document has no images in it.']);
  });

  it('tells two different pictures of the same length apart', () => {
    expect(contentKey(jpegBytes(1))).not.toBe(contentKey(jpegBytes(2)));
    expect(contentKey(jpegBytes(1))).toBe(contentKey(jpegBytes(1)));
  });
});

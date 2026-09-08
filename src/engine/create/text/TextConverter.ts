/**
 * Plain text → PDF (M91). Set in one of the standard fonts, wrapped on measured widths,
 * paginated, with an optional header carrying the file name and the page number.
 *
 * The standard fonts speak WinAnsi and nothing else, so a character outside it becomes `?` and
 * is counted. Embedding a Unicode font waits for M51, which brings fontkit.
 */

import { PDFDocument, StandardFonts, type PDFFont, type PDFPage } from 'pdf-lib';
import type { MarginsMm, Orientation, PageSizeChoice } from '@shared/create';
import { marginsToPoints, resolvePageSize, type SizePt } from '@shared/pageSizes';
import {
  checkCancelled,
  ConvertUnsupported,
  extensionOf,
  stemOf,
  type ConvertContext,
  type ConvertInput,
  type ConvertResult,
  type Converter,
  type RoutingInput,
} from '../types';
import { decodeText, expandTabs, splitLines } from './decode';

export type TextFontChoice = 'mono' | 'sans' | 'serif';

export interface TextConvertOptions {
  readonly font: TextFontChoice;
  /** Points. */
  readonly fontSize: number;
  /** Multiple of the font size. */
  readonly lineSpacing: number;
  readonly pageSize: PageSizeChoice;
  readonly orientation: Orientation;
  readonly margins: MarginsMm;
  /** File name and page number at the top of every page. */
  readonly header: boolean;
  /** Wrap long lines; when off they run past the right margin and are clipped. */
  readonly wrap: boolean;
  readonly tabSize: number;
  readonly title?: string;
}

export const DEFAULT_TEXT_OPTIONS: TextConvertOptions = {
  font: 'mono',
  fontSize: 10,
  lineSpacing: 1.25,
  pageSize: { kind: 'preset', id: 'A4' },
  orientation: 'portrait',
  margins: { top: 20, right: 20, bottom: 20, left: 20 },
  header: true,
  wrap: true,
  tabSize: 4,
};

export const TEXT_EXTENSIONS: ReadonlyArray<string> = [
  'txt',
  'text',
  'log',
  'csv',
  'ini',
  'cfg',
  'json',
  'xml',
  'yml',
  'yaml',
];
export const TEXT_MIMES: ReadonlyArray<string> = ['text/plain', 'text/csv', 'application/json'];

const FONT_NAMES: Readonly<Record<TextFontChoice, StandardFonts>> = {
  mono: StandardFonts.Courier,
  sans: StandardFonts.Helvetica,
  serif: StandardFonts.TimesRoman,
};

export class TextConverter implements Converter<TextConvertOptions> {
  readonly id = 'text';
  readonly label = 'Plain text';
  readonly extensions = TEXT_EXTENSIONS;
  readonly mimes = TEXT_MIMES;
  readonly multi = false;

  accepts(input: RoutingInput): boolean {
    const mime = input.mime?.toLowerCase();
    if (mime && this.mimes.includes(mime)) return true;
    return this.extensions.includes(extensionOf(input.name));
  }

  defaults(): TextConvertOptions {
    return { ...DEFAULT_TEXT_OPTIONS };
  }

  async convert(
    inputs: ReadonlyArray<ConvertInput>,
    options: TextConvertOptions,
    ctx: ConvertContext,
  ): Promise<ConvertResult> {
    const input = inputs[0];
    if (!input) throw new ConvertUnsupported('empty', 'No text was given');
    const settings: TextConvertOptions = { ...DEFAULT_TEXT_OPTIONS, ...options };
    const text = decodeText(input.bytes);
    return convertText(text, input.name, settings, ctx);
  }
}

/** The whole conversion over a string, so the clipboard path and the file path share it. */
export async function convertText(
  text: string,
  name: string,
  options: TextConvertOptions,
  ctx: ConvertContext,
): Promise<ConvertResult> {
  const warnings: string[] = [];
  const doc = await PDFDocument.create({ updateMetadata: false });
  const font = await doc.embedFont(FONT_NAMES[options.font]);
  const headerFont = options.font === 'sans' ? font : await doc.embedFont(StandardFonts.Helvetica);
  const size = clamp(options.fontSize, 4, 72);
  const lineHeight = size * clamp(options.lineSpacing, 0.8, 3);
  const page = resolvePageSize(options.pageSize, options.orientation);
  const m = marginsToPoints(options.margins, page);
  const contentWidth = Math.max(10, page.width - m.left - m.right);
  const headerHeight = options.header ? size * 1.4 + 4 : 0;
  const contentHeight = Math.max(lineHeight, page.height - m.top - m.bottom - headerHeight);
  const linesPerPage = Math.max(1, Math.floor(contentHeight / lineHeight));

  const encodable = new Set(font.getCharacterSet());
  let replaced = 0;
  const clean = (line: string): string => {
    let out = '';
    for (const ch of line) {
      const code = ch.codePointAt(0) ?? 0;
      if (code < 32) continue;
      if (encodable.has(code)) out += ch;
      else {
        out += '?';
        replaced++;
      }
    }
    return out;
  };

  const lines: string[] = [];
  const source = splitLines(text);
  for (const [i, raw] of source.entries()) {
    if (i % 500 === 0) {
      checkCancelled(ctx.signal);
      ctx.progress?.(
        (i / Math.max(1, source.length)) * 0.6,
        `Laying out line ${i + 1} of ${source.length}`,
      );
    }
    const line = clean(expandTabs(raw, options.tabSize));
    if (options.wrap) lines.push(...wrapLine(line, font, size, contentWidth));
    else lines.push(line);
  }
  if (lines.length === 0) lines.push('');
  if (replaced > 0) {
    warnings.push(
      `${replaced} character${replaced === 1 ? '' : 's'} the standard fonts cannot show ${replaced === 1 ? 'was' : 'were'} replaced by "?"`,
    );
  }

  const total = Math.ceil(lines.length / linesPerPage);
  const title = options.title ?? stemOf(name);
  for (let p = 0; p < total; p++) {
    checkCancelled(ctx.signal);
    ctx.progress?.(0.6 + (p / total) * 0.4, `Writing page ${p + 1} of ${total}`);
    const pdfPage = doc.addPage([page.width, page.height]);
    let y = page.height - m.top;
    if (options.header) {
      drawHeader(pdfPage, headerFont, size, name, p + 1, total, m, page, y);
      y -= headerHeight;
    }
    y -= size; // the baseline of the first line sits one font size below the top
    const start = p * linesPerPage;
    const slice = lines.slice(start, start + linesPerPage);
    for (const line of slice) {
      if (line !== '') {
        pdfPage.drawText(line, { x: m.left, y, size, font });
      }
      y -= lineHeight;
    }
  }
  doc.setTitle(title);
  doc.setProducer('ynotPDF');
  doc.setCreator('ynotPDF');
  const bytes = await doc.save({ addDefaultPage: false, updateFieldAppearances: false });
  return { bytes, pageCount: total, title, warnings };
}

function drawHeader(
  page: PDFPage,
  font: PDFFont,
  size: number,
  name: string,
  number: number,
  total: number,
  m: MarginsMm,
  pageSize: SizePt,
  top: number,
): void {
  const headerSize = Math.max(6, size * 0.9);
  const y = top - headerSize;
  const label = `Page ${number} of ${total}`;
  const labelWidth = font.widthOfTextAtSize(label, headerSize);
  const available = pageSize.width - m.left - m.right - labelWidth - 12;
  const shownName = fitText(name.replace(/^.*[\\/]/, ''), font, headerSize, available);
  page.drawText(shownName, { x: m.left, y, size: headerSize, font });
  page.drawText(label, { x: pageSize.width - m.right - labelWidth, y, size: headerSize, font });
  page.drawLine({
    start: { x: m.left, y: y - 3 },
    end: { x: pageSize.width - m.right, y: y - 3 },
    thickness: 0.5,
  });
}

/** Shortens a string with an ellipsis until it fits. */
function fitText(text: string, font: PDFFont, size: number, width: number): string {
  if (width <= 0) return '';
  const set = new Set(font.getCharacterSet());
  const safe = Array.from(text)
    .filter((ch) => set.has(ch.codePointAt(0) ?? 0))
    .join('');
  if (font.widthOfTextAtSize(safe, size) <= width) return safe;
  let cut = safe;
  while (cut.length > 0 && font.widthOfTextAtSize(`${cut}...`, size) > width)
    cut = cut.slice(0, -1);
  return cut.length === 0 ? '' : `${cut}...`;
}

/** Greedy word wrap on measured widths; a word longer than a line is broken by character. */
export function wrapLine(line: string, font: PDFFont, size: number, width: number): string[] {
  if (line === '') return [''];
  const measure = (s: string): number => font.widthOfTextAtSize(s, size);
  if (measure(line) <= width) return [line];
  const out: string[] = [];
  let current = '';
  const words = line.split(/(\s+)/);
  for (const word of words) {
    if (word === '') continue;
    const candidate = current + word;
    if (measure(candidate) <= width) {
      current = candidate;
      continue;
    }
    if (/^\s+$/.test(word)) {
      // Whitespace that does not fit ends the line; it is not carried over.
      if (current !== '') out.push(current);
      current = '';
      continue;
    }
    // The line so far is finished; the word starts the next one, whole or broken.
    if (current !== '') out.push(current.replace(/\s+$/, ''));
    if (measure(word) <= width) {
      current = word;
      continue;
    }
    // Break the long word by character; the last piece starts the next line.
    const pieces = breakWord(word, measure, width);
    out.push(...pieces.slice(0, -1));
    current = pieces[pieces.length - 1] ?? '';
  }
  if (current !== '') out.push(current.replace(/\s+$/, ''));
  return out.length === 0 ? [''] : out;
}

/** Splits a word that is wider than a line into pieces that each fit. */
function breakWord(word: string, measure: (s: string) => number, width: number): string[] {
  const pieces: string[] = [];
  let piece = '';
  for (const ch of word) {
    if (measure(piece + ch) > width && piece !== '') {
      pieces.push(piece);
      piece = '';
    }
    piece += ch;
  }
  pieces.push(piece);
  return pieces;
}

function clamp(n: number, min: number, max: number): number {
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : min;
}

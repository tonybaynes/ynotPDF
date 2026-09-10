/**
 * RTF export (M92) — the whole document, as paragraphs.
 *
 * M13 already has an RTF writer and this is deliberately not it. M13's writes a clipboard
 * *fragment*: a flat stream of styled characters, which is exactly what "Copy with formatting"
 * is. A document needs more — real paragraphs with `\pard`, page breaks, a page size, a default
 * font and a generator line — and the two would fight if one file tried to be both. The escaping
 * is the same thirty lines in both; the alternative was `src/engine/` importing a module's file,
 * which is worse than the repetition.
 *
 * What survives: font family and name, size, bold, italic, colour, paragraph breaks and page
 * breaks. What does not: kerning, character spacing, columns and anything the PDF expresses as
 * geometry rather than as style — the same trade every "PDF to RTF" makes, because a word
 * processor has nowhere to receive the rest. (Layout-faithful PDF → Word is Parked in PLAN.md §1.)
 */

import { checkCancelled, type ExportContext, type ExportResult } from './types';
import { styleAt, type ExportPage, type PageTextLike } from './textModel';

/** A stretch of text with one set of attributes. */
export interface RtfRun {
  readonly text: string;
  /** PDF base font name, subset prefix already removed. */
  readonly fontName: string;
  readonly fontSize: number;
  readonly bold: boolean;
  readonly italic: boolean;
  /** 0xRRGGBB. */
  readonly color: number;
}

/** RTF font families, chosen from the font name the way a reader would. */
export type RtfFamily = 'roman' | 'swiss' | 'modern' | 'script' | 'nil';

export interface RtfExportOptions {
  readonly documentName: string;
  /** Page size in points, for `\paperw` / `\paperh`; the first page's when absent. */
  readonly paperWidth?: number;
  readonly paperHeight?: number;
  /** Start each PDF page on a new RTF page. */
  readonly pageBreaks?: boolean;
  /** Keep the PDF's text colours; off writes everything as automatic (black). */
  readonly keepColours?: boolean;
  /** Keep font sizes; off writes everything at `defaultSize`. */
  readonly keepSizes?: boolean;
  readonly defaultSize?: number;
}

const SUBSET_PREFIX = /^[A-Z]{6}\+/;
const STYLE_SUFFIX =
  /[-,]?\s*(bold|italic|oblique|black|heavy|semibold|demibold|medium|light|regular|roman|book|MT|PS|BoldItalic|BoldOblique)+$/i;

/** `"ABCDEF+Helvetica-BoldOblique"` → `"Helvetica"`. */
export function baseFontName(name: string): string {
  let out = name.replace(SUBSET_PREFIX, '');
  for (let i = 0; i < 4; i++) {
    const next = out.replace(STYLE_SUFFIX, '').trim();
    if (next === out || next.length === 0) break;
    out = next;
  }
  return out.replace(/[-,]$/u, '').trim() || 'Serif';
}

/** The RTF family a font name implies. */
export function familyOf(name: string): RtfFamily {
  const n = name.toLowerCase();
  if (/courier|mono|consol/u.test(n)) return 'modern';
  if (/times|serif|georgia|garamond|book|minion|roman/u.test(n)) return 'roman';
  if (/script|cursive|brush|hand/u.test(n)) return 'script';
  if (/helvetica|arial|sans|verdana|tahoma|calibri|segoe|futura|gill/u.test(n)) return 'swiss';
  return 'nil';
}

/** Whether the font's *name* claims bold / italic, for files whose flags are missing. */
export function styleFromName(name: string): { bold: boolean; italic: boolean } {
  const n = name.toLowerCase();
  return {
    bold: /bold|black|heavy|semib|demib/u.test(n),
    italic: /italic|oblique/u.test(n),
  };
}

function escapeChar(ch: string): string {
  switch (ch) {
    case '\\':
      return '\\\\';
    case '{':
      return '\\{';
    case '}':
      return '\\}';
    case '\r':
      return '';
    case '\t':
      return '\\tab ';
    default:
      break;
  }
  const code = ch.codePointAt(0) ?? 0;
  if (code < 0x80) return ch;
  // `\uN?` takes a *signed* 16-bit unit, and anything outside the BMP is two of them.
  let out = '';
  for (let i = 0; i < ch.length; i++) {
    const unit = ch.charCodeAt(i);
    out += `\\u${String(unit > 0x7fff ? unit - 0x10000 : unit)}?`;
  }
  return out;
}

/** Escapes text for an RTF body. Newlines are *not* escaped here — paragraphs decide those. */
export function escapeRtf(text: string): string {
  let out = '';
  for (const ch of text) out += escapeChar(ch);
  return out;
}

/** One paragraph: its runs, and whether a page break comes before it. */
export interface RtfParagraph {
  readonly runs: ReadonlyArray<RtfRun>;
  readonly pageBreakBefore?: boolean;
}

/**
 * Groups a span of a page's text into runs, one per unbroken stretch of identical attributes.
 *
 * Line separators inside a paragraph become spaces: a PDF line break is where the *typesetter*
 * ran out of measure, not where the author ended a thought, so keeping it would give a word
 * processor a document it could never reflow. Paragraph boundaries are M13's grouping, and those
 * are kept.
 */
export function spanToRuns(page: PageTextLike, start: number, end: number): RtfRun[] {
  const out: RtfRun[] = [];
  for (let i = start; i < Math.min(end, page.text.length); i++) {
    const raw = page.text[i];
    if (raw === undefined) continue;
    const ch = raw === '\n' ? ' ' : raw;
    const style = styleAt(page, i);
    const rawName = style.fontName || 'Serif';
    const named = styleFromName(rawName);
    const run: RtfRun = {
      text: ch,
      fontName: baseFontName(rawName),
      fontSize: style.fontSize,
      bold: style.bold || named.bold,
      italic: style.italic || named.italic,
      color: style.color,
    };
    const last = out[out.length - 1];
    if (
      last?.fontName === run.fontName &&
      last.fontSize === run.fontSize &&
      last.bold === run.bold &&
      last.italic === run.italic &&
      last.color === run.color
    ) {
      out[out.length - 1] = { ...last, text: last.text + ch };
    } else {
      out.push(run);
    }
  }
  // A run that is only the spaces a line break became carries no information.
  return out.filter((run) => run.text.trim() !== '' || out.length === 1);
}

/** The paragraphs of a document, in reading order, with the page breaks marked. */
export function documentToParagraphs(
  pages: ReadonlyArray<ExportPage>,
  pageBreaks: boolean,
): RtfParagraph[] {
  const out: RtfParagraph[] = [];
  for (const [pageIndex, page] of pages.entries()) {
    let first = true;
    const paragraphs =
      page.text.paragraphs.length > 0
        ? page.text.paragraphs
        : page.text.lines.map((line) => ({
            start: line.start,
            end: line.end,
            rect: line.rect,
            lines: [],
          }));
    for (const paragraph of paragraphs) {
      const runs = spanToRuns(page.text, paragraph.start, paragraph.end);
      if (runs.length === 0) continue;
      out.push({
        runs,
        ...(pageBreaks && pageIndex > 0 && first ? { pageBreakBefore: true } : {}),
      });
      first = false;
    }
  }
  return out;
}

/** Builds a complete RTF document. */
export function buildRtfDocument(
  paragraphs: ReadonlyArray<RtfParagraph>,
  options: RtfExportOptions,
): string {
  const fonts: string[] = [];
  const colors: number[] = [];
  const fontIndex = (name: string): number => {
    const at = fonts.indexOf(name);
    if (at >= 0) return at;
    fonts.push(name);
    return fonts.length - 1;
  };
  const colorIndex = (rgb: number): number => {
    if (rgb === 0) return 0; // 0 is "auto", which is what black should be
    const at = colors.indexOf(rgb);
    if (at >= 0) return at + 1;
    colors.push(rgb);
    return colors.length;
  };
  const defaultSize = Math.max(2, Math.round((options.defaultSize ?? 11) * 2));

  let body = '';
  for (const paragraph of paragraphs) {
    body += '\\pard';
    if (paragraph.pageBreakBefore === true) body += '\\page';
    body += '\\sa120';
    let currentFont = -1;
    let currentSize = -1;
    let currentColor = -1;
    let bold = false;
    let italic = false;
    for (const run of paragraph.runs) {
      if (run.text.length === 0) continue;
      const f = fontIndex(run.fontName);
      const size =
        options.keepSizes === false ? defaultSize : Math.max(2, Math.round(run.fontSize * 2));
      const c = options.keepColours === false ? 0 : colorIndex(run.color & 0xffffff);
      if (f !== currentFont) {
        body += `\\f${String(f)}`;
        currentFont = f;
      }
      if (size !== currentSize) {
        body += `\\fs${String(size)}`;
        currentSize = size;
      }
      if (c !== currentColor) {
        body += `\\cf${String(c)}`;
        currentColor = c;
      }
      if (run.bold !== bold) {
        body += run.bold ? '\\b' : '\\b0';
        bold = run.bold;
      }
      if (run.italic !== italic) {
        body += run.italic ? '\\i' : '\\i0';
        italic = run.italic;
      }
      body += ` ${escapeRtf(run.text)}`;
    }
    body += '\\par\n';
  }
  if (fonts.length === 0) fonts.push('Serif');

  const fontTable = fonts
    .map((name, i) => `{\\f${String(i)}\\f${familyOf(name)}\\fcharset0 ${escapeRtf(name)};}`)
    .join('');
  const colorTable = `{\\colortbl ;${colors
    .map(
      (rgb) =>
        `\\red${String((rgb >> 16) & 0xff)}\\green${String((rgb >> 8) & 0xff)}\\blue${String(rgb & 0xff)};`,
    )
    .join('')}}`;
  // Twips: 20 to the point. A word processor uses these to choose the paper.
  const paper =
    options.paperWidth !== undefined && options.paperHeight !== undefined
      ? `\\paperw${String(Math.round(options.paperWidth * 20))}\\paperh${String(Math.round(options.paperHeight * 20))}`
      : '';
  const info = `{\\info{\\title ${escapeRtf(options.documentName)}}{\\doccomm Exported by ynotPDF}}`;
  return `{\\rtf1\\ansi\\ansicpg1252\\uc1\\deff0{\\fonttbl${fontTable}}${colorTable}${info}${paper}\\viewkind4\\fs${String(defaultSize)}\n${body}}`;
}

/** The document as one RTF file. */
export function exportRtf(
  pages: ReadonlyArray<ExportPage>,
  options: RtfExportOptions,
  ctx: ExportContext = {},
): ExportResult {
  checkCancelled(ctx.signal);
  ctx.progress?.(0.2, 'Reading the text');
  const paragraphs = documentToParagraphs(pages, options.pageBreaks !== false);
  checkCancelled(ctx.signal);
  ctx.progress?.(0.7, 'Writing the file');
  const first = pages[0];
  const rtf = buildRtfDocument(paragraphs, {
    ...options,
    ...(options.paperWidth === undefined && first ? { paperWidth: first.width } : {}),
    ...(options.paperHeight === undefined && first ? { paperHeight: first.height } : {}),
  });
  ctx.progress?.(1, 'Done');
  return {
    files: [
      {
        name: `${options.documentName}.rtf`,
        // RTF is ASCII by construction: everything above 0x7f is a `\uN?` escape.
        bytes: new TextEncoder().encode(rtf),
        mediaType: 'application/rtf',
        pages: pages.map((p) => p.index),
      },
    ],
    warnings:
      paragraphs.length === 0
        ? [
            'This document has no text layer — it is probably a scan. Run OCR over it first and the text will be there to export.',
          ]
        : [],
  };
}

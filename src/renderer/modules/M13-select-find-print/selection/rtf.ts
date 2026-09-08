/**
 * Rich Text Format writer (M13). Built in-house — the brief adds no libraries — and small
 * enough to be: RTF is a header, a font table, a colour table and a stream of escaped text with
 * formatting control words in front of it.
 *
 * What survives a copy: the font (family and name), the size, bold and italic, the fill colour
 * and the line breaks. What does not: kerning, character spacing and anything the PDF expresses
 * as geometry rather than as style. That is the same trade Foxit's "Copy with formatting" makes,
 * because a word processor has no way to receive the rest.
 *
 * Everything here is pure, so `test/unit/find/rtf.test.ts` proves the output byte for byte and
 * the operator's WordPad check only has to confirm it opens.
 */

import type { PageText, Span } from '@view/TextLayer';

/** A stretch of text with one set of attributes. */
export interface RtfRun {
  readonly text: string;
  /** PDF base font name, subset prefix already removed. */
  readonly fontName: string;
  /** Points. */
  readonly fontSize: number;
  readonly bold: boolean;
  readonly italic: boolean;
  /** 0xRRGGBB. */
  readonly color: number;
}

/** RTF font families, chosen from the font name the way a reader would. */
export type RtfFamily = 'roman' | 'swiss' | 'modern' | 'script' | 'nil';

const SUBSET_PREFIX = /^[A-Z]{6}\+/;
const STYLE_SUFFIX =
  /[-,]?\s*(bold|italic|oblique|black|heavy|semibold|demibold|medium|light|regular|roman|book|MT|PS|BoldItalic|BoldOblique)+$/i;

/** `"ABCDEF+Helvetica-BoldOblique"` → `"Helvetica"`. */
export function baseFontName(name: string): string {
  let out = name.replace(SUBSET_PREFIX, '');
  // Strip repeated style words: "Helvetica-BoldOblique" loses both, one pass at a time.
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

/** Escapes one character for the RTF body. */
function escapeChar(ch: string): string {
  switch (ch) {
    case '\\':
      return '\\\\';
    case '{':
      return '\\{';
    case '}':
      return '\\}';
    case '\n':
      return '\\par\n';
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
    out += `\\u${unit > 0x7fff ? unit - 0x10000 : unit}?`;
  }
  return out;
}

export function escapeRtf(text: string): string {
  let out = '';
  for (const ch of text) out += escapeChar(ch);
  return out;
}

/** Builds a complete RTF document from styled runs. */
export function buildRtf(runs: ReadonlyArray<RtfRun>): string {
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

  let body = '';
  let currentFont = -1;
  let currentSize = -1;
  let currentColor = -1;
  let bold = false;
  let italic = false;

  for (const run of runs) {
    if (run.text.length === 0) continue;
    const f = fontIndex(run.fontName);
    const size = Math.max(2, Math.round(run.fontSize * 2));
    const c = colorIndex(run.color & 0xffffff);
    if (f !== currentFont) {
      body += `\\f${f}`;
      currentFont = f;
    }
    if (size !== currentSize) {
      body += `\\fs${size}`;
      currentSize = size;
    }
    if (c !== currentColor) {
      body += `\\cf${c}`;
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

  const fontTable = fonts
    .map((name, i) => `{\\f${i}\\f${familyOf(name)}\\fcharset0 ${escapeRtf(name)};}`)
    .join('');
  const colorTable = `{\\colortbl ;${colors
    .map((rgb) => `\\red${(rgb >> 16) & 0xff}\\green${(rgb >> 8) & 0xff}\\blue${rgb & 0xff};`)
    .join('')}}`;
  return `{\\rtf1\\ansi\\ansicpg1252\\uc1\\deff0{\\fonttbl${fontTable}}${colorTable}\\viewkind4\\pard${body}\\par}`;
}

/**
 * Turns a page's selected spans into styled runs. Characters are grouped while their attributes
 * are unchanged, so a paragraph in one font is one run rather than one per glyph.
 */
export function spansToRtfRuns(pageText: PageText, spans: ReadonlyArray<Span>): RtfRun[] {
  const out: RtfRun[] = [];
  for (const span of spans) {
    const start = Math.max(0, Math.min(span.start, span.end));
    const end = Math.min(pageText.text.length, Math.max(span.start, span.end));
    for (let i = start; i < end; i++) {
      const box = pageText.chars[i];
      const ch = pageText.text[i];
      if (!box || ch === undefined) continue;
      const source = pageText.runs[box.run];
      const rawName = source?.fontName ?? 'Serif';
      const name = baseFontName(rawName);
      const named = styleFromName(rawName);
      const style: RtfRun = {
        text: ch,
        fontName: name,
        fontSize: source?.fontSize ?? 11,
        bold: source?.bold ?? named.bold,
        italic: source?.italic ?? named.italic,
        color: source?.color ?? 0,
      };
      const last = out[out.length - 1];
      if (
        last?.fontName === style.fontName &&
        last.fontSize === style.fontSize &&
        last.bold === style.bold &&
        last.italic === style.italic &&
        last.color === style.color
      ) {
        out[out.length - 1] = { ...last, text: last.text + ch };
      } else {
        out.push(style);
      }
    }
  }
  return out;
}

/** The RTF for a page's selected spans. */
export function spansToRtf(pageText: PageText, spans: ReadonlyArray<Span>): string {
  return buildRtf(spansToRtfRuns(pageText, spans));
}

/** The RTF for a selection that runs over several pages. */
export function selectionToRtf(
  parts: ReadonlyArray<{ readonly pageText: PageText; readonly spans: ReadonlyArray<Span> }>,
): string {
  const runs: RtfRun[] = [];
  for (const part of parts) runs.push(...spansToRtfRuns(part.pageText, part.spans));
  return buildRtf(runs);
}

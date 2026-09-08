/**
 * Free-text style: `/DA`, `/DS` and the appearance stream for typewriter, text box and callout
 * (M30).
 *
 * The `/DA` string is the PDF's own idea of "how this text is drawn" — a colour operator and a
 * `Tf` — and `/DS` is the same thing again as a CSS declaration list, which is what a viewer with
 * rich text reads. Two strings that must agree, plus a properties panel and an inline editor that
 * both have to read them back: so one module builds and parses both, and everything else asks it.
 *
 * Pure. No DOM, no PDF library — the geometry and the strings, nothing else.
 */

import type { PdfPoint, PdfRect } from '@shared/pdf';
import { ContentBuilder, num, rgbComponents } from './content';
import { textWidth, wrapText } from './metrics';
import {
  metricFont,
  normaliseRect,
  type AppearanceFont,
  type AppearanceGenerator,
  type AppearanceInput,
  type AppearanceStream,
  type StandardFontName,
} from './types';

// ---- the font table ----------------------------------------------------------------------------

/** One family the picker offers, and how it reaches the file. */
export interface FreeTextFamily {
  /** What the reader sees, and what goes into `/DS`. */
  readonly name: string;
  /** The `/DA` resource name Acrobat and Foxit use for it, when it is a standard face. */
  readonly daName: string;
  /** The standard face whose widths lay this family out. */
  readonly metrics: StandardFontName;
  /** Set when the family is one of the standard 14, so the stream can embed nothing at all. */
  readonly standard: StandardFontName | null;
}

/**
 * The families that need no substitution anywhere: the base 14, under the names a reader knows
 * them by. Anything else the reader picks comes from the system list and is written as a
 * non-embedded font — see `familyFor`.
 */
export const BASE_FAMILIES: ReadonlyArray<FreeTextFamily> = [
  { name: 'Helvetica', daName: 'Helv', metrics: 'Helvetica', standard: 'Helvetica' },
  { name: 'Times New Roman', daName: 'TiRo', metrics: 'Times-Roman', standard: 'Times-Roman' },
  { name: 'Courier New', daName: 'Cour', metrics: 'Courier', standard: 'Courier' },
  { name: 'Symbol', daName: 'Symb', metrics: 'Symbol', standard: 'Symbol' },
  { name: 'ZapfDingbats', daName: 'ZaDb', metrics: 'ZapfDingbats', standard: 'ZapfDingbats' },
];

/** Generic families a system face is laid out with when we have no metrics of our own. */
const GENERIC_METRICS: ReadonlyArray<readonly [RegExp, StandardFontName]> = [
  [/courier|mono|consol|menlo|inconsolata/i, 'Courier'],
  [/times|serif|georgia|garamond|book|cambria|palatino|minion/i, 'Times-Roman'],
];

/** The bold/italic variant of a standard face. */
export function styledStandardFont(
  base: StandardFontName,
  bold: boolean,
  italic: boolean,
): StandardFontName {
  if (base === 'Symbol' || base === 'ZapfDingbats') return base;
  const family = base.startsWith('Times')
    ? 'Times'
    : base.startsWith('Courier')
      ? 'Courier'
      : 'Helvetica';
  if (family === 'Times') {
    if (bold && italic) return 'Times-BoldItalic';
    if (bold) return 'Times-Bold';
    if (italic) return 'Times-Italic';
    return 'Times-Roman';
  }
  const suffix = bold && italic ? '-BoldOblique' : bold ? '-Bold' : italic ? '-Oblique' : '';
  return `${family}${suffix}` as StandardFontName;
}

/** The family record for a name, inventing one for a face that is not in the base 14. */
export function familyFor(name: string): FreeTextFamily {
  const known = BASE_FAMILIES.find((f) => f.name.toLowerCase() === name.toLowerCase());
  if (known) return known;
  const metrics = GENERIC_METRICS.find(([re]) => re.test(name))?.[1] ?? 'Helvetica';
  return { name, daName: name.replace(/[^A-Za-z0-9]/g, ''), metrics, standard: null };
}

// ---- the style ---------------------------------------------------------------------------------

/** Horizontal alignment, as `/Q` numbers it. */
export type TextAlign = 0 | 1 | 2;

/** How a free-text box is drawn. Everything the properties panel edits lives here. */
export interface FreeTextStyle {
  /** Family name as the reader picked it. */
  readonly family: string;
  readonly size: number;
  readonly bold: boolean;
  readonly italic: boolean;
  /** Text colour, `0xRRGGBB`. */
  readonly color: number;
  readonly align: TextAlign;
  /** Line height as a multiple of the font size. */
  readonly lineSpacing: number;
}

export const DEFAULT_FREE_TEXT_STYLE: FreeTextStyle = {
  family: 'Helvetica',
  size: 12,
  bold: false,
  italic: false,
  color: 0x000000,
  align: 0,
  lineSpacing: 1.2,
};

/** The font an appearance stream should ask for to draw this style. */
export function appearanceFontFor(style: FreeTextStyle): AppearanceFont {
  const family = familyFor(style.family);
  const face = styledStandardFont(family.metrics, style.bold, style.italic);
  if (family.standard !== null) return face;
  return { baseFont: systemBaseFont(family.name, style), fallback: face };
}

/** `Verdana` + bold + italic → `Verdana,BoldItalic`, which is how a TrueType `/BaseFont` says it. */
function systemBaseFont(family: string, style: FreeTextStyle): string {
  const cleaned = family.replace(/[^A-Za-z0-9+.-]/g, '');
  const suffix =
    style.bold && style.italic
      ? ',BoldItalic'
      : style.bold
        ? ',Bold'
        : style.italic
          ? ',Italic'
          : '';
  return `${cleaned === '' ? 'Helvetica' : cleaned}${suffix}`;
}

// ---- `/DA` --------------------------------------------------------------------------------------

/** The `/DA` string for a style: the fill colour, then the font and size. */
export function buildDefaultAppearance(style: FreeTextStyle): string {
  const family = familyFor(style.family);
  const face = styledStandardFont(family.metrics, style.bold, style.italic);
  const name = family.standard === null ? family.daName : daNameFor(face, family);
  const [r, g, b] = rgbComponents(style.color);
  return `${num(r)} ${num(g)} ${num(b)} rg /${name} ${num(style.size)} Tf`;
}

/** Acrobat's resource names for the standard faces: `Helv`, `HeBo`, `TiRo`, `TiBI`, `Cour`… */
function daNameFor(face: StandardFontName, family: FreeTextFamily): string {
  const table: Readonly<Record<string, string>> = {
    Helvetica: 'Helv',
    'Helvetica-Bold': 'HeBo',
    'Helvetica-Oblique': 'HeOb',
    'Helvetica-BoldOblique': 'HeBO',
    'Times-Roman': 'TiRo',
    'Times-Bold': 'TiBo',
    'Times-Italic': 'TiIt',
    'Times-BoldItalic': 'TiBI',
    Courier: 'Cour',
    'Courier-Bold': 'CoBo',
    'Courier-Oblique': 'CoOb',
    'Courier-BoldOblique': 'CoBO',
    Symbol: 'Symb',
    ZapfDingbats: 'ZaDb',
  };
  return table[face] ?? family.daName;
}

const DA_NAME_TO_STYLE: Readonly<
  Record<string, { family: string; bold: boolean; italic: boolean }>
> = {
  Helv: { family: 'Helvetica', bold: false, italic: false },
  HeBo: { family: 'Helvetica', bold: true, italic: false },
  HeOb: { family: 'Helvetica', bold: false, italic: true },
  HeBO: { family: 'Helvetica', bold: true, italic: true },
  TiRo: { family: 'Times New Roman', bold: false, italic: false },
  TiBo: { family: 'Times New Roman', bold: true, italic: false },
  TiIt: { family: 'Times New Roman', bold: false, italic: true },
  TiBI: { family: 'Times New Roman', bold: true, italic: true },
  Cour: { family: 'Courier New', bold: false, italic: false },
  CoBo: { family: 'Courier New', bold: true, italic: false },
  CoOb: { family: 'Courier New', bold: false, italic: true },
  CoBO: { family: 'Courier New', bold: true, italic: true },
  Symb: { family: 'Symbol', bold: false, italic: false },
  ZaDb: { family: 'ZapfDingbats', bold: false, italic: false },
};

/**
 * Reads a `/DA` string back into a style. Everything it does not say keeps the default, because
 * a `/DA` written by another editor says only what that editor cared about.
 */
export function parseDefaultAppearance(
  da: string,
  base: FreeTextStyle = DEFAULT_FREE_TEXT_STYLE,
): FreeTextStyle {
  let style: FreeTextStyle = base;
  const tf = /\/([^\s/]+)\s+([0-9.]+)\s+Tf/.exec(da);
  if (tf) {
    const named = DA_NAME_TO_STYLE[tf[1] ?? ''];
    const size = Number.parseFloat(tf[2] ?? '');
    style = {
      ...style,
      ...(named ?? { family: (tf[1] ?? style.family).replace(/,.*$/, '') }),
      ...(Number.isFinite(size) && size > 0 ? { size } : {}),
    };
  }
  const colour = parseColourOperator(da);
  if (colour !== null) style = { ...style, color: colour };
  return style;
}

/** The last `g` / `rg` / `k` fill operator in a `/DA`, as `0xRRGGBB`. */
function parseColourOperator(da: string): number | null {
  const pack = (r: number, g: number, b: number): number =>
    (Math.round(clamp01(r) * 255) << 16) |
    (Math.round(clamp01(g) * 255) << 8) |
    Math.round(clamp01(b) * 255);
  let out: number | null = null;
  for (const m of da.matchAll(/([0-9.\s]+?)\s*(rg|g|k)\b/g)) {
    const parts = (m[1] ?? '')
      .trim()
      .split(/\s+/)
      .map(Number)
      .filter((n) => Number.isFinite(n));
    const op = m[2];
    if (op === 'g' && parts.length >= 1) {
      const v = parts[parts.length - 1] ?? 0;
      out = pack(v, v, v);
    } else if (op === 'rg' && parts.length >= 3) {
      const [r, g, b] = parts.slice(-3) as [number, number, number];
      out = pack(r, g, b);
    } else if (op === 'k' && parts.length >= 4) {
      const [c, m2, y, k] = parts.slice(-4) as [number, number, number, number];
      out = pack((1 - c) * (1 - k), (1 - m2) * (1 - k), (1 - y) * (1 - k));
    }
  }
  return out;
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

// ---- `/DS` --------------------------------------------------------------------------------------

const ALIGN_WORD: Readonly<Record<TextAlign, string>> = { 0: 'left', 1: 'center', 2: 'right' };

/** The `/DS` CSS declaration list for a style — what a rich-text viewer reads. */
export function buildDefaultStyle(style: FreeTextStyle): string {
  const [r, g, b] = rgbComponents(style.color).map((c) => Math.round(c * 255));
  const hex = [r, g, b].map((c) => (c ?? 0).toString(16).padStart(2, '0')).join('');
  return [
    `font-family:${style.family}`,
    `font-size:${num(style.size)}pt`,
    `font-weight:${style.bold ? 'bold' : 'normal'}`,
    `font-style:${style.italic ? 'italic' : 'normal'}`,
    // Not a colour literal: the digits come from the annotation, not from this file.
    `color:#${hex}`,
    `text-align:${ALIGN_WORD[style.align]}`,
    `line-height:${num(style.lineSpacing)}`,
  ].join(';');
}

/** Reads a `/DS` back. Anything it does not mention keeps the value it had. */
export function parseDefaultStyle(
  ds: string,
  base: FreeTextStyle = DEFAULT_FREE_TEXT_STYLE,
): FreeTextStyle {
  const declarations = new Map<string, string>();
  for (const part of ds.split(';')) {
    const at = part.indexOf(':');
    if (at < 0) continue;
    declarations.set(part.slice(0, at).trim().toLowerCase(), part.slice(at + 1).trim());
  }
  const size = Number.parseFloat(declarations.get('font-size') ?? '');
  const spacing = Number.parseFloat(declarations.get('line-height') ?? '');
  const alignWord = (declarations.get('text-align') ?? '').toLowerCase();
  const align: TextAlign = alignWord === 'center' ? 1 : alignWord === 'right' ? 2 : base.align;
  const colour = parseCssColour(declarations.get('color') ?? '');
  return {
    ...base,
    family: declarations.get('font-family')?.replace(/["']/g, '') ?? base.family,
    ...(Number.isFinite(size) && size > 0 ? { size } : {}),
    bold: declarations.has('font-weight')
      ? /bold|[6-9]00/i.test(declarations.get('font-weight') ?? '')
      : base.bold,
    italic: declarations.has('font-style')
      ? /italic|oblique/i.test(declarations.get('font-style') ?? '')
      : base.italic,
    ...(colour === null ? {} : { color: colour }),
    align: declarations.has('text-align') ? align : base.align,
    ...(Number.isFinite(spacing) && spacing > 0 ? { lineSpacing: spacing } : {}),
  };
}

/** `#rgb` / `#rrggbb` from a `/DS`, as `0xRRGGBB`. Anything else is "not stated". */
function parseCssColour(value: string): number | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim());
  const digits = m?.[1];
  if (digits === undefined) return null;
  const full =
    digits.length === 3
      ? digits
          .split('')
          .map((c) => c + c)
          .join('')
      : digits;
  return Number.parseInt(full, 16);
}

// ---- the style an annotation currently has -------------------------------------------------------

/**
 * The style of a free-text annotation, read from `/DS` over `/DA` over the defaults. `/DS` wins
 * where it speaks because it is the richer of the two, and `/DA` fills in what it does not say.
 */
export function styleOf(
  extra: Readonly<Record<string, unknown>>,
  base: FreeTextStyle = DEFAULT_FREE_TEXT_STYLE,
): FreeTextStyle {
  let style = base;
  // The three loose keys M21's generator read before `/DA` was written. They stay supported so a
  // caller that only wants "12 pt Courier" does not have to build a `/DA` to say it.
  const font = extra['font'];
  if (typeof font === 'string' && font !== '') {
    style = {
      ...style,
      family: familyNameOfStandardFace(font) ?? style.family,
      bold: /bold/i.test(font),
      italic: /italic|oblique/i.test(font),
    };
  }
  const size = extra['fontSize'];
  if (typeof size === 'number' && size > 0) style = { ...style, size };
  const colour = extra['textColor'];
  if (typeof colour === 'number' && Number.isFinite(colour)) style = { ...style, color: colour };

  const da = extra['defaultAppearance'];
  if (typeof da === 'string' && da !== '') style = parseDefaultAppearance(da, style);
  const ds = extra['defaultStyle'];
  if (typeof ds === 'string' && ds !== '') style = parseDefaultStyle(ds, style);
  return style;
}

/** `"Times-BoldItalic"` → `"Times New Roman"`, for the loose `extra.font` key. */
function familyNameOfStandardFace(face: string): string | null {
  if (/^Times/i.test(face)) return 'Times New Roman';
  if (/^Courier/i.test(face)) return 'Courier New';
  if (/^Helvetica/i.test(face)) return 'Helvetica';
  if (/^Symbol$/i.test(face)) return 'Symbol';
  if (/^ZapfDingbats$/i.test(face)) return 'ZapfDingbats';
  return null;
}

// ---- geometry ------------------------------------------------------------------------------------

/** What `/IT` says a free-text annotation is. */
export type FreeTextIntent = 'FreeText' | 'FreeTextTypewriter' | 'FreeTextCallout';

/** The intent of an annotation, defaulting to the plain text box. */
export function intentOf(extra: Readonly<Record<string, unknown>>): FreeTextIntent {
  const value = extra['intent'];
  return value === 'FreeTextTypewriter' || value === 'FreeTextCallout' ? value : 'FreeText';
}

/** `/RD` as four insets from `/Rect`: left, top, right, bottom. Zero when absent. */
export function paddingOf(
  extra: Readonly<Record<string, unknown>>,
): [number, number, number, number] {
  const value = extra['padding'];
  if (!Array.isArray(value) || value.length < 4) return [0, 0, 0, 0];
  const n = value.map((v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0));
  return [n[0] ?? 0, n[1] ?? 0, n[2] ?? 0, n[3] ?? 0];
}

/** The text box inside `/Rect`, after `/RD`. */
export function textBoxOf(rect: PdfRect, extra: Readonly<Record<string, unknown>>): PdfRect {
  const [left, top, right, bottom] = paddingOf(extra);
  const box: PdfRect = {
    x0: rect.x0 + left,
    y0: rect.y0 + bottom,
    x1: rect.x1 - right,
    y1: rect.y1 - top,
  };
  return box.x1 > box.x0 && box.y1 > box.y0 ? box : rect;
}

/** `/Rotate` — how far the text inside the box is turned, anticlockwise, as a multiple of 90. */
export function rotateOf(extra: Readonly<Record<string, unknown>>): 0 | 90 | 180 | 270 {
  const value = extra['rotate'];
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  const turns = ((Math.round(value / 90) % 4) + 4) % 4;
  return ([0, 90, 180, 270] as const)[turns] ?? 0;
}

/**
 * The box the text is laid out in before it is turned.
 *
 * At 90° and 270° the words run down the box rather than across it, so they wrap to its *height*.
 * The logical box is therefore the real one with its sides swapped, about the same centre; the
 * rotation then puts it back where it belongs.
 */
export function logicalBox(box: PdfRect, rotate: number): PdfRect {
  if (rotate % 180 === 0) return box;
  const cx = (box.x0 + box.x1) / 2;
  const cy = (box.y0 + box.y1) / 2;
  const halfW = (box.y1 - box.y0) / 2;
  const halfH = (box.x1 - box.x0) / 2;
  return { x0: cx - halfW, y0: cy - halfH, x1: cx + halfW, y1: cy + halfH };
}

/** A point turned `rotate` degrees anticlockwise about `centre`. */
export function rotatePoint(p: PdfPoint, centre: PdfPoint, rotate: number): PdfPoint {
  if (rotate % 360 === 0) return p;
  const radians = (rotate * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const dx = p.x - centre.x;
  const dy = p.y - centre.y;
  return { x: centre.x + dx * cos - dy * sin, y: centre.y + dx * sin + dy * cos };
}

/** `/CL` as points: three (tip, knee, shoulder) or two (tip, shoulder). Empty when absent. */
export function calloutOf(extra: Readonly<Record<string, unknown>>): PdfPoint[] {
  const value = extra['callout'];
  if (!Array.isArray(value)) return [];
  const numbers = value.filter((n): n is number => typeof n === 'number' && Number.isFinite(n));
  if (numbers.length < 4) return [];
  const points: PdfPoint[] = [];
  for (let i = 0; i + 1 < numbers.length && points.length < 3; i += 2) {
    points.push({ x: numbers[i] ?? 0, y: numbers[i + 1] ?? 0 });
  }
  return points;
}

/** `/CL` from points, which is how the model stores a callout's leader line. */
export function calloutNumbers(points: ReadonlyArray<PdfPoint>): number[] {
  const out: number[] = [];
  for (const p of points.slice(0, 3)) out.push(p.x, p.y);
  return out;
}

/** One laid-out line of a free-text box, with the baseline point it is drawn at. */
export interface LaidOutLine {
  readonly text: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
}

/** Wraps and places the text of a box: greedy wrap, then `/Q` alignment, then the leading. */
export function layoutFreeText(
  text: string,
  box: PdfRect,
  style: FreeTextStyle,
  padding = 2,
  rotate = 0,
): LaidOutLine[] {
  const face = styledStandardFont(familyFor(style.family).metrics, style.bold, style.italic);
  const inner = logicalBox(box, rotate);
  const centre = { x: (box.x0 + box.x1) / 2, y: (box.y0 + box.y1) / 2 };
  const innerWidth = Math.max(style.size, inner.x1 - inner.x0 - 2 * padding);
  const lines = wrapText(text, face, style.size, innerWidth);
  const leading = style.size * style.lineSpacing;
  const out: LaidOutLine[] = [];
  lines.forEach((line, i) => {
    const width = textWidth(line, face, style.size);
    const slack = innerWidth - width;
    const offset = style.align === 1 ? slack / 2 : style.align === 2 ? slack : 0;
    const at = rotatePoint(
      {
        x: inner.x0 + padding + Math.max(0, offset),
        // The first baseline sits one full size below the top inset, as a text editor places it.
        y: inner.y1 - padding - style.size - i * leading,
      },
      centre,
      rotate,
    );
    out.push({ text: line, x: at.x, y: at.y, width });
  });
  return out;
}

// ---- the generator ---------------------------------------------------------------------------------

/** Padding between the text and the box, in points. Foxit uses the same two. */
export const FREE_TEXT_PADDING = 2;

const DEFAULT_BORDER = 1;

/**
 * `/FreeText` — the box, the leader line if it is a callout, and the text.
 *
 * Replaces the plainer generator M21 registered: that one drew left-aligned text in a standard
 * face, which is all M21 needed to repair a file that arrived without an `/AP`. This one is what
 * the reader's own choices produce — alignment, line spacing, a system family, a dashed border, a
 * callout with a knee and an arrow head, and a text box inset from `/Rect` by `/RD`.
 */
export const freeTextAppearance: AppearanceGenerator = (input) => {
  const rect = normaliseRect(input.rect);
  const style = styleOf(input.extra);
  const b = new ContentBuilder();
  const width = input.borderWidth ?? DEFAULT_BORDER;
  const intent = intentOf(input.extra);
  const box = textBoxOf(rect, input.extra);

  b.save();
  if (input.opacity !== null && input.opacity < 1) {
    b.graphicsState({ fillAlpha: input.opacity, strokeAlpha: input.opacity });
  }
  drawCallout(b, input, intent, width);

  // The box itself. A typewriter has no border and no fill by definition, so it draws neither
  // even when the file carries a `/C` — that is what makes it a typewriter rather than a text box.
  const inset = width / 2;
  const frame: PdfRect = {
    x0: box.x0 + inset,
    y0: box.y0 + inset,
    x1: box.x1 - inset,
    y1: box.y1 - inset,
  };
  const stroked = intent !== 'FreeTextTypewriter' && input.color !== null && width > 0;
  const filled = intent !== 'FreeTextTypewriter' && input.interiorColor !== null;
  if (frame.x1 > frame.x0 && frame.y1 > frame.y0 && (stroked || filled)) {
    if (filled && input.interiorColor !== null) b.fillColor(input.interiorColor);
    if (stroked && input.color !== null) {
      b.strokeColor(input.color).lineWidth(width).lineJoin(0);
      const dashes = dashArray(input);
      if (dashes.length > 0) b.dash(dashes);
    }
    b.rect(frame);
    if (stroked && filled) b.fillAndStroke();
    else if (filled) b.fill();
    else b.stroke();
  }

  const text = input.contents ?? '';
  if (text !== '') {
    const rotate = rotateOf(input.extra);
    const lines = layoutFreeText(text, box, style, FREE_TEXT_PADDING, rotate);
    b.save();
    // Clip to the box: text that outgrew it is cut off, not spilled across the page.
    b.rect(box).push('W').push('n');
    b.fillColor(style.color);
    if (rotate === 0) {
      b.textLinesAt(lines, { font: appearanceFontFor(style), size: style.size });
    } else {
      /*
       * The glyphs turn with the box. The line origins are already in their turned places, so the
       * text matrix only has to carry the rotation itself — which is why each line is emitted on
       * its own rather than through one `Tm`.
       */
      const radians = (rotate * Math.PI) / 180;
      const cos = Math.cos(radians);
      const sin = Math.sin(radians);
      const font = appearanceFontFor(style);
      for (const line of lines) {
        if (line.text === '') continue;
        b.save();
        b.transform(cos, sin, -sin, cos, line.x, line.y);
        b.textLinesAt([{ text: line.text, x: 0, y: 0 }], { font, size: style.size });
        b.restore();
      }
    }
    b.restore();
  }
  b.restore();
  if (b.isEmpty) return null;
  const pad = width / 2 + 0.5;
  const bbox = calloutBBox(rect, input, pad);
  return { bbox, content: b.build(), resources: b.resources };
};

/** The leader line of a callout, with an arrow head at its tip. */
function drawCallout(
  b: ContentBuilder,
  input: AppearanceInput,
  intent: FreeTextIntent,
  width: number,
): void {
  if (intent !== 'FreeTextCallout') return;
  const points = calloutOf(input.extra);
  if (points.length < 2) return;
  const colour = input.color ?? 0x000000;
  const lineWidth = width > 0 ? width : DEFAULT_BORDER;
  b.save();
  b.strokeColor(colour).lineWidth(lineWidth).lineCap(0).lineJoin(0);
  b.polyline(points).stroke();
  const tip = points[0];
  const next = points[1];
  if (tip && next && ending(input) !== 'None') {
    drawArrowHead(b, tip, next, colour, Math.max(4, lineWidth * 4));
  }
  b.restore();
}

function ending(input: AppearanceInput): string {
  const value = input.extra['lineEnding'];
  return typeof value === 'string' && value !== '' ? value : 'OpenArrow';
}

/** A two-stroke open arrow at `tip`, opening back towards `from`. */
function drawArrowHead(
  b: ContentBuilder,
  tip: PdfPoint,
  from: PdfPoint,
  colour: number,
  size: number,
): void {
  const dx = from.x - tip.x;
  const dy = from.y - tip.y;
  const length = Math.hypot(dx, dy);
  if (length < 1e-6) return;
  const ux = dx / length;
  const uy = dy / length;
  const spread = Math.PI / 7;
  const cos = Math.cos(spread);
  const sin = Math.sin(spread);
  b.strokeColor(colour);
  b.moveTo(tip.x, tip.y)
    .lineTo(tip.x + size * (ux * cos - uy * sin), tip.y + size * (ux * sin + uy * cos))
    .stroke();
  b.moveTo(tip.x, tip.y)
    .lineTo(tip.x + size * (ux * cos + uy * sin), tip.y + size * (-ux * sin + uy * cos))
    .stroke();
}

/** The stream's BBox: the rect, grown by the stroke and by whatever the leader line reaches. */
function calloutBBox(rect: PdfRect, input: AppearanceInput, pad: number): PdfRect {
  let box: PdfRect = { x0: rect.x0 - pad, y0: rect.y0 - pad, x1: rect.x1 + pad, y1: rect.y1 + pad };
  for (const p of calloutOf(input.extra)) {
    box = {
      x0: Math.min(box.x0, p.x - pad * 4),
      y0: Math.min(box.y0, p.y - pad * 4),
      x1: Math.max(box.x1, p.x + pad * 4),
      y1: Math.max(box.y1, p.y + pad * 4),
    };
  }
  return box;
}

function dashArray(input: AppearanceInput): ReadonlyArray<number> {
  const value = input.extra['dashArray'];
  return Array.isArray(value) ? value.filter((n): n is number => typeof n === 'number') : [];
}

/** Exported for the tests: the metric face a style lays out with. */
export function metricFaceFor(style: FreeTextStyle): StandardFontName {
  return metricFont(appearanceFontFor(style));
}

/** The smallest rect that holds `lines` at `style`, for "fit the box to the text". */
export function measureFreeText(
  text: string,
  style: FreeTextStyle,
  maxWidth: number,
): { readonly width: number; readonly height: number } {
  const face = styledStandardFont(familyFor(style.family).metrics, style.bold, style.italic);
  const inner = Math.max(style.size, maxWidth - 2 * FREE_TEXT_PADDING);
  const lines = wrapText(text === '' ? ' ' : text, face, style.size, inner);
  const widest = lines.reduce((max, line) => Math.max(max, textWidth(line, face, style.size)), 0);
  const leading = style.size * style.lineSpacing;
  return {
    width: widest + 2 * FREE_TEXT_PADDING,
    height: (lines.length - 1) * leading + style.size * 1.35 + 2 * FREE_TEXT_PADDING,
  };
}

/** Re-exported so callers do not have to reach past this module for a stream type. */
export type { AppearanceStream };

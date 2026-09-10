/**
 * `/DA` — the default appearance string (M60, ADR 0019).
 *
 * A field's font, size and text colour live in one string of PDF operators, and three places have
 * to agree about what it says: the properties panel, the DOM widget layer and the appearance
 * generator. So the round trip is one module, as `freetext.ts` is for a FreeText annotation.
 *
 * The resource names are Acrobat's (`Helv`, `HeBo`, `TiRo`, `Cour`, `ZaDb`, …). They are what a
 * form's `/DR /Font` dictionary is keyed by in practice, and a viewer that finds no such key
 * falls back to Helvetica — so writing them keeps a file working in editors that have never seen
 * ours.
 */

import type { AppearanceFont, StandardFontName } from '../appearance/types';
import { isNonEmbeddedFont } from '../appearance/types';

/** The standard-14 faces a `/DR /Font` names, by the key Acrobat uses. */
export const DA_FONT_KEYS: Readonly<Record<string, StandardFontName>> = {
  Helv: 'Helvetica',
  HeBo: 'Helvetica-Bold',
  HeOb: 'Helvetica-Oblique',
  HeBO: 'Helvetica-BoldOblique',
  TiRo: 'Times-Roman',
  TiBo: 'Times-Bold',
  TiIt: 'Times-Italic',
  TiBI: 'Times-BoldItalic',
  Cour: 'Courier',
  CoBo: 'Courier-Bold',
  CoOb: 'Courier-Oblique',
  CoBO: 'Courier-BoldOblique',
  Symb: 'Symbol',
  ZaDb: 'ZapfDingbats',
};

const KEY_OF_FONT: Readonly<Record<StandardFontName, string>> = Object.fromEntries(
  Object.entries(DA_FONT_KEYS).map(([key, font]) => [font, key]),
) as Record<StandardFontName, string>;

/** The `/DR /Font` key a font is written under. A system family keeps its own cleaned name. */
export function daFontKey(font: AppearanceFont): string {
  if (isNonEmbeddedFont(font)) {
    const cleaned = font.baseFont.replace(/[^A-Za-z0-9]/g, '');
    return cleaned === '' ? 'Helv' : cleaned;
  }
  return KEY_OF_FONT[font] ?? 'Helv';
}

export interface DefaultAppearance {
  readonly font: AppearanceFont;
  /** Points; 0 means "auto" — the generator fits the box. */
  readonly size: number;
  /** `0xRRGGBB`. */
  readonly color: number;
}

export const DEFAULT_DA: DefaultAppearance = { font: 'Helvetica', size: 0, color: 0x000000 };

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

function packRgb(r: number, g: number, b: number): number {
  const c = (v: number): number => Math.round(clamp01(v) * 255);
  return (c(r) << 16) | (c(g) << 8) | c(b);
}

/**
 * Reads a `/DA`. Anything it cannot make sense of falls back to the default rather than throwing:
 * a field with a malformed `/DA` still has to be shown.
 */
export function parseDefaultAppearance(
  da: string | null | undefined,
  fonts?: Readonly<Record<string, AppearanceFont>>,
): DefaultAppearance {
  if (!da) return DEFAULT_DA;
  const tokens = da.trim().split(/\s+/);
  let font: AppearanceFont = DEFAULT_DA.font;
  let size = DEFAULT_DA.size;
  let color = DEFAULT_DA.color;
  const numbers: number[] = [];
  for (const raw of tokens) {
    const token = raw;
    if (token.startsWith('/')) {
      numbers.length = 0;
      const key = token.slice(1);
      const known = fonts?.[key] ?? DA_FONT_KEYS[key];
      if (known) font = known;
      else if (key !== '') font = { baseFont: key, fallback: 'Helvetica' };
      continue;
    }
    const n = Number(token);
    if (Number.isFinite(n)) {
      numbers.push(n);
      continue;
    }
    switch (token) {
      case 'Tf':
        size = Math.max(0, numbers[numbers.length - 1] ?? 0);
        break;
      case 'g': {
        const v = numbers[numbers.length - 1] ?? 0;
        color = packRgb(v, v, v);
        break;
      }
      case 'rg': {
        const [r = 0, g = 0, b = 0] = numbers.slice(-3);
        color = packRgb(r, g, b);
        break;
      }
      case 'k': {
        const [c = 0, m = 0, y = 0, k = 0] = numbers.slice(-4);
        color = packRgb((1 - c) * (1 - k), (1 - m) * (1 - k), (1 - y) * (1 - k));
        break;
      }
      default:
        break;
    }
    numbers.length = 0;
  }
  return { font, size, color };
}

/** Number formatting for a `/DA`: the same rules the content builder uses. */
function num(value: number): string {
  const rounded = Math.round(value * 10_000) / 10_000;
  if (Object.is(rounded, -0) || rounded === 0) return '0';
  return rounded.toFixed(4).replace(/\.?0+$/, '');
}

/** Builds a `/DA` string. Grey is written as `g` when the colour is neutral, as Acrobat does. */
export function formatDefaultAppearance(da: DefaultAppearance): string {
  const r = (da.color >> 16) & 0xff;
  const g = (da.color >> 8) & 0xff;
  const b = da.color & 0xff;
  const colorOps =
    r === g && g === b ? `${num(r / 255)} g` : `${num(r / 255)} ${num(g / 255)} ${num(b / 255)} rg`;
  return `/${daFontKey(da.font)} ${num(da.size)} Tf ${colorOps}`;
}

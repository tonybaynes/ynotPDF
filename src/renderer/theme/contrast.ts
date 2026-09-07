/**
 * Colour maths for the theme system (M01). Pure functions, no DOM, so the contrast and
 * colour-vision tests run under vitest in Node and the gallery page reuses them in the browser.
 *
 * - {@link contrastRatio}: WCAG 2.x relative-luminance contrast, 1..21.
 * - {@link lightness}: CIE L* (0..100) — perceptual lightness used for the colour-vision test.
 * - {@link simulateCvd}: Machado, Oliveira & Fernandes (2009) severity-1.0 matrices for
 *   protanopia and deuteranopia, applied in linear RGB.
 */

/** Linear-light RGB triple, each channel 0..1. */
export interface LinearRgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

/** 8-bit sRGB triple, each channel 0..255. */
export interface Rgb8 {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

/**
 * Parses `#rgb`, `#rrggbb` (and the 4/8-digit alpha forms, whose alpha is ignored — the
 * theme files are not allowed to use it anyway). Throws on anything else: theme values must
 * be plain hex so the contrast test can reason about them.
 */
export function parseHex(hex: string): Rgb8 {
  const m = /^#([0-9a-f]{3,8})$/i.exec(hex.trim());
  if (!m?.[1]) throw new Error(`Not a hex colour: ${JSON.stringify(hex)}`);
  let h = m[1];
  if (h.length === 3 || h.length === 4) {
    h = h
      .split('')
      .map((c) => c + c)
      .join('');
  }
  if (h.length !== 6 && h.length !== 8) throw new Error(`Not a hex colour: ${hex}`);
  return {
    r: Number.parseInt(h.slice(0, 2), 16),
    g: Number.parseInt(h.slice(2, 4), 16),
    b: Number.parseInt(h.slice(4, 6), 16),
  };
}

/** Formats an 8-bit triple as lower-case `#rrggbb`. */
export function toHex(c: Rgb8): string {
  const two = (n: number): string =>
    Math.max(0, Math.min(255, Math.round(n)))
      .toString(16)
      .padStart(2, '0');
  return `#${two(c.r)}${two(c.g)}${two(c.b)}`;
}

/** sRGB transfer function (IEC 61966-2-1), 0..255 → linear 0..1. */
export function srgbToLinear(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** Inverse sRGB transfer function, linear 0..1 → 0..255 (clamped). */
export function linearToSrgb(v: number): number {
  const c = Math.max(0, Math.min(1, v));
  const s = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  return s * 255;
}

export function toLinear(c: Rgb8): LinearRgb {
  return { r: srgbToLinear(c.r), g: srgbToLinear(c.g), b: srgbToLinear(c.b) };
}

export function fromLinear(c: LinearRgb): Rgb8 {
  return { r: linearToSrgb(c.r), g: linearToSrgb(c.g), b: linearToSrgb(c.b) };
}

/** WCAG relative luminance (Y of CIE XYZ, D65), 0..1. */
export function relativeLuminance(c: Rgb8): number {
  const l = toLinear(c);
  return 0.2126 * l.r + 0.7152 * l.g + 0.0722 * l.b;
}

/** WCAG 2.x contrast ratio between two colours, 1..21. Order does not matter. */
export function contrastRatio(a: Rgb8 | string, b: Rgb8 | string): number {
  const la = relativeLuminance(typeof a === 'string' ? parseHex(a) : a);
  const lb = relativeLuminance(typeof b === 'string' ? parseHex(b) : b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** CIE L* (0 = black, 100 = white) from relative luminance. */
export function lightnessFromLuminance(y: number): number {
  const t = y > 216 / 24389 ? Math.cbrt(y) : ((24389 / 27) * y + 16) / 116;
  return 116 * t - 16;
}

/** CIE L* of a colour, 0..100. */
export function lightness(c: Rgb8 | string): number {
  return lightnessFromLuminance(relativeLuminance(typeof c === 'string' ? parseHex(c) : c));
}

export type CvdType = 'protanopia' | 'deuteranopia' | 'tritanopia';

/**
 * Machado, Oliveira & Fernandes (2009), "A Physiologically-based Model for Simulation of
 * Color Vision Deficiency", severity 1.0 matrices. Applied to linear RGB.
 */
export const MACHADO_2009: Readonly<Record<CvdType, ReadonlyArray<ReadonlyArray<number>>>> = {
  protanopia: [
    [0.152286, 1.052583, -0.204868],
    [0.114503, 0.786281, 0.099216],
    [-0.003882, -0.048116, 1.051998],
  ],
  deuteranopia: [
    [0.367322, 0.860646, -0.227968],
    [0.280085, 0.672501, 0.047413],
    [-0.01182, 0.04294, 0.968881],
  ],
  tritanopia: [
    [1.255528, -0.076749, -0.178779],
    [-0.078411, 0.930809, 0.147602],
    [0.004733, 0.691367, 0.3039],
  ],
};

/** Simulates how a colour looks to a viewer with the given dichromacy. */
export function simulateCvd(c: Rgb8 | string, type: CvdType): Rgb8 {
  const lin = toLinear(typeof c === 'string' ? parseHex(c) : c);
  const m = MACHADO_2009[type];
  const row = (i: number): number => {
    const r = m[i];
    if (!r) throw new Error('bad matrix');
    return (r[0] ?? 0) * lin.r + (r[1] ?? 0) * lin.g + (r[2] ?? 0) * lin.b;
  };
  return fromLinear({ r: row(0), g: row(1), b: row(2) });
}

/** Rounds a ratio to two decimals for display (`4.5`, `7.12`). */
export function formatRatio(ratio: number): string {
  return `${(Math.floor(ratio * 100) / 100).toFixed(2)}:1`;
}

/** CIE L*a*b* (D65). `b` is the blue (negative) ↔ yellow (positive) axis. */
export interface Lab {
  readonly L: number;
  readonly a: number;
  readonly b: number;
}

/** Converts a colour to CIE L*a*b* under D65. Used by the colour-vision test and gallery. */
export function toLab(c: Rgb8 | string): Lab {
  const l = toLinear(typeof c === 'string' ? parseHex(c) : c);
  const x = (0.4124564 * l.r + 0.3575761 * l.g + 0.1804375 * l.b) / 0.95047;
  const y = 0.2126729 * l.r + 0.7151522 * l.g + 0.072175 * l.b;
  const z = (0.0193339 * l.r + 0.119192 * l.g + 0.9503041 * l.b) / 1.08883;
  const f = (t: number): number =>
    t > 216 / 24389 ? Math.cbrt(t) : t / (3 * Math.pow(6 / 29, 2)) + 4 / 29;
  const fx = f(x);
  const fy = f(y);
  const fz = f(z);
  return { L: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
}

/**
 * Night Mode for the rendered page raster (M11, inherited from M01).
 *
 * M01 owns the toggle (`view.nightMode.toggle`, `Mod+Alt+N`), the `data-night-mode` attribute
 * and the `--page-paper-night` / `--page-ink-night` tokens. This file is the pixel half: it
 * darkens the *page*, not the interface.
 *
 * A plain `invert()` is wrong — it turns a photograph into a negative and a blue heading into
 * orange. What we want is to invert **lightness** while leaving **hue and chroma** alone:
 *
 * 1. Split each pixel into a grey level `L` (Rec. 709 luma) and its colour deviation
 *    `(r − L, g − L, b − L)`.
 * 2. Map `L` along the theme's ink → paper ramp: `L = 0` (black ink) becomes `--page-ink-night`
 *    (light), `L = 255` (white paper) becomes `--page-paper-night` (dark). That is the
 *    inversion, and it lands on the theme's own two colours rather than on pure black/white.
 * 3. Add the deviation back, scaling it down if a channel would otherwise leave 0..255 — which
 *    keeps the hue exact instead of letting the clip bend it.
 *
 * A red heading therefore stays red, a blue link stays blue, and the paper turns the same dark
 * the placeholder page uses. Photographs read as photographs — but they still lose their
 * lightness, so by default the caller paints image objects back from the untouched source
 * (`keepImages`), which is what the eye actually wants and what the brief asks for.
 *
 * Everything here is pure and works on plain `Uint8ClampedArray`s, so it is unit-tested in Node.
 */

/** An 8-bit RGB triple. */
export interface Rgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

/** Rec. 709 luma of an 8-bit triple, 0..255. */
export function luma(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * Parses a CSS colour that a theme token can hold: `#rgb`, `#rrggbb`, `#rrggbbaa` or
 * `rgb()`/`rgba()` as `getComputedStyle` returns it. Returns `null` for anything else so the
 * caller can fall back rather than paint something wrong.
 */
export function parseColor(text: string): Rgb | null {
  const s = text.trim();
  if (s.startsWith('#')) {
    const hex = s.slice(1);
    const expand = (h: string): number => Number.parseInt(h.length === 1 ? h + h : h, 16);
    if (hex.length === 3 || hex.length === 4) {
      const [r, g, b] = [hex[0] ?? '', hex[1] ?? '', hex[2] ?? ''];
      return { r: expand(r), g: expand(g), b: expand(b) };
    }
    if (hex.length === 6 || hex.length === 8) {
      return {
        r: expand(hex.slice(0, 2)),
        g: expand(hex.slice(2, 4)),
        b: expand(hex.slice(4, 6)),
      };
    }
    return null;
  }
  const m = /^rgba?\(([^)]+)\)$/i.exec(s);
  if (!m?.[1]) return null;
  const parts = m[1]
    .split(/[\s,/]+/)
    .filter(Boolean)
    .map(Number);
  const [r, g, b] = parts;
  if (r === undefined || g === undefined || b === undefined) return null;
  if (![r, g, b].every((n) => Number.isFinite(n))) return null;
  return { r, g, b };
}

/** The two colours the ramp runs between. */
export interface NightPalette {
  /** `--page-paper-night`: what white paper becomes. */
  readonly paper: Rgb;
  /** `--page-ink-night`: what black ink becomes. */
  readonly ink: Rgb;
}

export interface NightOptions {
  /**
   * How much of the source's colour survives, 0..1. 1 keeps hue and saturation exactly; lower
   * values calm bright content down. Default 1 — the operator asked for hue preserved.
   */
  readonly chroma?: number;
}

/**
 * A 256 × 3 lookup table: for each source luma, the grey level the three channels start from.
 * Building it once per tile-set keeps the per-pixel work to three adds and three clamps.
 */
export type NightRamp = Uint8ClampedArray;

export function buildRamp(palette: NightPalette): NightRamp {
  const ramp = new Uint8ClampedArray(256 * 3);
  const { ink, paper } = palette;
  for (let l = 0; l < 256; l++) {
    const t = l / 255;
    ramp[l * 3] = ink.r + (paper.r - ink.r) * t;
    ramp[l * 3 + 1] = ink.g + (paper.g - ink.g) * t;
    ramp[l * 3 + 2] = ink.b + (paper.b - ink.b) * t;
  }
  return ramp;
}

/** The default palette, used when the computed style cannot be read (tests, headless). */
export const FALLBACK_PALETTE: NightPalette = {
  paper: { r: 0x1b, g: 0x1b, b: 0x1d },
  ink: { r: 0xe8, g: 0xe8, b: 0xea },
};

/**
 * Applies the night transform to RGBA pixels **in place**. Alpha is untouched.
 *
 * The colour deviation is scaled down rather than clipped when adding it back would take a
 * channel outside 0..255. Letting `Uint8ClampedArray` clip instead would bend the hue — a
 * saturated violet came out nearly 40° away — whereas scaling the whole deviation vector keeps
 * its direction, so the hue is exact and only the saturation gives a little.
 */
export function applyNight(
  rgba: Uint8ClampedArray,
  ramp: NightRamp,
  options: NightOptions = {},
): void {
  const chroma = options.chroma ?? 1;
  for (let i = 0; i < rgba.length; i += 4) {
    const r = rgba[i] ?? 0;
    const g = rgba[i + 1] ?? 0;
    const b = rgba[i + 2] ?? 0;
    const l = luma(r, g, b);
    const base = Math.round(l) * 3;
    const br = ramp[base] ?? 0;
    const bg = ramp[base + 1] ?? 0;
    const bb = ramp[base + 2] ?? 0;
    const dr = r - l;
    const dg = g - l;
    const db = b - l;
    const k = Math.min(chroma, headroom(br, dr), headroom(bg, dg), headroom(bb, db));
    rgba[i] = br + dr * k;
    rgba[i + 1] = bg + dg * k;
    rgba[i + 2] = bb + db * k;
  }
}

/** How far a deviation can be applied to a base level before the channel leaves 0..255. */
function headroom(base: number, deviation: number): number {
  if (deviation > 0) return (255 - base) / deviation;
  if (deviation < 0) return -base / deviation;
  return Number.POSITIVE_INFINITY;
}

/** An integer pixel rectangle inside a bitmap. */
export interface PixelRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Copies `rects` back from `source` into `target` — how image objects escape the inversion.
 * Rectangles are clipped to the bitmap; overlapping ones are fine.
 */
export function restoreRegions(
  target: Uint8ClampedArray,
  source: Uint8ClampedArray,
  width: number,
  height: number,
  rects: ReadonlyArray<PixelRect>,
): void {
  for (const rect of rects) {
    const x0 = Math.max(0, Math.floor(rect.x));
    const y0 = Math.max(0, Math.floor(rect.y));
    const x1 = Math.min(width, Math.ceil(rect.x + rect.width));
    const y1 = Math.min(height, Math.ceil(rect.y + rect.height));
    if (x1 <= x0 || y1 <= y0) continue;
    const runBytes = (x1 - x0) * 4;
    for (let y = y0; y < y1; y++) {
      const start = (y * width + x0) * 4;
      target.set(source.subarray(start, start + runBytes), start);
    }
  }
}

/**
 * The whole transform for one tile: invert lightness, then put the image regions back.
 * `imageRects` are in the *tile's* pixel space (the caller has already offset them).
 */
export function nightTransform(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  ramp: NightRamp,
  imageRects: ReadonlyArray<PixelRect> = [],
  options: NightOptions = {},
): void {
  const original = imageRects.length > 0 ? new Uint8ClampedArray(rgba) : null;
  applyNight(rgba, ramp, options);
  if (original) restoreRegions(rgba, original, width, height, imageRects);
}

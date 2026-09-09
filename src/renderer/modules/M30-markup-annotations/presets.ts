/**
 * Colour and font presets (M30). Data, not code: `resources/annotations/colours.json` and
 * `resources/annotations/fonts.json`, per PLAN.md §4.4.
 *
 * These are **PDF content colours**, written into the file as `0xRRGGBB`, and so are deliberately
 * not theme tokens: a highlight the reader made yellow stays yellow when the theme changes. The
 * sets are chosen so that no two entries differ only on red-vs-green, and every swatch carries
 * its name as text — a colour picker that says nothing but colour is unusable for this operator.
 */

import colours from '../../../../resources/annotations/colours.json';
import fonts from '../../../../resources/annotations/fonts.json';

/** One preset: a name the reader can read, and the colour it writes. `null` means "no colour". */
export interface ColourPreset {
  readonly name: string;
  readonly value: number | null;
}

interface RawPreset {
  readonly name: string;
  readonly value: string | null;
}

interface ColourCatalogue {
  readonly highlight: ReadonlyArray<RawPreset>;
  readonly ink: ReadonlyArray<RawPreset>;
  readonly fill: ReadonlyArray<RawPreset>;
  readonly defaults: Readonly<Record<string, string>>;
}

interface FontCatalogue {
  readonly base: ReadonlyArray<string>;
  readonly suggested: ReadonlyArray<string>;
  readonly sizes: ReadonlyArray<number>;
}

const raw = colours as unknown as ColourCatalogue;
const fontData = fonts as unknown as FontCatalogue;

function parse(list: ReadonlyArray<RawPreset>): ColourPreset[] {
  return list.map((p) => ({
    name: p.name,
    value: p.value === null ? null : Number.parseInt(p.value, 16) & 0xffffff,
  }));
}

/** Backgrounds for text markup: pale enough that words under them still read. */
export const HIGHLIGHT_PRESETS: ReadonlyArray<ColourPreset> = parse(raw.highlight);
/** Line and text colours. */
export const INK_PRESETS: ReadonlyArray<ColourPreset> = parse(raw.ink);
/** Interior colours for a text box, including "None". */
export const FILL_PRESETS: ReadonlyArray<ColourPreset> = parse(raw.fill);

/** The name of a colour, for the swatch's label and its accessible name. */
export function colourName(value: number | null): string {
  if (value === null) return 'None';
  for (const list of [HIGHLIGHT_PRESETS, INK_PRESETS, FILL_PRESETS]) {
    const found = list.find((p) => p.value === value);
    if (found) return found.name;
  }
  return `#${(value & 0xffffff).toString(16).padStart(6, '0').toUpperCase()}`;
}

/** The colour a tool starts with, before the reader has set a default of their own. */
export function defaultColourFor(tool: string): number {
  const hex = raw.defaults[tool];
  return hex === undefined ? 0x000000 : Number.parseInt(hex, 16) & 0xffffff;
}

/** The families offered first: the standard 14, which need no embedding anywhere. */
export const BASE_FONT_FAMILIES: ReadonlyArray<string> = fontData.base;
/** Families worth offering above the system list when the machine has them. */
export const SUGGESTED_FONT_FAMILIES: ReadonlyArray<string> = fontData.suggested;
/** The sizes the picker lists; any number may still be typed. */
export const FONT_SIZES: ReadonlyArray<number> = fontData.sizes;

/** `0xRRGGBB` from `#rrggbb`, `rrggbb` or `#rgb`, or null when it is not a colour. */
export function parseHexColour(text: string): number | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(text.trim());
  const digits = m?.[1];
  if (digits === undefined) return null;
  const full =
    digits.length === 3
      ? digits
          .split('')
          .map((c) => c + c)
          .join('')
      : digits;
  return Number.parseInt(full, 16) & 0xffffff;
}

/** `0xRRGGBB` as the `#rrggbb` an input and a swatch want. */
export function hexOf(value: number): string {
  // ynot-allow-color: the digits come from the annotation, never from this file.
  return `#${(value & 0xffffff).toString(16).padStart(6, '0')}`;
}

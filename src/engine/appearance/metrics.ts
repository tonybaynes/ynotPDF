/**
 * Standard-14 font metrics (M21) — the widths the appearance generators need to lay text out.
 *
 * Adobe's AFM metrics for the standard fonts have not changed since 1985 and are part of the PDF
 * specification's own furniture, so they live in code rather than under `resources/`: they are
 * not data that can vary. Each table is 224 widths in 1/1000 em for WinAnsi codes 32..255 (a 0
 * means the encoding has no glyph there); the oblique faces share their upright face's widths,
 * which is what the AFM files themselves say. Courier is monospaced at 600 throughout.
 *
 * Generated from `@pdf-lib/standard-fonts` (MIT) and checked against it by
 * `test/unit/engine/appearance.test.ts`, so a drift would fail the build rather than move text.
 */

import type { StandardFontName } from './types';

const FIRST_CODE = 32;
const LAST_CODE = 255;

const HELVETICA =
  '278 278 355 556 556 889 667 191 333 333 389 584 278 333 278 278 556 556 556 556 556 556 556 ' +
  '556 556 556 278 278 584 584 584 556 1015 667 667 722 722 667 611 778 722 278 500 667 556 833 ' +
  '722 778 667 778 722 667 611 722 667 944 667 667 611 278 278 278 469 556 333 556 556 500 556 ' +
  '556 278 556 556 222 222 500 222 833 556 556 556 556 333 500 278 556 500 722 500 500 500 334 ' +
  '260 334 584 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 278 333 556 ' +
  '556 556 556 260 556 333 737 370 556 584 333 737 333 400 584 333 333 333 556 537 278 333 333 ' +
  '365 556 834 834 834 611 667 667 667 667 667 667 1000 722 667 667 667 667 278 278 278 278 722 ' +
  '722 778 778 778 778 778 584 778 722 722 722 722 667 667 611 556 556 556 556 556 556 889 500 ' +
  '556 556 556 556 278 278 278 278 556 556 556 556 556 556 556 584 611 556 556 556 556 500 556 ' +
  '500 ';

const HELVETICA_BOLD =
  '278 333 474 556 556 889 722 238 333 333 389 584 278 333 278 278 556 556 556 556 556 556 556 ' +
  '556 556 556 333 333 584 584 584 611 975 722 722 722 722 667 611 778 722 278 556 722 611 833 ' +
  '722 778 667 778 722 667 611 722 667 944 667 667 611 333 278 333 584 556 333 556 611 556 611 ' +
  '556 333 611 611 278 278 556 278 889 611 611 611 611 389 556 333 611 556 778 556 556 500 389 ' +
  '280 389 584 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 278 333 556 ' +
  '556 556 556 280 556 333 737 370 556 584 333 737 333 400 584 333 333 333 611 556 278 333 333 ' +
  '365 556 834 834 834 611 722 722 722 722 722 722 1000 722 667 667 667 667 278 278 278 278 722 ' +
  '722 778 778 778 778 778 584 778 722 722 722 722 667 667 611 556 556 556 556 556 556 889 556 ' +
  '556 556 556 556 278 278 278 278 611 611 611 611 611 611 611 584 611 611 611 611 611 556 611 ' +
  '556 ';

const TIMES_ROMAN =
  '250 333 408 500 500 833 778 180 333 333 500 564 250 333 250 278 500 500 500 500 500 500 500 ' +
  '500 500 500 278 278 564 564 564 444 921 722 667 667 722 611 556 722 722 333 389 722 611 889 ' +
  '722 722 556 722 667 556 611 722 722 944 722 722 611 333 278 333 469 500 333 444 500 444 500 ' +
  '444 333 500 500 278 278 500 278 778 500 500 500 500 333 389 278 500 500 722 500 500 444 480 ' +
  '200 480 541 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 250 333 500 ' +
  '500 500 500 200 500 333 760 276 500 564 333 760 333 400 564 300 300 333 500 453 250 333 300 ' +
  '310 500 750 750 750 444 722 722 722 722 722 722 889 667 611 611 611 611 333 333 333 333 722 ' +
  '722 722 722 722 722 722 564 722 722 722 722 722 722 556 500 444 444 444 444 444 444 667 444 ' +
  '444 444 444 444 278 278 278 278 500 500 500 500 500 500 500 564 500 500 500 500 500 500 500 ' +
  '500 ';

const TIMES_BOLD =
  '250 333 555 500 500 1000 833 278 333 333 500 570 250 333 250 278 500 500 500 500 500 500 500 ' +
  '500 500 500 333 333 570 570 570 500 930 722 667 722 722 667 611 778 778 389 500 778 667 944 ' +
  '722 778 611 778 722 556 667 722 722 1000 722 722 667 333 278 333 581 500 333 500 556 444 556 ' +
  '444 333 500 556 278 333 556 278 833 556 500 556 556 444 389 333 556 500 722 500 500 444 394 ' +
  '220 394 520 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 250 333 500 ' +
  '500 500 500 220 500 333 747 300 500 570 333 747 333 400 570 300 300 333 556 540 250 333 300 ' +
  '330 500 750 750 750 500 722 722 722 722 722 722 1000 722 667 667 667 667 389 389 389 389 722 ' +
  '722 778 778 778 778 778 570 778 722 722 722 722 722 611 556 500 500 500 500 500 500 722 444 ' +
  '444 444 444 444 278 278 278 278 500 556 500 500 500 500 500 570 500 556 556 556 556 500 556 ' +
  '500 ';

const TIMES_ITALIC =
  '250 333 420 500 500 833 778 214 333 333 500 675 250 333 250 278 500 500 500 500 500 500 500 ' +
  '500 500 500 333 333 675 675 675 500 920 611 611 667 722 611 611 722 722 333 444 667 556 833 ' +
  '667 722 611 722 611 500 556 722 611 833 611 556 556 389 278 389 422 500 333 500 500 444 500 ' +
  '444 278 500 500 278 278 444 278 722 500 500 500 500 389 389 278 500 444 667 444 444 389 400 ' +
  '275 400 541 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 250 389 500 ' +
  '500 500 500 275 500 333 760 276 500 675 333 760 333 400 675 300 300 333 500 523 250 333 300 ' +
  '310 500 750 750 750 500 611 611 611 611 611 611 889 667 611 611 611 611 333 333 333 333 722 ' +
  '667 722 722 722 722 722 675 722 722 722 722 722 556 611 500 500 500 500 500 500 500 667 444 ' +
  '444 444 444 444 278 278 278 278 500 500 500 500 500 500 500 675 500 500 500 500 500 444 500 ' +
  '444 ';

const TIMES_BOLDITALIC =
  '250 389 555 500 500 833 778 278 333 333 500 570 250 333 250 278 500 500 500 500 500 500 500 ' +
  '500 500 500 333 333 570 570 570 500 832 667 667 667 722 667 667 722 778 389 500 667 611 889 ' +
  '722 722 611 722 667 556 611 722 667 889 667 611 611 333 278 333 570 500 333 500 500 444 500 ' +
  '444 333 500 556 278 278 500 278 778 556 500 500 500 389 389 278 556 444 667 500 444 389 348 ' +
  '220 348 570 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 250 389 500 ' +
  '500 500 500 220 500 333 747 266 500 606 333 747 333 400 570 300 300 333 576 500 250 333 300 ' +
  '300 500 750 750 750 500 667 667 667 667 667 667 944 667 667 667 667 667 389 389 389 389 722 ' +
  '722 722 722 722 722 722 570 722 722 722 722 722 611 611 500 500 500 500 500 500 500 722 444 ' +
  '444 444 444 444 278 278 278 278 500 556 500 500 500 500 500 570 500 556 556 556 556 444 500 ' +
  '444 ';

/** Courier and its three variants are monospaced. */
const COURIER_WIDTH = 600;

function unpack(packed: string): ReadonlyArray<number> {
  return packed.trim().split(' ').map(Number);
}

const TABLES: Readonly<Record<string, ReadonlyArray<number>>> = {
  Helvetica: unpack(HELVETICA),
  'Helvetica-Bold': unpack(HELVETICA_BOLD),
  'Times-Roman': unpack(TIMES_ROMAN),
  'Times-Bold': unpack(TIMES_BOLD),
  'Times-Italic': unpack(TIMES_ITALIC),
  'Times-BoldItalic': unpack(TIMES_BOLDITALIC),
};

/** The upright face whose widths a font shares. Oblique/italic Helvetica matches its upright. */
const ALIASES: Readonly<Record<string, string>> = {
  'Helvetica-Oblique': 'Helvetica',
  'Helvetica-BoldOblique': 'Helvetica-Bold',
};

/**
 * Width of one code point in 1/1000 em. Codes outside WinAnsi, and glyphs the encoding does not
 * have, measure as a space — the same fallback the viewer will make when it draws the text.
 */
export function glyphWidth(font: StandardFontName, code: number): number {
  if (font.startsWith('Courier')) return COURIER_WIDTH;
  // Symbol and ZapfDingbats are not text fonts; nothing here lays text out in them.
  const table = TABLES[ALIASES[font] ?? font];
  if (!table) return COURIER_WIDTH;
  if (code < FIRST_CODE || code > LAST_CODE) return table[0] ?? COURIER_WIDTH;
  const width = table[code - FIRST_CODE] ?? 0;
  return width === 0 ? (table[0] ?? COURIER_WIDTH) : width;
}

/** Width of a string in points at `size`. */
export function textWidth(text: string, font: StandardFontName, size: number): number {
  let total = 0;
  for (const ch of text) total += glyphWidth(font, ch.codePointAt(0) ?? 32);
  return (total * size) / 1000;
}

/**
 * Greedy word wrap to `maxWidth` points. A word longer than the line is broken by character
 * rather than allowed to run past the edge of the box, because an annotation clips to its BBox
 * and text that runs off it simply disappears.
 */
export function wrapText(
  text: string,
  font: StandardFontName,
  size: number,
  maxWidth: number,
): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split(/\r\n|\r|\n/)) {
    if (paragraph === '') {
      lines.push('');
      continue;
    }
    let line = '';
    for (const word of paragraph.split(' ')) {
      const candidate = line === '' ? word : `${line} ${word}`;
      if (textWidth(candidate, font, size) <= maxWidth) {
        line = candidate;
        continue;
      }
      if (line !== '') {
        lines.push(line);
        line = '';
      }
      if (textWidth(word, font, size) <= maxWidth) {
        line = word;
        continue;
      }
      // A single word wider than the whole line: break it by character rather than let it run
      // past the BBox, where the viewer would clip it away entirely.
      for (const ch of word) {
        if (line !== '' && textWidth(line + ch, font, size) > maxWidth) {
          lines.push(line);
          line = ch;
        } else {
          line += ch;
        }
      }
    }
    lines.push(line);
  }
  return lines;
}

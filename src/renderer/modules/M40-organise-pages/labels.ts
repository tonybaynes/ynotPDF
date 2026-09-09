/**
 * Page labels, the UI half (M40).
 *
 * The numbering itself — the five `/S` styles, the numerals, and reading a label back as a
 * numbering — lives in `src/engine/pageLabels.ts`, because M21's writer needs exactly the same
 * answers and two implementations of a roman numeral are two chances to disagree. What is here
 * is what only the interface needs: the wording of the choices, a whole document's worth of
 * labels after a range is renumbered, and the default the dialog opens on.
 */

import {
  LABEL_STYLE_KEY,
  decodeLabel,
  fromAlpha,
  fromRoman,
  numeral,
  toAlpha,
  toRoman,
  type DecodedLabel,
  type LabelStyle,
} from '@engine/pageLabels';

export {
  LABEL_STYLE_KEY,
  decodeLabel,
  fromAlpha,
  fromRoman,
  numeral,
  toAlpha,
  toRoman,
  type DecodedLabel,
  type LabelStyle,
};

/**
 * What the Page Numbering dialog offers, in the order it offers it.
 *
 * Each is named by what it looks like rather than by its `/S` letter, because "r" is not
 * something a reader should have to know, and an example says it in less space than a
 * description would.
 */
export const LABEL_STYLES: ReadonlyArray<{ readonly value: LabelStyle; readonly label: string }> = [
  { value: 'decimal', label: 'Numbers — 1, 2, 3' },
  { value: 'romanLower', label: 'Roman, small — i, ii, iii' },
  { value: 'romanUpper', label: 'Roman, capital — I, II, III' },
  { value: 'alphaLower', label: 'Letters, small — a, b, c' },
  { value: 'alphaUpper', label: 'Letters, capital — A, B, C' },
  { value: 'none', label: 'No number — prefix only' },
];

export interface LabelSpec {
  readonly style: LabelStyle;
  /** Text before the number. `"A-"` gives "A-1", "A-2". */
  readonly prefix: string;
  /** The number the first page of the range takes. At least 1, as `/St` requires. */
  readonly start: number;
}

export const DEFAULT_LABEL_SPEC: LabelSpec = { style: 'decimal', prefix: '', start: 1 };

/** One page's label: the prefix and the numbering, or just the prefix for `none`. */
export function formatLabel(spec: LabelSpec, offset: number): string {
  const n = Math.max(1, Math.floor(spec.start)) + Math.max(0, Math.floor(offset));
  return `${spec.prefix}${numeral(spec.style, n)}`;
}

/**
 * The labels a whole document has after `pages` are renumbered with `spec`.
 *
 * Pages outside the range keep what they had, so numbering the front matter does not disturb the
 * body. The range's own pages are numbered in **document order** from `start`, whatever order the
 * caller listed them in: "number pages 5, 2 and 3 starting at 1" can only sensibly mean that 2, 3
 * and 5 become 1, 2 and 3.
 */
export function labelsForRange(
  current: ReadonlyArray<string>,
  pages: ReadonlyArray<number>,
  spec: LabelSpec,
): string[] {
  const out = [...current];
  const ordered = [...new Set(pages)].filter((p) => p >= 0 && p < out.length).sort((a, b) => a - b);
  ordered.forEach((page, offset) => {
    out[page] = formatLabel(spec, offset);
  });
  return out;
}

/**
 * The labels a document has when nothing has ever been numbered: `"1"`, `"2"`, … That is what
 * `PdfEngine.pageLabels` reports for a file with no `/PageLabels`, and what "remove the numbering
 * from these pages" restores.
 */
export function defaultLabels(pageCount: number): string[] {
  return Array.from({ length: Math.max(0, pageCount) }, (_, i) => String(i + 1));
}

/**
 * Page-label numbering (`/PageLabels`, ISO 32000-1 §12.4.2). Pure, and engine-side on purpose.
 *
 * A PDF does not store one string per page. It stores *ranges*, each with a numbering **style**
 * (`/S`: `D`, `r`, `R`, `a`, `A`), an optional **prefix** (`/P`) and a **start** value (`/St`).
 * The document model holds the resolved strings, because that is what a page field and a
 * thumbnail show — so something has to translate, and it has to translate both ways:
 *
 * - **out**, when M40's Page Numbering dialog turns (style, prefix, start) into strings;
 * - **in**, when M21's writer reads a run of strings back and recognises it as a numbering, so
 *   "i, ii, iii, …" is written as one `/S /r` range rather than as a hundred literal entries.
 *
 * It lives under `src/engine/` because the writer needs it and nothing under `src/engine/` may
 * import from `src/renderer/` (ADR 0010). M40's `labels.ts` builds the UI wording on top.
 *
 * Everything here is **exactly reversible**: `decodeLabel(formatted) === the numbering that made
 * it`, or `null`. A string that cannot be described as a numbering stays a literal, which is the
 * only way a label like "Cover" or "007" can survive a round-trip.
 */

/** `/S` values, plus `none` for a range that has a prefix and no number. */
export type LabelStyle =
  'decimal' | 'romanLower' | 'romanUpper' | 'alphaLower' | 'alphaUpper' | 'none';

/** The `/S` name each style is written as. `none` has no `/S` entry at all. */
export const LABEL_STYLE_KEY: Readonly<Record<LabelStyle, string | null>> = {
  decimal: 'D',
  romanLower: 'r',
  romanUpper: 'R',
  alphaLower: 'a',
  alphaUpper: 'A',
  none: null,
};

/** The numeric part of a label. Empty for `none`. */
export function numeral(style: LabelStyle, n: number): string {
  switch (style) {
    case 'decimal':
      return String(n);
    case 'romanLower':
      return toRoman(n).toLowerCase();
    case 'romanUpper':
      return toRoman(n);
    case 'alphaLower':
      return toAlpha(n).toLowerCase();
    case 'alphaUpper':
      return toAlpha(n);
    case 'none':
      return '';
  }
}

/** A label understood as a numbering: the prefix, the style and the value. */
export interface DecodedLabel {
  readonly prefix: string;
  readonly style: LabelStyle;
  readonly value: number;
}

/**
 * Reads a label string as (prefix, style, number), or `null` when nothing sensible fits.
 *
 * The order is the order of confidence, and it matters. Decimal first, because `"12"` is a number
 * and never a numeral. Then roman, then alphabetic — so `"I"`, `"II"`, `"III"` decodes as roman
 * 1, 2, 3, which is a run, rather than as the letters 9, 35, 61, which is not; and that is what
 * makes the writer choose `/S /R` for it.
 *
 * A leading zero is refused: `"007"` cannot be written as `/S /D` with `/St 7`, because every
 * reader would render that as `"7"`. Such a label stays a literal.
 */
export function decodeLabel(label: string): DecodedLabel | null {
  const decimal = /^(.*?)([1-9]\d*)$/u.exec(label);
  if (decimal) {
    const [, prefix = '', digits = ''] = decimal;
    // A prefix ending in a digit means the split ate a leading zero: "007" would be written as
    // `/P (00) /St 7`, which is reversible but says the page is *numbered* seven when the
    // reader wrote a literal. Leave it as a literal.
    if (!/\d$/u.test(prefix)) return { prefix, style: 'decimal', value: Number(digits) };
    return null;
  }
  const roman = /^(.*?)([ivxlcdm]+|[IVXLCDM]+)$/u.exec(label);
  if (roman) {
    const [, prefix = '', numerals = ''] = roman;
    const value = fromRoman(numerals.toUpperCase());
    // Only a *canonical* numeral round-trips; "IIII" would come back as "IV".
    if (value !== null && toRoman(value) === numerals.toUpperCase() && !endsInLetter(prefix)) {
      return {
        prefix,
        style: numerals === numerals.toLowerCase() ? 'romanLower' : 'romanUpper',
        value,
      };
    }
  }
  const alpha = /^(.*?)(([a-z])\3*|([A-Z])\4*)$/u.exec(label);
  if (alpha) {
    const [, prefix = '', letters = ''] = alpha;
    const value = fromAlpha(letters);
    if (value !== null && !endsInLetter(prefix)) {
      return {
        prefix,
        style: letters === letters.toLowerCase() ? 'alphaLower' : 'alphaUpper',
        value,
      };
    }
  }
  return null;
}

/**
 * Whether a prefix ends in a letter, which means the split into (prefix, numeral) fell in the
 * middle of a word.
 *
 * Without this, "Cover" reads as the prefix "Cove" numbered "r" — the eighteenth letter — and a
 * title page would be written into the file as a numbering. It renders back correctly, so
 * nothing breaks; it is simply not what the reader wrote, and a later insert in another
 * application would carry the numbering on into nonsense. A real prefix ends in a separator or a
 * space: "A-", "Appendix ", "".
 */
function endsInLetter(prefix: string): boolean {
  return /\p{L}$/u.test(prefix);
}
const ROMAN: ReadonlyArray<readonly [number, string]> = [
  [1000, 'M'],
  [900, 'CM'],
  [500, 'D'],
  [400, 'CD'],
  [100, 'C'],
  [90, 'XC'],
  [50, 'L'],
  [40, 'XL'],
  [10, 'X'],
  [9, 'IX'],
  [5, 'V'],
  [4, 'IV'],
  [1, 'I'],
];

/**
 * Roman numerals, capitals. Above 3999 the classical notation needs overbars a PDF cannot write,
 * so the thousands are repeated `M`s — which is what readers do, and stays exactly reversible.
 */
export function toRoman(n: number): string {
  let value = Math.max(1, Math.floor(n));
  let out = '';
  for (const [amount, digits] of ROMAN) {
    while (value >= amount) {
      out += digits;
      value -= amount;
    }
  }
  return out;
}

/** The value of a capital numeral, or `null` when the text is not one. */
export function fromRoman(text: string): number | null {
  if (!/^[IVXLCDM]+$/u.test(text)) return null;
  const single: Readonly<Record<string, number>> = {
    I: 1,
    V: 5,
    X: 10,
    L: 50,
    C: 100,
    D: 500,
    M: 1000,
  };
  let total = 0;
  for (let i = 0; i < text.length; i++) {
    const here = single[text[i] ?? ''] ?? 0;
    const next = single[text[i + 1] ?? ''] ?? 0;
    total += here < next ? -here : here;
  }
  return total > 0 ? total : null;
}

/**
 * The format's alphabetic numbering: `A`…`Z`, then `AA`…`ZZ`, then `AAA`… — the letter is
 * *repeated*, not carried like a spreadsheet column, so 27 is `"AA"` and never `"AB"`.
 */
export function toAlpha(n: number): string {
  const value = Math.max(1, Math.floor(n));
  const letter = String.fromCharCode(65 + ((value - 1) % 26));
  return letter.repeat(Math.floor((value - 1) / 26) + 1);
}

/** The value of a repeated-letter label, or `null` when the letters are not all the same. */
export function fromAlpha(text: string): number | null {
  if (!/^[A-Za-z]+$/u.test(text)) return null;
  const upper = text.toUpperCase();
  const first = upper[0] ?? '';
  // Every letter must be the same one: "AA" is 27, "AB" is not a label at all.
  if (upper.split('').some((c) => c !== first)) return null;
  return (upper.length - 1) * 26 + (first.charCodeAt(0) - 64);
}

/**
 * The value `label` would have if it were written in `style` after `prefix`, or `null`.
 *
 * This exists because a label can be two things at once. "c" is roman 100 and also the third
 * letter, and `decodeLabel` has to pick one — it picks roman, which is right for "i, ii, iii".
 * But in the run "a, b, c" the third label is plainly the letter, and asking "what would this be
 * as the style we are already in?" is the only way to see that. Without it a run of letters
 * silently splits into three `/Nums` entries at c, d, i, l, m, v and x.
 */
export function valueOfLabelAs(label: string, style: LabelStyle, prefix: string): number | null {
  if (!label.startsWith(prefix)) return null;
  const rest = label.slice(prefix.length);
  if (style === 'none') return rest === '' ? 1 : null;
  if (style === 'decimal') return /^[1-9]\d*$/u.test(rest) ? Number(rest) : null;
  if (style === 'romanLower' || style === 'romanUpper') {
    const wanted = style === 'romanLower' ? rest.toLowerCase() : rest.toUpperCase();
    if (rest !== wanted) return null;
    const value = fromRoman(rest.toUpperCase());
    return value !== null && toRoman(value) === rest.toUpperCase() ? value : null;
  }
  const wanted = style === 'alphaLower' ? rest.toLowerCase() : rest.toUpperCase();
  if (rest !== wanted) return null;
  return fromAlpha(rest);
}

/** One `/Nums` entry: a `/P` literal, or a numbering that starts at this page. */
export interface LabelRange {
  readonly index: number;
  readonly entry: {
    readonly S?: string;
    readonly P?: string;
    readonly St?: number;
  };
}

/**
 * Turns per-page label strings into the `/Nums` entries of a `/PageLabels` tree.
 *
 * A run is any sequence of labels that share a prefix and a style and count up by one; it becomes
 * a single entry. Anything else gets a `/P` literal of its own, which reproduces the string
 * whatever it is — a title page called "Cover", a label with a leading zero, an empty one.
 *
 * A run of one is still written as a numbering rather than a literal, because that is what makes
 * a page *numbered* rather than *named*: a reader who inserts a page after it should see the
 * count continue.
 */
export function pageLabelNums(labels: ReadonlyArray<string>): LabelRange[] {
  const out: LabelRange[] = [];
  let i = 0;
  while (i < labels.length) {
    const decoded = decodeLabel(labels[i] ?? '');
    if (!decoded) {
      out.push({ index: i, entry: { P: labels[i] ?? '' } });
      i++;
      continue;
    }
    let end = i + 1;
    while (end < labels.length) {
      // Asked *in the style of the run*, not by best guess: see `valueOfLabelAs`.
      const next = valueOfLabelAs(labels[end] ?? '', decoded.style, decoded.prefix);
      if (next !== decoded.value + (end - i)) break;
      end++;
    }
    const style = LABEL_STYLE_KEY[decoded.style];
    const entry: { S?: string; P?: string; St?: number } = {};
    if (style !== null) entry.S = style;
    if (decoded.prefix !== '') entry.P = decoded.prefix;
    entry.St = decoded.value;
    out.push({ index: i, entry });
    i = end;
  }
  return out;
}

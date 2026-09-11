/**
 * WinAnsi text for decorations (M53).
 *
 * The standard 14 fonts are the only ones this application can write without a subsetter, and
 * they are encoded in WinAnsi. A content stream carries **bytes**, so a curly apostrophe has to
 * become byte 0x92 before it reaches the stream — as the character U+2019 it would either be
 * dropped or, worse, written as two bytes that a viewer reads as two letters.
 *
 * The 27 characters WinAnsi puts in 0x80–0x9F are exactly the ones a header picks up from a word
 * processor: curly quotes, en and em dashes, the ellipsis, the euro. They are mapped here; the
 * rest of Latin-1 is already its own byte, and anything else is reported so the dialog can say
 * which characters this font cannot write rather than quietly printing a question mark.
 */

/** U+ code point → WinAnsi byte, for the range where the two disagree. */
const WIN_ANSI_HIGH: Readonly<Record<number, number>> = {
  0x20ac: 0x80, // €
  0x201a: 0x82, // ‚
  0x0192: 0x83, // ƒ
  0x201e: 0x84, // „
  0x2026: 0x85, // …
  0x2020: 0x86, // †
  0x2021: 0x87, // ‡
  0x02c6: 0x88, // ˆ
  0x2030: 0x89, // ‰
  0x0160: 0x8a, // Š
  0x2039: 0x8b, // ‹
  0x0152: 0x8c, // Œ
  0x017d: 0x8e, // Ž
  0x2018: 0x91, // '
  0x2019: 0x92, // '
  0x201c: 0x93, // "
  0x201d: 0x94, // "
  0x2022: 0x95, // •
  0x2013: 0x96, // –
  0x2014: 0x97, // —
  0x02dc: 0x98, // ˜
  0x2122: 0x99, // ™
  0x0161: 0x9a, // š
  0x203a: 0x9b, // ›
  0x0153: 0x9c, // œ
  0x017e: 0x9e, // ž
  0x0178: 0x9f, // Ÿ
};

/** What a decoration's text becomes on the page, and what had to be left out. */
export interface WinAnsiText {
  /** One JS char per byte, each char code being the WinAnsi byte. */
  readonly text: string;
  /** Characters the encoding has no room for, in the order they appeared, without repeats. */
  readonly dropped: ReadonlyArray<string>;
}

/**
 * Converts text to WinAnsi. A character the encoding cannot hold is replaced by `?` — the same
 * thing every other viewer does — and reported in `dropped` so the reader is told rather than
 * left to find it on the page.
 */
export function toWinAnsi(value: string): WinAnsiText {
  let text = '';
  const dropped: string[] = [];
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (code === 0x0a || code === 0x0d || code === 0x09) {
      text += ch;
      continue;
    }
    if (code >= 0x20 && code <= 0x7e) {
      text += ch;
      continue;
    }
    if (code >= 0xa0 && code <= 0xff) {
      text += ch;
      continue;
    }
    const mapped = WIN_ANSI_HIGH[code];
    if (mapped !== undefined) {
      text += String.fromCharCode(mapped);
      continue;
    }
    text += '?';
    if (!dropped.includes(ch)) dropped.push(ch);
  }
  return { text, dropped };
}

/** Just the converted text, for the many callers that do not report. */
export function winAnsi(value: string): string {
  return toWinAnsi(value).text;
}

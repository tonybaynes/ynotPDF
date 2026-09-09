/**
 * Text a comment summary can actually draw (M32). Pure.
 *
 * A summary is written with the standard Helvetica, which is WinAnsi-encoded, and pdf-lib throws
 * rather than substituting when it meets a character outside it — so a reviewer writing in Greek
 * or Polish would otherwise make the summary fail to build. Look-alikes are mapped, control
 * characters are dropped, and anything genuinely outside the encoding becomes `?`.
 *
 * Embedding a Unicode face instead needs a font subsetter, which this repo does not have before
 * M51. The limit is real and it is stated in the module's README; a summary that says `?` is
 * better than one that refuses to exist.
 *
 * It runs during *layout*, not only at draw time, so the width the wrapper measures is the width
 * of the text that is drawn.
 */

/**
 * The code points WinAnsi (CP1252) carries beyond Latin-1: the 27 typographic characters it puts
 * in 0x80–0x9F (PDF 32000-1, annex D.2).
 */
const WINANSI_EXTRA = new Set([
  0x20ac, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152,
  0x017d, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a,
  0x0153, 0x017e, 0x0178,
]);

/** Characters with a WinAnsi look-alike, so a substitution reads rather than blanks. */
const SUBSTITUTES = new Map<number, string>([
  [0x00a0, ' '], // no-break space
  [0x2007, ' '], // figure space
  [0x2009, ' '], // thin space
  [0x202f, ' '], // narrow no-break space
  [0x2011, '-'], // non-breaking hyphen
  [0x2012, '-'], // figure dash
  [0x2015, '—'], // horizontal bar → em dash
  [0x2212, '-'], // minus sign
  [0x2044, '/'], // fraction slash
  [0x2060, ''], // word joiner
  [0x200b, ''], // zero-width space
  [0xfeff, ''], // byte-order mark
]);

export function toDrawableText(value: string): string {
  let out = '';
  for (const char of value.normalize('NFC')) {
    const code = char.codePointAt(0) ?? 0;
    const mapped = SUBSTITUTES.get(code);
    if (mapped !== undefined) {
      out += mapped;
      continue;
    }
    if (code === 0x09) {
      out += '    ';
    } else if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
      // A control character is not text; a line break has already become a line of its own.
      continue;
    } else if (code <= 0xff || WINANSI_EXTRA.has(code)) {
      out += char;
    } else {
      out += '?';
    }
  }
  return out;
}

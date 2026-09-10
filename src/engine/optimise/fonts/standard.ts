/**
 * Which fonts may be unembedded (M100).
 *
 * Removing a font program is the one optimisation that can make a document unreadable somewhere
 * else: the reader's machine has to have a font of that name, or something metrically identical,
 * or the text reflows and the page is wrong. So the list is short and closed.
 *
 * - The **Standard 14** (ISO 32000-1 §9.6.2.2), which every conforming reader is required to
 *   have — that is what "standard" means in the spec, and it is the whole reason this is safe.
 * - The four families that are **metrically identical** to them and that every desktop reader
 *   substitutes for them anyway: Arial for Helvetica, Times New Roman for Times, Courier New for
 *   Courier, plus the two symbol faces. PDFium does this substitution itself
 *   (`src/engine/pdfium/fonts.ts`), so a document we unembed here renders the same in our own
 *   viewer as it did before.
 *
 * Everything else keeps its font program, however common the name looks. "Calibri" is on every
 * Windows machine and on almost no Mac; "Helvetica Neue" is the reverse. A saving of 200 KB is
 * not worth a document that is wrong on half the computers that open it.
 */

/** The Standard 14 as `/BaseFont` spells them. */
const STANDARD_14 = [
  'Helvetica',
  'Helvetica-Bold',
  'Helvetica-Oblique',
  'Helvetica-BoldOblique',
  'Courier',
  'Courier-Bold',
  'Courier-Oblique',
  'Courier-BoldOblique',
  'Times-Roman',
  'Times-Bold',
  'Times-Italic',
  'Times-BoldItalic',
  'Symbol',
  'ZapfDingbats',
];

/** Metric-compatible families, by base name with the style suffix already taken off. */
const COMPATIBLE_FAMILIES = new Set([
  'arial',
  'arialmt',
  'helvetica',
  'timesnewroman',
  'timesnewromanpsmt',
  'times',
  'couriernew',
  'couriernewpsmt',
  'courier',
  'symbol',
  'zapfdingbats',
]);

/**
 * Whether a `/BaseFont` names a font a reader is certain to be able to substitute.
 *
 * A subset prefix (`ABCDEF+`) is stripped first: a subset of Arial is still Arial as far as the
 * substitution goes, and the six letters are exactly what the spec puts there to say "this font
 * program is not the whole family".
 */
export function isSafeToUnembed(baseFont: string): boolean {
  const name = stripSubsetPrefix(baseFont);
  if (STANDARD_14.includes(name)) return true;
  const [family = ''] = name.split(/[,-]/);
  return COMPATIBLE_FAMILIES.has(family.toLowerCase().replace(/\s+/g, ''));
}

/** `"ABCDEF+DejaVuSans"` → `"DejaVuSans"`; anything else is returned unchanged. */
export function stripSubsetPrefix(baseFont: string): string {
  const name = baseFont.startsWith('/') ? baseFont.slice(1) : baseFont;
  return /^[A-Z]{6}\+/.test(name) ? name.slice(7) : name;
}

export { STANDARD_14 };

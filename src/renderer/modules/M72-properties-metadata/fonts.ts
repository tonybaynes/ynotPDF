/**
 * The Fonts tab's vocabulary (M72).
 *
 * Turning `FontUsage` into the words the tab shows, kept out of the DOM code so the mapping is
 * unit-testable and so the same words can be reused by a report later. Every status is a word:
 * "Embedded subset" rather than a coloured dot, because a colour is exactly what the operator
 * cannot read.
 */

import type { FontUsage } from '@engine/PdfEngine';

/** How a font's type reads in the tab. Type0 shows what it actually is underneath. */
export function fontTypeLabel(font: FontUsage): string {
  switch (font.type) {
    case 'Type1':
      return 'Type 1';
    case 'MMType1':
      return 'Multiple Master Type 1';
    case 'TrueType':
      return 'TrueType';
    case 'Type3':
      return 'Type 3';
    case 'Type0':
      switch (font.descendantType) {
        case 'CIDFontType0':
          return 'Type 0 (CID Type 1)';
        case 'CIDFontType2':
          return 'Type 0 (CID TrueType)';
        default:
          return 'Type 0';
      }
    case 'CIDFontType0':
      return 'CID Type 1';
    case 'CIDFontType2':
      return 'CID TrueType';
    default:
      return 'Unknown';
  }
}

/** Embedding, in words. The three states a reader cares about are three different sentences. */
export function embeddingLabel(font: FontUsage): string {
  if (!font.embedded) return 'Not embedded';
  return font.subset ? 'Embedded subset' : 'Embedded';
}

/** The icon that goes with {@link embeddingLabel}. Never the only cue — the word is always there. */
export function embeddingIcon(font: FontUsage): string {
  if (!font.embedded) return 'circle-alert';
  return font.subset ? 'file-minus' : 'circle-check';
}

/**
 * What the Fonts tab says when a font is not embedded.
 *
 * Worth a sentence rather than a symbol: a document that names Helvetica and does not carry it
 * is fine everywhere, while one naming a licensed corporate face is not, and the reader is the
 * only one who knows which they have.
 */
export function embeddingNote(fonts: ReadonlyArray<FontUsage>): string | null {
  const missing = fonts.filter((f) => !f.embedded);
  if (missing.length === 0) return null;
  const standard = missing.filter((f) => isStandard14(f.name));
  if (standard.length === missing.length) {
    return missing.length === 1
      ? 'One font is not embedded. It is one of the 14 standard fonts, which every PDF reader supplies.'
      : `${String(missing.length)} fonts are not embedded. All of them are standard fonts, which every PDF reader supplies.`;
  }
  return missing.length === 1
    ? 'One font is not embedded, so a reader without it will substitute another and the layout may shift.'
    : `${String(missing.length)} fonts are not embedded, so a reader without them will substitute others and the layout may shift.`;
}

/** The 14 fonts every PDF reader is required to have (ISO 32000-1 §9.6.2.2). */
const STANDARD_14: ReadonlySet<string> = new Set([
  'Times-Roman',
  'Times-Bold',
  'Times-Italic',
  'Times-BoldItalic',
  'Helvetica',
  'Helvetica-Bold',
  'Helvetica-Oblique',
  'Helvetica-BoldOblique',
  'Courier',
  'Courier-Bold',
  'Courier-Oblique',
  'Courier-BoldOblique',
  'Symbol',
  'ZapfDingbats',
]);

export function isStandard14(name: string): boolean {
  return STANDARD_14.has(name);
}

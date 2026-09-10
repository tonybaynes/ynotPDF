/**
 * The fonts a field may be drawn in (M60).
 *
 * The standard 14 only, and deliberately: a form field's `/DA` names a font by a key in the
 * form's `/DR /Font`, and a font that is not embedded is resolved by whatever the reader has.
 * The standard 14 are the ones every reader is required to have, so a form written with them
 * looks the same everywhere. A system family would need embedding to be safe, and there is no
 * subsetter in this repo before M51 — M30 made the same call for free text and says so in words
 * in its own panel.
 */

import type { StandardFontName } from '@engine/appearance/types';

export const STANDARD_FONT_NAMES: ReadonlyArray<StandardFontName> = [
  'Helvetica',
  'Helvetica-Bold',
  'Helvetica-Oblique',
  'Helvetica-BoldOblique',
  'Times-Roman',
  'Times-Bold',
  'Times-Italic',
  'Times-BoldItalic',
  'Courier',
  'Courier-Bold',
  'Courier-Oblique',
  'Courier-BoldOblique',
  'Symbol',
  'ZapfDingbats',
];

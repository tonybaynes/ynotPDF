/**
 * Renders every stamp in `resources/stamps/catalogue.json` to a vector PDF beside it (M31).
 *
 * The app does not read these files — it draws each stamp from the catalogue through
 * `src/engine/appearance/stamp.ts` — but the brief asks for a vector PDF per stamp, they are what
 * another tool would import, and generating them from the same drawing code is what keeps the two
 * in step. Deterministic: fixed dates, no object streams, so a regeneration that changes nothing
 * produces identical bytes.
 *
 * A dynamic stamp is rendered with its tokens shown as themselves (`{name}`, `{date}`), because
 * a file cannot know who will place it or when.
 *
 * Usage: `node scripts/make-stamps.ts` (writes into resources/stamps/).
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PDFDocument, PDFName, StandardFonts } from 'pdf-lib';
import { parseStampCatalogue, stampDrawing, stampForm } from '../src/engine/appearance/stamp.ts';

const DIR = join(process.cwd(), 'resources', 'stamps');
mkdirSync(DIR, { recursive: true });
const FIXED_DATE = new Date('2026-01-01T00:00:00Z');

const catalogue = parseStampCatalogue(
  JSON.parse(readFileSync(join(DIR, 'catalogue.json'), 'utf8')) as unknown,
);

for (const definition of catalogue.stamps) {
  const drawing = stampDrawing(definition.lines, definition.color);
  const form = stampForm(drawing);
  const doc = await PDFDocument.create();
  doc.setTitle(`${definition.label} stamp`);
  doc.setProducer('ynotPDF make-stamps');
  doc.setCreator('ynotPDF make-stamps');
  doc.setCreationDate(FIXED_DATE);
  doc.setModificationDate(FIXED_DATE);
  const page = doc.addPage([drawing.width, drawing.height]);
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  // The form's content names its font `/F1`; the page's resources say what that is.
  const fontName = Object.keys(form.resources.fonts)[0] ?? 'F1';
  page.node.setFontDictionary(PDFName.of(fontName), font.ref);
  page.pushOperators();
  const stream = doc.context.flateStream(form.content);
  const ref = doc.context.register(stream);
  page.node.set(PDFName.of('Contents'), ref);
  const bytes = await doc.save({ useObjectStreams: false, updateFieldAppearances: false });
  const file = join(DIR, `${definition.id}.pdf`);
  writeFileSync(file, bytes);
  console.info(`stamps: ${definition.id}.pdf (${bytes.byteLength} bytes)`);
}
console.info('stamps: done');

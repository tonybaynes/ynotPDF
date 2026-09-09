/**
 * A catalogue stamp as a one-page vector PDF (M31).
 *
 * The app never reads such a file — it draws every stamp from the catalogue through `stamp.ts` —
 * but the brief asks for a vector PDF per stamp, they are what another tool would import, and
 * rendering them from the same drawing code is what keeps the two in step. `npm run stamps`
 * (`scripts/make-stamps.ts`) writes them to `resources/stamps/<id>.pdf`; they are generated, not
 * committed, because the repository refuses every PDF outside `test/fixtures/`.
 *
 * Deterministic: a fixed date, no object streams, so rendering the same definition twice gives
 * identical bytes. A dynamic stamp shows its tokens as themselves (`{name}`, `{date}`), because a
 * file cannot know who will place it or when.
 */

import { PDFDocument, PDFName, StandardFonts } from 'pdf-lib';
import { stampDrawing, stampForm, type StampDefinition } from './stamp';

export const STAMP_PDF_DATE = new Date('2026-01-01T00:00:00Z');

/** Renders one catalogue entry to the bytes of a single-page PDF the size of the drawing. */
export async function renderStampPdf(definition: StampDefinition): Promise<Uint8Array> {
  const drawing = stampDrawing(definition.lines, definition.color);
  const form = stampForm(drawing);
  const doc = await PDFDocument.create();
  doc.setTitle(`${definition.label} stamp`);
  doc.setProducer('ynotPDF make-stamps');
  doc.setCreator('ynotPDF make-stamps');
  doc.setCreationDate(STAMP_PDF_DATE);
  doc.setModificationDate(STAMP_PDF_DATE);
  const page = doc.addPage([drawing.width, drawing.height]);
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  // The form's content names its font `/F1`; the page's resources say what that is.
  const fontName = Object.keys(form.resources.fonts)[0] ?? 'F1';
  page.node.setFontDictionary(PDFName.of(fontName), font.ref);
  page.pushOperators();
  const stream = doc.context.flateStream(form.content);
  const ref = doc.context.register(stream);
  page.node.set(PDFName.of('Contents'), ref);
  return doc.save({ useObjectStreams: false, updateFieldAppearances: false });
}

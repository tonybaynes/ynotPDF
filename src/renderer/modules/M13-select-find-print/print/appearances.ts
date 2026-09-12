/** Print-specific flattening on an isolated PDF object graph. Never changes the open document. */
import {
  PDFArray,
  PDFBool,
  PDFDict,
  PDFName,
  PDFNumber,
  PDFStream,
  type PDFDocument,
  type PDFPage,
} from 'pdf-lib';
import { placementMatrix } from '@engine/ops/flatten';
import { pick, readRotation } from '@engine/ops/pdfdoc';
import { num } from '@engine/appearance/content';

export interface PrintAppearanceOptions {
  readonly annotations: boolean;
  readonly forms: boolean;
}

/** Bake only marks requested by the print options and the annotation Print/Hidden flags. */
export function bakePrintAppearances(
  doc: PDFDocument,
  pages: ReadonlySet<number>,
  options: PrintAppearanceOptions,
): void {
  // Repair missing widget appearances with the existing pdf-lib form providers. Preserve supplied
  // appearances otherwise (including signatures, custom buttons and third-party typography).
  if (options.forms && doc.catalog.has(PDFName.of('AcroForm'))) {
    const form = doc.getForm();
    const needs = pick(doc.context, form.acroForm.dict.get(PDFName.of('NeedAppearances')), PDFBool);
    if (needs === PDFBool.True)
      for (const field of form.getFields()) form.markFieldAsDirty(field.ref);
    form.updateFieldAppearances();
  }
  for (const index of pages) {
    const page = doc.getPage(index);
    const annots = page.node.Annots();
    if (!annots) continue;
    const operators: string[] = [];
    // Clone both dictionaries: resources and XObjects can be shared by other pages.
    const resources = page.node.Resources()?.clone(doc.context) ?? doc.context.obj({});
    const xobjects =
      pick(doc.context, resources.get(PDFName.of('XObject')), PDFDict)?.clone(doc.context) ??
      doc.context.obj({});
    resources.set(PDFName.of('XObject'), xobjects);
    page.node.set(PDFName.of('Resources'), resources);
    for (let i = 0; i < annots.size(); i++) {
      const annot = pick(doc.context, annots.get(i), PDFDict);
      if (!annot) throw failure(index, 'an unreadable annotation');
      const subtype =
        pick(doc.context, annot.get(PDFName.of('Subtype')), PDFName)?.asString() ?? '/Unknown';
      if (subtype === '/Popup') continue;
      if (subtype === '/Widget' ? !options.forms : !options.annotations) continue;
      const flags = pick(doc.context, annot.get(PDFName.of('F')), PDFNumber)?.asNumber() ?? 0;
      if (!(flags & 4) || flags & 2) continue;
      // NoView concerns the screen only: a Print + NoView mark still belongs on paper.
      const ap = pick(doc.context, annot.get(PDFName.of('AP')), PDFDict);
      let normal = ap ? doc.context.lookup(ap.get(PDFName.of('N'))) : undefined;
      if (normal instanceof PDFDict) {
        const state = pick(doc.context, annot.get(PDFName.of('AS')), PDFName);
        if (state) normal = doc.context.lookup(normal.get(state));
        else if (normal.entries().length === 1)
          normal = doc.context.lookup(normal.entries()[0]?.[1]);
        else normal = undefined;
      }
      // A borderless link is an action rather than a printed mark. A link with a drawing or
      // border must be preserved or reported, just like an annotation of an unknown subtype.
      if (!normal && subtype === '/Link' && borderless(doc, annot)) continue;
      if (!(normal instanceof PDFStream))
        throw failure(index, `${subtype.slice(1)} has no usable normal appearance`);
      const rect = numbers(doc, annot, 'Rect', 4);
      const bbox = numbers(doc, normal.dict, 'BBox', 4);
      if (
        !rect ||
        !bbox ||
        (rect[2] ?? 0) <= (rect[0] ?? 0) ||
        (rect[3] ?? 0) <= (rect[1] ?? 0) ||
        (bbox[2] ?? 0) <= (bbox[0] ?? 0) ||
        (bbox[3] ?? 0) <= (bbox[1] ?? 0)
      ) {
        throw failure(index, `${subtype.slice(1)} has invalid appearance geometry`);
      }
      if (normal.dict.has(PDFName.of('Matrix')) && !numbers(doc, normal.dict, 'Matrix', 6))
        throw failure(index, 'an appearance has an invalid matrix');
      const m = placementMatrix(doc.context, normal, {
        x0: rect[0] ?? 0,
        y0: rect[1] ?? 0,
        x1: rect[2] ?? 0,
        y1: rect[3] ?? 0,
      });
      let name = `PrintAppearance${i}`;
      while (xobjects.has(PDFName.of(name))) name += '_';
      xobjects.set(PDFName.of(name), doc.context.register(normal));
      // NoRotate cancels the page's rotation around the annotation's upper-left corner.
      // Imposition still turns/scales the whole printed page afterwards.
      const rotation = flags & 16 ? readRotation(page.node) : 0;
      const angle = (rotation * Math.PI) / 180;
      const c = Math.round(Math.cos(angle));
      const s = Math.round(Math.sin(angle));
      const x = rect[0] ?? 0;
      const y = rect[3] ?? 0;
      const upright = rotation
        ? `${[c, s, -s, c, x - c * x + s * y, y - s * x - c * y].map(num).join(' ')} cm `
        : '';
      operators.push(`q ${upright}${m.map(num).join(' ')} cm /${name} Do Q`);
    }
    isolateContent(doc, page, operators.join('\n'));
    page.node.delete(PDFName.of('Annots'));
  }
}

function failure(page: number, reason: string): Error {
  return new Error(
    `Cannot preserve the printed appearance on page ${page + 1}: ${reason}. No PDF was written.`,
  );
}

function numbers(doc: PDFDocument, dict: PDFDict, key: string, length: number): number[] | null {
  const array = pick(doc.context, dict.get(PDFName.of(key)), PDFArray);
  if (array?.size() !== length) return null;
  const values = Array.from(
    { length },
    (_, i) => pick(doc.context, array.get(i), PDFNumber)?.asNumber() ?? NaN,
  );
  return values.every(Number.isFinite) ? values : null;
}

function borderless(doc: PDFDocument, annot: PDFDict): boolean {
  const bs = pick(doc.context, annot.get(PDFName.of('BS')), PDFDict);
  const width = bs ? pick(doc.context, bs.get(PDFName.of('W')), PDFNumber)?.asNumber() : undefined;
  const border = pick(doc.context, annot.get(PDFName.of('Border')), PDFArray);
  return (width ?? (border ? pick(doc.context, border.get(2), PDFNumber)?.asNumber() : 1)) === 0;
}

/** Existing page graphics state must not translate/clip the appended appearances. */
function isolateContent(doc: PDFDocument, page: PDFPage, marks: string): void {
  const original = page.node.get(PDFName.of('Contents'));
  const array = pick(doc.context, original, PDFArray);
  const content = array ? array.asArray() : original ? [original] : [];
  page.node.set(
    PDFName.of('Contents'),
    doc.context.obj([
      doc.context.register(doc.context.flateStream('q\n')),
      ...content,
      doc.context.register(doc.context.flateStream(`\nQ\n${marks}\n`)),
    ]),
  );
}

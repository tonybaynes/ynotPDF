/**
 * How big each image actually is **on the page** (M100).
 *
 * The only meaningful resolution of an image in a PDF is the one it is drawn at: a 2000-pixel
 * photograph placed two inches wide is a 1000 dpi image, and the same file placed across a whole
 * A4 page is 240 dpi. Neither number is written down anywhere — it comes out of the `cm` matrix
 * in force at the `Do` that draws it, because a PDF image is always drawn into the unit square.
 *
 * So this walks every page's content stream with M50's parser and object scanner, follows form
 * XObjects into their own streams (an image inside a stamp is placed by two matrices, not one),
 * and records the **largest** placement of each image. Largest rather than average or first,
 * because downsampling to fit the smallest use of an image would visibly blur the largest.
 */

import {
  PDFArray,
  PDFDict,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  PDFStream,
  decodePDFRawStream,
} from 'pdf-lib';
import type { PDFDocument } from 'pdf-lib';
import { parse } from '../../content/parser';
import { scanObjects } from '../../content/objects';
import { multiply } from '../../content/matrix';
import { pageContentOf } from '../../content/pdf';
import { pick } from '../../ops/pdfdoc';
import { IDENTITY, type PdfMatrix } from '@shared/pdf';

/** The size an image is drawn at, in PDF points. */
export interface DrawnSize {
  readonly width: number;
  readonly height: number;
}

/**
 * The largest placement of every image XObject, keyed by `PDFRef.toString()`.
 *
 * An image the map does not mention is drawn by nothing this walk could follow — a page whose
 * content stream would not parse, an annotation appearance, a pattern. It is never downsampled,
 * because resizing something whose size on the page we do not know is guesswork.
 */
export type Placements = ReadonlyMap<string, DrawnSize>;

export function findPlacements(doc: PDFDocument): Placements {
  const out = new Map<string, DrawnSize>();
  const record = (ref: PDFRef, size: DrawnSize): void => {
    const key = ref.toString();
    const existing = out.get(key);
    if (!existing || size.width * size.height > existing.width * existing.height) {
      out.set(key, size);
    }
  };

  for (const page of doc.getPages()) {
    let content: Uint8Array;
    try {
      content = pageContentOf(doc, page);
    } catch {
      continue;
    }
    const resources = pick(
      doc.context,
      page.node.getInheritableAttribute(PDFName.of('Resources')),
      PDFDict,
    );
    walkStream(doc, content, resources, IDENTITY, record, new Set(), 0);
  }
  return out;
}

/** How wide and tall the unit square becomes under `m`. */
export function drawnSizeOf(m: PdfMatrix): DrawnSize {
  return {
    width: Math.hypot(m[0], m[1]),
    height: Math.hypot(m[2], m[3]),
  };
}

function walkStream(
  doc: PDFDocument,
  content: Uint8Array,
  resources: PDFDict | null,
  base: PdfMatrix,
  record: (ref: PDFRef, size: DrawnSize) => void,
  visiting: Set<string>,
  depth: number,
): void {
  // A form XObject may legally draw itself. Ten levels is deeper than any real document and
  // shallower than a stack overflow.
  if (depth > 10) return;
  const xobjects = resources
    ? pick(doc.context, resources.get(PDFName.of('XObject')), PDFDict)
    : null;
  if (!xobjects) return;

  let scan;
  try {
    scan = scanObjects(parse(content).ops);
  } catch {
    return;
  }

  for (const object of scan.objects) {
    if (object.kind !== 'xobject' || object.name === undefined) continue;
    const entry = xobjects.get(PDFName.of(object.name));
    // Only a named indirect object can be keyed, and in practice every XObject is one. A stream
    // written directly into the resources dictionary is legal and unplaceable here.
    const ref = entry instanceof PDFRef ? entry : null;
    const stream = pick(doc.context, entry, PDFStream);
    if (!stream) continue;
    const subtype = pick(doc.context, stream.dict.get(PDFName.of('Subtype')), PDFName)?.asString();
    const ctm = multiply(object.ctm, base);

    if (subtype === '/Image') {
      if (ref) record(ref, drawnSizeOf(ctm));
      continue;
    }
    if (subtype !== '/Form') continue;

    const key = ref ? ref.toString() : `${object.name}@${String(depth)}`;
    if (visiting.has(key)) continue;
    visiting.add(key);
    const inner = readFormContent(stream);
    if (inner) {
      const formMatrix = readMatrix(doc, stream.dict);
      const formResources =
        pick(doc.context, stream.dict.get(PDFName.of('Resources')), PDFDict) ?? resources;
      walkStream(doc, inner, formResources, multiply(formMatrix, ctm), record, visiting, depth + 1);
    }
    visiting.delete(key);
  }
}

/** A form XObject's `/Matrix`, or the identity. */
function readMatrix(doc: PDFDocument, dict: PDFDict): PdfMatrix {
  const array = pick(doc.context, dict.get(PDFName.of('Matrix')), PDFArray);
  if (!array || array.size() < 6) return IDENTITY;
  const at = (i: number): number => {
    const n = pick(doc.context, array.get(i), PDFNumber);
    return n ? n.asNumber() : Number.NaN;
  };
  const m: PdfMatrix = [at(0), at(1), at(2), at(3), at(4), at(5)];
  return m.every((n) => Number.isFinite(n)) ? m : IDENTITY;
}

function readFormContent(stream: PDFStream): Uint8Array | null {
  try {
    if (stream instanceof PDFRawStream) return decodePDFRawStream(stream).decode();
    return stream.getContents();
  } catch {
    return null;
  }
}

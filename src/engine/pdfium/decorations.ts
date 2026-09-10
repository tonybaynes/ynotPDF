/**
 * Page decorations in the live engine (M53, ADR 0020 §2).
 *
 * `setDecorations` **replaces** every `/YNOTDec`-marked object on a page with the ones it is
 * given, so one call is add, update and remove at once and calling it twice with the same items
 * leaves the same page. That is what lets the renderer keep a decoration in the model and simply
 * re-apply after every change and every undo.
 *
 * The marker is a PDFium content mark. `FPDFPageObj_AddMark` puts it on the live object,
 * `FPDFPage_GenerateContent` writes it into the stream as `/YNOTDec <<…>> BDC … EMC`, and
 * reopening the file gives it back — so the same tag identifies a decoration in this session, in
 * the saved bytes, and in a file opened next year.
 *
 * A decoration reaches PDFium as a one-page PDF whose single page *is* the drawing:
 * `FPDF_NewXObjectFromPage` turns that into a form XObject with its resources attached, which is
 * exactly what the writer builds by hand. One drawing description, two ways in.
 */

import { PDFDocument, PDFName } from 'pdf-lib';
import type { PdfMatrix } from '@shared/pdf';
import { EngineError } from '../PdfEngine';
import type { PlannedXObject } from '../Writer';
import {
  DECORATION_MARK,
  MARK_ID,
  MARK_KIND,
  MARK_SPEC,
  type DecorationDraw,
  type DecorationKind,
  type FoundDecoration,
} from '../decorations/types';
import { embedXObjectSource, formXObject } from '../writers/resources';
import type { Ffi } from './ffi';

/** The kinds a marker may name; anything else read back is reported as `unknown`. */
const KINDS: ReadonlyArray<DecorationKind> = [
  'header-footer',
  'bates',
  'watermark',
  'background',
];

/**
 * A one-page PDF whose page is the decoration, sized to its `/BBox`.
 *
 * The page's content is the drawing translated so the box's origin is the page's, because a
 * PDF page's media box always starts at (0, 0) once PDFium has imported it, and the placement
 * matrix on the other side assumes the box it was given.
 */
export async function decorationPdf(
  draw: DecorationDraw,
  sources: Readonly<Record<string, PlannedXObject>>,
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const width = Math.max(1, draw.bbox.x1 - draw.bbox.x0);
  const height = Math.max(1, draw.bbox.y1 - draw.bbox.y0);
  const page = doc.addPage([width, height]);
  const embedded = new Map<string, ReturnType<typeof doc.context.register>>();
  for (const key of new Set(Object.values(draw.resources.xobjects ?? {}))) {
    const source = sources[key];
    if (!source) continue;
    embedded.set(key, await embedXObjectSource(doc, source));
  }
  const form = formXObject(doc.context, {
    content: draw.content,
    bbox: draw.bbox,
    resources: draw.resources,
    xobjects: embedded,
  });
  const resources = doc.context.obj({});
  const xobjects = doc.context.obj({});
  xobjects.set(PDFName.of('YnD'), form);
  resources.set(PDFName.of('XObject'), xobjects);
  const content = doc.context.flateStream(
    `q 1 0 0 1 ${fmt(-draw.bbox.x0)} ${fmt(-draw.bbox.y0)} cm /YnD Do Q`,
  );
  page.node.set(PDFName.of('Resources'), resources);
  page.node.set(PDFName.of('Contents'), doc.context.register(content));
  return doc.save({ useObjectStreams: false });
}

function fmt(n: number): string {
  return Number.isFinite(n) ? String(Math.round(n * 10000) / 10000) : '0';
}

/** Reads one string parameter of a mark. */
function markString(ffi: Ffi, mark: number, key: string): string | null {
  return ffi.scope((s) => {
    const keyPtr = s.utf8(key);
    const out = s.alloc(8);
    if (!ffi.call('FPDFPageObjMark_GetParamStringValue', mark, keyPtr, 0, 0, out)) return null;
    const size = ffi.u32(out, 0);
    if (size <= 2) return '';
    const buf = s.alloc(size);
    if (!ffi.call('FPDFPageObjMark_GetParamStringValue', mark, keyPtr, buf, size, out)) return null;
    const got = ffi.u32(out, 0);
    return new TextDecoder('utf-16le').decode(
      ffi.m.HEAPU8.slice(buf, buf + Math.max(0, got - 2)),
    );
  });
}

/** The name of a mark. */
function markName(ffi: Ffi, mark: number): string {
  return ffi.scope((s) => {
    const out = s.alloc(8);
    if (!ffi.call('FPDFPageObjMark_GetName', mark, 0, 0, out)) return '';
    const size = ffi.u32(out, 0);
    if (size <= 2) return '';
    const buf = s.alloc(size);
    if (!ffi.call('FPDFPageObjMark_GetName', mark, buf, size, out)) return '';
    const got = ffi.u32(out, 0);
    return new TextDecoder('utf-16le').decode(ffi.m.HEAPU8.slice(buf, buf + Math.max(0, got - 2)));
  });
}

/** The `/YNOTDec` mark on an object, or 0. */
function decorationMark(ffi: Ffi, obj: number): number {
  const count = ffi.call('FPDFPageObj_CountMarks', obj);
  for (let i = 0; i < count; i++) {
    const mark = ffi.call('FPDFPageObj_GetMark', obj, i);
    if (mark !== 0 && markName(ffi, mark) === DECORATION_MARK) return mark;
  }
  return 0;
}

/** Every decoration this application put on a page, newest last, with its object index. */
export function readDecorations(ffi: Ffi, page: number, pageIndex: number): FoundDecoration[] {
  const out: FoundDecoration[] = [];
  const count = ffi.call('FPDFPage_CountObjects', page);
  for (let i = 0; i < count; i++) {
    const obj = ffi.call('FPDFPage_GetObject', page, i);
    if (obj === 0) continue;
    const mark = decorationMark(ffi, obj);
    if (mark === 0) continue;
    const kind = markString(ffi, mark, MARK_KIND) ?? '';
    out.push({
      page: pageIndex,
      id: markString(ffi, mark, MARK_ID) ?? '',
      kind: (KINDS as ReadonlyArray<string>).includes(kind)
        ? (kind as DecorationKind)
        : 'unknown',
      index: i,
      spec: markString(ffi, mark, MARK_SPEC),
      foreign: false,
    });
  }
  return out;
}

/** Removes every marked decoration from a page. Returns how many went. */
function clearDecorations(ffi: Ffi, page: number): number {
  const indexes = readDecorations(ffi, page, 0).map((d) => d.index);
  // Back to front: removing an object shifts every later index down by one.
  for (const index of [...indexes].reverse()) {
    const obj = ffi.call('FPDFPage_GetObject', page, index);
    if (obj === 0) continue;
    if (ffi.call('FPDFPage_RemoveObject', page, obj)) ffi.call('FPDFPageObj_Destroy', obj);
  }
  return indexes.length;
}

/**
 * Puts one decoration on the page and marks it.
 *
 * `behind` inserts at index 0, which is what makes a watermark sit under the page's own text —
 * the one thing an overlay could never do.
 */
function insertDecoration(
  ffi: Ffi,
  doc: number,
  page: number,
  draw: DecorationDraw,
  pdf: Uint8Array,
): void {
  const ptr = ffi.malloc(Math.max(1, pdf.byteLength));
  ffi.m.HEAPU8.set(pdf, ptr);
  const src = ffi.call('FPDF_LoadMemDocument', ptr, pdf.byteLength, 0);
  if (src === 0) {
    ffi.free(ptr);
    throw new EngineError('internal', 'a decoration could not be turned into a PDF page');
  }
  try {
    const xobject = ffi.call('FPDF_NewXObjectFromPage', doc, src, 0);
    if (xobject === 0) throw new EngineError('internal', 'PDFium could not copy the decoration in');
    let obj: number;
    try {
      obj = ffi.call('FPDF_NewFormObjectFromXObject', xobject);
    } finally {
      ffi.call('FPDF_CloseXObject', xobject);
    }
    if (obj === 0) throw new EngineError('internal', 'PDFium could not make a decoration object');
    const m: PdfMatrix = draw.matrix;
    ffi.call('FPDFPageObj_Transform', obj, m[0], m[1], m[2], m[3], m[4], m[5]);
    ffi.scope((s) => {
      const mark = ffi.call('FPDFPageObj_AddMark', obj, s.utf8(DECORATION_MARK));
      if (mark === 0) return;
      const put = (key: string, value: string): void => {
        ffi.call('FPDFPageObjMark_SetStringParam', doc, obj, mark, s.utf8(key), s.utf8(value));
      };
      put(MARK_ID, draw.id);
      put(MARK_KIND, draw.kind);
      put(MARK_SPEC, draw.spec);
    });
    if (draw.behind) {
      if (!ffi.call('FPDFPage_InsertObjectAtIndex', page, obj, 0)) {
        ffi.call('FPDFPage_InsertObject', page, obj);
      }
    } else {
      ffi.call('FPDFPage_InsertObject', page, obj);
    }
  } finally {
    ffi.call('FPDF_CloseDocument', src);
    ffi.free(ptr);
  }
}

/**
 * Scales every object on the page that is not a decoration, so a header has room (the "shrink
 * page" option).
 *
 * `from` is the factor already applied — the caller knows it, because it is in the model and in
 * the marker — so the page is first put back to full size and then scaled to `to`. Doing it in
 * one step would compound.
 */
export function scalePageContent(
  ffi: Ffi,
  page: number,
  box: readonly [number, number, number, number],
  from: number,
  to: number,
): void {
  const previous = from > 0 && from < 1 ? from : 1;
  const next = to > 0 && to < 1 ? to : 1;
  if (Math.abs(previous - next) < 1e-6) return;
  const factor = next / previous;
  const cx = (box[0] + box[2]) / 2;
  const cy = (box[1] + box[3]) / 2;
  const e = cx - factor * cx;
  const f = cy - factor * cy;
  const decorations = new Set(readDecorations(ffi, page, 0).map((d) => d.index));
  const count = ffi.call('FPDFPage_CountObjects', page);
  for (let i = 0; i < count; i++) {
    if (decorations.has(i)) continue;
    const obj = ffi.call('FPDFPage_GetObject', page, i);
    if (obj !== 0) ffi.call('FPDFPageObj_Transform', obj, factor, 0, 0, factor, e, f);
  }
}

/** What `setDecorations` needs beyond the items themselves. */
export interface SetDecorationsOptions {
  /** Pictures and PDF pages the items name, by key. */
  readonly sources?: Readonly<Record<string, PlannedXObject>>;
  /** The content shrink already applied to this page, and the one wanted. */
  readonly shrink?: { readonly from: number; readonly to: number };
  /** The page's crop box, for the shrink's centre. */
  readonly box?: readonly [number, number, number, number];
}

/**
 * Replaces the page's decorations with `items`. Returns how many marked objects were taken off,
 * so a caller can tell "there was nothing there" from "there were three".
 */
export async function setDecorations(
  ffi: Ffi,
  doc: number,
  page: number,
  items: ReadonlyArray<DecorationDraw>,
  options: SetDecorationsOptions = {},
): Promise<number> {
  const sources = options.sources ?? {};
  // Built before anything is removed: a failure here must leave the page as it was.
  const pdfs: Array<{ draw: DecorationDraw; pdf: Uint8Array }> = [];
  for (const draw of items) pdfs.push({ draw, pdf: await decorationPdf(draw, sources) });

  const removed = clearDecorations(ffi, page);
  if (options.shrink && options.box) {
    scalePageContent(ffi, page, options.box, options.shrink.from, options.shrink.to);
  }
  // Behind first, so two behind-the-content decorations keep the order they were given in.
  for (const { draw, pdf } of [...pdfs].filter((p) => p.draw.behind).reverse()) {
    insertDecoration(ffi, doc, page, draw, pdf);
  }
  for (const { draw, pdf } of pdfs.filter((p) => !p.draw.behind)) {
    insertDecoration(ffi, doc, page, draw, pdf);
  }
  ffi.call('FPDFPage_GenerateContent', page);
  return removed;
}

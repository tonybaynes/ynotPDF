/**
 * PDFium page-object mutations (M50, ADR 0018). Kept beside `PdfiumEngine` like `mutations.ts`
 * so the engine's methods stay thin wrappers.
 *
 * Every function here leaves the page's content stream regenerated (`FPDFPage_GenerateContent`)
 * so the change survives a page reload — the annotation methods unload and reload pages freely,
 * and an in-memory-only edit would vanish under them. The writer still gets the *original*
 * stream from the renderer, captured before the first edit, so byte preservation is the plan
 * builder's business rather than this file's (see ADR 0018 §3).
 *
 * Removed objects are not destroyed: `FPDFPage_RemoveObject` hands ownership back, and the
 * object is kept in a per-document **stash** under a token so an undo can put the very same
 * object back — a path stays a path, a text object stays text, and `objectAsPdf` of it later
 * still says so. The stash is destroyed with the document.
 */

import type { ObjectStyle, PdfMatrix } from '@shared/pdf';
import { EngineError, type ObjectPath, type PathPoint } from '../PdfEngine';
import { apply, invert, multiply } from '../content/matrix';
import { PAGEOBJ } from './constants';
import type { Ffi } from './ffi';
import { unpackRgb } from './mutations';

/** Removed objects waiting for an undo, by token. */
export interface ObjectStash {
  next: number;
  readonly objects: Map<number, number>;
}

export function createObjectStash(): ObjectStash {
  return { next: 1, objects: new Map() };
}

/** Destroys every stashed object (on document close). */
export function destroyObjectStash(ffi: Ffi, stash: ObjectStash): void {
  for (const handle of stash.objects.values()) ffi.call('FPDFPageObj_Destroy', handle);
  stash.objects.clear();
}

/** The object at `index`, with a bounds check that names the range. */
export function objectHandle(ffi: Ffi, page: number, index: number): number {
  const count = ffi.call('FPDFPage_CountObjects', page);
  if (!Number.isInteger(index) || index < 0 || index >= count) {
    throw new EngineError('invalid-argument', `object ${index} is out of range (0..${count - 1})`);
  }
  const obj = ffi.call('FPDFPage_GetObject', page, index);
  if (obj === 0) throw new EngineError('internal', `PDFium has no object ${index}`);
  return obj;
}

function readMatrix(ffi: Ffi, obj: number): PdfMatrix | null {
  return ffi.scope((s) => {
    const f = s.alloc(4 * 6);
    if (!ffi.call('FPDFPageObj_GetMatrix', obj, f)) return null;
    return [
      ffi.f32(f, 0),
      ffi.f32(f, 1),
      ffi.f32(f, 2),
      ffi.f32(f, 3),
      ffi.f32(f, 4),
      ffi.f32(f, 5),
    ];
  });
}

/** Post-multiplies `delta` onto the object's matrix: the object moves by `delta` in page space. */
export function transformObject(ffi: Ffi, page: number, index: number, delta: PdfMatrix): void {
  const obj = objectHandle(ffi, page, index);
  ffi.call(
    'FPDFPageObj_Transform',
    obj,
    delta[0],
    delta[1],
    delta[2],
    delta[3],
    delta[4],
    delta[5],
  );
  ffi.call('FPDFPage_GenerateContent', page);
}

/**
 * Sets the object's matrix outright. Expressed as a transform from the current matrix, which
 * works for a shading too — `FPDFPageObj_SetMatrix` refuses those, `Transform` does not.
 */
export function setObjectMatrix(ffi: Ffi, page: number, index: number, matrix: PdfMatrix): void {
  const obj = objectHandle(ffi, page, index);
  const current = readMatrix(ffi, obj);
  const inverse = current ? invert(current) : null;
  if (!inverse) {
    throw new EngineError(
      'invalid-argument',
      `object ${index} has no invertible matrix to replace`,
    );
  }
  const delta = multiply(inverse, matrix);
  ffi.call(
    'FPDFPageObj_Transform',
    obj,
    delta[0],
    delta[1],
    delta[2],
    delta[3],
    delta[4],
    delta[5],
  );
  ffi.call('FPDFPage_GenerateContent', page);
}

/** Removes an object from the page and stashes it. Returns the stash token. */
export function removeObject(ffi: Ffi, page: number, index: number, stash: ObjectStash): number {
  const obj = objectHandle(ffi, page, index);
  if (!ffi.call('FPDFPage_RemoveObject', page, obj)) {
    throw new EngineError('internal', `PDFium could not remove object ${index}`);
  }
  ffi.call('FPDFPage_GenerateContent', page);
  const token = stash.next++;
  stash.objects.set(token, obj);
  return token;
}

/** Puts a stashed object back at `at` (appends when `at` is the count). */
export function restoreObject(
  ffi: Ffi,
  page: number,
  stash: ObjectStash,
  token: number,
  at: number,
): void {
  const obj = stash.objects.get(token);
  if (obj === undefined) throw new EngineError('invalid-argument', `no stashed object ${token}`);
  insertAt(ffi, page, obj, at);
  stash.objects.delete(token);
  ffi.call('FPDFPage_GenerateContent', page);
}

function insertAt(ffi: Ffi, page: number, obj: number, at: number | undefined): number {
  const count = ffi.call('FPDFPage_CountObjects', page);
  const index = at ?? count;
  if (!Number.isInteger(index) || index < 0 || index > count) {
    throw new EngineError('invalid-argument', `cannot insert at ${index} (0..${count})`);
  }
  if (index === count) {
    ffi.call('FPDFPage_InsertObject', page, obj);
  } else if (!ffi.call('FPDFPage_InsertObjectAtIndex', page, obj, index)) {
    throw new EngineError('internal', `PDFium could not insert an object at ${index}`);
  }
  return index;
}

/**
 * Inserts the object a one-page PDF carries (see {@link objectAsPdf}) as a form XObject, placed
 * under `matrix`. Returns the new object's index.
 */
export function insertFromPdf(
  ffi: Ffi,
  doc: number,
  page: number,
  pdf: Uint8Array,
  matrix: PdfMatrix,
  at: number | undefined,
): number {
  const ptr = ffi.malloc(Math.max(1, pdf.byteLength));
  ffi.m.HEAPU8.set(pdf, ptr);
  const src = ffi.call('FPDF_LoadMemDocument', ptr, pdf.byteLength, 0);
  if (src === 0) {
    ffi.free(ptr);
    throw new EngineError('invalid-argument', 'the object to paste is not a readable PDF');
  }
  try {
    const xobject = ffi.call('FPDF_NewXObjectFromPage', doc, src, 0);
    if (xobject === 0) throw new EngineError('internal', 'PDFium could not copy the object in');
    let obj: number;
    try {
      obj = ffi.call('FPDF_NewFormObjectFromXObject', xobject);
    } finally {
      ffi.call('FPDF_CloseXObject', xobject);
    }
    if (obj === 0) throw new EngineError('internal', 'PDFium could not make a form object');
    ffi.call(
      'FPDFPageObj_Transform',
      obj,
      matrix[0],
      matrix[1],
      matrix[2],
      matrix[3],
      matrix[4],
      matrix[5],
    );
    const index = insertAt(ffi, page, obj, at);
    ffi.call('FPDFPage_GenerateContent', page);
    return index;
  } finally {
    ffi.call('FPDF_CloseDocument', src);
    ffi.free(ptr);
  }
}

/**
 * Rewrites the page's object order. `order[i]` is the current index of the object that should
 * end up at `i`; it must be a permutation of `0..count-1`.
 */
export function reorderObjects(ffi: Ffi, page: number, order: ReadonlyArray<number>): void {
  const count = ffi.call('FPDFPage_CountObjects', page);
  const seen = new Set<number>();
  for (const i of order) {
    if (!Number.isInteger(i) || i < 0 || i >= count || seen.has(i)) {
      throw new EngineError('invalid-argument', `order is not a permutation of 0..${count - 1}`);
    }
    seen.add(i);
  }
  if (order.length !== count) {
    throw new EngineError('invalid-argument', `order names ${order.length} of ${count} objects`);
  }
  if (order.every((v, i) => v === i)) return;
  const handles: number[] = [];
  for (let i = 0; i < count; i++) handles.push(ffi.call('FPDFPage_GetObject', page, i));
  // Take them all out, back to front so the indexes stay honest, then put them in as asked.
  for (let i = count - 1; i >= 0; i--) {
    const h = handles[i];
    if (h !== undefined && !ffi.call('FPDFPage_RemoveObject', page, h)) {
      throw new EngineError('internal', `PDFium could not detach object ${i}`);
    }
  }
  for (const i of order) {
    const h = handles[i];
    if (h !== undefined) ffi.call('FPDFPage_InsertObject', page, h);
  }
  ffi.call('FPDFPage_GenerateContent', page);
}

/**
 * A one-page PDF containing only object `index` of `page`, with the page's own resources so it
 * is self-contained: the page is imported into a scratch document and every other object (and
 * every annotation) is destroyed before it is serialised.
 */
export function objectAsPdf(
  ffi: Ffi,
  doc: number,
  pageIndex: number,
  index: number,
  save: (docPtr: number) => Uint8Array,
): Uint8Array {
  const scratch = ffi.call('FPDF_CreateNewDocument');
  if (scratch === 0) throw new EngineError('internal', 'PDFium could not create a document');
  try {
    const ok = ffi.scope((s) => {
      const buf = s.alloc(4);
      ffi.setI32(buf, pageIndex, 0);
      return ffi.call('FPDF_ImportPagesByIndex', scratch, doc, buf, 1, 0);
    });
    if (!ok) throw new EngineError('internal', 'PDFium could not copy the page');
    const page = ffi.call('FPDF_LoadPage', scratch, 0);
    if (page === 0) throw new EngineError('internal', 'the copied page could not be loaded');
    try {
      const count = ffi.call('FPDFPage_CountObjects', page);
      if (index < 0 || index >= count) {
        throw new EngineError(
          'invalid-argument',
          `object ${index} is out of range (0..${count - 1})`,
        );
      }
      for (let i = count - 1; i >= 0; i--) {
        if (i === index) continue;
        const obj = ffi.call('FPDFPage_GetObject', page, i);
        if (obj !== 0 && ffi.call('FPDFPage_RemoveObject', page, obj)) {
          ffi.call('FPDFPageObj_Destroy', obj);
        }
      }
      while (ffi.call('FPDFPage_GetAnnotCount', page) > 0) {
        if (!ffi.call('FPDFPage_RemoveAnnot', page, 0)) break;
      }
      ffi.call('FPDFPage_GenerateContent', page);
    } finally {
      ffi.call('FPDF_ClosePage', page);
    }
    return save(scratch);
  } finally {
    ffi.call('FPDF_CloseDocument', scratch);
  }
}

/** Sets a path's stroke and fill properties. Absent fields are left as they are. */
export function setObjectStyle(ffi: Ffi, page: number, index: number, style: ObjectStyle): void {
  const obj = objectHandle(ffi, page, index);
  if (style.fillColor !== undefined) {
    const [r, g, b] = unpackRgb(style.fillColor);
    ffi.call('FPDFPageObj_SetFillColor', obj, r, g, b, 255);
  }
  if (style.strokeColor !== undefined) {
    const [r, g, b] = unpackRgb(style.strokeColor);
    ffi.call('FPDFPageObj_SetStrokeColor', obj, r, g, b, 255);
  }
  if (style.strokeWidth !== undefined) {
    ffi.call('FPDFPageObj_SetStrokeWidth', obj, Math.max(0, style.strokeWidth));
  }
  if (style.dash !== undefined) {
    const dash = style.dash;
    ffi.scope((s) => {
      const buf = s.alloc(Math.max(4, dash.length * 4));
      dash.forEach((d, i) => {
        ffi.setF32(buf, d, i);
      });
      ffi.call('FPDFPageObj_SetDashArray', obj, buf, dash.length, 0);
    });
  }
  ffi.call('FPDFPage_GenerateContent', page);
}

/** PDFium's `FPDF_SEGMENT_*`. */
const SEGMENT = { LINETO: 0, BEZIERTO: 1, MOVETO: 2 } as const;

/** A path object's geometry in page space, and whether it is filled and stroked. */
export function readObjectPath(ffi: Ffi, page: number, index: number): ObjectPath {
  const obj = objectHandle(ffi, page, index);
  if (ffi.call('FPDFPageObj_GetType', obj) !== PAGEOBJ.PATH) {
    throw new EngineError('invalid-argument', `object ${index} is not a path`);
  }
  const matrix = readMatrix(ffi, obj) ?? [1, 0, 0, 1, 0, 0];
  const count = ffi.call('FPDFPath_CountSegments', obj);
  const points: PathPoint[] = [];
  let fill = false;
  let stroke = false;
  ffi.scope((s) => {
    const f = s.alloc(8);
    const mode = s.alloc(8);
    if (ffi.call('FPDFPath_GetDrawMode', obj, mode, mode + 4)) {
      fill = ffi.u32(mode, 0) !== 0;
      stroke = ffi.u32(mode, 1) !== 0;
    }
    for (let i = 0; i < count; i++) {
      const segment = ffi.call('FPDFPath_GetPathSegment', obj, i);
      if (segment === 0) continue;
      if (!ffi.call('FPDFPathSegment_GetPoint', segment, f, f + 4)) continue;
      const local = { x: ffi.f32(f, 0), y: ffi.f32(f, 1) };
      const type = ffi.call('FPDFPathSegment_GetType', segment);
      const p = apply(matrix, local);
      points.push({
        x: p.x,
        y: p.y,
        type: type === SEGMENT.MOVETO ? 'move' : type === SEGMENT.BEZIERTO ? 'bezier' : 'line',
        close: ffi.call('FPDFPathSegment_GetClose', segment) !== 0,
      });
    }
  });
  return { points, fill, stroke };
}

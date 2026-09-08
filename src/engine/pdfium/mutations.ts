/**
 * PDFium mutation helpers (M20, ADR 0007). Kept beside `PdfiumEngine` rather than inside it so
 * the 1 600-line read adapter stays readable; the engine's mutation methods are thin wrappers
 * over these.
 *
 * Two rules run through all of it:
 *
 * 1. **Anything that changes the page list invalidates the page cache.** `FPDFPage_Delete`,
 *    `FPDFPage_New`, `FPDF_MovePages` and `FPDF_ImportPagesByIndex` renumber pages, and a cached
 *    `FPDF_PAGE` handle for an old index is then wrong. The caller unloads every cached page
 *    first, so the next read reloads from the document.
 * 2. **Changing an annotation drops its appearance stream.** PDFium builds an appearance for the
 *    subtypes it understands when a page is loaded, but it will not *re*build one that already
 *    exists. Removing `/AP` after an edit is what makes the change visible in the next render.
 */

import type { NewAnnotation } from '../PdfEngine';
import { EngineError } from '../PdfEngine';
import type { PdfRect, Rotation } from '@shared/pdf';
import { ANNOT_COLORTYPE, ANNOT_FLAG, ANNOT_SUBTYPES } from './constants';
import type { Ffi } from './ffi';

/** PDFium's appearance modes for `FPDFAnnot_SetAP` / `GetAP`. */
export const APPEARANCE_MODE = { NORMAL: 0, ROLLOVER: 1, DOWN: 2 } as const;

/** Annotation keys this adapter writes, in the order PDFium likes to see them. */
const STRING_KEYS: ReadonlyArray<[keyof NewAnnotation, string]> = [
  ['contents', 'Contents'],
  ['author', 'T'],
  ['subject', 'Subj'],
  ['name', 'NM'],
  ['appearanceState', 'AS'],
  ['state', 'State'],
];

/** ISO 8601 → the `D:YYYYMMDDHHmmSS` form PDF dates use. Returns null for unparsable input. */
export function isoToPdfDate(iso: string | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const p = (n: number, width = 2): string => String(n).padStart(width, '0');
  return (
    `D:${p(d.getUTCFullYear(), 4)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`
  );
}

/** `0xRRGGBB` → the three components PDFium's colour setters take. */
export function unpackRgb(color: number): [number, number, number] {
  return [(color >> 16) & 255, (color >> 8) & 255, color & 255];
}

/** The PDFium enum value for an annotation subtype name. */
export function subtypeValue(subtype: string): number {
  const index = ANNOT_SUBTYPES.indexOf(subtype as (typeof ANNOT_SUBTYPES)[number]);
  return index < 0 ? 0 : index;
}

/** Packs our `AnnotationFlags` into the PDF `/F` bit field. */
export function packFlags(flags: NewAnnotation['flags']): number {
  return (
    (flags.hidden ? ANNOT_FLAG.HIDDEN : 0) |
    (flags.print ? ANNOT_FLAG.PRINT : 0) |
    (flags.noView ? ANNOT_FLAG.NOVIEW : 0) |
    (flags.readOnly ? ANNOT_FLAG.READONLY : 0) |
    (flags.locked ? ANNOT_FLAG.LOCKED : 0)
  );
}

/** Sets `/Rect` on an open annotation. PDFium's `FS_RECTF` is left, top, right, bottom. */
export function setAnnotRect(ffi: Ffi, annot: number, rect: PdfRect): void {
  ffi.scope((s) => {
    const r = s.alloc(16);
    ffi.setF32(r, rect.x0, 0);
    ffi.setF32(r, rect.y1, 1);
    ffi.setF32(r, rect.x1, 2);
    ffi.setF32(r, rect.y0, 3);
    ffi.call('FPDFAnnot_SetRect', annot, r);
  });
}

/**
 * Removes an annotation's normal appearance stream so PDFium regenerates it from the annotation
 * dictionary the next time the page is loaded. Without this an edited highlight keeps drawing
 * its old shape and colour.
 */
export function dropAppearance(ffi: Ffi, annot: number): void {
  ffi.call('FPDFAnnot_SetAP', annot, APPEARANCE_MODE.NORMAL, 0);
}

/**
 * Writes the fields of `patch` onto an open annotation. Only keys present in `patch` are
 * touched, so `updateAnnotation` really is a patch and not a replace.
 */
export function writeAnnotation(ffi: Ffi, annot: number, patch: Partial<NewAnnotation>): void {
  ffi.scope((s) => {
    if (patch.rect) setAnnotRect(ffi, annot, patch.rect);
    if (patch.flags) ffi.call('FPDFAnnot_SetFlags', annot, packFlags(patch.flags));

    for (const [field, key] of STRING_KEYS) {
      const value = patch[field];
      if (typeof value !== 'string') continue;
      ffi.call('FPDFAnnot_SetStringValue', annot, s.utf8(key), s.utf16(value));
    }
    for (const [field, key] of [
      ['created', 'CreationDate'],
      ['modified', 'M'],
    ] as const) {
      const value = isoToPdfDate(patch[field]);
      if (value !== null) ffi.call('FPDFAnnot_SetStringValue', annot, s.utf8(key), s.utf16(value));
    }

    if (typeof patch.color === 'number') {
      const [r, g, b] = unpackRgb(patch.color);
      ffi.call('FPDFAnnot_SetColor', annot, ANNOT_COLORTYPE.COLOR, r, g, b, 255);
    }
    if (typeof patch.interiorColor === 'number') {
      const [r, g, b] = unpackRgb(patch.interiorColor);
      ffi.call('FPDFAnnot_SetColor', annot, ANNOT_COLORTYPE.INTERIOR, r, g, b, 255);
    }
    if (typeof patch.borderWidth === 'number') {
      // FPDFAnnot_SetBorder(annot, horizontal_radius, vertical_radius, border_width)
      ffi.call('FPDFAnnot_SetBorder', annot, 0, 0, patch.borderWidth);
    }
    if (patch.quadPoints && patch.quadPoints.length >= 8) {
      writeQuadPoints(ffi, annot, patch.quadPoints);
    }
    if (patch.paths && patch.paths.length > 0) writeInk(ffi, annot, patch.paths);
    dropAppearance(ffi, annot);
  });
}

/** Replaces the attachment points (text-markup quads), 8 numbers per quad. */
function writeQuadPoints(ffi: Ffi, annot: number, quads: ReadonlyArray<number>): void {
  ffi.scope((s) => {
    const buf = s.alloc(32);
    const count = Math.floor(quads.length / 8);
    const existing = ffi.call('FPDFAnnot_CountAttachmentPoints', annot);
    for (let q = 0; q < count; q++) {
      for (let k = 0; k < 8; k++) ffi.setF32(buf, quads[q * 8 + k] ?? 0, k);
      if (q < existing) ffi.call('FPDFAnnot_SetAttachmentPoints', annot, q, buf);
      else ffi.call('FPDFAnnot_AppendAttachmentPoints', annot, buf);
    }
  });
}

/** Replaces every ink stroke. PDFium can only clear the list wholesale, then re-add strokes. */
function writeInk(
  ffi: Ffi,
  annot: number,
  paths: ReadonlyArray<ReadonlyArray<{ readonly x: number; readonly y: number }>>,
): void {
  ffi.call('FPDFAnnot_RemoveInkList', annot);
  for (const path of paths) {
    if (path.length === 0) continue;
    ffi.scope((s) => {
      const buf = s.alloc(path.length * 8);
      path.forEach((pt, i) => {
        ffi.setF32(buf, pt.x, i * 2);
        ffi.setF32(buf, pt.y, i * 2 + 1);
      });
      ffi.call('FPDFAnnot_AddInkStroke', annot, buf, path.length);
    });
  }
}

/** Reads a signature's `/ByteRange` — `FPDFSignatureObj_GetByteRange` reports ints. */
export function readByteRange(ffi: Ffi, sig: number): number[] {
  const count = ffi.call('FPDFSignatureObj_GetByteRange', sig, 0, 0);
  if (count <= 0) return [];
  return ffi.scope((s) => {
    const buf = s.alloc(count * 4);
    const got = ffi.call('FPDFSignatureObj_GetByteRange', sig, buf, count);
    const out: number[] = [];
    for (let i = 0; i < Math.min(got, count); i++) out.push(ffi.i32(buf, i));
    return out;
  });
}

/** Guard used by every mutation entry point: a rotation must be one of the four legal values. */
export function assertRotation(rotation: number): asserts rotation is Rotation {
  if (rotation !== 0 && rotation !== 90 && rotation !== 180 && rotation !== 270) {
    throw new EngineError(
      'invalid-argument',
      `rotation must be 0, 90, 180 or 270 (got ${rotation})`,
    );
  }
}

// ---- optional content (layers) — M12, ADR 0011 -------------------------------------------------

/**
 * Applies optional-content visibility to one **loaded** page by activating or deactivating the
 * objects that carry an `/OC` marked-content mark naming a hidden group.
 *
 * PDFium exposes no OCG API at all, so this is the whole mechanism: an inactive object is not
 * drawn. `FPDFPage_GenerateContent` is never called, so the page's content stream — and any
 * later save — is untouched, which is what makes a layer toggle exactly reversible.
 *
 * The activity flag lives on the loaded page rather than in the document, so the caller
 * re-applies this every time a page is loaded (see `PdfiumEngine.loadPage`).
 *
 * Returns the number of objects whose activity it changed.
 */
export function applyLayerVisibility(
  ffi: Ffi,
  page: number,
  hiddenGroupNames: ReadonlySet<string>,
): number {
  if (!ffi.has('FPDFPageObj_SetIsActive')) return 0;
  let changed = 0;
  ffi.scope((s) => {
    const nameKey = s.utf8('Name');
    const out = s.alloc(4);
    /** The `/OC` group name of one object, or null when it is not in a group. */
    const groupOf = (obj: number): string | null => {
      const marks = ffi.call('FPDFPageObj_CountMarks', obj);
      for (let i = 0; i < marks; i++) {
        const mark = ffi.call('FPDFPageObj_GetMark', obj, i);
        if (mark === 0) continue;
        const markName = ffi.utf16Call((buf, len) => {
          ffi.call('FPDFPageObjMark_GetName', mark, buf, len, out);
          return ffi.u32(out);
        });
        if (markName !== 'OC') continue;
        const group = ffi.utf16Call((buf, len) => {
          ffi.call('FPDFPageObjMark_GetParamStringValue', mark, nameKey, buf, len, out);
          return ffi.u32(out);
        });
        if (group) return group;
      }
      return null;
    };
    // One level into form XObjects: a layer is very often a single form object, but a file that
    // marks the objects inside one instead is just as legal.
    const visit = (obj: number, inheritedHidden: boolean, depth: number): void => {
      const group = groupOf(obj);
      const hidden = inheritedHidden || (group !== null && hiddenGroupNames.has(group));
      if (group !== null || inheritedHidden) {
        if (ffi.call('FPDFPageObj_SetIsActive', obj, hidden ? 0 : 1) !== 0) changed++;
      }
      if (depth < 2 && ffi.call('FPDFPageObj_GetType', obj) === PAGEOBJ_FORM) {
        const kids = ffi.call('FPDFFormObj_CountObjects', obj);
        for (let i = 0; i < kids; i++) {
          const kid = ffi.call('FPDFFormObj_GetObject', obj, i);
          if (kid !== 0) visit(kid, hidden, depth + 1);
        }
      }
    };
    const n = ffi.call('FPDFPage_CountObjects', page);
    for (let i = 0; i < n; i++) {
      const obj = ffi.call('FPDFPage_GetObject', page, i);
      if (obj !== 0) visit(obj, false, 0);
    }
  });
  return changed;
}

/** `FPDF_PAGEOBJ_FORM`; duplicated here so this file does not depend on the constants table. */
const PAGEOBJ_FORM = 5;

/**
 * Shared PDF geometry and value types used by the engine, the document model and the view.
 *
 * Conventions (PDF 32000-1:2008):
 * - Units are **PDF points** (1 pt = 1/72 inch) unless a name says otherwise.
 * - Page coordinates use PDF **user space**: origin at the bottom-left of the page's
 *   *unrotated* MediaBox/CropBox, x to the right, y **upwards**. The view layer converts
 *   to device pixels (origin top-left, y downwards) — see `src/renderer/view/Viewport.ts`.
 * - Page indexes are **0-based** everywhere in code. Page *labels* (`/PageLabels`) are
 *   display-only strings and may be anything ("iv", "A-3").
 * - `/Rotate` is stored as a clockwise multiple of 90°. Sizes returned by the engine are
 *   the *displayed* size (after rotation) unless documented otherwise.
 */

/** 0-based page index. */
export type PageIndex = number;

/** Page rotation in clockwise degrees, as in the PDF `/Rotate` entry. */
export type Rotation = 0 | 90 | 180 | 270;

/** A point in PDF user space (points, origin bottom-left, y up). */
export interface PdfPoint {
  readonly x: number;
  readonly y: number;
}

/**
 * An axis-aligned rectangle in PDF user space. Normalised: `x0 <= x1`, `y0 <= y1`
 * (`y0` is the *bottom* edge). Matches the PDF `/Rect` array order.
 */
export interface PdfRect {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

/** A 2-D affine matrix `[a b c d e f]` as used in PDF content streams (`cm`). */
export type PdfMatrix = readonly [a: number, b: number, c: number, d: number, e: number, f: number];

/** Colour in a device colour space. Components are 0..1. */
export type PdfColor =
  | { readonly space: 'DeviceGray'; readonly g: number }
  | { readonly space: 'DeviceRGB'; readonly r: number; readonly g: number; readonly b: number }
  | {
      readonly space: 'DeviceCMYK';
      readonly c: number;
      readonly m: number;
      readonly y: number;
      readonly k: number;
    };

/** The page boxes a document may define (PDF 14.11.2). CropBox and MediaBox always exist. */
export type PageBoxName = 'media' | 'crop' | 'bleed' | 'trim' | 'art';

/**
 * Every box a page defines, straight from the file: `null` where the page does not carry one
 * (ADR 0017). Not the same question as `pageBox(page, name)` in the model, which applies the
 * spec's fallbacks — this says what is actually there.
 */
export type PageBoxes = Readonly<Record<PageBoxName, PdfRect | null>>;

/** Size and rotation of one page. `width`/`height` are the displayed (rotated) size in points. */
export interface PageSize {
  readonly width: number;
  readonly height: number;
  /** The page's `/Rotate` value; the size above already accounts for it. */
  readonly rotation: Rotation;
  /** Unrotated CropBox (the visible area) in user space. */
  readonly cropBox: PdfRect;
  /** Unrotated MediaBox (the physical page) in user space. */
  readonly mediaBox: PdfRect;
}

/** Normalise a rectangle so that `x0 <= x1` and `y0 <= y1`. */
export function normalizeRect(r: PdfRect): PdfRect {
  return {
    x0: Math.min(r.x0, r.x1),
    y0: Math.min(r.y0, r.y1),
    x1: Math.max(r.x0, r.x1),
    y1: Math.max(r.y0, r.y1),
  };
}

/** Width of a rectangle in points. */
export function rectWidth(r: PdfRect): number {
  return r.x1 - r.x0;
}

/** Height of a rectangle in points. */
export function rectHeight(r: PdfRect): number {
  return r.y1 - r.y0;
}

/** Identity matrix. */
export const IDENTITY: PdfMatrix = [1, 0, 0, 1, 0, 0];

/** Points per inch. */
export const PT_PER_INCH = 72;

/** Convert millimetres to points. */
export function mmToPt(mm: number): number {
  return (mm / 25.4) * PT_PER_INCH;
}

/** Convert points to millimetres. */
export function ptToMm(pt: number): number {
  return (pt / PT_PER_INCH) * 25.4;
}

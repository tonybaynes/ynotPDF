/**
 * Appearance-stream types (M21).
 *
 * An annotation without an `/AP` is drawn by whatever guesswork the viewer feels like doing,
 * and viewers disagree — which is why a file that looks right here can look wrong in Chrome or
 * Preview. The generators in this folder build the stream ourselves so the file carries its own
 * appearance and every viewer agrees.
 *
 * Deliberately library-neutral: a generator returns *content-stream text* plus the resources it
 * used, never a pdf-lib object. `FullRewriteWriter` is the only file that knows which PDF
 * library we write with, and these are unit-testable in plain Node.
 *
 * Geometry is PDF user space, origin bottom-left, page-relative — the same space as
 * {@link AppearanceInput.rect}.
 */

import type { AnnotationSubtype } from '../PdfEngine';
import type { PdfPoint, PdfRect } from '@shared/pdf';

/** What a generator is told about the annotation. Mirrors the model's annotation shape. */
export interface AppearanceInput {
  readonly subtype: AnnotationSubtype;
  /** `/Rect`, normalised so `x0 <= x1` and `y0 <= y1`. */
  readonly rect: PdfRect;
  /** Stroke/border colour `0xRRGGBB`, or null for "no colour given". */
  readonly color: number | null;
  /** `/IC` interior (fill) colour `0xRRGGBB`, or null for unfilled. */
  readonly interiorColor: number | null;
  /** `/CA` 0..1, or null for opaque. */
  readonly opacity: number | null;
  /** Border width in points, or null for the PDF default of 1. */
  readonly borderWidth: number | null;
  /** Text-markup quads, 8 numbers per quad (x1 y1 x2 y2 x3 y3 x4 y4 — top-left first). */
  readonly quadPoints: ReadonlyArray<number>;
  /** Ink paths, one array of points per stroke. */
  readonly paths: ReadonlyArray<ReadonlyArray<PdfPoint>>;
  /** Polygon / polyline / line vertices. */
  readonly vertices: ReadonlyArray<PdfPoint>;
  /** `/Contents`, used by the FreeText generator. */
  readonly contents: string | null;
  /** Subtype-specific extras (`fontSize`, `lineEnding`, `dashArray`, …). */
  readonly extra: Readonly<Record<string, unknown>>;
}

/** The 14 standard fonts, the only ones a generator may ask for without embedding anything. */
export type StandardFontName =
  | 'Helvetica'
  | 'Helvetica-Bold'
  | 'Helvetica-Oblique'
  | 'Helvetica-BoldOblique'
  | 'Times-Roman'
  | 'Times-Bold'
  | 'Times-Italic'
  | 'Times-BoldItalic'
  | 'Courier'
  | 'Courier-Bold'
  | 'Courier-Oblique'
  | 'Courier-BoldOblique'
  | 'Symbol'
  | 'ZapfDingbats';

/** One `/ExtGState` the stream refers to by name. */
export interface ExtGStateSpec {
  /** `/ca` — non-stroking alpha. */
  readonly fillAlpha?: number;
  /** `/CA` — stroking alpha. */
  readonly strokeAlpha?: number;
  /** `/BM` — blend mode, e.g. `"Multiply"` for a highlight. */
  readonly blendMode?: string;
}

/** What the stream's `/Resources` must contain, by the names the content uses. */
export interface AppearanceResources {
  readonly extGState: Readonly<Record<string, ExtGStateSpec>>;
  readonly fonts: Readonly<Record<string, StandardFontName>>;
}

/** A generated `/AP /N` form XObject, as data. */
export interface AppearanceStream {
  /** `/BBox` in the stream's own space. */
  readonly bbox: PdfRect;
  /** `/Matrix`, omitted when it is the identity. */
  readonly matrix?: readonly [number, number, number, number, number, number];
  /** The content stream, as PDF operators. */
  readonly content: string;
  readonly resources: AppearanceResources;
}

/** Builds the appearance of one annotation, or `null` when it has nothing to draw. */
export type AppearanceGenerator = (input: AppearanceInput) => AppearanceStream | null;

/** Fills in the parts of an {@link AppearanceInput} a caller did not give. */
export function appearanceInput(
  partial: Partial<AppearanceInput> & Pick<AppearanceInput, 'subtype' | 'rect'>,
): AppearanceInput {
  return {
    color: null,
    interiorColor: null,
    opacity: null,
    borderWidth: null,
    quadPoints: [],
    paths: [],
    vertices: [],
    contents: null,
    extra: {},
    ...partial,
    rect: normaliseRect(partial.rect),
  };
}

/** `x0 <= x1`, `y0 <= y1`. A `/Rect` in the wild is often the other way round. */
export function normaliseRect(r: PdfRect): PdfRect {
  return {
    x0: Math.min(r.x0, r.x1),
    y0: Math.min(r.y0, r.y1),
    x1: Math.max(r.x0, r.x1),
    y1: Math.max(r.y0, r.y1),
  };
}

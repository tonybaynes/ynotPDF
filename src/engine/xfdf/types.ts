/**
 * The neutral comment record FDF and XFDF are both read into and written from (M32).
 *
 * It is deliberately *not* `ModelAnnotation`: an exchange file has no model ids, names its pages
 * by number and its parents by `/NM`, and carries a few things the model keeps in its `extra`
 * bag. Putting the exchange shape in its own type means `read.ts`, `write.ts` and `fdf.ts` all
 * agree about what a comment is, and `convert.ts` is the only file that has to know how the
 * model spells any of it.
 *
 * Geometry is PDF user space, points, origin bottom-left — the same space as `/Rect`, which is
 * also XFDF's (XFDF 3.0 §2.2 and ISO 19444-1). Nothing here flips a coordinate.
 */

import type { AnnotationFlags, AnnotationSubtype } from '@engine/PdfEngine';
import type { PdfPoint, PdfRect } from '@shared/pdf';

/** The subtypes this reader and writer know how to name in an exchange file. */
export const XFDF_SUBTYPES = [
  'Text',
  'FreeText',
  'Line',
  'Square',
  'Circle',
  'Polygon',
  'PolyLine',
  'Highlight',
  'Underline',
  'Squiggly',
  'StrikeOut',
  'Stamp',
  'Caret',
  'Ink',
  'Popup',
  'FileAttachment',
  'Sound',
  'Link',
  'Redact',
] as const;

/** XFDF element name ↔ PDF subtype. Lower-case throughout, as the format has it. */
export const XFDF_ELEMENT_BY_SUBTYPE: Readonly<Record<string, string>> = {
  Text: 'text',
  FreeText: 'freetext',
  Line: 'line',
  Square: 'square',
  Circle: 'circle',
  Polygon: 'polygon',
  PolyLine: 'polyline',
  Highlight: 'highlight',
  Underline: 'underline',
  Squiggly: 'squiggly',
  StrikeOut: 'strikeout',
  Stamp: 'stamp',
  Caret: 'caret',
  Ink: 'ink',
  Popup: 'popup',
  FileAttachment: 'fileattachment',
  Sound: 'sound',
  Link: 'link',
  Redact: 'redact',
};

export const XFDF_SUBTYPE_BY_ELEMENT: Readonly<Record<string, AnnotationSubtype>> =
  Object.fromEntries(
    Object.entries(XFDF_ELEMENT_BY_SUBTYPE).map(([subtype, element]) => [
      element,
      subtype as AnnotationSubtype,
    ]),
  );

/** Flags as they are spelled in an XFDF `flags` attribute (PDF 12.5.3, in order). */
export const XFDF_FLAG_NAMES = [
  'invisible',
  'hidden',
  'print',
  'nozoom',
  'norotate',
  'noview',
  'readonly',
  'locked',
  'togglenoview',
] as const;

export const DEFAULT_XFDF_FLAGS: AnnotationFlags = {
  hidden: false,
  print: true,
  noView: false,
  readOnly: false,
  locked: false,
};

/** One comment in an exchange file. Everything optional is `null` when the file omits it. */
export interface XfdfAnnotation {
  readonly subtype: AnnotationSubtype;
  /** 0-based page number, as the file has it. */
  readonly page: number;
  readonly rect: PdfRect;
  /** `/NM`. The identity import merges on, and what a reply's `inReplyTo` names. */
  readonly name: string | null;
  readonly contents: string | null;
  /** `/RC` — rich text, as the XHTML fragment the file carries. */
  readonly richContents: string | null;
  /** `/T`. */
  readonly author: string | null;
  readonly subject: string | null;
  /** ISO 8601. */
  readonly created: string | null;
  readonly modified: string | null;
  /** `0xRRGGBB`. */
  readonly color: number | null;
  readonly interiorColor: number | null;
  readonly opacity: number | null;
  readonly borderWidth: number | null;
  readonly flags: AnnotationFlags;
  /** 8 numbers per quad, `/QuadPoints` order. */
  readonly quadPoints: ReadonlyArray<number>;
  /** Ink gestures, a polygon's vertices, or a line's two ends. */
  readonly paths: ReadonlyArray<ReadonlyArray<PdfPoint>>;
  /** `/Name` — a note's icon, a stamp's name, an attachment's icon. */
  readonly icon: string | null;
  readonly state: string | null;
  readonly stateModel: string | null;
  /** The `/NM` of the annotation this one replies to. */
  readonly inReplyTo: string | null;
  /** `/RT`: `"R"` (a reply) or `"Group"`. */
  readonly replyType: string | null;
  readonly intent: string | null;
  readonly defaultAppearance: string | null;
  readonly defaultStyle: string | null;
  /** `/Rotate`, degrees. */
  readonly rotate: number | null;
  /** `/Q`: 0 left, 1 centre, 2 right. */
  readonly align: number | null;
  /** `/CL` — 4 or 6 numbers. */
  readonly callout: ReadonlyArray<number>;
  /** `/RD` — 4 numbers. */
  readonly padding: ReadonlyArray<number>;
  /** `/LE` as one name (a callout's leader). */
  readonly lineEnding: string | null;
  /** `/LE` as two names (a line's two ends). */
  readonly lineEndings: ReadonlyArray<string> | null;
  /** `/BS /D` dash pattern. */
  readonly dashArray: ReadonlyArray<number> | null;
  /** `/BE /I` cloud intensity; 0 or null is not cloudy. */
  readonly cloudy: number | null;
  /** The file name a FileAttachment names, for the reader to be told about. */
  readonly attachmentName: string | null;
}

/** An empty comment, so every producer fills in only what it has. */
export const EMPTY_XFDF_ANNOTATION: XfdfAnnotation = {
  subtype: 'Text',
  page: 0,
  rect: { x0: 0, y0: 0, x1: 0, y1: 0 },
  name: null,
  contents: null,
  richContents: null,
  author: null,
  subject: null,
  created: null,
  modified: null,
  color: null,
  interiorColor: null,
  opacity: null,
  borderWidth: null,
  flags: DEFAULT_XFDF_FLAGS,
  quadPoints: [],
  paths: [],
  icon: null,
  state: null,
  stateModel: null,
  inReplyTo: null,
  replyType: null,
  intent: null,
  defaultAppearance: null,
  defaultStyle: null,
  rotate: null,
  align: null,
  callout: [],
  padding: [],
  lineEnding: null,
  lineEndings: null,
  dashArray: null,
  cloudy: null,
  attachmentName: null,
};

/** One AcroForm field's value, for the optional form-data half of an export. */
export interface XfdfField {
  /** Fully qualified name (`/T` chain joined with dots). */
  readonly name: string;
  readonly value: string;
}

/** A whole exchange file. */
export interface XfdfDocument {
  /** `/F` — the PDF these comments came from, as a path or a URL. */
  readonly href: string | null;
  /** `/ID` — the source file's two identifiers, hex, uppercase without delimiters. */
  readonly ids: { readonly original: string; readonly modified: string } | null;
  readonly annotations: ReadonlyArray<XfdfAnnotation>;
  readonly fields: ReadonlyArray<XfdfField>;
}

export const EMPTY_XFDF_DOCUMENT: XfdfDocument = {
  href: null,
  ids: null,
  annotations: [],
  fields: [],
};

/** What went wrong reading an exchange file, worded for the reader. */
export class XfdfError extends Error {
  readonly code: 'not-xfdf' | 'not-fdf' | 'malformed';

  constructor(code: XfdfError['code'], message: string) {
    super(message);
    this.name = 'XfdfError';
    this.code = code;
  }
}

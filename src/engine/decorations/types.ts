/**
 * Page decorations (M53, ADR 0020) — what a header, a footer, a Bates number, a watermark or a
 * background *is*, as data.
 *
 * Two shapes, and the difference between them matters:
 *
 * - a **spec** is what the reader chose in the dialog — a font, a margin, six pieces of text with
 *   macros in them, a range of pages. It is JSON, it lives in the model, it is journalled, and it
 *   is what the marker on the page carries so a file can be reopened and edited a year later.
 * - a **draw** is one piece of finished content for one page — a content stream, a bounding box,
 *   a placement matrix and the resources the stream names. It is derived from a spec by the pure
 *   functions in `draw.ts`, and it is what both the live engine and the writer consume, so the
 *   preview, the page and the saved file cannot disagree.
 *
 * Nothing here imports PDFium or pdf-lib.
 */

import type { PdfMatrix, PdfRect } from '@shared/pdf';
import type { AppearanceResources } from '../appearance/types';

/** The families of decoration. One dialog each; one marker `Kind` each. */
export type DecorationKind = 'header-footer' | 'bates' | 'watermark' | 'background';

/** The content mark every decoration this application writes is wrapped in (ADR 0020 §1). */
export const DECORATION_MARK = 'YNOTDec';

/** Keys of the mark's parameter dictionary. */
export const MARK_ID = 'Id';
export const MARK_KIND = 'Kind';
export const MARK_SPEC = 'Spec';

/** The six zones of a header/footer, in reading order. */
export const ZONES = [
  'header-left',
  'header-centre',
  'header-right',
  'footer-left',
  'footer-centre',
  'footer-right',
] as const;

export type ZoneName = (typeof ZONES)[number];

/** Which of the nine positions a watermark or background sits in. */
export const POSITIONS = [
  'top-left',
  'top-centre',
  'top-right',
  'middle-left',
  'centre',
  'middle-right',
  'bottom-left',
  'bottom-centre',
  'bottom-right',
] as const;

export type PositionName = (typeof POSITIONS)[number];

/** A font as a decoration names it: one of the standard 14, by its `/BaseFont`. */
export type DecorationFont =
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
  | 'Courier-BoldOblique';

export const DECORATION_FONTS: ReadonlyArray<DecorationFont> = [
  'Helvetica',
  'Helvetica-Bold',
  'Helvetica-Oblique',
  'Helvetica-BoldOblique',
  'Times-Roman',
  'Times-Bold',
  'Times-Italic',
  'Times-BoldItalic',
  'Courier',
  'Courier-Bold',
  'Courier-Oblique',
  'Courier-BoldOblique',
];

/** Margins from the page edge, in points. */
export interface Margins {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
}

export const DEFAULT_MARGINS: Margins = { left: 36, right: 36, top: 28, bottom: 28 };

/** Header and footer: six zones of text with macros, one font, one colour. */
export interface HeaderFooterSpec {
  readonly kind: 'header-footer';
  /** Zone text, macros unexpanded. A zone missing or empty draws nothing. */
  readonly zones: Readonly<Partial<Record<ZoneName, string>>>;
  readonly font: DecorationFont;
  readonly size: number;
  /** `0xRRGGBB`. Solid — there is no alpha anywhere in this application. */
  readonly colour: number;
  readonly margins: Margins;
  /** Draw a rule under the header and over the footer. */
  readonly underline: boolean;
  /**
   * Scale the page's own content down so the decoration cannot sit on top of it. The value is
   * the fraction of the page the content is squeezed into, or 0 for "leave the page alone".
   */
  readonly shrink: number;
  /** Where the numbering of `<<1>>` starts, and at which page of the range. */
  readonly startNumber: number;
  /** Total used by `<<1 of n>>`; 0 means "the number of pages in the range". */
  readonly totalOverride: number;
}

/** Bates numbering: a running number with a prefix and a suffix. */
export interface BatesSpec {
  readonly kind: 'bates';
  readonly prefix: string;
  readonly suffix: string;
  /** How many digits the number is padded to (1..15, Foxit's own limit is 15). */
  readonly digits: number;
  readonly startAt: number;
  readonly zone: ZoneName;
  readonly font: DecorationFont;
  readonly size: number;
  readonly colour: number;
  readonly margins: Margins;
}

/** What a watermark or a background is made of. */
export type DecorationSource =
  | { readonly kind: 'text'; readonly text: string }
  /** A picture, always PNG by the time it gets here (M31's rule, reused). */
  | { readonly kind: 'image'; readonly key: string }
  /** One page of another PDF. */
  | { readonly kind: 'pdf'; readonly key: string }
  /** A flat colour filling the whole page — backgrounds only. */
  | { readonly kind: 'colour' };

export interface WatermarkSpec {
  readonly kind: 'watermark' | 'background';
  readonly source: DecorationSource;
  /** For `text`. */
  readonly font: DecorationFont;
  readonly size: number;
  readonly colour: number;
  /** Anticlockwise degrees. */
  readonly rotation: number;
  /** Size relative to the page, as a fraction of the page's shorter side; 0 = natural size. */
  readonly scale: number;
  readonly position: PositionName;
  /** Nudge from that position, in points. */
  readonly offsetX: number;
  readonly offsetY: number;
  /** Behind the page's own content rather than over it. */
  readonly behind: boolean;
  /** Whether it appears when the document is printed (`/Print` on the marked content). */
  readonly print: boolean;
  /** Whether it appears on screen. Off + print on is the "printed copies only" watermark. */
  readonly screen: boolean;
}

/** Every decoration spec. Discriminated by `kind`, which is also the marker's `Kind`. */
export type DecorationSpec = HeaderFooterSpec | BatesSpec | WatermarkSpec;

/** A decoration in the model: a spec, the pages it is on, and an id that outlives the session. */
export interface Decoration {
  readonly id: string;
  readonly kind: DecorationKind;
  /** The page range as the reader typed it (M40's dialect). Empty means every page. */
  readonly range: string;
  readonly spec: DecorationSpec;
}

/**
 * One finished piece of content for one page.
 *
 * `content` is drawn in the space `bbox` describes and placed on the page by `matrix`, which is
 * exactly a form XObject's `/BBox` and the `cm` before its `Do`.
 */
export interface DecorationDraw {
  /** The decoration this came from — the marker's `Id`. */
  readonly id: string;
  readonly kind: DecorationKind;
  readonly bbox: PdfRect;
  readonly matrix: PdfMatrix;
  readonly content: string;
  readonly resources: AppearanceResources;
  /** Under the page's own content rather than over it. */
  readonly behind: boolean;
  /** `/Print` and `/View` on the marked content, for a watermark that is one or the other. */
  readonly print: boolean;
  readonly screen: boolean;
  /** The spec as JSON, carried in the marker so a reopened file can be edited (ADR 0020 §1). */
  readonly spec: string;
}

/** A decoration found on a page — ours by its mark, or another application's by its shape. */
export interface FoundDecoration {
  readonly page: number;
  readonly id: string;
  readonly kind: DecorationKind | 'unknown';
  /** The object's index in the page's object list, so the engine can reach it again. */
  readonly index: number;
  /** The spec as stored in the marker, when this one is ours. */
  readonly spec: string | null;
  /**
   * True for a decoration this application did not write — another editor's watermark, found by
   * a `/Watermark` annotation or an optional-content group that names itself one. It can be
   * counted and removed; it cannot be edited, because nothing says what it was meant to be.
   */
  readonly foreign: boolean;
  /** What to call it in a list, for a foreign one. */
  readonly label?: string;
}

/** What a spec needs to know about the page it is being drawn on. */
export interface PageContext {
  /** 0-based index in the document. */
  readonly index: number;
  /** 1-based position within the decoration's own range. */
  readonly ordinal: number;
  /** How many pages the range holds. */
  readonly rangeCount: number;
  /** The page's crop box: decorations sit inside what the reader sees, not the media box. */
  readonly box: PdfRect;
  /** `/Rotate`, so a header stays at the top of the page as displayed. */
  readonly rotation: number;
  /** For `<<FileName>>` and friends. */
  readonly document: DocumentContext;
}

/** Document-wide facts the macros can name. */
export interface DocumentContext {
  readonly fileName: string;
  readonly fullPath: string;
  readonly title: string;
  readonly author: string;
  readonly subject: string;
  readonly pageCount: number;
  /** The label `/PageLabels` gives this page, for `<<PageLabel>>`. */
  readonly labels: ReadonlyArray<string>;
  /** The moment the decoration was applied, ISO 8601 — never `Date.now()` inside a draw. */
  readonly now: string;
  /** Bates value for this page, when a Bates decoration is on the document. */
  readonly bates?: string;
}

/** The empty resource set, so a stream that names nothing still has the shape. */
export const NO_RESOURCES: AppearanceResources = { extGState: {}, fonts: {} };

/**
 * What "optimise this document" means, as plain data (M100, ADR 0019).
 *
 * Everything in `src/engine/optimise/` is a **pure function over bytes**, in the sense M41's ops
 * established: bytes and options in, bytes out; no `Document`, no tab, no dialog, no DOM, and —
 * the part that matters here — no `node:*` and no Electron either, because the same code runs in
 * a renderer Worker, in a plain vitest module and (M120, M121) with no window open at all.
 *
 * The one thing this layer cannot do for itself is qpdf, which lives in the main process
 * (ADR 0011). `qpdf/tasks.ts` is given a runner rather than making one, so the rule above holds.
 *
 * Progress and cancellation are M41's `OpContext`, reused rather than restated: an optimise is a
 * whole-document operation like a split, and two spellings of "cancel" would be one too many.
 */

import type { OpContext } from '../ops/types';

export type { OpContext, OpProgress } from '../ops/types';
export { OpCancelled, OpFailed, checkCancelled, isCancelled } from '../ops/types';

// ---- the options -------------------------------------------------------------------------------

/** The three classes of image the spec and every optimiser before us treat separately. */
export type ImageClass = 'colour' | 'grey' | 'mono';

/** What to re-encode an image's samples with. `keep` leaves the existing filter alone. */
export type ImageCodec = 'keep' | 'jpeg' | 'flate' | 'ccitt';

/** Downsampling and recompression for one class of image. */
export interface ImagePolicy {
  /** Reduce to this many pixels per inch of the page it is drawn at. `0` disables downsampling. */
  readonly targetDpi: number;
  /**
   * Only downsample an image already above this many dpi. Foxit and Acrobat both ask for the
   * threshold separately so that an image a little over the target is left alone; without it,
   * every image in the document is resampled for a saving of nothing.
   */
  readonly thresholdDpi: number;
  readonly codec: ImageCodec;
  /** JPEG quality 1–100. Ignored unless `codec` is `jpeg`. */
  readonly quality: number;
}

export interface ImageOptions {
  readonly colour: ImagePolicy;
  readonly grey: ImagePolicy;
  readonly mono: ImagePolicy;
  /**
   * Never make an image bigger. A photograph re-encoded as flate, or a small JPEG re-encoded at a
   * high quality, can grow; when it does, the original is kept and nothing is said about it.
   */
  readonly neverGrow: boolean;
}

export interface FontOptions {
  /** Cut every embedded font down to the glyphs the document actually draws. */
  readonly subset: boolean;
  /**
   * Remove the font program of a font a reader is certain to have — the Standard 14 and the
   * families metric-compatible with them. Anything else keeps its program (see `fonts.ts`).
   */
  readonly unembedStandard: boolean;
}

/** Things a document carries that a smaller copy may do without. */
export interface DiscardOptions {
  /** `/Thumb` page thumbnails, which every viewer can draw for itself. */
  readonly thumbnails: boolean;
  /** `/Alternates` — alternative representations of an image, which almost nothing reads. */
  readonly alternateImages: boolean;
  /** The information dictionary and the XMP packet. */
  readonly metadata: boolean;
  readonly bookmarks: boolean;
  readonly links: boolean;
  /** Every annotation that is not a link or a widget: comments, markup, stamps, notes. */
  readonly comments: boolean;
  /** The AcroForm and its widgets. Field *values* go with them. */
  readonly forms: boolean;
  /** Attachments in the `/EmbeddedFiles` name tree and `/FileAttachment` annotations. */
  readonly embeddedFiles: boolean;
  /** Document-level and field-level JavaScript. */
  readonly javascript: boolean;
  /** `/PieceInfo` — private application data left behind by whatever made the file. */
  readonly privateData: boolean;
}

/** Structural work, all of it qpdf's (`qpdf/structure.ts` builds the argv). */
export interface StructureOptions {
  /** `--object-streams=generate`: pack the small objects into compressed streams. */
  readonly objectStreams: boolean;
  /** `--recompress-flate --compression-level=9`: re-deflate every flate stream. */
  readonly recompressStreams: boolean;
  /** `--remove-unreferenced-resources=yes`: drop resources no page names. */
  readonly removeUnused: boolean;
  /** `--linearize`: fast web view. */
  readonly linearise: boolean;
}

/** Which kinds of duplicate to merge, by content hash. */
export interface DedupeOptions {
  readonly images: boolean;
  readonly fonts: boolean;
  /** Form XObjects — the same logo drawn on every page is one of these more often than not. */
  readonly xobjects: boolean;
}

/** One complete answer to "make this smaller". A preset is exactly this, stored as data. */
export interface OptimiseOptions {
  readonly images: ImageOptions;
  readonly fonts: FontOptions;
  readonly discard: DiscardOptions;
  readonly structure: StructureOptions;
  readonly dedupe: DedupeOptions;
}

/** A named set of options, from `resources/optimise-presets.json` or the reader's own. */
export interface OptimisePreset {
  readonly id: string;
  readonly name: string;
  /** One sentence, shown under the name. Says what it costs, not what it does. */
  readonly description: string;
  /**
   * True when this preset changes no image sample and no font program, so the rendered pages are
   * byte-identical afterwards. The acceptance test asserts a render diff of exactly zero for one.
   */
  readonly lossless: boolean;
  /** False for a preset the reader saved, which may be renamed and deleted. */
  readonly builtIn: boolean;
  readonly options: OptimiseOptions;
}

// ---- what an optimise produced -------------------------------------------------------------------

/** One line of the report: what was done, how many times, and what it saved. */
export interface OptimiseChange {
  /** A sentence for the reader, already in the past tense: "Downsampled 12 images to 150 dpi". */
  readonly what: string;
  readonly count: number;
  /** Bytes saved by this change, as measured on the objects it rewrote. Never negative. */
  readonly saved: number;
}

export interface OptimiseResult {
  readonly bytes: Uint8Array;
  readonly before: number;
  readonly after: number;
  readonly changes: ReadonlyArray<OptimiseChange>;
  /** Things the reader should know: a font left alone, an image codec we could not read. */
  readonly warnings: ReadonlyArray<string>;
  /** True when the finished file is linearised. */
  readonly linearised: boolean;
}

// ---- the space audit ------------------------------------------------------------------------------

/**
 * The categories the audit divides a file into, in the order the chart and the table show them.
 *
 * `structure` is the remainder — the catalogue, the page tree, the cross-reference table and
 * anything nothing else claimed — so the categories always add up to the file's own length.
 */
export type AuditCategory =
  | 'images'
  | 'fonts'
  | 'content'
  | 'comments'
  | 'forms'
  | 'bookmarks'
  | 'attachments'
  | 'metadata'
  | 'thumbnails'
  | 'structure';

/** The words the reader sees. Not derived from the key: "content" alone means nothing. */
export const AUDIT_LABELS: Readonly<Record<AuditCategory, string>> = {
  images: 'Images',
  fonts: 'Fonts',
  content: 'Page content',
  comments: 'Comments and markup',
  forms: 'Form fields',
  bookmarks: 'Bookmarks and links',
  attachments: 'Attached files',
  metadata: 'Document information',
  thumbnails: 'Page thumbnails',
  structure: 'Document structure',
};

/** The order the chart and the table use. */
export const AUDIT_ORDER: ReadonlyArray<AuditCategory> = [
  'images',
  'fonts',
  'content',
  'comments',
  'forms',
  'bookmarks',
  'attachments',
  'metadata',
  'thumbnails',
  'structure',
];

export interface AuditSlice {
  readonly category: AuditCategory;
  readonly bytes: number;
  /** Share of the whole file, 0–1. */
  readonly share: number;
  /** How many objects were counted here. Zero is a real answer, not a missing one. */
  readonly objects: number;
}

export interface SpaceAudit {
  /** The file's own length, which the slices add up to. */
  readonly total: number;
  readonly slices: ReadonlyArray<AuditSlice>;
}

/** Convenience for callers that want one number without searching the list. */
export function sliceOf(audit: SpaceAudit, category: AuditCategory): AuditSlice {
  return (
    audit.slices.find((s) => s.category === category) ?? {
      category,
      bytes: 0,
      share: 0,
      objects: 0,
    }
  );
}

// ---- what qpdf said --------------------------------------------------------------------------------

/** `qpdf --check`, read back as facts rather than as text. */
export interface QpdfCheck {
  /** qpdf found nothing wrong at all. */
  readonly ok: boolean;
  /** qpdf could not read the file even far enough to complain about it in detail. */
  readonly unreadable: boolean;
  readonly linearised: boolean;
  readonly encrypted: boolean;
  /** `"1.7"`, or `null` when qpdf did not say. */
  readonly version: string | null;
  /** Sentences, with qpdf's own `WARNING:` prefix removed. */
  readonly warnings: ReadonlyArray<string>;
  readonly errors: ReadonlyArray<string>;
}

/** What a repair produced. `repaired` is false when there was nothing wrong to fix. */
export interface RepairResult {
  readonly bytes: Uint8Array;
  readonly repaired: boolean;
  readonly warnings: ReadonlyArray<string>;
}

/** Bytes and warnings — what every qpdf pass that rewrites a file answers with. */
export interface BytesAndWarnings {
  readonly bytes: Uint8Array;
  readonly warnings: ReadonlyArray<string>;
}

/** The context an optimise runs in; an alias so callers need not reach into M41's file. */
export type OptimiseContext = OpContext;

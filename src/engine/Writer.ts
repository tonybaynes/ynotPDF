/**
 * `Writer` — how a document becomes bytes on disk (M21, ADR 0010).
 *
 * A writer takes **base bytes** and a **plan** and returns new bytes. The base is the document
 * as the engine currently holds it (`PdfEngine.save`), which already carries everything PDFium
 * can apply and reverse — rotation, boxes, annotations, field values, pages we inserted — with
 * every object it does not understand preserved. The plan says what is *left*: page order and
 * presence, page labels, the boxes PDFium has no setter for, the information dictionary and XMP,
 * the outline, named destinations, layer visibility, and appearance streams.
 *
 * Two properties matter and are tested:
 *
 * - **Pure.** The same (bytes, plan) always produces the same document. Nothing here reads a
 *   clock, a file or a UI. Recovery after a crash and a batch run over a hundred files therefore
 *   produce exactly what an interactive save would.
 * - **Sparse.** Every section of the plan is nullable, and `null` means *leave it alone*. A save
 *   with an empty plan is a re-serialisation and nothing else, which is what makes a no-op save
 *   round-trip.
 *
 * `FullRewriteWriter` (pdf-lib) is the implementation M21 ships. M80 adds `IncrementalWriter`,
 * which appends an update instead and becomes the default; M70 hooks encryption into the same
 * pipeline.
 */

import type { PageIndex, PdfPoint, PdfRect } from '@shared/pdf';
import type { AnnotationSubtype, Destination, ProgressCallback } from './PdfEngine';
import type { AppearanceInput } from './appearance/types';

/** One page of the finished document. */
export interface PlannedPage {
  /**
   * Index of the page in the **base** document this one comes from. Reordering is expressed by
   * the order of `WritePlan.pages`; deletion by leaving a base page out.
   */
  readonly source: PageIndex;
  /** `/PageLabels` text for this page, when the plan carries labels at all. */
  readonly label?: string;
  /** Boxes to set on this page. Absent keys are left as the base has them; `null` removes. */
  readonly boxes?: PlannedBoxes;
  /** Annotations on this page that need something the engine could not do. */
  readonly annotations?: ReadonlyArray<PlannedAnnotation>;
}

export interface PlannedBoxes {
  readonly media?: PdfRect;
  readonly crop?: PdfRect | null;
  readonly bleed?: PdfRect | null;
  readonly trim?: PdfRect | null;
  readonly art?: PdfRect | null;
}

/**
 * An annotation the writer has work for. `index` is its position in the base page's `/Annots`,
 * which is the order PDFium enumerates them in; `subtype` and `rect` are checked against the
 * dictionary found there, so a mismatch is skipped and reported rather than written to the wrong
 * annotation.
 */
export interface PlannedAnnotation {
  readonly index: number;
  readonly subtype: AnnotationSubtype;
  readonly rect: PdfRect;
  /**
   * Dictionary entries to write. Present-and-null **removes** the entry, which is the one thing
   * `PdfEngine.updateAnnotation` cannot express — a patch says what a value becomes, never "and
   * empty that one" — so clearing a note's text or an ink list arrives here.
   */
  readonly properties?: PlannedAnnotationProperties;
  /** Draw an `/AP`. `replace` overwrites one the file already has. */
  readonly appearance?: { readonly input: AppearanceInput; readonly replace: boolean };
}

/** Annotation dictionary entries, in model terms. `null` removes the entry. */
export interface PlannedAnnotationProperties {
  readonly contents?: string | null;
  readonly author?: string | null;
  readonly subject?: string | null;
  readonly name?: string | null;
  readonly state?: string | null;
  /** `/C` as `0xRRGGBB`. */
  readonly color?: number | null;
  /** `/IC` as `0xRRGGBB`. */
  readonly interiorColor?: number | null;
  /** `/CA` 0..1. */
  readonly opacity?: number | null;
  /** `/BS /W`. */
  readonly borderWidth?: number | null;
  readonly quadPoints?: ReadonlyArray<number> | null;
  /** `/InkList`. */
  readonly paths?: ReadonlyArray<ReadonlyArray<PdfPoint>> | null;
  /** `/Vertices`, or `/L` for a Line. */
  readonly vertices?: ReadonlyArray<PdfPoint> | null;
}

/**
 * A form field value the engine could not write. `null` removes `/V`, which is what clearing a
 * field means; the writer then drops the widgets' appearance streams and sets
 * `/NeedAppearances`, so every viewer regenerates rather than showing the value that is gone.
 */
export interface PlannedField {
  /** Fully qualified field name (`/T` chain joined with dots). */
  readonly name: string;
  readonly value: string | null;
}

/** The information dictionary and XMP. Absent keys are left alone; `null` removes the entry. */
export interface PlannedMetadata {
  readonly title?: string | null;
  readonly author?: string | null;
  readonly subject?: string | null;
  readonly keywords?: string | null;
  readonly creator?: string | null;
  readonly producer?: string | null;
  /** ISO 8601. */
  readonly created?: string | null;
  readonly modified?: string | null;
  /** Raw XMP packet. */
  readonly xmp?: string | null;
}

/** A destination in the finished document. `page` indexes {@link WritePlan.pages}. */
export interface PlannedDestination {
  readonly page: number;
  readonly fit: Destination['fit'];
  readonly left?: number | null;
  readonly top?: number | null;
  readonly zoom?: number | null;
  readonly rect?: PdfRect | null;
}

/** One bookmark. `parent` indexes the outline array; roots have `null`. Parents precede children. */
export interface PlannedOutlineItem {
  readonly title: string;
  readonly parent: number | null;
  readonly dest: PlannedDestination | null;
  readonly uri: string | null;
  readonly open: boolean;
  readonly bold: boolean;
  readonly italic: boolean;
  /** `0xRRGGBB`, or null for the viewer's default. */
  readonly color: number | null;
}

/** A named destination for `/Names /Dests`. */
export interface PlannedNamedDestination {
  readonly name: string;
  readonly dest: PlannedDestination;
}

/**
 * Visibility of one optional-content group.
 *
 * The engine's layer id is `ocg.<object number>` in the file **as it was opened**, and a
 * re-serialisation renumbers objects — so the id alone cannot find the group again. The writer
 * matches on `name` first and falls back to `index`, the group's position in the same
 * `/Order`-then-`/OCGs` walk the engine did; `id` is carried for diagnostics.
 */
export interface PlannedLayer {
  readonly id: string;
  readonly name: string;
  readonly index: number;
  readonly visible: boolean;
}

/** The finished document, as data. Every nullable section means "leave the base alone". */
export interface WritePlan {
  /** Pages in final order. Never empty. */
  readonly pages: ReadonlyArray<PlannedPage>;
  /** True when `pages` is exactly the base's pages in the base's order. */
  readonly pagesUnchanged: boolean;
  /** Write `/PageLabels` from the pages' `label`s. */
  readonly labels: boolean;
  readonly metadata: PlannedMetadata | null;
  /**
   * Metadata to write **only when the base has no information dictionary at all**.
   *
   * PDFium rebuilds the cross-reference table of a damaged file, reads its `/Info` perfectly
   * well — and then serialises the repaired document without one. Opening such a file and saving
   * it would silently lose the title, the author and the dates. A normal file has an `/Info`, so
   * this is ignored and nothing is touched; a repaired one gets its metadata put back.
   */
  readonly metadataFallback: PlannedMetadata | null;
  /** Replaces `/Outlines` wholesale. An empty array removes the outline. */
  readonly outline: ReadonlyArray<PlannedOutlineItem> | null;
  /** Replaces `/Names /Dests`. */
  readonly namedDestinations: ReadonlyArray<PlannedNamedDestination> | null;
  readonly layers: ReadonlyArray<PlannedLayer> | null;
  readonly fields: ReadonlyArray<PlannedField> | null;
}

/** An empty plan over `pageCount` pages: a straight re-serialisation. */
export function emptyWritePlan(pageCount: number): WritePlan {
  return {
    pages: Array.from({ length: pageCount }, (_v, i) => ({ source: i })),
    pagesUnchanged: true,
    labels: false,
    metadata: null,
    metadataFallback: null,
    outline: null,
    namedDestinations: null,
    layers: null,
    fields: null,
  };
}

/** True when the plan asks for nothing a re-serialisation would not already do. */
export function planIsEmpty(plan: WritePlan): boolean {
  return (
    plan.pagesUnchanged &&
    !plan.labels &&
    plan.metadata === null &&
    plan.outline === null &&
    plan.namedDestinations === null &&
    plan.layers === null &&
    plan.fields === null &&
    plan.pages.every((p) => p.boxes === undefined && (p.annotations?.length ?? 0) === 0)
  );
}

export interface WriteOptions {
  /** Write cross-reference and object streams (PDF 1.5+). Default true. */
  readonly objectStreams?: boolean;
  /**
   * Producer string for the information dictionary when the plan does not set one. Absent leaves
   * the base's `/Producer` alone — which is what a no-op save wants.
   */
  readonly producer?: string;
}

/** The named phases a writer reports progress through, in order. */
export const WRITE_PHASES = [
  'parse',
  'pages',
  'labels',
  'metadata',
  'outline',
  'destinations',
  'layers',
  'annotations',
  'fields',
  'serialise',
] as const;

export type WritePhase = (typeof WRITE_PHASES)[number];

/** Progress with the phase name, so the dialog can say what it is doing rather than only how far. */
export type WriteProgressCallback = (fraction: number, phase: WritePhase) => void;

export interface WriteRequest {
  /** The document as the engine holds it now (`PdfEngine.save`). */
  readonly bytes: Uint8Array;
  readonly plan: WritePlan;
  readonly options?: WriteOptions;
  readonly progress?: WriteProgressCallback;
  /** Aborting rejects with `WriteCancelled`. Only meaningful before the caller writes to disk. */
  readonly signal?: AbortSignal;
}

export interface WriteResult {
  readonly bytes: Uint8Array;
  /** Phases that actually changed something. */
  readonly applied: ReadonlyArray<WritePhase>;
  /** Appearance streams generated. */
  readonly appearances: number;
  /**
   * Things the writer could not do, in plain words, for the caller to show. Never a reason to
   * fail: a file that saved with one bookmark missing is better than no file at all.
   */
  readonly warnings: ReadonlyArray<string>;
}

/** Thrown when a write is aborted through its `AbortSignal`. */
export class WriteCancelled extends Error {
  override readonly name = 'WriteCancelled';

  constructor() {
    super('The save was cancelled');
  }
}

/**
 * Thrown when the base bytes cannot be rewritten at all — an encrypted document, or one pdf-lib
 * refuses to parse. The caller decides what to offer instead.
 */
export class WriteUnsupported extends Error {
  override readonly name = 'WriteUnsupported';
  /** `encrypted` when the file is protected; `corrupt` when it will not parse. */
  readonly reason: 'encrypted' | 'corrupt';

  constructor(reason: 'encrypted' | 'corrupt', message: string) {
    super(message);
    this.reason = reason;
  }
}

export interface Writer {
  /** Stable id (`"full-rewrite"`, later `"incremental"`). */
  readonly id: string;
  write(request: WriteRequest): Promise<WriteResult>;
}

/** Adapts a {@link WriteProgressCallback} to the engine's plain `ProgressCallback`. */
export function phaseProgress(
  progress: WriteProgressCallback | undefined,
  phase: WritePhase,
): ProgressCallback | undefined {
  return progress === undefined
    ? undefined
    : (fraction) => {
        progress(fraction, phase);
      };
}

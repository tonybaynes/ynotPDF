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

import type { PageIndex, PdfMatrix, PdfPoint, PdfRect } from '@shared/pdf';
import type { AnnotationSubtype, Destination, ProgressCallback } from './PdfEngine';
import type { AppearanceInput, AppearanceResources } from './appearance/types';
import type { DictValue } from './appearance/dict';

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
  /**
   * Page-object edits to replay onto the page's *original* content stream (M50, ADR 0018),
   * replacing the one the engine regenerated. Absent for a page whose objects were reordered —
   * that page keeps what PDFium wrote.
   */
  readonly objects?: PlannedObjects;
}

/** One page-object edit, in the terms of `src/engine/content/edit.ts` (M50, ADR 0018). */
export type PlannedObjectEdit =
  | {
      readonly kind: 'transform';
      /** Index in the original object list. */
      readonly index: number;
      /** The composed page-space delta. */
      readonly matrix: PdfMatrix;
    }
  | { readonly kind: 'remove'; readonly index: number }
  | {
      /** A pasted or duplicated object: a base64 one-page PDF (`PdfEngine.objectAsPdf`). */
      readonly kind: 'insert';
      readonly pdf: string;
      readonly matrix: PdfMatrix;
    };

/**
 * A page's object edits with what the applier needs to trust them (M50, ADR 0018): the content
 * stream as it was before the first edit, PDFium's object kinds for it (checked against the
 * applier's own scan, so an index can never land on the wrong object) and the page-space matrix
 * of every text object as first read, which is what repositions a `Tj` exactly.
 */
export interface PlannedObjects {
  /** Base64 of the original decoded content stream. */
  readonly original: string;
  readonly kinds: ReadonlyArray<string>;
  readonly textMatrices: Readonly<Record<string, PdfMatrix>>;
  readonly edits: ReadonlyArray<PlannedObjectEdit>;
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
   * Add this annotation to the page rather than change one that is already there (M30, ADR 0013).
   *
   * PDFium creates only ten of the annotation subtypes; FreeText, Caret, Line, Polygon and
   * PolyLine are refused, so an app that offers a typewriter or an insertion mark has to write
   * them itself. `index` is ignored for an insert and `properties` carries the whole annotation,
   * not just the entries that had to be removed.
   */
  readonly insert?: boolean;
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
  /** `/F`, the flag bit field. */
  readonly flags?: number;
  /** `/CreationDate` and `/M`, ISO 8601. */
  readonly created?: string | null;
  readonly modified?: string | null;
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
  /**
   * Dictionary entries by PDF key, for the ones PDFium's annotation API has no setter for
   * (M30, ADR 0013): `/CL`, `/Q`, `/Rotate`, `/RD` and friends. `null` removes the entry. The
   * mapping from model keys to these is `engine/appearance/dict.ts`, which is also what decides
   * which keys the engine wrote itself and so never appear here.
   */
  readonly entries?: Readonly<Record<string, DictValue | null>>;
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

/**
 * How the finished document asks to be opened, plus the two catalogue facts that sit beside it
 * on Foxit's Advanced tab (M72, ADR 0017).
 *
 * Present-and-null removes the entry, exactly as {@link PlannedMetadata} does; a key the plan
 * does not mention is left as the base has it. `openAction` indexes {@link WritePlan.pages}, so
 * a document whose pages were reordered still opens at the page the reader chose.
 */
export interface PlannedView {
  readonly pageMode?: 'none' | 'outlines' | 'thumbnails' | 'fullscreen' | 'attachments' | 'ocg';
  readonly pageLayout?:
    | 'default'
    | 'single'
    | 'one-column'
    | 'two-column-left'
    | 'two-column-right'
    | 'two-page-left'
    | 'two-page-right';
  readonly openAction?: PlannedDestination | null;
  readonly hideToolbar?: boolean;
  readonly hideMenubar?: boolean;
  readonly hideWindowUi?: boolean;
  readonly fitWindow?: boolean;
  readonly centreWindow?: boolean;
  readonly displayDocTitle?: boolean;
  readonly printScaling?: 'app-default' | 'none';
  readonly direction?: 'l2r' | 'r2l';
  /** The catalogue's `/Lang`. */
  readonly lang?: string | null;
  /** The catalogue's `/URI /Base`. */
  readonly baseUrl?: string | null;
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
  /**
   * Custom information-dictionary entries by key — **the complete set** the finished document
   * should have (M72, ADR 0017).
   *
   * A key mapped to `null` is removed, and so is any non-standard key the file has that this
   * object does not mention *and* whose value is text the reader could have seen. That last
   * condition is what stops a save from dropping an entry holding an array or a dictionary,
   * which the model never showed and so could not have been asked to delete.
   */
  readonly custom?: Readonly<Record<string, string | null>>;
  /** `/Trapped` (M72, ADR 0017). */
  readonly trapped?: 'True' | 'False' | 'Unknown' | null;
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

/**
 * Metadata of one embedded file the writer must put where the PDF specification says it goes
 * (M12, ADR 0011).
 *
 * PDFium's attachment API writes `/Desc` and `/Subtype` into the embedded stream's `/Params`
 * dictionary, which is not where a reader looks: a description belongs on the file
 * *specification* and the MIME type is a name on the stream itself. The engine's bytes carry
 * the file and its name correctly; this section moves the rest into place. Matched by name.
 */
export interface PlannedAttachment {
  /** Name in the `/EmbeddedFiles` name tree. */
  readonly name: string;
  /** `null` removes the description. */
  readonly description: string | null;
  /** MIME type, written as the stream's `/Subtype` name. `null` removes it. */
  readonly mimeType: string | null;
}

/**
 * The source of a shared XObject an appearance stream may name by key (M31, ADR 0015).
 *
 * Bytes travel as base64 so the plan stays JSON: it is journalled, sent to the writer's Worker
 * and replayed by a batch run, and none of those can carry a `Uint8Array` unchanged.
 */
export type PlannedXObject =
  | {
      /** A content stream drawn in its own box — a catalogue stamp. */
      readonly kind: 'form';
      readonly content: string;
      readonly bbox: PdfRect;
      readonly resources?: AppearanceResources;
    }
  | {
      /**
       * A picture as PNG bytes — a custom stamp. Every custom stamp is converted to PNG when it
       * is imported, whatever it came from (an image file, the clipboard, a rendered PDF page),
       * so there is one stored format and its alpha channel is the transparency.
       */
      readonly kind: 'image';
      readonly format: 'png';
      readonly data: string;
      /** The picture's size in pixels, which is also its natural box in points. */
      readonly width: number;
      readonly height: number;
    };

/**
 * A PDF Portfolio, as instructions for the writer (M42, ADR 0014).
 *
 * The whole `/Collection` dictionary and the whole `/EmbeddedFiles` name tree are rebuilt from
 * this section, which is what lets one plan express a rename, a move between folders, a new
 * column and a reorder at once. Nothing else in the file is touched.
 *
 * The guarantee that matters is in {@link PlannedPortfolioFile.source}: a file the reader did
 * not replace says `keep`, and the writer then reuses the embedded stream object the base
 * document already holds — same reference, same bytes, same `/Filter`, same `/Params`. A
 * digitally signed PDF embedded in a portfolio therefore still verifies after a save, because
 * nothing decoded it.
 */
export interface PlannedPortfolio {
  /** `/View`. */
  readonly view: 'details' | 'tile' | 'hidden';
  /** `/Schema`, in `/O` order. */
  readonly schema: ReadonlyArray<PlannedPortfolioColumn>;
  /** `/Sort`. */
  readonly sort: { readonly key: string; readonly ascending: boolean } | null;
  /** `/Reorder` — the schema key a viewer writes when the reader drags a file. */
  readonly reorderKey: string | null;
  /** `/D` — the file a viewer opens first, by name. */
  readonly initialFile: string | null;
  /** `/Folders`, root first. Every file's `folderId` must name one of these. */
  readonly folders: ReadonlyArray<PlannedPortfolioFolder>;
  /** Every file in the finished portfolio, in the order the name tree should list them. */
  readonly files: ReadonlyArray<PlannedPortfolioFile>;
}

export interface PlannedPortfolioColumn {
  readonly key: string;
  readonly label: string;
  /** `/Subtype`: `F`, `Desc`, `CreationDate`, `ModDate`, `Size`, `CompressedSize`, `S`, `D`, `N`. */
  readonly subtype: string;
  readonly order: number;
  readonly visible: boolean;
}

export interface PlannedPortfolioFolder {
  readonly id: number;
  readonly name: string;
  /** `null` for the root, which must be the first entry. */
  readonly parentId: number | null;
  readonly description: string | null;
  /** ISO 8601. */
  readonly created: string | null;
  readonly modified: string | null;
}

/**
 * Where the writer gets a file's bytes.
 *
 * `keep` names an embedded stream the base document already has, by its `/EmbeddedFiles` key
 * as the file was opened. `bytes` is a file this session brought in, and is the only source
 * that makes the writer create a stream.
 */
export type PlannedFileSource =
  | { readonly kind: 'keep'; readonly treeKey: string }
  | {
      readonly kind: 'bytes';
      readonly bytes: Uint8Array;
      /** ISO 8601, for `/Params`. */
      readonly created: string | null;
      readonly modified: string | null;
    };

export interface PlannedPortfolioFile {
  /** The file name, with no folder prefix; the key is built from this and `folderId`. */
  readonly name: string;
  readonly folderId: number;
  readonly description: string | null;
  /** Written as the embedded stream's `/Subtype` name. */
  readonly mimeType: string | null;
  /** Custom schema values, written to the file specification's `/CI`. */
  readonly fields: Readonly<Record<string, string>>;
  readonly source: PlannedFileSource;
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
  /**
   * The initial view and the document-level properties beside it (M72, ADR 0017):
   * `/PageMode`, `/PageLayout`, `/OpenAction`, `/ViewerPreferences`, `/Lang` and the base URL.
   */
  readonly view: PlannedView | null;
  /** Replaces `/Outlines` wholesale. An empty array removes the outline. */
  readonly outline: ReadonlyArray<PlannedOutlineItem> | null;
  /** Replaces `/Names /Dests`. */
  readonly namedDestinations: ReadonlyArray<PlannedNamedDestination> | null;
  readonly layers: ReadonlyArray<PlannedLayer> | null;
  readonly fields: ReadonlyArray<PlannedField> | null;
  /** Embedded-file metadata to normalise (M12, ADR 0011). */
  readonly attachments: ReadonlyArray<PlannedAttachment> | null;
  /**
   * Shared XObjects by key, for appearance streams that name one in their
   * `resources.xobjects` (M31, ADR 0015). Each key is embedded **once** per write, however many
   * annotations refer to it; a key no stream names is not embedded at all.
   */
  readonly xobjects?: Readonly<Record<string, PlannedXObject>> | null;

  /**
   * The whole PDF Portfolio structure (M42, ADR 0014). Non-null only when the document is a
   * portfolio this session edited; the writer then rebuilds `/Collection` and
   * `/Names /EmbeddedFiles` from it and leaves everything else alone.
   */
  readonly portfolio: PlannedPortfolio | null;
}

/** An empty plan over `pageCount` pages: a straight re-serialisation. */
export function emptyWritePlan(pageCount: number): WritePlan {
  return {
    pages: Array.from({ length: pageCount }, (_v, i) => ({ source: i })),
    pagesUnchanged: true,
    labels: false,
    metadata: null,
    metadataFallback: null,
    view: null,
    outline: null,
    namedDestinations: null,
    layers: null,
    fields: null,
    attachments: null,
    portfolio: null,
  };
}

/** True when the plan asks for nothing a re-serialisation would not already do. */
export function planIsEmpty(plan: WritePlan): boolean {
  return (
    plan.pagesUnchanged &&
    !plan.labels &&
    plan.metadata === null &&
    plan.view === null &&
    plan.outline === null &&
    plan.namedDestinations === null &&
    plan.layers === null &&
    plan.fields === null &&
    plan.attachments === null &&
    plan.portfolio === null &&
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
  'view',
  'outline',
  'destinations',
  'layers',
  'attachments',
  'portfolio',
  'annotations',
  'objects',
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

// ---- save pipeline stages (M70, ADR 0012) --------------------------------------------------------

/**
 * Context a {@link SavePipelineStage} is given about the save it is part of. Deliberately thin:
 * a stage transforms bytes and must not need a document, a shell or a window to do it, so the
 * identical stage runs in an interactive save and in a batch run with nothing on screen.
 */
export interface SaveStageContext {
  /** `Document.id`, so a stage can find whatever it holds for this document. */
  readonly documentId: string;
  /** Absolute path the bytes are about to be written to. */
  readonly path: string;
  /** True when this is a Save As rather than a save over the same file. */
  readonly saveAs: boolean;
}

export interface SaveStageInput {
  /** The document as the writer produced it. */
  readonly bytes: Uint8Array;
  readonly context: SaveStageContext;
  readonly signal?: AbortSignal;
}

export interface SaveStageResult {
  readonly bytes: Uint8Array;
  /** Things worth telling the reader. Never a reason to fail the save. */
  readonly warnings?: ReadonlyArray<string>;
}

/**
 * A transformation applied to the writer's output before it reaches the disk.
 *
 * M70 registers one to put encryption back on a protected document, which is why it exists: doing
 * that after the save would mean writing the file twice and leaving it unprotected in between.
 * A stage that throws fails the save, and the reader is told what it said — so a stage should
 * return a warning for anything it merely could not do.
 */
export interface SavePipelineStage {
  /** Stable id, so a stage can be replaced rather than added twice. */
  readonly id: string;
  /** Lower runs first. Encryption is 100, and nothing should run after it. */
  readonly order: number;
  run(input: SaveStageInput): Promise<SaveStageResult>;
  /**
   * Whether this stage is responsible for what happens to this document's protection.
   *
   * M21 warns before saving an encrypted document, because a full rewrite loses the password and
   * a reader who was not told would find out from the file. A stage answering `true` here is
   * saying "I decide that, and the reader has already been asked" — so M21 stays quiet, whether
   * the answer turns out to be *re-protect it* or *the reader asked to remove it*. Warning in the
   * second case would put the same question twice for one decision.
   */
  handlesSecurity?(documentId: string): boolean;
}

/** Runs stages in order. Exported so batch (M120) can use the pipeline without a `SaveService`. */
export async function runSaveStages(
  stages: ReadonlyArray<SavePipelineStage>,
  input: SaveStageInput,
): Promise<SaveStageResult> {
  let bytes = input.bytes;
  const warnings: string[] = [];
  for (const stage of [...stages].sort((a, b) => a.order - b.order)) {
    if (input.signal?.aborted) throw new WriteCancelled();
    const result = await stage.run({ ...input, bytes });
    bytes = result.bytes;
    if (result.warnings) warnings.push(...result.warnings);
  }
  return { bytes, warnings };
}

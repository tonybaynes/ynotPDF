/**
 * `PdfEngine` — the contract every PDF backend implements (M00 stub; M10 supplies the PDFium
 * adapter). The engine runs inside a Web Worker; the renderer reaches it through
 * `EngineClient` (same interface, every method already async).
 *
 * Semantics shared by every method:
 * - Geometry is in **PDF points**, origin **bottom-left** of the unrotated page (see
 *   `src/shared/pdf.ts`). Page indexes are 0-based.
 * - The engine is the source of truth for **bytes**. `Document` (renderer) is the source of
 *   truth for **intent** and replays `Command`s into these mutation methods.
 * - Every method may reject with {@link EngineError}. `NotImplementedError` is thrown by
 *   {@link NotImplementedEngine} and by adapters for features the backend lacks.
 * - Handles (`DocHandle`) are opaque integers valid until `close()`.
 */

import type { PageIndex, PageSize, PdfMatrix, PdfPoint, PdfRect, Rotation } from '@shared/pdf';

/** Opaque handle for an open document inside the engine. */
export type DocHandle = number & { readonly __brand: 'DocHandle' };

/** Options for {@link PdfEngine.open}. */
export interface OpenOptions {
  /** User or owner password for encrypted files. */
  readonly password?: string;
  /** Display name, used in error messages only. */
  readonly name?: string;
}

/** Why a document could not be opened. */
export type OpenFailure = 'password-required' | 'wrong-password' | 'corrupt' | 'unsupported';

/** Options for {@link PdfEngine.render}. */
export interface RenderOptions {
  /** Draw annotation appearance streams (default true). */
  readonly annotations?: boolean;
  /** Draw form-field widgets (default true). */
  readonly forms?: boolean;
  /** Render in grayscale (default false). */
  readonly grayscale?: boolean;
  /** Extra rotation applied on top of the page's `/Rotate` (view rotation), clockwise. */
  readonly rotation?: Rotation;
  /** Optional-content (layer) visibility overrides by layer id. */
  readonly layers?: Readonly<Record<string, boolean>>;
  /** Background colour as 0xRRGGBB (default white). Themes pass their page colour here. */
  readonly background?: number;
  /** Print-mode rendering (`FPDF_PRINTING`): print appearance streams, no screen-only marks. */
  readonly printing?: boolean;
  /** Anti-alias text / images / paths (default true for all three). */
  readonly smoothText?: boolean;
  readonly smoothImages?: boolean;
  readonly smoothPaths?: boolean;
  /** Sub-pixel (LCD) text rendering (default false). */
  readonly lcdText?: boolean;
  /**
   * Draw strokes at their true widths (default true). `false` is Foxit's "Line Weights off":
   * every stroke becomes a one-pixel hairline, which is how a CAD drawing stays readable when
   * it is zoomed out. Render-time only — the file is never touched (ADR 0009).
   */
  readonly lineWeights?: boolean;
}

/**
 * A rendered bitmap. `bitmap` is transferable across the worker boundary. `scale` is the
 * device pixels per PDF point that was actually used.
 */
export interface RenderResult {
  readonly bitmap: ImageBitmap;
  readonly scale: number;
  /** The page-space rectangle the bitmap covers. */
  readonly rect: PdfRect;
}

/** A run of text with a single font/size/colour on one baseline. */
export interface TextRun {
  readonly text: string;
  /** Bounding box in page space. */
  readonly rect: PdfRect;
  /** Per-character boxes in page space, same length as `text` (code points). */
  readonly chars: ReadonlyArray<PdfRect>;
  /** Baseline origin and text matrix. */
  readonly origin: PdfPoint;
  readonly matrix: PdfMatrix;
  readonly fontName: string;
  /** Font size in points (after the text matrix). */
  readonly fontSize: number;
  /** Fill colour as 0xRRGGBB. */
  readonly color: number;
  /** Index of the owning page object in `pageObjects(page)`. */
  readonly objectIndex: number;
  /** Font style from the font descriptor / name (ADR 0005). */
  readonly bold?: boolean;
  readonly italic?: boolean;
  /** Font weight (100..900) when the font declares one. */
  readonly weight?: number;
  /** Rotation of the run in radians, counter-clockwise; 0 for horizontal text. */
  readonly angle?: number;
  /** Raw PDF font descriptor flags (`/Flags`). */
  readonly fontFlags?: number;
}

/** Kinds of content-stream objects PDFium exposes. */
export type PageObjectKind = 'text' | 'path' | 'image' | 'shading' | 'form';

/** A page content object (text block, path, image, shading, form XObject). */
export interface PageObject {
  /** Stable index within the page's object list. */
  readonly index: number;
  readonly kind: PageObjectKind;
  /** Bounding box in page space. */
  readonly rect: PdfRect;
  /** Current transformation matrix applied to the object. */
  readonly matrix: PdfMatrix;
  /** For `text`: the text content; for `image`: pixel size; for `form`: nested object count. */
  readonly text?: string;
  readonly imageWidth?: number;
  readonly imageHeight?: number;
  readonly childCount?: number;
  /** Optional-content group this object belongs to, if any. */
  readonly layerId?: string;
  /** Fill / stroke colour as 0xRRGGBB and alpha 0..1, when the object has one (ADR 0005). */
  readonly fillColor?: number;
  readonly fillAlpha?: number;
  readonly strokeColor?: number;
  readonly strokeAlpha?: number;
  /** Stroke width in points (paths, stroked text). */
  readonly strokeWidth?: number;
  /** For `text`: base font name and size (after the text matrix). */
  readonly fontName?: string;
  readonly fontSize?: number;
}

/** Annotation subtypes (PDF 12.5.6). */
export type AnnotationSubtype =
  | 'Text'
  | 'Link'
  | 'FreeText'
  | 'Line'
  | 'Square'
  | 'Circle'
  | 'Polygon'
  | 'PolyLine'
  | 'Highlight'
  | 'Underline'
  | 'Squiggly'
  | 'StrikeOut'
  | 'Stamp'
  | 'Caret'
  | 'Ink'
  | 'Popup'
  | 'FileAttachment'
  | 'Sound'
  | 'Movie'
  | 'Widget'
  | 'Screen'
  | 'PrinterMark'
  | 'TrapNet'
  | 'Watermark'
  | '3D'
  | 'Redact'
  | 'Unknown';

/** Annotation flags (PDF 12.5.3), as booleans. */
export interface AnnotationFlags {
  readonly hidden: boolean;
  readonly print: boolean;
  readonly noView: boolean;
  readonly readOnly: boolean;
  readonly locked: boolean;
}

/**
 * An annotation as stored in the file. `id` is engine-assigned and stable for the life of the
 * open document (it is *not* the object number). `rect` is in page space.
 */
export interface Annotation {
  readonly id: string;
  readonly page: PageIndex;
  readonly subtype: AnnotationSubtype;
  readonly rect: PdfRect;
  readonly flags: AnnotationFlags;
  /** `/Contents` (note text). */
  readonly contents?: string;
  /** `/T` — author. */
  readonly author?: string;
  /** `/M` — modification date, ISO 8601. */
  readonly modified?: string;
  /** `/CreationDate`, ISO 8601. */
  readonly created?: string;
  /** Stroke/border colour as 0xRRGGBB, if any. */
  readonly color?: number;
  /** Interior colour as 0xRRGGBB, if any. */
  readonly interiorColor?: number;
  /** `/CA` — opacity 0..1 as stored in the file (rendering only; UI chrome never uses it). */
  readonly opacity?: number;
  /** Quad points for text-markup annotations, page space, 8 numbers per quad. */
  readonly quadPoints?: ReadonlyArray<number>;
  /** Ink paths / vertices, page space. */
  readonly paths?: ReadonlyArray<ReadonlyArray<PdfPoint>>;
  /** Border width in points. */
  readonly borderWidth?: number;
  /** `/IRT` — id of the annotation this one replies to. */
  readonly inReplyTo?: string;
  /** Review state (`/State`) for reply annotations. */
  readonly state?: string;
  /** `/AS` — appearance state (checkbox "Yes"/"Off", stamp variants). */
  readonly appearanceState?: string;
  /** `/NM` — annotation name, unique within the page when present. */
  readonly name?: string;
  /** `/Subj` — subject line shown in comment panels. */
  readonly subject?: string;
  /** Any subtype-specific extras the adapter chooses to expose. */
  readonly extra?: Readonly<Record<string, unknown>>;
}

/** Input for creating an annotation: everything except the engine-assigned id. */
export type NewAnnotation = Omit<Annotation, 'id'>;

/** AcroForm field types (PDF 12.7.4). */
export type FormFieldType =
  'text' | 'checkbox' | 'radio' | 'combobox' | 'listbox' | 'button' | 'signature' | 'unknown';

/** A form field with its widget(s). */
export interface FormField {
  /** Fully qualified field name (`/T` chain joined with dots). */
  readonly name: string;
  readonly type: FormFieldType;
  /** Current value (`/V`) as text; checkbox/radio use the export value or `"Off"`. */
  readonly value: string;
  readonly defaultValue?: string;
  readonly readOnly: boolean;
  readonly required: boolean;
  /** Choice options for combobox/listbox. */
  readonly options?: ReadonlyArray<{ readonly value: string; readonly label: string }>;
  /** Widget rectangles, one per appearance on a page. */
  readonly widgets: ReadonlyArray<{ readonly page: PageIndex; readonly rect: PdfRect }>;
  /** Tooltip (`/TU`). */
  readonly tooltip?: string;
}

/** A destination inside the document (PDF 12.3.2). */
export interface Destination {
  readonly page: PageIndex;
  /** Fit mode; `xyz` uses `left`/`top`/`zoom`. */
  readonly fit: 'xyz' | 'fit' | 'fitH' | 'fitV' | 'fitR' | 'fitB' | 'fitBH' | 'fitBV';
  readonly left?: number;
  readonly top?: number;
  readonly zoom?: number;
  readonly rect?: PdfRect;
}

/** A link on a page: the Link annotation resolved to a destination or URI (ADR 0005). */
export interface Link {
  /** Active area in page space. */
  readonly rect: PdfRect;
  /** Quad points when the link area is not a single rectangle, 8 numbers per quad. */
  readonly quadPoints?: ReadonlyArray<number>;
  readonly dest?: Destination;
  readonly uri?: string;
  /** Id of the underlying annotation in `annotations(page)`, if it is one. */
  readonly annotationId?: string;
}

/** A destination reachable by name from the catalogue's `/Dests` name tree (ADR 0007). */
export interface NamedDestination {
  readonly name: string;
  readonly dest: Destination;
}

/**
 * What a viewer can say about a signature *before* any trust decision (ADR 0007). Validating
 * one — building the chain, checking revocation, LTV — is M81's job; nothing here asserts that
 * a signature is good.
 */
export interface SignatureSummary {
  /** `/Reason`, when the signer gave one. */
  readonly reason?: string;
  /** `/SubFilter`, e.g. `"adbe.pkcs7.detached"`, `"ETSI.CAdES.detached"`. */
  readonly subFilter?: string;
  /** `/M` — signing time as the file states it, ISO 8601 when parsable. */
  readonly time?: string;
  /** `/ByteRange` as stored. Anything but four ascending numbers means a malformed file. */
  readonly byteRange: ReadonlyArray<number>;
  /** `/DocMDP` permission level 1..3, absent when this is not a certification signature. */
  readonly docMdpPermission?: number;
}

/** An outline (bookmark) node. */
export interface OutlineItem {
  readonly title: string;
  readonly dest?: Destination;
  /** External URI action, if this item opens a link instead of a destination. */
  readonly uri?: string;
  readonly children: ReadonlyArray<OutlineItem>;
  /** Whether the node is initially expanded (`/Count` > 0). */
  readonly open: boolean;
  readonly bold?: boolean;
  readonly italic?: boolean;
  /** Text colour as 0xRRGGBB. */
  readonly color?: number;
}

/** An optional-content group (layer). */
export interface Layer {
  readonly id: string;
  readonly name: string;
  readonly visible: boolean;
  /** Whether the file marks it locked in the UI. */
  readonly locked: boolean;
  /** Nesting depth from the `/Order` array. */
  readonly depth: number;
}

/** An embedded file (`/EmbeddedFiles` name tree or FileAttachment annotation). */
export interface Attachment {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly mimeType?: string;
  readonly size?: number;
  readonly modified?: string;
  /** `/CreationDate` of the embedded stream, ISO 8601 (ADR 0011). */
  readonly created?: string;
  /**
   * Values of the portfolio's custom schema fields for this file, from the file
   * specification's `/CI` dictionary (ADR 0011). Keyed by schema field key. Empty or absent
   * for an ordinary attachment.
   */
  readonly collectionFields?: Readonly<Record<string, string>>;
  /**
   * The raw `/EmbeddedFiles` name-tree key, folder prefix included (M42, ADR 0016). The writer
   * matches on it to reuse an embedded stream untouched, which is what keeps a signed PDF
   * inside a portfolio valid across a save. Absent for a FileAttachment annotation.
   */
  readonly treeKey?: string;
  /** Portfolio folder this file sits in; 0 — or absent — is the root (M42, ADR 0016). */
  readonly folderId?: number;
  /** Present when the attachment comes from a FileAttachment annotation. */
  readonly page?: PageIndex;
}

/** A new embedded file, for {@link PdfEngine.addAttachment} (ADR 0011). */
export interface NewAttachment {
  readonly name: string;
  readonly bytes: Uint8Array;
  readonly description?: string;
  readonly mimeType?: string;
  /** ISO 8601; defaults to now. */
  readonly modified?: string;
  readonly created?: string;
}

/** What {@link PdfEngine.updateAttachment} may change (ADR 0011). */
export interface AttachmentPatch {
  readonly name?: string;
  readonly description?: string;
  readonly mimeType?: string;
  readonly modified?: string;
  readonly bytes?: Uint8Array;
}

/**
 * One column of a PDF Portfolio's `/Collection /Schema` (PDF 12.3.5, ADR 0011).
 *
 * `kind` is the field's `/Subtype`: the five standard ones name a property of the embedded
 * file itself (`F` its name, `Desc` its description, `ModDate` / `CreationDate` its dates,
 * `Size` / `CompressedSize` its size); `S`, `D` and `N` are a custom string, date or number
 * whose value lives in each file specification's `/CI` dictionary under `key`.
 */
export interface CollectionField {
  /** Key in `/Schema` and in each file's `/CI`, e.g. `"FileName"` or `"foxit:Order"`. */
  readonly key: string;
  /** `/N` — what a viewer shows as the column heading. */
  readonly label: string;
  readonly kind:
    'F' | 'Desc' | 'ModDate' | 'CreationDate' | 'Size' | 'CompressedSize' | 'S' | 'D' | 'N';
  /** `/O` — column order, lower first. */
  readonly order: number;
  /** `/V` — false when the file asks for the column to be hidden. */
  readonly visible: boolean;
}

/**
 * One node of `/Collection /Folders` (PDF 2.0 / Acrobat 9, M42 ADR 0016). The tree is stored as
 * `/Child` and `/Next` links; this is the flattened form, and the root is the only node whose
 * `parentId` is null.
 */
export interface CollectionFolder {
  /** `/ID` — the number the `/EmbeddedFiles` key prefixes a file with. */
  readonly id: number;
  readonly name: string;
  readonly parentId: number | null;
  readonly description?: string;
  /** ISO 8601. */
  readonly created?: string;
  readonly modified?: string;
}

/**
 * The catalogue's `/Collection` dictionary: the document is a **PDF Portfolio** (ADR 0011).
 * `null` from {@link PdfEngine.collection} means an ordinary document.
 */
export interface PdfCollection {
  /** `/View`: details grid, tiles, hidden (show the cover only) or a custom navigator. */
  readonly view: 'details' | 'tile' | 'hidden' | 'custom';
  /** Schema columns in `/O` order. Empty when the file defines no schema. */
  readonly fields: ReadonlyArray<CollectionField>;
  /** `/D` — name of the file a viewer should show first, when the file names one. */
  readonly initialFile?: string;
  /** Number of `/Folders` entries, so a viewer can say a portfolio has folders it ignores. */
  readonly folderCount: number;
  /**
   * The whole `/Folders` tree, root first (M42, ADR 0016). Absent when the file has none, which
   * is a portfolio whose files all sit at the top level.
   */
  readonly folders?: ReadonlyArray<CollectionFolder>;
  /** `/Sort` — the schema key a viewer orders on, and which way (M42, ADR 0016). */
  readonly sort?: { readonly key: string; readonly ascending: boolean };
  /** `/Reorder` — the schema key a viewer writes when the reader drags a file (M42, ADR 0016). */
  readonly reorderKey?: string;
}

/** Document information dictionary + a few catalogue facts. */
export interface Metadata {
  readonly title?: string;
  readonly author?: string;
  readonly subject?: string;
  readonly keywords?: string;
  readonly creator?: string;
  readonly producer?: string;
  /** ISO 8601. */
  readonly created?: string;
  readonly modified?: string;
  /** PDF version, e.g. `"1.7"`. */
  readonly version: string;
  /** Raw XMP packet, if present. */
  readonly xmp?: string;
  readonly encrypted: boolean;
  readonly linearized: boolean;
  readonly tagged: boolean;
  /** Whether the file has an AcroForm. */
  readonly hasForm: boolean;
  /** Whether the file has XFA (parked — we render the AcroForm fallback only). */
  readonly hasXfa: boolean;
  /** Page count, duplicated here for convenience. */
  readonly pageCount: number;
}

/** Permissions from the standard security handler (PDF 7.6.3.2). All true when unencrypted. */
export interface Permissions {
  readonly print: boolean;
  readonly printHighQuality: boolean;
  readonly modify: boolean;
  readonly copy: boolean;
  readonly annotate: boolean;
  readonly fillForms: boolean;
  readonly extractForAccessibility: boolean;
  readonly assemble: boolean;
}

/** Options for {@link PdfEngine.save}. */
export interface SaveOptions {
  /** Append an incremental update instead of rewriting (M80). Adapters may ignore. */
  readonly incremental?: boolean;
  /** Remove security when saving. */
  readonly removeSecurity?: boolean;
}

/** Progress callback for long operations (0..1). */
export type ProgressCallback = (fraction: number) => void;

/**
 * The engine interface. All methods are async so the same signature works locally and over
 * the Worker RPC boundary.
 */
export interface PdfEngine {
  /** Engine name and version, e.g. `"pdfium 7000"`. */
  info(): Promise<{ readonly name: string; readonly version: string }>;

  // ---- lifecycle ---------------------------------------------------------------------------

  /**
   * Opens a document from bytes. The engine copies or takes ownership of `bytes` — callers
   * must not mutate the buffer afterwards. Rejects with `EngineError` whose `code` is an
   * {@link OpenFailure} when the file cannot be opened.
   */
  open(bytes: Uint8Array, options?: OpenOptions): Promise<DocHandle>;
  /**
   * A new, empty document with no pages (M40, ADR 0016). The caller owns the handle and must
   * `close` it. `importPages` fills it; saving one that is still empty is a caller error,
   * because a PDF must have at least one page.
   */
  createDocument(): Promise<DocHandle>;
  /** Releases all engine resources for the document. The handle is invalid afterwards. */
  close(doc: DocHandle): Promise<void>;

  // ---- structure ---------------------------------------------------------------------------

  pageCount(doc: DocHandle): Promise<number>;
  /** Displayed page size (rotation applied) plus the raw boxes. */
  pageSize(doc: DocHandle, page: PageIndex): Promise<PageSize>;
  /** Page labels (`/PageLabels`), one entry per page; defaults to `"1"`, `"2"`, ... */
  pageLabels(doc: DocHandle): Promise<ReadonlyArray<string>>;
  metadata(doc: DocHandle): Promise<Metadata>;
  permissions(doc: DocHandle): Promise<Permissions>;
  outline(doc: DocHandle): Promise<ReadonlyArray<OutlineItem>>;
  layers(doc: DocHandle): Promise<ReadonlyArray<Layer>>;
  attachments(doc: DocHandle): Promise<ReadonlyArray<Attachment>>;
  /** Raw bytes of an attachment. */
  attachmentData(doc: DocHandle, attachmentId: string): Promise<Uint8Array>;
  /**
   * The catalogue's `/Collection` dictionary, or `null` for an ordinary document (ADR 0011).
   * A non-null answer means the file is a PDF Portfolio.
   */
  collection(doc: DocHandle): Promise<PdfCollection | null>;

  // ---- content -----------------------------------------------------------------------------

  /**
   * Renders `rect` (page space; whole page when omitted) at `scale` device pixels per point.
   * The result bitmap is transferred to the caller.
   */
  render(
    doc: DocHandle,
    page: PageIndex,
    scale: number,
    rect?: PdfRect,
    options?: RenderOptions,
  ): Promise<RenderResult>;
  /** Text runs in reading (content-stream) order. */
  textRuns(doc: DocHandle, page: PageIndex): Promise<ReadonlyArray<TextRun>>;
  /** Content objects of a page, in z-order (index 0 is bottom-most). */
  pageObjects(doc: DocHandle, page: PageIndex): Promise<ReadonlyArray<PageObject>>;
  annotations(doc: DocHandle, page: PageIndex): Promise<ReadonlyArray<Annotation>>;
  formFields(doc: DocHandle): Promise<ReadonlyArray<FormField>>;
  /** Links on a page with their destination / URI resolved (ADR 0005). */
  links(doc: DocHandle, page: PageIndex): Promise<ReadonlyArray<Link>>;
  /** Signature fields with what the file says about them, in document order (ADR 0007). */
  signatures(doc: DocHandle): Promise<ReadonlyArray<SignatureSummary>>;
  /** Named destinations from the catalogue's name tree (ADR 0007). */
  namedDestinations(doc: DocHandle): Promise<ReadonlyArray<NamedDestination>>;

  // ---- mutation (each corresponds to a `Command`) --------------------------------------------

  /** Sets `/Rotate` on a page. The displayed size flips for 90/270. */
  setPageRotation(doc: DocHandle, page: PageIndex, rotation: Rotation): Promise<void>;
  /** Deletes pages (indexes refer to the state *before* the call). */
  deletePages(doc: DocHandle, pages: ReadonlyArray<PageIndex>): Promise<void>;
  /** Inserts blank pages of `size` before `at` (`at === pageCount` appends). */
  insertBlankPages(
    doc: DocHandle,
    at: PageIndex,
    count: number,
    size: { readonly width: number; readonly height: number },
  ): Promise<void>;
  /** Imports pages from another open document before `at`. */
  importPages(
    doc: DocHandle,
    source: DocHandle,
    pages: ReadonlyArray<PageIndex>,
    at: PageIndex,
  ): Promise<void>;
  /** Moves a page to a new index (index in the post-removal list). */
  movePage(doc: DocHandle, from: PageIndex, to: PageIndex): Promise<void>;
  /** Sets the CropBox (page space). */
  setCropBox(doc: DocHandle, page: PageIndex, box: PdfRect): Promise<void>;

  addAnnotation(doc: DocHandle, annotation: NewAnnotation): Promise<Annotation>;
  updateAnnotation(
    doc: DocHandle,
    id: string,
    patch: Partial<Omit<Annotation, 'id' | 'page'>>,
  ): Promise<Annotation>;
  deleteAnnotation(doc: DocHandle, id: string): Promise<void>;
  /**
   * Replaces an annotation's normal appearance stream with `content`, or removes it when
   * `content` is null so the backend draws its own again (M30, ADR 0013).
   *
   * The stream is written with `/BBox` = `/Rect`, an identity `/Matrix` and **no `/Resources`**,
   * which is all PDFium's API allows — so only an appearance that needs no font and no graphics
   * state may go through here. Note icons qualify, because they are pure vector; free text does
   * not, and is drawn by the annotation overlay until a save can attach real resources.
   */
  setAnnotationAppearance(doc: DocHandle, id: string, content: string | null): Promise<void>;

  /** Embeds a file in the `/EmbeddedFiles` name tree (ADR 0011). */
  addAttachment(doc: DocHandle, file: NewAttachment): Promise<Attachment>;
  /** Changes an embedded file's name, description, type, date or bytes (ADR 0011). */
  updateAttachment(
    doc: DocHandle,
    attachmentId: string,
    patch: AttachmentPatch,
  ): Promise<Attachment>;
  /** Removes an embedded file. Ids of later attachments shift down by one (ADR 0011). */
  deleteAttachment(doc: DocHandle, attachmentId: string): Promise<void>;

  setFieldValue(doc: DocHandle, fieldName: string, value: string): Promise<void>;
  setMetadata(
    doc: DocHandle,
    patch: Partial<Omit<Metadata, 'version' | 'pageCount'>>,
  ): Promise<void>;
  setLayerVisible(doc: DocHandle, layerId: string, visible: boolean): Promise<void>;

  /** Serialises the current state. Returns a fresh buffer owned by the caller. */
  save(doc: DocHandle, options?: SaveOptions, progress?: ProgressCallback): Promise<Uint8Array>;
}

/** Error codes an engine may raise. */
export type EngineErrorCode =
  | OpenFailure
  | 'not-implemented'
  | 'invalid-handle'
  | 'invalid-page'
  | 'invalid-argument'
  | 'permission-denied'
  | 'cancelled'
  | 'internal';

/** Error type for every engine failure. Serialisable across the worker boundary. */
export class EngineError extends Error {
  readonly code: EngineErrorCode;
  constructor(code: EngineErrorCode, message: string) {
    super(message);
    this.name = 'EngineError';
    this.code = code;
  }
}

/** Thrown for engine features the current adapter does not provide. */
export class NotImplementedError extends EngineError {
  constructor(what: string) {
    super('not-implemented', `${what} is not implemented by this engine`);
    this.name = 'NotImplementedError';
  }
}

/**
 * An engine that implements nothing. It is the default until M10 lands and is also handy in
 * tests for asserting that a code path never touches the engine.
 */
export class NotImplementedEngine implements PdfEngine {
  info(): Promise<{ readonly name: string; readonly version: string }> {
    return Promise.resolve({ name: 'none', version: '0' });
  }
  open(..._args: unknown[]): Promise<DocHandle> {
    return Promise.reject(new NotImplementedError('open'));
  }
  createDocument(..._args: unknown[]): Promise<DocHandle> {
    return Promise.reject(new NotImplementedError('createDocument'));
  }
  close(..._args: unknown[]): Promise<void> {
    return Promise.reject(new NotImplementedError('close'));
  }
  pageCount(..._args: unknown[]): Promise<number> {
    return Promise.reject(new NotImplementedError('pageCount'));
  }
  pageSize(..._args: unknown[]): Promise<PageSize> {
    return Promise.reject(new NotImplementedError('pageSize'));
  }
  pageLabels(..._args: unknown[]): Promise<ReadonlyArray<string>> {
    return Promise.reject(new NotImplementedError('pageLabels'));
  }
  metadata(..._args: unknown[]): Promise<Metadata> {
    return Promise.reject(new NotImplementedError('metadata'));
  }
  permissions(..._args: unknown[]): Promise<Permissions> {
    return Promise.reject(new NotImplementedError('permissions'));
  }
  outline(..._args: unknown[]): Promise<ReadonlyArray<OutlineItem>> {
    return Promise.reject(new NotImplementedError('outline'));
  }
  layers(..._args: unknown[]): Promise<ReadonlyArray<Layer>> {
    return Promise.reject(new NotImplementedError('layers'));
  }
  attachments(..._args: unknown[]): Promise<ReadonlyArray<Attachment>> {
    return Promise.reject(new NotImplementedError('attachments'));
  }
  attachmentData(..._args: unknown[]): Promise<Uint8Array> {
    return Promise.reject(new NotImplementedError('attachmentData'));
  }
  collection(..._args: unknown[]): Promise<PdfCollection | null> {
    return Promise.reject(new NotImplementedError('collection'));
  }
  render(..._args: unknown[]): Promise<RenderResult> {
    return Promise.reject(new NotImplementedError('render'));
  }
  textRuns(..._args: unknown[]): Promise<ReadonlyArray<TextRun>> {
    return Promise.reject(new NotImplementedError('textRuns'));
  }
  pageObjects(..._args: unknown[]): Promise<ReadonlyArray<PageObject>> {
    return Promise.reject(new NotImplementedError('pageObjects'));
  }
  annotations(..._args: unknown[]): Promise<ReadonlyArray<Annotation>> {
    return Promise.reject(new NotImplementedError('annotations'));
  }
  formFields(..._args: unknown[]): Promise<ReadonlyArray<FormField>> {
    return Promise.reject(new NotImplementedError('formFields'));
  }
  links(..._args: unknown[]): Promise<ReadonlyArray<Link>> {
    return Promise.reject(new NotImplementedError('links'));
  }
  signatures(..._args: unknown[]): Promise<ReadonlyArray<SignatureSummary>> {
    return Promise.reject(new NotImplementedError('signatures'));
  }
  namedDestinations(..._args: unknown[]): Promise<ReadonlyArray<NamedDestination>> {
    return Promise.reject(new NotImplementedError('namedDestinations'));
  }
  setPageRotation(..._args: unknown[]): Promise<void> {
    return Promise.reject(new NotImplementedError('setPageRotation'));
  }
  deletePages(..._args: unknown[]): Promise<void> {
    return Promise.reject(new NotImplementedError('deletePages'));
  }
  insertBlankPages(..._args: unknown[]): Promise<void> {
    return Promise.reject(new NotImplementedError('insertBlankPages'));
  }
  importPages(..._args: unknown[]): Promise<void> {
    return Promise.reject(new NotImplementedError('importPages'));
  }
  movePage(..._args: unknown[]): Promise<void> {
    return Promise.reject(new NotImplementedError('movePage'));
  }
  setCropBox(..._args: unknown[]): Promise<void> {
    return Promise.reject(new NotImplementedError('setCropBox'));
  }
  addAnnotation(..._args: unknown[]): Promise<Annotation> {
    return Promise.reject(new NotImplementedError('addAnnotation'));
  }
  updateAnnotation(..._args: unknown[]): Promise<Annotation> {
    return Promise.reject(new NotImplementedError('updateAnnotation'));
  }
  deleteAnnotation(..._args: unknown[]): Promise<void> {
    return Promise.reject(new NotImplementedError('deleteAnnotation'));
  }
  setAnnotationAppearance(..._args: unknown[]): Promise<void> {
    return Promise.reject(new NotImplementedError('setAnnotationAppearance'));
  }
  addAttachment(..._args: unknown[]): Promise<Attachment> {
    return Promise.reject(new NotImplementedError('addAttachment'));
  }
  updateAttachment(..._args: unknown[]): Promise<Attachment> {
    return Promise.reject(new NotImplementedError('updateAttachment'));
  }
  deleteAttachment(..._args: unknown[]): Promise<void> {
    return Promise.reject(new NotImplementedError('deleteAttachment'));
  }
  setFieldValue(..._args: unknown[]): Promise<void> {
    return Promise.reject(new NotImplementedError('setFieldValue'));
  }
  setMetadata(..._args: unknown[]): Promise<void> {
    return Promise.reject(new NotImplementedError('setMetadata'));
  }
  setLayerVisible(..._args: unknown[]): Promise<void> {
    return Promise.reject(new NotImplementedError('setLayerVisible'));
  }
  save(..._args: unknown[]): Promise<Uint8Array> {
    return Promise.reject(new NotImplementedError('save'));
  }
}

/** Names of every `PdfEngine` method, used by the RPC layer to build proxies. */
export const ENGINE_METHODS = [
  'info',
  'open',
  'createDocument',
  'close',
  'pageCount',
  'pageSize',
  'pageLabels',
  'metadata',
  'permissions',
  'outline',
  'layers',
  'attachments',
  'attachmentData',
  'collection',
  'render',
  'textRuns',
  'pageObjects',
  'annotations',
  'formFields',
  'links',
  'signatures',
  'namedDestinations',
  'setPageRotation',
  'deletePages',
  'insertBlankPages',
  'importPages',
  'movePage',
  'setCropBox',
  'addAnnotation',
  'updateAnnotation',
  'deleteAnnotation',
  'setAnnotationAppearance',
  'addAttachment',
  'updateAttachment',
  'deleteAttachment',
  'setFieldValue',
  'setMetadata',
  'setLayerVisible',
  'save',
] as const satisfies ReadonlyArray<keyof PdfEngine>;

export type EngineMethod = (typeof ENGINE_METHODS)[number];

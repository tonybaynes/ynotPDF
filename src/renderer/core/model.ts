/**
 * The entity types of the document model (M20, ADR 0007).
 *
 * These are what the UI edits. They mirror the engine's read types but differ in three ways
 * that matter:
 *
 * 1. **Identity is a model id**, not an engine key — see `Ids.ts`. A page is `pg-3` for as long
 *    as the document is open, whatever index PDFium currently gives it.
 * 2. **References are ids**, not indexes: an annotation names its `pageId`, a destination names
 *    its `pageId`. Reordering pages therefore changes one array and nothing else.
 * 3. **Annotations are a discriminated union** over subtype families, so a tool that only
 *    handles ink can narrow to `InkAnnotation` and get `paths` as a required field.
 *
 * Geometry is PDF points, origin bottom-left of the unrotated page, as everywhere else.
 */

import type {
  Annotation,
  AnnotationFlags,
  AnnotationSubtype,
  Attachment,
  Destination,
  FormFieldType,
  InitialView,
  Layer,
  Metadata,
  OutlineItem,
  PageObject,
  Permissions,
} from '@engine/PdfEngine';
import type { PageBoxName, PageIndex, PageSize, PdfPoint, PdfRect, Rotation } from '@shared/pdf';
import type { ModelId } from './Ids';

// ---- pages -------------------------------------------------------------------------------------

/**
 * The page boxes a document may define (PDF 14.11.2). CropBox and MediaBox always exist.
 *
 * Declared in `@shared/pdf` since M41 (ADR 0017), because the engine names the same five and
 * must not import from `@core`. Re-exported here, where the model's own callers expect it.
 */
export type { PageBoxName } from '@shared/pdf';

/**
 * One page as the model sees it. The *order* of `DocumentState.pages` is the document's page
 * order; the engine keeps its own, and `Document.enginePage(id)` bridges the two.
 */
export interface ModelPage {
  readonly id: ModelId;
  /** Display label from `/PageLabels`, or the 1-based number as a string. */
  readonly label: string;
  /** `/Rotate`, clockwise degrees. */
  readonly rotation: Rotation;
  readonly mediaBox: PdfRect;
  readonly cropBox: PdfRect;
  readonly bleedBox: PdfRect | null;
  readonly trimBox: PdfRect | null;
  readonly artBox: PdfRect | null;
  /**
   * Content objects, loaded on demand by `Document.loadObjects(pageId)`. `null` means "not
   * loaded yet", which is different from an empty page.
   */
  readonly objects: ReadonlyArray<PageObject> | null;
}

/** Displayed size of a page: the CropBox, with width and height swapped for 90°/270°. */
export function pageSizeOf(page: ModelPage): PageSize {
  const w = page.cropBox.x1 - page.cropBox.x0;
  const h = page.cropBox.y1 - page.cropBox.y0;
  const swap = page.rotation === 90 || page.rotation === 270;
  return {
    width: swap ? h : w,
    height: swap ? w : h,
    rotation: page.rotation,
    cropBox: page.cropBox,
    mediaBox: page.mediaBox,
  };
}

/** The box a name refers to, falling back to CropBox then MediaBox as the PDF spec requires. */
export function pageBox(page: ModelPage, box: PageBoxName): PdfRect {
  switch (box) {
    case 'media':
      return page.mediaBox;
    case 'crop':
      return page.cropBox;
    case 'bleed':
      return page.bleedBox ?? page.cropBox;
    case 'trim':
      return page.trimBox ?? page.cropBox;
    case 'art':
      return page.artBox ?? page.cropBox;
  }
}

// ---- annotations -------------------------------------------------------------------------------

/** What every annotation has, whatever its subtype. */
export interface AnnotationBase {
  readonly id: ModelId;
  readonly pageId: ModelId;
  readonly subtype: AnnotationSubtype;
  readonly rect: PdfRect;
  readonly flags: AnnotationFlags;
  /** `/Contents` — the note text. */
  readonly contents: string | null;
  /** `/T` — the author. */
  readonly author: string | null;
  /** `/CreationDate` and `/M`, ISO 8601. */
  readonly created: string | null;
  readonly modified: string | null;
  /** Stroke or border colour, `0xRRGGBB`. */
  readonly color: number | null;
  readonly interiorColor: number | null;
  /** `/CA`, 0..1, as stored in the file. UI chrome never uses it — see CLAUDE.md. */
  readonly opacity: number | null;
  readonly borderWidth: number | null;
  /** `/AS` — appearance state (a checkbox's "Yes"/"Off", a stamp variant). */
  readonly appearanceState: string | null;
  /** `/NM` — the annotation's own name, when the file gives it one. */
  readonly name: string | null;
  /** `/Subj` — subject line shown in comment panels. */
  readonly subject: string | null;
  /** `/IRT` — the annotation this one replies to, as a model id. */
  readonly inReplyTo: ModelId | null;
  /** `/State` — review state of a reply. */
  readonly state: string | null;
  /** Subtype-specific extras the adapter chose to expose. */
  readonly extra: Readonly<Record<string, unknown>>;
}

/** Text markup: highlight, underline, squiggly, strike-out. Quads are 8 numbers each. */
export interface MarkupAnnotation extends AnnotationBase {
  readonly family: 'markup';
  readonly subtype: 'Highlight' | 'Underline' | 'Squiggly' | 'StrikeOut';
  readonly quadPoints: ReadonlyArray<number>;
}

/** Freehand ink: one or more strokes. */
export interface InkAnnotation extends AnnotationBase {
  readonly family: 'ink';
  readonly subtype: 'Ink';
  readonly paths: ReadonlyArray<ReadonlyArray<PdfPoint>>;
}

/** Square, circle, line, polygon, polyline. `vertices` is empty for square and circle. */
export interface ShapeAnnotation extends AnnotationBase {
  readonly family: 'shape';
  readonly subtype: 'Square' | 'Circle' | 'Line' | 'Polygon' | 'PolyLine';
  readonly vertices: ReadonlyArray<PdfPoint>;
}

/** A sticky note. */
export interface NoteAnnotation extends AnnotationBase {
  readonly family: 'note';
  readonly subtype: 'Text';
  /** `/Name` — the icon ("Comment", "Note", "Help", …). */
  readonly icon: string | null;
}

/** Typewriter / text box / callout. */
export interface FreeTextAnnotation extends AnnotationBase {
  readonly family: 'freeText';
  readonly subtype: 'FreeText';
  /** `/RC` — rich text, when the file has it. */
  readonly richContents: string | null;
}

/** A stamp. */
export interface StampAnnotation extends AnnotationBase {
  readonly family: 'stamp';
  readonly subtype: 'Stamp';
  readonly icon: string | null;
}

/** A form-field widget. `fieldId` is filled in once the field tree is built. */
export interface WidgetAnnotation extends AnnotationBase {
  readonly family: 'widget';
  readonly subtype: 'Widget';
  readonly fieldName: string | null;
  readonly fieldId: ModelId | null;
}

/** A link. */
export interface LinkAnnotation extends AnnotationBase {
  readonly family: 'link';
  readonly subtype: 'Link';
  readonly uri: string | null;
  readonly destinationId: ModelId | null;
  readonly quadPoints: ReadonlyArray<number>;
}

/** An attached file shown on the page. */
export interface FileAttachmentAnnotation extends AnnotationBase {
  readonly family: 'fileAttachment';
  readonly subtype: 'FileAttachment';
  readonly attachmentId: ModelId | null;
  readonly icon: string | null;
}

/** Everything else, including subtypes we deliberately do not model (Sound, Movie, 3D, …). */
export interface OtherAnnotation extends AnnotationBase {
  readonly family: 'other';
}

/** The annotation union. Narrow on `family`, not on `subtype`. */
export type ModelAnnotation =
  | MarkupAnnotation
  | InkAnnotation
  | ShapeAnnotation
  | NoteAnnotation
  | FreeTextAnnotation
  | StampAnnotation
  | WidgetAnnotation
  | LinkAnnotation
  | FileAttachmentAnnotation
  | OtherAnnotation;

export type AnnotationFamily = ModelAnnotation['family'];

/**
 * A patch for any annotation: the shared fields plus every family-specific one, all optional.
 * `Partial<ModelAnnotation>` cannot express this — a partial of a union still has to pick one
 * member — and a tool that moves an annotation should not have to know which family it is.
 */
export type AnnotationPatch = Partial<Omit<AnnotationBase, 'id' | 'pageId'>> & {
  readonly quadPoints?: ReadonlyArray<number>;
  readonly paths?: ReadonlyArray<ReadonlyArray<PdfPoint>>;
  readonly vertices?: ReadonlyArray<PdfPoint>;
  readonly icon?: string | null;
  readonly richContents?: string | null;
  readonly uri?: string | null;
  readonly fieldName?: string | null;
  readonly fieldId?: ModelId | null;
  readonly destinationId?: ModelId | null;
  readonly attachmentId?: ModelId | null;
};

const MARKUP_SUBTYPES = new Set<AnnotationSubtype>([
  'Highlight',
  'Underline',
  'Squiggly',
  'StrikeOut',
]);
const SHAPE_SUBTYPES = new Set<AnnotationSubtype>([
  'Square',
  'Circle',
  'Line',
  'Polygon',
  'PolyLine',
]);

/** The family a subtype belongs to. Unrecognised subtypes are `'other'`, never an error. */
export function familyOf(subtype: AnnotationSubtype): AnnotationFamily {
  if (MARKUP_SUBTYPES.has(subtype)) return 'markup';
  if (SHAPE_SUBTYPES.has(subtype)) return 'shape';
  switch (subtype) {
    case 'Ink':
      return 'ink';
    case 'Text':
      return 'note';
    case 'FreeText':
      return 'freeText';
    case 'Stamp':
      return 'stamp';
    case 'Widget':
      return 'widget';
    case 'Link':
      return 'link';
    case 'FileAttachment':
      return 'fileAttachment';
    default:
      return 'other';
  }
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * Turns an engine annotation into a model one. `pageId` and `id` come from the caller because
 * only the document knows them; `resolve` maps an engine annotation id to a model id, for
 * `/IRT` (it returns `null` while the target has not been seen yet).
 */
export function toModelAnnotation(
  id: ModelId,
  pageId: ModelId,
  source: Annotation,
  resolve: (engineId: string) => ModelId | null = () => null,
): ModelAnnotation {
  const base: AnnotationBase = {
    id,
    pageId,
    subtype: source.subtype,
    rect: source.rect,
    flags: source.flags,
    contents: source.contents ?? null,
    author: source.author ?? null,
    created: source.created ?? null,
    modified: source.modified ?? null,
    color: source.color ?? null,
    interiorColor: source.interiorColor ?? null,
    opacity: source.opacity ?? null,
    borderWidth: source.borderWidth ?? null,
    appearanceState: source.appearanceState ?? null,
    name: source.name ?? null,
    subject: source.subject ?? null,
    inReplyTo: source.inReplyTo ? resolve(source.inReplyTo) : null,
    state: source.state ?? null,
    extra: source.extra ?? {},
  };
  const extra = base.extra;
  const family = familyOf(source.subtype);
  switch (family) {
    case 'markup':
      return {
        ...base,
        family,
        subtype: source.subtype as MarkupAnnotation['subtype'],
        quadPoints: source.quadPoints ?? [],
      };
    case 'ink':
      return { ...base, family, subtype: 'Ink', paths: source.paths ?? [] };
    case 'shape':
      return {
        ...base,
        family,
        subtype: source.subtype as ShapeAnnotation['subtype'],
        vertices: source.paths?.[0] ?? [],
      };
    case 'note':
      return { ...base, family, subtype: 'Text', icon: str(extra['icon']) };
    case 'freeText':
      return {
        ...base,
        family,
        subtype: 'FreeText',
        richContents: str(extra['richContents']),
      };
    case 'stamp':
      return { ...base, family, subtype: 'Stamp', icon: str(extra['icon']) };
    case 'widget':
      return {
        ...base,
        family,
        subtype: 'Widget',
        fieldName: str(extra['fieldName']),
        fieldId: null,
      };
    case 'link':
      return {
        ...base,
        family,
        subtype: 'Link',
        uri: str(extra['uri']),
        destinationId: null,
        quadPoints: source.quadPoints ?? [],
      };
    case 'fileAttachment':
      return {
        ...base,
        family,
        subtype: 'FileAttachment',
        attachmentId: null,
        icon: str(extra['icon']),
      };
    case 'other':
      return { ...base, family };
  }
}

/** The engine-shaped annotation a model one describes, for `addAnnotation` / `updateAnnotation`. */
export function toEngineAnnotation(a: ModelAnnotation, pageIndex: number): Omit<Annotation, 'id'> {
  const out: Record<string, unknown> = {
    page: pageIndex,
    subtype: a.subtype,
    rect: a.rect,
    flags: a.flags,
  };
  const put = (key: string, value: unknown): void => {
    if (value !== null && value !== undefined) out[key] = value;
  };
  put('contents', a.contents);
  put('author', a.author);
  put('created', a.created);
  put('modified', a.modified);
  put('color', a.color);
  put('interiorColor', a.interiorColor);
  put('opacity', a.opacity);
  put('borderWidth', a.borderWidth);
  put('appearanceState', a.appearanceState);
  put('name', a.name);
  put('subject', a.subject);
  put('state', a.state);
  if (a.family === 'markup' && a.quadPoints.length > 0) out['quadPoints'] = a.quadPoints;
  if (a.family === 'link' && a.quadPoints.length > 0) out['quadPoints'] = a.quadPoints;
  if (a.family === 'ink' && a.paths.length > 0) out['paths'] = a.paths;
  if (a.family === 'shape' && a.vertices.length > 0) out['paths'] = [a.vertices];
  if (Object.keys(a.extra).length > 0) out['extra'] = a.extra;
  return out as unknown as Omit<Annotation, 'id'>;
}

// ---- form fields -------------------------------------------------------------------------------

/** One on-page appearance of a field. */
export interface ModelWidget {
  readonly id: ModelId;
  readonly pageId: ModelId;
  readonly rect: PdfRect;
  /** The Widget annotation this widget is drawn by, when the page has been loaded. */
  readonly annotationId: ModelId | null;
}

/**
 * A form field. Fields form a tree through the dotted `/T` chain: `"address.city"` is the child
 * `"city"` of the intermediate node `"address"`. Intermediate nodes exist in the tree even when
 * the file has no dictionary for them, so a panel can group by them.
 */
export interface ModelField {
  readonly id: ModelId;
  /** Fully qualified name, dots included. */
  readonly name: string;
  /** Last segment of the name. */
  readonly partialName: string;
  readonly parentId: ModelId | null;
  readonly childIds: ReadonlyArray<ModelId>;
  readonly type: FormFieldType;
  readonly value: string;
  readonly defaultValue: string | null;
  readonly readOnly: boolean;
  readonly required: boolean;
  readonly options: ReadonlyArray<{ readonly value: string; readonly label: string }>;
  readonly tooltip: string | null;
  readonly widgets: ReadonlyArray<ModelWidget>;
  /** True for a node the tree invented to hold children (no dictionary of its own). */
  readonly synthetic: boolean;
}

// ---- outline, destinations, layers, attachments ------------------------------------------------

/** A destination inside the document, with the page as a model id. */
export interface ModelDestination {
  readonly id: ModelId;
  /** Name from the `/Dests` name tree, when it came from there. */
  readonly name: string | null;
  readonly pageId: ModelId | null;
  readonly fit: Destination['fit'];
  readonly left: number | null;
  readonly top: number | null;
  readonly zoom: number | null;
  readonly rect: PdfRect | null;
}

/** A bookmark. Children are ids so the tree can be edited without rebuilding it. */
export interface ModelOutlineItem {
  readonly id: ModelId;
  readonly title: string;
  readonly parentId: ModelId | null;
  readonly childIds: ReadonlyArray<ModelId>;
  readonly destinationId: ModelId | null;
  readonly uri: string | null;
  readonly open: boolean;
  readonly bold: boolean;
  readonly italic: boolean;
  readonly color: number | null;
}

/** An optional-content group. */
export interface ModelLayer {
  readonly id: ModelId;
  readonly engineId: string;
  readonly name: string;
  readonly visible: boolean;
  readonly locked: boolean;
  readonly depth: number;
}

/** An embedded file. */
export interface ModelAttachment {
  readonly id: ModelId;
  readonly engineId: string;
  readonly name: string;
  readonly description: string | null;
  readonly mimeType: string | null;
  readonly size: number | null;
  readonly modified: string | null;
  /** `/CreationDate` of the embedded stream (M12, ADR 0011). */
  readonly created: string | null;
  /**
   * Values of a PDF Portfolio's custom schema fields for this file, keyed by field key (M12,
   * ADR 0011). Empty for an ordinary attachment.
   */
  readonly collectionFields: Readonly<Record<string, string>>;
  /** Set when the attachment comes from a FileAttachment annotation. */
  readonly pageId: ModelId | null;
}

// ---- document-level state ----------------------------------------------------------------------

/** Metadata plus the raw XMP packet. Mutable through `meta.set`; XMP through M72. */
export interface ModelMetadata {
  readonly title: string | null;
  readonly author: string | null;
  readonly subject: string | null;
  readonly keywords: string | null;
  readonly creator: string | null;
  readonly producer: string | null;
  readonly created: string | null;
  readonly modified: string | null;
  readonly version: string;
  readonly xmp: string | null;
  readonly tagged: boolean;
  readonly linearized: boolean;
  readonly hasForm: boolean;
  readonly hasXfa: boolean;
  /**
   * Information-dictionary entries that are not one of the standard keys (M72, ADR 0017), by
   * the key as it is written in the file. Foxit calls these custom document properties.
   */
  readonly custom: Readonly<Record<string, string>>;
  /** `/Trapped` (M72, ADR 0017). */
  readonly trapped: 'True' | 'False' | 'Unknown' | null;
  /** The catalogue's `/Lang`: the document's natural language, as a BCP 47 tag (M72). */
  readonly lang: string | null;
  /** The catalogue's `/URI /Base`, against which relative link URIs resolve (M72). */
  readonly baseUrl: string | null;
}

/** What the file's security handler allows. Read-only in M20; M70 owns changing it. */
export interface SecurityState {
  readonly encrypted: boolean;
  readonly permissions: Permissions;
}

/**
 * A signature as a viewer shows it before any trust decision. Validation — chain building,
 * revocation, LTV — is M81's job; nothing here asserts that a signature is *good*.
 */
export interface SignatureSummary {
  readonly id: ModelId;
  readonly reason: string | null;
  readonly subFilter: string | null;
  /** Signing time as the file states it, ISO 8601 when parsable. */
  readonly time: string | null;
  /** `/ByteRange`, as stored. An odd or short array means the file is malformed. */
  readonly byteRange: ReadonlyArray<number>;
  /** `/DocMDP` permission level 1..3, or `null` when the signature is not a certification. */
  readonly docMdpPermission: number | null;
}

/**
 * How the file asks to be opened (`/OpenAction`, `/PageMode`, `/PageLayout`,
 * `/ViewerPreferences`). Filled from the engine on open and written back by M21's writer
 * (M72, ADR 0017); whether the application *obeys* it is M72's `applyInitialView` setting.
 */
export interface ViewSettings {
  readonly pageMode: 'none' | 'outlines' | 'thumbnails' | 'fullscreen' | 'attachments' | 'ocg';
  readonly initialPageId: ModelId | null;
  readonly initialZoom: number | null;
  readonly initialFit: Destination['fit'] | null;
  /** `/PageLayout`; `default` means the file does not say and the reader's preference wins. */
  readonly pageLayout:
    | 'default'
    | 'single'
    | 'one-column'
    | 'two-column-left'
    | 'two-column-right'
    | 'two-page-left'
    | 'two-page-right';
  readonly hideToolbar: boolean;
  readonly hideMenubar: boolean;
  readonly hideWindowUi: boolean;
  readonly fitWindow: boolean;
  readonly centreWindow: boolean;
  readonly displayDocTitle: boolean;
  readonly printScaling: 'app-default' | 'none';
  /** Reading order of the *interface*, not of the text. */
  readonly direction: 'l2r' | 'r2l';
}

export const DEFAULT_VIEW_SETTINGS: ViewSettings = {
  pageMode: 'none',
  initialPageId: null,
  initialZoom: null,
  initialFit: null,
  pageLayout: 'default',
  hideToolbar: false,
  hideMenubar: false,
  hideWindowUi: false,
  fitWindow: false,
  centreWindow: false,
  displayDocTitle: false,
  printScaling: 'app-default',
  direction: 'l2r',
};

/**
 * A change the engine could not take, which M21's writer must apply itself. Recorded as a set
 * of kinds rather than a log: what matters at save time is *what* differs, not how often.
 */
export type WriteIntent =
  | 'page-order'
  | 'page-labels'
  | 'page-boxes'
  | 'metadata'
  | 'layers'
  | 'outline'
  /** Named destinations were edited; the writer rebuilds `/Names /Dests` (M12, ADR 0011). */
  | 'destinations'
  /**
   * Embedded files were edited (M12, ADR 0011). The engine took the bytes and the name; the
   * description and the MIME type it could only write into `/Params`, so the writer moves them
   * to the file specification where a reader looks for them.
   */
  | 'attachments'
  | 'annotations'
  | 'fields'
  /**
   * The initial view or a document-level property was edited (M72, ADR 0017): `/PageMode`,
   * `/PageLayout`, `/OpenAction`, `/ViewerPreferences`, `/Lang` or the base URL. PDFium has a
   * setter for none of them, so the writer applies the whole section.
   */
  | 'view'
  /**
   * The PDF Portfolio structure was edited (M42, ADR 0014). The writer rebuilds `/Collection`,
   * `/Folders` and the `/EmbeddedFiles` name tree from the plan, reusing every embedded stream
   * the reader did not replace.
   */
  | 'portfolio'
  /**
   * Page objects were moved, resized, deleted, restyled or pasted (M50, ADR 0018). The engine
   * took every edit for the live page; the writer replays them onto the original content stream
   * so operators PDFium does not model survive the save.
   */
  | 'page-objects'
  | 'custom';

/** Everything a module may hang off the document, one namespace per module id. */
export type CustomBag = Readonly<Record<string, Readonly<Record<string, unknown>>>>;

// ---- conversions from engine reads --------------------------------------------------------------

export function toModelMetadata(m: Metadata): ModelMetadata {
  return {
    title: m.title ?? null,
    author: m.author ?? null,
    subject: m.subject ?? null,
    keywords: m.keywords ?? null,
    creator: m.creator ?? null,
    producer: m.producer ?? null,
    created: m.created ?? null,
    modified: m.modified ?? null,
    version: m.version,
    xmp: m.xmp ?? null,
    tagged: m.tagged,
    linearized: m.linearized,
    hasForm: m.hasForm,
    hasXfa: m.hasXfa,
    custom: m.custom ?? {},
    trapped: m.trapped ?? null,
    lang: m.lang ?? null,
    baseUrl: m.baseUrl ?? null,
  };
}

/**
 * The engine's reading of `/PageMode` and friends as model state (M72, ADR 0017). The open
 * action's page index becomes a model page id, so a page that moves takes its initial view with
 * it; a destination naming a page that is not there is dropped.
 */
export function toViewSettings(
  view: InitialView,
  pageIdAt: (index: PageIndex) => ModelId | null,
): ViewSettings {
  const dest = view.openAction;
  const pageId = dest ? pageIdAt(dest.page) : null;
  return {
    pageMode: view.pageMode,
    pageLayout: view.pageLayout,
    initialPageId: pageId,
    initialZoom: dest?.zoom ?? null,
    initialFit: dest && pageId !== null ? dest.fit : null,
    hideToolbar: view.hideToolbar,
    hideMenubar: view.hideMenubar,
    hideWindowUi: view.hideWindowUi,
    fitWindow: view.fitWindow,
    centreWindow: view.centreWindow,
    displayDocTitle: view.displayDocTitle,
    printScaling: view.printScaling,
    direction: view.direction,
  };
}

export function toModelLayer(id: ModelId, layer: Layer): ModelLayer {
  return {
    id,
    engineId: layer.id,
    name: layer.name,
    visible: layer.visible,
    locked: layer.locked,
    depth: layer.depth,
  };
}

export function toModelAttachment(
  id: ModelId,
  attachment: Attachment,
  pageId: ModelId | null,
): ModelAttachment {
  return {
    id,
    engineId: attachment.id,
    name: attachment.name,
    description: attachment.description ?? null,
    mimeType: attachment.mimeType ?? null,
    size: attachment.size ?? null,
    modified: attachment.modified ?? null,
    created: attachment.created ?? null,
    collectionFields: attachment.collectionFields ?? {},
    pageId,
  };
}

export function toModelDestination(
  id: ModelId,
  dest: Destination,
  pageId: ModelId | null,
  name: string | null = null,
): ModelDestination {
  return {
    id,
    name,
    pageId,
    fit: dest.fit,
    left: dest.left ?? null,
    top: dest.top ?? null,
    zoom: dest.zoom ?? null,
    rect: dest.rect ?? null,
  };
}

/** Flattens an engine outline tree into id-linked model nodes, parents before children. */
export function flattenOutline(
  items: ReadonlyArray<OutlineItem>,
  nextId: () => ModelId,
  destinationFor: (item: OutlineItem) => ModelId | null,
): ModelOutlineItem[] {
  const out: ModelOutlineItem[] = [];
  const walk = (list: ReadonlyArray<OutlineItem>, parentId: ModelId | null): ModelId[] => {
    const ids: ModelId[] = [];
    for (const item of list) {
      const id = nextId();
      ids.push(id);
      const node: ModelOutlineItem = {
        id,
        title: item.title,
        parentId,
        childIds: [],
        destinationId: destinationFor(item),
        uri: item.uri ?? null,
        open: item.open,
        bold: item.bold ?? false,
        italic: item.italic ?? false,
        color: item.color ?? null,
      };
      out.push(node);
      const childIds = walk(item.children, id);
      const index = out.indexOf(node);
      out[index] = { ...node, childIds };
    }
    return ids;
  };
  walk(items, null);
  return out;
}

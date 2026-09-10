/**
 * `PdfiumEngine` — the `PdfEngine` read implementation on PDFium WASM (M10, ADR 0006).
 *
 * Runs in the engine Worker (`src/engine/worker.ts`) and in Node for unit tests. It owns the
 * wasm module, one form-fill environment per document, a small LRU of loaded pages per
 * document, and the font registry. Everything is synchronous C calls except `render`, which
 * uses PDFium's progressive renderer and yields to the event loop so cancel messages get
 * through (`cancelCurrent()`).
 *
 * M20 (ADR 0007) added the mutations PDFium can express — page rotation, insert, delete, move,
 * import, crop box, annotation add/update/delete, form field values — plus the signature and
 * named-destination reads. `setMetadata` and `setLayerVisible` stay `NotImplementedError`
 * because the build has no API for them; the document model records those as write intents and
 * M21's writer applies them. The mutation helpers live in `mutations.ts`.
 */

import type {
  PageBoxes,
  PageIndex,
  PageSize,
  PdfMatrix,
  PdfPoint,
  PdfRect,
  Rotation,
} from '@shared/pdf';
import { normalizeRect } from '@shared/pdf';
import { PageGeometry } from '../geometry';
import { appearanceInput, defaultAppearanceService } from '../appearance';
import {
  EngineError,
  NotImplementedError,
  type Annotation,
  type AnnotationFlags,
  type AnnotationSubtype,
  type Attachment,
  type AttachmentPatch,
  type NewAttachment,
  type PdfCollection,
  type Destination,
  type DocHandle,
  type FontUsage,
  type FormField,
  type FormFieldType,
  type InitialView,
  type Layer,
  type Link,
  type Metadata,
  type NamedDestination,
  type NewAnnotation,
  type ObjectPath,
  type ObjectStyle,
  type OpenOptions,
  type PageContent,
  type OutlineItem,
  type PageObject,
  type PageObjectKind,
  type PageObjectPath,
  type PdfEngine,
  type Permissions,
  type ProgressCallback,
  type RenderOptions,
  type RenderResult,
  type SaveOptions,
  type SignatureSummary,
  type TextRun,
} from '../PdfEngine';
import {
  ACTION,
  ANNOT_COLORTYPE,
  ANNOT_FLAG,
  ANNOT_SUBTYPES,
  BITMAP,
  DEST_VIEW,
  FIELDFLAG,
  FONT_FLAG,
  FORMFIELD,
  FORMTYPE,
  FPDF_ERR,
  PAGEOBJ,
  PERMISSION_BIT,
  RENDER,
  RENDER_STATUS,
  SAVE,
} from './constants';
import { Ffi, readMatrix, readRectF, type WasmModule } from './ffi';
import {
  APPEARANCE_IS_CONTENT,
  applyLayerVisibility,
  assertRotation,
  dropAppearance,
  isoToPdfDate,
  patchIsVisual,
  readByteRange,
  setAppearanceStream,
  subtypeValue,
  writeAnnotation,
} from './mutations';
import { readPageContent } from '../content/pdf';
import {
  createObjectStash,
  destroyObjectStash,
  insertFromPdf,
  objectAsPdf as objectAsPdfFrom,
  removeObject as removePageObject,
  reorderObjects as reorderPageObjects,
  restoreObject as restorePageObject,
  setObjectMatrix as setPageObjectMatrix,
  transformObject as transformPageObject,
  setObjectStyle as setPageObjectStyle,
  readObjectPath,
  type ObjectStash,
} from './objects';
import { FontRegistry, type SubstitutionTable } from './fonts';
import { readRawInfo, type RawInfo } from './rawdoc';
import { addFunction, instantiatePdfium, removeFunction } from './wasm';
import { yieldMacrotask } from '../yield';

/** Version string reported by `info()`; the wasm carries no runtime version API. */
export const PDFIUM_BUILD = '@hyzyla/pdfium 2.1.13 (wasm)';

/** Subtypes the adapter gives the app's own appearance as they are written (M31, ADR 0016). */
const OWN_APPEARANCE_SUBTYPES: ReadonlySet<AnnotationSubtype> = new Set<AnnotationSubtype>([
  'Square',
  'Circle',
  'Ink',
]);

/** Subtypes whose dictionary entries only the raw pass can read (M31): see `annotationsSync`. */
const RAW_PASS_SUBTYPES: ReadonlySet<AnnotationSubtype> = new Set<AnnotationSubtype>([
  'Line',
  'Square',
  'Circle',
  'Polygon',
  'PolyLine',
  'Ink',
  'Stamp',
]);

export interface PdfiumEngineOptions {
  /** Raw `pdfium.wasm` bytes (patched for callbacks internally). */
  readonly wasm: Uint8Array;
  /** Font files by name, matching `substitutions.json`. Empty → PDFium built-in fonts. */
  readonly fonts?: ReadonlyMap<string, Uint8Array>;
  readonly substitutions?: SubstitutionTable;
  /** Milliseconds a render may run before yielding to the event loop (default 20). */
  readonly renderSlice?: number;
  /** Loaded pages kept per document (default 8). */
  readonly pageCacheSize?: number;
}

/** A render result before it becomes an `ImageBitmap`: straight RGBA pixels. */
export interface RawRender {
  readonly width: number;
  readonly height: number;
  readonly rgba: Uint8ClampedArray<ArrayBuffer>;
  readonly scale: number;
  readonly rect: PdfRect;
}

interface LoadedPage {
  readonly index: number;
  readonly page: number;
  textPage: number;
  geometry: PageGeometry | null;
  /** Page object handle → index in the page's object list (built on demand). */
  objectIndex: Map<number, number> | null;
}

interface OpenDoc {
  readonly handle: DocHandle;
  readonly doc: number;
  readonly form: number;
  readonly formInfo: number;
  readonly bytesPtr: number;
  readonly bytes: Uint8Array;
  readonly encrypted: boolean;
  readonly pages: Map<number, LoadedPage>;
  raw: Promise<RawInfo> | null;
  /**
   * True once anything has been changed (M20). `bytes` is then the file as it was *opened*, not
   * as it is now, so the raw catalogue pass has to re-serialise instead of re-reading them.
   */
  mutated: boolean;
  /**
   * Names of the optional-content groups the caller has hidden (M12, ADR 0011). PDFium has no
   * OCG API: visibility is applied by deactivating the page objects marked with the group, and
   * that lives on the *loaded* page — so it is re-applied every time a page is loaded.
   */
  hiddenLayerNames: Set<string>;
  /** Removed page objects waiting for an undo (M50, ADR 0018). */
  readonly objectStash: ObjectStash;
}

/** Engines that can abort the request currently executing (used by the worker on `cancel`). */
export interface CancellableEngine {
  cancelCurrent(): void;
}

/** `D:YYYYMMDDHHmmSSOHH'mm'` → ISO 8601. Returns undefined for unparsable input. */
export function pdfDateToIso(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const m =
    /^(?:D:)?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?(?:([Zz+-])(\d{2})?'?(\d{2})?'?)?/.exec(
      value.trim(),
    );
  if (!m) return undefined;
  const [, y, mo = '01', d = '01', h = '00', mi = '00', s = '00', tz, tzh = '00', tzm = '00'] = m;
  const date = `${y}-${mo}-${d}T${h}:${mi}:${s}`;
  if (!tz || tz === 'Z' || tz === 'z') return `${date}Z`;
  return `${date}${tz}${tzh}:${tzm}`;
}

const packRgb = (r: number, g: number, b: number): number =>
  ((r & 255) << 16) | ((g & 255) << 8) | (b & 255);

/**
 * Splits an annotation id (`"a2.7"` — page 2, index 7) back into its parts. Ids are only stable
 * while the page is unmodified; M20's `IdTable` re-binds them after every add or delete.
 */
export function parseAnnotationId(id: string): { page: PageIndex; index: number } {
  const m = /^a(\d+)\.(\d+)$/.exec(id);
  if (!m) throw new EngineError('invalid-argument', `${id} is not an annotation id`);
  return { page: Number(m[1]), index: Number(m[2]) };
}

function optional<K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}

/** Runs a synchronous body so that a throw becomes a rejection, as the contract promises. */
function run<T>(fn: () => T): Promise<T> {
  try {
    return Promise.resolve(fn());
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error(String(error)));
  }
}

// ---- path outlines (M33, ADR 0018) ---------------------------------------------------------------

/** `FPDFPathSegment_GetType`. `-1` is PDFium's "unknown". */
const SEGMENT = { LINETO: 0, BEZIERTO: 1, MOVETO: 2 } as const;

/** How many straight pieces one Bézier becomes. 16 is under a tenth of a point at any real zoom. */
const BEZIER_STEPS = 16;

/**
 * How many objects one `pageObjectPaths` call will look at, however they are nested (M33).
 *
 * Not a limit on how deep a page may nest — that is the file's business, and a placed drawing
 * inside a stamp inside an imported page is ordinary. It is a limit on how long the call may
 * take, because it runs on the first pointer move over a page. Twenty thousand objects is far
 * more than any page a reader measures and still returns in a few milliseconds.
 */
const MAX_PATH_OBJECTS = 20_000;

/** Deep enough for any real file; a form that contains itself is stopped here. */
const MAX_FORM_DEPTH = 12;

const IDENTITY_MATRIX: PdfMatrix = [1, 0, 0, 1, 0, 0];

/** `a` applied after `b`: the matrix that maps a child's space through its parent's. */
function composeMatrix(parent: PdfMatrix, child: PdfMatrix): PdfMatrix {
  const [a1, b1, c1, d1, e1, f1] = child;
  const [a2, b2, c2, d2, e2, f2] = parent;
  return [
    a1 * a2 + b1 * c2,
    a1 * b2 + b1 * d2,
    c1 * a2 + d1 * c2,
    c1 * b2 + d1 * d2,
    e1 * a2 + f1 * c2 + e2,
    e1 * b2 + f1 * d2 + f2,
  ];
}

function applyMatrix(m: PdfMatrix, x: number, y: number): PdfPoint {
  return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] };
}

/** One cubic Bézier as `BEZIER_STEPS` straight pieces, the start point already emitted. */
function flattenBezier(
  into: PdfPoint[],
  from: PdfPoint,
  c1: PdfPoint,
  c2: PdfPoint,
  to: PdfPoint,
): void {
  for (let i = 1; i <= BEZIER_STEPS; i++) {
    const t = i / BEZIER_STEPS;
    const u = 1 - t;
    const w0 = u * u * u;
    const w1 = 3 * u * u * t;
    const w2 = 3 * u * t * t;
    const w3 = t * t * t;
    into.push({
      x: w0 * from.x + w1 * c1.x + w2 * c2.x + w3 * to.x,
      y: w0 * from.y + w1 * c1.y + w2 * c2.y + w3 * to.y,
    });
  }
}

/**
 * A path object's segments as polylines in the space `matrix` maps into. A closed subpath repeats
 * its first point, so a caller walking consecutive pairs sees the closing edge too.
 */
function readSubpaths(ffi: Ffi, obj: number, matrix: PdfMatrix, pt: number): PdfPoint[][] {
  const count = ffi.call('FPDFPath_CountSegments', obj);
  if (count <= 0) return [];
  const subpaths: PdfPoint[][] = [];
  let current: PdfPoint[] = [];
  // Bézier controls arrive as two ordinary segments before the end point.
  let pending: PdfPoint[] = [];
  const finish = (close: boolean): void => {
    const first = current[0];
    if (current.length >= 2) {
      if (close && first) current.push({ x: first.x, y: first.y });
      subpaths.push(current);
    }
    current = [];
  };
  for (let i = 0; i < count; i++) {
    const seg = ffi.call('FPDFPath_GetPathSegment', obj, i);
    if (seg === 0) continue;
    if (!ffi.call('FPDFPathSegment_GetPoint', seg, pt, pt + 4)) continue;
    const point = applyMatrix(matrix, ffi.f32(pt, 0), ffi.f32(pt, 1));
    const type = ffi.call('FPDFPathSegment_GetType', seg);
    const closes = ffi.call('FPDFPathSegment_GetClose', seg) !== 0;
    if (type === SEGMENT.MOVETO) {
      finish(false);
      pending = [];
      current = [point];
    } else if (type === SEGMENT.BEZIERTO) {
      pending.push(point);
      if (pending.length === 3) {
        const from = current[current.length - 1];
        const [c1, c2, to] = pending;
        if (from && c1 && c2 && to) flattenBezier(current, from, c1, c2, to);
        else current.push(point);
        pending = [];
      }
    } else {
      pending = [];
      current.push(point);
    }
    if (closes) finish(true);
  }
  finish(false);
  return subpaths;
}

export class PdfiumEngine implements PdfEngine, CancellableEngine {
  private readonly ffi: Ffi;
  /** Renamed from `fonts` when `PdfEngine.fonts()` arrived (M72, ADR 0017). */
  private readonly fontRegistry: FontRegistry | null;
  private readonly docs = new Map<number, OpenDoc>();
  private nextHandle = 1;
  private readonly renderSlice: number;
  private readonly pageCacheSize: number;
  private pausePtr = 0;
  private pauseFn = -1;
  private sliceStart = 0;
  private renderCancelled = false;
  private rendering = false;
  private destroyed = false;

  private constructor(m: WasmModule, options: PdfiumEngineOptions) {
    this.ffi = new Ffi(m);
    this.renderSlice = options.renderSlice ?? 20;
    this.pageCacheSize = options.pageCacheSize ?? 8;
    this.ffi.call('FPDF_InitLibraryWithConfig', 0);
    if (options.fonts && options.substitutions && options.fonts.size > 0) {
      this.fontRegistry = new FontRegistry(this.ffi, options.substitutions, options.fonts);
      this.fontRegistry.install();
    } else {
      this.fontRegistry = null;
    }
    // IFSDK_PAUSE { int version; FPDF_BOOL (*NeedToPauseNow)(IFSDK_PAUSE*); void* user; }
    this.pauseFn = addFunction(
      m,
      () =>
        this.renderCancelled || performance.now() - this.sliceStart > this.renderSlice ? 1 : 0,
      'ii',
    );
    this.pausePtr = this.ffi.malloc(12);
    this.ffi.setI32(this.pausePtr, 1, 0);
    this.ffi.setI32(this.pausePtr, this.pauseFn, 1);
    this.ffi.setI32(this.pausePtr, 0, 2);
  }

  /** Instantiates the wasm and initialises PDFium. */
  static async create(options: PdfiumEngineOptions): Promise<PdfiumEngine> {
    const m = await instantiatePdfium(options.wasm);
    return new PdfiumEngine(m, options);
  }

  /** Number of font files registered with PDFium (0 = built-in fonts only). */
  get fontCount(): number {
    return this.fontRegistry?.fileCount ?? 0;
  }

  /** Open document handles (diagnostics). */
  get openCount(): number {
    return this.docs.size;
  }

  /** Closes every document and tears PDFium down. The engine is unusable afterwards. */
  destroy(): void {
    if (this.destroyed) return;
    for (const h of [...this.docs.keys()]) this.closeDoc(h);
    this.fontRegistry?.dispose();
    if (this.pausePtr) this.ffi.free(this.pausePtr);
    if (this.pauseFn >= 0) removeFunction(this.ffi.m, this.pauseFn);
    this.ffi.call('FPDF_DestroyLibrary');
    this.destroyed = true;
  }

  // ---- CancellableEngine -----------------------------------------------------------------------

  cancelCurrent(): void {
    if (this.rendering) this.renderCancelled = true;
  }

  // ---- PdfEngine: lifecycle --------------------------------------------------------------------

  info(): Promise<{ readonly name: string; readonly version: string }> {
    return Promise.resolve({ name: 'pdfium', version: PDFIUM_BUILD });
  }

  open(bytes: Uint8Array, options: OpenOptions = {}): Promise<DocHandle> {
    return run(() => this.openSync(bytes, options));
  }

  /** Synchronous open, handy for tests and benchmarks. */
  openSync(bytes: Uint8Array, options: OpenOptions = {}): DocHandle {
    const ffi = this.ffi;
    const bytesPtr = ffi.malloc(Math.max(1, bytes.byteLength));
    ffi.m.HEAPU8.set(bytes, bytesPtr);
    const doc = ffi.scope((s) => {
      const pw = options.password !== undefined ? s.utf8(options.password) : 0;
      return ffi.call('FPDF_LoadMemDocument', bytesPtr, bytes.byteLength, pw);
    });
    if (doc === 0) {
      ffi.free(bytesPtr);
      const err = ffi.call('FPDF_GetLastError');
      const name = options.name ?? 'document';
      switch (err) {
        case FPDF_ERR.PASSWORD:
          throw options.password !== undefined
            ? new EngineError('wrong-password', `${name}: wrong password`)
            : new EngineError('password-required', `${name}: a password is required`);
        case FPDF_ERR.SECURITY:
          throw new EngineError('unsupported', `${name}: unsupported security handler`);
        case FPDF_ERR.XFALOAD:
        case FPDF_ERR.XFALAYOUT:
          throw new EngineError('unsupported', `${name}: XFA form could not be loaded`);
        default:
          throw new EngineError('corrupt', `${name}: not a readable PDF (PDFium error ${err})`);
      }
    }
    // Form-fill environment so widgets render with their values (FPDF_FORMFILLINFO v1, zeroed).
    const formInfo = ffi.malloc(256);
    ffi.m.HEAPU8.fill(0, formInfo, formInfo + 256);
    ffi.setI32(formInfo, 1, 0);
    const form = ffi.call('FPDFDOC_InitFormFillEnvironment', doc, formInfo);
    if (form !== 0) ffi.call('FPDF_RemoveFormFieldHighlight', form);
    const handle = this.nextHandle++ as DocHandle;
    this.docs.set(handle, {
      handle,
      doc,
      form,
      formInfo,
      bytesPtr,
      bytes,
      encrypted: ffi.call('FPDF_GetSecurityHandlerRevision', doc) !== -1,
      pages: new Map(),
      raw: null,
      mutated: false,
      hiddenLayerNames: new Set(),
      objectStash: createObjectStash(),
    });
    return handle;
  }

  /**
   * A new, empty document (M40, ADR 0016). `importPages` fills it; it has no bytes of its own,
   * so `bytesPtr` is zero and `bytes` is empty — `closeDoc` frees a null pointer happily and
   * the raw catalogue pass re-serialises because `mutated` starts true.
   */
  createDocument(): Promise<DocHandle> {
    return run(() => {
      const doc = this.ffi.call('FPDF_CreateNewDocument');
      if (doc === 0) throw new EngineError('internal', 'PDFium could not create a document');
      const formInfo = this.ffi.malloc(256);
      this.ffi.m.HEAPU8.fill(0, formInfo, formInfo + 256);
      this.ffi.setI32(formInfo, 1, 0);
      const form = this.ffi.call('FPDFDOC_InitFormFillEnvironment', doc, formInfo);
      if (form !== 0) this.ffi.call('FPDF_RemoveFormFieldHighlight', form);
      const handle = this.nextHandle++ as DocHandle;
      this.docs.set(handle, {
        handle,
        doc,
        form,
        formInfo,
        bytesPtr: 0,
        bytes: new Uint8Array(0),
        encrypted: false,
        pages: new Map(),
        raw: null,
        // There are no bytes to re-read, so every raw pass must serialise what is here now.
        mutated: true,
        hiddenLayerNames: new Set(),
        objectStash: createObjectStash(),
      });
      return handle;
    });
  }

  close(doc: DocHandle): Promise<void> {
    return run(() => {
      this.closeDoc(doc);
    });
  }

  private closeDoc(handle: number): void {
    const d = this.docs.get(handle);
    if (!d) throw new EngineError('invalid-handle', `document handle ${handle} is not open`);
    for (const p of d.pages.values()) this.unloadPage(d, p);
    d.pages.clear();
    destroyObjectStash(this.ffi, d.objectStash);
    if (d.form !== 0) this.ffi.call('FPDFDOC_ExitFormFillEnvironment', d.form);
    this.ffi.call('FPDF_CloseDocument', d.doc);
    this.ffi.free(d.formInfo);
    this.ffi.free(d.bytesPtr);
    this.docs.delete(handle);
  }

  private doc(handle: DocHandle): OpenDoc {
    const d = this.docs.get(handle);
    if (!d) throw new EngineError('invalid-handle', `document handle ${handle} is not open`);
    return d;
  }

  // ---- pages -----------------------------------------------------------------------------------

  private loadPage(d: OpenDoc, index: PageIndex): LoadedPage {
    const cached = d.pages.get(index);
    if (cached) {
      // Refresh LRU position.
      d.pages.delete(index);
      d.pages.set(index, cached);
      return cached;
    }
    const count = this.ffi.call('FPDF_GetPageCount', d.doc);
    if (!Number.isInteger(index) || index < 0 || index >= count) {
      throw new EngineError('invalid-page', `page ${index} is out of range (0..${count - 1})`);
    }
    const page = this.ffi.call('FPDF_LoadPage', d.doc, index);
    if (page === 0) throw new EngineError('corrupt', `page ${index} could not be loaded`);
    if (d.form !== 0) this.ffi.call('FORM_OnAfterLoadPage', page, d.form);
    const loaded: LoadedPage = { index, page, textPage: 0, geometry: null, objectIndex: null };
    if (d.hiddenLayerNames.size > 0) applyLayerVisibility(this.ffi, page, d.hiddenLayerNames);
    d.pages.set(index, loaded);
    while (d.pages.size > this.pageCacheSize) {
      const oldest = d.pages.keys().next().value;
      if (oldest === undefined) break;
      const victim = d.pages.get(oldest);
      d.pages.delete(oldest);
      if (victim) this.unloadPage(d, victim);
    }
    return loaded;
  }

  private unloadPage(d: OpenDoc, p: LoadedPage): void {
    if (p.textPage !== 0) this.ffi.call('FPDFText_ClosePage', p.textPage);
    if (d.form !== 0) this.ffi.call('FORM_OnBeforeClosePage', p.page, d.form);
    this.ffi.call('FPDF_ClosePage', p.page);
  }

  private textPage(p: LoadedPage): number {
    if (p.textPage === 0) p.textPage = this.ffi.call('FPDFText_LoadPage', p.page);
    return p.textPage;
  }

  private geometry(p: LoadedPage, extra: Rotation = 0): PageGeometry {
    if (!p.geometry) {
      const ffi = this.ffi;
      const boxes = ffi.scope((s) => {
        const buf = s.alloc(16);
        const read = (fn: string): PdfRect | null => {
          const ok = ffi.call(fn, p.page, buf, buf + 4, buf + 8, buf + 12);
          if (!ok) return null;
          return normalizeRect({
            x0: ffi.f32(buf, 0),
            y0: ffi.f32(buf, 1),
            x1: ffi.f32(buf, 2),
            y1: ffi.f32(buf, 3),
          });
        };
        return { media: read('FPDFPage_GetMediaBox'), crop: read('FPDFPage_GetCropBox') };
      });
      const rotate = ((ffi.call('FPDFPage_GetRotation', p.page) % 4) * 90) as Rotation;
      const valid = (r: PdfRect | null): r is PdfRect =>
        r !== null && r.x1 - r.x0 > 1 && r.y1 - r.y0 > 1;
      let media = boxes.media;
      if (!valid(media)) {
        // Missing or degenerate MediaBox: PDFium substitutes Letter; mirror its displayed size.
        const w = ffi.call('FPDF_GetPageWidthF', p.page);
        const h = ffi.call('FPDF_GetPageHeightF', p.page);
        const swap = rotate === 90 || rotate === 270;
        media = { x0: 0, y0: 0, x1: swap ? h : w, y1: swap ? w : h };
        if (!valid(media)) media = { x0: 0, y0: 0, x1: 612, y1: 792 };
      }
      const crop = valid(boxes.crop) ? boxes.crop : media;
      p.geometry = PageGeometry.fromBoxes(media, crop, rotate);
    }
    return extra === 0 ? p.geometry : new PageGeometry(p.geometry.pageSize, extra);
  }

  private objectIndexMap(p: LoadedPage): Map<number, number> {
    if (!p.objectIndex) {
      const map = new Map<number, number>();
      const n = this.ffi.call('FPDFPage_CountObjects', p.page);
      for (let i = 0; i < n; i++) map.set(this.ffi.call('FPDFPage_GetObject', p.page, i), i);
      p.objectIndex = map;
    }
    return p.objectIndex;
  }

  // ---- PdfEngine: structure --------------------------------------------------------------------

  pageCount(doc: DocHandle): Promise<number> {
    return run(() => this.ffi.call('FPDF_GetPageCount', this.doc(doc).doc));
  }

  pageSize(doc: DocHandle, page: PageIndex): Promise<PageSize> {
    return run(() => this.pageSizeSync(doc, page));
  }

  pageSizeSync(doc: DocHandle, page: PageIndex): PageSize {
    return this.geometry(this.loadPage(this.doc(doc), page)).pageSize;
  }

  /**
   * Every box the page carries, `null` where it carries none (M41, ADR 0017).
   *
   * Deliberately *not* routed through {@link geometry}, which exists to answer "how big is this
   * page" and therefore substitutes a MediaBox when the file has none. Here a missing box is the
   * answer, so each getter's own success flag is reported as it stands. PDFium does synthesise a
   * CropBox from the MediaBox, which is what every renderer does and what a reader expects to
   * see, so `crop` comes back non-null for any page that has a MediaBox.
   */
  pageBoxes(doc: DocHandle, page: PageIndex): Promise<PageBoxes> {
    return run(() => {
      const p = this.loadPage(this.doc(doc), page);
      const ffi = this.ffi;
      return ffi.scope((s) => {
        const buf = s.alloc(16);
        const read = (fn: string): PdfRect | null => {
          if (!ffi.call(fn, p.page, buf, buf + 4, buf + 8, buf + 12)) return null;
          const r = normalizeRect({
            x0: ffi.f32(buf, 0),
            y0: ffi.f32(buf, 1),
            x1: ffi.f32(buf, 2),
            y1: ffi.f32(buf, 3),
          });
          // A zero-area box is a box the file got wrong; saying "none" is the honest answer.
          return r.x1 - r.x0 > 0 && r.y1 - r.y0 > 0 ? r : null;
        };
        return {
          media: read('FPDFPage_GetMediaBox'),
          crop: read('FPDFPage_GetCropBox'),
          bleed: read('FPDFPage_GetBleedBox'),
          trim: read('FPDFPage_GetTrimBox'),
          art: read('FPDFPage_GetArtBox'),
        };
      });
    });
  }

  /** The geometry helper for a page (with an optional extra view rotation). */
  pageGeometry(doc: DocHandle, page: PageIndex, extra: Rotation = 0): PageGeometry {
    return this.geometry(this.loadPage(this.doc(doc), page), extra);
  }

  pageLabels(doc: DocHandle): Promise<ReadonlyArray<string>> {
    return run(() => {
      const d = this.doc(doc);
      const n = this.ffi.call('FPDF_GetPageCount', d.doc);
      const labels: string[] = [];
      for (let i = 0; i < n; i++) {
        const label = this.ffi.utf16Call((buf, len) =>
          this.ffi.call('FPDF_GetPageLabel', d.doc, i, buf, len),
        );
        labels.push(label || String(i + 1));
      }
      return labels;
    });
  }

  async metadata(doc: DocHandle): Promise<Metadata> {
    const d = this.doc(doc);
    const ffi = this.ffi;
    const meta = (key: string): string | undefined => {
      const v = ffi.scope((s) => {
        const k = s.utf8(key);
        return ffi.utf16Call((buf, len) => ffi.call('FPDF_GetMetaText', d.doc, k, buf, len));
      });
      return v === '' ? undefined : v;
    };
    const version = ffi.scope((s) => {
      const out = s.alloc(4);
      return ffi.call('FPDF_GetFileVersion', d.doc, out) ? ffi.i32(out) : 0;
    });
    const formType = ffi.call('FPDF_GetFormType', d.doc);
    const head = new TextDecoder('latin1').decode(
      d.bytes.subarray(0, Math.min(1024, d.bytes.length)),
    );
    const raw = await this.rawInfo(d);
    return {
      ...optional('title', meta('Title')),
      ...optional('author', meta('Author')),
      ...optional('subject', meta('Subject')),
      ...optional('keywords', meta('Keywords')),
      ...optional('creator', meta('Creator')),
      ...optional('producer', meta('Producer')),
      ...optional('created', pdfDateToIso(meta('CreationDate'))),
      ...optional('modified', pdfDateToIso(meta('ModDate'))),
      version: version > 0 ? `${Math.floor(version / 10)}.${version % 10}` : 'unknown',
      ...optional('xmp', raw.xmp),
      encrypted: d.encrypted,
      linearized: head.includes('/Linearized'),
      tagged: ffi.call('FPDFCatalog_IsTagged', d.doc) !== 0,
      hasForm: formType !== FORMTYPE.NONE,
      hasXfa: formType === FORMTYPE.XFA_FULL || formType === FORMTYPE.XFA_FOREGROUND,
      pageCount: ffi.call('FPDF_GetPageCount', d.doc),
      // Custom Info keys, /Trapped, /Lang and the base URL: no PDFium getter reaches any of them
      // (M72, ADR 0017), so they come from the same raw read as the XMP packet above.
      ...raw.documentInfo,
    };
  }

  permissions(doc: DocHandle): Promise<Permissions> {
    return run(() => {
      const d = this.doc(doc);
      const bits = this.ffi.call('FPDF_GetDocPermissions', d.doc) >>> 0;
      const has = (bit: number): boolean => (bits & (1 << (bit - 1))) !== 0;
      return {
        print: has(PERMISSION_BIT.PRINT),
        printHighQuality: has(PERMISSION_BIT.PRINT_HIGH),
        modify: has(PERMISSION_BIT.MODIFY),
        copy: has(PERMISSION_BIT.COPY),
        annotate: has(PERMISSION_BIT.ANNOTATE),
        fillForms: has(PERMISSION_BIT.FILL_FORMS),
        extractForAccessibility: has(PERMISSION_BIT.EXTRACT_ACCESSIBILITY),
        assemble: has(PERMISSION_BIT.ASSEMBLE),
      };
    });
  }

  outline(doc: DocHandle): Promise<ReadonlyArray<OutlineItem>> {
    return run(() => {
      const d = this.doc(doc);
      const visited = new Set<number>();
      const walk = (parent: number, depth: number): OutlineItem[] => {
        const items: OutlineItem[] = [];
        if (depth > 64) return items;
        let bm = this.ffi.call('FPDFBookmark_GetFirstChild', d.doc, parent);
        while (bm !== 0 && !visited.has(bm)) {
          visited.add(bm);
          const title = this.ffi.utf16Call((buf, len) =>
            this.ffi.call('FPDFBookmark_GetTitle', bm, buf, len),
          );
          const count = this.ffi.call('FPDFBookmark_GetCount', bm);
          let dest = this.destination(d, this.ffi.call('FPDFBookmark_GetDest', d.doc, bm));
          let uri: string | undefined;
          if (!dest) {
            const resolved = this.action(d, this.ffi.call('FPDFBookmark_GetAction', bm));
            dest = resolved.dest;
            uri = resolved.uri;
          }
          items.push({
            title,
            ...optional('dest', dest),
            ...optional('uri', uri),
            children: walk(bm, depth + 1),
            open: count > 0,
          });
          bm = this.ffi.call('FPDFBookmark_GetNextSibling', d.doc, bm);
        }
        return items;
      };
      return walk(0, 0);
    });
  }

  private destination(d: OpenDoc, dest: number): Destination | undefined {
    if (dest === 0) return undefined;
    const ffi = this.ffi;
    const page = ffi.call('FPDFDest_GetDestPageIndex', d.doc, dest);
    if (page < 0) return undefined;
    return ffi.scope((s) => {
      const numParams = s.alloc(4);
      const params = s.alloc(16);
      const mode = ffi.call('FPDFDest_GetView', dest, numParams, params);
      const p = (i: number): number => ffi.f32(params, i);
      switch (mode) {
        case DEST_VIEW.XYZ: {
          const flags = s.alloc(12);
          const vals = s.alloc(12);
          ffi.call(
            'FPDFDest_GetLocationInPage',
            dest,
            flags,
            flags + 4,
            flags + 8,
            vals,
            vals + 4,
            vals + 8,
          );
          return {
            page,
            fit: 'xyz',
            ...optional('left', ffi.i32(flags, 0) ? ffi.f32(vals, 0) : undefined),
            ...optional('top', ffi.i32(flags, 1) ? ffi.f32(vals, 1) : undefined),
            ...optional('zoom', ffi.i32(flags, 2) ? ffi.f32(vals, 2) : undefined),
          };
        }
        case DEST_VIEW.FIT:
          return { page, fit: 'fit' };
        case DEST_VIEW.FITH:
          return { page, fit: 'fitH', top: p(0) };
        case DEST_VIEW.FITV:
          return { page, fit: 'fitV', left: p(0) };
        case DEST_VIEW.FITR:
          return {
            page,
            fit: 'fitR',
            rect: normalizeRect({ x0: p(0), y0: p(1), x1: p(2), y1: p(3) }),
          };
        case DEST_VIEW.FITB:
          return { page, fit: 'fitB' };
        case DEST_VIEW.FITBH:
          return { page, fit: 'fitBH', top: p(0) };
        case DEST_VIEW.FITBV:
          return { page, fit: 'fitBV', left: p(0) };
        default:
          return { page, fit: 'xyz' };
      }
    });
  }

  private action(d: OpenDoc, action: number): { dest?: Destination; uri?: string } {
    if (action === 0) return {};
    const type = this.ffi.call('FPDFAction_GetType', action);
    if (type === ACTION.GOTO) {
      return optional(
        'dest',
        this.destination(d, this.ffi.call('FPDFAction_GetDest', d.doc, action)),
      );
    }
    if (type === ACTION.URI) {
      const uri = this.ffi.utf8Call((buf, len) =>
        this.ffi.call('FPDFAction_GetURIPath', d.doc, action, buf, len),
      );
      return uri ? { uri } : {};
    }
    if (type === ACTION.REMOTEGOTO || type === ACTION.LAUNCH) {
      const path = this.ffi.utf8Call((buf, len) =>
        this.ffi.call('FPDFAction_GetFilePath', action, buf, len),
      );
      return path ? { uri: path } : {};
    }
    return {};
  }

  async layers(doc: DocHandle): Promise<ReadonlyArray<Layer>> {
    return (await this.rawInfo(this.doc(doc))).layers;
  }

  /**
   * The catalogue facts PDFium has no API for (layers, XMP, annotation colours behind a
   * generated appearance stream), read with pdf-lib.
   *
   * The bytes it parses must be the document *as it is now*: after a mutation `d.bytes` is the
   * file as it was opened, so an annotation added in this session would be invisible to the
   * fallback and its colour would read as absent. Encrypted files are copied without security
   * for the same reason — the strings would otherwise be unreadable.
   */
  private rawInfo(d: OpenDoc): Promise<RawInfo> {
    if (!d.raw) {
      let bytes = d.bytes;
      if (d.encrypted || d.mutated) {
        try {
          bytes = this.saveCopy(d, d.encrypted ? SAVE.REMOVE_SECURITY : 0);
        } catch {
          bytes = d.bytes;
        }
      }
      d.raw = readRawInfo(bytes);
    }
    return d.raw;
  }

  async attachments(doc: DocHandle): Promise<ReadonlyArray<Attachment>> {
    const list = this.attachmentsSync(doc);
    // PDFium's attachment API reads the embedded stream's /Params only; /Desc and /Subtype live
    // on the file specification, so fill them from the raw name tree when missing.
    const raw = await this.rawInfo(this.doc(doc));
    return list.map((a, i) => {
      if (!a.id.startsWith('att.')) return a;
      const extra = raw.embeddedFiles[i];
      if (!extra) return a;
      return {
        ...a,
        ...optional('description', a.description ?? extra.description),
        ...optional('mimeType', a.mimeType ?? extra.mimeType),
        ...optional('collectionFields', extra.collectionFields),
        // The name-tree key and the folder it names (M42, ADR 0016). PDFium reports the file
        // specification's own `/UF`, which is the clean name; the key carries the `<n>` prefix
        // that says which portfolio folder the file is in, and is what the writer matches on.
        ...optional('treeKey', extra.treeKey),
        ...optional('folderId', extra.folderId),
      };
    });
  }

  attachmentsSync(doc: DocHandle): Attachment[] {
    {
      const d = this.doc(doc);
      const ffi = this.ffi;
      const out: Attachment[] = [];
      const describe = (att: number, id: string, page?: number): Attachment => {
        const name = ffi.utf16Call((buf, len) => ffi.call('FPDFAttachment_GetName', att, buf, len));
        const str = (key: string): string | undefined => {
          const v = ffi.scope((s) => {
            const k = s.utf8(key);
            return ffi.utf16Call((buf, len) =>
              ffi.call('FPDFAttachment_GetStringValue', att, k, buf, len),
            );
          });
          return v === '' ? undefined : v;
        };
        const size = ffi.scope((s) => {
          const outLen = s.alloc(4);
          return ffi.call('FPDFAttachment_GetFile', att, 0, 0, outLen)
            ? ffi.u32(outLen)
            : undefined;
        });
        // `/Subtype` is a name on the embedded stream. PDFium can only *write* strings, and
        // writes them into `/Params`, so a type set in this session is read back from there
        // until M21's writer moves it into place on save (ADR 0011).
        const mime =
          (ffi.has('FPDFAttachment_GetSubtype')
            ? ffi.utf16Call((buf, len) => ffi.call('FPDFAttachment_GetSubtype', att, buf, len))
            : '') ||
          (str('Subtype') ?? '');
        return {
          id,
          name,
          ...optional('description', str('Desc')),
          ...optional('mimeType', mime === '' ? undefined : mime),
          ...optional('size', size),
          ...optional('modified', pdfDateToIso(str('ModDate'))),
          ...optional('created', pdfDateToIso(str('CreationDate'))),
          ...optional('page', page),
        };
      };
      const n = ffi.call('FPDFDoc_GetAttachmentCount', d.doc);
      for (let i = 0; i < n; i++) {
        const att = ffi.call('FPDFDoc_GetAttachment', d.doc, i);
        if (att !== 0) out.push(describe(att, `att.${i}`));
      }
      // FileAttachment annotations, page by page (annotation lists only, no content parsing).
      const pages = ffi.call('FPDF_GetPageCount', d.doc);
      for (let pi = 0; pi < pages; pi++) {
        const p = this.loadPage(d, pi);
        const count = ffi.call('FPDFPage_GetAnnotCount', p.page);
        for (let ai = 0; ai < count; ai++) {
          const annot = ffi.call('FPDFPage_GetAnnot', p.page, ai);
          if (annot === 0) continue;
          if (ANNOT_SUBTYPES[ffi.call('FPDFAnnot_GetSubtype', annot)] === 'FileAttachment') {
            const att = ffi.call('FPDFAnnot_GetFileAttachment', annot);
            if (att !== 0) out.push(describe(att, `annot.${pi}.${ai}`, pi));
          }
          ffi.call('FPDFPage_CloseAnnot', annot);
        }
      }
      return out;
    }
  }

  attachmentData(doc: DocHandle, attachmentId: string): Promise<Uint8Array> {
    return run(() => {
      const d = this.doc(doc);
      const ffi = this.ffi;
      const read = (att: number): Uint8Array =>
        ffi.scope((s) => {
          const outLen = s.alloc(4);
          if (!ffi.call('FPDFAttachment_GetFile', att, 0, 0, outLen)) return new Uint8Array(0);
          const len = ffi.u32(outLen);
          const buf = s.alloc(len);
          ffi.call('FPDFAttachment_GetFile', att, buf, len, outLen);
          return ffi.copyBytes(buf, ffi.u32(outLen));
        });
      const embedded = /^att\.(\d+)$/.exec(attachmentId);
      if (embedded) {
        const att = ffi.call('FPDFDoc_GetAttachment', d.doc, Number(embedded[1]));
        if (att === 0) throw new EngineError('invalid-argument', `no attachment ${attachmentId}`);
        return read(att);
      }
      const annotRef = /^annot\.(\d+)\.(\d+)$/.exec(attachmentId);
      if (annotRef) {
        const p = this.loadPage(d, Number(annotRef[1]));
        const annot = ffi.call('FPDFPage_GetAnnot', p.page, Number(annotRef[2]));
        if (annot === 0) throw new EngineError('invalid-argument', `no attachment ${attachmentId}`);
        try {
          const att = ffi.call('FPDFAnnot_GetFileAttachment', annot);
          if (att === 0) throw new EngineError('invalid-argument', `no attachment ${attachmentId}`);
          return read(att);
        } finally {
          ffi.call('FPDFPage_CloseAnnot', annot);
        }
      }
      throw new EngineError('invalid-argument', `bad attachment id ${attachmentId}`);
    });
  }

  /** The catalogue's `/Collection` — a PDF Portfolio — read with pdf-lib (ADR 0011). */
  async collection(doc: DocHandle): Promise<PdfCollection | null> {
    return (await this.rawInfo(this.doc(doc))).collection;
  }

  /**
   * Embeds a file in the `/EmbeddedFiles` name tree (ADR 0011).
   *
   * PDFium keeps the name tree sorted by name, so a new attachment's index — and therefore its
   * id — is wherever the sort puts it. The id is looked up by name afterwards rather than
   * assumed to be the last one.
   */
  addAttachment(doc: DocHandle, file: NewAttachment): Promise<Attachment> {
    return run(() => {
      const d = this.doc(doc);
      if (file.name === '') throw new EngineError('invalid-argument', 'an attachment needs a name');
      return this.addAttachmentSync(d, doc, file);
    });
  }

  /** Changes an embedded file's name, description, type, date or bytes (ADR 0011). */
  updateAttachment(
    doc: DocHandle,
    attachmentId: string,
    patch: AttachmentPatch,
  ): Promise<Attachment> {
    return run(() => {
      const d = this.doc(doc);
      const index = this.embeddedIndex(attachmentId);
      const att = this.ffi.call('FPDFDoc_GetAttachment', d.doc, index);
      if (att === 0) throw new EngineError('invalid-argument', `no attachment ${attachmentId}`);
      if (patch.name !== undefined && patch.name !== '') {
        // PDFium has no rename: re-embed under the new name and drop the old entry.
        const before = this.attachmentsSync(doc).find((a) => a.id === attachmentId);
        const bytes = patch.bytes ?? this.readAttachment(att);
        this.ffi.call('FPDFDoc_DeleteAttachment', d.doc, index);
        d.raw = null;
        d.mutated = true;
        return this.addAttachmentSync(d, doc, {
          name: patch.name,
          bytes,
          ...optional('description', patch.description ?? before?.description),
          ...optional('mimeType', patch.mimeType ?? before?.mimeType),
          modified: patch.modified ?? new Date().toISOString(),
          ...optional('created', before?.created),
        });
      }
      this.writeAttachment(d, att, patch);
      d.raw = null;
      d.mutated = true;
      const after = this.attachmentsSync(doc).find((a) => a.id === attachmentId);
      if (!after) throw new EngineError('internal', `attachment ${attachmentId} vanished`);
      return after;
    });
  }

  /** Removes an embedded file. Attachments after it shift down one index (ADR 0011). */
  deleteAttachment(doc: DocHandle, attachmentId: string): Promise<void> {
    return run(() => {
      const d = this.doc(doc);
      const index = this.embeddedIndex(attachmentId);
      const count = this.ffi.call('FPDFDoc_GetAttachmentCount', d.doc);
      if (index >= count)
        throw new EngineError('invalid-argument', `no attachment ${attachmentId}`);
      if (this.ffi.call('FPDFDoc_DeleteAttachment', d.doc, index) === 0) {
        throw new EngineError('internal', `PDFium would not delete ${attachmentId}`);
      }
      d.raw = null;
      d.mutated = true;
    });
  }

  /** `att.<n>` -> n. A file-attachment annotation is M31's, not editable through here. */
  private embeddedIndex(attachmentId: string): number {
    const m = /^att\.(\d+)$/.exec(attachmentId);
    if (!m?.[1]) {
      throw new EngineError(
        'invalid-argument',
        `${attachmentId} is a file-attachment annotation, not an embedded file`,
      );
    }
    return Number(m[1]);
  }

  /** Index of the embedded file with this name, or -1. */
  private attachmentIndexOf(d: OpenDoc, name: string): number {
    const ffi = this.ffi;
    const count = ffi.call('FPDFDoc_GetAttachmentCount', d.doc);
    for (let i = count - 1; i >= 0; i--) {
      const att = ffi.call('FPDFDoc_GetAttachment', d.doc, i);
      if (att === 0) continue;
      const found = ffi.utf16Call((buf, len) => ffi.call('FPDFAttachment_GetName', att, buf, len));
      if (found === name) return i;
    }
    return -1;
  }

  /** Embeds a file and reads back the attachment record PDFium ended up with. */
  private addAttachmentSync(d: OpenDoc, doc: DocHandle, file: NewAttachment): Attachment {
    const ffi = this.ffi;
    const att = ffi.scope((s) => ffi.call('FPDFDoc_AddAttachment', d.doc, s.utf16(file.name)));
    if (att === 0) throw new EngineError('internal', `PDFium would not embed "${file.name}"`);
    this.writeAttachment(d, att, {
      bytes: file.bytes,
      ...optional('description', file.description),
      ...optional('mimeType', file.mimeType),
      modified: file.modified ?? new Date().toISOString(),
      ...optional('created', file.created),
    });
    d.raw = null;
    d.mutated = true;
    const index = this.attachmentIndexOf(d, file.name);
    const found = this.attachmentsSync(doc).find((a) => a.id === `att.${index}`);
    if (!found) throw new EngineError('internal', `"${file.name}" was embedded but not found`);
    return found;
  }

  /** Writes the parts of an attachment PDFium has setters for. */
  private writeAttachment(
    d: OpenDoc,
    att: number,
    patch: AttachmentPatch & { readonly created?: string },
  ): void {
    const ffi = this.ffi;
    const bytes = patch.bytes;
    if (bytes) {
      ffi.scope((s) => {
        const ptr = s.bytes(bytes);
        // FPDFAttachment_SetFile(attachment, document, contents, len) — the document is not
        // optional: PDFium needs it to create the embedded stream.
        if (ffi.call('FPDFAttachment_SetFile', att, d.doc, ptr, bytes.length) === 0) {
          throw new EngineError('internal', 'PDFium would not write the attachment bytes');
        }
      });
    }
    const setString = (key: string, value: string): void => {
      ffi.scope((s) => {
        ffi.call('FPDFAttachment_SetStringValue', att, s.utf8(key), s.utf16(value));
      });
    };
    if (patch.description !== undefined) setString('Desc', patch.description);
    if (patch.mimeType !== undefined) setString('Subtype', patch.mimeType);
    const modified = isoToPdfDate(patch.modified);
    if (modified) setString('ModDate', modified);
    const created = isoToPdfDate(patch.created);
    if (created) setString('CreationDate', created);
  }

  /** The bytes behind an open attachment handle. */
  private readAttachment(att: number): Uint8Array {
    const ffi = this.ffi;
    return ffi.scope((s) => {
      const outLen = s.alloc(4);
      if (!ffi.call('FPDFAttachment_GetFile', att, 0, 0, outLen)) return new Uint8Array(0);
      const len = ffi.u32(outLen);
      const buf = s.alloc(len);
      ffi.call('FPDFAttachment_GetFile', att, buf, len, outLen);
      return ffi.copyBytes(buf, ffi.u32(outLen));
    });
  }

  // ---- PdfEngine: content ----------------------------------------------------------------------

  async render(
    doc: DocHandle,
    page: PageIndex,
    scale: number,
    rect?: PdfRect,
    options: RenderOptions = {},
  ): Promise<RenderResult> {
    const raw = await this.renderRaw(doc, page, scale, rect, options);
    const bitmap =
      typeof createImageBitmap === 'function' && typeof ImageData === 'function'
        ? await createImageBitmap(new ImageData(raw.rgba, raw.width, raw.height))
        : // Node (tests): no ImageBitmap; hand back the pixels under the same field.
          ({
            width: raw.width,
            height: raw.height,
            data: raw.rgba,
            close: () => undefined,
          } as unknown as ImageBitmap);
    return { bitmap, scale: raw.scale, rect: raw.rect };
  }

  /**
   * Renders to RGBA pixels. `rect` is in page space (whole page when omitted); `scale` is
   * device pixels per point. Cancellable through {@link cancelCurrent}.
   */
  async renderRaw(
    doc: DocHandle,
    page: PageIndex,
    scale: number,
    rect?: PdfRect,
    options: RenderOptions = {},
  ): Promise<RawRender> {
    if (!(scale > 0) || !Number.isFinite(scale)) {
      throw new EngineError('invalid-argument', `render scale must be positive, got ${scale}`);
    }
    if (this.rendering) throw new EngineError('internal', 'render is not re-entrant');
    const d = this.doc(doc);
    const p = this.loadPage(d, page);
    const geo = this.geometry(p, options.rotation ?? 0);
    const tile = geo.tile(rect, scale);
    const { x, y, width, height } = tile.device;
    if (width * height > 64 * 1024 * 1024) {
      throw new EngineError('invalid-argument', `render tile too large: ${width}×${height}`);
    }
    const ffi = this.ffi;
    let flags = RENDER.REVERSE_BYTE_ORDER;
    if (options.annotations !== false) flags |= RENDER.ANNOT;
    if (options.grayscale) flags |= RENDER.GRAYSCALE;
    if (options.printing) flags |= RENDER.PRINTING;
    if (options.lcdText) flags |= RENDER.LCD_TEXT;
    if (options.smoothText === false) flags |= RENDER.NO_SMOOTHTEXT;
    if (options.smoothImages === false) flags |= RENDER.NO_SMOOTHIMAGE;
    if (options.smoothPaths === false) flags |= RENDER.NO_SMOOTHPATH;
    const background = 0xff000000 | (options.background ?? 0xffffff);

    const bitmap = ffi.call('FPDFBitmap_CreateEx', width, height, BITMAP.BGRA, 0, 0);
    if (bitmap === 0) throw new EngineError('internal', 'PDFium could not allocate the bitmap');
    // "Line Weights off" (M11): hairline every stroke for this render, then put the widths back.
    const strokes = options.lineWeights === false ? this.hairlineStrokes(p.page) : null;
    this.rendering = true;
    this.renderCancelled = false;
    try {
      ffi.call('FPDFBitmap_FillRect', bitmap, 0, 0, width, height, background >>> 0);
      const startX = -x;
      const startY = -y;
      this.sliceStart = performance.now();
      let status = ffi.call(
        'FPDF_RenderPageBitmap_Start',
        bitmap,
        p.page,
        startX,
        startY,
        tile.pageWidthPx,
        tile.pageHeightPx,
        geo.pdfiumRotate,
        flags,
        this.pausePtr,
      );
      while (status === RENDER_STATUS.TOBECONTINUED) {
        await yieldMacrotask();
        if (this.renderCancelled) {
          ffi.call('FPDF_RenderPage_Close', p.page);
          throw new EngineError('cancelled', `render of page ${page} was cancelled`);
        }
        this.sliceStart = performance.now();
        status = ffi.call('FPDF_RenderPage_Continue', p.page, this.pausePtr);
      }
      ffi.call('FPDF_RenderPage_Close', p.page);
      if (status === RENDER_STATUS.FAILED) {
        throw new EngineError('internal', `PDFium failed to render page ${page}`);
      }
      if (options.forms !== false && d.form !== 0) {
        ffi.call(
          'FPDF_FFLDraw',
          d.form,
          bitmap,
          p.page,
          startX,
          startY,
          tile.pageWidthPx,
          tile.pageHeightPx,
          geo.pdfiumRotate,
          flags,
        );
      }
      const stride = ffi.call('FPDFBitmap_GetStride', bitmap);
      const buffer = ffi.call('FPDFBitmap_GetBuffer', bitmap);
      const rgba = new Uint8ClampedArray(width * height * 4);
      const heap = ffi.m.HEAPU8;
      if (stride === width * 4) {
        rgba.set(heap.subarray(buffer, buffer + width * height * 4));
      } else {
        for (let row = 0; row < height; row++) {
          rgba.set(
            heap.subarray(buffer + row * stride, buffer + row * stride + width * 4),
            row * width * 4,
          );
        }
      }
      return {
        width,
        height,
        rgba,
        scale: geo.width > 0 ? tile.pageWidthPx / geo.width : scale,
        rect: tile.page,
      };
    } finally {
      ffi.call('FPDFBitmap_Destroy', bitmap);
      if (strokes) this.restoreStrokes(strokes);
      this.rendering = false;
      this.renderCancelled = false;
    }
  }

  /**
   * Sets every stroke on the page (and inside its form XObjects) to width 0, which PDFium draws
   * as a one-pixel hairline, and reports the previous widths so the caller can restore them.
   * Nothing is written back to the document: `FPDFPage_GenerateContent` is never called, so the
   * bytes on disk and any later save are unaffected.
   */
  private hairlineStrokes(page: number): Array<[number, number]> {
    const ffi = this.ffi;
    const saved: Array<[number, number]> = [];
    const visit = (count: number, get: (i: number) => number, depth: number): void => {
      if (depth > 4) return;
      for (let i = 0; i < count; i++) {
        const obj = get(i);
        if (obj === 0) continue;
        ffi.scope((s) => {
          const f = s.alloc(4);
          if (ffi.call('FPDFPageObj_GetStrokeWidth', obj, f)) {
            const width = ffi.f32(f);
            if (width > 0) {
              saved.push([obj, width]);
              ffi.call('FPDFPageObj_SetStrokeWidth', obj, 0);
            }
          }
        });
        if (ffi.call('FPDFPageObj_GetType', obj) === PAGEOBJ.FORM) {
          const n = ffi.call('FPDFFormObj_CountObjects', obj);
          visit(n, (j) => ffi.call('FPDFFormObj_GetObject', obj, j), depth + 1);
        }
      }
    };
    visit(
      ffi.call('FPDFPage_CountObjects', page),
      (i) => ffi.call('FPDFPage_GetObject', page, i),
      0,
    );
    return saved;
  }

  private restoreStrokes(saved: ReadonlyArray<[number, number]>): void {
    for (const [obj, width] of saved) this.ffi.call('FPDFPageObj_SetStrokeWidth', obj, width);
  }

  textRuns(doc: DocHandle, page: PageIndex): Promise<ReadonlyArray<TextRun>> {
    return run(() => this.textRunsSync(doc, page));
  }

  textRunsSync(doc: DocHandle, page: PageIndex): TextRun[] {
    const d = this.doc(doc);
    const p = this.loadPage(d, page);
    const tp = this.textPage(p);
    const ffi = this.ffi;
    const n = ffi.call('FPDFText_CountChars', tp);
    const objects = this.objectIndexMap(p);
    const runs: TextRun[] = [];
    if (n <= 0) return runs;

    interface Building {
      objectHandle: number;
      text: string[];
      chars: PdfRect[];
      generated: boolean[];
      origin: PdfPoint;
      matrix: PdfMatrix;
      fontName: string;
      fontSize: number;
      color: number;
      angle: number;
      weight: number;
      flags: number;
      baseline: number;
    }
    let cur: Building | null = null;
    const fontCache = new Map<number, { name: string; flags: number }>();

    const flush = (): void => {
      if (!cur || cur.text.length === 0) {
        cur = null;
        return;
      }
      const b = cur;
      // Give generated spaces a box spanning their neighbours.
      for (let i = 0; i < b.chars.length; i++) {
        if (!b.generated[i]) continue;
        const prev = b.chars[i - 1];
        const next = b.chars[i + 1];
        const ref = prev ?? next;
        if (!ref) continue;
        b.chars[i] = normalizeRect({
          x0: prev ? prev.x1 : ref.x0,
          y0: ref.y0,
          x1: next ? next.x0 : ref.x1,
          y1: ref.y1,
        });
      }
      const real = b.chars.filter((_, i) => !b.generated[i]);
      const boxes = real.length > 0 ? real : b.chars;
      const rect = boxes.reduce(
        (acc, r) => ({
          x0: Math.min(acc.x0, r.x0),
          y0: Math.min(acc.y0, r.y0),
          x1: Math.max(acc.x1, r.x1),
          y1: Math.max(acc.y1, r.y1),
        }),
        { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity },
      );
      const nameLower = b.fontName.toLowerCase();
      const bold =
        b.weight >= 600 ||
        (b.flags & FONT_FLAG.FORCE_BOLD) !== 0 ||
        /bold|black|heavy/.test(nameLower);
      const italic = (b.flags & FONT_FLAG.ITALIC) !== 0 || /italic|oblique/.test(nameLower);
      runs.push({
        text: b.text.join(''),
        rect: Number.isFinite(rect.x0)
          ? rect
          : { x0: b.origin.x, y0: b.origin.y, x1: b.origin.x, y1: b.origin.y },
        chars: b.chars,
        origin: b.origin,
        matrix: b.matrix,
        fontName: b.fontName,
        fontSize: b.fontSize,
        color: b.color,
        objectIndex: objects.get(b.objectHandle) ?? -1,
        bold,
        italic,
        weight: b.weight,
        angle: b.angle,
        fontFlags: b.flags,
      });
      cur = null;
    };

    ffi.scope((s) => {
      const dbl = s.alloc(8 * 4); // four doubles
      const ints = s.alloc(4 * 4);
      const mat = s.alloc(4 * 6);
      for (let i = 0; i < n; i++) {
        const code = ffi.call('FPDFText_GetUnicode', tp, i);
        const generated = ffi.call('FPDFText_IsGenerated', tp, i) === 1;
        if (code === 0x0d || code === 0x0a) {
          flush();
          continue;
        }
        const objectHandle = ffi.call('FPDFText_GetTextObject', tp, i);
        const fontSize = ffi.call('FPDFText_GetFontSize', tp, i);
        let font = fontCache.get(objectHandle);
        if (!font) {
          let flags = 0;
          const name = ffi.utf8Call((buf, len) => {
            const r = ffi.call('FPDFText_GetFontInfo', tp, i, buf, len, ints);
            flags = ffi.i32(ints);
            return r;
          });
          font = { name, flags };
          fontCache.set(objectHandle, font);
        }
        const hasColor = ffi.call(
          'FPDFText_GetFillColor',
          tp,
          i,
          ints,
          ints + 4,
          ints + 8,
          ints + 12,
        );
        const color = hasColor ? packRgb(ffi.u32(ints, 0), ffi.u32(ints, 1), ffi.u32(ints, 2)) : 0;
        const angle = ffi.call('FPDFText_GetCharAngle', tp, i);
        const weight = ffi.call('FPDFText_GetFontWeight', tp, i);
        ffi.call('FPDFText_GetCharBox', tp, i, dbl, dbl + 8, dbl + 16, dbl + 24);
        const box = normalizeRect({
          x0: ffi.f64(dbl, 0),
          x1: ffi.f64(dbl, 1),
          y0: ffi.f64(dbl, 2),
          y1: ffi.f64(dbl, 3),
        });
        ffi.call('FPDFText_GetCharOrigin', tp, i, dbl, dbl + 8);
        const origin = { x: ffi.f64(dbl, 0), y: ffi.f64(dbl, 1) };
        const sameRun =
          cur !== null &&
          cur.objectHandle === objectHandle &&
          cur.fontSize === fontSize &&
          cur.color === color &&
          Math.abs(cur.angle - angle) < 1e-3 &&
          (Math.abs(angle) > 1e-3 ||
            Math.abs(cur.baseline - origin.y) < Math.max(0.5, fontSize * 0.05));
        let b: Building;
        if (!sameRun || cur === null) {
          flush();
          ffi.call('FPDFText_GetMatrix', tp, i, mat);
          b = {
            objectHandle,
            text: [],
            chars: [],
            generated: [],
            origin,
            matrix: readMatrix(ffi, mat),
            fontName: font.name,
            fontSize,
            color,
            angle,
            weight: weight < 0 ? 400 : weight,
            flags: font.flags,
            baseline: origin.y,
          };
          cur = b;
        } else {
          b = cur;
        }
        b.text.push(code > 0 ? String.fromCodePoint(code) : '�');
        b.chars.push(box);
        b.generated.push(generated);
      }
    });
    flush();
    return runs;
  }

  async pageObjects(doc: DocHandle, page: PageIndex): Promise<ReadonlyArray<PageObject>> {
    const d = this.doc(doc);
    const p = this.loadPage(d, page);
    const ffi = this.ffi;
    const n = ffi.call('FPDFPage_CountObjects', p.page);
    const out: PageObject[] = [];
    const kinds: Record<number, PageObjectKind> = {
      [PAGEOBJ.TEXT]: 'text',
      [PAGEOBJ.PATH]: 'path',
      [PAGEOBJ.IMAGE]: 'image',
      [PAGEOBJ.SHADING]: 'shading',
      [PAGEOBJ.FORM]: 'form',
    };
    const layerNames: Array<{ index: number; name: string }> = [];
    ffi.scope((s) => {
      const f = s.alloc(4 * 6);
      const u = s.alloc(4 * 4);
      const ocKey = s.utf8('Name');
      for (let i = 0; i < n; i++) {
        const obj = ffi.call('FPDFPage_GetObject', p.page, i);
        const kind = kinds[ffi.call('FPDFPageObj_GetType', obj)] ?? 'path';
        ffi.call('FPDFPageObj_GetBounds', obj, f, f + 4, f + 8, f + 12);
        const rect = normalizeRect({
          x0: ffi.f32(f, 0),
          y0: ffi.f32(f, 1),
          x1: ffi.f32(f, 2),
          y1: ffi.f32(f, 3),
        });
        ffi.call('FPDFPageObj_GetMatrix', obj, f);
        const matrix = readMatrix(ffi, f);
        const fill = ffi.call('FPDFPageObj_GetFillColor', obj, u, u + 4, u + 8, u + 12)
          ? {
              color: packRgb(ffi.u32(u, 0), ffi.u32(u, 1), ffi.u32(u, 2)),
              alpha: ffi.u32(u, 3) / 255,
            }
          : null;
        const stroke = ffi.call('FPDFPageObj_GetStrokeColor', obj, u, u + 4, u + 8, u + 12)
          ? {
              color: packRgb(ffi.u32(u, 0), ffi.u32(u, 1), ffi.u32(u, 2)),
              alpha: ffi.u32(u, 3) / 255,
            }
          : null;
        const strokeWidth = ffi.call('FPDFPageObj_GetStrokeWidth', obj, f) ? ffi.f32(f) : undefined;
        let extra: Partial<PageObject> = {};
        if (kind === 'text') {
          const tp = this.textPage(p);
          const text = ffi.utf16Call((buf, len) =>
            ffi.call('FPDFTextObj_GetText', obj, tp, buf, len),
          );
          const font = ffi.call('FPDFTextObj_GetFont', obj);
          const fontName =
            font !== 0
              ? ffi.utf8Call((buf, len) => ffi.call('FPDFFont_GetBaseFontName', font, buf, len))
              : '';
          const fontSize = ffi.call('FPDFTextObj_GetFontSize', obj, f) ? ffi.f32(f) : undefined;
          extra = {
            text,
            ...optional('fontName', fontName || undefined),
            ...optional('fontSize', fontSize),
          };
        } else if (kind === 'image') {
          if (ffi.call('FPDFImageObj_GetImagePixelSize', obj, u, u + 4)) {
            extra = { imageWidth: ffi.u32(u, 0), imageHeight: ffi.u32(u, 1) };
          }
        } else if (kind === 'form') {
          extra = { childCount: ffi.call('FPDFFormObj_CountObjects', obj) };
        }
        // Optional content: an /OC marked-content mark whose properties dict carries /Name.
        const marks = ffi.call('FPDFPageObj_CountMarks', obj);
        for (let mi = 0; mi < marks; mi++) {
          const mark = ffi.call('FPDFPageObj_GetMark', obj, mi);
          if (mark === 0) continue;
          const name = ffi.utf16Call((buf, len) => {
            ffi.call('FPDFPageObjMark_GetName', mark, buf, len, u);
            return ffi.u32(u);
          });
          if (name === 'OC') {
            const ocName = ffi.utf16Call((buf, len) => {
              ffi.call('FPDFPageObjMark_GetParamStringValue', mark, ocKey, buf, len, u);
              return ffi.u32(u);
            });
            if (ocName) layerNames.push({ index: i, name: ocName });
          }
        }
        out.push({
          index: i,
          kind,
          rect,
          matrix,
          ...extra,
          ...optional('fillColor', fill?.color),
          ...optional('fillAlpha', fill?.alpha),
          ...optional('strokeColor', stroke?.color),
          ...optional('strokeAlpha', stroke?.alpha),
          ...optional('strokeWidth', strokeWidth),
        });
      }
    });
    if (layerNames.length > 0) {
      const raw = await this.rawInfo(d);
      for (const { index, name } of layerNames) {
        const id = raw.layerIdByName.get(name);
        const obj = out[index];
        if (id && obj) out[index] = { ...obj, layerId: id };
      }
    }
    return out;
  }

  /**
   * The outlines of a page's paths, in page space (M33, ADR 0018).
   *
   * PDFium reports a path as a list of segments in the object's own space, so every point goes
   * through the object's matrix; a Bézier arrives as three consecutive `BEZIERTO` segments —
   * two controls and an end point — and is subdivided here. Form objects are walked one level,
   * with the child's matrix composed on to the parent's, because a stamped logo's outline is
   * exactly what a reader wants to snap to.
   *
   * Returns an empty list rather than throwing when the wasm build lacks the path exports: the
   * method is optional on `PdfEngine` and every caller has a fallback.
   */
  pageObjectPaths(doc: DocHandle, page: PageIndex): Promise<ReadonlyArray<PageObjectPath>> {
    const ffi = this.ffi;
    const needed = [
      'FPDFPath_CountSegments',
      'FPDFPath_GetPathSegment',
      'FPDFPathSegment_GetPoint',
      'FPDFPathSegment_GetType',
      'FPDFPathSegment_GetClose',
    ];
    if (!needed.every((name) => ffi.has(name))) return Promise.resolve([]);
    const d = this.doc(doc);
    const p = this.loadPage(d, page);
    const out: PageObjectPath[] = [];
    ffi.scope((s) => {
      const f = s.alloc(4 * 6);
      const pt = s.alloc(4 * 2);
      /*
       * A budget rather than a depth limit. How deeply a page nests its form XObjects is not
       * something a reader chose — a placed drawing inside a stamp inside an imported page is
       * three deep and perfectly ordinary — so a depth cut-off silently loses outlines for no
       * reason the reader can see. What actually has to be bounded is the *work*: this is called
       * on the first pointer move over a page, and a malformed file can nest for ever. So every
       * object visited costs one, the walk stops when the budget is spent, and the depth guard is
       * only there to catch a form that contains itself.
       */
      let budget = MAX_PATH_OBJECTS;
      const walk = (obj: number, matrix: PdfMatrix, index: number, depth: number): void => {
        if (budget <= 0 || depth > MAX_FORM_DEPTH) return;
        budget--;
        const type = ffi.call('FPDFPageObj_GetType', obj);
        const own = ffi.call('FPDFPageObj_GetMatrix', obj, f)
          ? composeMatrix(matrix, readMatrix(ffi, f))
          : matrix;
        if (type === PAGEOBJ.PATH) {
          const subpaths = readSubpaths(ffi, obj, own, pt);
          if (subpaths.length > 0) out.push({ index, subpaths });
          return;
        }
        if (type === PAGEOBJ.FORM) {
          const children = ffi.call('FPDFFormObj_CountObjects', obj);
          for (let c = 0; c < children && budget > 0; c++) {
            const child = ffi.call('FPDFFormObj_GetObject', obj, c);
            if (child !== 0) walk(child, own, index, depth + 1);
          }
        }
      };
      const n = ffi.call('FPDFPage_CountObjects', p.page);
      for (let i = 0; i < n; i++) {
        const obj = ffi.call('FPDFPage_GetObject', p.page, i);
        if (obj !== 0) walk(obj, IDENTITY_MATRIX, i, 0);
      }
    });
    return Promise.resolve(out);
  }

  async annotations(doc: DocHandle, page: PageIndex): Promise<ReadonlyArray<Annotation>> {
    const { annotations, missingColors } = this.annotationsSync(doc, page);
    if (missingColors.length === 0) return annotations;
    // PDFium generated appearance streams for these, hiding /C and /IC, and it has no getter at
    // all for the number arrays a callout and a free text carry: read them raw.
    const raw = await this.rawInfo(this.doc(doc));
    const colors = raw.annotationColors(page);
    const out = [...annotations];
    for (const index of missingColors) {
      const a = out[index];
      const c = colors[index];
      if (a && c) {
        const extra: Record<string, unknown> = { ...a.extra };
        if (c.callout) extra['callout'] = c.callout;
        if (c.padding) extra['padding'] = c.padding;
        if (c.align !== undefined) extra['align'] = c.align;
        if (c.rotate !== undefined) extra['rotate'] = c.rotate;
        // The shape family's entries PDFium has no getter for (M31, ADR 0016).
        if (c.lineEndings) extra['lineEndings'] = c.lineEndings;
        if (c.cloudy !== undefined) extra['cloudy'] = c.cloudy;
        if (c.dashArray) extra['dashArray'] = c.dashArray;
        // A measurement's scale and its dimension line (M33, ADR 0018).
        if (c.measure) extra['measure'] = c.measure;
        if (c.leaderLength !== undefined) extra['leaderLength'] = c.leaderLength;
        if (c.leaderExtend !== undefined) extra['leaderExtend'] = c.leaderExtend;
        if (c.leaderOffset !== undefined) extra['leaderOffset'] = c.leaderOffset;
        if (c.caption !== undefined) extra['caption'] = c.caption;
        if (c.captionPosition !== undefined) extra['captionPosition'] = c.captionPosition;
        if (c.captionOffset) extra['captionOffset'] = c.captionOffset;
        out[index] = {
          ...a,
          ...optional('color', a.color ?? c.color),
          ...optional('interiorColor', a.interiorColor ?? c.interiorColor),
          ...optional('borderWidth', a.borderWidth ?? c.borderWidth),
          ...(Object.keys(extra).length > 0 ? { extra } : {}),
        };
      }
    }
    return out;
  }

  /** Synchronous annotation read; `missingColors` lists indexes whose colour needs the raw pass. */
  annotationsSync(
    doc: DocHandle,
    page: PageIndex,
  ): { annotations: Annotation[]; missingColors: number[] } {
    const d = this.doc(doc);
    const p = this.loadPage(d, page);
    const ffi = this.ffi;
    const count = ffi.call('FPDFPage_GetAnnotCount', p.page);
    const out: Annotation[] = [];
    const missingColors: number[] = [];
    ffi.scope((s) => {
      const f = s.alloc(4 * 8);
      const u = s.alloc(4 * 4);
      const keys = new Map<string, number>();
      const key = (k: string): number => {
        let ptr = keys.get(k);
        if (ptr === undefined) {
          ptr = s.utf8(k);
          keys.set(k, ptr);
        }
        return ptr;
      };
      for (let i = 0; i < count; i++) {
        const annot = ffi.call('FPDFPage_GetAnnot', p.page, i);
        if (annot === 0) continue;
        try {
          const subtypeName = ANNOT_SUBTYPES[ffi.call('FPDFAnnot_GetSubtype', annot)] ?? 'Unknown';
          const subtype: AnnotationSubtype =
            subtypeName === 'RichMedia' || subtypeName === 'XFAWidget' ? 'Unknown' : subtypeName;
          ffi.call('FPDFAnnot_GetRect', annot, f);
          const r = readRectF(ffi, f);
          const rect = normalizeRect({ x0: r.left, y0: r.bottom, x1: r.right, y1: r.top });
          const flagBits = ffi.call('FPDFAnnot_GetFlags', annot);
          const flags: AnnotationFlags = {
            hidden: (flagBits & ANNOT_FLAG.HIDDEN) !== 0,
            print: (flagBits & ANNOT_FLAG.PRINT) !== 0,
            noView: (flagBits & ANNOT_FLAG.NOVIEW) !== 0,
            readOnly: (flagBits & ANNOT_FLAG.READONLY) !== 0,
            locked: (flagBits & ANNOT_FLAG.LOCKED) !== 0,
          };
          const str = (k: string): string | undefined => {
            if (!ffi.call('FPDFAnnot_HasKey', annot, key(k))) return undefined;
            const v = ffi.utf16Call((buf, len) =>
              ffi.call('FPDFAnnot_GetStringValue', annot, key(k), buf, len),
            );
            return v === '' ? undefined : v;
          };
          const hasAP = ffi.call('FPDFAnnot_HasKey', annot, key('AP')) !== 0;
          const annotColor = (type: number): number | undefined =>
            ffi.call('FPDFAnnot_GetColor', annot, type, u, u + 4, u + 8, u + 12)
              ? packRgb(ffi.u32(u, 0), ffi.u32(u, 1), ffi.u32(u, 2))
              : undefined;
          const opacity = ffi.call('FPDFAnnot_GetNumberValue', annot, key('CA'), f)
            ? ffi.f32(f)
            : undefined;
          const borderWidth = ffi.call('FPDFAnnot_GetBorder', annot, f, f + 4, f + 8)
            ? ffi.f32(f, 2)
            : undefined;
          let quadPoints: number[] | undefined;
          if (ffi.call('FPDFAnnot_HasAttachmentPoints', annot)) {
            const q = ffi.call('FPDFAnnot_CountAttachmentPoints', annot);
            quadPoints = [];
            for (let qi = 0; qi < q; qi++) {
              if (ffi.call('FPDFAnnot_GetAttachmentPoints', annot, qi, f)) {
                for (let k = 0; k < 8; k++) quadPoints.push(ffi.f32(f, k));
              }
            }
          }
          const readPoints = (
            count2: number,
            fn: (buf: number, len: number) => number,
          ): PdfPoint[] =>
            ffi.scope((s2) => {
              const buf = s2.alloc(count2 * 8);
              const got = fn(buf, count2);
              const arr: PdfPoint[] = [];
              for (let j = 0; j < got; j++)
                arr.push({ x: ffi.f32(buf, j * 2), y: ffi.f32(buf, j * 2 + 1) });
              return arr;
            });
          let paths: PdfPoint[][] | undefined;
          const inkCount = ffi.call('FPDFAnnot_GetInkListCount', annot);
          if (inkCount > 0) {
            paths = [];
            for (let k = 0; k < inkCount; k++) {
              const pts = ffi.call('FPDFAnnot_GetInkListPath', annot, k, 0, 0);
              if (pts > 0) {
                paths.push(
                  readPoints(pts, (buf, len) =>
                    ffi.call('FPDFAnnot_GetInkListPath', annot, k, buf, len),
                  ),
                );
              }
            }
          } else if (subtype === 'Polygon' || subtype === 'PolyLine') {
            const pts = ffi.call('FPDFAnnot_GetVertices', annot, 0, 0);
            if (pts > 0)
              paths = [
                readPoints(pts, (buf, len) => ffi.call('FPDFAnnot_GetVertices', annot, buf, len)),
              ];
          } else if (subtype === 'Line') {
            if (ffi.call('FPDFAnnot_GetLine', annot, f, f + 8)) {
              paths = [
                [
                  { x: ffi.f32(f, 0), y: ffi.f32(f, 1) },
                  { x: ffi.f32(f, 2), y: ffi.f32(f, 3) },
                ],
              ];
            }
          }
          let inReplyTo: string | undefined;
          const linked = ffi.call('FPDFAnnot_GetLinkedAnnot', annot, key('IRT'));
          if (linked !== 0) {
            const idx = ffi.call('FPDFPage_GetAnnotIndex', p.page, linked);
            if (idx >= 0) inReplyTo = `a${page}.${idx}`;
            ffi.call('FPDFPage_CloseAnnot', linked);
          }
          const extra: Record<string, unknown> = {};
          const popup = ffi.call('FPDFAnnot_GetLinkedAnnot', annot, key('Popup'));
          if (popup !== 0) {
            const idx = ffi.call('FPDFPage_GetAnnotIndex', p.page, popup);
            if (idx >= 0) extra['popup'] = `a${page}.${idx}`;
            ffi.call('FPDFPage_CloseAnnot', popup);
          }
          if (subtype === 'Widget' && d.form !== 0) {
            extra['fieldName'] = ffi.utf16Call((buf, len) =>
              ffi.call('FPDFAnnot_GetFormFieldName', d.form, annot, buf, len),
            );
            extra['fieldType'] = this.fieldType(
              ffi.call('FPDFAnnot_GetFormFieldType', d.form, annot),
            );
          }
          const stateModel = str('StateModel');
          if (stateModel) extra['stateModel'] = stateModel;
          const richText = str('RC');
          if (richText) extra['richContents'] = richText;
          const iconName = str('Name');
          if (
            iconName &&
            (subtype === 'Text' || subtype === 'Stamp' || subtype === 'FileAttachment')
          ) {
            extra['icon'] = iconName;
          }
          // Free text carries how it is drawn in strings of its own, and what kind of free text
          // it is in `/IT` (M30). Read for every subtype that can have them, not just FreeText:
          // `/DA` also appears on widgets, and `/IT` on the shape family.
          for (const [modelKey, pdfKey] of [
            ['defaultAppearance', 'DA'],
            ['intent', 'IT'],
            ['defaultStyle', 'DS'],
            ['lineEnding', 'LE'],
            // `/RT` says what an `/IRT` means: `/R` a reply, `/Group` a grouped annotation (M32).
            ['replyType', 'RT'],
          ] as const) {
            const value = str(pdfKey);
            if (value) extra[modelKey] = value;
          }
          /*
           * Whether the file already carries an appearance stream. M30's annotation layer needs
           * it: an annotation PDFium has drawn is already in the tile raster, and one it has not
           * has to be drawn by the overlay instead — draw both and it appears twice.
           */
          extra['hasAP'] = hasAP;
          const c = annotColor(ANNOT_COLORTYPE.COLOR);
          const ic = annotColor(ANNOT_COLORTYPE.INTERIOR);
          // PDFium hides /C and /IC behind an appearance stream and ignores /BS /W: raw pass.
          // A free text or a caret goes through it whatever its colours say, because `/CL`,
          // `/RD`, `/Q` and `/Rotate` have no PDFium getter at all (M30) — and so do the shapes,
          // the ink and the stamps, for `/LE`, `/BE`, `/BS /D` and `/Rotate` (M31).
          if (
            (hasAP && c === undefined && ic === undefined) ||
            borderWidth === undefined ||
            subtype === 'FreeText' ||
            subtype === 'Caret' ||
            RAW_PASS_SUBTYPES.has(subtype)
          ) {
            missingColors.push(out.length);
          }
          out.push({
            id: `a${page}.${i}`,
            page,
            subtype,
            rect,
            flags,
            ...optional('contents', str('Contents')),
            ...optional('author', str('T')),
            ...optional('modified', pdfDateToIso(str('M'))),
            ...optional('created', pdfDateToIso(str('CreationDate'))),
            ...optional('color', c),
            ...optional('interiorColor', ic),
            ...optional('opacity', opacity),
            ...optional('quadPoints', quadPoints && quadPoints.length > 0 ? quadPoints : undefined),
            ...optional('paths', paths),
            ...optional('borderWidth', borderWidth),
            ...optional('inReplyTo', inReplyTo),
            ...optional('state', str('State')),
            ...optional('appearanceState', str('AS')),
            ...optional('name', str('NM')),
            ...optional('subject', str('Subj')),
            ...(Object.keys(extra).length > 0 ? { extra } : {}),
          });
        } finally {
          ffi.call('FPDFPage_CloseAnnot', annot);
        }
      }
    });
    return { annotations: out, missingColors };
  }

  private fieldType(t: number): FormFieldType {
    switch (t) {
      case FORMFIELD.PUSHBUTTON:
        return 'button';
      case FORMFIELD.CHECKBOX:
        return 'checkbox';
      case FORMFIELD.RADIOBUTTON:
        return 'radio';
      case FORMFIELD.COMBOBOX:
        return 'combobox';
      case FORMFIELD.LISTBOX:
        return 'listbox';
      case FORMFIELD.TEXTFIELD:
        return 'text';
      case FORMFIELD.SIGNATURE:
        return 'signature';
      default:
        return 'unknown';
    }
  }

  formFields(doc: DocHandle): Promise<ReadonlyArray<FormField>> {
    return run(() => {
      const d = this.doc(doc);
      const ffi = this.ffi;
      const fields = new Map<
        string,
        { field: FormField; widgets: Array<{ page: PageIndex; rect: PdfRect }> }
      >();
      if (d.form === 0) return [];
      const pages = ffi.call('FPDF_GetPageCount', d.doc);
      ffi.scope((s) => {
        const f = s.alloc(16);
        for (let pi = 0; pi < pages; pi++) {
          const p = this.loadPage(d, pi);
          const count = ffi.call('FPDFPage_GetAnnotCount', p.page);
          for (let ai = 0; ai < count; ai++) {
            const annot = ffi.call('FPDFPage_GetAnnot', p.page, ai);
            if (annot === 0) continue;
            try {
              if (ANNOT_SUBTYPES[ffi.call('FPDFAnnot_GetSubtype', annot)] !== 'Widget') continue;
              const name = ffi.utf16Call((buf, len) =>
                ffi.call('FPDFAnnot_GetFormFieldName', d.form, annot, buf, len),
              );
              if (!name) continue;
              ffi.call('FPDFAnnot_GetRect', annot, f);
              const r = readRectF(ffi, f);
              const rect = normalizeRect({ x0: r.left, y0: r.bottom, x1: r.right, y1: r.top });
              const existing = fields.get(name);
              if (existing) {
                existing.widgets.push({ page: pi, rect });
                continue;
              }
              const type = this.fieldType(ffi.call('FPDFAnnot_GetFormFieldType', d.form, annot));
              const flagBits = ffi.call('FPDFAnnot_GetFormFieldFlags', d.form, annot);
              let value = ffi.utf16Call((buf, len) =>
                ffi.call('FPDFAnnot_GetFormFieldValue', d.form, annot, buf, len),
              );
              if ((type === 'checkbox' || type === 'radio') && value === '') {
                const exportValue = ffi.utf16Call((buf, len) =>
                  ffi.call('FPDFAnnot_GetFormFieldExportValue', d.form, annot, buf, len),
                );
                value = ffi.call('FPDFAnnot_IsChecked', d.form, annot)
                  ? exportValue || 'Yes'
                  : 'Off';
              }
              const tooltip = ffi.utf16Call((buf, len) =>
                ffi.call('FPDFAnnot_GetFormFieldAlternateName', d.form, annot, buf, len),
              );
              let options: Array<{ value: string; label: string }> | undefined;
              if (type === 'combobox' || type === 'listbox') {
                const n = ffi.call('FPDFAnnot_GetOptionCount', d.form, annot);
                options = [];
                for (let oi = 0; oi < n; oi++) {
                  const label = ffi.utf16Call((buf, len) =>
                    ffi.call('FPDFAnnot_GetOptionLabel', d.form, annot, oi, buf, len),
                  );
                  options.push({ value: label, label });
                }
              }
              const widgets: Array<{ page: PageIndex; rect: PdfRect }> = [{ page: pi, rect }];
              fields.set(name, {
                widgets,
                field: {
                  name,
                  type,
                  value,
                  readOnly: (flagBits & FIELDFLAG.READONLY) !== 0,
                  required: (flagBits & FIELDFLAG.REQUIRED) !== 0,
                  ...optional('options', options),
                  widgets,
                  ...optional('tooltip', tooltip || undefined),
                },
              });
            } finally {
              ffi.call('FPDFPage_CloseAnnot', annot);
            }
          }
        }
      });
      return [...fields.values()].map((e) => e.field);
    });
  }

  links(doc: DocHandle, page: PageIndex): Promise<ReadonlyArray<Link>> {
    return run(() => {
      const d = this.doc(doc);
      const p = this.loadPage(d, page);
      const ffi = this.ffi;
      const out: Link[] = [];
      ffi.scope((s) => {
        const pos = s.alloc(4);
        const linkOut = s.alloc(4);
        const f = s.alloc(4 * 8);
        ffi.setI32(pos, 0);
        while (ffi.call('FPDFLink_Enumerate', p.page, pos, linkOut)) {
          const link = ffi.i32(linkOut);
          if (link === 0) continue;
          ffi.call('FPDFLink_GetAnnotRect', link, f);
          const r = readRectF(ffi, f);
          const rect = normalizeRect({ x0: r.left, y0: r.bottom, x1: r.right, y1: r.top });
          let dest = this.destination(d, ffi.call('FPDFLink_GetDest', d.doc, link));
          let uri: string | undefined;
          if (!dest) {
            const resolved = this.action(d, ffi.call('FPDFLink_GetAction', link));
            dest = resolved.dest;
            uri = resolved.uri;
          }
          const quads = ffi.call('FPDFLink_CountQuadPoints', link);
          let quadPoints: number[] | undefined;
          if (quads > 0) {
            quadPoints = [];
            for (let qi = 0; qi < quads; qi++) {
              if (ffi.call('FPDFLink_GetQuadPoints', link, qi, f)) {
                for (let k = 0; k < 8; k++) quadPoints.push(ffi.f32(f, k));
              }
            }
          }
          let annotationId: string | undefined;
          const annot = ffi.call('FPDFLink_GetAnnot', p.page, link);
          if (annot !== 0) {
            const idx = ffi.call('FPDFPage_GetAnnotIndex', p.page, annot);
            if (idx >= 0) annotationId = `a${page}.${idx}`;
            ffi.call('FPDFPage_CloseAnnot', annot);
          }
          out.push({
            rect,
            ...optional('quadPoints', quadPoints),
            ...optional('dest', dest),
            ...optional('uri', uri),
            ...optional('annotationId', annotationId),
          });
        }
      });
      return out;
    });
  }

  // ---- PdfEngine: mutation (M20, ADR 0007) ------------------------------------------------------

  /**
   * Drops every cached page of a document. Required after any operation that changes the page
   * list: a cached `FPDF_PAGE` for an old index would otherwise be handed out for a different
   * page.
   */
  private invalidatePages(d: OpenDoc): void {
    for (const p of d.pages.values()) this.unloadPage(d, p);
    d.pages.clear();
    d.raw = null;
    d.mutated = true;
  }

  /** Drops one cached page (after an edit that changes what it draws). */
  private invalidatePage(d: OpenDoc, index: PageIndex): void {
    d.raw = null;
    d.mutated = true;
    const p = d.pages.get(index);
    if (!p) return;
    d.pages.delete(index);
    this.unloadPage(d, p);
  }

  /** Finds the widget annotation of a field by its fully qualified name. */
  private findWidget(
    d: OpenDoc,
    fieldName: string,
  ): { page: PageIndex; loaded: LoadedPage; annot: number; type: number } | null {
    const pages = this.ffi.call('FPDF_GetPageCount', d.doc);
    for (let page = 0; page < pages; page++) {
      const loaded = this.loadPage(d, page);
      const count = this.ffi.call('FPDFPage_GetAnnotCount', loaded.page);
      for (let i = 0; i < count; i++) {
        const annot = this.ffi.call('FPDFPage_GetAnnot', loaded.page, i);
        if (annot === 0) continue;
        const name = this.ffi.utf16Call((buf, len) =>
          this.ffi.call('FPDFAnnot_GetFormFieldName', d.form, annot, buf, len),
        );
        if (name === fieldName) {
          const type = this.ffi.call('FPDFAnnot_GetFormFieldType', d.form, annot);
          return { page, loaded, annot, type };
        }
        this.ffi.call('FPDFPage_CloseAnnot', annot);
      }
    }
    return null;
  }

  setPageRotation(doc: DocHandle, page: PageIndex, rotation: Rotation): Promise<void> {
    return run(() => {
      assertRotation(rotation);
      const d = this.doc(doc);
      const p = this.loadPage(d, page);
      this.ffi.call('FPDFPage_SetRotation', p.page, rotation / 90);
      // The displayed size flips for 90/270, so the cached geometry is stale.
      p.geometry = null;
    });
  }

  deletePages(doc: DocHandle, pages: ReadonlyArray<PageIndex>): Promise<void> {
    return run(() => {
      const d = this.doc(doc);
      const count = this.ffi.call('FPDF_GetPageCount', d.doc);
      const unique = [...new Set(pages)].sort((a, b) => b - a);
      for (const index of unique) {
        if (!Number.isInteger(index) || index < 0 || index >= count) {
          throw new EngineError('invalid-page', `page ${index} is out of range (0..${count - 1})`);
        }
      }
      if (unique.length >= count) {
        throw new EngineError('invalid-argument', 'a document must keep at least one page');
      }
      this.invalidatePages(d);
      // Highest index first, so the ones still to come are unaffected.
      for (const index of unique) this.ffi.call('FPDFPage_Delete', d.doc, index);
    });
  }

  insertBlankPages(
    doc: DocHandle,
    at: PageIndex,
    count: number,
    size: { readonly width: number; readonly height: number },
  ): Promise<void> {
    return run(() => {
      const d = this.doc(doc);
      const total = this.ffi.call('FPDF_GetPageCount', d.doc);
      if (!Number.isInteger(at) || at < 0 || at > total) {
        throw new EngineError('invalid-page', `cannot insert at ${at} (0..${total})`);
      }
      if (!Number.isInteger(count) || count < 1) {
        throw new EngineError('invalid-argument', `count must be a positive integer (${count})`);
      }
      if (!(size.width > 0) || !(size.height > 0)) {
        throw new EngineError('invalid-argument', 'page size must be positive');
      }
      this.invalidatePages(d);
      for (let i = 0; i < count; i++) {
        const page = this.ffi.call('FPDFPage_New', d.doc, at + i, size.width, size.height);
        if (page === 0) throw new EngineError('internal', 'PDFium could not create a page');
        this.ffi.call('FPDFPage_GenerateContent', page);
        this.ffi.call('FPDF_ClosePage', page);
      }
    });
  }

  importPages(
    doc: DocHandle,
    source: DocHandle,
    pages: ReadonlyArray<PageIndex>,
    at: PageIndex,
  ): Promise<void> {
    return run(() => {
      const d = this.doc(doc);
      const src = this.doc(source);
      const total = this.ffi.call('FPDF_GetPageCount', d.doc);
      if (!Number.isInteger(at) || at < 0 || at > total) {
        throw new EngineError('invalid-page', `cannot insert at ${at} (0..${total})`);
      }
      this.invalidatePages(d);
      const ok = this.ffi.scope((s) => {
        if (pages.length === 0) {
          return this.ffi.call('FPDF_ImportPagesByIndex', d.doc, src.doc, 0, 0, at);
        }
        const buf = s.alloc(pages.length * 4);
        pages.forEach((p, i) => {
          this.ffi.setI32(buf, p, i);
        });
        return this.ffi.call('FPDF_ImportPagesByIndex', d.doc, src.doc, buf, pages.length, at);
      });
      if (!ok) throw new EngineError('internal', 'PDFium could not import the pages');
    });
  }

  movePage(doc: DocHandle, from: PageIndex, to: PageIndex): Promise<void> {
    return run(() => {
      const d = this.doc(doc);
      const count = this.ffi.call('FPDF_GetPageCount', d.doc);
      for (const [name, index] of [
        ['from', from],
        ['to', to],
      ] as const) {
        if (!Number.isInteger(index) || index < 0 || index >= count) {
          throw new EngineError('invalid-page', `${name} page ${index} is out of range`);
        }
      }
      if (from === to) return;
      this.invalidatePages(d);
      const ok = this.ffi.scope((s) => {
        const buf = s.alloc(4);
        this.ffi.setI32(buf, from, 0);
        return this.ffi.call('FPDF_MovePages', d.doc, buf, 1, to);
      });
      if (!ok) throw new EngineError('internal', `PDFium could not move page ${from} to ${to}`);
    });
  }

  setCropBox(doc: DocHandle, page: PageIndex, box: PdfRect): Promise<void> {
    return run(() => {
      const d = this.doc(doc);
      const p = this.loadPage(d, page);
      const r = normalizeRect(box);
      if (!(r.x1 - r.x0 > 0) || !(r.y1 - r.y0 > 0)) {
        throw new EngineError('invalid-argument', 'a crop box must have a positive area');
      }
      this.ffi.call('FPDFPage_SetCropBox', p.page, r.x0, r.y0, r.x1, r.y1);
      p.geometry = null;
    });
  }

  /**
   * Sets the MediaBox. Not part of the `PdfEngine` contract (M40 may promote it); offered here
   * because `setCropBox` would otherwise be able to crop a page larger than its own paper.
   */
  setMediaBox(doc: DocHandle, page: PageIndex, box: PdfRect): Promise<void> {
    return run(() => {
      const p = this.loadPage(this.doc(doc), page);
      const r = normalizeRect(box);
      this.ffi.call('FPDFPage_SetMediaBox', p.page, r.x0, r.y0, r.x1, r.y1);
      p.geometry = null;
    });
  }

  async addAnnotation(doc: DocHandle, annotation: NewAnnotation): Promise<Annotation> {
    const page = annotation.page;
    const index = await run(() => {
      const d = this.doc(doc);
      const p = this.loadPage(d, page);
      const subtype = subtypeValue(annotation.subtype);
      if (subtype === 0) {
        throw new EngineError('invalid-argument', `cannot create a ${annotation.subtype}`);
      }
      const annot = this.ffi.call('FPDFPage_CreateAnnot', p.page, subtype);
      if (annot === 0) {
        /*
         * PDFium creates only the ten subtypes its `IsValidAnnotSubtype` allows — Circle,
         * Highlight, Ink, Popup, Square, Squiggly, Stamp, StrikeOut, Text and Underline. FreeText,
         * Caret, Line, Polygon and PolyLine are refused outright. That is a limit of the backend,
         * not a failure, so it is reported as one: the caller records a write intent and M21's
         * writer adds the annotation to the file itself (M30, ADR 0013).
         */
        throw new EngineError(
          'not-implemented',
          `PDFium cannot create a ${annotation.subtype} annotation`,
        );
      }
      let at: number;
      try {
        writeAnnotation(this.ffi, annot, annotation);
        this.installOwnAppearance(annot, annotation.subtype, annotation);
        at = this.ffi.call('FPDFPage_GetAnnotIndex', p.page, annot);
      } finally {
        this.ffi.call('FPDFPage_CloseAnnot', annot);
      }
      this.ffi.call('FPDFPage_GenerateContent', p.page);
      // Reload so PDFium builds the appearance stream for the new annotation.
      this.invalidatePage(d, page);
      return at;
    });
    // Read through the async path, so the raw-catalogue fallback fills in the colours PDFium
    // hides once it has generated an appearance stream.
    const created = (await this.annotations(doc, page))[index];
    if (!created) throw new EngineError('internal', 'the new annotation could not be read back');
    return created;
  }

  async updateAnnotation(
    doc: DocHandle,
    id: string,
    patch: Partial<Omit<Annotation, 'id' | 'page'>>,
  ): Promise<Annotation> {
    const { page, index } = parseAnnotationId(id);
    await run(() => {
      const d = this.doc(doc);
      const p = this.loadPage(d, page);
      const annot = this.ffi.call('FPDFPage_GetAnnot', p.page, index);
      if (annot === 0) throw new EngineError('invalid-argument', `no annotation ${id}`);
      try {
        // A stamp's or an attachment's appearance is its content: a move keeps it (M31).
        const subtype = ANNOT_SUBTYPES[this.ffi.call('FPDFAnnot_GetSubtype', annot)] ?? 'Unknown';
        const keepAppearance = APPEARANCE_IS_CONTENT.has(subtype) && !patchIsVisual(patch);
        writeAnnotation(this.ffi, annot, patch, { keepAppearance });
        if (subtype !== 'Unknown' && subtype !== 'RichMedia' && subtype !== 'XFAWidget') {
          this.installOwnAppearance(annot, subtype, patch);
        }
      } finally {
        this.ffi.call('FPDFPage_CloseAnnot', annot);
      }
      this.ffi.call('FPDFPage_GenerateContent', p.page);
      this.invalidatePage(d, page);
    });
    const updated = (await this.annotations(doc, page))[index];
    if (!updated) throw new EngineError('internal', `annotation ${id} vanished after the update`);
    return updated;
  }

  /**
   * Gives a Square, a Circle or an Ink the app's own appearance the moment it is written, before
   * the page reloads (M31, ADR 0016).
   *
   * PDFium would otherwise build one itself as the page loads — and, for an Ink, *inflate* `/Rect`
   * by half the border width while it is at it, once per regeneration. The model never learns of
   * that, so after a few edits the engine's rect and the model's disagree and M21's writer, which
   * checks the two before it writes, refuses to touch the annotation. Installing ours first means
   * PDFium finds an `/AP` and generates nothing: the rect stays what the model said, and the live
   * page shows the cloud, the dash and the smoothed stroke rather than PDFium's plainer drawing.
   * Pure vector, so the resource-less stream `FPDFAnnot_SetAP` writes is enough (ADR 0013).
   */
  private installOwnAppearance(
    annot: number,
    subtype: AnnotationSubtype,
    data: Partial<Omit<Annotation, 'id' | 'page'>>,
  ): void {
    if (!OWN_APPEARANCE_SUBTYPES.has(subtype) || !data.rect) return;
    const stream = defaultAppearanceService.generate(
      appearanceInput({
        subtype,
        rect: data.rect,
        color: data.color ?? null,
        interiorColor: data.interiorColor ?? null,
        opacity: null,
        borderWidth: data.borderWidth ?? null,
        paths: data.paths ?? [],
        vertices: [],
        extra: data.extra ?? {},
      }),
    );
    if (stream) setAppearanceStream(this.ffi, annot, stream.content);
  }

  /**
   * Pushes an appearance stream onto an annotation, or drops it (M30, ADR 0013). The page is
   * reloaded afterwards so the next render draws it; `FPDFPage_GenerateContent` is not called,
   * because the annotation list is not part of the page's content stream.
   */
  setAnnotationAppearance(doc: DocHandle, id: string, content: string | null): Promise<void> {
    return run(() => {
      const d = this.doc(doc);
      const { page, index } = parseAnnotationId(id);
      const p = this.loadPage(d, page);
      const annot = this.ffi.call('FPDFPage_GetAnnot', p.page, index);
      if (annot === 0) throw new EngineError('invalid-argument', `no annotation ${id}`);
      try {
        if (content === null) dropAppearance(this.ffi, annot);
        else setAppearanceStream(this.ffi, annot, content);
      } finally {
        this.ffi.call('FPDFPage_CloseAnnot', annot);
      }
      this.invalidatePage(d, page);
    });
  }

  deleteAnnotation(doc: DocHandle, id: string): Promise<void> {
    return run(() => {
      const d = this.doc(doc);
      const { page, index } = parseAnnotationId(id);
      const p = this.loadPage(d, page);
      const count = this.ffi.call('FPDFPage_GetAnnotCount', p.page);
      if (index < 0 || index >= count) {
        throw new EngineError('invalid-argument', `no annotation ${id}`);
      }
      if (!this.ffi.call('FPDFPage_RemoveAnnot', p.page, index)) {
        throw new EngineError('internal', `PDFium could not remove annotation ${id}`);
      }
      this.ffi.call('FPDFPage_GenerateContent', p.page);
      this.invalidatePage(d, page);
    });
  }

  /**
   * Sets a field's value **through the form-fill environment**, the way a user would.
   *
   * Writing `/V` onto the widget annotation looks simpler and does not work: in a hierarchical
   * form the widget is a kid whose `/Parent` holds `/T` and `/V`, and PDFium's annotation API
   * cannot reach the parent — the write lands on the wrong dictionary and every reader still
   * sees the old value. Driving `FORM_*` instead lets PDFium update the field it owns and
   * regenerate the widget's appearance, so `formFields()` and the next render both agree.
   */
  setFieldValue(doc: DocHandle, fieldName: string, value: string): Promise<void> {
    return run(() => {
      const d = this.doc(doc);
      if (d.form === 0) throw new EngineError('invalid-argument', 'the document has no form');
      const found = this.findWidget(d, fieldName);
      if (!found) throw new EngineError('invalid-argument', `no field named ${fieldName}`);
      const { loaded, annot, type } = found;
      try {
        this.ffi.call('FORM_SetFocusedAnnot', d.form, annot);
        switch (type) {
          case FORMFIELD.TEXTFIELD:
            this.replaceText(d, loaded.page, value);
            break;
          case FORMFIELD.COMBOBOX:
          case FORMFIELD.LISTBOX: {
            const index = this.optionIndex(d, annot, value);
            if (index >= 0) {
              this.ffi.call('FORM_SetIndexSelected', d.form, loaded.page, index, 1);
            } else if (type === FORMFIELD.COMBOBOX) {
              // An editable combo box accepts free text; a list box does not.
              this.replaceText(d, loaded.page, value);
            } else {
              throw new EngineError('invalid-argument', `${fieldName} has no option "${value}"`);
            }
            break;
          }
          case FORMFIELD.CHECKBOX:
          case FORMFIELD.RADIOBUTTON: {
            const wanted = value !== '' && value !== 'Off';
            const checked = this.ffi.call('FPDFAnnot_IsChecked', d.form, annot) !== 0;
            if (wanted !== checked) this.clickWidget(d, loaded.page, annot);
            break;
          }
          default:
            throw new EngineError(
              'invalid-argument',
              `${fieldName} is a ${this.fieldType(type)} field and has no value to set`,
            );
        }
        this.ffi.call('FORM_ForceToKillFocus', d.form);
      } finally {
        this.ffi.call('FPDFPage_CloseAnnot', annot);
      }
      d.mutated = true;
      d.raw = null;
    });
  }

  /** Selects everything in the focused text control and types `value` over it. */
  private replaceText(d: OpenDoc, page: number, value: string): void {
    this.ffi.call('FORM_SelectAllText', d.form, page);
    this.ffi.scope((s) => {
      this.ffi.call('FORM_ReplaceSelection', d.form, page, s.utf16(value));
    });
  }

  /** The index of a choice option whose label is `value`, or -1. */
  private optionIndex(d: OpenDoc, annot: number, value: string): number {
    const n = this.ffi.call('FPDFAnnot_GetOptionCount', d.form, annot);
    for (let i = 0; i < n; i++) {
      const label = this.ffi.utf16Call((buf, len) =>
        this.ffi.call('FPDFAnnot_GetOptionLabel', d.form, annot, i, buf, len),
      );
      if (label === value) return i;
    }
    return -1;
  }

  /** Clicks the centre of a widget, which is how a check box or radio button is toggled. */
  private clickWidget(d: OpenDoc, page: number, annot: number): void {
    this.ffi.scope((s) => {
      const f = s.alloc(16);
      this.ffi.call('FPDFAnnot_GetRect', annot, f);
      const r = readRectF(this.ffi, f);
      const x = (r.left + r.right) / 2;
      const y = (r.top + r.bottom) / 2;
      this.ffi.call('FORM_OnLButtonDown', d.form, page, 0, x, y);
      this.ffi.call('FORM_OnLButtonUp', d.form, page, 0, x, y);
    });
  }

  /**
   * Not available: PDFium exposes no setter for the document information dictionary. M21's
   * writer applies the model's metadata when it serialises (the `metadata` write intent).
   */
  setMetadata(..._args: unknown[]): Promise<void> {
    return Promise.reject(new NotImplementedError('setMetadata'));
  }

  /**
   * Shows or hides an optional-content group (M12, ADR 0011).
   *
   * PDFium has no OCG API, so visibility is applied by deactivating every page object marked
   * with the group - see `applyLayerVisibility`. The set of hidden groups is kept on the open
   * document and re-applied whenever a page is loaded, because the activity flag lives on the
   * loaded page rather than in the file. `FPDFPage_GenerateContent` is never called, so the
   * bytes are untouched and undo is exact; writing the visibility into a saved file is M21's
   * job, through the `layers` write intent.
   */
  async setLayerVisible(doc: DocHandle, layerId: string, visible: boolean): Promise<void> {
    const d = this.doc(doc);
    const raw = await this.rawInfo(d);
    const layer = raw.layers.find((l) => l.id === layerId);
    if (!layer) throw new EngineError('invalid-argument', `no layer ${layerId}`);
    // Groups are matched by name, which is what the marked content carries: two groups sharing a
    // name are indistinguishable to a content stream, and are treated as one.
    if (visible) d.hiddenLayerNames.delete(layer.name);
    else d.hiddenLayerNames.add(layer.name);
    for (const p of d.pages.values()) applyLayerVisibility(this.ffi, p.page, d.hiddenLayerNames);
  }

  // ---- PdfEngine: signatures and named destinations (ADR 0007) ----------------------------------

  signatures(doc: DocHandle): Promise<ReadonlyArray<SignatureSummary>> {
    return run(() => {
      const d = this.doc(doc);
      const ffi = this.ffi;
      const count = ffi.call('FPDF_GetSignatureCount', d.doc);
      const out: SignatureSummary[] = [];
      for (let i = 0; i < count; i++) {
        const sig = ffi.call('FPDF_GetSignatureObject', d.doc, i);
        if (sig === 0) continue;
        const reason = ffi.utf16Call((buf, len) =>
          ffi.call('FPDFSignatureObj_GetReason', sig, buf, len),
        );
        const subFilter = ffi.utf8Call((buf, len) =>
          ffi.call('FPDFSignatureObj_GetSubFilter', sig, buf, len),
        );
        const time = ffi.utf8Call((buf, len) =>
          ffi.call('FPDFSignatureObj_GetTime', sig, buf, len),
        );
        const permission = ffi.call('FPDFSignatureObj_GetDocMDPPermission', sig);
        out.push({
          byteRange: readByteRange(ffi, sig),
          ...optional('reason', reason === '' ? undefined : reason),
          ...optional('subFilter', subFilter === '' ? undefined : subFilter),
          ...optional('time', pdfDateToIso(time)),
          ...optional('docMdpPermission', permission > 0 ? permission : undefined),
        });
      }
      return out;
    });
  }

  namedDestinations(doc: DocHandle): Promise<ReadonlyArray<NamedDestination>> {
    return run(() => {
      const d = this.doc(doc);
      const ffi = this.ffi;
      const count = ffi.call('FPDF_CountNamedDests', d.doc);
      const out: NamedDestination[] = [];
      for (let i = 0; i < count; i++) {
        ffi.scope((s) => {
          // FPDF_GetNamedDest(doc, index, buffer, long* buflen): call twice, as everywhere else.
          const lenPtr = s.alloc(4);
          ffi.setI32(lenPtr, 0);
          if (ffi.call('FPDF_GetNamedDest', d.doc, i, 0, lenPtr) === 0) return;
          const needed = ffi.i32(lenPtr);
          if (needed <= 0) return;
          const buf = s.alloc(needed);
          ffi.setI32(lenPtr, needed);
          const dest = ffi.call('FPDF_GetNamedDest', d.doc, i, buf, lenPtr);
          if (dest === 0) return;
          const name = ffi.readUtf16(buf, ffi.i32(lenPtr));
          const target = this.destination(d, dest);
          if (name !== '' && target) out.push({ name, dest: target });
        });
      }
      return out;
    });
  }

  /**
   * The fonts the page resources name (M72, ADR 0017).
   *
   * Read from the `/Font` dictionaries rather than through PDFium's text API, which can only
   * report the font of a glyph that was actually drawn — a font declared and never used would be
   * missing, and a Fonts tab that omits fonts is worse than none.
   */
  async fonts(doc: DocHandle): Promise<ReadonlyArray<FontUsage>> {
    return (await this.rawInfo(this.doc(doc))).fonts;
  }

  /** How the file asks to be opened (M72, ADR 0017). PDFium exposes none of these entries. */
  async initialView(doc: DocHandle): Promise<InitialView> {
    return (await this.rawInfo(this.doc(doc))).initialView;
  }

  save(
    doc: DocHandle,
    options: SaveOptions = {},
    progress?: ProgressCallback,
  ): Promise<Uint8Array> {
    return run(() => {
      const d = this.doc(doc);
      progress?.(0);
      const flags = options.removeSecurity
        ? SAVE.REMOVE_SECURITY
        : options.incremental
          ? SAVE.INCREMENTAL
          : 0;
      const bytes = this.saveCopy(d, flags);
      progress?.(1);
      return bytes;
    });
  }

  // ---- page objects (M50, ADR 0018) ------------------------------------------------------------

  async pageContent(doc: DocHandle, page: PageIndex): Promise<PageContent> {
    const d = this.doc(doc);
    const count = this.ffi.call('FPDF_GetPageCount', d.doc);
    if (!Number.isInteger(page) || page < 0 || page >= count) {
      throw new EngineError('invalid-page', `page ${page} is out of range (0..${count - 1})`);
    }
    // The bytes as opened are only right while nothing has changed; an encrypted file has to be
    // copied without its security or pdf-lib cannot decode the streams (as `rawInfo` does).
    const bytes =
      d.mutated || d.encrypted ? this.saveCopy(d, d.encrypted ? SAVE.REMOVE_SECURITY : 0) : d.bytes;
    const content = await readPageContent(bytes, page);
    if (!content) throw new EngineError('invalid-page', `page ${page} has no content stream`);
    return content;
  }

  transformObject(doc: DocHandle, page: PageIndex, index: number, delta: PdfMatrix): Promise<void> {
    return run(() => {
      const d = this.doc(doc);
      const p = this.beforeObjectEdit(d, page);
      transformPageObject(this.ffi, p.page, index, delta);
      this.afterObjectEdit(d);
    });
  }

  setObjectMatrix(
    doc: DocHandle,
    page: PageIndex,
    index: number,
    matrix: PdfMatrix,
  ): Promise<void> {
    return run(() => {
      const d = this.doc(doc);
      const p = this.beforeObjectEdit(d, page);
      setPageObjectMatrix(this.ffi, p.page, index, matrix);
      this.afterObjectEdit(d);
    });
  }

  removeObject(doc: DocHandle, page: PageIndex, index: number): Promise<number> {
    return run(() => {
      const d = this.doc(doc);
      const p = this.beforeObjectEdit(d, page);
      const token = removePageObject(this.ffi, p.page, index, d.objectStash);
      this.afterObjectEdit(d);
      return token;
    });
  }

  restoreObject(doc: DocHandle, page: PageIndex, token: number, at: number): Promise<void> {
    return run(() => {
      const d = this.doc(doc);
      const p = this.beforeObjectEdit(d, page);
      restorePageObject(this.ffi, p.page, d.objectStash, token, at);
      this.afterObjectEdit(d);
    });
  }

  insertObject(
    doc: DocHandle,
    page: PageIndex,
    source: { readonly pdf: Uint8Array; readonly matrix: PdfMatrix },
    at?: number,
  ): Promise<number> {
    return run(() => {
      const d = this.doc(doc);
      const p = this.beforeObjectEdit(d, page);
      const index = insertFromPdf(this.ffi, d.doc, p.page, source.pdf, source.matrix, at);
      this.afterObjectEdit(d);
      return index;
    });
  }

  reorderObjects(doc: DocHandle, page: PageIndex, order: ReadonlyArray<number>): Promise<void> {
    return run(() => {
      const d = this.doc(doc);
      const p = this.beforeObjectEdit(d, page);
      reorderPageObjects(this.ffi, p.page, order);
      this.afterObjectEdit(d);
    });
  }

  objectAsPdf(doc: DocHandle, page: PageIndex, index: number): Promise<Uint8Array> {
    return run(() => {
      const d = this.doc(doc);
      const count = this.ffi.call('FPDF_GetPageCount', d.doc);
      if (!Number.isInteger(page) || page < 0 || page >= count) {
        throw new EngineError('invalid-page', `page ${page} is out of range (0..${count - 1})`);
      }
      return objectAsPdfFrom(this.ffi, d.doc, page, index, (ptr) => this.saveDocPtr(ptr, 0));
    });
  }

  setObjectStyle(
    doc: DocHandle,
    page: PageIndex,
    index: number,
    style: ObjectStyle,
  ): Promise<void> {
    return run(() => {
      const d = this.doc(doc);
      const p = this.beforeObjectEdit(d, page);
      setPageObjectStyle(this.ffi, p.page, index, style);
      this.afterObjectEdit(d);
    });
  }

  objectPath(doc: DocHandle, page: PageIndex, index: number): Promise<ObjectPath> {
    return run(() => {
      const d = this.doc(doc);
      const p = this.loadPage(d, page);
      return readObjectPath(this.ffi, p.page, index);
    });
  }

  /**
   * Loads the page for an object edit and drops what the edit will make stale: the text page
   * (which points at the objects about to move) and the handle → index map. The page itself
   * stays loaded — every edit regenerates the content stream, so a later reload sees the same
   * thing.
   */
  private beforeObjectEdit(d: OpenDoc, page: PageIndex): LoadedPage {
    const p = this.loadPage(d, page);
    if (p.textPage !== 0) {
      this.ffi.call('FPDFText_ClosePage', p.textPage);
      p.textPage = 0;
    }
    p.objectIndex = null;
    return p;
  }

  private afterObjectEdit(d: OpenDoc): void {
    d.raw = null;
    d.mutated = true;
  }

  /** `FPDF_SaveAsCopy` through a `FPDF_FILEWRITE` callback (possible thanks to the table patch). */
  private saveCopy(d: OpenDoc, flags: number): Uint8Array {
    return this.saveDocPtr(d.doc, flags);
  }

  /** The same, for a document PDFium holds that is not one of ours (a scratch document). */
  private saveDocPtr(docPtr: number, flags: number): Uint8Array {
    const ffi = this.ffi;
    const chunks: Uint8Array[] = [];
    let total = 0;
    const write = addFunction(
      ffi.m,
      (_self: number, data: number, size: number) => {
        chunks.push(ffi.copyBytes(data, size));
        total += size;
        return 1;
      },
      'iiii',
    );
    const fw = ffi.malloc(8); // FPDF_FILEWRITE { int version; WriteBlock }
    try {
      ffi.setI32(fw, 1, 0);
      ffi.setI32(fw, write, 1);
      const ok = ffi.call('FPDF_SaveAsCopy', docPtr, fw, flags);
      if (!ok) throw new EngineError('internal', 'PDFium could not serialise the document');
    } finally {
      ffi.free(fw);
      removeFunction(ffi.m, write);
    }
    const out = new Uint8Array(total);
    let at = 0;
    for (const c of chunks) {
      out.set(c, at);
      at += c.byteLength;
    }
    return out;
  }
}

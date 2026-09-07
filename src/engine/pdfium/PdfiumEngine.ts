/**
 * `PdfiumEngine` — the `PdfEngine` read implementation on PDFium WASM (M10, ADR 0006).
 *
 * Runs in the engine Worker (`src/engine/worker.ts`) and in Node for unit tests. It owns the
 * wasm module, one form-fill environment per document, a small LRU of loaded pages per
 * document, and the font registry. Everything is synchronous C calls except `render`, which
 * uses PDFium's progressive renderer and yields to the event loop so cancel messages get
 * through (`cancelCurrent()`).
 *
 * Mutation methods are still `NotImplementedError` here — M20+ add them additively — except
 * `save`, which is a plain `FPDF_SaveAsCopy` and costs nothing to offer now.
 */

import type { PageIndex, PageSize, PdfMatrix, PdfPoint, PdfRect, Rotation } from '@shared/pdf';
import { normalizeRect } from '@shared/pdf';
import { PageGeometry } from '../geometry';
import {
  EngineError,
  NotImplementedError,
  type Annotation,
  type AnnotationFlags,
  type AnnotationSubtype,
  type Attachment,
  type Destination,
  type DocHandle,
  type FormField,
  type FormFieldType,
  type Layer,
  type Link,
  type Metadata,
  type OpenOptions,
  type OutlineItem,
  type PageObject,
  type PageObjectKind,
  type PdfEngine,
  type Permissions,
  type ProgressCallback,
  type RenderOptions,
  type RenderResult,
  type SaveOptions,
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
import { FontRegistry, type SubstitutionTable } from './fonts';
import { readRawInfo, type RawInfo } from './rawdoc';
import { addFunction, instantiatePdfium, removeFunction } from './wasm';
import { yieldMacrotask } from '../yield';

/** Version string reported by `info()`; the wasm carries no runtime version API. */
export const PDFIUM_BUILD = '@hyzyla/pdfium 2.1.13 (wasm)';

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

export class PdfiumEngine implements PdfEngine, CancellableEngine {
  private readonly ffi: Ffi;
  private readonly fonts: FontRegistry | null;
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
      this.fonts = new FontRegistry(this.ffi, options.substitutions, options.fonts);
      this.fonts.install();
    } else {
      this.fonts = null;
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
    return this.fonts?.fileCount ?? 0;
  }

  /** Open document handles (diagnostics). */
  get openCount(): number {
    return this.docs.size;
  }

  /** Closes every document and tears PDFium down. The engine is unusable afterwards. */
  destroy(): void {
    if (this.destroyed) return;
    for (const h of [...this.docs.keys()]) this.closeDoc(h);
    this.fonts?.dispose();
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
    });
    return handle;
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

  private rawInfo(d: OpenDoc): Promise<RawInfo> {
    if (!d.raw) {
      let bytes = d.bytes;
      if (d.encrypted) {
        try {
          bytes = this.saveCopy(d, SAVE.REMOVE_SECURITY);
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
        const mime = ffi.has('FPDFAttachment_GetSubtype')
          ? ffi.utf16Call((buf, len) => ffi.call('FPDFAttachment_GetSubtype', att, buf, len))
          : '';
        return {
          id,
          name,
          ...optional('description', str('Desc')),
          ...optional('mimeType', mime === '' ? undefined : mime),
          ...optional('size', size),
          ...optional('modified', pdfDateToIso(str('ModDate'))),
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
      this.rendering = false;
      this.renderCancelled = false;
    }
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

  async annotations(doc: DocHandle, page: PageIndex): Promise<ReadonlyArray<Annotation>> {
    const { annotations, missingColors } = this.annotationsSync(doc, page);
    if (missingColors.length === 0) return annotations;
    // PDFium generated appearance streams for these, hiding /C and /IC: read them raw.
    const raw = await this.rawInfo(this.doc(doc));
    const colors = raw.annotationColors(page);
    const out = [...annotations];
    for (const index of missingColors) {
      const a = out[index];
      const c = colors[index];
      if (a && c) {
        out[index] = {
          ...a,
          ...optional('color', a.color ?? c.color),
          ...optional('interiorColor', a.interiorColor ?? c.interiorColor),
          ...optional('borderWidth', a.borderWidth ?? c.borderWidth),
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
          const c = annotColor(ANNOT_COLORTYPE.COLOR);
          const ic = annotColor(ANNOT_COLORTYPE.INTERIOR);
          // PDFium hides /C and /IC behind an appearance stream and ignores /BS /W: raw pass.
          if ((hasAP && c === undefined && ic === undefined) || borderWidth === undefined) {
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

  // ---- PdfEngine: mutation (M20+) --------------------------------------------------------------

  setPageRotation(): Promise<void> {
    return Promise.reject(new NotImplementedError('setPageRotation'));
  }
  deletePages(): Promise<void> {
    return Promise.reject(new NotImplementedError('deletePages'));
  }
  insertBlankPages(): Promise<void> {
    return Promise.reject(new NotImplementedError('insertBlankPages'));
  }
  importPages(): Promise<void> {
    return Promise.reject(new NotImplementedError('importPages'));
  }
  movePage(): Promise<void> {
    return Promise.reject(new NotImplementedError('movePage'));
  }
  setCropBox(): Promise<void> {
    return Promise.reject(new NotImplementedError('setCropBox'));
  }
  addAnnotation(): Promise<Annotation> {
    return Promise.reject(new NotImplementedError('addAnnotation'));
  }
  updateAnnotation(): Promise<Annotation> {
    return Promise.reject(new NotImplementedError('updateAnnotation'));
  }
  deleteAnnotation(): Promise<void> {
    return Promise.reject(new NotImplementedError('deleteAnnotation'));
  }
  setFieldValue(): Promise<void> {
    return Promise.reject(new NotImplementedError('setFieldValue'));
  }
  setMetadata(): Promise<void> {
    return Promise.reject(new NotImplementedError('setMetadata'));
  }
  setLayerVisible(): Promise<void> {
    return Promise.reject(new NotImplementedError('setLayerVisible'));
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

  /** `FPDF_SaveAsCopy` through a `FPDF_FILEWRITE` callback (possible thanks to the table patch). */
  private saveCopy(d: OpenDoc, flags: number): Uint8Array {
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
      const ok = ffi.call('FPDF_SaveAsCopy', d.doc, fw, flags);
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

/**
 * `FakeEngine` — an in-memory `PdfEngine` for the document-model tests (M20).
 *
 * Two reasons it exists rather than running everything through PDFium:
 *
 * 1. **Speed and determinism.** The property test applies a thousand random commands and undoes
 *    them all; doing that through wasm would take minutes and drag real file parsing into a test
 *    about model invariants.
 * 2. **Coverage of the fallback path.** `supports` turns individual mutations off, so the same
 *    suite can prove that a command records the right write intent when the backend refuses,
 *    which is exactly what happens with `setMetadata` on the real adapter.
 *
 * It is not a PDF implementation: `render` returns a stub, `save` returns a marker. Anything
 * that has to prove the *engine* behaves is in `test/unit/engine/`, against real PDFium.
 */

import {
  DEFAULT_INITIAL_VIEW,
  EngineError,
  NotImplementedError,
  type Annotation,
  type Attachment,
  type AttachmentPatch,
  type DocHandle,
  type FormField,
  type FontUsage,
  type InitialView,
  type Layer,
  type Metadata,
  type NewAttachment,
  type PdfCollection,
  type NamedDestination,
  type NewAnnotation,
  type OpenOptions,
  type OutlineItem,
  type PageObject,
  type PdfEngine,
  type Permissions,
  type RenderResult,
  type SignatureSummary,
  type TextRun,
  type Link,
} from '@engine/PdfEngine';
import type { PageIndex, PageSize, PdfRect, Rotation } from '@shared/pdf';

/** Which mutations the fake claims to support. Anything false raises `NotImplementedError`. */
export interface FakeSupport {
  setPageRotation: boolean;
  deletePages: boolean;
  insertBlankPages: boolean;
  importPages: boolean;
  movePage: boolean;
  setCropBox: boolean;
  annotations: boolean;
  setFieldValue: boolean;
  setMetadata: boolean;
  setLayerVisible: boolean;
  /** Add / update / delete of embedded files (M12, ADR 0011). */
  attachments: boolean;
}

export const FULL_SUPPORT: FakeSupport = {
  setPageRotation: true,
  deletePages: true,
  insertBlankPages: true,
  importPages: true,
  movePage: true,
  setCropBox: true,
  annotations: true,
  setFieldValue: true,
  setMetadata: true,
  setLayerVisible: true,
  attachments: true,
};

/** What the real PDFium adapter can do, so a test can reproduce its exact fallback behaviour. */
export const PDFIUM_SUPPORT: FakeSupport = {
  ...FULL_SUPPORT,
  setMetadata: false,
  // Layer visibility and embedded-file editing are both real in the PDFium adapter (ADR 0011).
};

export const NO_SUPPORT: FakeSupport = {
  setPageRotation: false,
  deletePages: false,
  insertBlankPages: false,
  importPages: false,
  movePage: false,
  setCropBox: false,
  annotations: false,
  setFieldValue: false,
  setMetadata: false,
  setLayerVisible: false,
  attachments: false,
};

interface FakePage {
  rotation: Rotation;
  mediaBox: PdfRect;
  cropBox: PdfRect;
  label: string;
  annotations: Annotation[];
  objects: PageObject[];
}

/** The file a fake document starts from. Every field has a sensible default. */
export interface FakeDocumentSpec {
  readonly pageCount?: number;
  readonly width?: number;
  readonly height?: number;
  readonly labels?: ReadonlyArray<string>;
  readonly annotations?: Readonly<Record<number, ReadonlyArray<Omit<Annotation, 'id' | 'page'>>>>;
  readonly fields?: ReadonlyArray<FormField>;
  readonly outline?: ReadonlyArray<OutlineItem>;
  readonly layers?: ReadonlyArray<Layer>;
  readonly attachments?: ReadonlyArray<Attachment>;
  readonly collection?: PdfCollection | null;
  readonly namedDestinations?: ReadonlyArray<NamedDestination>;
  readonly signatures?: ReadonlyArray<SignatureSummary>;
  readonly fonts?: ReadonlyArray<FontUsage>;
  readonly initialView?: InitialView;
  readonly metadata?: Partial<Metadata>;
  readonly encrypted?: boolean;
}

interface FakeDoc {
  pages: FakePage[];
  fields: FormField[];
  outline: OutlineItem[];
  layers: Layer[];
  attachments: Attachment[];
  attachmentBytes: Map<string, Uint8Array>;
  collection: PdfCollection | null;
  namedDestinations: NamedDestination[];
  signatures: SignatureSummary[];
  fonts: FontUsage[];
  initialView: InitialView;
  metadata: Metadata;
}

const ALL_PERMISSIONS: Permissions = {
  print: true,
  printHighQuality: true,
  modify: true,
  copy: true,
  annotate: true,
  fillForms: true,
  extractForAccessibility: true,
  assemble: true,
};

const box = (w: number, h: number): PdfRect => ({ x0: 0, y0: 0, x1: w, y1: h });

export class FakeEngine implements PdfEngine {
  readonly supports: FakeSupport;
  /** Every method call, in order — tests assert that a command really did reach the engine. */
  readonly calls: string[] = [];
  private readonly docs = new Map<number, FakeDoc>();
  private next = 1;

  constructor(supports: Partial<FakeSupport> = {}) {
    this.supports = { ...FULL_SUPPORT, ...supports };
  }

  /** Opens a synthetic document directly, without going through bytes. */
  create(spec: FakeDocumentSpec = {}): DocHandle {
    const count = spec.pageCount ?? 3;
    const width = spec.width ?? 600;
    const height = spec.height ?? 800;
    const pages: FakePage[] = [];
    for (let i = 0; i < count; i++) {
      const list = spec.annotations?.[i] ?? [];
      pages.push({
        rotation: 0,
        mediaBox: box(width, height),
        cropBox: box(width, height),
        label: spec.labels?.[i] ?? String(i + 1),
        annotations: list.map((a, j) => ({ ...a, id: `a${i}.${j}`, page: i })),
        objects: [],
      });
    }
    const handle = this.next++ as DocHandle;
    this.docs.set(handle, {
      pages,
      fields: [...(spec.fields ?? [])],
      outline: [...(spec.outline ?? [])],
      layers: [...(spec.layers ?? [])],
      attachments: [...(spec.attachments ?? [])],
      attachmentBytes: new Map(),
      collection: spec.collection ?? null,
      namedDestinations: [...(spec.namedDestinations ?? [])],
      signatures: [...(spec.signatures ?? [])],
      fonts: [...(spec.fonts ?? [])],
      initialView: spec.initialView ?? DEFAULT_INITIAL_VIEW,
      metadata: {
        version: '1.7',
        encrypted: spec.encrypted ?? false,
        linearized: false,
        tagged: false,
        hasForm: (spec.fields?.length ?? 0) > 0,
        hasXfa: false,
        pageCount: count,
        ...spec.metadata,
      },
    });
    return handle;
  }

  private doc(handle: DocHandle): FakeDoc {
    const d = this.docs.get(handle);
    if (!d) throw new EngineError('invalid-handle', `handle ${handle} is not open`);
    return d;
  }

  private page(handle: DocHandle, index: PageIndex): FakePage {
    const d = this.doc(handle);
    const p = d.pages[index];
    if (!p) throw new EngineError('invalid-page', `page ${index} is out of range`);
    return p;
  }

  private note(name: string): void {
    this.calls.push(name);
  }

  /** Re-numbers annotation ids after a change, exactly as PDFium does. */
  private renumber(page: FakePage, index: PageIndex): void {
    page.annotations = page.annotations.map((a, j) => ({
      ...a,
      id: `a${index}.${j}`,
      page: index,
    }));
  }

  private need(feature: keyof FakeSupport, what: string): void {
    if (!this.supports[feature]) throw new NotImplementedError(what);
  }

  // ---- lifecycle ---------------------------------------------------------------------------

  info(): Promise<{ readonly name: string; readonly version: string }> {
    return Promise.resolve({ name: 'fake', version: '1' });
  }

  /** The bytes are ignored; `create()` is the real entry point. Encrypted files need a password. */
  open(bytes: Uint8Array, options: OpenOptions = {}): Promise<DocHandle> {
    this.note('open');
    if (bytes.length === 0) throw new EngineError('corrupt', 'empty file');
    const spec: FakeDocumentSpec = { pageCount: Math.max(1, bytes[0] ?? 3) };
    if (options.password === 'wrong') throw new EngineError('wrong-password', 'wrong password');
    return Promise.resolve(this.create(spec));
  }

  /** An empty document, as M40 extracts into (ADR 0014). */
  createDocument(): Promise<DocHandle> {
    this.note('createDocument');
    return Promise.resolve(this.create({ pageCount: 0 }));
  }

  close(doc: DocHandle): Promise<void> {
    this.note('close');
    this.doc(doc);
    this.docs.delete(doc);
    return Promise.resolve();
  }

  // ---- structure ---------------------------------------------------------------------------

  pageCount(doc: DocHandle): Promise<number> {
    return Promise.resolve(this.doc(doc).pages.length);
  }

  pageSize(doc: DocHandle, page: PageIndex): Promise<PageSize> {
    const p = this.page(doc, page);
    const w = p.cropBox.x1 - p.cropBox.x0;
    const h = p.cropBox.y1 - p.cropBox.y0;
    const swap = p.rotation === 90 || p.rotation === 270;
    return Promise.resolve({
      width: swap ? h : w,
      height: swap ? w : h,
      rotation: p.rotation,
      cropBox: p.cropBox,
      mediaBox: p.mediaBox,
    });
  }

  pageLabels(doc: DocHandle): Promise<ReadonlyArray<string>> {
    return Promise.resolve(this.doc(doc).pages.map((p) => p.label));
  }

  metadata(doc: DocHandle): Promise<Metadata> {
    const d = this.doc(doc);
    return Promise.resolve({ ...d.metadata, pageCount: d.pages.length });
  }

  permissions(): Promise<Permissions> {
    return Promise.resolve(ALL_PERMISSIONS);
  }

  outline(doc: DocHandle): Promise<ReadonlyArray<OutlineItem>> {
    return Promise.resolve(this.doc(doc).outline);
  }

  layers(doc: DocHandle): Promise<ReadonlyArray<Layer>> {
    return Promise.resolve(this.doc(doc).layers);
  }

  attachments(doc: DocHandle): Promise<ReadonlyArray<Attachment>> {
    return Promise.resolve(this.doc(doc).attachments);
  }

  attachmentData(doc: DocHandle, attachmentId: string): Promise<Uint8Array> {
    return Promise.resolve(this.doc(doc).attachmentBytes.get(attachmentId) ?? new Uint8Array(0));
  }

  collection(doc: DocHandle): Promise<PdfCollection | null> {
    return Promise.resolve(this.doc(doc).collection);
  }

  signatures(doc: DocHandle): Promise<ReadonlyArray<SignatureSummary>> {
    return Promise.resolve(this.doc(doc).signatures);
  }

  namedDestinations(doc: DocHandle): Promise<ReadonlyArray<NamedDestination>> {
    return Promise.resolve(this.doc(doc).namedDestinations);
  }

  fonts(doc: DocHandle): Promise<ReadonlyArray<FontUsage>> {
    return Promise.resolve(this.doc(doc).fonts);
  }

  initialView(doc: DocHandle): Promise<InitialView> {
    return Promise.resolve(this.doc(doc).initialView);
  }

  // ---- content -----------------------------------------------------------------------------

  render(doc: DocHandle, page: PageIndex, scale: number): Promise<RenderResult> {
    const p = this.page(doc, page);
    return Promise.resolve({
      bitmap: { width: 1, height: 1, close: () => undefined },
      scale,
      rect: p.cropBox,
    });
  }

  textRuns(): Promise<ReadonlyArray<TextRun>> {
    return Promise.resolve([]);
  }

  pageObjects(doc: DocHandle, page: PageIndex): Promise<ReadonlyArray<PageObject>> {
    return Promise.resolve(this.page(doc, page).objects);
  }

  annotations(doc: DocHandle, page: PageIndex): Promise<ReadonlyArray<Annotation>> {
    return Promise.resolve(this.page(doc, page).annotations.map((a) => ({ ...a })));
  }

  formFields(doc: DocHandle): Promise<ReadonlyArray<FormField>> {
    return Promise.resolve(this.doc(doc).fields);
  }

  links(): Promise<ReadonlyArray<Link>> {
    return Promise.resolve([]);
  }

  // ---- mutation ----------------------------------------------------------------------------

  setPageRotation(doc: DocHandle, page: PageIndex, rotation: Rotation): Promise<void> {
    this.need('setPageRotation', 'setPageRotation');
    this.note('setPageRotation');
    this.page(doc, page).rotation = rotation;
    return Promise.resolve();
  }

  deletePages(doc: DocHandle, pages: ReadonlyArray<PageIndex>): Promise<void> {
    this.need('deletePages', 'deletePages');
    this.note('deletePages');
    const d = this.doc(doc);
    for (const index of [...new Set(pages)].sort((a, b) => b - a)) {
      if (index < 0 || index >= d.pages.length) {
        throw new EngineError('invalid-page', `page ${index} is out of range`);
      }
      d.pages.splice(index, 1);
    }
    d.pages.forEach((p, i) => {
      this.renumber(p, i);
    });
    return Promise.resolve();
  }

  insertBlankPages(
    doc: DocHandle,
    at: PageIndex,
    count: number,
    size: { readonly width: number; readonly height: number },
  ): Promise<void> {
    this.need('insertBlankPages', 'insertBlankPages');
    this.note('insertBlankPages');
    const d = this.doc(doc);
    if (at < 0 || at > d.pages.length) {
      throw new EngineError('invalid-page', `cannot insert at ${at}`);
    }
    const made: FakePage[] = [];
    for (let i = 0; i < count; i++) {
      made.push({
        rotation: 0,
        mediaBox: box(size.width, size.height),
        cropBox: box(size.width, size.height),
        label: String(at + i + 1),
        annotations: [],
        objects: [],
      });
    }
    d.pages.splice(at, 0, ...made);
    d.pages.forEach((p, i) => {
      this.renumber(p, i);
    });
    return Promise.resolve();
  }

  importPages(
    doc: DocHandle,
    source: DocHandle,
    pages: ReadonlyArray<PageIndex>,
    at: PageIndex,
  ): Promise<void> {
    this.need('importPages', 'importPages');
    this.note('importPages');
    const d = this.doc(doc);
    const src = this.doc(source);
    const wanted = pages.length > 0 ? pages : src.pages.map((_, i) => i);
    const copies = wanted.flatMap((i) => {
      const p = src.pages[i];
      return p ? [{ ...p, annotations: p.annotations.map((a) => ({ ...a })) }] : [];
    });
    d.pages.splice(at, 0, ...copies);
    d.pages.forEach((p, i) => {
      this.renumber(p, i);
    });
    return Promise.resolve();
  }

  movePage(doc: DocHandle, from: PageIndex, to: PageIndex): Promise<void> {
    this.need('movePage', 'movePage');
    this.note('movePage');
    const d = this.doc(doc);
    const [p] = d.pages.splice(from, 1);
    if (!p) throw new EngineError('invalid-page', `page ${from} is out of range`);
    d.pages.splice(to, 0, p);
    d.pages.forEach((q, i) => {
      this.renumber(q, i);
    });
    return Promise.resolve();
  }

  setCropBox(doc: DocHandle, page: PageIndex, boxRect: PdfRect): Promise<void> {
    this.need('setCropBox', 'setCropBox');
    this.note('setCropBox');
    this.page(doc, page).cropBox = boxRect;
    return Promise.resolve();
  }

  addAnnotation(doc: DocHandle, annotation: NewAnnotation): Promise<Annotation> {
    this.need('annotations', 'addAnnotation');
    this.note('addAnnotation');
    const p = this.page(doc, annotation.page);
    const created: Annotation = {
      ...annotation,
      id: `a${annotation.page}.${p.annotations.length}`,
    };
    p.annotations.push(created);
    this.renumber(p, annotation.page);
    const last = p.annotations[p.annotations.length - 1];
    if (!last) throw new EngineError('internal', 'annotation vanished');
    return Promise.resolve({ ...last });
  }

  updateAnnotation(
    doc: DocHandle,
    id: string,
    patch: Partial<Omit<Annotation, 'id' | 'page'>>,
  ): Promise<Annotation> {
    this.need('annotations', 'updateAnnotation');
    this.note('updateAnnotation');
    const { page, index } = parseId(id);
    const p = this.page(doc, page);
    const current = p.annotations[index];
    if (!current) throw new EngineError('invalid-argument', `no annotation ${id}`);
    const updated: Annotation = { ...current, ...patch, id: current.id, page };
    p.annotations[index] = updated;
    return Promise.resolve({ ...updated });
  }

  deleteAnnotation(doc: DocHandle, id: string): Promise<void> {
    this.need('annotations', 'deleteAnnotation');
    this.note('deleteAnnotation');
    const { page, index } = parseId(id);
    const p = this.page(doc, page);
    if (index < 0 || index >= p.annotations.length) {
      throw new EngineError('invalid-argument', `no annotation ${id}`);
    }
    p.annotations.splice(index, 1);
    this.renumber(p, page);
    return Promise.resolve();
  }

  /** M30's appearance push. The fake keeps the stream so a test can assert one was written. */
  setAnnotationAppearance(doc: DocHandle, id: string, content: string | null): Promise<void> {
    this.need('annotations', 'setAnnotationAppearance');
    this.note('setAnnotationAppearance');
    const { page, index } = parseId(id);
    const p = this.page(doc, page);
    const annotation = p.annotations[index];
    if (!annotation) throw new EngineError('invalid-argument', `no annotation ${id}`);
    const extra = { ...annotation.extra };
    if (content === null) delete extra['appearanceStream'];
    else extra['appearanceStream'] = content;
    p.annotations[index] = { ...annotation, extra, ...(content === null ? {} : {}) };
    return Promise.resolve();
  }

  setFieldValue(doc: DocHandle, fieldName: string, value: string): Promise<void> {
    this.need('setFieldValue', 'setFieldValue');
    this.note('setFieldValue');
    const d = this.doc(doc);
    const index = d.fields.findIndex((f) => f.name === fieldName);
    if (index < 0) throw new EngineError('invalid-argument', `no field ${fieldName}`);
    const field = d.fields[index];
    if (field) d.fields[index] = { ...field, value };
    return Promise.resolve();
  }

  setMetadata(
    doc: DocHandle,
    patch: Partial<Omit<Metadata, 'version' | 'pageCount'>>,
  ): Promise<void> {
    this.need('setMetadata', 'setMetadata');
    this.note('setMetadata');
    const d = this.doc(doc);
    d.metadata = { ...d.metadata, ...patch };
    return Promise.resolve();
  }

  setLayerVisible(doc: DocHandle, layerId: string, visible: boolean): Promise<void> {
    this.need('setLayerVisible', 'setLayerVisible');
    this.note('setLayerVisible');
    const d = this.doc(doc);
    d.layers = d.layers.map((l) => (l.id === layerId ? { ...l, visible } : l));
    return Promise.resolve();
  }

  addAttachment(doc: DocHandle, file: NewAttachment): Promise<Attachment> {
    this.need('attachments', 'addAttachment');
    this.note('addAttachment');
    const d = this.doc(doc);
    const attachment: Attachment = {
      id: `att.${String(d.attachments.length)}`,
      name: file.name,
      size: file.bytes.length,
      ...(file.description === undefined ? {} : { description: file.description }),
      ...(file.mimeType === undefined ? {} : { mimeType: file.mimeType }),
      ...(file.modified === undefined ? {} : { modified: file.modified }),
    };
    d.attachments = [...d.attachments, attachment];
    d.attachmentBytes.set(attachment.id, file.bytes);
    renumberAttachments(d);
    const added = d.attachments.find((a) => a.name === file.name);
    return Promise.resolve(added ?? attachment);
  }

  updateAttachment(
    doc: DocHandle,
    attachmentId: string,
    patch: AttachmentPatch,
  ): Promise<Attachment> {
    this.need('attachments', 'updateAttachment');
    this.note('updateAttachment');
    const d = this.doc(doc);
    const found = d.attachments.find((a) => a.id === attachmentId);
    if (!found) throw new EngineError('invalid-argument', `no attachment ${attachmentId}`);
    const next: Attachment = {
      ...found,
      ...(patch.name === undefined ? {} : { name: patch.name }),
      ...(patch.description === undefined ? {} : { description: patch.description }),
      ...(patch.mimeType === undefined ? {} : { mimeType: patch.mimeType }),
      ...(patch.modified === undefined ? {} : { modified: patch.modified }),
      ...(patch.bytes === undefined ? {} : { size: patch.bytes.length }),
    };
    d.attachments = d.attachments.map((a) => (a.id === attachmentId ? next : a));
    if (patch.bytes) d.attachmentBytes.set(attachmentId, patch.bytes);
    return Promise.resolve(next);
  }

  deleteAttachment(doc: DocHandle, attachmentId: string): Promise<void> {
    this.need('attachments', 'deleteAttachment');
    this.note('deleteAttachment');
    const d = this.doc(doc);
    const at = d.attachments.findIndex((a) => a.id === attachmentId);
    if (at < 0) throw new EngineError('invalid-argument', `no attachment ${attachmentId}`);
    d.attachmentBytes.delete(attachmentId);
    d.attachments = d.attachments.filter((a) => a.id !== attachmentId);
    renumberAttachments(d);
    return Promise.resolve();
  }

  save(doc: DocHandle): Promise<Uint8Array> {
    this.note('save');
    const d = this.doc(doc);
    return Promise.resolve(new Uint8Array([d.pages.length]));
  }
}

/**
 * Puts the positional attachment ids back in step with the list, bytes and all — PDFium names an
 * embedded file by its index in the name tree, so an add or a delete renumbers the ones after it
 * and an id that did not move would name a different file (M12, ADR 0011).
 */
function renumberAttachments(d: FakeDoc): void {
  const bytes = d.attachments.map((a) => d.attachmentBytes.get(a.id));
  d.attachments = d.attachments.map((a, i) => ({ ...a, id: `att.${String(i)}` }));
  d.attachmentBytes.clear();
  d.attachments.forEach((a, i) => {
    const value = bytes[i];
    if (value) d.attachmentBytes.set(a.id, value);
  });
}

function parseId(id: string): { page: number; index: number } {
  const m = /^a(\d+)\.(\d+)$/.exec(id);
  if (!m) throw new EngineError('invalid-argument', `${id} is not an annotation id`);
  return { page: Number(m[1]), index: Number(m[2]) };
}

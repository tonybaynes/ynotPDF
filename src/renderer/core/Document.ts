/**
 * `Document` — the in-memory model of one open PDF (M20; typed shell by M00, ADR 0007).
 *
 * The engine is the source of truth for **bytes**; the Document is the source of truth for
 * **intent**. It holds everything editable — pages, annotations, fields, outline, destinations,
 * layers, attachments, metadata, security, signatures, view settings — plus a journal of
 * `Command`s (its `UndoStack`). Saving (M21) replays the journal into the writer.
 *
 * Every change goes through `apply(command)`. Never mutate the engine directly from UI code.
 *
 * **Structure lives here, content lives in the engine.** Page order, page presence and labels
 * are the model's alone: `FPDFPage_Delete` cannot be undone, so a delete that went to PDFium
 * would make undo a lie. Views resolve a model page id to the live PDFium index through
 * {@link Document.enginePage}. Everything PDFium can reverse exactly — rotation, boxes,
 * annotations, field values, blank pages we inserted ourselves — is pushed to the engine
 * immediately so a render reflects the edit. What the engine cannot take is recorded as a
 * {@link WriteIntent} for M21's writer.
 *
 * Geometry: PDF points, origin bottom-left, page-relative. Page indexes 0-based.
 */

import type {
  Annotation,
  DocHandle,
  FormField,
  NamedDestination,
  OpenOptions,
  PageObject,
  PdfEngine,
  Permissions,
} from '@engine/PdfEngine';
import type { PageIndex, PageSize, PdfRect } from '@shared/pdf';
import type { Command } from './Command';
import { DocumentEvents } from './events';
import { IdAllocator, IdTable, type ModelId } from './Ids';
import {
  DEFAULT_VIEW_SETTINGS,
  flattenOutline,
  pageBox,
  pageSizeOf,
  toModelAnnotation,
  toModelAttachment,
  toModelDestination,
  toModelLayer,
  toModelMetadata,
  toViewSettings,
  type CustomBag,
  type ModelAnnotation,
  type ModelAttachment,
  type ModelDestination,
  type ModelField,
  type ModelLayer,
  type ModelMetadata,
  type ModelOutlineItem,
  type ModelPage,
  type ModelWidget,
  type PageBoxName,
  type SecurityState,
  type SignatureSummary,
  type ViewSettings,
  type WriteIntent,
} from './model';
import { createStore, type Store, type Unsubscribe } from './Store';
import { UndoStack } from './UndoStack';
import { contentIdentity } from '@shared/contentIdentity';
import { serialiseJournal, type JournalEntry } from './Journal';

/** Engine bytes accompanying this state must be captured in the same undo read barrier. */
export interface DocumentCheckpoint {
  readonly state: Omit<DocumentState, 'revision'>;
  readonly ids: Record<string, number>;
  readonly bindings: ReturnType<IdTable['toJSON']>;
  readonly journal: ReadonlyArray<JournalEntry>;
}

export * from './model';
export type { DocumentEvent, DocumentEventType, PageChange } from './events';

/** Kept from M00, where a page was `{ index, label, size }`. Prefer {@link ModelPage}. */
export type PageInfo = ModelPage;

/** Observable document state. Modules subscribe to slices of this via `document.store`. */
export interface DocumentState {
  /** Absolute path on disk, or `null` for a new/unsaved document. */
  readonly path: string | null;
  readonly title: string;
  /** Pages in document order. */
  readonly pages: ReadonlyArray<ModelPage>;
  /** Annotations by **page id**, for pages whose annotations have been loaded. */
  readonly annotations: Readonly<Record<string, ReadonlyArray<ModelAnnotation>>>;
  /** Fields as a flat list; the tree is `parentId` / `childIds`. */
  readonly fields: ReadonlyArray<ModelField>;
  /** Outline nodes, parents before children; roots have `parentId === null`. */
  readonly outline: ReadonlyArray<ModelOutlineItem>;
  readonly destinations: ReadonlyArray<ModelDestination>;
  readonly layers: ReadonlyArray<ModelLayer>;
  readonly attachments: ReadonlyArray<ModelAttachment>;
  readonly metadata: ModelMetadata;
  readonly security: SecurityState;
  readonly signatures: ReadonlyArray<SignatureSummary>;
  readonly view: ViewSettings;
  /** Module-owned state, one namespace per module id. Read yours, not other modules'. */
  readonly custom: CustomBag;
  /** What the engine could not apply, for M21's writer. Derived from the undo stack. */
  readonly writeIntents: ReadonlyArray<WriteIntent>;
  /** Bumped after every applied command so views can re-render cheaply. */
  readonly revision: number;
}

/** A command that knows what it left for the writer to do. */
export interface DocumentCommand extends Command {
  /** Kinds of change the engine did not take. Empty when the engine applied everything. */
  readonly writeIntents: ReadonlyArray<WriteIntent>;
}

function isDocumentCommand(c: Command): c is DocumentCommand {
  return Array.isArray((c as Partial<DocumentCommand>).writeIntents);
}

/** A model invariant that does not hold. `Document.validate()` returns these. */
export interface ValidationIssue {
  /** Stable machine-readable code, e.g. `"page.duplicate-id"`. */
  readonly code: string;
  readonly message: string;
  readonly entityId?: ModelId;
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

let nextDocumentId = 1;

export class Document {
  /** Unique per open document in this window (tabs key on it). */
  readonly id: string;
  readonly engine: PdfEngine;
  readonly handle: DocHandle;
  readonly store: Store<DocumentState>;
  readonly undo: UndoStack;
  /** Fine-grained change events (ADR 0007). */
  readonly events = new DocumentEvents();
  /** Allocates model ids. Exposed so commands can mint ids for entities they create. */
  readonly ids: IdAllocator;
  /** Model id ↔ engine key. Commands rebind it after engine calls that renumber. */
  readonly idTable: IdTable;
  /**
   * Bytes a module has to carry from a command to the writer, keyed by whatever the module
   * chooses (M42, ADR 0014).
   *
   * The custom bag next to it is JSON — it goes into `snapshot()` and into the recovery file —
   * so a megabyte of file content cannot live there. A portfolio's newly added files are the
   * first use: the command puts the bytes here, the write plan hands them to the writer, and
   * neither the snapshot nor the recovery record ever sees them. Not part of the model state:
   * nothing subscribes to it and undoing does not empty it, because a redo needs the bytes back.
   */
  readonly blobs = new Map<string, Uint8Array>();

  /** Milliseconds of inactivity after which the next edit starts a new undo entry. */
  mergeIdleMs = 600;
  private lastEditAt = 0;
  private closed = false;
  private initialSource: ReturnType<typeof contentIdentity> | null = null;

  get sourceIdentity(): ReturnType<typeof contentIdentity> | null {
    return this.initialSource;
  }
  private recoveredIntents: ReadonlyArray<WriteIntent> = [];
  private recoveredEntries: ReadonlyArray<JournalEntry> = [];

  /** Writer provenance from the restored checkpoint; never replay these commands. */
  get recoveryJournal(): ReadonlyArray<JournalEntry> {
    return this.recoveredEntries;
  }

  checkpoint(): DocumentCheckpoint {
    return JSON.parse(
      JSON.stringify({
        state: this.snapshot(),
        ids: this.ids.toJSON(),
        bindings: this.idTable.toJSON(),
        journal: serialiseJournal(this).entries,
      }),
    ) as DocumentCheckpoint;
  }

  /** Called before attaching a freshly opened checkpoint engine to any UI or module. */
  restoreCheckpoint(checkpoint: DocumentCheckpoint): void {
    this.ids.restore(checkpoint.ids);
    this.idTable.restore(checkpoint.bindings);
    this.recoveredIntents = checkpoint.state.writeIntents;
    this.recoveredEntries = checkpoint.journal;
    this.store.set({ ...checkpoint.state, revision: 0 });
    const issues = this.validate();
    if (issues.length) throw new Error(`Invalid recovery model: ${issues[0]?.message}`);
    this.undo.clear();
    this.undo.markUnsaved();
  }

  private constructor(
    engine: PdfEngine,
    handle: DocHandle,
    initial: DocumentState,
    ids: IdAllocator,
    idTable: IdTable,
  ) {
    this.id = `doc-${nextDocumentId++}`;
    this.engine = engine;
    this.handle = handle;
    this.store = createStore(initial);
    this.undo = new UndoStack();
    this.ids = ids;
    this.idTable = idTable;
  }

  /**
   * Opens bytes in the engine and builds the model. Rejects with `EngineError` (code
   * `password-required` / `wrong-password` / `corrupt`) when the engine cannot open the file.
   */
  static async open(
    engine: PdfEngine,
    bytes: Uint8Array,
    options: OpenOptions & { readonly path?: string | null } = {},
  ): Promise<Document> {
    const { path, ...openOptions } = options;
    const source = contentIdentity(bytes);
    const handle = await engine.open(bytes, openOptions);
    try {
      const document = await Document.build(engine, handle, path ?? null, options.name ?? null);
      document.initialSource = source;
      return document;
    } catch (error) {
      await engine.close(handle).catch(() => undefined);
      throw error;
    }
  }

  /**
   * Builds the model around a handle the caller already has. Use this when the document was
   * *created* rather than opened — M91's "new from images", a document assembled by the engine —
   * and in tests that construct a synthetic document. `open()` is this plus `engine.open`.
   */
  static fromHandle(
    engine: PdfEngine,
    handle: DocHandle,
    options: { readonly path?: string | null; readonly name?: string | null } = {},
  ): Promise<Document> {
    return Document.build(engine, handle, options.path ?? null, options.name ?? null);
  }

  private static async build(
    engine: PdfEngine,
    handle: DocHandle,
    path: string | null,
    name: string | null,
  ): Promise<Document> {
    const ids = new IdAllocator();
    const idTable = new IdTable();
    const [count, labels, metadata, permissions, outlineItems, layers, attachments] =
      await Promise.all([
        engine.pageCount(handle),
        engine.pageLabels(handle),
        engine.metadata(handle),
        engine.permissions(handle).catch(() => ALL_PERMISSIONS),
        engine.outline(handle).catch(() => []),
        engine.layers(handle).catch(() => []),
        engine.attachments(handle).catch(() => []),
      ]);

    // Pages first: everything else refers to them by id.
    const pages: ModelPage[] = [];
    for (let i = 0; i < count; i++) {
      const size = await engine.pageSize(handle, i);
      const id = ids.next('page');
      idTable.bind('page', id, String(i));
      pages.push(pageFromSize(id, labels[i] ?? String(i + 1), size));
    }
    const pageIdAt = (index: PageIndex): ModelId | null => pages[index]?.id ?? null;

    // Destinations: named ones from the catalogue, plus one per outline target.
    const destinations: ModelDestination[] = [];
    const named: ReadonlyArray<NamedDestination> = await engine
      .namedDestinations(handle)
      .catch(() => []);
    for (const n of named) {
      destinations.push(
        toModelDestination(ids.next('destination'), n.dest, pageIdAt(n.dest.page), n.name),
      );
    }
    const outline = flattenOutline(
      outlineItems,
      () => ids.next('outline'),
      (item) => {
        if (!item.dest) return null;
        const dest = toModelDestination(
          ids.next('destination'),
          item.dest,
          pageIdAt(item.dest.page),
        );
        destinations.push(dest);
        return dest.id;
      },
    );

    const fields = buildFieldTree(await engine.formFields(handle).catch(() => []), ids, pageIdAt);

    const signatures: SignatureSummary[] = (await engine.signatures(handle).catch(() => [])).map(
      (s) => ({
        id: ids.next('signature'),
        reason: s.reason ?? null,
        subFilter: s.subFilter ?? null,
        time: s.time ?? null,
        byteRange: s.byteRange,
        docMdpPermission: s.docMdpPermission ?? null,
      }),
    );

    const modelLayers = layers.map((l) => {
      const id = ids.next('layer');
      idTable.bind('layer', id, l.id);
      return toModelLayer(id, l);
    });
    const modelAttachments = attachments.map((a) => {
      const id = ids.next('attachment');
      idTable.bind('attachment', id, a.id);
      return toModelAttachment(id, a, a.page === undefined ? null : pageIdAt(a.page));
    });

    const meta = toModelMetadata(metadata);
    // How the file asks to be opened (M72, ADR 0017). An engine that cannot say leaves the
    // defaults, which is the same answer as a file that asks for nothing.
    const view = await engine
      .initialView(handle)
      .then((v) => toViewSettings(v, pageIdAt))
      .catch(() => DEFAULT_VIEW_SETTINGS);
    const title = meta.title ?? basename(path ?? name ?? 'Untitled');
    return new Document(
      engine,
      handle,
      {
        path,
        title,
        pages,
        annotations: {},
        fields,
        outline,
        destinations,
        layers: modelLayers,
        attachments: modelAttachments,
        metadata: meta,
        security: { encrypted: metadata.encrypted, permissions },
        signatures,
        view,
        custom: {},
        writeIntents: [],
        revision: 0,
      },
      ids,
      idTable,
    );
  }

  // ---- reading ---------------------------------------------------------------------------------

  get state(): DocumentState {
    return this.store.get();
  }

  get pageCount(): number {
    return this.state.pages.length;
  }

  get isDirty(): boolean {
    return this.undo.isDirty;
  }

  /** True once `close()` has run. Using the document afterwards throws. */
  get isClosed(): boolean {
    return this.closed;
  }

  /** The page at a visual index. Throws `RangeError` when out of range. */
  page(index: PageIndex): ModelPage {
    const p = this.state.pages[index];
    if (!p) throw new RangeError(`Page ${index} out of range (0..${this.pageCount - 1})`);
    return p;
  }

  /** The page with an id, or `null`. */
  pageById(id: ModelId): ModelPage | null {
    return this.state.pages.find((p) => p.id === id) ?? null;
  }

  /** Visual index of a page id, or `-1`. */
  pageIndex(id: ModelId): number {
    return this.state.pages.findIndex((p) => p.id === id);
  }

  /**
   * The engine's current page index for a model page, or `undefined` when the engine does not
   * hold it. Every engine call about a page must go through this — the model's order and the
   * engine's order are not the same thing.
   */
  enginePage(id: ModelId): PageIndex | undefined {
    const key = this.idTable.engineKey('page', id);
    return key === undefined ? undefined : Number(key);
  }

  /** Displayed size of a page (CropBox, rotation applied). */
  pageSize(id: ModelId): PageSize | null {
    const p = this.pageById(id);
    return p ? pageSizeOf(p) : null;
  }

  /** A named box of a page, with the spec's fallbacks applied. */
  pageBox(id: ModelId, box: PageBoxName): PdfRect | null {
    const p = this.pageById(id);
    return p ? pageBox(p, box) : null;
  }

  /** Annotations of a page. Empty until `loadAnnotations` has run for it. */
  annotations(pageId: ModelId): ReadonlyArray<ModelAnnotation> {
    return this.state.annotations[pageId] ?? [];
  }

  /** Finds an annotation anywhere in the document. */
  annotation(id: ModelId): ModelAnnotation | null {
    for (const list of Object.values(this.state.annotations)) {
      const found = list.find((a) => a.id === id);
      if (found) return found;
    }
    return null;
  }

  field(id: ModelId): ModelField | null {
    return this.state.fields.find((f) => f.id === id) ?? null;
  }

  fieldByName(name: string): ModelField | null {
    return this.state.fields.find((f) => f.name === name) ?? null;
  }

  outlineItem(id: ModelId): ModelOutlineItem | null {
    return this.state.outline.find((o) => o.id === id) ?? null;
  }

  destination(id: ModelId): ModelDestination | null {
    return this.state.destinations.find((d) => d.id === id) ?? null;
  }

  layer(id: ModelId): ModelLayer | null {
    return this.state.layers.find((l) => l.id === id) ?? null;
  }

  attachment(id: ModelId): ModelAttachment | null {
    return this.state.attachments.find((a) => a.id === id) ?? null;
  }

  /** A module's slice of the custom bag. Namespaces are module ids (`"M30"`). */
  custom(namespace: string): Readonly<Record<string, unknown>> {
    return this.state.custom[namespace] ?? {};
  }

  // ---- events ----------------------------------------------------------------------------------

  /** Subscribes to one change event type. See `events.ts`. */
  on = this.events.on.bind(this.events);
  /** Subscribes to every change event. */
  onAny = this.events.onAny.bind(this.events);

  /** Subscribes to whole-state changes (coarse). Prefer `on()` for anything specific. */
  subscribe(listener: (state: DocumentState) => void): Unsubscribe {
    return this.store.subscribe(listener);
  }

  // ---- applying changes ------------------------------------------------------------------------

  /** Applies a command through the undo stack and bumps `revision`. */
  async apply(command: Command): Promise<void> {
    this.assertOpen();
    if (Date.now() - this.lastEditAt > this.mergeIdleMs) this.undo.breakMerge();
    await this.undo.push(command);
    this.lastEditAt = Date.now();
    this.touch();
  }

  /** Groups several commands into one undo entry. */
  async batch(label: string, fn: () => void | Promise<void>, id = 'group'): Promise<void> {
    this.assertOpen();
    await this.undo.group(label, fn, id);
    this.lastEditAt = Date.now();
    this.touch();
  }

  /**
   * Opens a transaction that is committed or rolled back explicitly — for interactions that
   * span events, like a drag that starts on pointer-down and ends on pointer-up.
   */
  beginTransaction(label: string, id = 'group'): void {
    this.assertOpen();
    this.undo.beginTransaction(label, id);
  }

  async commit(): Promise<void> {
    await this.undo.commit();
    this.lastEditAt = Date.now();
    this.touch();
  }

  async rollback(): Promise<void> {
    await this.undo.rollback();
    this.touch();
  }

  async undoLast(): Promise<void> {
    await this.undo.undo();
    this.touch();
  }

  async redoLast(): Promise<void> {
    await this.undo.redo();
    this.touch();
  }

  /** Stops the next edit merging with the last one (selection change, tool change, blur). */
  breakMerge(): void {
    this.undo.breakMerge();
  }

  // ---- loading more of the file ----------------------------------------------------------------

  /**
   * Rebuilds page records from the engine. Only for a fresh open or an external reload — normal
   * page edits go through commands, which keep the model and the engine in step themselves.
   */
  async refreshPages(): Promise<void> {
    this.assertOpen();
    const count = await this.engine.pageCount(this.handle);
    const labels = await this.engine.pageLabels(this.handle);
    const pages: ModelPage[] = [];
    for (let i = 0; i < count; i++) {
      const size = await this.engine.pageSize(this.handle, i);
      const existing = this.idTable.modelId('page', String(i));
      const id = existing ?? this.ids.next('page');
      this.idTable.bind('page', id, String(i));
      const previous = existing === undefined ? null : this.pageById(existing);
      pages.push({
        ...pageFromSize(id, labels[i] ?? String(i + 1), size),
        objects: previous?.objects ?? null,
      });
    }
    this.store.set({ pages });
  }

  /** Loads (or reloads) the annotations of one page into the model. */
  async loadAnnotations(pageId: ModelId): Promise<ReadonlyArray<ModelAnnotation>> {
    this.assertOpen();
    const index = this.enginePage(pageId);
    if (index === undefined) return this.annotations(pageId);
    const list = await this.engine.annotations(this.handle, index);
    // A page can be removed or rebound while its lazy engine read is in flight.
    // Never publish old annotations onto a deleted page (or after document closure).
    if (this.closed || this.pageIndex(pageId) < 0 || this.enginePage(pageId) !== index) {
      return this.annotations(pageId);
    }
    const model = this.adoptAnnotations(pageId, list);
    this.store.set((s) => ({ annotations: { ...s.annotations, [pageId]: model } }));
    return model;
  }

  /** Loads a page's content objects (lazy — see {@link ModelPage.objects}). */
  async loadObjects(pageId: ModelId): Promise<ReadonlyArray<PageObject>> {
    this.assertOpen();
    const index = this.enginePage(pageId);
    if (index === undefined) return [];
    const objects = await this.engine.pageObjects(this.handle, index);
    this.replacePage(pageId, (p) => ({ ...p, objects }), 'objects');
    return objects;
  }

  /**
   * Binds engine annotations to model ids, reusing the id an engine annotation already had so a
   * reload does not invalidate selections. Returns the model list for the page.
   */
  adoptAnnotations(
    pageId: ModelId,
    list: ReadonlyArray<Annotation>,
  ): ReadonlyArray<ModelAnnotation> {
    const resolve = (engineId: string): ModelId | null =>
      this.idTable.modelId('annotation', engineId) ?? null;
    /*
     * Every id is bound *before* any annotation is converted, because `/IRT` is resolved during
     * the conversion: binding as we went left a reply pointing at nothing whenever its target had
     * not been reached yet, and binding afterwards left every reply on a freshly-loaded page
     * unthreaded (M32).
     */
    const ids = list.map(
      (a) => this.idTable.modelId('annotation', a.id) ?? this.ids.next('annotation'),
    );
    list.forEach((a, at) => {
      const id = ids[at];
      if (id !== undefined) this.idTable.bind('annotation', id, a.id);
    });
    return list.map((a, at) =>
      toModelAnnotation(ids[at] ?? this.ids.next('annotation'), pageId, a, resolve),
    );
  }

  // ---- model mutation (called by commands, not by UI code) --------------------------------------

  /** Replaces one page record and emits `page:changed`. */
  replacePage(
    pageId: ModelId,
    update: (page: ModelPage) => ModelPage,
    what: 'rotation' | 'boxes' | 'label' | 'objects',
    box?: PageBoxName,
  ): void {
    let changed = false;
    this.store.set((s) => ({
      pages: s.pages.map((p) => {
        if (p.id !== pageId) return p;
        changed = true;
        return update(p);
      }),
    }));
    if (!changed) return;
    this.events.emit(
      box ? { type: 'page:changed', pageId, what, box } : { type: 'page:changed', pageId, what },
    );
  }

  /** Inserts a page record at a visual index. */
  insertPageRecord(page: ModelPage, index: number): void {
    this.store.set((s) => {
      const pages = [...s.pages];
      pages.splice(Math.max(0, Math.min(index, pages.length)), 0, page);
      return { pages };
    });
    this.events.emit({ type: 'page:added', pageId: page.id, index });
  }

  /**
   * Removes a page record and the annotations that lived on it (the engine keeps its page — see
   * the class comment). Returns everything needed to put it back, for undo.
   */
  removePageRecord(pageId: ModelId): {
    page: ModelPage;
    index: number;
    /** Null when the page's annotations had never been loaded — different from "none". */
    annotations: ReadonlyArray<ModelAnnotation> | null;
  } | null {
    const index = this.pageIndex(pageId);
    if (index < 0) return null;
    const page = this.page(index);
    const annotations = this.state.annotations[pageId] ?? null;
    this.store.set((s) => ({
      pages: s.pages.filter((p) => p.id !== pageId),
      annotations: without(s.annotations, pageId),
    }));
    this.events.emit({ type: 'page:removed', pageId, index });
    return { page, index, annotations };
  }

  /**
   * Puts a page's annotations back, wholesale (undo of a page deletion). An empty list still
   * restores the entry, because "loaded and empty" is not the same state as "never loaded".
   */
  restoreAnnotations(pageId: ModelId, list: ReadonlyArray<ModelAnnotation> | null): void {
    if (list === null) return;
    this.store.set((s) => ({ annotations: { ...s.annotations, [pageId]: list } }));
    for (const a of list) {
      this.events.emit({ type: 'annotation:added', annotationId: a.id, pageId });
    }
  }

  /** Replaces a field's widget list (a page deletion takes its widgets with it). */
  setFieldWidgetsRecord(fieldId: ModelId, widgets: ReadonlyArray<ModelWidget>): void {
    let name = '';
    this.store.set((s) => ({
      fields: s.fields.map((f) => {
        if (f.id !== fieldId) return f;
        name = f.name;
        return { ...f, widgets };
      }),
    }));
    if (name !== '') this.events.emit({ type: 'field:changed', fieldId, name });
  }

  /**
   * Takes a field out of the tree, unhooking it from its parent (M41).
   *
   * Answers what was removed and where it was, so an undo can put it back exactly. A field with
   * no widget left on any page is what flattening a form produces, and one left in the tree is a
   * field no reader can fill and every validator complains about.
   */
  removeFieldRecord(fieldId: ModelId): { field: ModelField; index: number } | null {
    const index = this.state.fields.findIndex((f) => f.id === fieldId);
    const field = this.state.fields[index];
    if (index < 0 || !field) return null;
    this.store.set((s) => ({
      fields: s.fields
        .filter((f) => f.id !== fieldId)
        .map((f) =>
          f.childIds.includes(fieldId)
            ? { ...f, childIds: f.childIds.filter((id) => id !== fieldId) }
            : f,
        ),
    }));
    this.events.emit({ type: 'field:changed', fieldId, name: field.name });
    return { field, index };
  }

  /** Puts a removed field back where it was, parent link included (M41). */
  putFieldRecord(field: ModelField, index: number): void {
    this.store.set((s) => {
      const fields = s.fields
        .filter((f) => f.id !== field.id)
        .map((f) =>
          f.id === field.parentId && !f.childIds.includes(field.id)
            ? { ...f, childIds: [...f.childIds, field.id] }
            : f,
        );
      fields.splice(Math.max(0, Math.min(index, fields.length)), 0, field);
      return { fields };
    });
    this.events.emit({ type: 'field:changed', fieldId: field.id, name: field.name });
  }

  /** Points a destination at another page, or at none when its page has been removed. */
  setDestinationPageRecord(destinationId: ModelId, pageId: ModelId | null): void {
    this.store.set((s) => ({
      destinations: s.destinations.map((d) => (d.id === destinationId ? { ...d, pageId } : d)),
    }));
  }

  /** Moves a page record to a new visual index. */
  movePageRecord(pageId: ModelId, to: number): void {
    const from = this.pageIndex(pageId);
    if (from < 0) return;
    this.store.set((s) => {
      const pages = [...s.pages];
      const [p] = pages.splice(from, 1);
      if (!p) return {};
      pages.splice(Math.max(0, Math.min(to, pages.length)), 0, p);
      return { pages };
    });
    this.events.emit({ type: 'page:moved', pageId, from, to });
  }

  /** Adds or replaces an annotation record on its page. */
  putAnnotation(annotation: ModelAnnotation, index?: number): void {
    const pageId = annotation.pageId;
    let existed = false;
    this.store.set((s) => {
      const list = s.annotations[pageId] ?? [];
      existed = list.some((a) => a.id === annotation.id);
      let next: ModelAnnotation[];
      if (existed) {
        next = list.map((a) => (a.id === annotation.id ? annotation : a));
      } else {
        next = [...list];
        next.splice(index ?? next.length, 0, annotation);
      }
      return { annotations: { ...s.annotations, [pageId]: next } };
    });
    this.events.emit({
      type: existed ? 'annotation:changed' : 'annotation:added',
      annotationId: annotation.id,
      pageId,
    });
  }

  /** Removes an annotation record; returns it with its position, for undo. */
  removeAnnotationRecord(id: ModelId): { annotation: ModelAnnotation; index: number } | null {
    const annotation = this.annotation(id);
    if (!annotation) return null;
    const pageId = annotation.pageId;
    const index = this.annotations(pageId).findIndex((a) => a.id === id);
    this.store.set((s) => ({
      annotations: {
        ...s.annotations,
        [pageId]: (s.annotations[pageId] ?? []).filter((a) => a.id !== id),
      },
    }));
    this.events.emit({ type: 'annotation:removed', annotationId: id, pageId });
    return { annotation, index };
  }

  /**
   * Drops a page's annotation entry entirely, returning it to "not loaded yet". Undoing the
   * *first* annotation added to a page uses this: leaving an empty list behind would say the
   * page has been read and has none, which is a different state and would stop a later load.
   */
  forgetAnnotations(pageId: ModelId): void {
    if (!(pageId in this.state.annotations)) return;
    this.store.set((s) => ({ annotations: without(s.annotations, pageId) }));
  }

  /**
   * Adds a field at the end of the list (M60, ADR 0019). The parent named by `field.parentId`
   * gains it as a child, which is what makes a dotted name a tree.
   */
  addFieldRecord(field: ModelField): void {
    this.insertFieldRecord(field, this.state.fields.length);
  }

  /**
   * Puts a field at `index`, parent link included. `putFieldRecord`'s twin for a field that was
   * never in the document, so an undo of "add" and an undo of "delete" are the same code.
   */
  insertFieldRecord(field: ModelField, index: number): void {
    this.store.set((s) => {
      const fields = s.fields.map((f) =>
        f.id === field.parentId && !f.childIds.includes(field.id)
          ? { ...f, childIds: [...f.childIds, field.id] }
          : f,
      );
      fields.splice(Math.max(0, Math.min(index, fields.length)), 0, field);
      return { fields };
    });
    this.events.emit({ type: 'field:changed', fieldId: field.id, name: field.name });
  }

  /**
   * Replaces a field wholesale (M60, ADR 0019).
   *
   * A designer edit changes several entries at once — a name and its widgets, a role and its
   * flags — and a patch per entry would make an undo of one of them put back a field that never
   * existed. The command holds the whole before and after instead.
   */
  updateFieldRecord(field: ModelField): void {
    this.store.set((s) => ({ fields: s.fields.map((f) => (f.id === field.id ? field : f)) }));
    this.events.emit({ type: 'field:changed', fieldId: field.id, name: field.name });
  }

  /** Sets a field's value in the model. */
  setFieldValueRecord(fieldId: ModelId, value: string): void {
    let name = '';
    this.store.set((s) => ({
      fields: s.fields.map((f) => {
        if (f.id !== fieldId) return f;
        name = f.name;
        return { ...f, value };
      }),
    }));
    if (name !== '') this.events.emit({ type: 'field:changed', fieldId, name });
  }

  /** Merges a metadata patch into the model. */
  setMetadataRecord(patch: Partial<ModelMetadata>): void {
    this.store.set((s) => ({ metadata: { ...s.metadata, ...patch } }));
    this.events.emit({ type: 'metadata:changed' });
  }

  /**
   * Merges a patch into the initial-view settings (M72, ADR 0017).
   *
   * Model-only, like the metadata setter beside it: PDFium has no setter for `/PageMode`,
   * `/PageLayout`, `/OpenAction` or `/ViewerPreferences`, so a command that calls this also
   * records the `view` write intent and M21's writer applies it.
   */
  setViewRecord(patch: Partial<ViewSettings>): void {
    this.store.set((s) => ({ view: { ...s.view, ...patch } }));
    this.events.emit({ type: 'view:changed' });
  }

  /** Sets a layer's visibility in the model. */
  setLayerVisibleRecord(layerId: ModelId, visible: boolean): void {
    this.store.set((s) => ({
      layers: s.layers.map((l) => (l.id === layerId ? { ...l, visible } : l)),
    }));
    this.events.emit({ type: 'layer:changed', layerId });
  }

  /** Replaces the outline. M12 owns the editing UI; this is the model primitive. */
  setOutlineRecord(outline: ReadonlyArray<ModelOutlineItem>): void {
    this.store.set({ outline });
    this.events.emit({ type: 'outline:changed' });
  }

  /**
   * Replaces the destination list (M12). Named destinations are the model's alone — the engine
   * reads them and M21's writer rebuilds `/Names /Dests` from here.
   */
  setDestinationsRecord(destinations: ReadonlyArray<ModelDestination>): void {
    this.store.set({ destinations });
    this.events.emit({ type: 'destinations:changed' });
  }

  /** Adds or replaces one destination, keeping the rest in place (M12). */
  putDestinationRecord(destination: ModelDestination, index?: number): void {
    this.store.set((s) => {
      const list = [...s.destinations];
      const at = list.findIndex((d) => d.id === destination.id);
      if (at >= 0) list[at] = destination;
      else list.splice(index ?? list.length, 0, destination);
      return { destinations: list };
    });
    this.events.emit({ type: 'destinations:changed' });
  }

  /** Removes a destination; returns it with its position, for undo (M12). */
  removeDestinationRecord(id: ModelId): { destination: ModelDestination; index: number } | null {
    const index = this.state.destinations.findIndex((d) => d.id === id);
    if (index < 0) return null;
    const destination = this.state.destinations[index];
    if (!destination) return null;
    this.store.set((s) => ({ destinations: s.destinations.filter((d) => d.id !== id) }));
    this.events.emit({ type: 'destinations:changed' });
    return { destination, index };
  }

  /** Adds or replaces one attachment record (M12). */
  putAttachmentRecord(attachment: ModelAttachment, index?: number): void {
    this.store.set((s) => {
      const list = [...s.attachments];
      const at = list.findIndex((a) => a.id === attachment.id);
      if (at >= 0) list[at] = attachment;
      else list.splice(index ?? list.length, 0, attachment);
      return { attachments: list };
    });
    this.events.emit({ type: 'attachments:changed' });
  }

  /** Removes an attachment record; returns it with its position, for undo (M12). */
  removeAttachmentRecord(id: ModelId): { attachment: ModelAttachment; index: number } | null {
    const index = this.state.attachments.findIndex((a) => a.id === id);
    if (index < 0) return null;
    const attachment = this.state.attachments[index];
    if (!attachment) return null;
    this.store.set((s) => ({ attachments: s.attachments.filter((a) => a.id !== id) }));
    this.events.emit({ type: 'attachments:changed' });
    return { attachment, index };
  }

  /**
   * Re-binds attachment ids to the engine's positional keys after an add or a delete (M12).
   *
   * PDFium names an embedded file by its index in the name tree, so removing one renumbers
   * every attachment after it — the same hazard M20 met with annotations. The model's ids never
   * move; this puts the *engine* keys back in step by walking the two lists together.
   */
  rebindAttachments(engineIds: ReadonlyArray<string>): void {
    // The files in the name tree are the ones with an `att.<n>` key — including one a
    // FileAttachment annotation made this session claims for a page (M31): it is still in the
    // tree until a save moves it on to the annotation, so it still shifts with the rest.
    const list = this.state.attachments.filter((a) => a.engineId.startsWith('att.'));
    list.forEach((attachment, i) => {
      const key = engineIds[i];
      if (key === undefined) return;
      this.idTable.bind('attachment', attachment.id, key);
      if (attachment.engineId !== key) {
        this.store.set((s) => ({
          attachments: s.attachments.map((a) =>
            a.id === attachment.id ? { ...a, engineId: key } : a,
          ),
        }));
      }
    });
  }

  /** Writes into a module's namespace of the custom bag. */
  setCustomRecord(namespace: string, values: Readonly<Record<string, unknown>>): void {
    this.store.set((s) => ({
      custom: { ...s.custom, [namespace]: { ...(s.custom[namespace] ?? {}), ...values } },
    }));
    this.events.emit({ type: 'custom:changed', namespace });
  }

  /** Replaces a module's namespace outright (used by undo to restore a previous slice). */
  replaceCustomRecord(namespace: string, values: Readonly<Record<string, unknown>>): void {
    this.store.set((s) => ({ custom: { ...s.custom, [namespace]: values } }));
    this.events.emit({ type: 'custom:changed', namespace });
  }

  /** Removes a namespace entirely, so undoing the first write leaves no empty shell behind. */
  deleteCustomRecord(namespace: string): void {
    if (!(namespace in this.state.custom)) return;
    this.store.set((s) => ({ custom: without(s.custom, namespace) }));
    this.events.emit({ type: 'custom:changed', namespace });
  }

  // ---- saving and lifecycle --------------------------------------------------------------------

  /**
   * Serialises through the engine and marks the stack clean. M21 replaces this with a writer
   * that also applies `writeIntents`; until then, intents that the engine never took are
   * reported by {@link DocumentState.writeIntents} and are *not* in these bytes.
   */
  async save(): Promise<Uint8Array> {
    this.assertOpen();
    const bytes = await this.engine.save(this.handle);
    this.undo.markSaved();
    this.touch();
    return bytes;
  }

  /** Closes the engine handle and drops every subscription. The document is unusable after. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.events.clear();
    await this.engine.close(this.handle);
  }

  // ---- invariants ------------------------------------------------------------------------------

  /**
   * Checks the model's invariants. Empty means healthy. Used by the tests after every random
   * command sequence, and by M21 before writing.
   */
  validate(): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    const s = this.state;
    const seen = new Set<string>();
    const unique = (id: ModelId, what: string): void => {
      if (seen.has(id)) {
        issues.push({ code: `${what}.duplicate-id`, message: `Duplicate id ${id}`, entityId: id });
      }
      seen.add(id);
    };
    const pageIds = new Set<string>(s.pages.map((p) => p.id));

    for (const p of s.pages) {
      unique(p.id, 'page');
      if (![0, 90, 180, 270].includes(p.rotation)) {
        issues.push({
          code: 'page.bad-rotation',
          message: `Page ${p.label} has rotation ${p.rotation}`,
          entityId: p.id,
        });
      }
      for (const [name, box] of [
        ['mediaBox', p.mediaBox],
        ['cropBox', p.cropBox],
        ['bleedBox', p.bleedBox],
        ['trimBox', p.trimBox],
        ['artBox', p.artBox],
      ] as const) {
        if (box && !isSaneRect(box)) {
          issues.push({
            code: 'page.bad-box',
            message: `Page ${p.label} has an invalid ${name}`,
            entityId: p.id,
          });
        }
      }
    }

    for (const [pageId, list] of Object.entries(s.annotations)) {
      if (!pageIds.has(pageId)) {
        issues.push({
          code: 'annotation.orphan-page',
          message: `Annotations are held for page ${pageId}, which is not in the document`,
        });
      }
      for (const a of list) {
        unique(a.id, 'annotation');
        if (a.pageId !== pageId) {
          issues.push({
            code: 'annotation.page-mismatch',
            message: `Annotation ${a.id} is filed under ${pageId} but names ${a.pageId}`,
            entityId: a.id,
          });
        }
        if (!isSaneRect(a.rect)) {
          issues.push({
            code: 'annotation.bad-rect',
            message: `Annotation ${a.id} has an invalid rectangle`,
            entityId: a.id,
          });
        }
        if (a.opacity !== null && (a.opacity < 0 || a.opacity > 1)) {
          issues.push({
            code: 'annotation.bad-opacity',
            message: `Annotation ${a.id} has opacity ${a.opacity}`,
            entityId: a.id,
          });
        }
      }
    }

    const fieldIds = new Set<string>(s.fields.map((f) => f.id));
    for (const f of s.fields) {
      unique(f.id, 'field');
      if (f.parentId && !fieldIds.has(f.parentId)) {
        issues.push({
          code: 'field.missing-parent',
          message: `Field ${f.name} names a parent that is not in the document`,
          entityId: f.id,
        });
      }
      for (const w of f.widgets) {
        if (!pageIds.has(w.pageId)) {
          issues.push({
            code: 'field.widget-orphan-page',
            message: `Widget of ${f.name} is on a page that is not in the document`,
            entityId: f.id,
          });
        }
      }
    }

    const outlineIds = new Set<string>(s.outline.map((o) => o.id));
    for (const o of s.outline) {
      unique(o.id, 'outline');
      if (o.parentId && !outlineIds.has(o.parentId)) {
        issues.push({
          code: 'outline.missing-parent',
          message: `Bookmark "${o.title}" names a parent that is not in the document`,
          entityId: o.id,
        });
      }
      for (const c of o.childIds) {
        if (!outlineIds.has(c)) {
          issues.push({
            code: 'outline.missing-child',
            message: `Bookmark "${o.title}" names a child that is not in the document`,
            entityId: o.id,
          });
        }
      }
    }

    for (const d of s.destinations) {
      unique(d.id, 'destination');
      if (d.pageId !== null && !pageIds.has(d.pageId)) {
        issues.push({
          code: 'destination.orphan-page',
          message: `Destination ${d.name ?? d.id} points at a page that is not in the document`,
          entityId: d.id,
        });
      }
    }

    for (const l of s.layers) unique(l.id, 'layer');
    for (const a of s.attachments) unique(a.id, 'attachment');
    for (const g of s.signatures) unique(g.id, 'signature');

    if (s.pages.length === 0) {
      issues.push({ code: 'document.no-pages', message: 'The document has no pages' });
    }
    return issues;
  }

  /**
   * A structural, JSON-safe copy of the model, without `revision`. Two snapshots compare equal
   * exactly when the documents are in the same state, which is what the property test asserts
   * after undoing everything.
   */
  snapshot(): unknown {
    const s = this.state;
    return JSON.parse(
      JSON.stringify({
        path: s.path,
        title: s.title,
        pages: s.pages,
        annotations: s.annotations,
        fields: s.fields,
        outline: s.outline,
        destinations: s.destinations,
        layers: s.layers,
        attachments: s.attachments,
        metadata: s.metadata,
        security: s.security,
        signatures: s.signatures,
        view: s.view,
        custom: s.custom,
        writeIntents: [...s.writeIntents].sort(),
      }),
    ) as unknown;
  }

  // ---- internals -------------------------------------------------------------------------------

  private assertOpen(): void {
    if (this.closed) throw new Error(`Document ${this.id} is closed`);
  }

  /** Bumps `revision` and recomputes the write intents from the undo journal. */
  private touch(): void {
    const before = this.state.writeIntents;
    const intents = [...new Set([...this.recoveredIntents, ...collectIntents(this.undo.journal)])];
    this.store.set((s) => {
      const changed =
        intents.length !== s.writeIntents.length || intents.some((i, n) => s.writeIntents[n] !== i);
      return changed
        ? { revision: s.revision + 1, writeIntents: intents }
        : { revision: s.revision + 1 };
    });
    for (const intent of intents) {
      if (!before.includes(intent)) this.events.emit({ type: 'writeIntent:added', intent });
    }
    this.events.emit({ type: 'document:revision', revision: this.state.revision });
  }
}

/** Write intents of every command in the journal, de-duplicated and sorted. */
function collectIntents(journal: ReadonlyArray<Command>): WriteIntent[] {
  const set = new Set<WriteIntent>();
  const walk = (commands: ReadonlyArray<Command>): void => {
    for (const c of commands) {
      if (isDocumentCommand(c)) for (const i of c.writeIntents) set.add(i);
      const children = (c as { commands?: ReadonlyArray<Command> }).commands;
      if (children) walk(children);
    }
  };
  walk(journal);
  return [...set].sort();
}

/** A copy of a record without one key.  on a computed key is banned by the lint rules. */
function without<T>(record: Readonly<Record<string, T>>, key: string): Record<string, T> {
  const out: Record<string, T> = {};
  for (const [k, v] of Object.entries(record)) if (k !== key) out[k] = v;
  return out;
}

function pageFromSize(id: ModelId, label: string, size: PageSize): ModelPage {
  return {
    id,
    label,
    rotation: size.rotation,
    mediaBox: size.mediaBox,
    cropBox: size.cropBox,
    bleedBox: null,
    trimBox: null,
    artBox: null,
    objects: null,
  };
}

function isSaneRect(r: PdfRect): boolean {
  return (
    Number.isFinite(r.x0) &&
    Number.isFinite(r.y0) &&
    Number.isFinite(r.x1) &&
    Number.isFinite(r.y1) &&
    r.x1 >= r.x0 &&
    r.y1 >= r.y0
  );
}

/**
 * Builds the field tree from the engine's flat, fully-qualified field list. Intermediate nodes
 * that the file does not define as dictionaries are synthesised so a panel can group by them.
 */
function buildFieldTree(
  fields: ReadonlyArray<FormField>,
  ids: IdAllocator,
  pageIdAt: (index: PageIndex) => ModelId | null,
): ModelField[] {
  const byName = new Map<string, ModelField>();
  const order: string[] = [];

  const ensure = (name: string, synthetic: boolean): ModelField => {
    const existing = byName.get(name);
    if (existing) return existing;
    const dot = name.lastIndexOf('.');
    const parentName = dot > 0 ? name.slice(0, dot) : null;
    const parent = parentName === null ? null : ensure(parentName, true);
    const node: ModelField = {
      id: ids.next('field'),
      name,
      partialName: dot > 0 ? name.slice(dot + 1) : name,
      parentId: parent ? parent.id : null,
      childIds: [],
      type: 'unknown',
      value: '',
      defaultValue: null,
      readOnly: false,
      required: false,
      options: [],
      tooltip: null,
      widgets: [],
      synthetic,
    };
    byName.set(name, node);
    order.push(name);
    if (parent) {
      byName.set(parent.name, { ...parent, childIds: [...parent.childIds, node.id] });
    }
    return node;
  };

  for (const f of fields) {
    const node = ensure(f.name, false);
    const widgets: ModelWidget[] = f.widgets.flatMap((w) => {
      const pageId = pageIdAt(w.page);
      if (pageId === null) return [];
      return [
        {
          id: ids.next('widget'),
          pageId,
          rect: w.rect,
          annotationId: null,
          // The designer's half of a widget, when the adapter could read it (M60, ADR 0019).
          ...(w.appearance ? { appearance: w.appearance } : {}),
        },
      ];
    });
    byName.set(f.name, {
      ...(byName.get(f.name) ?? node),
      type: f.type,
      value: f.value,
      defaultValue: f.defaultValue ?? null,
      readOnly: f.readOnly,
      required: f.required,
      options: f.options ?? [],
      tooltip: f.tooltip ?? null,
      widgets,
      synthetic: false,
      ...(f.design ? { design: f.design } : {}),
    });
  }
  return order.flatMap((n) => {
    const f = byName.get(n);
    return f ? [f] : [];
  });
}

function basename(path: string): string {
  const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return i >= 0 ? path.slice(i + 1) : path;
}

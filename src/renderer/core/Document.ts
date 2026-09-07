/**
 * `Document` — the in-memory model of one open PDF (M00 typed shell; M20 fills it in).
 *
 * The engine is the source of truth for **bytes**; the Document is the source of truth for
 * **intent**: it holds what the user sees (pages, annotations, fields, metadata) and a journal
 * of `Command`s (its `UndoStack`). Saving (M21) replays the journal into the writer.
 *
 * Every change goes through `apply(command)`. Never mutate the engine directly from UI code.
 * Geometry: PDF points, origin bottom-left, page-relative. Page indexes 0-based.
 */

import type {
  Annotation,
  DocHandle,
  FormField,
  Metadata,
  OutlineItem,
  Layer,
  Attachment,
  PdfEngine,
  OpenOptions,
} from '@engine/PdfEngine';
import type { PageIndex, PageSize } from '@shared/pdf';
import type { Command } from './Command';
import { createStore, type Store, type Unsubscribe } from './Store';
import { UndoStack } from './UndoStack';

/** One page as the model sees it. */
export interface PageInfo {
  readonly index: PageIndex;
  readonly label: string;
  readonly size: PageSize;
}

/** Observable document state. Modules subscribe to slices of this via `document.store`. */
export interface DocumentState {
  /** Absolute path on disk, or `null` for a new/unsaved document. */
  readonly path: string | null;
  readonly title: string;
  readonly pages: ReadonlyArray<PageInfo>;
  /** Annotations by page index (only pages that have been loaded). */
  readonly annotations: Readonly<Record<number, ReadonlyArray<Annotation>>>;
  readonly fields: ReadonlyArray<FormField>;
  readonly outline: ReadonlyArray<OutlineItem>;
  readonly layers: ReadonlyArray<Layer>;
  readonly attachments: ReadonlyArray<Attachment>;
  readonly metadata: Metadata | null;
  /** Bumped after every applied command so views can re-render cheaply. */
  readonly revision: number;
}

let nextDocumentId = 1;

export class Document {
  /** Unique per open document in this window (tabs key on it). */
  readonly id: string;
  readonly engine: PdfEngine;
  readonly handle: DocHandle;
  readonly store: Store<DocumentState>;
  readonly undo: UndoStack;

  private constructor(engine: PdfEngine, handle: DocHandle, initial: DocumentState) {
    this.id = `doc-${nextDocumentId++}`;
    this.engine = engine;
    this.handle = handle;
    this.store = createStore(initial);
    this.undo = new UndoStack();
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
    const handle = await engine.open(bytes, openOptions);
    const [count, labels, metadata] = await Promise.all([
      engine.pageCount(handle),
      engine.pageLabels(handle),
      engine.metadata(handle),
    ]);
    const pages: PageInfo[] = [];
    for (let i = 0; i < count; i++) {
      const size = await engine.pageSize(handle, i);
      pages.push({ index: i, label: labels[i] ?? String(i + 1), size });
    }
    const title = metadata.title ?? basename(path ?? options.name ?? 'Untitled');
    return new Document(engine, handle, {
      path: path ?? null,
      title,
      pages,
      annotations: {},
      fields: [],
      outline: [],
      layers: [],
      attachments: [],
      metadata,
      revision: 0,
    });
  }

  get state(): DocumentState {
    return this.store.get();
  }

  get pageCount(): number {
    return this.state.pages.length;
  }

  get isDirty(): boolean {
    return this.undo.isDirty;
  }

  page(index: PageIndex): PageInfo {
    const p = this.state.pages[index];
    if (!p) throw new RangeError(`Page ${index} out of range (0..${this.pageCount - 1})`);
    return p;
  }

  /** Applies a command through the undo stack and bumps `revision`. */
  async apply(command: Command): Promise<void> {
    await this.undo.push(command);
    this.touch();
  }

  /** Groups several commands into one undo entry. */
  async batch(label: string, fn: () => void | Promise<void>): Promise<void> {
    await this.undo.group(label, fn);
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

  /** Reloads structural data from the engine (after page operations). */
  async refreshPages(): Promise<void> {
    const count = await this.engine.pageCount(this.handle);
    const labels = await this.engine.pageLabels(this.handle);
    const pages: PageInfo[] = [];
    for (let i = 0; i < count; i++) {
      const size = await this.engine.pageSize(this.handle, i);
      pages.push({ index: i, label: labels[i] ?? String(i + 1), size });
    }
    this.store.set({ pages });
  }

  /** Loads (or reloads) the annotations of one page into the model. */
  async loadAnnotations(page: PageIndex): Promise<ReadonlyArray<Annotation>> {
    const list = await this.engine.annotations(this.handle, page);
    this.store.set((s) => ({ annotations: { ...s.annotations, [page]: list } }));
    return list;
  }

  /** Serialises via the engine. Marks the undo stack clean on success. */
  async save(): Promise<Uint8Array> {
    const bytes = await this.engine.save(this.handle);
    this.undo.markSaved();
    return bytes;
  }

  subscribe(listener: (state: DocumentState) => void): Unsubscribe {
    return this.store.subscribe(listener);
  }

  /** Closes the engine handle. The document must not be used afterwards. */
  async close(): Promise<void> {
    await this.engine.close(this.handle);
  }

  private touch(): void {
    this.store.set((s) => ({ revision: s.revision + 1 }));
  }
}

function basename(path: string): string {
  const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return i >= 0 ? path.slice(i + 1) : path;
}

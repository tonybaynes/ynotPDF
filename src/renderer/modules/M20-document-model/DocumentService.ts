/**
 * `DocumentService` — the bridge between the shell's tabs and the document model (M20).
 *
 * The shell (M02) knows about tabs: a title, a path, a dirty flag. M20 owns the `Document`
 * behind each one. This service holds the mapping, keeps the tab's title and dirty flag in step
 * with the model, and tells the shell to re-evaluate `when()` clauses whenever the undo stack
 * moves so the ribbon's Undo and Redo buttons enable, disable and rename themselves.
 *
 * Registered as the service `"document"`. M11 (viewer) and M21 (save) take it from here rather
 * than opening documents of their own.
 */

import { Document } from '@core/Document';
import type { PdfEngine } from '@engine/PdfEngine';
import type { OpenOptions } from '@engine/PdfEngine';
import type { Documents, DocumentTab } from '@app/tabs/Documents';
import type { Unsubscribe } from '@core/Store';
import type { UndoStackState } from '@core/UndoStack';

/** The service name modules use with `ctx.service(...)`. */
export const DOCUMENT_SERVICE = 'document';

/** What `open()` gives back. */
export interface OpenedDocument {
  readonly tab: DocumentTab;
  readonly document: Document;
}

export interface OpenDocumentOptions extends OpenOptions {
  /** Absolute path, or null/absent for a document that has never been saved. */
  readonly path?: string | null;
  /** Tab title override; defaults to the document's own title. */
  readonly title?: string;
}

export class DocumentService {
  private readonly documents: Documents;
  private readonly engine: PdfEngine;
  private readonly invalidate: () => void;
  private readonly byTab = new Map<string, Document>();
  private readonly unsubscribes = new Map<string, Unsubscribe[]>();

  constructor(documents: Documents, engine: PdfEngine, invalidate: () => void = () => undefined) {
    this.documents = documents;
    this.engine = engine;
    this.invalidate = invalidate;
    this.documents.onClosed((tab) => {
      void this.dispose(tab.id);
    });
  }

  /** The document of the active tab, or null when no document is open. */
  get active(): Document | null {
    const tab = this.documents.active;
    return tab ? (this.byTab.get(tab.id) ?? null) : null;
  }

  /** The document behind a tab id. */
  get(tabId: string): Document | null {
    return this.byTab.get(tabId) ?? null;
  }

  /** Every open document (M21 autosaves all of them). */
  all(): ReadonlyArray<Document> {
    return [...this.byTab.values()];
  }

  /** The undo state of the active document, or a quiescent one when nothing is open. */
  get undoState(): UndoStackState {
    return (
      this.active?.undo.state ?? {
        canUndo: false,
        canRedo: false,
        undoLabel: null,
        redoLabel: null,
        isDirty: false,
        length: 0,
      }
    );
  }

  /** Opens bytes as a new tab. An already-open path activates its tab instead of reopening. */
  async open(bytes: Uint8Array, options: OpenDocumentOptions = {}): Promise<OpenedDocument> {
    const path = options.path ?? null;
    if (path !== null) {
      const existing = this.documents.tabs.find((t) => t.path === path);
      const doc = existing ? this.byTab.get(existing.id) : undefined;
      if (existing && doc) {
        this.documents.activate(existing.id);
        return { tab: existing, document: doc };
      }
    }
    const document = await Document.open(this.engine, bytes, options);
    const tab = this.documents.open({
      title: options.title ?? document.state.title,
      path,
      readOnly: !document.state.security.permissions.modify,
    });
    this.attach(tab, document);
    return { tab, document };
  }

  /** Registers an already-built document against a tab (used by tests and by M91's creators). */
  attach(tab: DocumentTab, document: Document): void {
    this.byTab.set(tab.id, document);
    this.documents.attach(tab.id, document);
    const subs: Unsubscribe[] = [
      document.undo.subscribe((state) => {
        this.documents.setDirty(tab.id, state.isDirty);
        this.invalidate();
      }),
      document.store.select(
        (s) => s.title,
        (title) => {
          this.documents.update(tab.id, { title });
        },
        { immediate: false },
      ),
    ];
    this.unsubscribes.set(tab.id, subs);
    this.invalidate();
  }

  /** Closes a tab's document and releases its engine handle. */
  async dispose(tabId: string): Promise<void> {
    for (const un of this.unsubscribes.get(tabId) ?? []) un();
    this.unsubscribes.delete(tabId);
    const document = this.byTab.get(tabId);
    this.byTab.delete(tabId);
    if (document) await document.close();
    this.invalidate();
  }

  /** Closes every open document. Called when the window goes away. */
  async disposeAll(): Promise<void> {
    for (const tabId of [...this.byTab.keys()]) await this.dispose(tabId);
  }
}

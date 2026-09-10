/**
 * `DecorationService` (M53, ADR 0020) — headers, footers, Bates numbers, watermarks and
 * backgrounds. Registered as the service `"decorations"`.
 *
 * The whole module runs on one idea: **the model says what the decorations are, and the pages are
 * re-drawn from it.** Adding, changing and removing are all `change()` with a different list, so
 * there is one path through the engine, undo is the same path with the previous list, and a batch
 * replay of the journal produces the same pages.
 *
 * What it owns:
 * - the decoration list in `Document.custom('M53')` and the page captures beside it;
 * - re-applying that list to the live engine, page by page, with a progress dialog when there are
 *   enough pages for it to matter;
 * - finding the decorations a file already carries, so "Update" opens on what the last person
 *   chose even in a document this application has never seen;
 * - the preview the dialogs show, which is the real engine rendering the real page.
 */

import type { ShellServices } from '@app/services';
import type { Registry } from '@core/Registry';
import type { Document } from '@core/Document';
import type { ModelId } from '@core/Ids';
import type { ModelPage } from '@core/model';
import type { PlannedDecoration, PlannedXObject } from '@engine/Writer';
import type { FoundDecoration } from '@engine/decorations/types';
import { asPlannedXObject, XOBJECTS_NAMESPACE } from '@modules/M21-save/plan';
import { VIEWER_SERVICE, type ViewerService } from '@modules/M11-viewer/ViewerService';
import { DOCUMENT_SERVICE, type DocumentService } from '@modules/M20-document-model/manifest';
import {
  SetDecorationsCommand,
  withDecoration,
  withoutDecorations,
  type DecorationApplier,
} from './commands';
import {
  DECORATIONS_NAMESPACE,
  documentContext,
  drawsForPage,
  readDecorationsState,
  readSpec,
  shrinkFor,
  sourceSizes,
  sourcesUsed,
  type DecorationsState,
  type ModelDecoration,
  type PageCapture,
} from './model';

export const DECORATION_SERVICE = 'decorations';

/** Above this many pages, applying gets a progress dialog rather than a frozen window. */
const PROGRESS_THRESHOLD = 24;

/** A decoration the file already carries, as the dialogs need it. */
export interface ExistingDecoration {
  readonly id: string;
  readonly kind: FoundDecoration['kind'];
  /** 0-based page indexes it was found on. */
  readonly pages: ReadonlyArray<number>;
  /** The settings the marker carries, when it has any we understand. */
  readonly spec: ModelDecoration['spec'] | null;
}

export interface DecorationServiceOptions {
  readonly registry: Registry;
  readonly shell: ShellServices;
  /** The clock, injected so tests get a fixed date in a header. */
  readonly now?: () => string;
}

export class DecorationService implements DecorationApplier {
  private readonly registry: Registry;
  private readonly shell: ShellServices;
  private readonly now: () => string;
  /** The content shrink last applied to each page, keyed `documentId|pageId`. */
  private readonly appliedShrink = new Map<string, number>();
  /** Decorations found in a file, per document id — session knowledge, not a document change. */
  private readonly discovered = new Map<string, ReadonlyArray<ExistingDecoration>>();
  private disposed = false;

  constructor(options: DecorationServiceOptions) {
    this.registry = options.registry;
    this.shell = options.shell;
    this.now = options.now ?? ((): string => new Date().toISOString());
  }

  dispose(): void {
    this.disposed = true;
    this.appliedShrink.clear();
    this.discovered.clear();
  }

  // ---- documents -------------------------------------------------------------------------------

  activeDocument(): Document | null {
    if (!this.registry.hasService(DOCUMENT_SERVICE)) return null;
    return this.registry.service<DocumentService>(DOCUMENT_SERVICE).active;
  }

  private viewer(): ViewerService | null {
    return this.registry.hasService(VIEWER_SERVICE)
      ? this.registry.service<ViewerService>(VIEWER_SERVICE)
      : null;
  }

  /** The decorations a document currently has, as the model holds them. */
  state(doc: Document): DecorationsState {
    return readDecorationsState(doc.custom(DECORATIONS_NAMESPACE));
  }

  /** The picture and PDF sources the document carries, by key. */
  private sources(doc: Document): Record<string, PlannedXObject> {
    const out: Record<string, PlannedXObject> = {};
    for (const [key, value] of Object.entries(doc.custom(XOBJECTS_NAMESPACE))) {
      const source = asPlannedXObject(value);
      if (source) out[key] = source;
    }
    return out;
  }

  // ---- applying --------------------------------------------------------------------------------

  /**
   * Puts every decoration the model names on to the live pages, and takes off the ones that are
   * no longer there.
   *
   * Every page that has ever been decorated is visited, not only the ones in the list, because a
   * removal has to clean the page it was on and the list no longer mentions it.
   */
  async reapply(doc: Document, alsoPages: ReadonlyArray<number> = []): Promise<void> {
    if (this.disposed || doc.isClosed) return;
    const state = this.state(doc);
    const document = documentContext(doc, this.now());
    const sizes = sourceSizes(doc.custom(XOBJECTS_NAMESPACE));
    const sources = this.sources(doc);

    const pages = new Map<ModelId, ModelPage>();
    for (const page of doc.state.pages) {
      if (page.id in state.pages) pages.set(page.id, page);
    }
    for (const index of alsoPages) {
      const page = doc.state.pages[index];
      if (page) pages.set(page.id, page);
    }

    const progress =
      pages.size > PROGRESS_THRESHOLD
        ? this.shell.dialogs.progress({
            title: 'Applying to the pages',
            text: `0 of ${String(pages.size)} pages`,
            cancellable: false,
          })
        : null;
    let done = 0;
    try {
      for (const page of pages.values()) {
        const index = doc.enginePage(page.id);
        if (index === undefined) continue;
        const draws = drawsForPage(doc, state, page, document, sizes);
        await this.applyToPage(doc, page, index, draws, sources, shrinkFor(state, page.id));
        done++;
        progress?.set(done / pages.size, `${String(done)} of ${String(pages.size)} pages`);
        // Let the window breathe between pages so the progress bar is not a lie.
        if (done % 8 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
      }
    } finally {
      progress?.close();
    }
    this.repaint(doc, [...pages.keys()].map((id) => doc.enginePage(id)));
  }

  private async applyToPage(
    doc: Document,
    page: ModelPage,
    index: number,
    draws: ReadonlyArray<PlannedDecoration>,
    sources: Readonly<Record<string, PlannedXObject>>,
    shrink: number,
  ): Promise<void> {
    const key = `${doc.id}|${page.id}`;
    const from = this.appliedShrink.get(key) ?? 0;
    await doc.engine.setDecorations(doc.handle, index, draws, {
      sources: sourcesUsed(draws, sources),
      shrink: { from, to: shrink },
    });
    if (shrink > 0) this.appliedShrink.set(key, shrink);
    else this.appliedShrink.delete(key);
  }

  /** Drops the tiles of the pages that changed and repaints. */
  private repaint(doc: Document, pages: ReadonlyArray<number | undefined>): void {
    const viewer = this.viewer();
    if (!viewer || !this.registry.hasService(DOCUMENT_SERVICE)) return;
    const documents = this.registry.service<DocumentService>(DOCUMENT_SERVICE);
    for (const tab of this.shell.documents.state.tabs) {
      if (documents.get(tab.id) !== doc) continue;
      for (const page of pages) {
        if (page !== undefined) viewer.renderer.forgetPage(tab.id, page);
      }
      viewer.get(tab.id)?.refresh();
    }
  }

  // ---- changing --------------------------------------------------------------------------------

  /**
   * Applies a change to the decoration list as one undoable command.
   *
   * The page captures are taken **here**, before anything is drawn, because after the first
   * `setDecorations` the page's content is PDFium's regeneration of it rather than the file's own
   * bytes — and the captured bytes are what the writer puts back (ADR 0020 §3).
   */
  async change(
    doc: Document,
    label: string,
    mutate: (state: DecorationsState) => DecorationsState,
  ): Promise<void> {
    const before = this.state(doc);
    const next = mutate(before);
    const wanted = new Set<ModelId>();
    for (const item of next.items) for (const id of item.pages) wanted.add(id);
    for (const item of before.items) for (const id of item.pages) wanted.add(id);

    const captures: Record<string, PageCapture> = { ...before.pages, ...next.pages };
    for (const id of wanted) {
      if (id in captures) continue;
      const index = doc.enginePage(id);
      if (index === undefined) continue;
      const capture = await this.capture(doc, index);
      if (capture) captures[id] = capture;
    }

    const touched: number[] = [];
    for (const id of wanted) {
      const index = doc.enginePage(id);
      if (index !== undefined) touched.push(index);
    }

    await doc.apply(
      new SetDecorationsCommand({
        doc,
        label,
        next: { ...next, pages: captures },
        applier: this,
        touched,
      }),
    );
  }

  /**
   * The page's content and resources as they are now.
   *
   * A page that cannot be read is not a reason to refuse the decoration: it simply keeps whatever
   * the engine writes, which is what happened before this module existed.
   */
  private async capture(doc: Document, index: number): Promise<PageCapture | null> {
    try {
      const content = await doc.engine.pageContent(doc.handle, index);
      return { original: toBase64(content.content), resources: content.resources };
    } catch {
      return null;
    }
  }

  /** Adds or replaces one decoration. */
  async put(doc: Document, decoration: ModelDecoration, label: string): Promise<void> {
    await this.change(doc, label, (state) => withDecoration(state, decoration));
  }

  /** Removes every decoration of a kind. Resolves to how many went. */
  async removeKind(doc: Document, kind: ModelDecoration['kind'], label: string): Promise<number> {
    const state = this.state(doc);
    const ids = new Set(state.items.filter((d) => d.kind === kind).map((d) => d.id));
    const found = (await this.existing(doc)).filter((d) => d.kind === kind);
    if (ids.size === 0 && found.length === 0) return 0;
    await this.change(doc, label, (current) => {
      const cleared = withoutDecorations(current, ids);
      // A decoration that came from the file is not in the list, so removing it means telling the
      // writer about the pages it was on. Adding the capture is what does that.
      return { ...cleared, pages: { ...cleared.pages } };
    });
    if (found.length > 0) await this.clearFound(doc, found);
    return ids.size + found.length;
  }

  /** Removes every decoration this application put on the document. */
  async removeAll(doc: Document, label: string): Promise<number> {
    const state = this.state(doc);
    const found = await this.existing(doc);
    if (state.items.length === 0 && found.length === 0) return 0;
    const count = state.items.length + found.length;
    await this.change(doc, label, (current) => ({ ...current, items: [] }));
    if (found.length > 0) await this.clearFound(doc, found);
    return count;
  }

  /**
   * Takes decorations the *file* carried off the live pages.
   *
   * They were never in the model, so `reapply` has nothing to remove: it draws the model's list
   * on each page, and the engine's replace-everything call takes the file's own ones off at the
   * same time. This is that call for the pages the model does not mention at all.
   */
  private async clearFound(
    doc: Document,
    found: ReadonlyArray<ExistingDecoration>,
  ): Promise<void> {
    const pages = new Set<number>();
    for (const item of found) for (const page of item.pages) pages.add(page);
    for (const page of pages) {
      await doc.engine.setDecorations(doc.handle, page, [], {});
    }
    this.discovered.set(doc.id, []);
    this.repaint(doc, [...pages]);
  }

  // ---- what a file already carries ---------------------------------------------------------------

  /**
   * The decorations the open file carries that this session did not put there.
   *
   * Scanned once per document and kept in the service rather than in the model: they are already
   * in the file, so recording them as a change would make an untouched document dirty and make a
   * no-op save rewrite every page.
   */
  async existing(doc: Document): Promise<ReadonlyArray<ExistingDecoration>> {
    const cached = this.discovered.get(doc.id);
    if (cached) return cached;
    const ours = new Set(this.state(doc).items.map((d) => d.id));
    const byId = new Map<string, { kind: FoundDecoration['kind']; pages: number[]; spec: string | null }>();
    const count = doc.state.pages.length;
    const progress =
      count > 200
        ? this.shell.dialogs.progress({
            title: 'Looking for existing marks',
            text: `0 of ${String(count)} pages`,
            cancellable: false,
          })
        : null;
    try {
      for (let i = 0; i < count; i++) {
        const page = doc.state.pages[i];
        const index = page ? doc.enginePage(page.id) : undefined;
        if (index === undefined) continue;
        let found: ReadonlyArray<FoundDecoration> = [];
        try {
          found = await doc.engine.decorations(doc.handle, index);
        } catch {
          found = [];
        }
        for (const item of found) {
          if (ours.has(item.id)) continue;
          const entry = byId.get(item.id) ?? { kind: item.kind, pages: [], spec: item.spec };
          entry.pages.push(i);
          byId.set(item.id, entry);
        }
        if (progress && i % 16 === 0) {
          progress.set(i / count, `${String(i)} of ${String(count)} pages`);
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
      }
    } finally {
      progress?.close();
    }
    const out: ExistingDecoration[] = [];
    for (const [id, entry] of byId) {
      let spec: ModelDecoration['spec'] | null = null;
      if (entry.spec) {
        try {
          spec = readSpec(JSON.parse(entry.spec));
        } catch {
          spec = null;
        }
      }
      out.push({ id, kind: entry.kind, pages: entry.pages, spec });
    }
    this.discovered.set(doc.id, out);
    return out;
  }

  /** Forgets what was found in a document, so a reload scans again. */
  forget(documentId: string): void {
    this.discovered.delete(documentId);
    for (const key of [...this.appliedShrink.keys()]) {
      if (key.startsWith(`${documentId}|`)) this.appliedShrink.delete(key);
    }
  }

  /**
   * The decoration of a kind the dialog should open on: this session's if there is one, otherwise
   * the file's own.
   */
  async currentOf(
    doc: Document,
    kind: ModelDecoration['kind'],
  ): Promise<{ decoration: ModelDecoration | null; existing: ExistingDecoration | null }> {
    const mine = this.state(doc).items.find((d) => d.kind === kind) ?? null;
    if (mine) return { decoration: mine, existing: null };
    const found = (await this.existing(doc)).find((d) => d.kind === kind && d.spec !== null);
    return { decoration: null, existing: found ?? null };
  }
}

/** Base64 of some bytes, in chunks so a large page does not blow the argument limit. */
export function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

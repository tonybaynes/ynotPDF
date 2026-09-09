/**
 * M40's document commands: the page surgery that M20's thirteen commands did not already cover.
 *
 * The rules are M20's (`src/renderer/core/commands.ts`) and are followed exactly:
 *
 * - **the model first**, because it is the authority for intent;
 * - **then the engine**, so a render reflects the edit at once;
 * - **a `WriteIntent`** for whatever the engine cannot express, so M21's writer applies it;
 * - **plain data in `toJSON`**, so the journal can replay the command after a crash.
 *
 * Which is which here. Page *order* never goes to the engine — `FPDFPage_Delete` cannot be undone,
 * so an engine-backed reorder or delete would make undo a lie (ADR 0007). Page *content* does:
 * importing pages is `FPDF_ImportPagesByIndex`, and like M20's blank insert it appends at the
 * engine's own end so no existing engine index shifts and undo is a delete of the highest ones.
 *
 * Reuse rather than repetition: rotate, delete, insert-blank and set-one-label are M20's
 * commands and this module calls them. What is here is what was missing.
 */

import type { Command, CommandJson } from '@core/Command';
import type { Document, DocumentCommand } from '@core/Document';
import type { ModelId } from '@core/Ids';
import { registerCommandCodec } from '@core/Journal';
import type { ModelOutlineItem, ModelPage, WriteIntent } from '@core/model';
import { EngineError } from '@engine/PdfEngine';
import type { PdfRect } from '@shared/pdf';
import { closeQuietly } from './extract';
import {
  positionOf,
  removeSubtree,
  restoreSubtree,
  subtreeOf,
  type Position,
} from '@modules/M12-navigation-panels/bookmarks/tree';

/** Command ids, so the journal, the palette and the tests all name the same thing. */
export const ORGANISE_COMMAND_ID = {
  reorderPages: 'page.reorder',
  importPages: 'page.import',
  setPageLabels: 'page.labels',
  pruneOutline: 'page.pruneOutline',
} as const;

/** True when an engine rejection means "this backend cannot do that", not "that went wrong". */
function isUnsupported(error: unknown): boolean {
  return error instanceof EngineError && error.code === 'not-implemented';
}

/** Runs an engine call, reporting whether it happened. Real failures still propagate. */
async function tryEngine(fn: () => Promise<unknown>): Promise<boolean> {
  try {
    await fn();
    return true;
  } catch (error) {
    if (isUnsupported(error)) return false;
    throw error;
  }
}

/** Base class: the M20 shape — holds the document, tracks what the engine refused. */
abstract class OrganiseCommand implements DocumentCommand {
  abstract readonly id: string;
  abstract readonly label: string;
  protected readonly doc: Document;
  private intents: WriteIntent[] = [];

  constructor(doc: Document) {
    this.doc = doc;
  }

  get writeIntents(): ReadonlyArray<WriteIntent> {
    return this.intents;
  }

  protected intend(...intents: WriteIntent[]): void {
    for (const i of intents) if (!this.intents.includes(i)) this.intents.push(i);
  }

  abstract do(): Promise<void>;
  abstract undo(): Promise<void>;
  abstract toJSON(): CommandJson;
}

// ---- reordering --------------------------------------------------------------------------------

/**
 * Puts the pages in a given order. Model-only, with a `page-order` write intent.
 *
 * This is the *only* reordering command in the module, and everything that rearranges pages goes
 * through it: move, reverse, swap, "send to front", and a drag of any number of thumbnails. They
 * differ in their label and in nothing else, so there is one thing to get right, one codec, and
 * one undo entry however many pages moved.
 *
 * Nothing else has to be updated when pages move. Annotations are filed under a page id, and
 * destinations and field widgets name one (M20) — so the whole operation is one array.
 */
export class ReorderPagesCommand extends OrganiseCommand {
  readonly id = ORGANISE_COMMAND_ID.reorderPages;
  readonly label: string;
  private readonly order: ReadonlyArray<ModelId>;
  private before: ReadonlyArray<ModelId> = [];

  constructor(doc: Document, order: ReadonlyArray<ModelId>, label = 'Move pages') {
    super(doc);
    this.order = [...order];
    this.label = label;
  }

  /** True when this would leave the document exactly as it is; the caller skips it. */
  get isNoop(): boolean {
    const now = this.doc.state.pages.map((p) => p.id);
    const next = this.resolve(this.order);
    return next.length === now.length && next.every((id, i) => now[i] === id);
  }

  do(): Promise<void> {
    this.before = this.doc.state.pages.map((p) => p.id);
    this.apply(this.order);
    this.intend('page-order');
    return Promise.resolve();
  }

  undo(): Promise<void> {
    this.apply(this.before);
    return Promise.resolve();
  }

  /**
   * Rearranges by moving each page into place from the front. `movePageRecord` is the model
   * primitive, and doing it in target order means every page below the cursor is already right,
   * so one pass is enough and each move emits the `page:moved` event a panel listens for.
   */
  private apply(order: ReadonlyArray<ModelId>): void {
    const wanted = this.resolve(order);
    wanted.forEach((id, index) => {
      if (this.doc.pageIndex(id) !== index) this.doc.movePageRecord(id, index);
    });
  }

  /**
   * The requested order, restricted to pages the document still has and completed with any it
   * does not mention. A journal replayed against a document that has since lost a page must not
   * silently drop every page the entry forgot to name.
   */
  private resolve(order: ReadonlyArray<ModelId>): ModelId[] {
    const present = new Set(this.doc.state.pages.map((p) => p.id));
    const named = order.filter((id) => present.has(id));
    const seen = new Set(named);
    const rest = this.doc.state.pages.map((p) => p.id).filter((id) => !seen.has(id));
    return [...named, ...rest];
  }

  toJSON(): CommandJson {
    return { id: this.id, data: { order: this.order, label: this.label } };
  }
}

/** The page order that moves `moving` so it sits before `target` (or at the end for `null`). */
export function orderAfterMove(
  pages: ReadonlyArray<ModelId>,
  moving: ReadonlyArray<ModelId>,
  insertBefore: number,
): ModelId[] {
  const set = new Set(moving);
  // Where the insertion point lands once the moved pages are out of the way.
  const removedBefore = pages
    .slice(0, Math.max(0, insertBefore))
    .filter((id) => set.has(id)).length;
  const rest = pages.filter((id) => !set.has(id));
  const at = Math.max(0, Math.min(insertBefore - removedBefore, rest.length));
  // The moved pages keep their relative order, which is what a multi-selection drag means.
  const ordered = pages.filter((id) => set.has(id));
  return [...rest.slice(0, at), ...ordered, ...rest.slice(at)];
}

/** The page order with two pages exchanged. */
export function orderAfterSwap(pages: ReadonlyArray<ModelId>, a: ModelId, b: ModelId): ModelId[] {
  const out = [...pages];
  const i = out.indexOf(a);
  const j = out.indexOf(b);
  if (i < 0 || j < 0) return out;
  out[i] = b;
  out[j] = a;
  return out;
}

/** The page order with a set of pages reversed among themselves, in place. */
export function orderAfterReverse(
  pages: ReadonlyArray<ModelId>,
  reversing: ReadonlyArray<ModelId>,
): ModelId[] {
  const set = new Set(reversing);
  const slots = pages.map((id, i) => (set.has(id) ? i : -1)).filter((i) => i >= 0);
  const chosen = slots.map((i) => pages[i]).filter((id): id is ModelId => id !== undefined);
  const out = [...pages];
  slots.forEach((slot, k) => {
    const id = chosen[chosen.length - 1 - k];
    if (id !== undefined) out[slot] = id;
  });
  return out;
}

// ---- importing pages ---------------------------------------------------------------------------

/** A bookmark to graft in with the imported pages, naming its page by position in `pages`. */
export interface ImportedBookmark {
  readonly title: string;
  /** Index into the imported `pages` array, or `null` for a bookmark with no destination. */
  readonly page: number | null;
  /** Index into this same array of the parent bookmark, or `null` for a root. */
  readonly parent: number | null;
  readonly bold?: boolean;
  readonly italic?: boolean;
  readonly color?: number | null;
}

export interface ImportPagesOptions {
  /** The source document, as bytes. The command owns them, so it can replay itself. */
  readonly bytes: Uint8Array;
  /** 0-based pages of the source to bring in, in the order they should appear. */
  readonly pages: ReadonlyArray<number>;
  /** Visual index in *this* document to insert before. */
  readonly at: number;
  /** Sizes of the imported pages, so the model records are right without re-reading them. */
  readonly sizes: ReadonlyArray<{ readonly width: number; readonly height: number }>;
  /** Labels the imported pages should carry. Defaults to their new position. */
  readonly labels?: ReadonlyArray<string>;
  /** Bookmarks to bring across with the pages. */
  readonly bookmarks?: ReadonlyArray<ImportedBookmark>;
  readonly label?: string;
  /** Ids to reuse, so a journal replay produces the same ones the original run minted. */
  readonly pageIds?: ReadonlyArray<ModelId>;
  readonly bookmarkIds?: ReadonlyArray<ModelId>;
  readonly destinationIds?: ReadonlyArray<ModelId>;
}

/**
 * Brings pages in from another document — Insert from File, Insert from Clipboard, Duplicate,
 * Replace and the copy half of a cross-document drag are all this command.
 *
 * It carries the source **bytes** rather than a handle, and opens them itself. Three things fall
 * out of that: the caller never has to manage a second handle's lifetime; the command is
 * genuinely replayable, so a crash recovery puts the inserted pages back rather than reporting
 * that it could not; and a duplicate is simply an import whose bytes are this document's own.
 *
 * The engine copy lands at the engine's **end** (`importPages(..., at = engineCount)`), so no
 * page already bound keeps a stale index, and undo deletes the highest indexes — the trick M20
 * used for blank pages, and the reason undoing an insert cannot corrupt the id table.
 */
export class ImportPagesCommand extends OrganiseCommand {
  readonly id = ORGANISE_COMMAND_ID.importPages;
  readonly label: string;
  private readonly options: ImportPagesOptions;
  private readonly bytes: Uint8Array;
  private created: ModelId[];
  private bookmarkIds: ModelId[];
  private destinationIds: ModelId[];
  private grafted: ReadonlyArray<ModelId> = [];

  constructor(doc: Document, options: ImportPagesOptions) {
    super(doc);
    this.options = options;
    // Our own copy: the engine *transfers* a Uint8Array into its worker, which detaches the
    // buffer on this side — the bug M12 met with attachments. A redo would otherwise import
    // nothing at all.
    this.bytes = new Uint8Array(options.bytes);
    this.created = [...(options.pageIds ?? [])];
    this.bookmarkIds = [...(options.bookmarkIds ?? [])];
    this.destinationIds = [...(options.destinationIds ?? [])];
    const n = options.pages.length;
    this.label = options.label ?? (n === 1 ? 'Insert page' : `Insert ${String(n)} pages`);
  }

  /** The pages this command created, in order. Empty until it has run. */
  get pageIds(): ReadonlyArray<ModelId> {
    return this.created;
  }

  async do(): Promise<void> {
    const { pages, at, sizes } = this.options;
    if (pages.length === 0) return;
    const engineCount = await this.doc.engine.pageCount(this.doc.handle);
    const applied = await this.copyIntoEngine(engineCount);
    if (!applied) this.intend('page-order');

    if (this.created.length === 0) {
      this.created = pages.map(() => this.doc.ids.next('page'));
    }
    this.created.forEach((id, i) => {
      if (applied) this.doc.idTable.bind('page', id, String(engineCount + i));
      const size = sizes[i] ?? { width: 595.276, height: 841.89 };
      const box: PdfRect = { x0: 0, y0: 0, x1: size.width, y1: size.height };
      const page: ModelPage = {
        id,
        label: this.options.labels?.[i] ?? String(at + i + 1),
        rotation: 0,
        mediaBox: box,
        cropBox: box,
        bleedBox: null,
        trimBox: null,
        artBox: null,
        objects: null,
      };
      this.doc.insertPageRecord(page, at + i);
    });
    this.graftBookmarks();
    this.intend('page-order', 'page-labels');
  }

  /**
   * Opens the source, copies the pages in and closes it again. The handle never escapes this
   * method, so an import that throws part-way cannot leak a document into the engine.
   */
  private async copyIntoEngine(at: number): Promise<boolean> {
    let source;
    try {
      source = await this.doc.engine.open(new Uint8Array(this.bytes), { name: 'inserted.pdf' });
    } catch (error) {
      if (isUnsupported(error)) return false;
      throw error;
    }
    try {
      return await tryEngine(() =>
        this.doc.engine.importPages(this.doc.handle, source, this.options.pages, at),
      );
    } finally {
      await closeQuietly(this.doc.engine, source);
    }
  }

  /** Adds the source's bookmarks for the imported pages, pointing at their new model pages. */
  private graftBookmarks(): void {
    const incoming = this.options.bookmarks ?? [];
    if (incoming.length === 0) return;
    if (this.bookmarkIds.length === 0) {
      this.bookmarkIds = incoming.map(() => this.doc.ids.next('outline'));
    }
    if (this.destinationIds.length === 0) {
      this.destinationIds = incoming.map(() => this.doc.ids.next('destination'));
    }
    const items: ModelOutlineItem[] = [];
    incoming.forEach((source, i) => {
      const id = this.bookmarkIds[i];
      if (id === undefined) return;
      const pageId = source.page === null ? null : (this.created[source.page] ?? null);
      const parentIndex = source.parent;
      const parentId =
        parentIndex === null || parentIndex < 0 || parentIndex >= i
          ? null
          : (this.bookmarkIds[parentIndex] ?? null);
      let destinationId: ModelId | null = null;
      if (pageId !== null) {
        destinationId = this.destinationIds[i] ?? null;
        if (destinationId !== null) {
          this.doc.putDestinationRecord({
            id: destinationId,
            name: null,
            pageId,
            fit: 'xyz',
            left: null,
            top: null,
            zoom: null,
            rect: null,
          });
        }
      }
      items.push({
        id,
        title: source.title,
        parentId,
        childIds: [],
        destinationId,
        uri: null,
        open: true,
        bold: source.bold ?? false,
        italic: source.italic ?? false,
        color: source.color ?? null,
      });
    });
    // Children are listed on their parent; the tree is otherwise parents-before-children already.
    const withChildren = items.map((item) => ({
      ...item,
      childIds: items.filter((c) => c.parentId === item.id).map((c) => c.id),
    }));
    this.doc.setOutlineRecord([...this.doc.state.outline, ...withChildren]);
    this.grafted = withChildren.map((i) => i.id);
    this.intend('outline');
  }

  async undo(): Promise<void> {
    for (const id of this.grafted) {
      this.doc.setOutlineRecord(removeSubtree(this.doc.state.outline, id).list);
    }
    for (const id of this.destinationIds) this.doc.removeDestinationRecord(id);
    this.grafted = [];
    // Every engine index first: deleting one at a time renumbers the rest (M20's bug).
    const indexes: number[] = [];
    for (const id of this.created) {
      const index = this.doc.enginePage(id);
      if (index !== undefined) indexes.push(index);
      this.doc.removePageRecord(id);
      this.doc.idTable.unbind('page', id);
    }
    if (indexes.length > 0) {
      await tryEngine(() => this.doc.engine.deletePages(this.doc.handle, indexes));
    }
  }

  toJSON(): CommandJson {
    // The ids go in the journal: a later entry naming an inserted page by id would otherwise
    // find nothing on a replay and silently do nothing while reporting success (M20's bug).
    return {
      id: this.id,
      data: {
        bytes: toBase64(this.bytes),
        pages: this.options.pages,
        at: this.options.at,
        sizes: this.options.sizes,
        labels: this.options.labels ?? null,
        bookmarks: this.options.bookmarks ?? null,
        label: this.label,
        pageIds: this.created,
        bookmarkIds: this.bookmarkIds,
        destinationIds: this.destinationIds,
      },
    };
  }
}

// ---- page labels -------------------------------------------------------------------------------

/**
 * Renumbers a run of pages in one step.
 *
 * M20 has `SetPageLabelCommand` for renaming *one* page, and labelling a range through it would
 * be one undo entry per page (its `merge` only collapses repeats of the same page). Labelling is
 * a single act to the reader, so it is a single command: it carries the pages it changed and
 * their previous labels, and undo puts every one of them back.
 */
export class SetPageLabelsCommand extends OrganiseCommand {
  readonly id = ORGANISE_COMMAND_ID.setPageLabels;
  readonly label: string;
  private readonly entries: ReadonlyArray<{ readonly pageId: ModelId; readonly label: string }>;
  private before: Array<{ pageId: ModelId; label: string }> = [];

  constructor(
    doc: Document,
    entries: ReadonlyArray<{ readonly pageId: ModelId; readonly label: string }>,
    label?: string,
  ) {
    super(doc);
    this.entries = [...entries];
    this.label =
      label ??
      (entries.length === 1 ? 'Renumber page' : `Renumber ${String(entries.length)} pages`);
  }

  do(): Promise<void> {
    this.before = [];
    for (const { pageId, label } of this.entries) {
      const page = this.doc.pageById(pageId);
      if (!page) continue;
      this.before.push({ pageId, label: page.label });
      this.doc.replacePage(pageId, (p) => ({ ...p, label }), 'label');
    }
    // PDFium has no `/PageLabels` setter, so this is always the writer's to apply.
    this.intend('page-labels');
    return Promise.resolve();
  }

  undo(): Promise<void> {
    for (const { pageId, label } of this.before) {
      this.doc.replacePage(pageId, (p) => ({ ...p, label }), 'label');
    }
    return Promise.resolve();
  }

  toJSON(): CommandJson {
    return { id: this.id, data: { entries: this.entries, label: this.label } };
  }
}

// ---- pruning the outline -----------------------------------------------------------------------

/**
 * Removes bookmarks whose destination page is gone, with everything under them.
 *
 * Deleting a page leaves any bookmark aimed at it pointing at nothing. M21's writer already
 * prunes the dead `/Dest` on the way out, so the file is never wrong either way; the question is
 * what the reader sees in the Bookmarks panel *now*. This brief asks for Foxit's answer — the
 * heading goes — so this runs in the same undo entry as the delete and one Ctrl+Z restores both.
 * The setting `organise.pruneBookmarksOnDelete` turns it off for anyone who would rather keep the
 * heading, which is M21's own reasoning.
 */
export class PruneOutlineCommand extends OrganiseCommand {
  readonly id = ORGANISE_COMMAND_ID.pruneOutline;
  readonly label: string;
  private readonly bookmarkIds: ReadonlyArray<ModelId>;
  private removed: Array<{ items: ReadonlyArray<ModelOutlineItem>; at: Position }> = [];

  constructor(doc: Document, bookmarkIds: ReadonlyArray<ModelId>) {
    super(doc);
    this.bookmarkIds = [...bookmarkIds];
    this.label =
      bookmarkIds.length === 1
        ? 'Remove bookmark'
        : `Remove ${String(bookmarkIds.length)} bookmarks`;
  }

  do(): Promise<void> {
    this.removed = [];
    for (const id of this.bookmarkIds) {
      if (!this.doc.outlineItem(id)) continue;
      const at = positionOf(this.doc.state.outline, id) ?? { parentId: null, index: 0 };
      const items = subtreeOf(this.doc.state.outline, id);
      if (items.length === 0) continue;
      this.doc.setOutlineRecord(removeSubtree(this.doc.state.outline, id).list);
      this.removed.push({ items, at });
    }
    if (this.removed.length > 0) this.intend('outline');
    return Promise.resolve();
  }

  undo(): Promise<void> {
    // Last removed first: an earlier removal's position was recorded against a longer list.
    for (const { items, at } of [...this.removed].reverse()) {
      this.doc.setOutlineRecord(restoreSubtree(this.doc.state.outline, items, at));
    }
    return Promise.resolve();
  }

  toJSON(): CommandJson {
    return { id: this.id, data: { bookmarkIds: this.bookmarkIds } };
  }
}

/**
 * Bookmarks whose destination names a page that is about to go, deepest first.
 *
 * Deepest first matters: removing a parent takes its children with it, and a child listed
 * afterwards would then not be found. Sorting by depth means every id is still there when its
 * turn comes.
 */
export function danglingBookmarks(doc: Document, goingPageIds: ReadonlySet<string>): ModelId[] {
  const outline = doc.state.outline;
  const aimedAtGoing = (item: ModelOutlineItem): boolean => {
    if (item.destinationId === null) return false;
    const dest = doc.destination(item.destinationId);
    return dest?.pageId != null && goingPageIds.has(dest.pageId);
  };
  const depth = (item: ModelOutlineItem): number => {
    let n = 0;
    let parent = item.parentId;
    while (parent !== null && n < 64) {
      n++;
      parent = doc.outlineItem(parent)?.parentId ?? null;
    }
    return n;
  };
  return outline
    .filter(aimedAtGoing)
    .sort((a, b) => depth(b) - depth(a))
    .map((i) => i.id);
}

// ---- base64, for the journal ---------------------------------------------------------------------

/**
 * Bytes as base64. The journal is JSON, and a `Uint8Array` written as an array of numbers costs
 * roughly four characters a byte where base64 costs one and a third — which matters when the
 * thing being recorded is an inserted PDF and the file it lands in is a crash-recovery record.
 */
export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  // `charCodeAt` by index, not a spread: `atob` returns one byte per UTF-16 unit, and splitting
  // it by code point would merge a surrogate pair and lose a byte of the PDF.
  for (let i = 0; i < out.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

// ---- journal codecs ------------------------------------------------------------------------------

const asRecord = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
const asIds = (v: unknown): ModelId[] | null =>
  Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as ModelId[]) : null;
const asNumbers = (v: unknown): number[] | null =>
  Array.isArray(v) && v.every((x) => typeof x === 'number') ? v : null;
const asString = (v: unknown): string | null => (typeof v === 'string' ? v : null);

let registered = false;

/** Registers M40's codecs. Idempotent — the manifest may activate more than once in tests. */
export function registerOrganiseCodecs(): void {
  if (registered) return;
  registered = true;

  registerCommandCodec(ORGANISE_COMMAND_ID.reorderPages, (doc, payload) => {
    const p = asRecord(payload);
    const order = asIds(p['order']);
    if (!order) return null;
    return new ReorderPagesCommand(doc, order, asString(p['label']) ?? 'Move pages');
  });

  registerCommandCodec(ORGANISE_COMMAND_ID.importPages, (doc, payload) => {
    const p = asRecord(payload);
    const base64 = asString(p['bytes']);
    const pages = asNumbers(p['pages']);
    const at = p['at'];
    if (base64 === null || !pages || typeof at !== 'number') return null;
    const sizes = Array.isArray(p['sizes'])
      ? (p['sizes'] as ReadonlyArray<{ width: number; height: number }>)
      : [];
    const pageIds = asIds(p['pageIds']) ?? [];
    for (const id of pageIds) doc.ids.reserve(id);
    const bookmarkIds = asIds(p['bookmarkIds']) ?? [];
    for (const id of bookmarkIds) doc.ids.reserve(id);
    const destinationIds = asIds(p['destinationIds']) ?? [];
    for (const id of destinationIds) doc.ids.reserve(id);
    const label = asString(p['label']);
    const labels = Array.isArray(p['labels']) ? (p['labels'] as string[]) : undefined;
    const bookmarks = Array.isArray(p['bookmarks'])
      ? (p['bookmarks'] as ReadonlyArray<ImportedBookmark>)
      : undefined;
    return new ImportPagesCommand(doc, {
      bytes: fromBase64(base64),
      pages,
      at,
      sizes,
      ...(labels ? { labels } : {}),
      ...(bookmarks ? { bookmarks } : {}),
      ...(label === null ? {} : { label }),
      pageIds,
      bookmarkIds,
      destinationIds,
    });
  });

  registerCommandCodec(ORGANISE_COMMAND_ID.setPageLabels, (doc, payload) => {
    const p = asRecord(payload);
    const raw = p['entries'];
    if (!Array.isArray(raw)) return null;
    const entries = raw.filter(
      (e): e is { pageId: ModelId; label: string } =>
        !!e &&
        typeof e === 'object' &&
        typeof (e as { pageId?: unknown }).pageId === 'string' &&
        typeof (e as { label?: unknown }).label === 'string',
    );
    if (entries.length !== raw.length) return null;
    return new SetPageLabelsCommand(doc, entries, asString(p['label']) ?? undefined);
  });

  registerCommandCodec(ORGANISE_COMMAND_ID.pruneOutline, (doc, payload) => {
    const ids = asIds(asRecord(payload)['bookmarkIds']);
    return ids ? new PruneOutlineCommand(doc, ids) : null;
  });
}

/** Re-exported for the tests, which need to know a command is a `Command`. */
export type { Command };

/**
 * Portfolio commands (M42, ADR 0014).
 *
 * The portfolio is one immutable value in the document's custom bag, so almost every edit —
 * add, remove, rename, describe, move between folders, reorder, sort, view, initial file, a new
 * schema column, a value in one — is the same operation: swap the value, and swap it back to
 * undo. That is why there is one command class here rather than fourteen, and why undo is exact
 * by construction rather than by fourteen separate arguments.
 *
 * Two things are not a value swap and have their own command. Replacing a file's content
 * changes bytes as well as structure, and the cover sheet is a *page*, which lives in the engine
 * rather than in the bag.
 */

import type { Command, CommandJson } from '@core/Command';
import type { Document, DocumentCommand } from '@core/Document';
import type { WriteIntent } from '@core/model';
import {
  blobKey,
  PORTFOLIO_KEY,
  PORTFOLIO_NAMESPACE,
  portfolioOf,
  type Portfolio,
} from '@shared/portfolio';

export const PORTFOLIO_COMMAND_ID = {
  edit: 'portfolio.edit',
  replaceFile: 'portfolio.replaceFile',
  cover: 'portfolio.cover',
} as const;

/** Reads the portfolio a document holds. */
export function portfolioOfDocument(doc: Document): Portfolio | null {
  return portfolioOf(doc.custom(PORTFOLIO_NAMESPACE));
}

/** Writes it back, without a command — for the initial read, which is not an edit. */
export function setPortfolioRecord(doc: Document, portfolio: Portfolio | null): void {
  if (portfolio === null) doc.deleteCustomRecord(PORTFOLIO_NAMESPACE);
  else doc.replaceCustomRecord(PORTFOLIO_NAMESPACE, { [PORTFOLIO_KEY]: portfolio });
}

/**
 * One structural change, as before-and-after.
 *
 * `mergeKey` lets consecutive edits of the same thing coalesce: typing in a description box
 * produces one undo entry rather than one per keystroke. Edits with no key never merge.
 */
export class PortfolioEditCommand implements DocumentCommand {
  readonly id = PORTFOLIO_COMMAND_ID.edit;
  readonly label: string;
  readonly writeIntents: ReadonlyArray<WriteIntent> = ['portfolio'];
  private readonly doc: Document;
  private readonly before: Portfolio | null;
  private after: Portfolio;
  private readonly mergeKey: string | null;
  /** Bytes this edit brought in, so a redo after an undo still has them. */
  private readonly blobs: ReadonlyArray<{ readonly key: string; readonly bytes: Uint8Array }>;

  constructor(
    doc: Document,
    label: string,
    after: Portfolio,
    options: {
      readonly mergeKey?: string;
      readonly blobs?: ReadonlyArray<{ readonly key: string; readonly bytes: Uint8Array }>;
    } = {},
  ) {
    this.doc = doc;
    this.label = label;
    this.after = after;
    this.before = portfolioOfDocument(doc);
    this.mergeKey = options.mergeKey ?? null;
    this.blobs = options.blobs ?? [];
  }

  do(): void {
    // Bytes go in before the structure does, so nothing ever sees a file it cannot read. They
    // are deliberately not removed on undo: a redo needs them, and they cost nothing until a
    // save asks for them.
    for (const blob of this.blobs) this.doc.blobs.set(blob.key, blob.bytes);
    setPortfolioRecord(this.doc, this.after);
  }

  undo(): void {
    setPortfolioRecord(this.doc, this.before);
  }

  merge(next: Command): Command | null {
    if (this.mergeKey === null) return null;
    if (!(next instanceof PortfolioEditCommand)) return null;
    if (next.mergeKey !== this.mergeKey) return null;
    this.after = next.after;
    return this;
  }

  get mergeable(): boolean {
    return this.mergeKey !== null;
  }

  toJSON(): CommandJson {
    return { id: this.id, data: { label: this.label, portfolio: this.after } };
  }
}

/**
 * Replaces one file's content and keeps everything the portfolio knows about it — its name, its
 * description, its column values and its place in the order. Foxit calls this "replace file";
 * it is what an operator does when a supporting document is re-issued.
 */
export class ReplaceFileCommand implements DocumentCommand {
  readonly id = PORTFOLIO_COMMAND_ID.replaceFile;
  readonly label: string;
  readonly writeIntents: ReadonlyArray<WriteIntent> = ['portfolio'];
  private readonly doc: Document;
  private readonly before: Portfolio | null;
  private readonly after: Portfolio;
  private readonly key: string;
  private readonly bytes: Uint8Array;
  private previous: Uint8Array | undefined;

  constructor(doc: Document, fileId: string, after: Portfolio, bytes: Uint8Array) {
    this.doc = doc;
    this.label = `Replace ${after.files.find((f) => f.id === fileId)?.name ?? 'file'}`;
    this.after = after;
    this.before = portfolioOfDocument(doc);
    this.key = blobKey(fileId);
    this.bytes = bytes;
  }

  do(): void {
    this.previous = this.doc.blobs.get(this.key);
    this.doc.blobs.set(this.key, this.bytes);
    setPortfolioRecord(this.doc, this.after);
  }

  undo(): void {
    if (this.previous === undefined) this.doc.blobs.delete(this.key);
    else this.doc.blobs.set(this.key, this.previous);
    setPortfolioRecord(this.doc, this.before);
  }

  toJSON(): CommandJson {
    return { id: this.id, data: { label: this.label, portfolio: this.after } };
  }
}

/**
 * Sets — or removes — the portfolio's cover sheet.
 *
 * The cover is the document's own pages, so this one really does move pages: the engine imports
 * the generated (or chosen) page and deletes the ones it replaces, and the model's page records
 * follow. Nothing about it is silent; the reader asks for a cover and gets one, and the undo
 * entry says which.
 */
export class CoverSheetCommand implements DocumentCommand {
  readonly id = PORTFOLIO_COMMAND_ID.cover;
  readonly label: string;
  readonly writeIntents: ReadonlyArray<WriteIntent> = ['portfolio', 'page-order'];
  private readonly doc: Document;
  private readonly bytes: Uint8Array | null;
  private readonly before: Portfolio | null;
  private readonly after: Portfolio | null;
  /** The pages that were there, as bytes, so undo can put them back exactly. */
  private replaced: Uint8Array | null = null;
  private replacedCount = 0;

  constructor(doc: Document, label: string, bytes: Uint8Array | null, after: Portfolio | null) {
    this.doc = doc;
    this.label = label;
    this.bytes = bytes;
    this.after = after;
    this.before = portfolioOfDocument(doc);
  }

  async do(): Promise<void> {
    const engine = this.doc.engine;
    const existing = this.doc.state.pages.length;
    this.replacedCount = existing;
    // Keep what is being replaced. A portfolio's pages are a cover sheet and nothing else, so
    // this is a page or two — but undo has to be exact, and only the bytes are.
    this.replaced = existing > 0 ? await engine.save(this.doc.handle) : null;

    if (this.bytes !== null) {
      const source = await engine.open(this.bytes.slice());
      try {
        await engine.importPages(this.doc.handle, source, [0], 0);
      } finally {
        await engine.close(source).catch(() => undefined);
      }
    }
    if (existing > 0) {
      await engine.deletePages(
        this.doc.handle,
        Array.from({ length: existing }, (_v, i) => i + (this.bytes === null ? 0 : 1)),
      );
    }
    await this.doc.refreshPages();
    if (this.after !== null) setPortfolioRecord(this.doc, this.after);
  }

  async undo(): Promise<void> {
    const engine = this.doc.engine;
    const now = this.doc.state.pages.length;
    if (this.replaced !== null && this.replacedCount > 0) {
      const source = await engine.open(this.replaced.slice());
      try {
        await engine.importPages(
          this.doc.handle,
          source,
          Array.from({ length: this.replacedCount }, (_v, i) => i),
          0,
        );
      } finally {
        await engine.close(source).catch(() => undefined);
      }
    }
    if (now > 0) {
      await engine.deletePages(
        this.doc.handle,
        Array.from({ length: now }, (_v, i) => i + this.replacedCount),
      );
    }
    await this.doc.refreshPages();
    setPortfolioRecord(this.doc, this.before);
  }

  toJSON(): CommandJson {
    return { id: this.id, data: { label: this.label } };
  }
}

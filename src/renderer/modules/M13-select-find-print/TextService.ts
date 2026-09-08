/**
 * `TextService` (M13) — the page-text cache. Everything textual goes through it: selection,
 * the find bar, the search panel, copy and, later, M51's editor and M111's read-aloud.
 *
 * `textRuns(page)` is one engine round trip per page and the answer never changes while a
 * document is open, so it is built once, lazily, and cached with the document. A tab that closes
 * takes its cache with it.
 *
 * The cache is keyed by tab id rather than by `DocHandle`, because a handle is an integer the
 * engine reuses: a closed-then-reopened document could otherwise inherit the previous one's text.
 */

import type { DocHandle, PdfEngine } from '@engine/PdfEngine';
import { buildPageText, emptyPageText, type PageText } from '@view/TextLayer';

export interface TextSource {
  readonly key: string;
  readonly handle: DocHandle;
  readonly pageCount: number;
}

export class TextService {
  private readonly engine: PdfEngine;
  private readonly cache = new Map<string, Map<number, PageText>>();
  private readonly inFlight = new Map<string, Promise<PageText>>();

  constructor(engine: PdfEngine) {
    this.engine = engine;
  }

  /** The text of one page, read from the engine the first time and cached afterwards. */
  async page(source: TextSource, page: number): Promise<PageText> {
    const cached = this.peek(source.key, page);
    if (cached) return cached;
    const id = `${source.key}:${page}`;
    const existing = this.inFlight.get(id);
    if (existing) return await existing;
    const promise = this.read(source, page);
    this.inFlight.set(id, promise);
    try {
      return await promise;
    } finally {
      this.inFlight.delete(id);
    }
  }

  private async read(source: TextSource, page: number): Promise<PageText> {
    let model: PageText;
    try {
      model = buildPageText(page, await this.engine.textRuns(source.handle, page));
    } catch {
      // A page whose text cannot be read (a damaged content stream) is an empty page, not a
      // failed document: the rest of the find still works.
      model = emptyPageText(page);
    }
    let pages = this.cache.get(source.key);
    if (!pages) {
      pages = new Map();
      this.cache.set(source.key, pages);
    }
    pages.set(page, model);
    return model;
  }

  /** The cached text, without asking the engine. */
  peek(key: string, page: number): PageText | undefined {
    return this.cache.get(key)?.get(page);
  }

  /** A lookup bound to one document, for the pure selection model. */
  lookup(key: string): (page: number) => PageText | undefined {
    return (page) => this.peek(key, page);
  }

  /** Reads every page of a document, yielding between pages so the UI keeps up. */
  async all(
    source: TextSource,
    onProgress?: (page: number, total: number) => void,
  ): Promise<PageText[]> {
    const out: PageText[] = [];
    for (let page = 0; page < source.pageCount; page++) {
      out.push(await this.page(source, page));
      onProgress?.(page + 1, source.pageCount);
    }
    return out;
  }

  /** Whether every page of a document is already cached. */
  isComplete(source: TextSource): boolean {
    const pages = this.cache.get(source.key);
    if (!pages) return source.pageCount === 0;
    for (let page = 0; page < source.pageCount; page++) if (!pages.has(page)) return false;
    return true;
  }

  /** Drops a document's cache — called when its tab closes or its pages change. */
  forget(key: string): void {
    this.cache.delete(key);
    for (const id of [...this.inFlight.keys()]) {
      if (id.startsWith(`${key}:`)) this.inFlight.delete(id);
    }
  }

  clear(): void {
    this.cache.clear();
    this.inFlight.clear();
  }
}

/**
 * The find engine for one open document (M13): runs a query over the page text, the bookmarks,
 * the comments and the form values, keeps the hit list, and knows which hit is current.
 *
 * It scans the whole document rather than only what is on screen, because "n of m" is a promise
 * about the *document*. The scan yields between pages so a long one never blocks the window, and
 * reports as it goes, so the count climbs while the reader is still typing rather than appearing
 * all at once at the end.
 */

import type { PdfEngine } from '@engine/PdfEngine';
import type { PageText } from '@view/TextLayer';
import { yieldMacrotask } from '@engine/yield';
import type { TextService, TextSource } from '../TextService';
import {
  contextSnippet,
  findMatches,
  type FindOptions,
  type HitSource,
  type MatchSpan,
} from './search';

/** One hit inside the open document. */
export interface FindHit {
  readonly page: number;
  readonly start: number;
  readonly end: number;
  readonly source: HitSource;
  readonly snippet: string;
  /** Bookmark title, field name or comment author. */
  readonly label?: string;
}

export interface FindProgress {
  readonly query: string;
  readonly hits: ReadonlyArray<FindHit>;
  readonly current: number;
  readonly scanning: boolean;
  readonly scannedPages: number;
  readonly totalPages: number;
  readonly error: string | null;
}

export interface FindControllerOptions {
  readonly engine: PdfEngine;
  readonly text: TextService;
  readonly onUpdate: (progress: FindProgress) => void;
}

/** How many pages are scanned between yields. Small enough that typing stays smooth. */
const PAGES_PER_SLICE = 4;

export class FindController {
  private readonly engine: PdfEngine;
  private readonly text: TextService;
  private readonly onUpdate: (progress: FindProgress) => void;
  private query = '';
  private hits: FindHit[] = [];
  private currentIndex = -1;
  private scanning = false;
  private scanned = 0;
  private total = 0;
  private error: string | null = null;
  private generation = 0;

  constructor(options: FindControllerOptions) {
    this.engine = options.engine;
    this.text = options.text;
    this.onUpdate = options.onUpdate;
  }

  get progress(): FindProgress {
    return {
      query: this.query,
      hits: this.hits,
      current: this.currentIndex,
      scanning: this.scanning,
      scannedPages: this.scanned,
      totalPages: this.total,
      error: this.error,
    };
  }

  get currentHit(): FindHit | null {
    return this.hits[this.currentIndex] ?? null;
  }

  /** Every hit on one page — what the highlighter draws. */
  hitsOnPage(page: number): FindHit[] {
    return this.hits.filter((h) => h.page === page && h.source === 'page');
  }

  /** Cancels any scan and forgets the results. */
  reset(): void {
    this.generation++;
    this.query = '';
    this.hits = [];
    this.currentIndex = -1;
    this.scanning = false;
    this.scanned = 0;
    this.error = null;
    this.onUpdate(this.progress);
  }

  /**
   * Runs a query. `startPage` is where the first hit is chosen from, so Ctrl+F on page 40 goes
   * to the next hit after page 40 rather than back to page 1.
   */
  async run(
    source: TextSource,
    query: string,
    options: FindOptions,
    startPage = 0,
  ): Promise<FindProgress> {
    const generation = ++this.generation;
    this.query = query;
    this.hits = [];
    this.currentIndex = -1;
    this.error = null;
    this.scanned = 0;
    this.total = source.pageCount;
    if (query.length === 0) {
      this.scanning = false;
      this.onUpdate(this.progress);
      return this.progress;
    }
    this.scanning = true;
    this.onUpdate(this.progress);

    try {
      for (let page = 0; page < source.pageCount; page++) {
        if (generation !== this.generation) return this.progress;
        const model = await this.text.page(source, page);
        // Checked *again* after the await: a newer query may have started and cleared the hits
        // while this one was waiting for a page, and its first result would then land in the
        // new query's list. Typing quickly is exactly how that happens.
        if (generation !== this.generation) return this.progress;
        this.collectPage(model, query, options);
        if (options.includeComments) await this.collectComments(source, page, query, options);
        this.scanned = page + 1;
        if (page % PAGES_PER_SLICE === PAGES_PER_SLICE - 1) {
          this.chooseCurrent(startPage);
          this.onUpdate(this.progress);
          await yieldMacrotask();
        }
      }
      if (generation !== this.generation) return this.progress;
      if (options.includeBookmarks) await this.collectBookmarks(source, query, options);
      if (options.includeFormFields) await this.collectFields(source, query, options);
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    }
    if (generation !== this.generation) return this.progress;
    this.scanning = false;
    this.sort();
    this.chooseCurrent(startPage);
    this.onUpdate(this.progress);
    return this.progress;
  }

  /** Moves to the next hit, wrapping round. Returns the hit, or `null` when there are none. */
  next(): FindHit | null {
    return this.step(1);
  }

  previous(): FindHit | null {
    return this.step(-1);
  }

  /** Selects a specific hit, e.g. from the results panel. */
  select(index: number): FindHit | null {
    if (this.hits.length === 0) return null;
    this.currentIndex = ((index % this.hits.length) + this.hits.length) % this.hits.length;
    this.onUpdate(this.progress);
    return this.currentHit;
  }

  private step(direction: 1 | -1): FindHit | null {
    if (this.hits.length === 0) return null;
    return this.select(this.currentIndex + direction);
  }

  private collectPage(model: PageText, query: string, options: FindOptions): void {
    for (const match of findMatches(model.text, query, options)) {
      this.hits.push({
        page: model.page,
        start: match.start,
        end: match.end,
        source: 'page',
        snippet: contextSnippet(model.text, match),
      });
    }
  }

  private async collectComments(
    source: TextSource,
    page: number,
    query: string,
    options: FindOptions,
  ): Promise<void> {
    const annotations = await this.engine.annotations(source.handle, page);
    for (const annotation of annotations) {
      const text = [annotation.contents, annotation.subject].filter(Boolean).join(' ');
      if (!text) continue;
      this.push(text, query, options, page, 'comment', annotation.author);
    }
  }

  private async collectBookmarks(
    source: TextSource,
    query: string,
    options: FindOptions,
  ): Promise<void> {
    const flat: Array<{ title: string; page: number }> = [];
    const walk = (
      items: ReadonlyArray<{
        title: string;
        dest?: { page: number } | undefined;
        children: ReadonlyArray<unknown>;
      }>,
    ): void => {
      for (const item of items) {
        flat.push({ title: item.title, page: item.dest?.page ?? -1 });
        walk(
          item.children as ReadonlyArray<{
            title: string;
            dest?: { page: number } | undefined;
            children: ReadonlyArray<unknown>;
          }>,
        );
      }
    };
    walk(await this.engine.outline(source.handle));
    for (const entry of flat) {
      this.push(entry.title, query, options, entry.page, 'bookmark', entry.title);
    }
  }

  private async collectFields(
    source: TextSource,
    query: string,
    options: FindOptions,
  ): Promise<void> {
    for (const field of await this.engine.formFields(source.handle)) {
      if (!field.value) continue;
      this.push(field.value, query, options, field.widgets[0]?.page ?? -1, 'field', field.name);
    }
  }

  private push(
    text: string,
    query: string,
    options: FindOptions,
    page: number,
    kind: HitSource,
    label: string | undefined,
  ): void {
    for (const match of findMatches(text, query, options)) {
      this.hits.push({
        page,
        start: match.start,
        end: match.end,
        source: kind,
        snippet: contextSnippet(text, match),
        ...(label !== undefined ? { label } : {}),
      });
    }
  }

  private sort(): void {
    const rank: Record<HitSource, number> = { page: 0, comment: 1, bookmark: 2, field: 3 };
    this.hits.sort(
      (a, b) => a.page - b.page || rank[a.source] - rank[b.source] || a.start - b.start,
    );
  }

  /** The first hit at or after `startPage`, else the first hit at all. */
  private chooseCurrent(startPage: number): void {
    if (this.currentIndex >= 0 && this.currentIndex < this.hits.length) return;
    if (this.hits.length === 0) {
      this.currentIndex = -1;
      return;
    }
    const at = this.hits.findIndex((h) => h.page >= startPage);
    this.currentIndex = at >= 0 ? at : 0;
  }
}

export type { MatchSpan };

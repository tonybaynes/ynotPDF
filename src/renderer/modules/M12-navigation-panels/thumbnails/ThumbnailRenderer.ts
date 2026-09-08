/**
 * `ThumbnailRenderer` (M12) — the only thing that asks the engine for thumbnail pixels.
 *
 * It is deliberately *not* M11's `TileRenderer`. That cache is keyed by zoom bucket and bounded
 * in megabytes of page tiles; letting thumbnails into it would have a scrolled panel evict the
 * page the reader is looking at. This one is small, keyed by (tab, page, size, revision), and
 * bounded by a count of bitmaps.
 *
 * **Thumbnails are low priority**, which is the brief's requirement and the engine worker cannot
 * express: it serves one request at a time, first come first served. So this renderer holds back
 * while the viewer has work outstanding, keeps a single request in flight, and drops what has
 * scrolled out of view — the page in front of the reader is never waiting behind a thumbnail.
 */

import type { EngineClient } from '@engine/EngineClient';
import { EngineError, type DocHandle, type RenderOptions } from '@engine/PdfEngine';

/** One thumbnail to draw. */
export interface ThumbnailRequest {
  /** Cache scope: unique per open tab. */
  readonly docKey: string;
  readonly doc: DocHandle;
  /** Engine page index. */
  readonly page: number;
  /** Model page id, so a reordered document does not reuse another page's picture. */
  readonly pageId: string;
  /** Thumbnail width in CSS pixels. */
  readonly size: number;
  /** Page size in points, for the scale. */
  readonly pageWidth: number;
  readonly pageHeight: number;
  readonly dpr: number;
  /** Lower renders first: the panel passes distance from the current page. */
  readonly priority: number;
  readonly options?: RenderOptions;
}

export interface ThumbnailRendererOptions {
  readonly client: EngineClient;
  /** Bitmaps kept before the oldest is dropped. A 300 px thumbnail is ~0.5 MB. */
  readonly maxEntries?: number;
  /**
   * Whether the main view is busy. While it is, no thumbnail is submitted — that is the whole
   * of "thumbnails are low priority in the engine queue".
   */
  readonly viewerBusy?: () => boolean;
  /** Delay before looking again while the viewer is busy. */
  readonly retryMs?: number;
}

interface QueueItem {
  readonly id: string;
  readonly request: ThumbnailRequest;
  priority: number;
}

/** The id a request is cached under. */
export function thumbnailId(
  request: Pick<ThumbnailRequest, 'docKey' | 'pageId' | 'size'>,
  revision: number,
): string {
  return `${request.docKey}|${request.pageId}|${String(request.size)}|${String(revision)}`;
}

export class ThumbnailRenderer {
  private readonly client: EngineClient;
  private readonly maxEntries: number;
  private readonly viewerBusy: () => boolean;
  private readonly retryMs: number;
  /** Insertion-ordered, which is what makes a `Map` an LRU when a hit re-inserts. */
  private readonly cache = new Map<string, ImageBitmap>();
  private queue: QueueItem[] = [];
  private inFlight: { id: string; cancel(): void } | null = null;
  private readonly listeners = new Set<(id: string, request: ThumbnailRequest) => void>();
  private readonly revisions = new Map<string, number>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  rendered = 0;
  cancelled = 0;

  constructor(options: ThumbnailRendererOptions) {
    this.client = options.client;
    this.maxEntries = Math.max(8, options.maxEntries ?? 160);
    this.viewerBusy = options.viewerBusy ?? ((): boolean => false);
    this.retryMs = options.retryMs ?? 60;
  }

  /** Fires when a thumbnail lands in the cache. */
  onThumbnail(listener: (id: string, request: ThumbnailRequest) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** The cache revision of one tab; bumped when its pages stop looking like themselves. */
  revision(docKey: string): number {
    return this.revisions.get(docKey) ?? 0;
  }

  /**
   * Invalidates every thumbnail of a tab — after a layer toggle, a rotation or a page edit.
   * The bitmaps go, the ids change, and the panel asks again for what it can see.
   */
  invalidate(docKey: string): void {
    this.revisions.set(docKey, this.revision(docKey) + 1);
    this.dropWhere((id) => id.startsWith(`${docKey}|`));
  }

  /** Drops a tab's thumbnails and forgets its queue (the tab closed). */
  forget(docKey: string): void {
    this.revisions.delete(docKey);
    this.queue = this.queue.filter((q) => q.request.docKey !== docKey);
    this.dropWhere((id) => id.startsWith(`${docKey}|`));
  }

  /** A cache read that never renders — what painting on scroll uses. */
  peek(request: Pick<ThumbnailRequest, 'docKey' | 'pageId' | 'size'>): ImageBitmap | undefined {
    const id = thumbnailId(request, this.revision(request.docKey));
    const found = this.cache.get(id);
    if (found) {
      // Re-insert to move it to the young end of the LRU.
      this.cache.delete(id);
      this.cache.set(id, found);
    }
    return found;
  }

  /**
   * Replaces what the panel wants, in priority order. Anything already cached is skipped, and a
   * render in flight for something no longer wanted is cancelled — a fast scroll must not leave
   * a hundred thumbnails queued behind it.
   */
  request(requests: ReadonlyArray<ThumbnailRequest>): void {
    if (this.disposed) return;
    const wanted: QueueItem[] = [];
    const seen = new Set<string>();
    for (const request of requests) {
      const id = thumbnailId(request, this.revision(request.docKey));
      if (this.cache.has(id) || seen.has(id)) continue;
      seen.add(id);
      wanted.push({ id, request, priority: request.priority });
    }
    this.queue = wanted.sort((a, b) => a.priority - b.priority);
    if (this.inFlight && !seen.has(this.inFlight.id)) {
      this.inFlight.cancel();
      this.inFlight = null;
      this.cancelled++;
    }
    this.pump();
  }

  private pump(): void {
    if (this.disposed || this.inFlight || this.queue.length === 0) return;
    if (this.timer !== null) return;
    // The main view first, always. Looking again shortly is cheaper than a queued thumbnail
    // sitting in front of the tile the reader is waiting for.
    if (this.viewerBusy()) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.pump();
      }, this.retryMs);
      return;
    }
    const next = this.queue.shift();
    if (!next) return;
    void this.render(next);
  }

  private async render(item: QueueItem): Promise<void> {
    const { request } = item;
    const longest = Math.max(1, request.pageWidth, request.pageHeight);
    const scale = Math.max(0.02, (request.size * request.dpr) / Math.max(1, request.pageWidth));
    // A thumbnail is never worth more pixels than its longest edge at device resolution.
    const capped = Math.min(scale, (request.size * request.dpr * 1.6) / longest);
    const handle = this.client.request('render', [
      request.doc,
      request.page,
      Math.max(0.02, capped),
      undefined,
      request.options ?? { annotations: true, forms: true },
    ]);
    this.inFlight = {
      id: item.id,
      cancel: () => {
        handle.cancel();
      },
    };
    try {
      const result = await handle.promise;
      this.put(item.id, result.bitmap);
      this.rendered++;
      for (const listener of Array.from(this.listeners)) listener(item.id, request);
    } catch (error) {
      // A cancelled render is the normal end of a fast scroll, not a failure.
      if (!(error instanceof EngineError && error.code === 'cancelled')) {
        console.warn(`thumbnail for page ${String(request.page + 1)} failed`, error);
      }
    } finally {
      if (this.inFlight?.id === item.id) this.inFlight = null;
      this.pump();
    }
  }

  private put(id: string, bitmap: ImageBitmap): void {
    this.cache.set(id, bitmap);
    while (this.cache.size > this.maxEntries) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      const victim = this.cache.get(oldest);
      this.cache.delete(oldest);
      victim?.close?.();
    }
  }

  private dropWhere(predicate: (id: string) => boolean): void {
    for (const [id, bitmap] of [...this.cache]) {
      if (!predicate(id)) continue;
      this.cache.delete(id);
      bitmap.close?.();
    }
  }

  get stats(): { cached: number; queued: number; rendered: number; cancelled: number } {
    return {
      cached: this.cache.size,
      queued: this.queue.length + (this.inFlight ? 1 : 0),
      rendered: this.rendered,
      cancelled: this.cancelled,
    };
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.inFlight?.cancel();
    this.inFlight = null;
    this.queue = [];
    this.dropWhere(() => true);
    this.listeners.clear();
  }
}

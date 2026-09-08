/**
 * `TileRenderer` — the only thing in the app that asks the engine for pixels (M11).
 *
 * It owns the shared {@link TileCache}, a priority queue ordered by distance from the viewport
 * centre, and the Night Mode post-pass. Two viewports on the same document (split view) share
 * one renderer, so a tile is rasterised once however many times it is displayed.
 *
 * The rules the viewport relies on:
 * - **A cache hit is synchronous.** `peek()` returns a bitmap without a promise, so painting on
 *   scroll never waits and never re-renders.
 * - **Superseded work is dropped.** `reprioritise()` throws away everything queued that is no
 *   longer wanted and cancels the matching in-flight engine calls, which is what keeps a fast
 *   scroll from queueing a thousand tiles.
 * - **Nothing is ever rendered twice concurrently.** In-flight ids are tracked, so a tile that
 *   two viewports both want is one engine call.
 */

import type { EngineClient } from '@engine/EngineClient';
import { EngineError, type DocHandle, type RenderOptions } from '@engine/PdfEngine';
import type { PageGeometry } from '@engine/geometry';
import { TileCache, megabytes } from './TileCache';
import { bitmapBytes, tileId, tileRect, type TileCoord, type TileSpec } from './tiles';
import {
  FALLBACK_PALETTE,
  buildRamp,
  nightTransform,
  type NightPalette,
  type PixelRect,
} from './night';

/** Everything that changes what a tile looks like. */
export interface RenderFlags {
  readonly annotations: boolean;
  readonly forms: boolean;
  readonly grayscale: boolean;
  readonly smoothText: boolean;
  readonly smoothImages: boolean;
  readonly smoothPaths: boolean;
  readonly lineWeights: boolean;
  readonly night: boolean;
}

export const DEFAULT_FLAGS: RenderFlags = {
  annotations: true,
  forms: true,
  grayscale: false,
  smoothText: true,
  smoothImages: true,
  smoothPaths: true,
  lineWeights: true,
  night: false,
};

/** A short, stable string for the flag set; part of every tile id. */
export function flagsKey(f: RenderFlags): string {
  return (
    (f.annotations ? 'a' : '-') +
    (f.forms ? 'f' : '-') +
    (f.grayscale ? 'g' : '-') +
    (f.smoothText ? 't' : '-') +
    (f.smoothImages ? 'i' : '-') +
    (f.smoothPaths ? 'p' : '-') +
    (f.lineWeights ? 'w' : '-') +
    (f.night ? 'n' : '-')
  );
}

export function renderOptions(f: RenderFlags, rotation: number, background?: number): RenderOptions {
  return {
    annotations: f.annotations,
    forms: f.forms,
    grayscale: f.grayscale,
    smoothText: f.smoothText,
    smoothImages: f.smoothImages,
    smoothPaths: f.smoothPaths,
    lineWeights: f.lineWeights,
    rotation: rotation as 0 | 90 | 180 | 270,
    ...(background === undefined ? {} : { background }),
  };
}

/** What the renderer needs to know about a page to tile it. */
export interface PageRenderContext {
  /** Engine handle of the open document. */
  readonly doc: DocHandle;
  /** Cache-scoping key: unique per open tab. */
  readonly docKey: string;
  readonly page: number;
  readonly geometry: PageGeometry;
}

/** One tile the viewport wants. */
export interface TileRequest extends PageRenderContext {
  readonly coord: TileCoord;
  /** Bucketed CSS px per point. */
  readonly zoom: number;
  readonly bucket: number;
  readonly dpr: number;
  readonly rotation: number;
  readonly flags: RenderFlags;
  /** Lower renders first. */
  readonly priority: number;
}

/** A whole-page low-resolution render, shown until the real tiles land. */
export interface PlaceholderRequest extends PageRenderContext {
  readonly rotation: number;
  readonly flags: RenderFlags;
  /** Longest edge of the placeholder in device pixels. */
  readonly maxEdge: number;
}

export interface TileRendererOptions {
  readonly client: EngineClient;
  readonly cacheBytes?: number;
  /** How many engine renders may be outstanding. The worker serialises; 3 keeps it fed. */
  readonly concurrency?: number;
  /** Reads the Night Mode palette from the theme; defaults to the built-in pair. */
  readonly palette?: () => NightPalette;
}

export interface RendererStats {
  readonly queued: number;
  readonly inFlight: number;
  readonly rendered: number;
  readonly cancelled: number;
  readonly failed: number;
  /** Tiles finished in the last second. */
  readonly tilesPerSecond: number;
  readonly cacheEntries: number;
  readonly cacheBytes: number;
  readonly cacheMaxBytes: number;
  readonly cacheHitRate: number;
}

interface QueueItem {
  readonly id: string;
  readonly request: TileRequest;
  priority: number;
}

type TileListener = (id: string, request: TileRequest) => void;

/** The placeholder id namespace: bucket −1 can never collide with a real zoom bucket. */
const PLACEHOLDER_BUCKET = Number.NEGATIVE_INFINITY;

export class TileRenderer {
  readonly cache: TileCache<ImageBitmap>;
  private readonly client: EngineClient;
  private readonly concurrency: number;
  private readonly palette: () => NightPalette;
  private queue: QueueItem[] = [];
  private readonly inFlight = new Map<string, { cancel(): void }>();
  private readonly listeners = new Set<TileListener>();
  /** Image-object rectangles per page, for Night Mode's "leave photographs alone". */
  private readonly imageRects = new Map<string, Promise<ReadonlyArray<PixelRectInPoints>>>();
  private rendered = 0;
  private cancelled = 0;
  private failed = 0;
  private recent: number[] = [];
  private disposed = false;
  private ramp = buildRamp(FALLBACK_PALETTE);
  private rampKey = '';
  /** Night Mode leaves image objects untouched unless this is turned off. */
  keepImages = true;
  /** How much of the source's colour survives the night transform, 0..1. */
  nightChroma = 1;

  constructor(options: TileRendererOptions) {
    this.client = options.client;
    this.concurrency = Math.max(1, options.concurrency ?? 3);
    this.palette = options.palette ?? ((): NightPalette => FALLBACK_PALETTE);
    this.cache = new TileCache<ImageBitmap>({
      maxBytes: options.cacheBytes ?? megabytes(256),
      dispose: (bitmap) => {
        bitmap.close?.();
      },
    });
  }

  setCacheBytes(bytes: number): void {
    this.cache.setMaxBytes(bytes);
  }

  /** Fires whenever a tile lands in the cache; the viewport repaints from it. */
  onTile(listener: TileListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** The id a request will be cached under. */
  idOf(request: TileRequest): string {
    return tileId(this.specOf(request));
  }

  placeholderId(request: Pick<PlaceholderRequest, 'docKey' | 'page' | 'rotation' | 'flags'>): string {
    return tileId({
      doc: request.docKey,
      page: request.page,
      bucket: PLACEHOLDER_BUCKET,
      rotation: request.rotation,
      flags: flagsKey(request.flags),
      col: 0,
      row: 0,
    });
  }

  /** A cache read that never renders. This is what painting on scroll uses. */
  peek(id: string): ImageBitmap | undefined {
    return this.cache.get(id);
  }

  has(id: string): boolean {
    return this.cache.has(id);
  }

  /**
   * Replaces the queue with exactly the tiles wanted now, in priority order, and cancels
   * in-flight renders that are no longer in the set. Called on every scroll/zoom settle.
   */
  reprioritise(requests: ReadonlyArray<TileRequest>): void {
    if (this.disposed) return;
    const wanted = new Map<string, QueueItem>();
    for (const request of requests) {
      const id = this.idOf(request);
      if (this.cache.has(id)) continue;
      const existing = wanted.get(id);
      if (existing) {
        existing.priority = Math.min(existing.priority, request.priority);
        continue;
      }
      wanted.set(id, { id, request, priority: request.priority });
    }
    for (const [id, handle] of [...this.inFlight]) {
      if (wanted.has(id)) {
        wanted.delete(id); // already being rendered
        continue;
      }
      handle.cancel();
      this.inFlight.delete(id);
      this.cancelled++;
    }
    this.queue = [...wanted.values()].sort((a, b) => a.priority - b.priority);
    this.pump();
  }

  /** Adds tiles without disturbing what is already queued — the idle-time prefetch. */
  prefetch(requests: ReadonlyArray<TileRequest>): void {
    if (this.disposed) return;
    for (const request of requests) {
      const id = this.idOf(request);
      if (this.cache.has(id) || this.inFlight.has(id)) continue;
      if (this.queue.some((q) => q.id === id)) continue;
      this.queue.push({ id, request, priority: request.priority });
    }
    this.queue.sort((a, b) => a.priority - b.priority);
    this.pump();
  }

  /**
   * Renders the low-resolution whole-page placeholder. Resolves with the cached bitmap when it
   * is already there, so the caller can paint immediately after a layout change.
   */
  async placeholder(request: PlaceholderRequest): Promise<ImageBitmap | undefined> {
    const id = this.placeholderId(request);
    const cached = this.cache.get(id);
    if (cached) return cached;
    if (this.inFlight.has(id)) return undefined;
    const geo = request.geometry;
    const longest = Math.max(geo.width, geo.height, 1);
    const scale = Math.max(0.05, request.maxEdge / longest);
    const handle = this.client.request('render', [
      request.doc,
      request.page,
      scale,
      undefined,
      renderOptions(request.flags, request.rotation),
    ]);
    this.inFlight.set(id, handle);
    try {
      const result = await handle.promise;
      const bitmap = await this.postProcess(result.bitmap, request, {
        x: 0,
        y: 0,
        width: result.bitmap.width,
        height: result.bitmap.height,
      }, scale);
      this.cache.set(id, bitmap, bitmapBytes(bitmap.width, bitmap.height));
      return bitmap;
    } catch (error) {
      if (!isCancelled(error)) this.failed++;
      return undefined;
    } finally {
      this.inFlight.delete(id);
    }
  }

  /** Drops every cached tile and pending render for a document (a tab closed). */
  forget(docKey: string): void {
    for (const [id, handle] of [...this.inFlight]) {
      if (id.startsWith(`${docKey}|`)) {
        handle.cancel();
        this.inFlight.delete(id);
      }
    }
    this.queue = this.queue.filter((q) => q.request.docKey !== docKey);
    this.cache.deleteWhere((key) => key.startsWith(`${docKey}|`));
    for (const key of [...this.imageRects.keys()]) {
      if (key.startsWith(`${docKey}|`)) this.imageRects.delete(key);
    }
  }

  stats(): RendererStats {
    const cache = this.cache.stats();
    const now = performance.now();
    this.recent = this.recent.filter((t) => now - t < 1000);
    return {
      queued: this.queue.length,
      inFlight: this.inFlight.size,
      rendered: this.rendered,
      cancelled: this.cancelled,
      failed: this.failed,
      tilesPerSecond: this.recent.length,
      cacheEntries: cache.entries,
      cacheBytes: cache.bytes,
      cacheMaxBytes: cache.maxBytes,
      cacheHitRate: cache.hitRate,
    };
  }

  dispose(): void {
    this.disposed = true;
    for (const handle of this.inFlight.values()) handle.cancel();
    this.inFlight.clear();
    this.queue = [];
    this.cache.clear();
    this.listeners.clear();
    this.imageRects.clear();
  }

  // ---- internals -----------------------------------------------------------------------------

  private specOf(request: TileRequest): TileSpec {
    return {
      doc: request.docKey,
      page: request.page,
      bucket: request.bucket,
      rotation: request.rotation,
      flags: flagsKey(request.flags),
      col: request.coord.col,
      row: request.coord.row,
    };
  }

  private pump(): void {
    while (this.inFlight.size < this.concurrency && this.queue.length > 0) {
      const item = this.queue.shift();
      if (!item) break;
      if (this.cache.has(item.id) || this.inFlight.has(item.id)) continue;
      void this.render(item);
    }
  }

  private async render(item: QueueItem): Promise<void> {
    const { request, id } = item;
    const geo = request.geometry;
    const pageWidthPx = geo.width * request.zoom;
    const pageHeightPx = geo.height * request.zoom;
    const css = tileRect(request.coord, pageWidthPx, pageHeightPx);
    if (css.width <= 0 || css.height <= 0) return;
    const device = geo.rectToPage(
      { x: css.x, y: css.y, width: css.width, height: css.height },
      request.zoom,
    );
    const handle = this.client.request('render', [
      request.doc,
      request.page,
      request.zoom * request.dpr,
      device,
      renderOptions(request.flags, request.rotation),
    ]);
    this.inFlight.set(id, handle);
    try {
      const result = await handle.promise;
      const bitmap = await this.postProcess(
        result.bitmap,
        request,
        {
          x: css.x * request.dpr,
          y: css.y * request.dpr,
          width: result.bitmap.width,
          height: result.bitmap.height,
        },
        request.zoom * request.dpr,
      );
      this.cache.set(id, bitmap, bitmapBytes(bitmap.width, bitmap.height));
      this.rendered++;
      this.recent.push(performance.now());
      for (const l of [...this.listeners]) l(id, request);
    } catch (error) {
      if (isCancelled(error)) this.cancelled++;
      else {
        this.failed++;
        console.warn(`tile render failed (page ${request.page})`, error);
      }
    } finally {
      this.inFlight.delete(id);
      this.pump();
    }
  }

  /** Night Mode's pixel pass. Returns the bitmap unchanged when Night Mode is off. */
  private async postProcess(
    bitmap: ImageBitmap,
    request: PageRenderContext & { readonly flags: RenderFlags; readonly rotation: number },
    placement: { x: number; y: number; width: number; height: number },
    scale: number,
  ): Promise<ImageBitmap> {
    if (!request.flags.night) return bitmap;
    if (typeof OffscreenCanvas === 'undefined') return bitmap;
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return bitmap;
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close?.();
    const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const rects = this.keepImages
      ? await this.imageRectsFor(request, scale, placement)
      : ([] as PixelRect[]);
    nightTransform(image.data, image.width, image.height, this.currentRamp(), rects, {
      chroma: this.nightChroma,
    });
    ctx.putImageData(image, 0, 0);
    return canvas.transferToImageBitmap();
  }

  private currentRamp(): ReturnType<typeof buildRamp> {
    const palette = this.palette();
    const key = `${palette.paper.r},${palette.paper.g},${palette.paper.b}|${palette.ink.r},${palette.ink.g},${palette.ink.b}`;
    if (key !== this.rampKey) {
      this.ramp = buildRamp(palette);
      this.rampKey = key;
    }
    return this.ramp;
  }

  /**
   * Image-object rectangles of a page, converted to this tile's pixels. Fetched once per page
   * and cached; a failure means "no exemptions", never a broken render.
   */
  private async imageRectsFor(
    request: PageRenderContext & { readonly rotation: number },
    scale: number,
    placement: { x: number; y: number; width: number; height: number },
  ): Promise<PixelRect[]> {
    const key = `${request.docKey}|${request.page}`;
    let pending = this.imageRects.get(key);
    if (!pending) {
      pending = this.client
        .call('pageObjects', [request.doc, request.page])
        .then((objects) =>
          objects.filter((o) => o.kind === 'image').map((o) => ({ rect: o.rect }) as PixelRectInPoints),
        )
        .catch(() => [] as PixelRectInPoints[]);
      this.imageRects.set(key, pending);
    }
    const objects = await pending;
    if (objects.length === 0) return [];
    const geo = request.geometry;
    const out: PixelRect[] = [];
    for (const o of objects) {
      const d = geo.rectToDevice(o.rect, scale);
      out.push({
        x: d.x - placement.x,
        y: d.y - placement.y,
        width: d.width,
        height: d.height,
      });
    }
    return out;
  }
}

interface PixelRectInPoints {
  readonly rect: import('@shared/pdf').PdfRect;
}

function isCancelled(error: unknown): boolean {
  return error instanceof EngineError && error.code === 'cancelled';
}

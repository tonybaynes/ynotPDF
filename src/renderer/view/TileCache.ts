/**
 * `TileCache` — an LRU of rendered tiles bounded by **megabytes**, not by count (M11).
 *
 * A tile's cost is its real pixel cost (w × h × 4), so a 512 px tile at DPR 2 counts four times
 * a DPR 1 one and the budget in the settings means what it says. Evicted entries are disposed
 * (an `ImageBitmap` must be `close()`d or Chromium keeps the GPU memory).
 *
 * Pure enough to unit-test in Node: it never touches the DOM and takes the disposer as a
 * parameter, so tests can use plain objects.
 */

export interface CacheEntry<V> {
  readonly value: V;
  readonly bytes: number;
}

export interface TileCacheOptions<V> {
  /** Budget in bytes. */
  readonly maxBytes: number;
  /** Called for every value that leaves the cache (eviction, delete, clear, overwrite). */
  readonly dispose?: (value: V) => void;
}

export interface CacheStats {
  readonly entries: number;
  readonly bytes: number;
  readonly maxBytes: number;
  readonly hits: number;
  readonly misses: number;
  readonly evictions: number;
  /** Hits ÷ (hits + misses); 0 when nothing has been asked for yet. */
  readonly hitRate: number;
}

export class TileCache<V> {
  /** `Map` keeps insertion order, which is exactly the LRU order once we re-insert on hit. */
  private readonly map = new Map<string, CacheEntry<V>>();
  private readonly disposeValue: (value: V) => void;
  private budget: number;
  private total = 0;
  private hits = 0;
  private misses = 0;
  private evictions = 0;

  constructor(options: TileCacheOptions<V>) {
    this.budget = Math.max(0, options.maxBytes);
    this.disposeValue = options.dispose ?? ((): void => undefined);
  }

  get maxBytes(): number {
    return this.budget;
  }

  /** Changes the budget; evicts immediately if the new one is smaller. */
  setMaxBytes(maxBytes: number): void {
    this.budget = Math.max(0, maxBytes);
    this.evict();
  }

  get bytes(): number {
    return this.total;
  }

  get size(): number {
    return this.map.size;
  }

  has(key: string): boolean {
    return this.map.has(key);
  }

  /** Reads a tile and marks it most-recently-used. Counts a hit or a miss. */
  get(key: string): V | undefined {
    const entry = this.map.get(key);
    if (!entry) {
      this.misses++;
      return undefined;
    }
    this.hits++;
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  /** Reads without touching the LRU order or the statistics. */
  peek(key: string): V | undefined {
    return this.map.get(key)?.value;
  }

  /**
   * Stores a tile. A value larger than the whole budget is disposed straight away rather than
   * emptying the cache to hold something that cannot stay.
   */
  set(key: string, value: V, bytes: number): void {
    const cost = Math.max(0, Math.round(bytes));
    const existing = this.map.get(key);
    if (existing) {
      this.map.delete(key);
      this.total -= existing.bytes;
      this.disposeValue(existing.value);
    }
    if (cost > this.budget) {
      this.disposeValue(value);
      return;
    }
    this.map.set(key, { value, bytes: cost });
    this.total += cost;
    this.evict();
  }

  delete(key: string): boolean {
    const entry = this.map.get(key);
    if (!entry) return false;
    this.map.delete(key);
    this.total -= entry.bytes;
    this.disposeValue(entry.value);
    return true;
  }

  /** Drops every entry whose key matches; returns how many went. Used when a document closes. */
  deleteWhere(predicate: (key: string) => boolean): number {
    let n = 0;
    for (const key of [...this.map.keys()]) {
      if (predicate(key) && this.delete(key)) n++;
    }
    return n;
  }

  clear(): void {
    for (const entry of this.map.values()) this.disposeValue(entry.value);
    this.map.clear();
    this.total = 0;
  }

  /** Keys from least to most recently used. */
  keys(): string[] {
    return [...this.map.keys()];
  }

  stats(): CacheStats {
    const asked = this.hits + this.misses;
    return {
      entries: this.map.size,
      bytes: this.total,
      maxBytes: this.budget,
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
      hitRate: asked === 0 ? 0 : this.hits / asked,
    };
  }

  resetStats(): void {
    this.hits = 0;
    this.misses = 0;
    this.evictions = 0;
  }

  private evict(): void {
    while (this.total > this.budget) {
      const oldest = this.map.keys().next();
      if (oldest.done) break;
      const entry = this.map.get(oldest.value);
      this.map.delete(oldest.value);
      if (entry) {
        this.total -= entry.bytes;
        this.disposeValue(entry.value);
      }
      this.evictions++;
    }
  }
}

/** Megabytes → bytes, for the `viewer.cache.megabytes` setting. */
export function megabytes(mb: number): number {
  return Math.max(0, Math.round(mb * 1024 * 1024));
}

/**
 * Tile geometry, ordering and the LRU cache (M11).
 *
 * The cache is the part of the viewer that stops a long document eating all the memory, so its
 * budget behaviour is tested in detail: the acceptance line is "memory bounded by the cache
 * setting", and this is where that is decided.
 */

import { describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';
import { megabytes, TileCache } from '@view/TileCache';
import {
  bitmapBytes,
  gridSize,
  orderByDistance,
  TILE_SIZE,
  tileId,
  tileRect,
  tilesForRect,
  type TileSpec,
} from '@view/tiles';

const spec = (patch: Partial<TileSpec> = {}): TileSpec => ({
  doc: 'tab-1',
  page: 0,
  bucket: 0,
  rotation: 0,
  flags: 'afg---w-',
  col: 0,
  row: 0,
  ...patch,
});

describe('tile grid', () => {
  it('covers a page with whole tiles', () => {
    expect(gridSize(1024, 1024)).toEqual({ cols: 2, rows: 2 });
    expect(gridSize(1025, 1)).toEqual({ cols: 3, rows: 1 });
    expect(gridSize(0, 0)).toEqual({ cols: 1, rows: 1 });
  });

  it('clips the last tile in each direction to the page', () => {
    expect(tileRect({ col: 0, row: 0 }, 600, 700)).toEqual({
      x: 0,
      y: 0,
      width: TILE_SIZE,
      height: TILE_SIZE,
    });
    expect(tileRect({ col: 1, row: 1 }, 600, 700)).toEqual({
      x: 512,
      y: 512,
      width: 88,
      height: 188,
    });
    // A tile entirely off the page has no area.
    expect(tileRect({ col: 5, row: 0 }, 600, 700).width).toBe(0);
  });

  it('lists exactly the tiles a visible rectangle touches', () => {
    expect(tilesForRect({ x: 0, y: 0, width: 10, height: 10 }, 2000, 2000)).toEqual([
      { col: 0, row: 0 },
    ]);
    const band = tilesForRect({ x: 500, y: 0, width: 30, height: 10 }, 2000, 2000);
    expect(band).toEqual([
      { col: 0, row: 0 },
      { col: 1, row: 0 },
    ]);
    expect(tilesForRect({ x: 0, y: 0, width: 2000, height: 2000 }, 2000, 2000)).toHaveLength(16);
  });

  it('never returns a tile outside the page, whatever it is asked', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -2000, max: 4000 }),
        fc.integer({ min: 0, max: 4000 }),
        fc.integer({ min: 1, max: 4000 }),
        (x, width, pageWidth) => {
          const { cols } = gridSize(pageWidth, 100);
          for (const t of tilesForRect({ x, y: 0, width, height: 10 }, pageWidth, 100)) {
            expect(t.col).toBeGreaterThanOrEqual(0);
            expect(t.col).toBeLessThan(cols);
          }
        },
      ),
    );
  });

  it('orders tiles by distance from the focus, stably', () => {
    const tiles = [
      { col: 0, row: 0 },
      { col: 3, row: 0 },
      { col: 1, row: 0 },
    ];
    const ordered = orderByDistance(tiles, { x: 512 + 256, y: 256 });
    expect(ordered[0]).toEqual({ col: 1, row: 0 });
    // Equal distances keep their input order.
    const tied = orderByDistance(
      [
        { col: 0, row: 0 },
        { col: 2, row: 0 },
      ],
      { x: 512 + 256, y: 256 },
    );
    expect(tied).toEqual([
      { col: 0, row: 0 },
      { col: 2, row: 0 },
    ]);
  });
});

describe('tile ids', () => {
  it('changes when anything that changes the pixels changes', () => {
    const base = tileId(spec());
    expect(tileId(spec())).toBe(base);
    for (const patch of [
      { doc: 'tab-2' },
      { page: 1 },
      { bucket: 8 },
      { rotation: 90 },
      { flags: 'afg---wn' },
      { col: 1 },
      { row: 1 },
    ] as Array<Partial<TileSpec>>) {
      expect(tileId(spec(patch))).not.toBe(base);
    }
  });

  it('is prefixed by the document key so a closing tab can drop its own tiles', () => {
    expect(tileId(spec())).toMatch(/^tab-1\|/);
  });
});

describe('TileCache', () => {
  const value = (n: number): { n: number } => ({ n });

  it('evicts the least recently used first', () => {
    const cache = new TileCache<{ n: number }>({ maxBytes: 300 });
    cache.set('a', value(1), 100);
    cache.set('b', value(2), 100);
    cache.set('c', value(3), 100);
    cache.get('a'); // a is now the most recent
    cache.set('d', value(4), 100);
    expect(cache.has('b')).toBe(false);
    expect(cache.keys()).toEqual(['c', 'a', 'd']);
  });

  it('stays inside its byte budget', () => {
    const cache = new TileCache<{ n: number }>({ maxBytes: megabytes(1) });
    for (let i = 0; i < 200; i++) cache.set(`t${i}`, value(i), bitmapBytes(512, 512));
    expect(cache.bytes).toBeLessThanOrEqual(megabytes(1));
    expect(cache.stats().evictions).toBeGreaterThan(0);
  });

  it('shrinking the budget evicts immediately', () => {
    const cache = new TileCache<{ n: number }>({ maxBytes: 1000 });
    for (let i = 0; i < 10; i++) cache.set(`t${i}`, value(i), 100);
    expect(cache.size).toBe(10);
    cache.setMaxBytes(300);
    expect(cache.size).toBe(3);
    expect(cache.bytes).toBe(300);
  });

  it('disposes everything that leaves', () => {
    const dispose = vi.fn();
    const cache = new TileCache<{ n: number }>({ maxBytes: 200, dispose });
    cache.set('a', value(1), 100);
    cache.set('b', value(2), 100);
    cache.set('c', value(3), 100); // evicts a
    expect(dispose).toHaveBeenCalledTimes(1);
    cache.set('b', value(9), 100); // overwrite disposes the old value
    expect(dispose).toHaveBeenCalledTimes(2);
    cache.delete('b');
    expect(dispose).toHaveBeenCalledTimes(3);
    cache.clear();
    expect(dispose).toHaveBeenCalledTimes(4);
  });

  it('refuses a value bigger than the whole budget instead of emptying itself', () => {
    const dispose = vi.fn();
    const cache = new TileCache<{ n: number }>({ maxBytes: 100, dispose });
    cache.set('small', value(1), 50);
    cache.set('huge', value(2), 1000);
    expect(cache.has('small')).toBe(true);
    expect(cache.has('huge')).toBe(false);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('counts hits and misses, and peek counts neither', () => {
    const cache = new TileCache<{ n: number }>({ maxBytes: 1000 });
    cache.set('a', value(1), 10);
    cache.get('a');
    cache.get('b');
    expect(cache.stats().hitRate).toBe(0.5);
    cache.peek('a');
    cache.peek('zzz');
    expect(cache.stats().hitRate).toBe(0.5);
    cache.resetStats();
    expect(cache.stats().hitRate).toBe(0);
  });

  it('drops a whole document’s tiles by prefix', () => {
    const cache = new TileCache<{ n: number }>({ maxBytes: 10_000 });
    cache.set(tileId(spec({ doc: 'tab-1', page: 0 })), value(1), 10);
    cache.set(tileId(spec({ doc: 'tab-1', page: 1 })), value(2), 10);
    cache.set(tileId(spec({ doc: 'tab-2', page: 0 })), value(3), 10);
    expect(cache.deleteWhere((k) => k.startsWith('tab-1|'))).toBe(2);
    expect(cache.size).toBe(1);
  });

  it('bitmapBytes is four bytes a pixel and never negative', () => {
    expect(bitmapBytes(512, 512)).toBe(512 * 512 * 4);
    expect(bitmapBytes(-5, 10)).toBe(0);
  });
});

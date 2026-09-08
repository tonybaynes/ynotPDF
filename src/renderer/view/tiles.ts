/**
 * Tile geometry and scheduling maths (M11). Pure — no DOM, no engine.
 *
 * A page at a given zoom is covered by a grid of `TILE_SIZE` CSS-px tiles (times the device
 * pixel ratio in real pixels). A tile is identified by the document, page, zoom bucket, view
 * rotation, render flags and its grid position, so two viewports on the same document at the
 * same zoom share every tile.
 */

/** Tile edge in CSS pixels. 512 keeps a 1× A4 page to 2 × 2 tiles and a 4× page to 5 × 7. */
export const TILE_SIZE = 512;

/** A tile's position in the page's grid. */
export interface TileCoord {
  readonly col: number;
  readonly row: number;
}

/** Everything that decides what a tile's pixels look like. */
export interface TileSpec extends TileCoord {
  /** Tab-scoped document key (two tabs on the same file still render separately). */
  readonly doc: string;
  readonly page: number;
  /** `bucketKey(zoom)` — the log-scale zoom bucket. */
  readonly bucket: number;
  /** Extra view rotation in degrees. */
  readonly rotation: number;
  /** Render flags that change pixels: grayscale, smoothing, night mode, line weights. */
  readonly flags: string;
}

/** A stable string id for a tile. */
export function tileId(spec: TileSpec): string {
  return `${spec.doc}|${spec.page}|${spec.bucket}|${spec.rotation}|${spec.flags}|${spec.col}|${spec.row}`;
}

/** A rectangle in the page's device pixels (origin top-left of the displayed page). */
export interface PxRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Number of tile columns and rows a page needs at a given displayed size. */
export function gridSize(
  pageWidthPx: number,
  pageHeightPx: number,
  tileSize = TILE_SIZE,
): { cols: number; rows: number } {
  return {
    cols: Math.max(1, Math.ceil(pageWidthPx / tileSize)),
    rows: Math.max(1, Math.ceil(pageHeightPx / tileSize)),
  };
}

/** The CSS-px rectangle a tile covers inside the page, clipped to the page box. */
export function tileRect(
  coord: TileCoord,
  pageWidthPx: number,
  pageHeightPx: number,
  tileSize = TILE_SIZE,
): PxRect {
  const x = coord.col * tileSize;
  const y = coord.row * tileSize;
  return {
    x,
    y,
    width: Math.max(0, Math.min(tileSize, pageWidthPx - x)),
    height: Math.max(0, Math.min(tileSize, pageHeightPx - y)),
  };
}

/** Every tile whose rectangle intersects `visible` (CSS px inside the page). */
export function tilesForRect(
  visible: PxRect,
  pageWidthPx: number,
  pageHeightPx: number,
  tileSize = TILE_SIZE,
): TileCoord[] {
  const { cols, rows } = gridSize(pageWidthPx, pageHeightPx, tileSize);
  const c0 = Math.max(0, Math.floor(visible.x / tileSize));
  const r0 = Math.max(0, Math.floor(visible.y / tileSize));
  const c1 = Math.min(
    cols - 1,
    Math.floor((visible.x + Math.max(0, visible.width) - 1) / tileSize),
  );
  const r1 = Math.min(
    rows - 1,
    Math.floor((visible.y + Math.max(0, visible.height) - 1) / tileSize),
  );
  const out: TileCoord[] = [];
  for (let row = r0; row <= r1; row++) {
    for (let col = c0; col <= c1; col++) out.push({ col, row });
  }
  return out;
}

/**
 * Orders tiles by distance from a focus point (the viewport centre expressed in the page's own
 * CSS px), so the tile the eye is on is rasterised first. Stable for equal distances.
 */
export function orderByDistance(
  tiles: ReadonlyArray<TileCoord>,
  focus: { readonly x: number; readonly y: number },
  tileSize = TILE_SIZE,
): TileCoord[] {
  const score = (t: TileCoord): number => {
    const cx = (t.col + 0.5) * tileSize;
    const cy = (t.row + 0.5) * tileSize;
    return (cx - focus.x) ** 2 + (cy - focus.y) ** 2;
  };
  return [...tiles]
    .map((t, i) => ({ t, i, s: score(t) }))
    .sort((a, b) => a.s - b.s || a.i - b.i)
    .map((e) => e.t);
}

/** Bytes an RGBA bitmap of this size occupies. */
export function bitmapBytes(width: number, height: number): number {
  return Math.max(0, Math.round(width)) * Math.max(0, Math.round(height)) * 4;
}

/**
 * `layoutPages` — the layout table (M11). Pure: page sizes + zoom + mode in, content-relative
 * rectangles out. Nothing here touches the DOM, so the whole thing is unit-testable in Node and
 * the viewport is free to place the rects however it likes.
 *
 * Coordinates are CSS pixels with the origin at the top-left of the *content* (not the
 * viewport); the viewport centres the content itself. Page sizes arrive in PDF points as the
 * engine reports them (already rotated by `/Rotate`); `zoom` is CSS pixels per point and the
 * extra view rotation is applied here so a rotated view re-flows properly.
 *
 * Rows come from two booleans:
 *
 * | mode                | facing | cover | continuous |
 * |---------------------|--------|-------|------------|
 * | `single`            | no     | –     | no         |
 * | `continuous`        | no     | –     | yes        |
 * | `facing`            | yes    | no    | no         |
 * | `facingContinuous`  | yes    | no    | yes        |
 * | `book`              | yes    | yes   | yes        |
 *
 * Facing rows sit on a two-column grid whose column widths are the maxima over every left- and
 * right-hand page, spine-aligned, so spreads line up down the document as they do in Foxit.
 * "Book" puts page 1 alone in the right column, which is where a cover belongs.
 */

import type { Rotation } from '@shared/pdf';

/** The five page layouts (Foxit's View tab). */
export type LayoutMode = 'single' | 'continuous' | 'facing' | 'facingContinuous' | 'book';

export const LAYOUT_MODES: ReadonlyArray<LayoutMode> = [
  'single',
  'continuous',
  'facing',
  'facingContinuous',
  'book',
];

/** Displayed size of one page in points, as `PdfEngine.pageSize` reports it. */
export interface LayoutPageSize {
  readonly width: number;
  readonly height: number;
}

export interface LayoutOptions {
  readonly mode: LayoutMode;
  /** CSS pixels per point. */
  readonly zoom: number;
  /** Gap between pages, CSS px. */
  readonly gap: number;
  /** Padding around the whole content, CSS px. */
  readonly padding: number;
  /** Extra view rotation (View ▸ Rotate), clockwise. Swaps every page's width and height. */
  readonly rotation?: Rotation;
}

/** One page's box, relative to the content origin. */
export interface PageRect {
  readonly page: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** A row of pages: one page, or a facing spread. */
export interface LayoutRow {
  readonly index: number;
  readonly pages: ReadonlyArray<number>;
  readonly y: number;
  readonly height: number;
}

export interface LayoutTable {
  readonly mode: LayoutMode;
  readonly continuous: boolean;
  readonly rects: ReadonlyArray<PageRect>;
  readonly rows: ReadonlyArray<LayoutRow>;
  /** Content size in CSS px, padding included. */
  readonly width: number;
  readonly height: number;
  readonly zoom: number;
}

/** Whether a mode pairs pages. */
export function isFacing(mode: LayoutMode): boolean {
  return mode === 'facing' || mode === 'facingContinuous' || mode === 'book';
}

/** Whether a mode scrolls through every page or shows one row at a time. */
export function isContinuous(mode: LayoutMode): boolean {
  return mode === 'continuous' || mode === 'facingContinuous' || mode === 'book';
}

/** Whether the first page stands alone (a cover). */
export function hasCover(mode: LayoutMode): boolean {
  return mode === 'book';
}

/** Groups page indexes into rows for a mode. */
export function rowsFor(pageCount: number, mode: LayoutMode): ReadonlyArray<ReadonlyArray<number>> {
  const rows: number[][] = [];
  if (pageCount <= 0) return rows;
  if (!isFacing(mode)) {
    for (let i = 0; i < pageCount; i++) rows.push([i]);
    return rows;
  }
  let i = 0;
  if (hasCover(mode)) {
    rows.push([0]);
    i = 1;
  }
  for (; i < pageCount; i += 2) {
    const pair = i + 1 < pageCount ? [i, i + 1] : [i];
    rows.push(pair);
  }
  return rows;
}

/**
 * The column a page occupies inside its row: 0 = left, 1 = right. A lone cover sits on the
 * right (it is a front cover); a lone trailing page sits on the left.
 */
export function columnOf(row: ReadonlyArray<number>, page: number, cover: boolean): 0 | 1 {
  if (row.length === 2) return row[0] === page ? 0 : 1;
  return cover && row[0] === 0 ? 1 : 0;
}

/** Displayed size of a page in CSS px at `zoom`, with the extra view rotation applied. */
export function pageBoxPx(
  size: LayoutPageSize,
  zoom: number,
  rotation: Rotation = 0,
): {
  width: number;
  height: number;
} {
  const swap = rotation === 90 || rotation === 270;
  const w = (swap ? size.height : size.width) * zoom;
  const h = (swap ? size.width : size.height) * zoom;
  return { width: Math.max(1, w), height: Math.max(1, h) };
}

/**
 * Builds the layout table. Pages are vertically centred inside their row and, in facing modes,
 * spine-aligned inside their column.
 */
export function layoutPages(
  sizes: ReadonlyArray<LayoutPageSize>,
  options: LayoutOptions,
): LayoutTable {
  const { mode, gap, padding } = options;
  const zoom = options.zoom > 0 ? options.zoom : 1;
  const rotation = options.rotation ?? 0;
  const facing = isFacing(mode);
  const cover = hasCover(mode);
  const boxes = sizes.map((s) => pageBoxPx(s, zoom, rotation));
  const groups = rowsFor(sizes.length, mode);

  if (groups.length === 0) {
    return {
      mode,
      continuous: isContinuous(mode),
      rects: [],
      rows: [],
      width: padding * 2,
      height: padding * 2,
      zoom,
    };
  }

  // Column widths: the widest page that ever lands in each column.
  let col0 = 0;
  let col1 = 0;
  for (const row of groups) {
    for (const page of row) {
      const box = boxes[page];
      if (!box) continue;
      if (facing && columnOf(row, page, cover) === 1) col1 = Math.max(col1, box.width);
      else col0 = Math.max(col0, box.width);
    }
  }
  const contentWidth = facing ? (col1 > 0 ? col0 + gap + col1 : col0) : col0;

  const rects: PageRect[] = [];
  const rows: LayoutRow[] = [];
  let y = padding;
  for (const [index, row] of groups.entries()) {
    let rowHeight = 0;
    for (const page of row) rowHeight = Math.max(rowHeight, boxes[page]?.height ?? 0);
    for (const page of row) {
      const box = boxes[page];
      if (!box) continue;
      const column = facing ? columnOf(row, page, cover) : 0;
      // Spine-aligned: the left column is right-aligned, the right column left-aligned.
      const x =
        facing && column === 1
          ? padding + col0 + gap
          : facing
            ? padding + col0 - box.width
            : padding + (contentWidth - box.width) / 2;
      rects.push({
        page,
        x,
        y: y + (rowHeight - box.height) / 2,
        width: box.width,
        height: box.height,
      });
    }
    rows.push({ index, pages: row, y, height: rowHeight });
    y += rowHeight + gap;
  }
  const height = y - gap + padding;
  rects.sort((a, b) => a.page - b.page);

  return {
    mode,
    continuous: isContinuous(mode),
    rects,
    rows,
    width: contentWidth + padding * 2,
    height,
    zoom,
  };
}

/** The row a page belongs to, or `-1`. */
export function rowOfPage(table: LayoutTable, page: number): number {
  return table.rows.findIndex((r) => r.pages.includes(page));
}

/** The rect of a page, or `undefined` when the page is not in the table. */
export function rectOfPage(table: LayoutTable, page: number): PageRect | undefined {
  return table.rects.find((r) => r.page === page);
}

/**
 * The page that occupies most of the visible band `[top, top + height)` — what the status bar
 * calls "the current page". Ties go to the lower-numbered page so scrolling up is stable.
 */
export function pageAt(table: LayoutTable, top: number, height: number): number {
  const bottom = top + height;
  let best = -1;
  let bestArea = -1;
  for (const r of table.rects) {
    const overlap = Math.min(bottom, r.y + r.height) - Math.max(top, r.y);
    if (overlap <= 0) continue;
    if (overlap > bestArea + 0.5) {
      bestArea = overlap;
      best = r.page;
    }
  }
  if (best >= 0) return best;
  // Nothing overlaps (a gap, or scrolled past the end): take the nearest page.
  let nearest = 0;
  let distance = Number.POSITIVE_INFINITY;
  for (const r of table.rects) {
    const d = r.y > bottom ? r.y - bottom : top - (r.y + r.height);
    if (d < distance) {
      distance = d;
      nearest = r.page;
    }
  }
  return nearest;
}

/** Every page whose rect intersects the band `[top - margin, top + height + margin)`. */
export function pagesInBand(
  table: LayoutTable,
  top: number,
  height: number,
  margin = 0,
): ReadonlyArray<number> {
  const a = top - margin;
  const b = top + height + margin;
  return table.rects.filter((r) => r.y + r.height > a && r.y < b).map((r) => r.page);
}

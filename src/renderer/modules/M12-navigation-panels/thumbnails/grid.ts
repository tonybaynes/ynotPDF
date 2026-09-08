/**
 * Thumbnail grid geometry (M12) — pure, and the whole of the operator's layout requirement:
 *
 * - the panel **opens as one column** at the current size, and its width is whatever one column
 *   needs, which is what {@link paneWidthFor} answers;
 * - `+` / `−` (and Ctrl+wheel) step {@link THUMBNAIL_SIZES} and re-set that width, so the
 *   splitter never has to be dragged after a zoom;
 * - **dragging the splitter wider adds columns** — {@link columnsFor} divides the width it is
 *   given by the column pitch. The column count is derived on every layout and stored nowhere.
 *
 * Rows, not pages, are virtualised: every row is the same height for a given size, so the first
 * and last visible rows are arithmetic ({@link visibleRows}) however many pages there are.
 */

/** The size ladder, in CSS pixels of thumbnail width. */
export const THUMBNAIL_SIZES: ReadonlyArray<number> = [80, 120, 160, 220, 300];

export const DEFAULT_THUMBNAIL_SIZE = 120;

/** Gap between thumbnails, and the padding around the grid. */
export const GRID_GAP = 12;
export const GRID_PADDING = 10;
/** Height of the page label under each thumbnail. */
export const LABEL_HEIGHT = 18;
/** Width of the panel's own scrollbar, reserved so a column is never half-hidden by it. */
export const SCROLLBAR = 14;

/** The nearest size on the ladder — a hand-edited setting can say anything. */
export function nearestSize(width: number): number {
  if (!Number.isFinite(width)) return DEFAULT_THUMBNAIL_SIZE;
  return THUMBNAIL_SIZES.reduce(
    (best, size) => (Math.abs(size - width) < Math.abs(best - width) ? size : best),
    THUMBNAIL_SIZES[0] ?? DEFAULT_THUMBNAIL_SIZE,
  );
}

/** One step up or down the ladder; the ends hold. */
export function stepSize(current: number, direction: 1 | -1): number {
  const at = THUMBNAIL_SIZES.indexOf(nearestSize(current));
  const next = THUMBNAIL_SIZES[at + direction];
  return next ?? THUMBNAIL_SIZES[at] ?? DEFAULT_THUMBNAIL_SIZE;
}

export function canStep(current: number, direction: 1 | -1): boolean {
  const at = THUMBNAIL_SIZES.indexOf(nearestSize(current));
  return THUMBNAIL_SIZES[at + direction] !== undefined;
}

/** Horizontal distance from one column to the next. */
export function columnPitch(size: number): number {
  return size + GRID_GAP;
}

/**
 * The panel width that shows exactly `columns` columns at this size — what `+` and `−` set, and
 * what the panel opens at.
 */
export function paneWidthFor(size: number, columns = 1): number {
  return Math.round(columns * columnPitch(size) - GRID_GAP + 2 * GRID_PADDING + SCROLLBAR);
}

/** How many columns fit in `width`. At least one, however narrow the pane has been dragged. */
export function columnsFor(width: number, size: number): number {
  const usable = width - 2 * GRID_PADDING - SCROLLBAR + GRID_GAP;
  if (!Number.isFinite(usable)) return 1;
  return Math.max(1, Math.floor(usable / columnPitch(size)));
}

/** A page's thumbnail box: the page scaled to fit `size` wide, never taller than `size * 1.6`. */
export function thumbnailBox(
  page: { readonly width: number; readonly height: number },
  size: number,
): { width: number; height: number } {
  const maxHeight = Math.round(size * 1.6);
  const aspect = page.width > 0 && page.height > 0 ? page.height / page.width : 1.414;
  const height = Math.min(maxHeight, Math.round(size * aspect));
  const width = Math.min(size, Math.round(height / (aspect || 1)));
  return { width: Math.max(8, width), height: Math.max(8, height) };
}

/**
 * Row height for a size: the tallest thumbnail a page may produce, plus the label. It is the
 * same for every row, which is what makes the virtualisation arithmetic rather than a
 * measurement.
 */
export function rowHeight(size: number): number {
  return Math.round(size * 1.6) + LABEL_HEIGHT + GRID_GAP;
}

export interface GridMetrics {
  readonly columns: number;
  readonly rows: number;
  readonly rowHeight: number;
  /** Total scrollable height of the grid, padding included. */
  readonly height: number;
}

export function metrics(pageCount: number, width: number, size: number): GridMetrics {
  const columns = columnsFor(width, size);
  const rows = Math.ceil(Math.max(0, pageCount) / columns);
  const height = rowHeight(size);
  return {
    columns,
    rows,
    rowHeight: height,
    height: Math.max(0, rows * height - GRID_GAP) + 2 * GRID_PADDING,
  };
}

/** The rows that intersect the viewport, plus `overscan` rows either side. */
export function visibleRows(
  scrollTop: number,
  viewportHeight: number,
  grid: GridMetrics,
  overscan = 1,
): { first: number; last: number } {
  if (grid.rows === 0) return { first: 0, last: -1 };
  const top = Math.max(0, scrollTop - GRID_PADDING);
  const first = Math.max(0, Math.floor(top / grid.rowHeight) - overscan);
  const last = Math.min(
    grid.rows - 1,
    Math.floor((top + Math.max(0, viewportHeight)) / grid.rowHeight) + overscan,
  );
  return { first, last: Math.max(first, last) };
}

/** Pages in a row, in reading order. */
export function pagesInRow(row: number, pageCount: number, columns: number): number[] {
  const start = row * columns;
  const out: number[] = [];
  for (let i = start; i < Math.min(start + columns, pageCount); i++) out.push(i);
  return out;
}

/** Scroll offset that brings a page's row into view, or `null` when it is already visible. */
export function scrollToPage(
  page: number,
  scrollTop: number,
  viewportHeight: number,
  grid: GridMetrics,
): number | null {
  if (grid.rows === 0) return null;
  const row = Math.floor(page / grid.columns);
  const top = GRID_PADDING + row * grid.rowHeight;
  const bottom = top + grid.rowHeight - GRID_GAP;
  if (top >= scrollTop && bottom <= scrollTop + viewportHeight) return null;
  // Centre it: after a `+` or `−` step the page the reader was on should still be in front of
  // them, not clinging to an edge.
  return Math.max(0, Math.round(top - (viewportHeight - grid.rowHeight) / 2));
}

/** Which page a keyboard move lands on, given the grid. Out-of-range moves hold. */
export function keyboardTarget(
  current: number,
  key:
    'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown' | 'Home' | 'End' | 'PageUp' | 'PageDown',
  pageCount: number,
  grid: GridMetrics,
  viewportHeight = 0,
): number {
  const rowsPerPage = Math.max(1, Math.floor(viewportHeight / grid.rowHeight));
  const step = {
    ArrowLeft: -1,
    ArrowRight: 1,
    ArrowUp: -grid.columns,
    ArrowDown: grid.columns,
    PageUp: -grid.columns * rowsPerPage,
    PageDown: grid.columns * rowsPerPage,
    Home: -Infinity,
    End: Infinity,
  }[key];
  if (step === -Infinity) return 0;
  if (step === Infinity) return Math.max(0, pageCount - 1);
  const next = current + step;
  return next < 0 || next >= pageCount ? current : next;
}

/** The pages a Shift-click selects, whichever way round the two ends are. */
export function rangeBetween(anchor: number, page: number): number[] {
  const [from, to] = anchor <= page ? [anchor, page] : [page, anchor];
  const out: number[] = [];
  for (let i = from; i <= to; i++) out.push(i);
  return out;
}

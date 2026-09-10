/**
 * Row geometry for the virtualised comments list (M32). Pure arithmetic.
 *
 * A comment's height depends on how much it says, so the rows are not all the same height and the
 * usual "index × rowHeight" trick does not work. Measuring every row's DOM would defeat the point
 * of virtualising at all — 2000 comments would mean 2000 elements just to find out how tall they
 * are — so each row's height is **computed** from its text, at a fixed number of characters per
 * line, and every row is then positioned absolutely at its computed offset.
 *
 * The estimate is not the browser's own wrapping, and it does not have to be: a row clips its
 * content to its own box, so an estimate that is a line out shows a line more or less of a
 * comment, never a broken layout. Selecting a comment expands it to its full text, which is when
 * an exact height matters and when there is exactly one row to measure.
 */

import type { CommentRow } from './rows';

/**
 * Heights in CSS pixels **at 100 % UI scale**. The stylesheet uses the same numbers, in rem, so
 * everything the browser draws doubles at 200 % while these constants do not: `options.scale`
 * is what puts the two back in step. Without it every row was a fixed 100 %-height box holding
 * 200 %-sized text, and the whole list clipped — at 150 %, which is the scale the operator runs
 * (M04, 2026-09-10).
 */
export const GROUP_ROW_HEIGHT = 26;
export const COMMENT_HEADER_HEIGHT = 38;
export const REPLY_HEADER_HEIGHT = 20;
export const LINE_HEIGHT = 17;
export const ROW_PADDING = 8;
/** Lines of text a collapsed row shows before it clips. */
export const CLAMPED_LINES = 3;
/** Lines the expanded (selected) row will show before it scrolls inside itself. */
export const EXPANDED_LINES = 40;
/** Room under an expanded comment for the reply box and the status line. */
export const EXPANDED_EXTRA = 34;

/** Average glyph width as a fraction of the font size, for the panel's UI font. */
const AVERAGE_GLYPH = 0.52;

/** How many lines `text` takes in a box `width` px wide at `fontSize`. At least one. */
export function lineCount(text: string, width: number, fontSize: number): number {
  const perLine = Math.max(8, Math.floor(width / (fontSize * AVERAGE_GLYPH)));
  let lines = 0;
  for (const paragraph of text.split(/\r\n|\r|\n/)) {
    lines += Math.max(1, Math.ceil(paragraph.length / perLine));
  }
  return Math.max(1, lines);
}

export interface RowMetricsOptions {
  /** Usable width of a row's text, in CSS pixels — measured, so already at the reader's scale. */
  readonly width: number;
  /** Text size at 100 % UI scale. */
  readonly fontSize: number;
  /** The row the reader has selected, which shows its whole text. */
  readonly expanded: string | null;
  /** The reader's UI scale, 1 = 100 %. Every constant above is a length at scale 1. */
  readonly scale?: number;
}

export interface RowMetrics {
  /** Top offset of each row, same order and length as the rows given. */
  readonly offsets: ReadonlyArray<number>;
  readonly heights: ReadonlyArray<number>;
  readonly total: number;
}

/** The height one row wants. */
export function heightOf(row: CommentRow, options: RowMetricsOptions): number {
  const scale = options.scale ?? 1;
  if (row.kind === 'group') return GROUP_ROW_HEIGHT * scale;
  const expanded = options.expanded === row.id;
  const cap = expanded ? EXPANDED_LINES : CLAMPED_LINES;
  const indent = row.kind === 'reply' ? 18 * scale : 0;
  const lines =
    row.entry.text === ''
      ? 0
      : Math.min(
          cap,
          lineCount(
            row.entry.text,
            Math.max(40 * scale, options.width - indent),
            options.fontSize * scale,
          ),
        );
  const header = (row.kind === 'reply' ? REPLY_HEADER_HEIGHT : COMMENT_HEADER_HEIGHT) * scale;
  return (
    header +
    lines * LINE_HEIGHT * scale +
    ROW_PADDING * scale +
    (expanded ? EXPANDED_EXTRA * scale : 0)
  );
}

export function rowMetrics(
  rows: ReadonlyArray<CommentRow>,
  options: RowMetricsOptions,
): RowMetrics {
  const offsets: number[] = [];
  const heights: number[] = [];
  let top = 0;
  for (const row of rows) {
    const height = heightOf(row, options);
    offsets.push(top);
    heights.push(height);
    top += height;
  }
  return { offsets, heights, total: top };
}

/** The rows that intersect the viewport, plus `overscan` either side. `last` is inclusive. */
export function visibleRange(
  scrollTop: number,
  viewportHeight: number,
  metrics: RowMetrics,
  overscan = 3,
): { first: number; last: number } {
  const count = metrics.offsets.length;
  if (count === 0) return { first: 0, last: -1 };
  const top = Math.max(0, scrollTop);
  const bottom = top + Math.max(0, viewportHeight);
  // Binary search for the first row whose bottom edge is below the viewport's top.
  let low = 0;
  let high = count - 1;
  while (low < high) {
    const middle = (low + high) >> 1;
    const end = (metrics.offsets[middle] ?? 0) + (metrics.heights[middle] ?? 0);
    if (end <= top) low = middle + 1;
    else high = middle;
  }
  let last = low;
  while (last + 1 < count && (metrics.offsets[last + 1] ?? 0) < bottom) last++;
  return {
    first: Math.max(0, low - overscan),
    last: Math.min(count - 1, last + overscan),
  };
}

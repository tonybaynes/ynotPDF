/**
 * Where every page, block, line and connector of a comment summary goes (M32). Pure: sizes and
 * text in, coordinates out, no PDF and no engine.
 *
 * Keeping it pure is what makes "the summary has the right number of pages and says the right
 * things" testable without rendering anything — which matters, because the four layouts differ
 * mostly in arithmetic and a page count is exactly the kind of thing that goes wrong quietly.
 *
 * All coordinates are PDF user space of the *output* page: points, origin bottom-left.
 */

import { textWidth, wrapText } from '@engine/appearance/metrics';
import type { PdfPoint } from '@shared/pdf';
import {
  MAX_SUMMARY_FONT_SIZE,
  MIN_SUMMARY_FONT_SIZE,
  type SummaryBlock,
  type SummaryComment,
  type SummaryConnector,
  type SummaryOptions,
  type SummaryPagePlan,
  type SummaryPageSize,
  type SummaryPlan,
  type SummaryTextLine,
} from './types';

const BODY_FONT = 'Helvetica';
const HEAD_FONT = 'Helvetica-Bold';

/** Page furniture, in points. Chosen so a 9 pt summary has a comfortable measure at A4 width. */
const MARGIN = 36;
const GUTTER = 18;
const BLOCK_GAP = 10;
const BLOCK_PADDING = 6;
const HEADING_GAP = 16;
/** The width a comments-only page uses when there is no source page to take a size from. */
const DEFAULT_PAGE: SummaryPageSize = { width: 595.28, height: 841.89 };

export function clampFontSize(size: number): number {
  if (!Number.isFinite(size)) return 9;
  return Math.min(MAX_SUMMARY_FONT_SIZE, Math.max(MIN_SUMMARY_FONT_SIZE, Math.round(size)));
}

/** Date as the summary prints it: en-GB, the same as everywhere else in the app. */
export function formatSummaryDate(iso: string | null): string {
  if (iso === null || iso === '') return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('en-GB', {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC',
  }).format(date);
}

/** The comparator a sort order means. Page order is always the tie-break, so it is stable. */
export function compareComments(
  sort: SummaryOptions['sort'],
): (a: SummaryComment, b: SummaryComment) => number {
  const byPage = (a: SummaryComment, b: SummaryComment): number =>
    a.page - b.page || b.anchor.y - a.anchor.y || a.anchor.x - b.anchor.x;
  switch (sort) {
    case 'author':
      return (a, b) => a.author.localeCompare(b.author, 'en-GB') || byPage(a, b);
    case 'date':
      return (a, b) => (a.date ?? '').localeCompare(b.date ?? '') || byPage(a, b);
    case 'type':
      return (a, b) => a.type.localeCompare(b.type, 'en-GB') || byPage(a, b);
    case 'page':
      return byPage;
  }
}

/** The lines one comment's block holds: a heading, the text, then each reply indented. */
export function blockLines(
  comment: SummaryComment,
  sequence: number,
  width: number,
  options: SummaryOptions,
): SummaryTextLine[] {
  const size = clampFontSize(options.fontSize);
  const head = size + 1;
  const lines: SummaryTextLine[] = [];
  const prefix = options.sequenceNumbers ? `${String(sequence)}. ` : '';
  const heading = `${prefix}${comment.type} — ${comment.author}`;
  for (const text of wrapText(heading, HEAD_FONT, head, width)) {
    lines.push({ text, bold: true, size: head, indent: 0 });
  }
  const meta = [
    formatSummaryDate(comment.date),
    comment.status === null ? '' : `Status: ${comment.status}`,
  ]
    .filter((part) => part !== '')
    .join(' · ');
  if (meta !== '') {
    for (const text of wrapText(meta, BODY_FONT, size, width)) {
      lines.push({ text, bold: false, size, indent: 0 });
    }
  }
  if (comment.text.trim() !== '') {
    for (const text of wrapText(comment.text, BODY_FONT, size, width)) {
      lines.push({ text, bold: false, size, indent: 0 });
    }
  }
  const indent = size * 1.5;
  for (const reply of comment.replies) {
    const replyHead = [
      `Reply — ${reply.author}`,
      formatSummaryDate(reply.date),
      reply.status === null ? '' : `set to ${reply.status}`,
    ]
      .filter((part) => part !== '')
      .join(' · ');
    for (const text of wrapText(replyHead, HEAD_FONT, size, width - indent)) {
      lines.push({ text, bold: true, size, indent });
    }
    if (reply.text.trim() !== '') {
      for (const text of wrapText(reply.text, BODY_FONT, size, width - indent)) {
        lines.push({ text, bold: false, size, indent });
      }
    }
  }
  return lines;
}

function blockHeight(lines: ReadonlyArray<SummaryTextLine>): number {
  const text = lines.reduce((total, line) => total + line.size * 1.35, 0);
  return text + BLOCK_PADDING * 2;
}

/** The widest line in a block, for the marker that sits beside it. */
export function widestLine(lines: ReadonlyArray<SummaryTextLine>): number {
  return lines.reduce(
    (widest, line) =>
      Math.max(
        widest,
        line.indent + textWidth(line.text, line.bold ? HEAD_FONT : BODY_FONT, line.size),
      ),
    0,
  );
}

interface Column {
  readonly x: number;
  readonly width: number;
  readonly top: number;
  readonly bottom: number;
}

/**
 * Fills one column with blocks, spilling into a new page through `newPage` when it runs out.
 * Returns the blocks it placed on each page, in page order.
 */
function flow(
  comments: ReadonlyArray<{ comment: SummaryComment; sequence: number }>,
  column: Column,
  options: SummaryOptions,
): SummaryBlock[][] {
  const pages: SummaryBlock[][] = [[]];
  const inner = column.width - BLOCK_PADDING * 2;
  let y = column.top;
  for (const { comment, sequence } of comments) {
    const lines = blockLines(comment, sequence, inner, options);
    const height = blockHeight(lines);
    if (y - height < column.bottom && (pages[pages.length - 1]?.length ?? 0) > 0) {
      pages.push([]);
      y = column.top;
    }
    const block: SummaryBlock = {
      commentId: comment.id,
      sequence,
      x: column.x,
      y: y - height,
      width: column.width,
      height,
      lines,
      connector: { x: column.x, y: y - BLOCK_PADDING - (lines[0]?.size ?? options.fontSize) },
    };
    pages[pages.length - 1]?.push(block);
    y -= height + BLOCK_GAP;
  }
  return pages;
}

/**
 * Lays a whole summary out.
 *
 * `pageSizes` is indexed by source page number and gives the size of each page as it is
 * displayed (so a rotated page is already swapped). Comments on a page the options do not
 * include are counted in `skipped` rather than dropped silently.
 */
export function layoutSummary(
  comments: ReadonlyArray<SummaryComment>,
  pageSizes: ReadonlyArray<SummaryPageSize>,
  options: SummaryOptions,
): SummaryPlan {
  const included = new Set(options.pages);
  const kept = comments.filter((c) => included.has(c.page));
  const skipped = comments.length - kept.length;
  const ordered = [...kept].sort(compareComments(options.sort));
  const sequenceOf = new Map<string, number>();
  ordered.forEach((comment, index) => sequenceOf.set(comment.id, index + 1));

  const sizeOf = (page: number): SummaryPageSize => pageSizes[page] ?? DEFAULT_PAGE;
  const numbered = (list: ReadonlyArray<SummaryComment>) =>
    list.map((comment) => ({ comment, sequence: sequenceOf.get(comment.id) ?? 0 }));

  if (options.layout === 'comments-only') {
    return {
      pages: commentsOnly(numbered(ordered), sizeOf(options.pages[0] ?? 0), options),
      ordered,
      skipped,
    };
  }

  const pages: SummaryPagePlan[] = [];
  for (const page of options.pages) {
    const onPage = ordered.filter((c) => c.page === page);
    if (onPage.length === 0 && !options.includeEmptyPages) continue;
    const size = sizeOf(page);
    if (options.layout === 'single-connectors') {
      pages.push(...sideBySide(page, size, numbered(onPage), options));
    } else {
      pages.push(...facing(page, size, numbered(onPage), options));
    }
  }
  return { pages, ordered, skipped };
}

/** `comments-only`: plain pages, one column, nothing but the blocks. */
function commentsOnly(
  entries: ReadonlyArray<{ comment: SummaryComment; sequence: number }>,
  size: SummaryPageSize,
  options: SummaryOptions,
): SummaryPagePlan[] {
  const column: Column = {
    x: MARGIN,
    width: size.width - MARGIN * 2,
    top: size.height - MARGIN - HEADING_GAP,
    bottom: MARGIN,
  };
  const flowed = flow(entries, column, options);
  return flowed.map((blocks, index) => ({
    width: size.width,
    height: size.height,
    document: null,
    blocks,
    connectors: [],
    markers: [],
    heading:
      index === 0
        ? `${options.title} — ${String(entries.length)} ${entries.length === 1 ? 'comment' : 'comments'}`
        : `${options.title} (continued)`,
  }));
}

/**
 * `single-connectors`: the source page on the left of a wider sheet, the comments on the right,
 * and a line from each comment's place on the page to its block.
 */
function sideBySide(
  page: number,
  size: SummaryPageSize,
  entries: ReadonlyArray<{ comment: SummaryComment; sequence: number }>,
  options: SummaryOptions,
): SummaryPagePlan[] {
  const commentWidth = Math.max(180, size.width * 0.6);
  const width = size.width + GUTTER + commentWidth + MARGIN * 2;
  const height = size.height + MARGIN * 2 + HEADING_GAP;
  const documentBox = {
    sourcePage: page,
    x: MARGIN,
    y: MARGIN,
    width: size.width,
    height: size.height,
  };
  const column: Column = {
    x: MARGIN + size.width + GUTTER,
    width: commentWidth,
    top: MARGIN + size.height,
    bottom: MARGIN,
  };
  const flowed = flow(entries, column, options);
  const bySequence = new Map(entries.map((e) => [e.sequence, e.comment]));
  return flowed.map((blocks, index) => ({
    width,
    height,
    // The page itself is drawn once; a comment list that spills goes on a sheet of its own so the
    // reader is never looking at the same page twice with different comments beside it.
    document: index === 0 ? documentBox : null,
    blocks,
    connectors: connectorsFor(blocks, bySequence, documentBox, index === 0),
    markers: index === 0 ? markersFor(blocks, bySequence, documentBox, options) : [],
    heading: headingFor(page, entries.length, index),
  }));
}

/**
 * `separate-connectors` and `separate-sequence`: the source page at its own size, then a facing
 * page of the same size holding its comments. The connector layout draws a line from the marker
 * on the page across to the block; the sequence layout draws the number and no line.
 */
function facing(
  page: number,
  size: SummaryPageSize,
  entries: ReadonlyArray<{ comment: SummaryComment; sequence: number }>,
  options: SummaryOptions,
): SummaryPagePlan[] {
  const documentBox = { sourcePage: page, x: 0, y: 0, width: size.width, height: size.height };
  const documentPage: SummaryPagePlan = {
    width: size.width,
    height: size.height,
    document: documentBox,
    blocks: [],
    connectors: [],
    markers: [],
    heading: null,
  };
  const column: Column = {
    x: MARGIN,
    width: size.width - MARGIN * 2,
    top: size.height - MARGIN - HEADING_GAP,
    bottom: MARGIN,
  };
  const flowed = entries.length === 0 ? [[]] : flow(entries, column, options);
  const bySequence = new Map(entries.map((e) => [e.sequence, e.comment]));
  const commentPages: SummaryPagePlan[] = flowed.map((blocks, index) => ({
    width: size.width,
    height: size.height,
    document: null,
    blocks,
    // A connector across a page boundary is drawn to the edge of the comment page: it points the
    // reader back at the page before it, which is what "on separate pages" can honestly do.
    connectors: options.layout === 'separate-connectors' ? edgeConnectors(blocks) : [],
    markers: [],
    heading: headingFor(page, entries.length, index),
  }));

  const markers =
    options.layout === 'separate-sequence' || options.layout === 'separate-connectors'
      ? markersFor(flowed.flat(), bySequence, documentBox, options)
      : [];
  return [{ ...documentPage, markers }, ...commentPages];
}

function headingFor(page: number, count: number, index: number): string {
  const words = `${String(count)} ${count === 1 ? 'comment' : 'comments'}`;
  const base = `Page ${String(page + 1)} — ${count === 0 ? 'no comments' : words}`;
  return index === 0 ? base : `${base} (continued)`;
}

/** A line from each comment's anchor on the drawn page to the left edge of its block. */
function connectorsFor(
  blocks: ReadonlyArray<SummaryBlock>,
  bySequence: ReadonlyMap<number, SummaryComment>,
  box: { x: number; y: number; width: number; height: number },
  onThisPage: boolean,
): SummaryConnector[] {
  if (!onThisPage) return [];
  const out: SummaryConnector[] = [];
  for (const block of blocks) {
    const comment = bySequence.get(block.sequence);
    if (!comment) continue;
    out.push({
      from: anchorOnPage(comment.anchor, box),
      to: block.connector,
      sequence: block.sequence,
    });
  }
  return out;
}

/** On a facing page the line starts at the sheet's left edge, level with the block. */
function edgeConnectors(blocks: ReadonlyArray<SummaryBlock>): SummaryConnector[] {
  return blocks.map((block) => ({
    from: { x: 0, y: block.connector.y },
    to: block.connector,
    sequence: block.sequence,
  }));
}

function markersFor(
  blocks: ReadonlyArray<SummaryBlock>,
  bySequence: ReadonlyMap<number, SummaryComment>,
  box: { x: number; y: number; width: number; height: number },
  options: SummaryOptions,
): Array<{ at: PdfPoint; sequence: number }> {
  if (!options.sequenceNumbers) return [];
  const out: Array<{ at: PdfPoint; sequence: number }> = [];
  for (const block of blocks) {
    const comment = bySequence.get(block.sequence);
    if (!comment) continue;
    out.push({ at: anchorOnPage(comment.anchor, box), sequence: block.sequence });
  }
  return out;
}

/** A point in source-page space, moved to where that page is drawn on the summary page. */
export function anchorOnPage(
  anchor: PdfPoint,
  box: { x: number; y: number; width: number; height: number },
): PdfPoint {
  return { x: box.x + anchor.x, y: box.y + anchor.y };
}

export const SUMMARY_MARGIN = MARGIN;
export const SUMMARY_BODY_FONT = BODY_FONT;
export const SUMMARY_HEAD_FONT = HEAD_FONT;
export const SUMMARY_BLOCK_PADDING = BLOCK_PADDING;
export const SUMMARY_HEADING_GAP = HEADING_GAP;

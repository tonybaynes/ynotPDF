/**
 * What a comment summary is made of (M32). Plain data: the layout is a pure function of these,
 * and the builder only turns the result into a PDF.
 */

import type { PdfPoint } from '@shared/pdf';

/**
 * The four layouts. The names say what they do rather than what they look like, because the
 * difference between the first two is where the comments go, not how they are drawn.
 *
 * The set matches what a reader coming from Foxit or Acrobat expects to find (both offer the
 * same four); the drawing, the wording and the proportions are ours.
 */
export type SummaryLayout =
  /** Each source page, then a page of its comments, joined by connector lines across the pair. */
  | 'separate-connectors'
  /** Source page and its comments side by side on one wider page, joined by connector lines. */
  | 'single-connectors'
  /** No pages at all: the comments, in order, on plain pages. */
  | 'comments-only'
  /** Each source page, then a page of its comments, matched by a number rather than a line. */
  | 'separate-sequence';

/** How the comments are ordered within a page (and, for `comments-only`, throughout). */
export type SummarySort = 'page' | 'author' | 'date' | 'type';

export interface SummaryOptions {
  readonly layout: SummaryLayout;
  readonly sort: SummarySort;
  /** Body text size in points; headings are one point larger and bold. */
  readonly fontSize: number;
  /** 0-based source page indexes to include, in document order. */
  readonly pages: ReadonlyArray<number>;
  /** Keep a source page that has no comments on it. Never applies to `comments-only`. */
  readonly includeEmptyPages: boolean;
  /** Number every comment and show the number on the page as well as in the block. */
  readonly sequenceNumbers: boolean;
  /** Title drawn at the head of the summary and written into the file's metadata. */
  readonly title: string;
}

export const DEFAULT_SUMMARY_OPTIONS: Omit<SummaryOptions, 'pages'> = {
  layout: 'separate-connectors',
  sort: 'page',
  fontSize: 9,
  includeEmptyPages: false,
  sequenceNumbers: true,
  title: 'Comment summary',
};

export const MIN_SUMMARY_FONT_SIZE = 6;
export const MAX_SUMMARY_FONT_SIZE = 18;

/** One reply under a comment. */
export interface SummaryReply {
  readonly author: string;
  /** ISO 8601, or null. */
  readonly date: string | null;
  readonly text: string;
  /** The review state this reply set, when it set one. */
  readonly status: string | null;
}

/** One comment, as the summary needs it. Nothing here is a model type. */
export interface SummaryComment {
  readonly id: string;
  /** 0-based source page. */
  readonly page: number;
  /** Words, e.g. "Highlight", "Sticky note". */
  readonly type: string;
  readonly author: string;
  /** ISO 8601, or null. */
  readonly date: string | null;
  /** The current review state in words ("Accepted"), or null for none. */
  readonly status: string | null;
  readonly text: string;
  /** Where on the source page the comment sits, page space, for the connector line. */
  readonly anchor: PdfPoint;
  readonly replies: ReadonlyArray<SummaryReply>;
}

/** The size of one source page, as the layout needs it. */
export interface SummaryPageSize {
  readonly width: number;
  readonly height: number;
}

/** One line of text inside a block. */
export interface SummaryTextLine {
  readonly text: string;
  readonly bold: boolean;
  readonly size: number;
  /** Points from the block's left edge — replies are indented. */
  readonly indent: number;
}

/** One comment's block on a summary page. Coordinates are PDF user space of the output page. */
export interface SummaryBlock {
  readonly commentId: string;
  readonly sequence: number;
  readonly x: number;
  /** Bottom edge. */
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly lines: ReadonlyArray<SummaryTextLine>;
  /** Where a connector line touches this block, output-page space. */
  readonly connector: PdfPoint;
}

/** A connector line from a comment's place on the page to its block. */
export interface SummaryConnector {
  readonly from: PdfPoint;
  readonly to: PdfPoint;
  readonly sequence: number;
}

/** A page of the summary. */
export interface SummaryPagePlan {
  readonly width: number;
  readonly height: number;
  /**
   * The source page drawn on this page, and where. `null` means the page carries only comments —
   * which is every page of a `comments-only` summary and the facing pages of a separate one.
   */
  readonly document: {
    readonly sourcePage: number;
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  } | null;
  readonly blocks: ReadonlyArray<SummaryBlock>;
  readonly connectors: ReadonlyArray<SummaryConnector>;
  /** Numbers drawn on the source page itself, beside each comment. */
  readonly markers: ReadonlyArray<{ readonly at: PdfPoint; readonly sequence: number }>;
  /** Running head, e.g. "Page 3 — 4 comments". */
  readonly heading: string | null;
}

export interface SummaryPlan {
  readonly pages: ReadonlyArray<SummaryPagePlan>;
  /** Every comment that made it into the summary, in the order it was numbered. */
  readonly ordered: ReadonlyArray<SummaryComment>;
  /** Comments that were left out because their page was not in the range. */
  readonly skipped: number;
}

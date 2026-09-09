/**
 * M32: the comment summary. The layout is pure arithmetic, so page counts, ordering and the words
 * on the page are all checked without rendering anything; the build is then run once per layout
 * over a stub renderer and the produced PDF is read back for its page count and its text.
 */

import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import {
  buildSummary,
  clampFontSize,
  compareComments,
  DEFAULT_SUMMARY_OPTIONS,
  formatSummaryDate,
  layoutSummary,
  type SummaryComment,
  type SummaryLayout,
  type SummaryOptions,
  type SummaryPageSize,
} from '../../../src/engine/summary/index';

const A4: SummaryPageSize = { width: 595.28, height: 841.89 };
const SIZES = [A4, A4, A4];

function comment(over: Partial<SummaryComment> & { id: string }): SummaryComment {
  return {
    page: 0,
    type: 'Highlight',
    author: 'A. Reviewer',
    date: '2026-09-01T10:15:00Z',
    status: null,
    text: 'Some words about this part of the page.',
    anchor: { x: 100, y: 700 },
    replies: [],
    ...over,
  };
}

function options(over: Partial<SummaryOptions> = {}): SummaryOptions {
  return { ...DEFAULT_SUMMARY_OPTIONS, pages: [0, 1, 2], ...over };
}

describe('compareComments', () => {
  const a = comment({
    id: 'a',
    page: 1,
    author: 'Zoe',
    date: '2026-01-01T00:00:00Z',
    type: 'Note',
  });
  const b = comment({
    id: 'b',
    page: 0,
    author: 'Adam',
    date: '2026-06-01T00:00:00Z',
    type: 'Ink',
  });

  it('orders by page, then down the page', () => {
    expect([a, b].sort(compareComments('page')).map((c) => c.id)).toEqual(['b', 'a']);
    const high = comment({ id: 'high', anchor: { x: 0, y: 700 } });
    const low = comment({ id: 'low', anchor: { x: 0, y: 100 } });
    expect([low, high].sort(compareComments('page')).map((c) => c.id)).toEqual(['high', 'low']);
  });

  it('orders by author, date and type when asked', () => {
    expect([a, b].sort(compareComments('author')).map((c) => c.id)).toEqual(['b', 'a']);
    expect([b, a].sort(compareComments('date')).map((c) => c.id)).toEqual(['a', 'b']);
    expect([a, b].sort(compareComments('type')).map((c) => c.id)).toEqual(['b', 'a']);
  });
});

describe('layoutSummary', () => {
  const three = [
    comment({ id: 'c1', page: 0 }),
    comment({ id: 'c2', page: 1 }),
    comment({ id: 'c3', page: 1 }),
  ];

  it('numbers comments in the order they will be read', () => {
    const plan = layoutSummary(three, SIZES, options());
    expect(plan.ordered.map((c) => c.id)).toEqual(['c1', 'c2', 'c3']);
    const sequences = plan.pages.flatMap((p) => p.blocks.map((b) => b.sequence));
    expect(sequences).toEqual([1, 2, 3]);
  });

  it('separate layouts give a page of document and a page of comments per source page', () => {
    const plan = layoutSummary(three, SIZES, options({ layout: 'separate-connectors' }));
    // Page 2 has no comments and is left out by default.
    expect(plan.pages).toHaveLength(4);
    expect(plan.pages.map((p) => p.document !== null)).toEqual([true, false, true, false]);
    expect(plan.pages[0]?.width).toBe(A4.width);
  });

  it('keeps an empty page when it is asked to', () => {
    const plan = layoutSummary(three, SIZES, options({ includeEmptyPages: true }));
    expect(plan.pages).toHaveLength(6);
    expect(plan.pages[5]?.heading).toContain('no comments');
  });

  it('the single-page layout puts the document and its comments side by side', () => {
    const plan = layoutSummary(three, SIZES, options({ layout: 'single-connectors' }));
    expect(plan.pages).toHaveLength(2);
    const first = plan.pages[0];
    expect(first?.width).toBeGreaterThan(A4.width);
    expect(first?.document).not.toBeNull();
    expect(first?.blocks).toHaveLength(1);
    expect(first?.connectors).toHaveLength(1);
    // The line starts where the comment is on the drawn page and ends at its block.
    expect(first?.connectors[0]?.from.x).toBeCloseTo(36 + 100, 5);
    expect(first?.connectors[0]?.to.x).toBe(first?.blocks[0]?.x);
  });

  it('comments-only has no document pages at all', () => {
    const plan = layoutSummary(three, SIZES, options({ layout: 'comments-only' }));
    expect(plan.pages.every((p) => p.document === null)).toBe(true);
    expect(plan.pages).toHaveLength(1);
    expect(plan.pages[0]?.blocks).toHaveLength(3);
    expect(plan.pages[0]?.heading).toBe('Comment summary — 3 comments');
  });

  it('the sequence layout numbers the page and draws no lines', () => {
    const plan = layoutSummary(three, SIZES, options({ layout: 'separate-sequence' }));
    expect(plan.pages.flatMap((p) => p.connectors)).toHaveLength(0);
    expect(plan.pages[0]?.markers.map((m) => m.sequence)).toEqual([1]);
  });

  it('drops the markers when sequence numbers are off', () => {
    const plan = layoutSummary(three, SIZES, options({ sequenceNumbers: false }));
    expect(plan.pages.flatMap((p) => p.markers)).toHaveLength(0);
    expect(plan.pages[1]?.blocks[0]?.lines[0]?.text.startsWith('1.')).toBe(false);
  });

  it('honours a page range and counts what it left out', () => {
    const plan = layoutSummary(three, SIZES, options({ pages: [1] }));
    expect(plan.ordered.map((c) => c.id)).toEqual(['c2', 'c3']);
    expect(plan.skipped).toBe(1);
  });

  it('spills a long list onto a second comments page', () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      comment({
        id: `m${String(i)}`,
        page: 0,
        text: 'A comment with enough words in it to take a couple of lines when it is wrapped.',
      }),
    );
    const plan = layoutSummary(many, SIZES, options({ pages: [0] }));
    const commentPages = plan.pages.filter((p) => p.document === null);
    expect(commentPages.length).toBeGreaterThan(1);
    expect(commentPages[1]?.heading).toContain('continued');
    // Every comment is on exactly one page and none is lost to the spill.
    const ids = plan.pages.flatMap((p) => p.blocks.map((b) => b.commentId));
    expect(new Set(ids).size).toBe(40);
  });

  it('writes a comment’s replies and status into its block', () => {
    const plan = layoutSummary(
      [
        comment({
          id: 'r1',
          status: 'Accepted',
          replies: [
            { author: 'B. Author', date: '2026-09-02T09:00:00Z', text: 'Will do.', status: null },
          ],
        }),
      ],
      SIZES,
      options({ pages: [0] }),
    );
    const text = plan.pages
      .flatMap((p) => p.blocks.flatMap((b) => b.lines.map((l) => l.text)))
      .join(' ');
    expect(text).toContain('Status: Accepted');
    expect(text).toContain('Reply — B. Author');
    expect(text).toContain('Will do.');
  });

  it('keeps every block inside its page', () => {
    const plan = layoutSummary(three, SIZES, options());
    for (const page of plan.pages) {
      for (const block of page.blocks) {
        expect(block.y).toBeGreaterThanOrEqual(0);
        expect(block.y + block.height).toBeLessThanOrEqual(page.height);
        expect(block.x + block.width).toBeLessThanOrEqual(page.width + 0.001);
      }
    }
  });
});

describe('clampFontSize and formatSummaryDate', () => {
  it('holds the font size to a readable range', () => {
    expect(clampFontSize(2)).toBe(6);
    expect(clampFontSize(40)).toBe(18);
    expect(clampFontSize(Number.NaN)).toBe(9);
    expect(clampFontSize(11.4)).toBe(11);
  });

  it('formats a date in en-GB and says nothing about one it cannot read', () => {
    expect(formatSummaryDate('2026-09-01T10:15:00Z')).toContain('2026');
    expect(formatSummaryDate('not a date')).toBe('');
    expect(formatSummaryDate(null)).toBe('');
  });
});

describe('buildSummary', () => {
  // A 1×1 PNG, so the build embeds a real image without a renderer being involved.
  const PNG = Uint8Array.from(
    atob(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    ),
    (c) => c.charCodeAt(0),
  );
  const render = async (): Promise<{ png: Uint8Array; width: number; height: number }> =>
    Promise.resolve({ png: PNG, width: A4.width, height: A4.height });

  const comments = [
    comment({ id: 'b1', page: 0, text: 'The first comment in the summary.' }),
    comment({ id: 'b2', page: 1, type: 'Sticky note', text: 'The second comment.' }),
  ];

  const layouts: SummaryLayout[] = [
    'separate-connectors',
    'single-connectors',
    'comments-only',
    'separate-sequence',
  ];

  for (const layout of layouts) {
    it(`builds a readable PDF for the ${layout} layout`, async () => {
      const opts = options({ layout, pages: [0, 1] });
      const plan = layoutSummary(comments, SIZES, opts);
      const built = await buildSummary({
        plan,
        options: opts,
        render,
        sourceTitle: 'report.pdf',
      });
      expect(built.pageCount).toBe(plan.pages.length);
      expect(built.unrendered).toHaveLength(0);
      const reopened = await PDFDocument.load(built.bytes);
      expect(reopened.getPageCount()).toBe(plan.pages.length);
      expect(reopened.getTitle()).toContain('report.pdf');
      const size = reopened.getPage(0).getSize();
      expect(size.width).toBeCloseTo(plan.pages[0]?.width ?? 0, 2);
    });
  }

  it('says which pages it could not draw rather than failing', async () => {
    const opts = options({ layout: 'separate-connectors', pages: [0, 1] });
    const plan = layoutSummary(comments, SIZES, opts);
    const built = await buildSummary({
      plan,
      options: opts,
      render: (page) =>
        Promise.resolve(page === 1 ? null : { png: PNG, width: A4.width, height: A4.height }),
      sourceTitle: 'report.pdf',
    });
    expect(built.unrendered).toEqual([1]);
    expect(built.pageCount).toBe(plan.pages.length);
  });

  it('produces a one-page document that says so when there is nothing to summarise', async () => {
    const opts = options({ pages: [] });
    const built = await buildSummary({
      plan: layoutSummary([], SIZES, opts),
      options: opts,
      render,
      sourceTitle: 'report.pdf',
    });
    expect(built.pageCount).toBe(1);
  });

  it('reports progress and can be cancelled', async () => {
    const opts = options({ layout: 'comments-only', pages: [0, 1] });
    const plan = layoutSummary(comments, SIZES, opts);
    const seen: number[] = [];
    await buildSummary({
      plan,
      options: opts,
      render,
      sourceTitle: 'report.pdf',
      onProgress: (f) => seen.push(f),
    });
    expect(seen[seen.length - 1]).toBe(1);

    const controller = new AbortController();
    controller.abort();
    await expect(
      buildSummary({ plan, options: opts, render, sourceTitle: 'x', signal: controller.signal }),
    ).rejects.toThrow();
  });
});

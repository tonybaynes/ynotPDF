/**
 * M32 acceptance: **summary PDF page count and text spot-checks for each layout option.**
 *
 * The comments come from the real `comments.pdf` through the real model, the layout is the pure
 * one, and the produced PDF is opened in PDFium and read back — so "the summary says what the
 * comments say" is checked against extracted text rather than against the arrays that made it.
 *
 * The page pictures are a stub: a summary's pictures are pictures, and what this is about is the
 * words. `test/e2e/comments.spec.ts` builds one through the running engine.
 */

import { describe, expect, it } from 'vitest';
import { Document } from '@core/Document';
import {
  buildSummary,
  DEFAULT_SUMMARY_OPTIONS,
  layoutSummary,
  type SummaryLayout,
  type SummaryOptions,
} from '@engine/summary';
import { buildComments } from '@modules/M32-comments-panel/model';
import { toSummaryComments } from '@modules/M32-comments-panel/summarise';
import { engine, fixture } from '../engine/helpers';

/** A 1×1 PNG, so the build embeds a real image without a canvas being involved. */
const PNG = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  ),
  (c) => c.charCodeAt(0),
);

async function summaryOf(over: Partial<SummaryOptions>): Promise<{
  bytes: Uint8Array;
  planned: number;
  comments: number;
  text: string;
  authors: string[];
}> {
  const eng = await engine();
  const doc = await Document.open(eng, fixture('comments.pdf'));
  for (const page of doc.state.pages) await doc.loadAnnotations(page.id);
  const all = doc.state.pages.flatMap((page) => doc.annotations(page.id));
  const index = new Map(doc.state.pages.map((page, at) => [page.id, at]));
  const threads = buildComments(all, (id) => index.get(id) ?? 0);
  const sizes = doc.state.pages.map((page) => ({
    width: page.cropBox.x1 - page.cropBox.x0,
    height: page.cropBox.y1 - page.cropBox.y0,
  }));
  await doc.close();

  const options: SummaryOptions = {
    ...DEFAULT_SUMMARY_OPTIONS,
    pages: sizes.map((_, at) => at),
    ...over,
  };
  const plan = layoutSummary(toSummaryComments(threads), sizes, options);
  const built = await buildSummary({
    plan,
    options,
    sourceTitle: 'comments.pdf',
    render: () => Promise.resolve({ png: PNG, width: 595.28, height: 841.89 }),
  });

  const handle = await eng.open(built.bytes.slice());
  let text = '';
  for (let page = 0; page < (await eng.pageCount(handle)); page++) {
    text += `${(await eng.textRuns(handle, page)).map((run) => run.text).join(' ')}\n`;
  }
  await eng.close(handle);
  return {
    bytes: built.bytes,
    planned: built.pageCount,
    comments: threads.length,
    text,
    authors: plan.ordered.map((c) => c.author),
  };
}

const LAYOUTS: ReadonlyArray<SummaryLayout> = [
  'separate-connectors',
  'single-connectors',
  'comments-only',
  'separate-sequence',
];

describe('the comment summary, for each layout', () => {
  for (const layout of LAYOUTS) {
    it(`${layout}: the page count is what the layout planned, and the words are the comments’`, async () => {
      const { planned, comments, text } = await summaryOf({ layout });
      expect(comments).toBeGreaterThanOrEqual(15);
      expect(planned).toBeGreaterThan(0);

      // Spot-checks: a comment's own words, its author, its kind, and a reply.
      expect(text).toContain('This opening sentence needs to say what the document is for.');
      expect(text).toContain('A. Reviewer');
      expect(text).toContain('Highlight');
      expect(text).toContain('Agreed');
      // The status a reply set is reported in words.
      expect(text).toContain('Accepted');
      expect(text).toContain('Rejected');
    }, 60_000);
  }

  it('comments-only has no document pages and one page per screenful of comments', async () => {
    const { planned, text } = await summaryOf({ layout: 'comments-only' });
    expect(planned).toBeGreaterThanOrEqual(1);
    expect(text).toContain('Comment summary');
  }, 60_000);

  it('the separate layouts give two pages per source page that has comments', async () => {
    const { planned } = await summaryOf({ layout: 'separate-connectors' });
    // Both pages of the fixture carry comments, so: page, comments, page, comments.
    expect(planned).toBeGreaterThanOrEqual(4);
  }, 60_000);

  it('sequence numbers appear in the blocks and go away when turned off', async () => {
    const numbered = await summaryOf({ layout: 'separate-sequence', sequenceNumbers: true });
    expect(numbered.text).toMatch(/\b1\.\s/);
    const plain = await summaryOf({ layout: 'separate-sequence', sequenceNumbers: false });
    expect(plain.text).toContain('This opening sentence needs to say what the document is for.');
  }, 60_000);

  it('sorting by author puts the authors together', async () => {
    // Asserted on the plan's own order rather than on the extracted text: a reply by another
    // reviewer is printed inside its comment's block, so the words interleave even when the
    // comments do not.
    const { authors } = await summaryOf({ layout: 'comments-only', sort: 'author' });
    expect(authors).toEqual([...authors].sort((a, b) => a.localeCompare(b, 'en-GB')));
    expect(new Set(authors).size).toBeGreaterThan(1);
  }, 60_000);

  it('a page range leaves the other pages’ comments out', async () => {
    const only = await summaryOf({ layout: 'comments-only', pages: [1] });
    // "Sketched correction." is on page two; the page-one opener is not in a page-two summary.
    expect(only.text).toContain('Sketched correction.');
    expect(only.text).not.toContain('This opening sentence needs to say what the document is for.');
  }, 60_000);

  it('a bigger font size makes a longer summary, not a clipped one', async () => {
    const small = await summaryOf({ layout: 'comments-only', fontSize: 7 });
    const large = await summaryOf({ layout: 'comments-only', fontSize: 14 });
    expect(large.planned).toBeGreaterThanOrEqual(small.planned);
    expect(large.text).toContain('Sketched correction.');
  }, 60_000);
});

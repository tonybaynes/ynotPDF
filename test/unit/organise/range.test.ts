/**
 * The page-range dialect (M40).
 *
 * The syntax is the only thing standing between "the reader typed something" and "pages were
 * deleted", so the awkward cases are what is tested: reversed pairs, en dashes pasted out of a
 * document, numbers past the end, duplicates, words on their own, words combined with numbers,
 * and the empty field.
 */

import { describe, expect, it } from 'vitest';
import {
  allPages,
  countPages,
  formatRange,
  parseRange,
  RANGE_WORDS,
  type RangeContext,
} from '@modules/M40-organise-pages/range';

/** Ten pages; pages 3 and 7 (1-based) are landscape; page 5 is current; 2 and 3 are selected. */
const CONTEXT: RangeContext = {
  pageCount: 10,
  currentPage: 4,
  selectedPages: [1, 2],
  pageSizes: Array.from({ length: 10 }, (_, i) =>
    i === 2 || i === 6 ? { width: 842, height: 595 } : { width: 595, height: 842 },
  ),
};

const parse = (text: string, context: RangeContext = CONTEXT): ReadonlyArray<number> => {
  const result = parseRange(text, context);
  expect(result.error).toBeNull();
  return result.pages;
};

describe('parseRange — numbers and ranges', () => {
  it('an empty field means every page, because an empty field must not mean none', () => {
    expect(parse('')).toEqual(allPages(10));
    expect(parse('   ')).toEqual(allPages(10));
  });

  it('reads single pages, ranges and open-ended ranges, one-based in and zero-based out', () => {
    expect(parse('1')).toEqual([0]);
    expect(parse('2-4')).toEqual([1, 2, 3]);
    expect(parse('8-')).toEqual([7, 8, 9]);
    expect(parse('-3')).toEqual([0, 1, 2]);
    expect(parse('1-3,5,8-')).toEqual([0, 1, 2, 4, 7, 8, 9]);
  });

  it('sorts and de-duplicates, so "5,2,2-3" is the same set however it was typed', () => {
    expect(parse('5,2,2-3')).toEqual([1, 2, 4]);
  });

  it('accepts a reversed pair — "4-2" is the range the reader meant', () => {
    expect(parse('4-2')).toEqual([1, 2, 3]);
  });

  it('accepts the en and em dashes a document paste brings with it', () => {
    expect(parse('2–4')).toEqual([1, 2, 3]);
    expect(parse('2—4')).toEqual([1, 2, 3]);
  });

  it('tolerates whitespace and semicolons', () => {
    expect(parse(' 1 - 2 ; 5 ')).toEqual([0, 1, 4]);
  });
});

describe('parseRange — refusing what it cannot honour', () => {
  it('says so when a page is past the end, rather than quietly taking what exists', () => {
    const result = parseRange('3-99', CONTEXT);
    expect(result.pages).toEqual([]);
    expect(result.error).toContain('10 pages');
  });

  it('rejects a page number that is not a number', () => {
    expect(parseRange('two', CONTEXT).error).toContain('not a page number');
  });

  it('rejects a bare dash and a three-part range', () => {
    expect(parseRange('-', CONTEXT).error).toContain('not a page range');
    expect(parseRange('1-2-3', CONTEXT).error).toContain('not a page range');
  });

  it('rejects page 0, which is not a page anyone can name', () => {
    expect(parseRange('0', CONTEXT).error).not.toBeNull();
  });

  it('answers an empty document with no pages and no complaint', () => {
    const empty = parseRange('1-3', { pageCount: 0, currentPage: 0, selectedPages: [] });
    expect(empty.pages).toEqual([]);
    expect(empty.error).toBeNull();
  });
});

describe('parseRange — the words', () => {
  it('offers exactly the words it understands', () => {
    expect([...RANGE_WORDS].sort()).toEqual([
      'all',
      'current',
      'even',
      'landscape',
      'last',
      'odd',
      'portrait',
      'selected',
    ]);
  });

  it('selects by word', () => {
    expect(parse('all')).toEqual(allPages(10));
    expect(parse('current')).toEqual([4]);
    expect(parse('last')).toEqual([9]);
    expect(parse('selected')).toEqual([1, 2]);
  });

  it('odd and even go by the printed number, so odd is pages 1, 3, 5', () => {
    expect(parse('odd')).toEqual([0, 2, 4, 6, 8]);
    expect(parse('even')).toEqual([1, 3, 5, 7, 9]);
  });

  it('landscape and portrait go by the displayed size', () => {
    expect(parse('landscape')).toEqual([2, 6]);
    expect(parse('portrait')).toEqual([0, 1, 3, 4, 5, 7, 8, 9]);
  });

  it('a filter word narrows the pages a selector chose, not the whole document', () => {
    expect(parse('1-6, even')).toEqual([1, 3, 5]);
    expect(parse('1-6, landscape')).toEqual([2]);
  });

  it('two filter words both apply', () => {
    // The landscape pages are printed 3 and 7, and both of those are odd.
    expect(parse('landscape, odd')).toEqual([2, 6]);
    // Narrowing the same two by the other parity leaves nothing.
    expect(parseRange('landscape, even', CONTEXT).pages).toEqual([]);
  });

  it('is case-insensitive about its words', () => {
    expect(parse('ODD')).toEqual(parse('odd'));
  });

  it('says so when the words cannot both be true of anything', () => {
    // Printed page 3 is odd, so asking for it and "even" together names nothing — and the field
    // has to say so rather than silently acting on every page or on none.
    const result = parseRange('3, even', CONTEXT);
    expect(result.pages).toEqual([]);
    expect(result.error).toBe('No pages match that');
  });

  it('selects nothing for an orientation when no sizes were supplied, rather than guessing', () => {
    const blind: RangeContext = { pageCount: 4, currentPage: 0, selectedPages: [] };
    expect(parseRange('landscape', blind).pages).toEqual([]);
  });

  it('clamps a current page that is past the end', () => {
    expect(parse('current', { ...CONTEXT, currentPage: 99 })).toEqual([9]);
  });

  it('ignores a selection that names pages the document does not have', () => {
    expect(parse('selected', { ...CONTEXT, selectedPages: [1, 99, -3] })).toEqual([1]);
  });
});

describe('formatRange and countPages', () => {
  it('collapses runs and keeps singletons', () => {
    expect(formatRange([0, 1, 2, 5])).toBe('1-3, 6');
    expect(formatRange([3])).toBe('4');
    expect(formatRange([])).toBe('');
  });

  it('sorts and de-duplicates before formatting', () => {
    expect(formatRange([5, 0, 1, 1, 2])).toBe('1-3, 6');
  });

  it('round-trips through the parser', () => {
    const pages = [0, 1, 2, 4, 7, 8, 9];
    expect(parse(formatRange(pages))).toEqual(pages);
  });

  it('counts in words, with the singular right', () => {
    expect(countPages(1)).toBe('1 page');
    expect(countPages(3)).toBe('3 pages');
    expect(countPages(0)).toBe('0 pages');
  });
});

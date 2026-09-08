/**
 * The matcher (M13): normalisation and the offset map it hands back, the four query modes, whole
 * words, proximity and the context snippet.
 */

import { describe, expect, it } from 'vitest';
import {
  BadPatternError,
  compileQuery,
  contextSnippet,
  DEFAULT_FIND_OPTIONS,
  escapeRegExp,
  findMatches,
  normalise,
  sortHits,
  type FindOptions,
  type SearchHit,
} from '@modules/M13-select-find-print/find/search';
import { must } from './helpers';

const options = (patch: Partial<FindOptions> = {}): FindOptions => ({
  ...DEFAULT_FIND_OPTIONS,
  ...patch,
});

const found = (text: string, query: string, patch: Partial<FindOptions> = {}): string[] =>
  findMatches(text, query, options(patch)).map((m) => text.slice(m.start, m.end));

describe('normalise', () => {
  it('is the identity when nothing is folded', () => {
    const n = normalise('Café', options({ matchCase: true }));
    expect(n.text).toBe('Café');
    expect(n.map[4]).toBe(4);
  });

  it('leaves case alone — the regular expression’s `i` flag does that', () => {
    const n = normalise('ABC', options());
    expect(n.text).toBe('ABC');
    expect(n.map.slice(0, 4)).toEqual([0, 1, 2, 3]);
  });

  it('strips diacritics and still maps back, even when the length changes', () => {
    const n = normalise('éa', options({ ignoreDiacritics: true, matchCase: true }));
    expect(n.text).toBe('ea');
    expect(n.map[0]).toBe(0);
    expect(n.map[1]).toBe(1);
  });

  it('survives a character whose lower case is longer than itself', () => {
    const n = normalise('İ', options());
    expect(n.text.length).toBeGreaterThanOrEqual(1);
    expect(n.map.every((offset) => offset >= 0 && offset <= 1)).toBe(true);
  });
});

describe('findMatches', () => {
  it('finds nothing for an empty query', () => {
    expect(findMatches('anything', '')).toEqual([]);
  });

  it('is case-insensitive by default and reports original offsets', () => {
    const text = 'The theme of the thesis';
    const matches = findMatches(text, 'the', options());
    // Four: "The", the start of "theme", "the", and the start of "thesis".
    expect(matches).toHaveLength(4);
    const at = (i: number): string => {
      const m = must(matches[i], 'match');
      return text.slice(m.start, m.end);
    };
    expect(at(0)).toBe('The');
    expect(at(2)).toBe('the');
  });

  it('respects match case', () => {
    expect(found('The the', 'the', { matchCase: true })).toEqual(['the']);
  });

  it('respects whole words', () => {
    expect(found('the theme of the', 'the', { wholeWord: true })).toEqual(['the', 'the']);
  });

  it('matches accented text when accents are ignored', () => {
    expect(found('résumé', 'resume', { ignoreDiacritics: true })).toEqual(['résumé']);
    expect(found('résumé', 'resume')).toEqual([]);
  });

  it('takes a regular expression when asked', () => {
    expect(found('a1 b22 c333', String.raw`\d{2,}`, { regex: true })).toEqual(['22', '333']);
  });

  it('treats a literal query literally', () => {
    expect(found('cost is $5.00 (net)', '$5.00 (net)')).toEqual(['$5.00 (net)']);
  });

  it('never loops on a pattern that can match nothing', () => {
    expect(found('abc', 'x*', { regex: true })).toEqual([]);
  });

  it('reports a broken pattern rather than finding nothing quietly', () => {
    expect(() => compileQuery('(unclosed', options({ regex: true }))).toThrow(BadPatternError);
  });

  it('escapes a literal for a regular expression', () => {
    expect(new RegExp(escapeRegExp('a.b')).test('a.b')).toBe(true);
    expect(new RegExp(escapeRegExp('a.b')).test('axb')).toBe(false);
  });
});

describe('proximity', () => {
  const text = 'alpha one beta gamma delta epsilon zeta alpha far away from beta';

  it('matches two words that are close together', () => {
    const matches = findMatches(text, 'alpha beta', options({ proximity: 3 }));
    expect(matches.length).toBeGreaterThan(0);
    const first = must(matches[0], 'match');
    expect(text.slice(first.start, first.end)).toBe('alpha one beta');
  });

  it('does not match words that are too far apart', () => {
    const far = 'alpha one two three four five six seven beta';
    expect(findMatches(far, 'alpha beta', options({ proximity: 2 }))).toEqual([]);
  });

  it('is off when proximity is zero — the query is then the literal phrase', () => {
    expect(findMatches(text, 'alpha beta', options({ proximity: 0 }))).toEqual([]);
    expect(found('alpha beta', 'alpha beta')).toEqual(['alpha beta']);
  });
});

describe('contextSnippet', () => {
  it('shows the hit with what is around it, and marks a trimmed edge', () => {
    const text = `${'x'.repeat(100)}needle${'y'.repeat(100)}`;
    const snippet = contextSnippet(text, { start: 100, end: 106 }, 10);
    expect(snippet).toContain('needle');
    expect(snippet.startsWith('…')).toBe(true);
    expect(snippet.endsWith('…')).toBe(true);
  });

  it('flattens line breaks so a row stays one line', () => {
    expect(contextSnippet('one\ntwo\nthree', { start: 4, end: 7 })).toBe('one two three');
  });
});

describe('sortHits', () => {
  it('orders by document, then page, then position', () => {
    const hit = (patch: Partial<SearchHit>): SearchHit => ({
      documentId: 'b.pdf',
      documentName: 'b.pdf',
      page: 1,
      source: 'page',
      start: 0,
      end: 1,
      snippet: '',
      ...patch,
    });
    const sorted = sortHits([
      hit({ page: 2 }),
      hit({ documentId: 'a.pdf', documentName: 'a.pdf' }),
      hit({ page: 1, start: 5 }),
    ]);
    expect(sorted.map((h) => [h.documentName, h.page, h.start])).toEqual([
      ['a.pdf', 1, 0],
      ['b.pdf', 1, 5],
      ['b.pdf', 2, 0],
    ]);
  });
});

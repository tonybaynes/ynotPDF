import { describe, expect, it } from 'vitest';
import { fuzzyMatch, fuzzyToken, rank } from '@app/fuzzy';

describe('fuzzy matching', () => {
  it('matches subsequences and reports positions', () => {
    const m = fuzzyToken('opn', 'Open…');
    expect(m).not.toBeNull();
    expect(m?.positions).toEqual([0, 1, 3]);
    expect(fuzzyToken('xyz', 'Open')).toBeNull();
  });

  it('prefers word starts and exact prefixes', () => {
    const items = ['Toggle Developer Tools', 'Theme: Daylight', 'Delete pages', 'Set Theme…'];
    const ranked = rank('th', items, (s) => s);
    expect(ranked[0]?.item).toBe('Theme: Daylight');
    const ranked2 = rank('dt', items, (s) => s);
    expect(ranked2[0]?.item).toBe('Toggle Developer Tools');
  });

  it('requires every token of a multi-word query', () => {
    expect(fuzzyMatch('open recent', 'File: Open Recent… file.openRecent')).not.toBeNull();
    expect(fuzzyMatch('open zzz', 'File: Open Recent…')).toBeNull();
    expect(fuzzyMatch('   ', 'anything')?.score).toBe(0);
  });

  it('keeps input order for ties and drops non-matches', () => {
    const ranked = rank('a', ['a1', 'a2', 'b'], (s) => s);
    expect(ranked.map((r) => r.item)).toEqual(['a1', 'a2']);
  });
});

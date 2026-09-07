/**
 * Fuzzy matching for the command palette (M02). Subsequence match with a score that prefers
 * word starts, consecutive runs and earlier matches; a query of several words must match each
 * word somewhere. Pure and unit-tested.
 */

export interface FuzzyMatch {
  readonly score: number;
  /** Indexes of matched characters in the haystack (for highlighting). */
  readonly positions: ReadonlyArray<number>;
}

function isWordStart(text: string, i: number): boolean {
  if (i === 0) return true;
  const prev = text[i - 1] ?? '';
  const cur = text[i] ?? '';
  if (/[\s\-_./:]/.test(prev)) return true;
  // camelCase boundary
  return prev === prev.toLowerCase() && cur === cur.toUpperCase() && /[a-z]/i.test(cur);
}

/** Matches one query token as a subsequence of `text`. `null` when it does not match. */
export function fuzzyToken(query: string, text: string): FuzzyMatch | null {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (!q) return { score: 0, positions: [] };
  const positions: number[] = [];
  let score = 0;
  let ti = 0;
  let lastMatch = -2;
  for (const ch of q) {
    // Prefer a word-start occurrence when one exists ahead; else the next occurrence.
    let found = -1;
    for (let k = ti; k < t.length; k++) {
      if (t[k] !== ch) continue;
      if (found < 0) found = k;
      if (isWordStart(text, k)) {
        found = k;
        break;
      }
      // Keep the first plain hit unless a word start follows within a few chars.
      if (k - found > 3) break;
    }
    if (found < 0) return null;
    positions.push(found);
    if (isWordStart(text, found)) score += 8;
    if (found === lastMatch + 1) score += 5;
    score -= Math.min(found - ti, 10) * 0.25;
    lastMatch = found;
    ti = found + 1;
  }
  // Shorter haystacks with the same matches rank higher; exact prefix ranks highest.
  score -= text.length * 0.02;
  if (t.startsWith(q)) score += 10;
  return { score, positions };
}

/** Matches every whitespace-separated token; scores add up. */
export function fuzzyMatch(query: string, text: string): FuzzyMatch | null {
  const tokens = query.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return { score: 0, positions: [] };
  let score = 0;
  const positions = new Set<number>();
  for (const token of tokens) {
    const m = fuzzyToken(token, text);
    if (!m) return null;
    score += m.score;
    for (const p of m.positions) positions.add(p);
  }
  return { score, positions: Array.from(positions).sort((a, b) => a - b) };
}

export interface Ranked<T> {
  readonly item: T;
  readonly score: number;
  readonly positions: ReadonlyArray<number>;
}

/**
 * Ranks `items` against `query` using `text(item)` as the haystack (typically
 * `"Category Label id"`). Non-matching items are dropped; ties keep input order.
 */
export function rank<T>(
  query: string,
  items: ReadonlyArray<T>,
  text: (item: T) => string,
): Ranked<T>[] {
  const out: (Ranked<T> & { readonly index: number })[] = [];
  items.forEach((item, index) => {
    const m = fuzzyMatch(query, text(item));
    if (m) out.push({ item, score: m.score, positions: m.positions, index });
  });
  return out.sort((a, b) => b.score - a.score || a.index - b.index);
}

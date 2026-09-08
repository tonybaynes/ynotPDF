/**
 * The matcher (M13). Pure: a string in, a list of spans out, with every Foxit find option
 * expressed as a property of the *normalisation* rather than as a special case in the search.
 *
 * Case folding and diacritic folding both change a string's length ("İ" lower-cases to two
 * units; "é" decomposes to two), so normalisation returns a map from each normalised unit back
 * to the offset it came from. Matches are always reported in **original** offsets, which is what
 * the text layer, the highlighter and the copy path all index by.
 */

/** Everything the find bar and the search panel can ask for. */
export interface FindOptions {
  readonly matchCase: boolean;
  readonly wholeWord: boolean;
  /** Treat the query as a JavaScript regular expression (`u` flag, always global). */
  readonly regex: boolean;
  /** "é" matches "e" — Foxit's "ignore accents". */
  readonly ignoreDiacritics: boolean;
  /** Search bookmark titles as well as the pages. */
  readonly includeBookmarks: boolean;
  /** Search annotation contents (notes, replies, free text). */
  readonly includeComments: boolean;
  /** Search form-field values. */
  readonly includeFormFields: boolean;
  /**
   * Proximity: when the query has two or more words, only report them when they occur within
   * this many words of one another. 0 turns it off (the default).
   */
  readonly proximity: number;
}

export const DEFAULT_FIND_OPTIONS: FindOptions = {
  matchCase: false,
  wholeWord: false,
  regex: false,
  ignoreDiacritics: false,
  includeBookmarks: false,
  includeComments: false,
  includeFormFields: false,
  proximity: 0,
};

/** A match, in offsets into the *original* text. */
export interface MatchSpan {
  readonly start: number;
  readonly end: number;
}

/** Normalised text plus the offset each unit came from. */
export interface Normalised {
  readonly text: string;
  /** `map[i]` is the original offset of normalised unit `i`; `map[text.length]` is the end. */
  readonly map: ReadonlyArray<number>;
}

const COMBINING = /\p{M}/u;

/** Options that change the *text*; case is left to the regular expression's `i` flag. */
export type FoldOptions = Pick<FindOptions, 'ignoreDiacritics'>;

/**
 * Folds one character. Returns the string it becomes — possibly empty (a combining mark that
 * `ignoreDiacritics` drops) and possibly longer than one unit.
 *
 * Case is deliberately *not* folded here. Lower-casing the haystack and not the query is an easy
 * bug to write, and lower-casing a regular expression's source would turn `\D` into `\d`; the
 * `i` flag does the job for both query kinds at once and cannot get out of step with itself.
 */
function fold(ch: string, options: FoldOptions): string {
  if (!options.ignoreDiacritics) return ch;
  let stripped = '';
  for (const c of ch.normalize('NFD')) if (!COMBINING.test(c)) stripped += c;
  return stripped;
}

/** Normalises `text` under `options`, keeping a map back to the original offsets. */
export function normalise(text: string, options: FoldOptions): Normalised {
  // The fast path matters: a folded copy of every page of a folder search is the hot loop.
  if (!options.ignoreDiacritics) {
    const map = new Array<number>(text.length + 1);
    for (let i = 0; i <= text.length; i++) map[i] = i;
    return { text, map };
  }
  let out = '';
  const map: number[] = [];
  for (let i = 0; i < text.length;) {
    const cp = String.fromCodePoint(text.codePointAt(i) ?? 0);
    const folded = fold(cp, options);
    for (const _unit of folded) map.push(i);
    out += folded;
    i += cp.length;
  }
  map.push(text.length);
  return { text: out, map };
}

const WORD_CHAR = /[\p{L}\p{N}_]/u;

function isWordBoundary(text: string, at: number, before: boolean): boolean {
  const inside = text[before ? at : at - 1] ?? '';
  const outside = text[before ? at - 1 : at] ?? '';
  if (!WORD_CHAR.test(inside)) return true;
  return outside === '' || !WORD_CHAR.test(outside);
}

/** Escapes a literal query for use inside a regular expression. */
export function escapeRegExp(query: string): string {
  return query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Thrown for a regular expression the user typed that will not compile. */
export class BadPatternError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BadPatternError';
  }
}

/**
 * Builds the regular expression a query means. Exported so the find bar can tell the user their
 * pattern is broken as they type rather than silently finding nothing.
 */
export function compileQuery(query: string, options: FindOptions): RegExp {
  // The query is folded the same way the text is, so "resume" matches "résumé" and a pattern
  // typed with an accent matches text whose accents have been folded away.
  const folded = normalise(query, options).text;
  const source = options.regex ? folded : escapeRegExp(folded);
  try {
    return new RegExp(source, options.matchCase ? 'gu' : 'giu');
  } catch (error) {
    throw new BadPatternError(error instanceof Error ? error.message : String(error));
  }
}

/**
 * Every match of `query` in `text`, in original offsets. An empty query finds nothing (rather
 * than everything), which is what an incremental find bar needs while it is still being typed.
 */
export function findMatches(
  text: string,
  query: string,
  options: FindOptions = DEFAULT_FIND_OPTIONS,
): MatchSpan[] {
  if (query.length === 0) return [];
  const words = splitWords(query);
  if (!options.regex && options.proximity > 0 && words.length > 1) {
    return proximityMatches(text, words, options);
  }
  const normalised = normalise(text, options);
  return matchesIn(normalised, compileQuery(query, options), options);
}

function matchesIn(normalised: Normalised, re: RegExp, options: FindOptions): MatchSpan[] {
  const out: MatchSpan[] = [];
  re.lastIndex = 0;
  let guard = 0;
  for (let m = re.exec(normalised.text); m !== null; m = re.exec(normalised.text)) {
    if (++guard > 1_000_000) break;
    const start = m.index;
    const end = start + m[0].length;
    if (end === start) {
      re.lastIndex = start + 1;
      continue;
    }
    if (
      !options.wholeWord ||
      (isWordBoundary(normalised.text, start, true) && isWordBoundary(normalised.text, end, false))
    ) {
      out.push({
        start: normalised.map[start] ?? start,
        end: normalised.map[end] ?? normalised.map.length - 1,
      });
    }
  }
  return out;
}

function splitWords(query: string): string[] {
  return query.split(/\s+/u).filter((w) => w.length > 0);
}

/**
 * Proximity search: each word is found on its own, then a run that contains every word within
 * `proximity` words of each other is reported as one match spanning them. This is Foxit's
 * "match all words within N words" in the advanced panel.
 */
function proximityMatches(text: string, words: string[], options: FindOptions): MatchSpan[] {
  const normalised = normalise(text, options);
  const tokens = tokenise(normalised.text);
  // Proximity compares words itself rather than through a regular expression, so case folding
  // has to happen here — this is the one place the `i` flag cannot do it.
  const cased = (s: string): string => (options.matchCase ? s : s.toLowerCase());
  const wanted = words.map((w) => cased(normalise(w, options).text));
  const hits: MatchSpan[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const window = tokens.slice(i, i + options.proximity + wanted.length);
    const found = new Map<string, number>();
    for (const [k, token] of window.entries()) {
      const word = cased(token.text);
      for (const w of wanted) {
        if (found.has(w)) continue;
        const matches = options.wholeWord ? word === w : word.includes(w);
        if (matches) found.set(w, k);
      }
    }
    if (found.size !== wanted.length) continue;
    const positions = [...found.values()].sort((a, b) => a - b);
    const first = window[positions[0] ?? 0];
    const last = window[positions[positions.length - 1] ?? 0];
    if (!first || !last) continue;
    hits.push({
      start: normalised.map[first.start] ?? first.start,
      end: normalised.map[last.end] ?? last.end,
    });
    i += positions[0] ?? 0;
  }
  return dedupe(hits);
}

interface Token {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

function tokenise(text: string): Token[] {
  const out: Token[] = [];
  const re = /[\p{L}\p{N}_]+/gu;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    out.push({ text: m[0], start: m.index, end: m.index + m[0].length });
  }
  return out;
}

function dedupe(spans: ReadonlyArray<MatchSpan>): MatchSpan[] {
  const seen = new Set<string>();
  const out: MatchSpan[] = [];
  for (const s of spans) {
    const key = `${s.start}:${s.end}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out.sort((a, b) => a.start - b.start || a.end - b.end);
}

/**
 * A snippet of context around a match, for the results tree. `radius` is characters either
 * side; line breaks become spaces so a row stays one line.
 */
export function contextSnippet(text: string, span: MatchSpan, radius = 40): string {
  const start = Math.max(0, span.start - radius);
  const end = Math.min(text.length, span.end + radius);
  const before = text.slice(start, span.start);
  const hit = text.slice(span.start, span.end);
  const after = text.slice(span.end, end);
  const flat = (s: string): string => s.replace(/\s+/gu, ' ');
  return `${start > 0 ? '…' : ''}${flat(before)}${flat(hit)}${flat(after)}${end < text.length ? '…' : ''}`.trim();
}

/** Where a hit was found. The results tree groups by document, then page, then this. */
export type HitSource = 'page' | 'bookmark' | 'comment' | 'field';

/** One hit anywhere in a document. */
export interface SearchHit {
  /** Absolute path, or the tab id for a document with no path yet. */
  readonly documentId: string;
  readonly documentName: string;
  /** 0-based; -1 for a document-level hit (a bookmark or a field with no page). */
  readonly page: number;
  readonly source: HitSource;
  readonly start: number;
  readonly end: number;
  readonly snippet: string;
  /** Bookmark title / field name / annotation author, when the hit is not page text. */
  readonly label?: string;
}

/** Exported for the CSV writer and the results tree: a stable sort. */
export function sortHits(hits: ReadonlyArray<SearchHit>): SearchHit[] {
  return [...hits].sort(
    (a, b) =>
      a.documentName.localeCompare(b.documentName) ||
      a.documentId.localeCompare(b.documentId) ||
      a.page - b.page ||
      a.start - b.start,
  );
}

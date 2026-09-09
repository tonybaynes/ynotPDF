/**
 * Page ranges, M40's dialect (pure).
 *
 * Every command in this module takes the same string, and so will M41's: `"1-3,5,8-"` with the
 * words Foxit's Organize dialogs also accept — `odd`, `even`, `landscape`, `portrait`,
 * `current`, `selected`, `all`, `last`. It reads as a filter chain rather than a grammar:
 *
 * 1. the comma-separated **selectors** choose a set of pages (numbers, ranges, words);
 * 2. `odd` / `even` and `landscape` / `portrait`, wherever they appear, **narrow** that set.
 *
 * So `"1-20, even, landscape"` means "the even, landscape pages among the first twenty", and
 * `"even"` on its own means "every even page", because with no numeric selector the set starts
 * as the whole document. That is the reading that makes both sentences mean what a person
 * expects, and it is what the tests pin down.
 *
 * Page numbers are 1-based in the text and 0-based everywhere in the result, as in M13's print
 * ranges. An empty string means every page — an empty field should not mean "nothing".
 */

/** What the parser needs to know about the document to answer. */
export interface RangeContext {
  readonly pageCount: number;
  /** 0-based current page, for the word `current`. */
  readonly currentPage: number;
  /** 0-based selected pages, for the word `selected`. */
  readonly selectedPages: ReadonlyArray<number>;
  /**
   * Displayed size of each page, in document order, for `landscape` / `portrait`. Rotation must
   * already be applied — a portrait page turned 90° is landscape to the reader, and that is what
   * the words mean here. Omit it and both words select nothing rather than guessing.
   */
  readonly pageSizes?: ReadonlyArray<{ readonly width: number; readonly height: number }>;
}

/** A parsed range. `pages` is 0-based, ascending and without duplicates. */
export interface ParsedRange {
  readonly pages: ReadonlyArray<number>;
  /** Set when the text could not be understood; the caller shows it beside the field. */
  readonly error: string | null;
}

/** Words that pick a set of pages. */
const SELECTOR_WORDS = ['all', 'current', 'selected', 'last'] as const;
/** Words that narrow whatever was picked. */
const FILTER_WORDS = ['odd', 'even', 'landscape', 'portrait'] as const;

type FilterWord = (typeof FILTER_WORDS)[number];

/** Every word the field understands, for a hint line under it. */
export const RANGE_WORDS: ReadonlyArray<string> = [...SELECTOR_WORDS, ...FILTER_WORDS];

const SEPARATORS = /[,;]/u;
/** Hyphen, en dash and em dash: a range pasted out of a document carries the wrong one. */
const DASHES = /[-–—]/u;

/**
 * Parses a range against a document. One-based in, zero-based out.
 *
 * Unknown words and out-of-range numbers are errors rather than silent omissions: a reader who
 * typed `3-99` in a five-page document has misunderstood something, and deleting pages 3 to 5
 * without saying so is the wrong answer.
 */
export function parseRange(text: string, context: RangeContext): ParsedRange {
  const { pageCount } = context;
  if (pageCount <= 0) return { pages: [], error: null };
  const trimmed = text.trim();
  if (trimmed === '') return { pages: allPages(pageCount), error: null };

  const selected = new Set<number>();
  const filters: FilterWord[] = [];
  let sawSelector = false;

  for (const rawPart of trimmed.split(SEPARATORS)) {
    const part = rawPart.trim();
    if (part === '') continue;
    const word = part.toLowerCase();

    if ((FILTER_WORDS as ReadonlyArray<string>).includes(word)) {
      if (!filters.includes(word as FilterWord)) filters.push(word as FilterWord);
      continue;
    }

    if ((SELECTOR_WORDS as ReadonlyArray<string>).includes(word)) {
      sawSelector = true;
      for (const page of wordPages(word, context)) selected.add(page);
      continue;
    }

    const numeric = numericSelector(part, pageCount);
    if (numeric.error !== null) return { pages: [], error: numeric.error };
    sawSelector = true;
    for (const page of numeric.pages) selected.add(page);
  }

  // Only filter words were given, so they narrow the whole document — "even" means every even
  // page, not none.
  const base = sawSelector ? [...selected].sort((a, b) => a - b) : allPages(pageCount);
  const pages = base.filter((page) => filters.every((f) => matches(f, page, context)));
  if (pages.length === 0) {
    return { pages: [], error: sawSelector || filters.length > 0 ? 'No pages match that' : null };
  }
  return { pages, error: null };
}

/** `"3"`, `"2-4"`, `"8-"`, `"-4"`. */
function numericSelector(part: string, pageCount: number): ParsedRange {
  const bits = part.split(DASHES).map((b) => b.trim());
  if (bits.length > 2) return { pages: [], error: `"${part}" is not a page range` };

  if (bits.length === 1) {
    const page = toPage(bits[0] ?? '', pageCount);
    if (page === null) return { pages: [], error: describe(part, pageCount) };
    return { pages: [page], error: null };
  }

  const [fromText = '', toText = ''] = bits;
  // A bare "-" is not a range, it is a typing accident.
  if (fromText === '' && toText === '')
    return { pages: [], error: `"${part}" is not a page range` };
  const from = fromText === '' ? 0 : toPage(fromText, pageCount);
  const to = toText === '' ? pageCount - 1 : toPage(toText, pageCount);
  if (from === null) return { pages: [], error: describe(fromText, pageCount) };
  if (to === null) return { pages: [], error: describe(toText, pageCount) };
  const lo = Math.min(from, to);
  const hi = Math.max(from, to);
  const pages: number[] = [];
  for (let p = lo; p <= hi; p++) pages.push(p);
  return { pages, error: null };
}

/** Why a page number was refused, in words the reader can act on. */
function describe(text: string, pageCount: number): string {
  if (!/^\d+$/u.test(text.trim())) return `"${text.trim()}" is not a page number`;
  return `This document has ${String(pageCount)} ${pageCount === 1 ? 'page' : 'pages'}, so "${text.trim()}" is out of range`;
}

function toPage(text: string, pageCount: number): number | null {
  const t = text.trim();
  if (!/^\d+$/u.test(t)) return null;
  const n = Number.parseInt(t, 10);
  if (n < 1 || n > pageCount) return null;
  return n - 1;
}

function wordPages(word: string, context: RangeContext): number[] {
  switch (word) {
    case 'all':
      return allPages(context.pageCount);
    case 'current':
      return [Math.min(Math.max(0, context.currentPage), context.pageCount - 1)];
    case 'last':
      return [context.pageCount - 1];
    case 'selected':
      return [...new Set(context.selectedPages)]
        .filter((p) => p >= 0 && p < context.pageCount)
        .sort((a, b) => a - b);
    default:
      return [];
  }
}

/** Whether a page survives one filter word. */
function matches(filter: FilterWord, page: number, context: RangeContext): boolean {
  switch (filter) {
    // Odd and even are by the *printed* number, so "odd" is pages 1, 3, 5 — indexes 0, 2, 4.
    case 'odd':
      return page % 2 === 0;
    case 'even':
      return page % 2 === 1;
    case 'landscape':
    case 'portrait': {
      const size = context.pageSizes?.[page];
      // With no sizes to look at, the honest answer is "no page is known to be landscape".
      if (!size) return false;
      const landscape = size.width > size.height;
      return filter === 'landscape' ? landscape : !landscape;
    }
  }
}

export function allPages(pageCount: number): number[] {
  return Array.from({ length: Math.max(0, pageCount) }, (_, i) => i);
}

/**
 * `[0,1,2,5]` → `"1-3, 6"`. The summary line under a range field, and how a command reports
 * back what it acted on.
 */
export function formatRange(pages: ReadonlyArray<number>): string {
  const sorted = [...new Set(pages)].sort((a, b) => a - b);
  const parts: string[] = [];
  let start: number | null = null;
  let previous: number | null = null;
  const flush = (): void => {
    if (start === null || previous === null) return;
    parts.push(
      start === previous ? String(start + 1) : `${String(start + 1)}-${String(previous + 1)}`,
    );
    start = null;
    previous = null;
  };
  for (const page of sorted) {
    if (previous !== null && page === previous + 1) {
      previous = page;
      continue;
    }
    flush();
    start = page;
    previous = page;
  }
  flush();
  return parts.join(', ');
}

/** "3 pages" / "1 page", for a dialog's summary and a command's undo label. */
export function countPages(n: number): string {
  return `${String(n)} ${n === 1 ? 'page' : 'pages'}`;
}

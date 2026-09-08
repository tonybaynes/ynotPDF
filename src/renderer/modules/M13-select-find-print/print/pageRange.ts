/**
 * Page ranges and subsets (M13) — the "Pages: 2-4, 7, 9-" field of the print dialog and the
 * Odd / Even / Reverse switches beside it. Pure, and unit-tested against the odd cases that
 * actually turn up: a trailing dash, a reversed pair, whitespace, duplicates, out-of-range
 * numbers and en dashes pasted from a document.
 */

/** What the range field means. `custom` uses the text; the rest ignore it. */
export type RangeMode = 'all' | 'current' | 'selection' | 'custom';

/** Foxit's subset switch. */
export type SubsetMode = 'all' | 'odd' | 'even';

/** A parsed range field. `pages` is 0-based, ascending and without duplicates. */
export interface ParsedRange {
  readonly pages: ReadonlyArray<number>;
  /** Set when the text could not be understood; the caller shows it beside the field. */
  readonly error: string | null;
}

const SEPARATORS = /[,;]/u;
const DASHES = /[-–—]/u;

/**
 * Parses `"2-4, 7, 9-"` against a document of `pageCount` pages. One-based in, zero-based out.
 * Empty text means every page, which is what an empty field should do.
 */
export function parsePageRange(text: string, pageCount: number): ParsedRange {
  const trimmed = text.trim();
  if (pageCount <= 0) return { pages: [], error: null };
  if (trimmed.length === 0) return { pages: allPages(pageCount), error: null };
  const seen = new Set<number>();
  for (const rawPart of trimmed.split(SEPARATORS)) {
    const part = rawPart.trim();
    if (part.length === 0) continue;
    const bits = part.split(DASHES).map((b) => b.trim());
    if (bits.length > 2) return { pages: [], error: `"${part}" is not a page range` };
    if (bits.length === 1) {
      const n = toPage(bits[0] ?? '', pageCount);
      if (n === null) return { pages: [], error: `"${part}" is not a page number` };
      seen.add(n);
      continue;
    }
    const [fromText, toText] = bits;
    const from = fromText === '' ? 0 : toPage(fromText ?? '', pageCount);
    const to = toText === '' ? pageCount - 1 : toPage(toText ?? '', pageCount);
    if (from === null || to === null) return { pages: [], error: `"${part}" is not a page range` };
    const lo = Math.min(from, to);
    const hi = Math.max(from, to);
    for (let p = lo; p <= hi; p++) seen.add(p);
  }
  const pages = [...seen].sort((a, b) => a - b);
  if (pages.length === 0) return { pages: [], error: 'No pages in that range' };
  return { pages, error: null };
}

function toPage(text: string, pageCount: number): number | null {
  if (!/^\d+$/u.test(text)) return null;
  const n = Number.parseInt(text, 10);
  if (n < 1 || n > pageCount) return null;
  return n - 1;
}

export function allPages(pageCount: number): number[] {
  return Array.from({ length: Math.max(0, pageCount) }, (_, i) => i);
}

/** Odd / even by the *printed* page number, so "odd" is pages 1, 3, 5 — indexes 0, 2, 4. */
export function applySubset(pages: ReadonlyArray<number>, subset: SubsetMode): number[] {
  if (subset === 'all') return [...pages];
  return pages.filter((p) => (subset === 'odd' ? p % 2 === 0 : p % 2 === 1));
}

export function applyReverse(pages: ReadonlyArray<number>, reverse: boolean): number[] {
  return reverse ? [...pages].reverse() : [...pages];
}

/** The whole field → the list of pages to print, in order. */
export function resolvePages(options: {
  readonly mode: RangeMode;
  readonly text: string;
  readonly pageCount: number;
  readonly currentPage: number;
  readonly selectedPages: ReadonlyArray<number>;
  readonly subset: SubsetMode;
  readonly reverse: boolean;
}): ParsedRange {
  let base: ParsedRange;
  switch (options.mode) {
    case 'all':
      base = { pages: allPages(options.pageCount), error: null };
      break;
    case 'current':
      base = {
        pages: options.pageCount > 0 ? [clamp(options.currentPage, options.pageCount)] : [],
        error: null,
      };
      break;
    case 'selection':
      base = {
        pages: [...options.selectedPages]
          .filter((p) => p >= 0 && p < options.pageCount)
          .sort((a, b) => a - b),
        error: options.selectedPages.length === 0 ? 'Nothing is selected' : null,
      };
      break;
    case 'custom':
      base = parsePageRange(options.text, options.pageCount);
      break;
  }
  if (base.error) return base;
  return {
    pages: applyReverse(applySubset(base.pages, options.subset), options.reverse),
    error: null,
  };
}

function clamp(page: number, pageCount: number): number {
  return Math.min(Math.max(0, page), Math.max(0, pageCount - 1));
}

/** `[0,1,2,5]` → `"1-3, 6"`. Used for the summary line under the dialog's range field. */
export function formatPageRange(pages: ReadonlyArray<number>): string {
  const sorted = [...new Set(pages)].sort((a, b) => a - b);
  const parts: string[] = [];
  let start: number | null = null;
  let previous: number | null = null;
  const flush = (): void => {
    if (start === null || previous === null) return;
    parts.push(start === previous ? String(start + 1) : `${start + 1}-${previous + 1}`);
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

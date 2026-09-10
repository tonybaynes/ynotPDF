/**
 * Finding the web and e-mail addresses written in a page's text (M53).
 *
 * Pure: it takes the `TextRun`s the engine read and gives back rectangles and URLs. Nothing here
 * creates a link — the reader reviews every candidate first, because an unattended pass that
 * turns a version number into a link is worse than no pass at all.
 *
 * The rectangle comes from the run's **character boxes**, not from the run's own box, so a URL
 * that is part of a longer line gets a box round the URL rather than round the sentence. A match
 * that spans two runs (a URL broken across a line) becomes two links, which is what a reader
 * expects: both halves are clickable and both go to the same place.
 */

import type { PdfRect } from '@shared/pdf';
import type { TextRun } from '../PdfEngine';

/** One address found in the text. */
export interface LinkCandidate {
  readonly page: number;
  /** The text exactly as it appears on the page. */
  readonly text: string;
  /** Where it goes — `https://…` or `mailto:…`, already normalised. */
  readonly uri: string;
  /** The box round the matched characters, in page space. */
  readonly rect: PdfRect;
  /** Index of the run it came from, so a caller can group the pieces of one broken address. */
  readonly run: number;
}

export interface DetectOptions {
  /** Also match `www.example.com` and bare e-mail addresses, not only full URLs. */
  readonly bare?: boolean;
  /** Skip candidates whose box overlaps one of these — links that already exist. */
  readonly existing?: ReadonlyArray<PdfRect>;
}

/**
 * A URL with a scheme. Deliberately conservative about the last character: a URL at the end of a
 * sentence should not swallow the full stop, and one in brackets should not swallow the bracket.
 */
const SCHEME_URL = /\bhttps?:\/\/[^\s<>"'()\[\]{}|\\^`]+/gi;
const BARE_URL = /\bwww\.[^\s<>"'()\[\]{}|\\^`]+/gi;
const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

/** Trailing characters that are punctuation of the sentence rather than part of the address. */
const TRAILING = /[.,;:!?)\]}>'"]+$/;

interface RawMatch {
  readonly start: number;
  readonly end: number;
  readonly text: string;
  readonly uri: string;
}

/** Every address in one string, with where it sits in it. */
export function findAddresses(text: string, options: DetectOptions = {}): RawMatch[] {
  const out: RawMatch[] = [];
  const taken: Array<[number, number]> = [];
  const overlaps = (start: number, end: number): boolean =>
    taken.some(([s, e]) => start < e && end > s);

  const scan = (pattern: RegExp, toUri: (raw: string) => string): void => {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const index = match.index ?? 0;
      let raw = match[0];
      // A closing bracket only belongs to the URL if it opened inside it — the usual Wikipedia
      // case — and the pattern already refuses brackets, so this is only the sentence's own
      // punctuation.
      const trimmed = raw.replace(TRAILING, '');
      if (trimmed === '') continue;
      raw = trimmed;
      const end = index + raw.length;
      if (overlaps(index, end)) continue;
      taken.push([index, end]);
      out.push({ start: index, end, text: raw, uri: toUri(raw) });
    }
  };

  scan(SCHEME_URL, (raw) => raw);
  if (options.bare !== false) {
    scan(EMAIL, (raw) => `mailto:${raw}`);
    scan(BARE_URL, (raw) => `https://${raw}`);
  }
  return out.sort((a, b) => a.start - b.start);
}

/** The union of some character boxes. */
function unionOf(rects: ReadonlyArray<PdfRect>): PdfRect | null {
  let out: PdfRect | null = null;
  for (const r of rects) {
    out = out
      ? {
          x0: Math.min(out.x0, r.x0),
          y0: Math.min(out.y0, r.y0),
          x1: Math.max(out.x1, r.x1),
          y1: Math.max(out.y1, r.y1),
        }
      : r;
  }
  return out;
}

/** Whether two rectangles share any area. */
export function overlaps(a: PdfRect, b: PdfRect): boolean {
  return a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;
}

/**
 * Every address written in a page's text.
 *
 * A run whose `chars` do not line up with its text (a backend that reports them differently) is
 * still matched — the run's own box is used instead, which is the honest fallback and is what a
 * one-word run would give anyway.
 */
export function detectLinks(
  page: number,
  runs: ReadonlyArray<TextRun>,
  options: DetectOptions = {},
): LinkCandidate[] {
  const out: LinkCandidate[] = [];
  runs.forEach((run, index) => {
    for (const match of findAddresses(run.text, options)) {
      const chars = [...run.chars].slice(match.start, match.end);
      const rect = chars.length > 0 ? unionOf(chars) : run.rect;
      if (!rect) continue;
      if (options.existing?.some((e) => overlaps(e, rect))) continue;
      out.push({ page, text: match.text, uri: match.uri, rect: pad(rect), run: index });
    }
  });
  return out;
}

/**
 * A link's box, opened out by a point on every side.
 *
 * A box tight to the glyphs is hard to hit and clips the underline a viewer draws; one point is
 * what Acrobat and Foxit both leave, and it is small enough that two links on consecutive lines
 * still do not touch.
 */
function pad(rect: PdfRect): PdfRect {
  return { x0: rect.x0 - 1, y0: rect.y0 - 1, x1: rect.x1 + 1, y1: rect.y1 + 1 };
}

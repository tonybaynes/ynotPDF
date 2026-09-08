/**
 * The text-selection model (M13). Pure: two carets, a granularity and an optional column
 * rectangle, plus the rules that turn them into per-page spans. The DOM controller
 * (`TextSelectionController`) is a thin layer over this, so every rule that decides *what* is
 * selected — cross-page runs, double-click words, triple-click paragraphs, Alt-drag columns — is
 * unit-tested in Node rather than clicked at in a browser.
 */

import {
  columnSpans,
  mergeSpans,
  paragraphSpanAt,
  wordAt,
  type PageText,
  type Span,
} from '@view/TextLayer';
import type { PdfRect } from '@shared/pdf';

/** A point in the document: a page and a character offset within its text. */
export interface Caret {
  readonly page: number;
  readonly offset: number;
}

/** What one drag selects at a time. */
export type Granularity = 'character' | 'word' | 'paragraph';

export interface SelectionState {
  readonly anchor: Caret | null;
  readonly focus: Caret | null;
  readonly granularity: Granularity;
  /** Alt-drag: the marquee, in page space, and the page it is on. */
  readonly column: { readonly page: number; readonly rect: PdfRect } | null;
}

export const EMPTY_SELECTION: SelectionState = {
  anchor: null,
  focus: null,
  granularity: 'character',
  column: null,
};

/** How the model reaches a page's text. Returns `undefined` for a page not yet read. */
export type TextLookup = (page: number) => PageText | undefined;

export function isEmpty(state: SelectionState): boolean {
  if (state.column) return false;
  if (!state.anchor || !state.focus) return true;
  return state.anchor.page === state.focus.page && state.anchor.offset === state.focus.offset;
}

/** The two carets in document order. */
export function ordered(state: SelectionState): [Caret, Caret] | null {
  const { anchor, focus } = state;
  if (!anchor || !focus) return null;
  const forwards =
    anchor.page < focus.page || (anchor.page === focus.page && anchor.offset <= focus.offset);
  return forwards ? [anchor, focus] : [focus, anchor];
}

/** Every page the selection touches, ascending. */
export function selectedPages(state: SelectionState): number[] {
  if (state.column) return [state.column.page];
  const pair = ordered(state);
  if (!pair) return [];
  const [from, to] = pair;
  const pages: number[] = [];
  for (let p = from.page; p <= to.page; p++) pages.push(p);
  return pages;
}

/**
 * The spans selected on one page. A granularity of `word` or `paragraph` grows *both* ends of
 * the selection to that unit, which is what makes a double-click-and-drag extend word by word.
 */
export function spansForPage(state: SelectionState, page: number, lookup: TextLookup): Span[] {
  const text = lookup(page);
  if (!text) return [];
  if (state.column) {
    return state.column.page === page ? mergeSpans(columnSpans(text, state.column.rect)) : [];
  }
  const pair = ordered(state);
  if (!pair) return [];
  const [from, to] = pair;
  if (page < from.page || page > to.page) return [];

  let start = page === from.page ? from.offset : 0;
  let end = page === to.page ? to.offset : text.text.length;
  if (state.granularity !== 'character') {
    const expand = state.granularity === 'word' ? wordAt : paragraphSpanAt;
    if (page === from.page) {
      const startText = lookup(from.page);
      if (startText) start = Math.min(start, expand(startText, from.offset).start);
    }
    if (page === to.page) {
      const endText = lookup(to.page);
      if (endText) end = Math.max(end, expand(endText, Math.max(0, to.offset - 1)).end);
    }
    if (page !== from.page) start = 0;
    if (page !== to.page) end = text.text.length;
  }
  if (end <= start) return [];
  return mergeSpans([{ start, end }]);
}

/** Sets both carets, which is what a fresh click does. */
export function startAt(caret: Caret, granularity: Granularity = 'character'): SelectionState {
  return { anchor: caret, focus: caret, granularity, column: null };
}

/** Moves the focus, which is what a drag and a Shift-click do. */
export function extendTo(state: SelectionState, caret: Caret): SelectionState {
  if (!state.anchor) return startAt(caret, state.granularity);
  return { ...state, focus: caret, column: null };
}

/** Selects a whole page — Ctrl+A. */
export function selectPage(page: number, text: PageText): SelectionState {
  return {
    anchor: { page, offset: 0 },
    focus: { page, offset: text.text.length },
    granularity: 'character',
    column: null,
  };
}

/** Selects everything from the first page to the last. */
export function selectAllPages(
  firstPage: number,
  lastPage: number,
  lastLength: number,
): SelectionState {
  return {
    anchor: { page: firstPage, offset: 0 },
    focus: { page: lastPage, offset: lastLength },
    granularity: 'character',
    column: null,
  };
}

/** Alt-drag. */
export function selectColumn(page: number, rect: PdfRect): SelectionState {
  return { anchor: null, focus: null, granularity: 'character', column: { page, rect } };
}

/**
 * The selected text of the whole selection, pages joined by a line break. Pages with no text yet
 * contribute nothing rather than blocking the copy — the caller reads the pages it needs first.
 */
export function selectionText(state: SelectionState, lookup: TextLookup): string {
  const parts: string[] = [];
  for (const page of selectedPages(state)) {
    const text = lookup(page);
    if (!text) continue;
    const spans = spansForPage(state, page, lookup);
    for (const span of spans) parts.push(text.text.slice(span.start, span.end));
  }
  // Page-level joins: every span already ends with its own line break where one belongs.
  return parts.join('').replace(/\n+$/u, '\n');
}

/** Character count, for the status bar. */
export function selectionLength(state: SelectionState, lookup: TextLookup): number {
  let n = 0;
  for (const page of selectedPages(state)) {
    for (const span of spansForPage(state, page, lookup)) n += span.end - span.start;
  }
  return n;
}

/**
 * Text selection, the DOM half (M13). One controller per document tab; it listens on each
 * viewport's scroller rather than on the page tool layers, because a drag that starts on page 3
 * and ends on page 5 has to keep producing coordinates after it has left the page it started on
 * — and a pointer capture on a page element would keep reporting that page's coordinates for
 * ever.
 *
 * Everything about *what* is selected lives in `selection/model.ts` and is unit-tested; this
 * file is the pointer, keyboard and repaint plumbing around it.
 */

import type { PdfRect } from '@shared/pdf';
import type { DocumentView } from '@view/DocumentView';
import { offsetAt, spanRects, type PageText } from '@view/TextLayer';
import type { Highlighter } from './Highlighter';
import { type Highlight } from './Highlighter';
import {
  EMPTY_SELECTION,
  extendTo,
  isEmpty,
  ordered,
  selectColumn,
  selectedPages,
  spansForPage,
  startAt,
  type Caret,
  type Granularity,
  type SelectionState,
  type TextLookup,
} from './model';

export interface TextSelectionOptions {
  /** True while the Select Text tool is the active tool. */
  readonly isActive: () => boolean;
  /** The cached text of a page, if it has been read. */
  readonly lookup: TextLookup;
  /** Asks for a page's text; the controller repaints when it arrives. */
  readonly ensure: (page: number) => Promise<PageText>;
  /** Called whenever the selection changes, so the service can publish it. */
  readonly onChange: (state: SelectionState) => void;
  readonly highlighter: Highlighter;
}

/** How close two clicks must be, in time and space, to count as a double click. */
const MULTI_CLICK_MS = 400;
const MULTI_CLICK_PX = 4;

export class TextSelectionController {
  private readonly options: TextSelectionOptions;
  private readonly panes: Array<{ view: DocumentView; dispose: () => void }> = [];
  private state: SelectionState = EMPTY_SELECTION;
  private dragging = false;
  private columnAnchor: { page: number; x: number; y: number } | null = null;
  private lastClick = { time: 0, x: 0, y: 0, count: 0 };
  private disposed = false;

  constructor(options: TextSelectionOptions) {
    this.options = options;
  }

  get selection(): SelectionState {
    return this.state;
  }

  get isEmpty(): boolean {
    return isEmpty(this.state);
  }

  /** Binds one viewport. Split view calls this twice. */
  attach(view: DocumentView): void {
    const scroller = view.scroller;
    const onPointerDown = (event: PointerEvent): void => {
      if (!this.options.isActive() || event.button !== 0) return;
      const hit = view.hitTest(event.clientX, event.clientY);
      if (!hit) return;
      event.preventDefault();
      scroller.setPointerCapture(event.pointerId);
      this.dragging = true;
      const count = this.clickCount(event);
      if (event.altKey) {
        this.columnAnchor = { page: hit.page, x: hit.x, y: hit.y };
        this.apply(selectColumn(hit.page, { x0: hit.x, y0: hit.y, x1: hit.x, y1: hit.y }));
        return;
      }
      this.columnAnchor = null;
      void this.caretAt(view, event.clientX, event.clientY).then((caret) => {
        if (!caret) return;
        if (event.shiftKey && this.state.anchor) this.apply(extendTo(this.state, caret));
        else this.apply(startAt(caret, granularityFor(count)));
      });
    };

    const onPointerMove = (event: PointerEvent): void => {
      if (!this.dragging || !this.options.isActive()) return;
      const hit = view.hitTest(event.clientX, event.clientY);
      if (!hit) return;
      if (this.columnAnchor) {
        const a = this.columnAnchor;
        this.apply(
          selectColumn(a.page, {
            x0: Math.min(a.x, hit.x),
            y0: Math.min(a.y, hit.y),
            x1: Math.max(a.x, hit.x),
            y1: Math.max(a.y, hit.y),
          }),
        );
        return;
      }
      void this.caretAt(view, event.clientX, event.clientY).then((caret) => {
        if (caret && this.dragging) this.apply(extendTo(this.state, caret));
      });
    };

    const onPointerUp = (event: PointerEvent): void => {
      if (!this.dragging) return;
      this.dragging = false;
      this.columnAnchor = null;
      scroller.releasePointerCapture?.(event.pointerId);
    };

    const onKeyDown = (event: KeyboardEvent): void => {
      if (!this.options.isActive() || event.defaultPrevented) return;
      if (this.handleKey(view, event)) event.preventDefault();
    };

    scroller.addEventListener('pointerdown', onPointerDown);
    scroller.addEventListener('pointermove', onPointerMove);
    scroller.addEventListener('pointerup', onPointerUp);
    scroller.addEventListener('pointercancel', onPointerUp);
    scroller.addEventListener('keydown', onKeyDown);
    this.panes.push({
      view,
      dispose: () => {
        scroller.removeEventListener('pointerdown', onPointerDown);
        scroller.removeEventListener('pointermove', onPointerMove);
        scroller.removeEventListener('pointerup', onPointerUp);
        scroller.removeEventListener('pointercancel', onPointerUp);
        scroller.removeEventListener('keydown', onKeyDown);
      },
    });
    this.options.highlighter.attach(view);
  }

  /** The viewport the reader is working in — the first attached one. */
  get primaryPane(): DocumentView | null {
    return this.panes[0]?.view ?? null;
  }

  /** Replaces the selection (Select All, a search result, a test). */
  apply(state: SelectionState): void {
    this.state = state;
    this.repaint();
    this.options.onChange(state);
  }

  clear(): void {
    if (isEmpty(this.state)) return;
    this.apply(EMPTY_SELECTION);
  }

  /** The spans selected on one page. */
  spans(page: number): ReadonlyArray<{ start: number; end: number }> {
    return spansForPage(this.state, page, this.options.lookup);
  }

  pages(): number[] {
    return selectedPages(this.state);
  }

  /** Repaints the highlights, merging in whatever the find controller has asked for. */
  repaint(extra: ReadonlyArray<Highlight> = []): void {
    const highlights: Highlight[] = [...extra];
    for (const page of selectedPages(this.state)) {
      const text = this.options.lookup(page);
      if (!text) {
        void this.options.ensure(page).then(() => {
          if (!this.disposed) this.repaint(extra);
        });
        continue;
      }
      for (const span of spansForPage(this.state, page, this.options.lookup)) {
        for (const rect of spanRects(text, span)) {
          highlights.push({ page, rect, kind: 'selection' });
        }
      }
    }
    this.options.highlighter.set(highlights);
  }

  /** Reads the text of every page currently on screen, so a click selects without a wait. */
  prefetchVisible(): void {
    for (const pane of this.panes) {
      for (const rect of pane.view.layoutTable.rects) {
        if (pane.view.pageView(rect.page)) void this.options.ensure(rect.page);
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const pane of this.panes.splice(0)) pane.dispose();
  }

  // ---- internals ------------------------------------------------------------------------------

  private async caretAt(
    view: DocumentView,
    clientX: number,
    clientY: number,
  ): Promise<Caret | null> {
    const hit = view.hitTest(clientX, clientY);
    if (!hit) return null;
    const text = this.options.lookup(hit.page) ?? (await this.options.ensure(hit.page));
    const offset = offsetAt(text, { x: hit.x, y: hit.y });
    if (offset === null) return { page: hit.page, offset: 0 };
    return { page: hit.page, offset };
  }

  private clickCount(event: PointerEvent): number {
    const now = performance.now();
    const near =
      Math.abs(event.clientX - this.lastClick.x) < MULTI_CLICK_PX &&
      Math.abs(event.clientY - this.lastClick.y) < MULTI_CLICK_PX;
    const count = near && now - this.lastClick.time < MULTI_CLICK_MS ? this.lastClick.count + 1 : 1;
    this.lastClick = { time: now, x: event.clientX, y: event.clientY, count };
    return count;
  }

  /** Arrow keys, Home/End and Escape. Returns true when the key was used. */
  private handleKey(view: DocumentView, event: KeyboardEvent): boolean {
    if (event.key === 'Escape' && !this.isEmpty) {
      this.clear();
      return true;
    }
    const focus = this.state.focus;
    if (!focus) return false;
    const text = this.options.lookup(focus.page);
    if (!text) return false;
    const next = moveCaret(text, focus, event.key, view.pageCount);
    if (!next) return false;
    this.apply(
      event.shiftKey ? extendTo(this.state, next) : { ...startAt(next), granularity: 'character' },
    );
    return true;
  }
}

function granularityFor(clickCount: number): Granularity {
  if (clickCount >= 3) return 'paragraph';
  if (clickCount === 2) return 'word';
  return 'character';
}

/** One keystroke's worth of caret movement inside a page. */
export function moveCaret(
  text: PageText,
  caret: Caret,
  key: string,
  pageCount: number,
): Caret | null {
  const max = text.text.length;
  const clamp = (offset: number): Caret => ({
    page: caret.page,
    offset: Math.min(Math.max(0, offset), max),
  });
  switch (key) {
    case 'ArrowLeft':
      return caret.offset > 0
        ? clamp(caret.offset - 1)
        : caret.page > 0
          ? { page: caret.page - 1, offset: 0 }
          : clamp(0);
    case 'ArrowRight':
      return caret.offset < max
        ? clamp(caret.offset + 1)
        : caret.page + 1 < pageCount
          ? { page: caret.page + 1, offset: 0 }
          : clamp(max);
    case 'ArrowUp':
    case 'ArrowDown': {
      const line = text.lines.find((l) => caret.offset >= l.start && caret.offset <= l.end);
      const index = (line?.index ?? 0) + (key === 'ArrowDown' ? 1 : -1);
      const target = text.lines[index];
      if (!target) return null;
      const column = caret.offset - (line?.start ?? 0);
      return clamp(Math.min(target.start + column, target.end));
    }
    case 'Home': {
      const line = text.lines.find((l) => caret.offset >= l.start && caret.offset <= l.end);
      return clamp(line?.start ?? 0);
    }
    case 'End': {
      const line = text.lines.find((l) => caret.offset >= l.start && caret.offset <= l.end);
      return clamp(line?.end ?? max);
    }
    default:
      return null;
  }
}

/** The two carets in document order, exported for the status line. */
export { ordered };
export type { PdfRect };

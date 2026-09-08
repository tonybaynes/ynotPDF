/**
 * View navigation history (M11) — Alt+← / Alt+→, the "back to where I was" that a reader needs
 * after following a link or typing a page number. Pure: a bounded stack of view positions with
 * a cursor, no DOM, no store.
 *
 * Only *jumps* are recorded (a page field, a bookmark, a link, Home/End). Ordinary scrolling is
 * not history — Foxit behaves the same way, and a scroll-per-entry stack would be useless.
 */

/** Where the view was: which page, and the scroll position within the content. */
export interface ViewPosition {
  readonly page: number;
  readonly left: number;
  readonly top: number;
  /** Zoom factor (CSS px per point) at the time, so going back restores the zoom too. */
  readonly zoom: number;
}

export const HISTORY_LIMIT = 100;

export class ViewHistory {
  private readonly entries: ViewPosition[] = [];
  private cursor = -1;
  private readonly limit: number;

  constructor(limit: number = HISTORY_LIMIT) {
    this.limit = Math.max(2, limit);
  }

  get length(): number {
    return this.entries.length;
  }

  get index(): number {
    return this.cursor;
  }

  get canGoBack(): boolean {
    return this.cursor > 0;
  }

  get canGoForward(): boolean {
    return this.cursor >= 0 && this.cursor < this.entries.length - 1;
  }

  /** The position the cursor is on, or `null` before anything is recorded. */
  get current(): ViewPosition | null {
    return this.entries[this.cursor] ?? null;
  }

  /**
   * Records a jump. Anything ahead of the cursor is dropped (a new branch), and a jump that
   * lands on the same page as the current entry replaces it rather than stacking duplicates.
   */
  push(position: ViewPosition): void {
    const current = this.current;
    if (current?.page === position.page && Math.abs(current.top - position.top) < 1) {
      this.entries[this.cursor] = position;
      return;
    }
    this.entries.splice(this.cursor + 1);
    this.entries.push(position);
    if (this.entries.length > this.limit) this.entries.shift();
    this.cursor = this.entries.length - 1;
  }

  /**
   * Updates the current entry in place — called just before a jump so that going back returns
   * to the exact scroll position the reader left, not to where the last jump landed.
   */
  replace(position: ViewPosition): void {
    if (this.cursor < 0) {
      this.push(position);
      return;
    }
    this.entries[this.cursor] = position;
  }

  back(): ViewPosition | null {
    if (!this.canGoBack) return null;
    this.cursor--;
    return this.current;
  }

  forward(): ViewPosition | null {
    if (!this.canGoForward) return null;
    this.cursor++;
    return this.current;
  }

  clear(): void {
    this.entries.length = 0;
    this.cursor = -1;
  }

  /** For the perf HUD and tests. */
  toArray(): ReadonlyArray<ViewPosition> {
    return [...this.entries];
  }
}

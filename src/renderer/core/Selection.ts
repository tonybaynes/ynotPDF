/**
 * `Selection` — what the user currently has selected (M00 typed shell).
 *
 * Exactly one selection kind is active at a time. Modules read it to decide `when` clauses
 * (e.g. "Delete pages" is enabled only for a `pages` selection) and to target commands.
 * Coordinates are PDF points, origin bottom-left, page-relative.
 */

import type { PageIndex, PdfRect } from '@shared/pdf';
import { createStore, type Store, type Unsubscribe } from './Store';

/** A contiguous run of characters on one page, as indexes into `textRuns(page)`. */
export interface TextRange {
  readonly page: PageIndex;
  /** Index of the first run and character offset within it (inclusive). */
  readonly startRun: number;
  readonly startChar: number;
  /** Index of the last run and character offset within it (exclusive). */
  readonly endRun: number;
  readonly endChar: number;
}

export type SelectionState =
  | { readonly kind: 'none' }
  | { readonly kind: 'text'; readonly ranges: ReadonlyArray<TextRange> }
  | { readonly kind: 'annotations'; readonly page: PageIndex; readonly ids: ReadonlyArray<string> }
  | { readonly kind: 'objects'; readonly page: PageIndex; readonly indexes: ReadonlyArray<number> }
  | { readonly kind: 'pages'; readonly pages: ReadonlyArray<PageIndex> }
  | { readonly kind: 'fields'; readonly names: ReadonlyArray<string> }
  | {
      readonly kind: 'region';
      readonly page: PageIndex;
      /** Marquee rectangle in page space (snapshot, crop, redaction area). */
      readonly rect: PdfRect;
    };

export type SelectionKind = SelectionState['kind'];

export const NO_SELECTION: SelectionState = { kind: 'none' };

/** Holds the current selection and notifies on change. */
export class Selection {
  private readonly store: Store<{ current: SelectionState }>;

  constructor() {
    this.store = createStore({ current: NO_SELECTION });
  }

  get current(): SelectionState {
    return this.store.get().current;
  }

  get kind(): SelectionKind {
    return this.current.kind;
  }

  get isEmpty(): boolean {
    return this.current.kind === 'none';
  }

  set(next: SelectionState): void {
    this.store.set({ current: next });
  }

  clear(): void {
    this.set(NO_SELECTION);
  }

  /** Narrow to a kind; returns `null` when a different kind is selected. */
  as<K extends SelectionKind>(kind: K): Extract<SelectionState, { kind: K }> | null {
    const c = this.current;
    return c.kind === kind ? (c as Extract<SelectionState, { kind: K }>) : null;
  }

  subscribe(listener: (next: SelectionState, previous: SelectionState) => void): Unsubscribe {
    return this.store.select((s) => s.current, listener, { immediate: false });
  }
}

/**
 * Dragging pages in the thumbnails panel (M40).
 *
 * The panel itself is M12's, and this module does not touch a line of it. The controller
 * delegates from the document root and finds its cells by class, so M12's virtualised grid can
 * build and drop cells underneath a drag in progress without either module knowing the other's
 * internals — which is also why the drag survives the auto-scroll that creates new cells.
 *
 * Pointer events rather than HTML5 drag-and-drop, deliberately:
 *
 * - the **insertion marker** has to sit between two thumbnails in a grid that reflows, which a
 *   drag image cannot express;
 * - **auto-scroll** near the edges has to run while the pointer is still, and `dragover` only
 *   fires when it moves;
 * - **Ctrl to copy** has to be readable at the moment of the drop, not at the moment the drag
 *   started;
 * - a **drag under five pixels is a click**, so M12's own select-and-navigate still works.
 *
 * Two drop targets: the grid itself (reorder, or copy within the document) and a document **tab**
 * (copy into that document). The tab is this shell's answer to Foxit's side-by-side panels, which
 * need a split view M02 does not have — see the module's Design decisions.
 */

import type { Selection } from '@core/Selection';
import { el } from '@app/dom';

/** How far the pointer must travel before a press becomes a drag. */
const DRAG_THRESHOLD_PX = 5;
/** How near the edge of the scroller auto-scroll begins, and how fast it goes. */
const AUTOSCROLL_EDGE_PX = 48;
const AUTOSCROLL_MAX_PX = 18;

export interface DragTarget {
  /** Reorder inside the document: the visual index to insert before. */
  readonly kind: 'grid';
  readonly index: number;
  readonly copy: boolean;
}

export interface TabDropTarget {
  readonly kind: 'tab';
  readonly tabId: string;
}

export type DropTarget = DragTarget | TabDropTarget;

export interface ThumbnailDragOptions {
  readonly selection: Selection;
  /** Pages of the active document, for clamping. */
  readonly pageCount: () => number;
  /** The id of the tab the thumbnails belong to, so a drop on its own tab does nothing. */
  readonly activeTabId: () => string | null;
  /** Performs the drop. Returning a promise keeps the marker up until it is done. */
  readonly onDrop: (pages: ReadonlyArray<number>, target: DropTarget) => Promise<void> | void;
  /** Root to delegate from; the shell's document element in the app, a fixture in tests. */
  readonly root?: HTMLElement;
}

/**
 * The part of a `DOMRect` this needs. Structural rather than `DOMRectReadOnly` so the geometry
 * can be tested in plain Node, where there is no DOM at all.
 */
export interface CellBox {
  readonly top: number;
  readonly left: number;
  readonly width: number;
  readonly height: number;
}

export interface DragCell {
  readonly page: number;
  readonly rect: CellBox;
}

/**
 * Where an insertion marker goes for a pointer at `point`, given the cells on screen.
 *
 * Pure, so the awkward part — a grid whose rows wrap, where "after the last cell of a row" and
 * "before the first cell of the next" are the same insertion point — is testable without a
 * browser. The answer is a visual page index to insert *before*, so it ranges 0..pageCount.
 */
export function insertionIndexFor(
  cells: ReadonlyArray<DragCell>,
  point: { readonly x: number; readonly y: number },
  pageCount: number,
): number {
  if (cells.length === 0) return 0;
  const ordered = [...cells].sort((a, b) => a.page - b.page);
  // The row the pointer is in, or the nearest one above it when it is in a gap.
  let best = ordered[0];
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const cell of ordered) {
    const cy = cell.rect.top + cell.rect.height / 2;
    const cx = cell.rect.left + cell.rect.width / 2;
    // Vertical distance dominates: a grid is rows first, and a pointer two rows away on the same
    // column must not beat the cell it is actually over.
    const distance = Math.abs(point.y - cy) * 4 + Math.abs(point.x - cx);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = cell;
    }
  }
  if (!best) return 0;
  const middle = best.rect.left + best.rect.width / 2;
  const index = point.x > middle ? best.page + 1 : best.page;
  return Math.max(0, Math.min(index, pageCount));
}

export interface ThumbnailDragController {
  dispose(): void;
  /** True while a drag is in progress (the e2e suite and the panel both ask). */
  readonly dragging: boolean;
}

export function installThumbnailDrag(options: ThumbnailDragOptions): ThumbnailDragController {
  const root = options.root ?? document.body;
  let start: { x: number; y: number; page: number; pointerId: number } | null = null;
  let dragging = false;
  let pages: number[] = [];
  let marker: HTMLElement | null = null;
  let ghost: HTMLElement | null = null;
  let scroller: HTMLElement | null = null;
  let autoscroll: number | null = null;
  let lastTarget: DropTarget | null = null;

  const cellsOnScreen = (): DragCell[] =>
    [...document.querySelectorAll<HTMLElement>('.thumb-cell')].map((cell) => ({
      page: Number(cell.dataset['page'] ?? '0'),
      rect: cell.getBoundingClientRect(),
    }));

  const stopAutoscroll = (): void => {
    if (autoscroll !== null) cancelAnimationFrame(autoscroll);
    autoscroll = null;
  };

  const cleanup = (): void => {
    stopAutoscroll();
    marker?.remove();
    ghost?.remove();
    marker = null;
    ghost = null;
    dragging = false;
    start = null;
    pages = [];
    lastTarget = null;
    document.body.classList.remove('is-page-dragging');
  };

  /** Keeps scrolling while the pointer rests near an edge, so a long document is reachable. */
  const tickAutoscroll = (clientY: number): void => {
    stopAutoscroll();
    const box = scroller?.getBoundingClientRect();
    if (!scroller || !box) return;
    const above = clientY - box.top;
    const below = box.bottom - clientY;
    let delta = 0;
    if (above < AUTOSCROLL_EDGE_PX) {
      delta = -Math.ceil(
        ((AUTOSCROLL_EDGE_PX - Math.max(0, above)) / AUTOSCROLL_EDGE_PX) * AUTOSCROLL_MAX_PX,
      );
    } else if (below < AUTOSCROLL_EDGE_PX) {
      delta = Math.ceil(
        ((AUTOSCROLL_EDGE_PX - Math.max(0, below)) / AUTOSCROLL_EDGE_PX) * AUTOSCROLL_MAX_PX,
      );
    }
    if (delta === 0) return;
    const step = (): void => {
      if (!scroller || !dragging) return;
      scroller.scrollTop += delta;
      autoscroll = requestAnimationFrame(step);
    };
    autoscroll = requestAnimationFrame(step);
  };

  const showMarker = (index: number): void => {
    const spacer = document.querySelector<HTMLElement>('.thumb-spacer');
    if (!spacer) return;
    marker ??= el('div.organise-drop-marker', { 'aria-hidden': 'true' });
    if (marker.parentElement !== spacer) spacer.append(marker);
    const cells = [...document.querySelectorAll<HTMLElement>('.thumb-cell')];
    const at = cells.find((c) => Number(c.dataset['page'] ?? '0') === index);
    const previous = cells.find((c) => Number(c.dataset['page'] ?? '0') === index - 1);
    const anchor = at ?? previous;
    if (!anchor) return;
    const spacerBox = spacer.getBoundingClientRect();
    const box = anchor.getBoundingClientRect();
    const left = at ? box.left - spacerBox.left : box.right - spacerBox.left;
    marker.style.left = `${String(Math.round(left + spacer.scrollLeft) - 2)}px`;
    marker.style.top = `${String(Math.round(box.top - spacerBox.top + spacer.scrollTop))}px`;
    marker.style.height = `${String(Math.round(box.height))}px`;
  };

  const hideMarker = (): void => {
    marker?.remove();
    marker = null;
  };

  /** The floating count that follows the pointer, so the reader can see what is being carried. */
  const showGhost = (x: number, y: number, copy: boolean): void => {
    if (!ghost) {
      ghost = el('div.organise-drag-ghost', { 'aria-hidden': 'true' });
      document.body.append(ghost);
    }
    const what = pages.length === 1 ? '1 page' : `${String(pages.length)} pages`;
    ghost.textContent = copy ? `Copy ${what}` : `Move ${what}`;
    ghost.style.left = `${String(Math.round(x + 14))}px`;
    ghost.style.top = `${String(Math.round(y + 14))}px`;
  };

  const targetFor = (event: PointerEvent): DropTarget | null => {
    const under = document.elementFromPoint(event.clientX, event.clientY);
    const tab = under?.closest<HTMLElement>('[data-tab-id]');
    if (tab) {
      const tabId = tab.dataset['tabId'] ?? '';
      return tabId === '' || tabId === options.activeTabId() ? null : { kind: 'tab', tabId };
    }
    if (!under?.closest('.thumb-scroll')) return null;
    const index = insertionIndexFor(
      cellsOnScreen(),
      { x: event.clientX, y: event.clientY },
      options.pageCount(),
    );
    return { kind: 'grid', index, copy: event.ctrlKey || event.metaKey };
  };

  const onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) return;
    const cell = (event.target as HTMLElement | null)?.closest<HTMLElement>('.thumb-cell');
    if (!cell) return;
    const page = Number(cell.dataset['page'] ?? '0');
    scroller = cell.closest<HTMLElement>('.thumb-scroll');
    start = { x: event.clientX, y: event.clientY, page, pointerId: event.pointerId };
  };

  const onPointerMove = (event: PointerEvent): void => {
    if (!start) return;
    if (!dragging) {
      const moved = Math.hypot(event.clientX - start.x, event.clientY - start.y);
      if (moved < DRAG_THRESHOLD_PX) return;
      // A drag of a page that is not in the selection carries that page alone — the same rule a
      // file manager uses, and the one that stops a stale selection surprising the reader.
      const selected = [...(options.selection.as('pages')?.pages ?? [])].sort((a, b) => a - b);
      pages = selected.includes(start.page) ? selected : [start.page];
      if (pages.length === 0) return;
      dragging = true;
      document.body.classList.add('is-page-dragging');
    }
    event.preventDefault();
    const target = targetFor(event);
    lastTarget = target;
    if (target?.kind === 'grid') showMarker(target.index);
    else hideMarker();
    showGhost(
      event.clientX,
      event.clientY,
      target?.kind === 'tab' || (target?.kind === 'grid' && target.copy),
    );
    tickAutoscroll(event.clientY);
  };

  const onPointerUp = (event: PointerEvent): void => {
    if (!dragging) {
      start = null;
      return;
    }
    const target = targetFor(event) ?? lastTarget;
    const carried = [...pages];
    cleanup();
    if (target && carried.length > 0) void options.onDrop(carried, target);
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    // Escape abandons a drag, as it does everywhere else in the shell.
    if (event.key === 'Escape' && dragging) {
      event.preventDefault();
      cleanup();
    }
  };

  root.addEventListener('pointerdown', onPointerDown, true);
  window.addEventListener('pointermove', onPointerMove, true);
  window.addEventListener('pointerup', onPointerUp, true);
  window.addEventListener('pointercancel', cleanup, true);
  window.addEventListener('keydown', onKeyDown, true);

  return {
    dispose: () => {
      cleanup();
      root.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('pointermove', onPointerMove, true);
      window.removeEventListener('pointerup', onPointerUp, true);
      window.removeEventListener('pointercancel', cleanup, true);
      window.removeEventListener('keydown', onKeyDown, true);
    },
    get dragging() {
      return dragging;
    },
  };
}

/**
 * The Pages panel (M12) — the default navigation panel, and the operator's layout rules made
 * real:
 *
 * - it opens as **one column** at the current size, and the pane is exactly that wide;
 * - `+` / `−` and Ctrl+wheel step the size **and** re-set the pane width, so the splitter never
 *   has to be dragged after a zoom, and the page you were on stays in view;
 * - dragging the splitter wider **adds columns**, because the column count is divided out of the
 *   width on every layout and stored nowhere.
 *
 * The grid is virtualised on rows: only the rows near the viewport have DOM, so a 500-page
 * document costs what a 5-page one does. Thumbnails come from `ThumbnailRenderer`, which yields
 * to the main view.
 */

import { el } from '@app/dom';
import type { ServiceContext } from '@shared/module';
import type { Selection } from '@core/Selection';
import { emptyMessage, installListKeys, toolButton, toolbar } from '../panelChrome';
import type { NavigationService } from '../NavigationService';
import {
  GRID_GAP,
  GRID_PADDING,
  canStep,
  keyboardTarget,
  metrics,
  pagesInRow,
  rangeBetween,
  scrollToPage,
  thumbnailBox,
  visibleRows,
  type GridMetrics,
} from './grid';
import type { ThumbnailRequest } from './ThumbnailRenderer';

/** Mounts the Pages panel. Returns the disposer the shell calls when the panel goes. */
export function mountThumbnailPanel(
  host: HTMLElement,
  ctx: ServiceContext,
  nav: NavigationService,
): () => void {
  const selection = ctx.service<Selection>('selection');
  const disposers: Array<() => void> = [];

  const smaller = toolButton({
    label: 'Smaller thumbnails',
    icon: 'minus',
    id: 'thumbnails-smaller',
    onPress: () => void nav.run('view.thumbnails.smaller'),
  });
  const larger = toolButton({
    label: 'Larger thumbnails',
    icon: 'plus',
    id: 'thumbnails-larger',
    onPress: () => void nav.run('view.thumbnails.larger'),
  });
  const sizeLabel = el('span.nav-size', { 'aria-live': 'polite' });
  const bar = toolbar('Page thumbnails', smaller, larger, sizeLabel);

  const scroller = el('div.nav-scroll.thumb-scroll', {
    tabindex: '-1',
    'data-panel-scroll': 'pages',
  });
  const spacer = el('div.thumb-spacer', {
    role: 'listbox',
    'aria-label': 'Page thumbnails',
    'aria-multiselectable': 'true',
  });
  scroller.append(spacer);
  const empty = emptyMessage('No document is open.', 'file');
  host.append(bar, scroller, empty);

  /** Cells currently in the DOM, by page index. */
  const cells = new Map<number, HTMLElement>();
  let grid: GridMetrics = { columns: 1, rows: 0, rowHeight: 1, height: 0 };
  let anchor = 0;
  let pending = false;

  const size = (): number => nav.settings.thumbnailSize;

  const selectedPages = (): number[] => selection.as('pages')?.pages.slice() ?? [];

  const render = (): void => {
    const context = nav.context;
    const pageCount = context?.document.pageCount ?? 0;
    empty.hidden = pageCount > 0;
    scroller.hidden = pageCount === 0;
    bar.hidden = pageCount === 0;
    sizeLabel.textContent = `${String(size())} px`;
    smaller.disabled = !canStep(size(), -1);
    larger.disabled = !canStep(size(), 1);
    if (!context || pageCount === 0) {
      spacer.replaceChildren();
      cells.clear();
      return;
    }
    grid = metrics(pageCount, scroller.clientWidth || 240, size());
    spacer.style.height = `${String(grid.height)}px`;
    paint();
  };

  /** Builds, moves and drops the cells the viewport can see. */
  const paint = (): void => {
    const context = nav.context;
    if (!context) return;
    const pageCount = context.document.pageCount;
    const { first, last } = visibleRows(scroller.scrollTop, scroller.clientHeight, grid);
    const wanted = new Set<number>();
    const requests: ThumbnailRequest[] = [];
    const current = nav.currentPage;
    const selected = new Set(selectedPages());

    for (let row = first; row <= last; row++) {
      for (const page of pagesInRow(row, pageCount, grid.columns)) {
        wanted.add(page);
        const modelPage = context.document.state.pages[page];
        if (!modelPage) continue;
        const pageSize = context.document.pageSize(modelPage.id) ?? { width: 612, height: 792 };
        const box = thumbnailBox(pageSize, size());
        const cell = cells.get(page) ?? buildCell(page);
        cells.set(page, cell);
        const column = page % grid.columns;
        cell.style.left = `${String(GRID_PADDING + column * (size() + GRID_GAP) + Math.round((size() - box.width) / 2))}px`;
        cell.style.top = `${String(GRID_PADDING + row * grid.rowHeight)}px`;
        cell.style.width = `${String(box.width)}px`;
        const frame = cell.querySelector<HTMLElement>('.thumb-frame');
        const label = cell.querySelector<HTMLElement>('.thumb-label');
        if (frame) {
          frame.style.width = `${String(box.width)}px`;
          frame.style.height = `${String(box.height)}px`;
        }
        if (label) label.textContent = modelPage.label;
        const isCurrent = page === current;
        cell.classList.toggle('is-current', isCurrent);
        cell.classList.toggle('is-selected', selected.has(page));
        cell.setAttribute('aria-selected', String(selected.has(page)));
        if (isCurrent) cell.setAttribute('aria-current', 'page');
        else cell.removeAttribute('aria-current');
        // The word matters: "current" must not be carried by a colour alone.
        cell.title = isCurrent
          ? `Page ${modelPage.label} — current page`
          : `Go to page ${modelPage.label}`;
        cell.setAttribute(
          'aria-label',
          isCurrent ? `Page ${modelPage.label}, current page` : `Page ${modelPage.label}`,
        );

        const engineIndex = context.document.enginePage(modelPage.id);
        const request: ThumbnailRequest = {
          docKey: context.tab.id,
          doc: context.document.handle,
          page: engineIndex ?? page,
          pageId: modelPage.id,
          size: size(),
          pageWidth: pageSize.width,
          pageHeight: pageSize.height,
          dpr: window.devicePixelRatio || 1,
          priority: Math.abs(page - current),
        };
        const bitmap = nav.thumbnails.peek(request);
        if (bitmap) draw(cell, bitmap, box);
        else if (engineIndex !== undefined) requests.push(request);
      }
    }

    for (const [page, cell] of [...cells]) {
      if (wanted.has(page)) continue;
      cell.remove();
      cells.delete(page);
    }
    // Nearest to the current page first; a fast scroll replaces the list wholesale.
    nav.thumbnails.request(requests.sort((a, b) => a.priority - b.priority));
    const rows = [...cells.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => c);
    const active = rows.find((r) => r.classList.contains('is-current')) ?? rows[0] ?? null;
    for (const row of rows) row.tabIndex = row === active ? 0 : -1;
  };

  const draw = (
    cell: HTMLElement,
    bitmap: ImageBitmap,
    box: { width: number; height: number },
  ): void => {
    const canvas = cell.querySelector('canvas');
    if (!(canvas instanceof HTMLCanvasElement)) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(box.width * dpr));
    canvas.height = Math.max(1, Math.round(box.height * dpr));
    canvas.style.width = `${String(box.width)}px`;
    canvas.style.height = `${String(box.height)}px`;
    const context2d = canvas.getContext('2d');
    if (!context2d) return;
    context2d.clearRect(0, 0, canvas.width, canvas.height);
    context2d.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    cell.classList.add('is-rendered');
  };

  const buildCell = (page: number): HTMLElement => {
    const cell = el('div.thumb-cell', {
      role: 'option',
      'data-row': '',
      'data-page': String(page),
      tabindex: '-1',
    });
    const frame = el('div.thumb-frame', null, el('canvas', { 'aria-hidden': 'true' }));
    cell.append(frame, el('span.thumb-label'));
    cell.addEventListener('click', (event) => {
      choose(page, event);
    });
    cell.addEventListener('dblclick', () => {
      nav.goToPage(page);
    });
    spacer.append(cell);
    return cell;
  };

  /** Click behaviour: plain click navigates; Ctrl and Shift build the selection M40 will use. */
  const choose = (page: number, event: MouseEvent): void => {
    const current = selectedPages();
    if (event.shiftKey) {
      selection.set({ kind: 'pages', pages: rangeBetween(anchor, page) });
    } else if (event.ctrlKey || event.metaKey) {
      const next = current.includes(page)
        ? current.filter((p) => p !== page)
        : [...current, page].sort((a, b) => a - b);
      selection.set(next.length === 0 ? { kind: 'none' } : { kind: 'pages', pages: next });
      anchor = page;
    } else {
      selection.set({ kind: 'pages', pages: [page] });
      anchor = page;
      nav.goToPage(page);
    }
    paint();
  };

  /**
   * Ctrl+wheel steps the ladder through the same command the `+` and `−` buttons run, so there
   * is one path and the palette, the ribbon and the wheel cannot drift apart.
   */
  const step = (direction: 1 | -1): void => {
    if (!canStep(size(), direction)) return;
    void nav.run(direction > 0 ? 'view.thumbnails.larger' : 'view.thumbnails.smaller');
  };

  const keepCurrentInView = (): void => {
    const top = scrollToPage(nav.currentPage, scroller.scrollTop, scroller.clientHeight, grid);
    if (top !== null) {
      scroller.scrollTop = top;
      paint();
    }
  };

  // ---- events ------------------------------------------------------------------------------------

  const schedule = (): void => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      paint();
    });
  };

  scroller.addEventListener('scroll', schedule, { passive: true });
  scroller.addEventListener(
    'wheel',
    (event) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      step(event.deltaY < 0 ? 1 : -1);
    },
    { passive: false },
  );

  const resize = new ResizeObserver(() => {
    render();
  });
  resize.observe(scroller);
  disposers.push(() => {
    resize.disconnect();
  });

  disposers.push(
    installListKeys(spacer, {
      rows: () => [...cells.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => c),
      activate: (row) => {
        const page = Number(row.dataset['page'] ?? '0');
        selection.set({ kind: 'pages', pages: [page] });
        anchor = page;
        nav.goToPage(page);
      },
    }),
  );

  // Arrow keys move by column, not by row order, so they are handled here rather than by the
  // shared list keys — a grid is not a list.
  const onKeyDown = (event: KeyboardEvent): void => {
    const context = nav.context;
    if (!context) return;
    const keys = [
      'ArrowLeft',
      'ArrowRight',
      'ArrowUp',
      'ArrowDown',
      'Home',
      'End',
      'PageUp',
      'PageDown',
    ];
    if (!keys.includes(event.key)) return;
    const from = Number(
      (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-page]')?.dataset['page'] ??
        String(nav.currentPage),
    );
    const target = keyboardTarget(
      from,
      event.key as Parameters<typeof keyboardTarget>[1],
      context.document.pageCount,
      grid,
      scroller.clientHeight,
    );
    event.preventDefault();
    event.stopPropagation();
    if (target === from) return;
    const top = scrollToPage(target, scroller.scrollTop, scroller.clientHeight, grid);
    if (top !== null) scroller.scrollTop = top;
    paint();
    const cell = cells.get(target);
    if (cell) {
      cell.tabIndex = 0;
      cell.focus();
    }
    if (event.shiftKey) selection.set({ kind: 'pages', pages: rangeBetween(anchor, target) });
  };
  spacer.addEventListener('keydown', onKeyDown, true);
  disposers.push(() => {
    spacer.removeEventListener('keydown', onKeyDown, true);
  });

  // Right-click selects the page under the pointer *before* the shell's own handler opens the
  // menu, so an item acts on what was clicked rather than on whatever happened to be selected
  // (M40 fills this menu).
  const onContextMenu = (event: MouseEvent): void => {
    const cell = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-page]');
    if (!cell) return;
    const page = Number(cell.dataset['page'] ?? '0');
    if (!selectedPages().includes(page)) {
      selection.set({ kind: 'pages', pages: [page] });
      anchor = page;
      paint();
    }
  };
  spacer.addEventListener('contextmenu', onContextMenu);
  disposers.push(() => {
    spacer.removeEventListener('contextmenu', onContextMenu);
  });

  disposers.push(
    nav.thumbnails.onThumbnail((_id, request) => {
      if (request.docKey !== nav.context?.tab.id) return;
      schedule();
    }),
    nav.onSettingsChange(() => {
      // The pane resize arrives through the `ResizeObserver`, so the scroll correction has to
      // wait a frame or it measures the grid the panel is about to stop having.
      render();
      requestAnimationFrame(() => {
        render();
        keepCurrentInView();
      });
    }),
    selection.subscribe(() => {
      paint();
    }),
    nav.ui.select(
      (state) => state.view.page,
      () => {
        paint();
        keepCurrentInView();
      },
      { immediate: false },
    ),
    nav.watch(() => {
      render();
    }),
  );

  // The panel opens at exactly one column — the operator's rule — unless the reader has already
  // dragged the splitter themselves this session.
  nav.fitPaneToOneColumn();
  render();
  requestAnimationFrame(() => {
    render();
    keepCurrentInView();
  });

  return () => {
    for (const d of disposers.splice(0)) d();
    host.replaceChildren();
  };
}

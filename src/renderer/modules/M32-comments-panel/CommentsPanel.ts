/**
 * The Comments panel (M32) — the left pane's review list.
 *
 * It is a **virtualised** list: only the rows near the viewport have DOM, so a document with two
 * thousand comments in it scrolls as smoothly as one with ten. Row heights come from
 * `metrics.ts` rather than from measurement, and every row is positioned absolutely at its
 * computed offset, so a row that estimates a line short shows a line less of a comment and never
 * breaks the layout.
 *
 * Everything the panel does to the document goes through a registered command, so the palette,
 * a shortcut and the e2e suite all reach the same code, and every one of them is undoable.
 *
 * Accessibility: the list is one tab stop with roving focus, arrow keys move between rows, Enter
 * opens a comment and Space folds a thread; a status is always a word *and* an icon, never a
 * colour; and the filter popover is a real popup with a focus trap, fully opaque.
 */

import { append, button, clear, el } from '@app/dom';
import { icon } from '@app/icons';
import { openPopup } from '@app/popup';
import type { ModelId } from '@core/Ids';
import type { ServiceContext } from '@shared/module';
import {
  emptyMessage,
  formatDate,
  toolbar,
  toolButton,
} from '@modules/M12-navigation-panels/panelChrome';
import type { CommentsService } from './CommentsService';
import { heightOf, rowMetrics, visibleRange } from './metrics';
import type { CommentEntry } from './model';
import {
  ALL_COMMENTS,
  type CommentFilter,
  type CommentRow,
  type GroupBy,
  type RowResult,
  type SortBy,
} from './rows';
import { STATUSES, statusSpec, type StatusId } from './status';

const GROUPINGS: ReadonlyArray<{ id: GroupBy; label: string }> = [
  { id: 'none', label: 'Nothing' },
  { id: 'page', label: 'Page' },
  { id: 'author', label: 'Author' },
  { id: 'type', label: 'Type' },
  { id: 'date', label: 'Date' },
  { id: 'status', label: 'Status' },
];

const SORTS: ReadonlyArray<{ id: SortBy; label: string }> = [
  { id: 'page', label: 'Page' },
  { id: 'author', label: 'Author' },
  { id: 'date', label: 'Date' },
  { id: 'type', label: 'Type' },
  { id: 'status', label: 'Status' },
];

/** Text size the metrics assume; the stylesheet uses the same number. */
const FONT_SIZE = 12;

export function mountCommentsPanel(
  host: HTMLElement,
  _ctx: ServiceContext,
  comments: CommentsService,
): () => void {
  const disposers: Array<() => void> = [];
  let expanded: ModelId | null = null;
  /** The annotation selection as the panel last saw it, so it can tell a change from a repeat. */
  let seenSelection: ModelId | null = null;
  let result: RowResult = { rows: [], shown: 0, total: 0, authors: [], types: [] };

  // ---- chrome ---------------------------------------------------------------------------------

  const badge = el('span.comments-badge', { 'data-role': 'comment-count' }, '0');
  const searchInput = el('input.comments-search', {
    type: 'search',
    placeholder: 'Search comments',
    'aria-label': 'Search comments',
    'data-role': 'comment-search',
  });

  const filterButton = toolButton({
    label: 'Filter comments',
    icon: 'sliders-horizontal',
    id: 'comments-filter',
    onPress: () => {
      openFilter();
    },
  });
  const bar = toolbar(
    'Comments',
    toolButton({
      label: 'Reply to the selected comment',
      icon: 'message-square',
      id: 'comments-reply',
      onPress: () => void comments.shell.run('comments.reply'),
    }),
    toolButton({
      label: 'Set the status of the selected comment',
      icon: 'circle-check',
      id: 'comments-status',
      onPress: () => void comments.shell.run('comments.status'),
    }),
    toolButton({
      label: 'Delete the selected comment',
      icon: 'trash-2',
      id: 'comments-delete',
      onPress: () => void comments.shell.run('comments.delete'),
    }),
    filterButton,
    toolButton({
      label: 'Sort and group comments',
      icon: 'list',
      id: 'comments-arrange',
      onPress: () => {
        openArrange();
      },
    }),
    toolButton({
      label: 'Show or hide comments on the page',
      icon: 'eye',
      id: 'comments-visibility',
      onPress: () => {
        openVisibility();
      },
    }),
    toolButton({
      label: 'Import comments from an FDF or XFDF file',
      icon: 'upload',
      id: 'comments-import',
      onPress: () => void comments.shell.run('comments.import'),
    }),
    toolButton({
      label: 'Export comments to an FDF or XFDF file',
      icon: 'download',
      id: 'comments-export',
      onPress: () => void comments.shell.run('comments.export'),
    }),
    toolButton({
      label: 'Summarise comments into a new PDF',
      icon: 'file-text',
      id: 'comments-summarise',
      onPress: () => void comments.shell.run('comments.summarise'),
    }),
  );

  const searchRow = el(
    'div.comments-searchrow',
    null,
    icon('search', { fallbackText: '' }),
    searchInput,
    el('span.comments-count', { role: 'status' }, badge),
  );

  const scroller = el('div.nav-scroll.comments-scroll', { 'data-panel-scroll': 'comments' });
  const spacer = el('div.comments-spacer');
  const list = el('div.comments-list', { role: 'listbox', 'aria-label': 'Comments' });
  spacer.append(list);
  scroller.append(spacer);
  const empty = emptyMessage('This document has no comments.', 'message-square');
  // Named so the acceptance test can tell this empty state from the shell's own.
  empty.dataset['role'] = 'comment-empty';
  host.append(bar, searchRow, scroller, empty);

  // ---- rendering ------------------------------------------------------------------------------

  const usableWidth = (): number => Math.max(80, scroller.clientWidth - 44);

  const render = (): void => {
    result = comments.rows();
    const total = result.total;
    badge.textContent =
      comments.filtering && result.shown !== total
        ? `${String(result.shown)} of ${String(total)}`
        : String(total);
    badge.title =
      comments.filtering && result.shown !== total
        ? `${String(result.shown)} comments shown, ${String(total)} in the document`
        : `${String(total)} comments`;
    filterButton.setAttribute('aria-pressed', String(comments.filtering));
    // "No comments" and "nothing matches your filter" are different states and the reader has to
    // be able to tell — the same rule M12's panels follow.
    const label = empty.querySelector('span');
    if (label) {
      label.textContent =
        total === 0 ? 'This document has no comments.' : 'No comment matches the filter.';
    }
    empty.hidden = result.shown > 0;
    scroller.hidden = result.shown === 0;
    paint();
  };

  const paint = (): void => {
    /*
     * A repaint throws every row away and builds it again, which takes the focused element with
     * it — and focus falling back to the body means the next arrow key reaches nobody. So the
     * list remembers whether it held focus and puts it back on the row that now stands for the
     * same place. Only when the *list* had it: a repaint while the reader is typing in the
     * search field must not pull focus out of the field.
     */
    const hadFocus = list.contains(document.activeElement);
    const metrics = rowMetrics(result.rows, {
      width: usableWidth(),
      fontSize: FONT_SIZE,
      expanded,
    });
    spacer.style.height = `${String(Math.max(0, metrics.total))}px`;
    const range = visibleRange(scroller.scrollTop, scroller.clientHeight || 400, metrics);
    clear(list);
    for (let i = range.first; i <= range.last; i++) {
      const row = result.rows[i];
      if (!row) continue;
      const element = renderRow(row);
      element.style.top = `${String(metrics.offsets[i] ?? 0)}px`;
      element.style.height = `${String(metrics.heights[i] ?? heightOf(row, { width: usableWidth(), fontSize: FONT_SIZE, expanded }))}px`;
      list.append(element);
    }
    setRoving();
    if (hadFocus) tabbableRow()?.focus();
  };

  /** The one row that is a tab stop; the list is a single stop with roving focus inside it. */
  const tabbableRow = (): HTMLElement | null =>
    list.querySelector<HTMLElement>('[data-row][tabindex="0"]');

  const setRoving = (): void => {
    const rows = Array.from(list.querySelectorAll<HTMLElement>('[data-row]'));
    const selected = rows.find((r) => r.dataset['id'] === expanded);
    for (const row of rows) row.tabIndex = row === (selected ?? rows[0]) ? 0 : -1;
  };

  function renderRow(row: CommentRow): HTMLElement {
    if (row.kind === 'group') return renderGroup(row);
    return renderComment(row);
  }

  function renderGroup(row: Extract<CommentRow, { kind: 'group' }>): HTMLElement {
    const element = el('div.comments-group', {
      'data-row': 'group',
      'data-id': row.id,
      role: 'option',
      'aria-selected': 'false',
      'aria-expanded': String(!row.collapsed),
    });
    const twisty = icon(row.collapsed ? 'chevron-right' : 'chevron-down', { fallbackText: '' });
    append(
      element,
      twisty,
      el('span.comments-group-label', null, row.label),
      el('span.comments-group-count', null, String(row.count)),
    );
    element.addEventListener('click', () => {
      comments.toggleGroup(row.id);
    });
    return element;
  }

  function renderComment(
    row: Extract<CommentRow, { kind: 'comment' } | { kind: 'reply' }>,
  ): HTMLElement {
    const entry = row.entry;
    const isReply = row.kind === 'reply';
    const selected = expanded === row.id;
    const element = el('div.comments-row', {
      'data-row': isReply ? 'reply' : 'comment',
      'data-id': row.id,
      'data-kind': isReply ? 'reply' : 'comment',
      role: 'option',
      'aria-selected': String(selected),
      ...(selected ? { 'data-selected': 'true' } : {}),
    });
    if (isReply) element.classList.add('is-reply');
    if (selected) element.classList.add('is-selected');

    const head = el('div.comments-head');
    if (!isReply) {
      const fold = button(
        'comments-twisty',
        {
          title: row.kind === 'comment' && row.folded ? 'Show replies' : 'Hide replies',
          'aria-label': row.kind === 'comment' && row.folded ? 'Show replies' : 'Hide replies',
          'aria-expanded': String(!(row.kind === 'comment' && row.folded)),
          tabindex: -1,
        },
        icon(row.kind === 'comment' && row.folded ? 'chevron-right' : 'chevron-down', {
          fallbackText: '',
        }),
      );
      if (row.kind === 'comment' && row.replyCount === 0) fold.classList.add('is-empty');
      fold.addEventListener('click', (event) => {
        event.stopPropagation();
        comments.toggleFold(row.id);
      });
      head.append(fold);
    } else {
      head.append(el('span.comments-twisty-space'));
    }

    head.append(
      icon(iconForType(entry.type), { fallbackText: entry.type }),
      el('span.comments-author', null, entry.author),
      el('span.comments-date', null, formatDate(entry.created ?? entry.modified)),
    );
    if (!isReply) {
      head.append(el('span.comments-page', null, `p. ${String(entry.page + 1)}`));
    }
    element.append(head);

    const meta = el('div.comments-meta');
    if (!isReply) {
      meta.append(el('span.comments-type', null, entry.type));
      meta.append(statusChip(entry));
      if (entry.checked) {
        meta.append(
          el(
            'span.comments-check',
            { title: 'Checked' },
            icon('check', { fallbackText: '' }),
            el('span', null, 'Checked'),
          ),
        );
      }
      if (row.kind === 'comment' && row.replyCount > 0) {
        meta.append(
          el(
            'span.comments-replies',
            null,
            `${String(row.replyCount)} ${row.replyCount === 1 ? 'reply' : 'replies'}`,
          ),
        );
      }
    } else if (entry.setsStatus !== null && entry.isStatusOnly) {
      meta.append(el('span.comments-type', null, `Set to ${statusSpec(entry.setsStatus).label}`));
    }
    element.append(meta);

    if (entry.text !== '') {
      const text = el('p.comments-text');
      appendMatched(text, entry.text, row.match);
      element.append(text);
    }

    if (selected && !isReply) element.append(replyBox(row.id));

    element.addEventListener('click', () => {
      choose(row.id);
    });
    element.addEventListener('dblclick', () => {
      comments.annotations.openPopup(row.id);
    });
    return element;
  }

  function statusChip(entry: CommentEntry): HTMLElement {
    const spec = statusSpec(entry.status);
    const chip = el(
      'span.comments-status',
      {
        'data-status': entry.status,
        title:
          entry.status === 'none'
            ? 'No status set'
            : `${spec.label}${entry.statusBy === null ? '' : ` by ${entry.statusBy}`}`,
      },
      icon(spec.icon, { fallbackText: spec.label }),
      // The word is always there: a status is never told apart by colour or glyph alone.
      el('span', null, spec.label),
    );
    return chip;
  }

  /** The inline reply editor under the selected comment. */
  function replyBox(id: ModelId): HTMLElement {
    const input = el('input.comments-replyinput', {
      type: 'text',
      placeholder: 'Write a reply',
      'aria-label': 'Write a reply',
      'data-role': 'comment-reply-input',
    });
    const send = button(
      'comments-replysend',
      { title: 'Add the reply', 'aria-label': 'Add the reply' },
      icon('plus', { fallbackText: 'Reply' }),
      el('span', null, 'Reply'),
    );
    const commit = (): void => {
      const text = input.value.trim();
      if (text === '') return;
      input.value = '';
      void comments.reply(id, text);
    };
    send.addEventListener('click', (event) => {
      event.stopPropagation();
      commit();
    });
    input.addEventListener('click', (event) => {
      event.stopPropagation();
    });
    input.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.key === 'Enter') {
        event.preventDefault();
        commit();
      }
    });
    const box = el('div.comments-replybox', null, input, send);
    return box;
  }

  /**
   * Picks a row. Only ever called from a click or a key inside the list, so it takes focus with
   * it — which is what makes clicking a comment and then pressing an arrow key work.
   *
   * The panel stays authoritative about its own row. A reply is a hidden annotation, so the page
   * cannot select it and the annotation selection stays on the comment above; the listener at the
   * bottom therefore adopts the annotation selection only when it *changes*, and `seenSelection`
   * is how it tells a change from the same value arriving again. Without that, every repaint
   * after a reply was chosen would snap the row back and the arrow keys would do nothing.
   */
  function choose(id: ModelId): void {
    expanded = id;
    comments.select(id);
    seenSelection = comments.annotations.selection[0] ?? null;
    expanded = id;
    paint();
    tabbableRow()?.focus();
  }

  // ---- popovers -------------------------------------------------------------------------------

  function openArrange(): void {
    const body = el('div.comments-popover');
    body.append(el('h3.comments-popover-title', null, 'Group by'));
    for (const group of GROUPINGS) {
      body.append(
        choice(group.label, comments.settings.group === group.id, () => {
          void comments.setGrouping(group.id);
        }),
      );
    }
    body.append(el('h3.comments-popover-title', null, 'Sort by'));
    for (const sort of SORTS) {
      body.append(
        choice(sort.label, comments.settings.sort === sort.id, () => {
          void comments.setSort(sort.id);
        }),
      );
    }
    body.append(
      choice('Newest first', comments.settings.direction === 'desc', () => {
        void comments.setSort(
          comments.settings.sort,
          comments.settings.direction === 'desc' ? 'asc' : 'desc',
        );
      }),
    );
    body.append(el('h3.comments-popover-title', null, 'Replies'));
    body.append(
      choice('Show replies', comments.settings.showReplies, () => {
        void comments.setSetting('showReplies', !comments.settings.showReplies);
      }),
    );
    popover(body, 'comments-arrange');
  }

  function openVisibility(): void {
    const body = el('div.comments-popover');
    body.append(el('h3.comments-popover-title', null, 'On the page'));
    body.append(
      choice('Show all comments', comments.everythingVisible, () => {
        comments.showAll();
      }),
    );
    body.append(
      choice('Hide all comments', !comments.visibility.all, () => {
        comments.hideAll();
      }),
    );
    body.append(el('h3.comments-popover-title', null, 'By type'));
    for (const type of result.types) {
      body.append(
        choice(type, !comments.visibility.hiddenTypes.has(type), () => {
          comments.toggleType(type);
        }),
      );
    }
    body.append(el('h3.comments-popover-title', null, 'By author'));
    for (const author of result.authors) {
      body.append(
        choice(author, !comments.visibility.hiddenAuthors.has(author), () => {
          comments.toggleAuthor(author);
        }),
      );
    }
    popover(body, 'comments-visibility');
  }

  function openFilter(): void {
    const draft: {
      authors: Set<string> | null;
      types: Set<string> | null;
      statuses: Set<StatusId> | null;
      checked: CommentFilter['checked'];
      from: string | null;
      to: string | null;
    } = {
      authors: comments.filter.authors ? new Set(comments.filter.authors) : null,
      types: comments.filter.types ? new Set(comments.filter.types) : null,
      statuses: comments.filter.statuses ? new Set(comments.filter.statuses) : null,
      checked: comments.filter.checked,
      from: comments.filter.from,
      to: comments.filter.to,
    };
    const apply = (): void => {
      comments.setFilter({
        authors: draft.authors,
        types: draft.types,
        statuses: draft.statuses,
        checked: draft.checked,
        from: draft.from,
        to: draft.to,
      });
    };
    const toggleIn = <T>(set: Set<T> | null, all: ReadonlyArray<T>, value: T): Set<T> | null => {
      const current = set ?? new Set(all);
      if (current.has(value)) current.delete(value);
      else current.add(value);
      return current.size === all.length ? null : current;
    };

    const body = el('div.comments-popover');
    body.append(el('h3.comments-popover-title', null, 'Author'));
    for (const author of result.authors) {
      body.append(
        choice(author, draft.authors === null || draft.authors.has(author), () => {
          draft.authors = toggleIn(draft.authors, result.authors, author);
          apply();
        }),
      );
    }
    body.append(el('h3.comments-popover-title', null, 'Type'));
    for (const type of result.types) {
      body.append(
        choice(type, draft.types === null || draft.types.has(type), () => {
          draft.types = toggleIn(draft.types, result.types, type);
          apply();
        }),
      );
    }
    body.append(el('h3.comments-popover-title', null, 'Status'));
    const statusIds = STATUSES.map((s) => s.id);
    for (const spec of STATUSES) {
      body.append(
        choice(spec.label, draft.statuses === null || draft.statuses.has(spec.id), () => {
          draft.statuses = toggleIn(draft.statuses, statusIds, spec.id);
          apply();
        }),
      );
    }
    body.append(el('h3.comments-popover-title', null, 'Checkmark'));
    for (const [value, label] of [
      ['all', 'Any'],
      ['checked', 'Checked'],
      ['unchecked', 'Not checked'],
    ] as const) {
      body.append(
        choice(label, draft.checked === value, () => {
          draft.checked = value;
          apply();
        }),
      );
    }

    body.append(el('h3.comments-popover-title', null, 'Date'));
    const from = el('input', {
      type: 'date',
      'aria-label': 'Comments from this date',
      value: draft.from ?? '',
    });
    const to = el('input', {
      type: 'date',
      'aria-label': 'Comments up to this date',
      value: draft.to ?? '',
    });
    from.addEventListener('change', () => {
      draft.from = from.value === '' ? null : from.value;
      apply();
    });
    to.addEventListener('change', () => {
      draft.to = to.value === '' ? null : to.value;
      apply();
    });
    body.append(el('div.comments-daterow', null, from, el('span', null, 'to'), to));

    const reset = button(
      'comments-reset',
      { 'data-action': 'comments-filter-reset' },
      'Show every comment',
    );
    reset.addEventListener('click', () => {
      comments.setFilter(ALL_COMMENTS);
    });
    body.append(reset);
    popover(body, 'comments-filter');
  }

  function choice(label: string, on: boolean, onPress: () => void): HTMLElement {
    const item = button(
      'comments-choice',
      { role: 'menuitemcheckbox', 'aria-checked': String(on) },
      icon(on ? 'check' : 'square-dashed', { fallbackText: on ? 'on' : 'off' }),
      el('span', null, label),
    );
    item.addEventListener('click', () => {
      onPress();
      const nowOn = item.getAttribute('aria-checked') !== 'true';
      item.setAttribute('aria-checked', String(nowOn));
      const glyph = item.querySelector('svg');
      glyph?.replaceWith(icon(nowOn ? 'check' : 'square-dashed', { fallbackText: '' }));
    });
    return item;
  }

  function popover(body: HTMLElement, anchorAction: string): void {
    const anchor = bar.querySelector<HTMLElement>(`[data-action="${anchorAction}"]`) ?? bar;
    openPopup({ anchor, content: body, className: 'comments-popup', role: 'menu' });
  }

  // ---- keyboard -------------------------------------------------------------------------------

  /**
   * The list's keys are handled on the panel's host rather than on the list element, because the
   * list's children are rebuilt on every repaint and a handler bound further in loses the events
   * the moment a row is replaced. The host outlives every repaint; the guard below keeps the
   * search field's own arrow keys, and the toolbar's, out of it.
   */
  const onKeyDown = (event: KeyboardEvent): void => {
    const w = window as unknown as Record<string, unknown>;
    ((w['__log'] as unknown[]) ??= []).push({
      k: event.key,
      cls: (event.target as HTMLElement | null)?.className ?? null,
      live: comments.rows().rows.length,
      exp: expanded,
    });
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    if (target.closest('input, textarea, select, [contenteditable="true"]')) return;
    // Read the list as it stands rather than from a captured copy: a repaint may have replaced
    // both the rows and the array behind them between the last render and this key.
    const rows = comments.rows().rows;
    if (rows.length === 0) return;
    const current =
      expanded ??
      list.querySelector<HTMLElement>('.comments-row.is-selected')?.dataset['id'] ??
      null;
    const at = rows.findIndex((row) => row.id === current);
    const move = (delta: number): void => {
      const next = rows[Math.min(rows.length - 1, Math.max(0, at + delta))];
      if (!next) return;
      if (next.kind === 'group') {
        const after = rows[Math.min(rows.length - 1, Math.max(0, at + delta * 2))];
        if (after && after.kind !== 'group') {
          choose(after.id);
          scrollTo(rows.indexOf(after));
          return;
        }
      }
      if (next.kind === 'group') return;
      choose(next.id);
      scrollTo(rows.indexOf(next));
    };
    switch (event.key) {
      case 'ArrowDown':
        move(1);
        break;
      case 'ArrowUp':
        move(-1);
        break;
      case 'Home': {
        const first = rows.find((row) => row.kind !== 'group');
        if (first) {
          choose(first.id);
          scrollTo(rows.indexOf(first));
        }
        break;
      }
      case 'End': {
        const last = [...rows].reverse().find((row) => row.kind !== 'group');
        if (last) {
          choose(last.id);
          scrollTo(rows.indexOf(last));
        }
        break;
      }
      case 'Enter':
        if (expanded) comments.annotations.openPopup(expanded);
        break;
      case ' ':
        if (expanded) comments.toggleFold(expanded);
        break;
      case 'Delete':
        if (expanded) void comments.shell.run('comments.delete');
        break;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
  };

  const scrollTo = (index: number): void => {
    const metrics = rowMetrics(result.rows, {
      width: usableWidth(),
      fontSize: FONT_SIZE,
      expanded,
    });
    const top = metrics.offsets[index] ?? 0;
    const height = metrics.heights[index] ?? 0;
    if (top < scroller.scrollTop) scroller.scrollTop = top;
    else if (top + height > scroller.scrollTop + scroller.clientHeight) {
      scroller.scrollTop = top + height - scroller.clientHeight;
    }
    paint();
  };

  // ---- wiring ---------------------------------------------------------------------------------

  const onScroll = (): void => {
    paint();
  };
  scroller.addEventListener('scroll', onScroll, { passive: true });
  list.addEventListener('keydown', onKeyDown);
  searchInput.addEventListener('input', () => {
    comments.setSearch(searchInput.value);
  });
  searchInput.addEventListener('keydown', (event) => {
    event.stopPropagation();
    if (event.key === 'Escape') {
      searchInput.value = '';
      comments.setSearch('');
    }
  });

  const observer =
    typeof ResizeObserver === 'function'
      ? new ResizeObserver(() => {
          paint();
        })
      : null;
  observer?.observe(scroller);

  disposers.push(
    comments.subscribe(() => {
      // A selection made on the page rather than in the panel moves the panel's row too — but
      // only when it actually changes, never when the same value arrives again (see `choose`).
      const selected = comments.annotations.selection[0] ?? null;
      if (selected !== seenSelection) {
        seenSelection = selected;
        if (selected !== null) expanded = selected;
      }
      render();
    }),
  );
  void comments.loadAll();
  render();

  return () => {
    observer?.disconnect();
    scroller.removeEventListener('scroll', onScroll);
    list.removeEventListener('keydown', onKeyDown);
    for (const dispose of disposers.splice(0)) dispose();
    host.replaceChildren();
  };
}

/** Wraps the matched part of a comment's text in a `<mark>`, leaving the rest as text. */
function appendMatched(
  host: HTMLElement,
  text: string,
  match: readonly [number, number] | null,
): void {
  if (!match) {
    host.textContent = text;
    return;
  }
  const [from, to] = match;
  append(
    host,
    text.slice(0, from),
    el('mark.comments-match', null, text.slice(from, to)),
    text.slice(to),
  );
}

/** A Lucide name for a comment type. Generic conventions only — a highlighter, a pen, a stamp. */
export function iconForType(type: string): string {
  switch (type) {
    case 'Highlight':
    case 'Area highlight':
      return 'highlighter';
    case 'Underline':
    case 'Squiggly':
      return 'baseline';
    case 'Strikeout':
    case 'Replaced text':
      return 'minus';
    case 'Sticky note':
      return 'message-square';
    case 'Text box':
    case 'Typewriter':
      return 'type';
    case 'Callout':
      return 'message-square';
    case 'Inserted text':
      return 'text-cursor-input';
    case 'Rectangle':
      return 'square';
    case 'Oval':
      return 'circle';
    case 'Line':
      return 'minus';
    case 'Arrow':
      return 'move-up-right';
    case 'Polygon':
    case 'Cloud':
      return 'pentagon';
    case 'Polyline':
      return 'spline';
    case 'Pencil':
      return 'pencil';
    case 'Stamp':
      return 'stamp';
    case 'Attachment':
      return 'paperclip';
    default:
      return 'message-square';
  }
}

/** Exported for the tests: the label a screen reader hears for a row. */
export function rowLabel(row: CommentRow): string {
  if (row.kind === 'group') return `${row.label}, ${String(row.count)} comments`;
  const entry = row.entry;
  const status = statusSpec(entry.status).label;
  return `${entry.type} by ${entry.author}, page ${String(entry.page + 1)}, ${status}`;
}

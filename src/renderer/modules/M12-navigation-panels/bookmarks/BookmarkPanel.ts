/**
 * The Bookmarks panel (M12): the outline as an editable tree.
 *
 * Reading it is a `role="tree"` with the usual keys — arrows to move, left/right to collapse and
 * expand, Enter to go. Editing it is nine commands, every one undoable, and the tree shape work
 * itself lives in `tree.ts` where it can be tested without a DOM.
 *
 * Expansion is **view state, not a document change**: `/Count`'s sign says whether a bookmark is
 * open in the file, but opening one while reading must not make the document dirty. The panel
 * starts from what the file said and keeps its own set from there.
 */

import { button, el } from '@app/dom';
import { icon } from '@app/icons';
import type { ModelId } from '@core/Ids';
import type { ModelOutlineItem } from '@core/model';
import type { ServiceContext } from '@shared/module';
import { emptyMessage, installListKeys, toolButton, toolbar } from '../panelChrome';
import type { NavigationService } from '../NavigationService';
import { MoveBookmarkCommand, RenameBookmarkCommand } from '../commands';
import { positionOf, walk } from './tree';

/** Mounts the Bookmarks panel. */
export function mountBookmarkPanel(
  host: HTMLElement,
  _ctx: ServiceContext,
  nav: NavigationService,
): () => void {
  const disposers: Array<() => void> = [];
  /** Ids the reader has opened. Seeded from the file, never written back to it. */
  const expanded = new Set<string>();
  let seededFor: string | null = null;
  let selected: ModelId | null = null;
  let editing: ModelId | null = null;

  const bar = toolbar(
    'Bookmarks',
    toolButton({
      label: 'Add bookmark from this view',
      icon: 'bookmark',
      id: 'bookmark-add',
      onPress: () => void nav.run('bookmarks.add'),
    }),
    toolButton({
      label: 'Rename bookmark',
      icon: 'square-pen',
      id: 'bookmark-rename',
      onPress: () => {
        if (selected) startEditing(selected);
      },
    }),
    toolButton({
      label: 'Delete bookmark',
      icon: 'trash-2',
      id: 'bookmark-delete',
      onPress: () => void nav.run('bookmarks.delete'),
    }),
    toolButton({
      label: 'Move bookmark right (nest it under the one above)',
      icon: 'chevron-right',
      id: 'bookmark-indent',
      onPress: () => void nav.run('bookmarks.indent'),
    }),
    toolButton({
      label: 'Move bookmark left',
      icon: 'chevron-left',
      id: 'bookmark-outdent',
      onPress: () => void nav.run('bookmarks.outdent'),
    }),
    toolButton({
      label: 'Expand all bookmarks',
      icon: 'list-tree',
      id: 'bookmark-expand',
      onPress: () => {
        for (const row of walk(outline())) expanded.add(row.item.id);
        render();
      },
    }),
    toolButton({
      label: 'Collapse all bookmarks',
      icon: 'chevrons-left',
      id: 'bookmark-collapse',
      onPress: () => {
        expanded.clear();
        render();
      },
    }),
  );

  const scroller = el('div.nav-scroll', { 'data-panel-scroll': 'bookmarks' });
  const tree = el('div.nav-tree', { role: 'tree', 'aria-label': 'Bookmarks' });
  scroller.append(tree);
  const empty = emptyMessage('This document has no bookmarks.', 'bookmark');
  host.append(bar, scroller, empty);

  const outline = (): ReadonlyArray<ModelOutlineItem> => nav.context?.document.state.outline ?? [];

  /** Seeds the open set from the file's own `open` flags, once per document. */
  const seed = (): void => {
    const context = nav.context;
    if (!context || seededFor === context.tab.id) return;
    seededFor = context.tab.id;
    expanded.clear();
    const level = nav.settings.expandBookmarksToLevel;
    for (const row of walk(outline())) {
      if (row.item.open || row.depth < level) expanded.add(row.item.id);
    }
  };

  /**
   * Opens whatever is hiding the selected bookmark. Indenting one nests it under a neighbour
   * that may well be collapsed, and a bookmark that vanishes when you move it is a bookmark you
   * have lost.
   */
  const revealSelected = (): void => {
    if (selected === null) return;
    const list = outline();
    let parentId = list.find((o) => o.id === selected)?.parentId ?? null;
    for (let guard = 0; parentId !== null && guard < 64; guard++) {
      expanded.add(parentId);
      parentId = list.find((o) => o.id === parentId)?.parentId ?? null;
    }
  };

  const rowsInView = (): Array<{ item: ModelOutlineItem; depth: number }> => {
    revealSelected();
    const all = walk(outline());
    const out: Array<{ item: ModelOutlineItem; depth: number }> = [];
    let hiddenBelow: number | null = null;
    for (const row of all) {
      if (hiddenBelow !== null && row.depth > hiddenBelow) continue;
      hiddenBelow = null;
      out.push(row);
      if (row.item.childIds.length > 0 && !expanded.has(row.item.id)) hiddenBelow = row.depth;
    }
    return out;
  };

  const render = (): void => {
    const context = nav.context;
    seed();
    // The commands act on the service's selection, and so does the panel.
    if (nav.selectedBookmark !== null) selected = nav.selectedBookmark;
    const rows = context ? rowsInView() : [];
    empty.hidden = rows.length > 0;
    if (!context) empty.textContent = '';
    empty.hidden = rows.length > 0;
    scroller.hidden = rows.length === 0;
    bar.hidden = context === null;
    tree.replaceChildren();
    tree.classList.toggle('is-wrapped', nav.settings.wrapBookmarkTitles);

    const current = nav.currentPage;
    let currentRow: HTMLElement | null = null;
    for (const { item, depth } of rows) {
      const row = el('div.nav-row', {
        role: 'treeitem',
        'data-row': '',
        'data-id': item.id,
        'aria-level': String(depth + 1),
        tabindex: '-1',
        draggable: 'true',
      });
      row.style.paddingLeft = `${String(6 + depth * 14)}px`;
      if (item.childIds.length > 0) {
        row.setAttribute('aria-expanded', String(expanded.has(item.id)));
        const twisty = button(
          'nav-twisty',
          {
            tabindex: '-1',
            'aria-label': expanded.has(item.id) ? 'Collapse' : 'Expand',
            title: expanded.has(item.id) ? 'Collapse' : 'Expand',
          },
          icon(expanded.has(item.id) ? 'chevron-down' : 'chevron-right'),
        );
        twisty.addEventListener('click', (event) => {
          event.stopPropagation();
          toggle(item.id);
        });
        row.append(twisty);
      } else {
        row.append(el('span.nav-twisty-space', { 'aria-hidden': 'true' }));
      }

      const title = el('span.nav-title', null, item.title || '(untitled)');
      if (item.bold) title.classList.add('is-bold');
      if (item.italic) title.classList.add('is-italic');
      if (item.color !== null) {
        // A bookmark's colour is the file's, not the theme's: it is document content, and the
        // title stays legible because the panel never relies on it to mean anything.
        title.style.color = `#${item.color.toString(16).padStart(6, '0')}`;
      }
      row.append(title);
      if (item.uri !== null) {
        row.append(el('span.nav-badge', { title: `Opens ${item.uri}` }, 'Link'));
      }
      const dest =
        item.destinationId === null ? null : context?.document.destination(item.destinationId);
      const pageLabel =
        dest?.pageId != null ? (context?.document.pageById(dest.pageId)?.label ?? null) : null;
      if (pageLabel !== null) row.append(el('span.nav-page', null, pageLabel));
      row.title = item.uri !== null ? `${item.title} — opens ${item.uri}` : item.title;

      if (item.id === selected) row.classList.add('is-selected');
      row.setAttribute('aria-selected', String(item.id === selected));
      if (
        nav.settings.highlightCurrentBookmark &&
        dest?.pageId != null &&
        context?.document.pageIndex(dest.pageId) === current
      ) {
        row.classList.add('is-current');
        row.setAttribute('aria-current', 'true');
        currentRow = row;
      }

      row.addEventListener('click', () => {
        select(item.id);
        activate(item.id);
      });
      row.addEventListener('dblclick', () => {
        startEditing(item.id);
      });
      installDrag(row, item.id);
      tree.append(row);
    }

    const rowEls = [...tree.querySelectorAll<HTMLElement>('[data-row]')];
    const active =
      rowEls.find((r) => r.dataset['id'] === selected) ?? currentRow ?? rowEls[0] ?? null;
    for (const row of rowEls) row.tabIndex = row === active ? 0 : -1;
    if (editing !== null) startEditing(editing, true);
  };

  const toggle = (id: ModelId): void => {
    if (expanded.has(id)) expanded.delete(id);
    else expanded.add(id);
    render();
  };

  const select = (id: ModelId | null): void => {
    selected = id;
    nav.selectedBookmark = id;
    render();
  };

  /** Click on a bookmark: go where it points, or open its URI through the shell. */
  const activate = (id: ModelId): void => {
    const context = nav.context;
    const item = context?.document.outlineItem(id);
    if (!context || !item) return;
    if (item.destinationId !== null) {
      const dest = context.document.destination(item.destinationId);
      if (dest) nav.goToDestination(dest);
      return;
    }
    if (item.uri !== null) void nav.openUri(item.uri);
  };

  /** Inline rename: an input in place of the title, Enter commits, Escape cancels. */
  const startEditing = (id: ModelId, restore = false): void => {
    const row = tree.querySelector<HTMLElement>(`[data-id="${CSS.escape(id)}"]`);
    const context = nav.context;
    const item = context?.document.outlineItem(id);
    if (!row || !context || !item) return;
    editing = id;
    const title = row.querySelector('.nav-title');
    if (!title) return;
    const input = el('input.nav-edit', {
      type: 'text',
      value: item.title,
      'aria-label': 'Bookmark title',
    });
    input.value = item.title;
    title.replaceWith(input);
    if (!restore) {
      input.focus();
      input.select();
    }
    const commit = (): void => {
      const value = input.value.trim();
      editing = null;
      if (value !== '' && value !== item.title) {
        void context.document
          .apply(new RenameBookmarkCommand(context.document, id, value))
          .then(() => {
            context.document.breakMerge();
          });
      } else {
        render();
      }
    };
    input.addEventListener('blur', commit);
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        input.blur();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        editing = null;
        input.removeEventListener('blur', commit);
        render();
      }
      event.stopPropagation();
    });
  };

  // ---- drag to reorder ----------------------------------------------------------------------------

  let dragging: ModelId | null = null;

  const installDrag = (row: HTMLElement, id: ModelId): void => {
    row.addEventListener('dragstart', (event) => {
      dragging = id;
      event.dataTransfer?.setData('text/plain', id);
      if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
    });
    row.addEventListener('dragend', () => {
      dragging = null;
      for (const other of tree.querySelectorAll('.is-drop-before, .is-drop-into, .is-drop-after')) {
        other.classList.remove('is-drop-before', 'is-drop-into', 'is-drop-after');
      }
    });
    row.addEventListener('dragover', (event) => {
      if (dragging === null || dragging === id) return;
      event.preventDefault();
      const where = dropZone(row, event);
      row.classList.toggle('is-drop-before', where === 'before');
      row.classList.toggle('is-drop-into', where === 'into');
      row.classList.toggle('is-drop-after', where === 'after');
    });
    row.addEventListener('dragleave', () => {
      row.classList.remove('is-drop-before', 'is-drop-into', 'is-drop-after');
    });
    row.addEventListener('drop', (event) => {
      event.preventDefault();
      const moved = dragging;
      dragging = null;
      if (moved === null || moved === id) return;
      void drop(moved, id, dropZone(row, event));
    });
  };

  /** Top third: before. Bottom third: after. Middle: a child of the row (Foxit's behaviour). */
  const dropZone = (row: HTMLElement, event: DragEvent): 'before' | 'into' | 'after' => {
    const box = row.getBoundingClientRect();
    const offset = (event.clientY - box.top) / Math.max(1, box.height);
    if (offset < 0.3) return 'before';
    if (offset > 0.7) return 'after';
    return 'into';
  };

  const drop = async (
    moved: ModelId,
    target: ModelId,
    where: 'before' | 'into' | 'after',
  ): Promise<void> => {
    const context = nav.context;
    if (!context) return;
    const list = context.document.state.outline;
    const at = positionOf(list, target);
    if (!at) return;
    const to =
      where === 'into'
        ? { parentId: target, index: 0 }
        : { parentId: at.parentId, index: at.index + (where === 'after' ? 1 : 0) };
    if (where === 'into') expanded.add(target);
    await context.document.apply(new MoveBookmarkCommand(context.document, moved, to));
  };

  // ---- keys and subscriptions ----------------------------------------------------------------------

  disposers.push(
    installListKeys(tree, {
      rows: () => [...tree.querySelectorAll<HTMLElement>('[data-row]')],
      activate: (row) => {
        const id = row.dataset['id'] as ModelId | undefined;
        if (id === undefined) return;
        select(id);
        activate(id);
      },
      focus: (row) => {
        const id = row.dataset['id'] as ModelId | undefined;
        if (id !== undefined) {
          selected = id;
          nav.selectedBookmark = id;
        }
      },
      collapse: (row) => {
        const id = row.dataset['id'] as ModelId | undefined;
        if (id === undefined) return false;
        if (expanded.has(id)) {
          expanded.delete(id);
          render();
          return true;
        }
        return false;
      },
      expand: (row) => {
        const id = row.dataset['id'] as ModelId | undefined;
        if (id === undefined) return false;
        const item = nav.context?.document.outlineItem(id);
        if (item && item.childIds.length > 0 && !expanded.has(id)) {
          expanded.add(id);
          render();
          return true;
        }
        return false;
      },
    }),
    nav.onSettingsChange(() => {
      render();
    }),
    nav.watch(
      () => {
        render();
      },
      { view: true },
    ),
  );

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'F2' || selected === null) return;
    event.preventDefault();
    startEditing(selected);
  };
  tree.addEventListener('keydown', onKeyDown);
  disposers.push(() => {
    tree.removeEventListener('keydown', onKeyDown);
  });

  render();
  return () => {
    for (const d of disposers.splice(0)) d();
    host.replaceChildren();
  };
}

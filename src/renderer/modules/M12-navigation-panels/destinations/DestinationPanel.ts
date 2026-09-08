/**
 * The Destinations panel (M12): the catalogue's named destinations.
 *
 * A named destination is a stable anchor other documents and links point at, so the panel is
 * mostly about keeping the names honest: click to go, rename in place, re-aim at the current
 * view, delete, and create one from where the reader is now — each an undoable `Command`.
 *
 * Unnamed destinations are not listed: they belong to a bookmark or a link and are shown there.
 */

import { el } from '@app/dom';
import type { ModelId } from '@core/Ids';
import type { ModelDestination } from '@core/model';
import type { ServiceContext } from '@shared/module';
import { emptyMessage, installListKeys, toolButton, toolbar } from '../panelChrome';
import type { NavigationService } from '../NavigationService';
import { RenameDestinationCommand } from '../commands';
import { describeDestination } from './navigate';

export function mountDestinationPanel(
  host: HTMLElement,
  _ctx: ServiceContext,
  nav: NavigationService,
): () => void {
  const disposers: Array<() => void> = [];
  let selected: ModelId | null = null;
  let editing: ModelId | null = null;

  const bar = toolbar(
    'Destinations',
    toolButton({
      label: 'Create a destination from this view',
      icon: 'file-plus',
      id: 'destination-add',
      onPress: () => void nav.run('destinations.add'),
    }),
    toolButton({
      label: 'Rename the selected destination',
      icon: 'square-pen',
      id: 'destination-rename',
      onPress: () => {
        if (selected) startEditing(selected);
      },
    }),
    toolButton({
      label: 'Set the selected destination to this view',
      icon: 'crosshair',
      id: 'destination-set',
      onPress: () => void nav.run('destinations.setToView'),
    }),
    toolButton({
      label: 'Delete the selected destination',
      icon: 'trash-2',
      id: 'destination-delete',
      onPress: () => void nav.run('destinations.delete'),
    }),
  );
  const scroller = el('div.nav-scroll', { 'data-panel-scroll': 'destinations' });
  const list = el('div.nav-list', { role: 'listbox', 'aria-label': 'Named destinations' });
  scroller.append(list);
  const empty = emptyMessage('This document has no named destinations.', 'tag');
  host.append(bar, scroller, empty);

  const named = (): ModelDestination[] =>
    (nav.context?.document.state.destinations ?? [])
      .filter((d): d is ModelDestination & { name: string } => d.name !== null)
      .sort((a, b) => a.name.localeCompare(b.name, 'en-GB'));

  const render = (): void => {
    const context = nav.context;
    const all = context ? named() : [];
    empty.hidden = all.length > 0;
    scroller.hidden = all.length === 0;
    bar.hidden = context === null;
    list.replaceChildren();

    for (const dest of all) {
      const pageLabel =
        dest.pageId === null ? null : (context?.document.pageById(dest.pageId)?.label ?? null);
      const row = el('div.nav-row', {
        role: 'option',
        'data-row': '',
        'data-id': dest.id,
        tabindex: '-1',
      });
      row.append(el('span.nav-title', null, dest.name ?? ''));
      row.append(el('span.nav-page', null, describeDestination(dest, pageLabel)));
      if (dest.pageId === null || pageLabel === null) {
        // Word plus icon: a broken destination must not be told apart by colour alone.
        row.append(
          el('span.nav-badge.is-warning', { title: 'This destination has no page' }, 'No page'),
        );
      }
      row.classList.toggle('is-selected', dest.id === selected);
      row.setAttribute('aria-selected', String(dest.id === selected));
      row.title = `${dest.name ?? ''} — ${describeDestination(dest, pageLabel)}`;
      row.addEventListener('click', () => {
        select(dest.id);
        nav.goToDestination(dest);
      });
      row.addEventListener('dblclick', () => {
        startEditing(dest.id);
      });
      list.append(row);
    }
    const rows = [...list.querySelectorAll<HTMLElement>('[data-row]')];
    const active = rows.find((r) => r.dataset['id'] === selected) ?? rows[0] ?? null;
    for (const row of rows) row.tabIndex = row === active ? 0 : -1;
    if (editing !== null) startEditing(editing, true);
  };

  const select = (id: ModelId | null): void => {
    selected = id;
    nav.selectedDestination = id;
    for (const row of list.querySelectorAll<HTMLElement>('[data-row]')) {
      const on = row.dataset['id'] === id;
      row.classList.toggle('is-selected', on);
      row.setAttribute('aria-selected', String(on));
    }
  };

  const startEditing = (id: ModelId, restore = false): void => {
    const context = nav.context;
    const dest = context?.document.destination(id);
    const row = list.querySelector<HTMLElement>(`[data-id="${CSS.escape(id)}"]`);
    const title = row?.querySelector('.nav-title');
    if (!context || !dest || !title) return;
    editing = id;
    const input = el('input.nav-edit', {
      type: 'text',
      'aria-label': 'Destination name',
    });
    input.value = dest.name ?? '';
    title.replaceWith(input);
    if (!restore) {
      input.focus();
      input.select();
    }
    const commit = (): void => {
      const value = input.value.trim();
      editing = null;
      if (value !== '' && value !== dest.name) {
        void context.document
          .apply(new RenameDestinationCommand(context.document, id, value))
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

  disposers.push(
    installListKeys(list, {
      rows: () => [...list.querySelectorAll<HTMLElement>('[data-row]')],
      focus: (row) => {
        select((row.dataset['id'] ?? null) as ModelId | null);
      },
      activate: (row) => {
        const id = (row.dataset['id'] ?? null) as ModelId | null;
        const dest = id === null ? null : nav.context?.document.destination(id);
        if (id === null || !dest) return;
        select(id);
        nav.goToDestination(dest);
      },
    }),
    nav.watch(() => {
      render();
    }),
  );

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'F2' || selected === null) return;
    event.preventDefault();
    startEditing(selected);
  };
  list.addEventListener('keydown', onKeyDown);
  disposers.push(() => {
    list.removeEventListener('keydown', onKeyDown);
  });

  render();
  return () => {
    for (const d of disposers.splice(0)) d();
    host.replaceChildren();
  };
}

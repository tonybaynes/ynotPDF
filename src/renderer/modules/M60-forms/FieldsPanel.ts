/**
 * The Fields panel (M60) — the left pane's tree of every field in the document.
 *
 * The tree is the dotted `/T` chain: `address.city` is the child `city` of the node `address`,
 * and an intermediate node the file never gave a dictionary to is still shown, because that is
 * how a reader thinks of a grouped form. Selecting a node selects its widgets and jumps to the
 * first one; renaming is in place; deleting takes the field and every widget with it.
 *
 * Every row says its type in words as well as by icon, and a required field says "required" —
 * never colour alone (CLAUDE.md).
 */

import { el, button as domButton } from '@app/dom';
import { icon } from '@app/icons';
import type { ModelField } from '@core/model';
import { fieldDesignOf } from '@core/model';
import { FIELD_ROLE_LABELS, isRequired, isReadOnly } from '@engine/forms/model';
import type { FormService } from './FormService';
import { widgetKey } from './model';
import { ROLE_ICON } from './tools';

export function mountFieldsPanel(host: HTMLElement, service: FormService): () => void {
  const root = el('div.fields-panel');
  const search = el('input.fields-search', {
    type: 'search',
    placeholder: 'Find a field',
    'aria-label': 'Find a field by name',
  });
  const tree = el('div.fields-tree', { role: 'tree', 'aria-label': 'Form fields' });
  const empty = el('p.fields-empty');
  root.append(search, tree, empty);
  host.replaceChildren(root);

  let filter = '';
  let renaming: string | null = null;

  search.addEventListener('input', () => {
    filter = search.value.trim().toLowerCase();
    render();
  });

  const render = (): void => {
    const document_ = service.activeDocument();
    tree.replaceChildren();
    if (!document_) {
      empty.textContent = 'Open a document to see its form fields.';
      empty.hidden = false;
      return;
    }
    const fields = document_.state.fields;
    const real = fields.filter((f) => !f.synthetic);
    if (real.length === 0) {
      empty.textContent = 'This document has no form fields. Use the Form tab to add some.';
      empty.hidden = false;
      return;
    }
    const matches = (f: ModelField): boolean =>
      filter === '' || f.name.toLowerCase().includes(filter);
    const shown = new Set<string>();
    for (const f of real) {
      if (!matches(f)) continue;
      shown.add(f.id);
      let parent = f.parentId;
      while (parent) {
        shown.add(parent);
        parent = fields.find((p) => p.id === parent)?.parentId ?? null;
      }
    }
    empty.hidden = shown.size > 0;
    if (shown.size === 0) empty.textContent = `No field matches "${search.value}".`;

    const selection = new Set(service.selection);
    const byId = new Map(fields.map((f) => [f.id, f]));
    const roots = fields.filter((f) => f.parentId === null);

    const addRow = (field: ModelField, depth: number): void => {
      if (!shown.has(field.id)) return;
      const design = fieldDesignOf(field);
      const selected = field.widgets.some((w) => selection.has(widgetKey(field.id, w.id)));
      const row = el('div.fields-row', {
        role: 'treeitem',
        tabindex: '0',
        'aria-selected': String(selected),
        'aria-level': String(depth + 1),
        'data-field': field.id,
      });
      row.style.setProperty('--depth', String(depth));
      row.classList.toggle('selected', selected);
      row.classList.toggle('synthetic', field.synthetic);

      row.append(icon(field.synthetic ? 'folder' : ROLE_ICON[design.role]));
      if (renaming === field.id) {
        const input = el('input.fields-rename', {
          type: 'text',
          value: field.name,
          'aria-label': `Name of ${field.name}`,
        });
        const finish = (commit: boolean): void => {
          renaming = null;
          if (!commit) {
            render();
            return;
          }
          void service.rename(field.id, input.value).then((problem) => {
            if (problem) {
              service.activeDocument();
              row.append(el('span.fields-problem', null, problem));
            }
            render();
          });
        };
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') finish(true);
          if (e.key === 'Escape') finish(false);
        });
        input.addEventListener('blur', () => {
          finish(true);
        });
        row.append(input);
        tree.append(row);
        input.focus();
        input.select();
      } else {
        row.append(el('span.fields-name', null, field.partialName || field.name));
        row.append(
          el('span.fields-kind', null, field.synthetic ? 'Group' : FIELD_ROLE_LABELS[design.role]),
        );
        if (!field.synthetic && isRequired(design)) {
          row.append(el('span.fields-flag', null, 'Required'));
        }
        if (!field.synthetic && isReadOnly(design)) {
          row.append(el('span.fields-flag', null, 'Read-only'));
        }
        tree.append(row);
      }

      if (!field.synthetic) {
        row.addEventListener('click', (e) => {
          const keys = field.widgets.map((w) => widgetKey(field.id, w.id));
          const first = field.widgets[0];
          const page = first ? document_.pageIndex(first.pageId) : -1;
          if (e.shiftKey || e.ctrlKey || e.metaKey) {
            service.select(
              [...new Set([...service.selection, ...keys])],
              page < 0 ? undefined : page,
            );
          } else {
            service.select(keys, page < 0 ? undefined : page);
            if (page >= 0) service.activeViewer()?.goToPage(page);
          }
        });
        row.addEventListener('dblclick', () => {
          renaming = field.id;
          render();
        });
        row.addEventListener('keydown', (e) => {
          if (e.key === 'F2') {
            e.preventDefault();
            renaming = field.id;
            render();
          }
          if (e.key === 'Delete') {
            e.preventDefault();
            const keys = field.widgets.map((w) => widgetKey(field.id, w.id));
            service.select(keys);
            void service.deleteSelection();
          }
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            row.click();
          }
        });
      }

      for (const childId of field.childIds) {
        const child = byId.get(childId);
        if (child) addRow(child, depth + 1);
      }
    };

    for (const root_ of roots) addRow(root_, 0);
    if (tree.childElementCount > 0) {
      const actions = el('div.fields-actions');
      const rename = domButton('btn', { 'data-action': 'rename' }, 'Rename');
      rename.addEventListener('click', () => {
        const first = service.selectionInfo().fields[0];
        if (!first) return;
        renaming = first.id;
        render();
      });
      const remove = domButton('btn', { 'data-action': 'delete' }, 'Delete');
      remove.addEventListener('click', () => {
        void service.deleteSelection();
      });
      actions.append(rename, remove);
      root.append(actions);
    }
  };

  render();
  const off = service.onChange(render);
  return () => {
    off();
    host.replaceChildren();
  };
}

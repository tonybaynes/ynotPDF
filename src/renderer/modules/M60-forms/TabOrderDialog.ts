/**
 * Set Tab Order (M60) — the dialog behind the Form tab's button.
 *
 * The order a reader tabs through a form is a property of the *page*: `/Tabs` names a rule (rows,
 * columns, or the document's structure) and a manual order is the order of the page's `/Annots`.
 * So the dialog is per page: pick a rule, or reorder the list by hand.
 *
 * The list is a real listbox with buttons rather than a drag-and-drop surface. Drag is offered as
 * well, but the buttons are what make the order reachable from the keyboard, and reorder-by-drag
 * with no keyboard path is exactly the kind of control the operator cannot use.
 */

import { el, button as domButton } from '@app/dom';
import type { Dialogs } from '@app/dialog/Dialogs';
import { fieldDesignOf } from '@core/model';
import {
  FIELD_ROLE_LABELS,
  TAB_ORDER_LABELS,
  TAB_ORDER_MODES,
  type TabOrderMode,
} from '@engine/forms/model';
import type { FormService } from './FormService';

export async function openTabOrderDialog(
  dialogs: Dialogs,
  service: FormService,
  page: number,
): Promise<void> {
  let mode: TabOrderMode = service.tabModeOf(page);
  let order = service.tabOrderOf(page).map((w) => w.key);
  const labels = new Map(
    service.tabOrderOf(page).map((w) => {
      const design = fieldDesignOf(w.field);
      return [w.key, `${w.field.name} — ${FIELD_ROLE_LABELS[design.role]}`];
    }),
  );

  const handle = dialogs.open({
    id: 'tab-order-dialog',
    title: `Tab order — page ${String(page + 1)}`,
    width: 520,
    content: (body) => {
      const modeRow = el('div.tab-order-modes', { role: 'radiogroup', 'aria-label': 'Tab order' });
      const list = el('div.tab-order-list', {
        role: 'listbox',
        'aria-label': 'Fields in tab order',
        tabindex: '0',
      });
      const hint = el('p.tab-order-hint');
      let selected = order[0] ?? null;

      const renderList = (): void => {
        list.replaceChildren();
        order.forEach((key, index) => {
          const row = el('div.tab-order-row', {
            role: 'option',
            'aria-selected': String(selected === key),
            'data-key': key,
            draggable: 'true',
          });
          row.classList.toggle('selected', selected === key);
          row.append(el('span.tab-order-number', null, String(index + 1)));
          row.append(el('span.tab-order-name', null, labels.get(key) ?? key));
          row.addEventListener('click', () => {
            selected = key;
            renderList();
          });
          row.addEventListener('dragstart', (e) => {
            e.dataTransfer?.setData('text/plain', key);
          });
          row.addEventListener('dragover', (e) => {
            e.preventDefault();
          });
          row.addEventListener('drop', (e) => {
            e.preventDefault();
            const moved = e.dataTransfer?.getData('text/plain');
            if (!moved || moved === key) return;
            const next = order.filter((k) => k !== moved);
            next.splice(order.indexOf(key), 0, moved);
            order = next;
            mode = 'manual';
            syncModes();
            renderList();
          });
          list.append(row);
        });
        if (order.length === 0) {
          list.append(el('p.tab-order-empty', null, 'This page has no form fields.'));
        }
      };

      const move = (delta: number): void => {
        if (selected === null) return;
        const at = order.indexOf(selected);
        const to = at + delta;
        if (at < 0 || to < 0 || to >= order.length) return;
        const next = [...order];
        const [item] = next.splice(at, 1);
        if (item) next.splice(to, 0, item);
        order = next;
        mode = 'manual';
        syncModes();
        renderList();
      };

      const radios: HTMLInputElement[] = [];
      const syncModes = (): void => {
        for (const r of radios) r.checked = r.value === mode;
        hint.textContent =
          mode === 'structure'
            ? 'Document structure is written into the file for readers that have it. ynotPDF has no structure tree of its own yet, so it shows the fields in row order here.'
            : mode === 'manual'
              ? 'The order below is written into the file exactly as it is.'
              : 'The order is worked out from where the fields sit on the page.';
      };

      for (const m of TAB_ORDER_MODES) {
        const id = `tab-order-${m}`;
        const input = el('input', { id, type: 'radio', name: 'tab-order', value: m });
        input.checked = m === mode;
        input.addEventListener('change', () => {
          mode = m;
          if (m !== 'manual') {
            order = orderPreview(service, page, m);
            renderList();
          }
          syncModes();
        });
        radios.push(input);
        modeRow.append(
          el('div.tab-order-mode', null, input, el('label', { for: id }, TAB_ORDER_LABELS[m])),
        );
      }

      const buttons = el('div.tab-order-buttons');
      const up = domButton('btn', null, 'Move up');
      up.addEventListener('click', () => {
        move(-1);
      });
      const down = domButton('btn', null, 'Move down');
      down.addEventListener('click', () => {
        move(1);
      });
      buttons.append(up, down);

      list.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowUp' && e.altKey) {
          e.preventDefault();
          move(-1);
        } else if (e.key === 'ArrowDown' && e.altKey) {
          e.preventDefault();
          move(1);
        } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
          e.preventDefault();
          const at = selected === null ? -1 : order.indexOf(selected);
          const to = Math.max(0, Math.min(order.length - 1, at + (e.key === 'ArrowUp' ? -1 : 1)));
          selected = order[to] ?? selected;
          renderList();
        }
      });

      syncModes();
      renderList();
      body.append(modeRow, hint, list, buttons);
      body.append(
        el(
          'p.tab-order-hint',
          null,
          'Alt with the arrow keys moves the chosen field; the arrow keys alone move the choice.',
        ),
      );
    },
    buttons: [
      { id: 'cancel', label: 'Cancel' },
      { id: 'apply', label: 'Apply', primary: true },
    ],
  });

  const result = await handle.result;
  if (result !== 'apply') return;
  if (mode === 'manual') await service.setManualOrder(page, order);
  else await service.setTabMode(page, mode);
}

/** What the list would look like under a rule, without changing anything yet. */
function orderPreview(service: FormService, page: number, mode: TabOrderMode): string[] {
  const current = service.tabOrderOf(page);
  if (mode === 'manual') return current.map((w) => w.key);
  const rect = (k: (typeof current)[number]): typeof k.widget.rect => k.widget.rect;
  const sorted = [...current].sort((a, b) =>
    mode === 'column'
      ? rect(a).x0 - rect(b).x0 || rect(b).y1 - rect(a).y1
      : rect(b).y1 - rect(a).y1 || rect(a).x0 - rect(b).x0,
  );
  return sorted.map((w) => w.key);
}

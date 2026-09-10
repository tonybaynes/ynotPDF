/**
 * "Ribbon and toolbar" (M130) — the page inside Preferences that hides, shows and reorders what
 * is on the ribbon, and edits the quick-access toolbar.
 *
 * A tree rather than the two-list arrangement most applications use for this: two lists ask the
 * reader to hold "what is on the left" and "what is on the right" in their head at once, where a
 * tree of tabs → groups → buttons with a tick box on each row shows the ribbon as it is and lets
 * one row be changed without moving anything. Every row is reachable by keyboard, and Move up /
 * Move down are real buttons rather than a drag, because a drag is the one interaction this
 * operator cannot rely on.
 *
 * Nothing is destroyed: hiding a group is a line in `ui.ribbon.custom`, and Reset deletes it.
 */

import type { Dialogs } from '@app/dialog/Dialogs';
import { button, el, srOnly } from '@app/dom';
import { icon } from '@app/icons';
import type { RibbonGroupSpec, RibbonItemSpec } from '@shared/module';
import { t } from '../i18n';
import {
  applyOrder,
  isCustomised,
  itemId,
  moveGroup,
  moveItem,
  setGroupHidden,
  setItemHidden,
  type RibbonCustomState,
} from './model';

/** The built-in tab ids and labels, so the tree reads in words rather than in ids. */
export interface TabInfo {
  readonly id: string;
  readonly label: string;
}

export interface CustomisePageOptions {
  readonly dialogs: Dialogs;
  readonly tabs: ReadonlyArray<TabInfo>;
  /** Every group the manifests declare, before customisation. */
  groups(): ReadonlyArray<RibbonGroupSpec>;
  /** The label and icon of a command id, for the button rows. */
  describe(commandId: string): { readonly label: string; readonly icon?: string };
  state(): RibbonCustomState;
  save(state: RibbonCustomState): Promise<void>;
  /** The quick-access toolbar's command ids, and the commands available to add to it. */
  qat(): ReadonlyArray<string>;
  setQat(ids: ReadonlyArray<string>): Promise<void>;
  addableCommands(): ReadonlyArray<{ readonly id: string; readonly label: string }>;
  resetQat(): Promise<void>;
  /** Tells the page when the customisation changed elsewhere (Reset from the palette). */
  subscribe?: (redraw: () => void) => () => void;
}

export function mountCustomisePage(host: HTMLElement, options: CustomisePageOptions): () => void {
  const { dialogs } = options;
  const status = el('p.customise-status', { role: 'status', 'aria-live': 'polite' });
  const tree = el('div.customise-tree', {
    role: 'tree',
    'aria-label': t('customise.ribbon', 'Ribbon'),
  });
  const qatList = el('ul.customise-qat', { role: 'list' });
  const expanded = new Set<string>();

  const say = (text: string): void => {
    status.textContent = text;
  };

  const commit = async (next: RibbonCustomState, message: string): Promise<void> => {
    await options.save(next);
    draw();
    say(message);
  };

  // ---- the ribbon tree ------------------------------------------------------------------------

  const itemLabel = (item: RibbonItemSpec): string => {
    if (item === '-') return t('customise.separator', 'Separator');
    const id = itemId(item);
    if (typeof item !== 'string' && 'label' in item && item.label) return item.label;
    return options.describe(id).label;
  };

  function drawTree(): void {
    tree.replaceChildren();
    const state = options.state();
    const hiddenGroups = new Set(state.hiddenGroups);
    const hiddenItems = new Set(state.hiddenItems);
    const all = options.groups();

    for (const tab of options.tabs) {
      const inTab = all.filter((g) => String(g.tab) === tab.id);
      if (inTab.length === 0) continue;
      const order = state.groupOrder[tab.id] ?? [];
      const ordered = order.length > 0 ? applyOrder(inTab, order, (g) => g.id) : inTab;
      const tabNode = el('div.customise-tab', { role: 'treeitem', 'aria-expanded': 'true' });
      tabNode.append(el('h4.customise-tab-label', null, tab.label));
      const groupList = el('div.customise-groups', { role: 'group' });

      ordered.forEach((group, index) => {
        const hidden = hiddenGroups.has(group.id);
        const groupNode = el('div.customise-group', {
          role: 'treeitem',
          'data-group': group.id,
          'aria-expanded': expanded.has(group.id) ? 'true' : 'false',
        });
        const header = el('div.customise-row');
        const toggle = button('icon-btn customise-expand', {
          title: expanded.has(group.id)
            ? t('customise.collapse', 'Hide the buttons in this group')
            : t('customise.expand', 'Show the buttons in this group'),
        });
        toggle.append(
          icon(expanded.has(group.id) ? 'chevron-down' : 'chevron-right'),
          srOnly(group.label),
        );
        toggle.addEventListener('click', () => {
          if (expanded.has(group.id)) expanded.delete(group.id);
          else expanded.add(group.id);
          drawTree();
        });
        header.append(
          toggle,
          checkbox(group.label, !hidden, (on) => {
            void commit(
              setGroupHidden(options.state(), group.id, !on),
              on
                ? t('customise.groupShown', '“{label}” is on the ribbon again.', {
                    label: group.label,
                  })
                : t('customise.groupHidden', '“{label}” is off the ribbon.', {
                    label: group.label,
                  }),
            );
          }),
        );
        header.append(
          moveButtons(group.label, index, ordered.length, (direction) => {
            void commit(
              moveGroup(
                options.state(),
                tab.id,
                ordered.map((g) => g.id),
                group.id,
                direction,
              ),
              t('customise.groupMoved', '“{label}” moved.', { label: group.label }),
            );
          }),
        );
        groupNode.append(header);

        if (expanded.has(group.id)) {
          const itemList = el('div.customise-items', { role: 'group' });
          const itemOrder = state.itemOrder[group.id] ?? [];
          const items =
            itemOrder.length > 0
              ? applyOrder(group.items, itemOrder, (i) => (i === '-' ? '' : itemId(i)))
              : group.items;
          items.forEach((item, itemIndex) => {
            if (item === '-') return;
            const id = itemId(item);
            const label = itemLabel(item);
            const row = el('div.customise-row.customise-item', {
              role: 'treeitem',
              'data-item': id,
            });
            row.append(
              checkbox(label, !hiddenItems.has(`${group.id}/${id}`), (on) => {
                void commit(
                  setItemHidden(options.state(), group.id, id, !on),
                  on
                    ? t('customise.itemShown', '“{label}” is back on the ribbon.', { label })
                    : t('customise.itemHidden', '“{label}” is off the ribbon.', { label }),
                );
              }),
            );
            row.append(
              moveButtons(label, itemIndex, items.length, (direction) => {
                void commit(
                  moveItem(
                    options.state(),
                    group.id,
                    items.map((i) => (i === '-' ? '' : itemId(i))),
                    id,
                    direction,
                  ),
                  t('customise.itemMoved', '“{label}” moved.', { label }),
                );
              }),
            );
            const toQat = button('icon-btn', {
              title: t('customise.addToQat', 'Add to the quick-access toolbar'),
            });
            toQat.append(
              icon('plus'),
              srOnly(`${t('customise.addToQat', 'Add to the quick-access toolbar')}: ${label}`),
            );
            toQat.disabled = options.qat().includes(id) || id === '';
            toQat.addEventListener('click', () => {
              void options.setQat([...options.qat(), id]).then(() => {
                drawQat();
                drawTree();
                say(
                  t('customise.qatAdded', '“{label}” is on the quick-access toolbar.', { label }),
                );
              });
            });
            row.append(toQat);
            itemList.append(row);
          });
          if (itemList.childElementCount === 0) {
            itemList.append(
              el('p.customise-empty', null, t('customise.groupEmpty', 'Nothing to hide in here.')),
            );
          }
          groupNode.append(itemList);
        }
        groupList.append(groupNode);
      });
      tabNode.append(groupList);
      tree.append(tabNode);
    }
  }

  // ---- the quick-access toolbar --------------------------------------------------------------

  function drawQat(): void {
    qatList.replaceChildren();
    const ids = options.qat();
    if (ids.length === 0) {
      qatList.append(
        el('li.customise-empty', null, t('customise.qatEmpty', 'The toolbar is empty.')),
      );
    }
    ids.forEach((id, index) => {
      const label = options.describe(id).label;
      const row = el('li.customise-row', { 'data-qat': id });
      row.append(el('span.customise-qat-label', null, label));
      row.append(
        moveButtons(label, index, ids.length, (direction) => {
          const next = [...ids];
          const [moved] = next.splice(index, 1);
          if (moved !== undefined) next.splice(index + direction, 0, moved);
          void options.setQat(next).then(() => {
            drawQat();
            say(t('customise.qatMoved', '“{label}” moved.', { label }));
          });
        }),
      );
      const remove = button('icon-btn', { title: t('customise.qatRemove', 'Remove') });
      remove.append(icon('trash-2'), srOnly(`${t('customise.qatRemove', 'Remove')}: ${label}`));
      remove.addEventListener('click', () => {
        void options.setQat(ids.filter((c) => c !== id)).then(() => {
          drawQat();
          drawTree();
          say(t('customise.qatRemoved', '“{label}” is off the toolbar.', { label }));
        });
      });
      row.append(remove);
      qatList.append(row);
    });
  }

  const qatPicker = el('select.customise-qat-picker', {
    'aria-label': t('customise.qatAddLabel', 'A command to add to the toolbar'),
  });
  const drawPicker = (): void => {
    const on = new Set(options.qat());
    qatPicker.replaceChildren(
      el('option', { value: '' }, t('customise.qatChoose', 'Choose a command…')),
    );
    for (const command of options.addableCommands()) {
      if (on.has(command.id)) continue;
      qatPicker.append(el('option', { value: command.id }, command.label));
    }
  };
  const qatAdd = button('btn customise-qat-add-btn');
  qatAdd.append(icon('plus'), el('span', null, t('customise.qatAdd', 'Add')));
  qatAdd.addEventListener('click', () => {
    const id = qatPicker.value;
    if (id === '') return;
    void options.setQat([...options.qat(), id]).then(() => {
      drawQat();
      drawPicker();
      drawTree();
      say(
        t('customise.qatAdded', '“{label}” is on the quick-access toolbar.', {
          label: options.describe(id).label,
        }),
      );
    });
  });

  // ---- reset -----------------------------------------------------------------------------------

  const resetRibbon = button('btn customise-ribbon-reset');
  resetRibbon.append(
    icon('refresh-cw'),
    el('span', null, t('customise.resetRibbon', 'Reset the ribbon')),
  );
  resetRibbon.addEventListener('click', () => {
    void (async () => {
      const ok = await dialogs.confirm({
        title: t('customise.resetRibbonTitle', 'Reset the ribbon?'),
        text: t(
          'customise.resetRibbonText',
          'Every group and button comes back, in the order the application ships with. The quick-access toolbar is not touched.',
        ),
        kind: 'question',
        confirmLabel: t('customise.resetRibbonConfirm', 'Reset it'),
      });
      if (!ok) return;
      await commit(
        { hiddenGroups: [], hiddenItems: [], groupOrder: {}, itemOrder: {} },
        t('customise.resetRibbonDone', 'The ribbon is back to how it ships.'),
      );
    })();
  });

  const resetQat = button('btn customise-qat-reset');
  resetQat.append(
    icon('refresh-cw'),
    el('span', null, t('customise.resetQat', 'Reset the toolbar')),
  );
  resetQat.addEventListener('click', () => {
    void options.resetQat().then(() => {
      drawQat();
      drawPicker();
      drawTree();
      say(t('customise.resetQatDone', 'The quick-access toolbar is back to how it ships.'));
    });
  });

  function draw(): void {
    drawTree();
    drawQat();
    drawPicker();
    resetRibbon.disabled = !isCustomised(options.state());
  }

  host.append(
    status,
    el('h3.customise-heading', null, t('customise.qatHeading', 'Quick-access toolbar')),
    el(
      'p.customise-lede',
      null,
      t(
        'customise.qatLede',
        'The small row of buttons above the ribbon tabs. It stays put whichever tab is open.',
      ),
    ),
    qatList,
    el('div.customise-qat-add', null, qatPicker, qatAdd, resetQat),
    el('h3.customise-heading', null, t('customise.ribbonHeading', 'Ribbon')),
    el(
      'p.customise-lede',
      null,
      t(
        'customise.ribbonLede',
        'Untick anything you never use and it leaves the ribbon. Nothing is deleted — tick it again and it comes back.',
      ),
    ),
    tree,
    el('div.customise-actions', null, resetRibbon),
  );
  const unsubscribe = options.subscribe?.(draw);
  draw();
  return () => {
    unsubscribe?.();
  };
}

/** A tick box with its label beside it, as every row of the tree uses. */
function checkbox(label: string, checked: boolean, onChange: (on: boolean) => void): HTMLElement {
  const input = el('input', { type: 'checkbox' });
  input.checked = checked;
  input.addEventListener('change', () => {
    onChange(input.checked);
  });
  const wrapper = el('label.customise-check');
  wrapper.append(input, el('span', null, label));
  return wrapper;
}

/** Move up / move down, disabled at the ends. */
function moveButtons(
  label: string,
  index: number,
  total: number,
  move: (direction: -1 | 1) => void,
): HTMLElement {
  const wrap = el('span.customise-move');
  const make = (direction: -1 | 1, iconName: string, word: string): void => {
    const btn = button('icon-btn', { title: `${word}: ${label}` });
    btn.append(icon(iconName), srOnly(`${word}: ${label}`));
    btn.disabled = direction === -1 ? index === 0 : index >= total - 1;
    btn.addEventListener('click', () => {
      move(direction);
    });
    wrap.append(btn);
  };
  make(-1, 'arrow-up', t('customise.moveUp', 'Move up'));
  make(1, 'arrow-down', t('customise.moveDown', 'Move down'));
  return wrap;
}

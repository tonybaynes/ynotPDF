/**
 * Ribbon customisation (M130): the diff over the manifests, and what happens when the manifests
 * change underneath it.
 *
 * The rule under test throughout is that the *manifests* stay the source of truth. Hiding a group
 * is a line in the customisation; a group nobody has touched keeps its place even when its
 * neighbours change; and an id that no longer exists costs the reader nothing.
 */

import { describe, expect, it } from 'vitest';
import type { RibbonGroupSpec } from '@shared/module';
import { flatten, unflatten } from '@shared/settings';
import {
  applyCustomisation,
  applyOrder,
  EMPTY_CUSTOM,
  isCustomised,
  itemId,
  itemKey,
  moveGroup,
  moveInList,
  moveItem,
  readCustomState,
  setGroupHidden,
  setItemHidden,
  toStoredCustom,
  type RibbonCustomState,
} from '@modules/M130-preferences/customise/model';

const GROUPS: ReadonlyArray<RibbonGroupSpec> = [
  { id: 'home.clipboard', tab: 'home', label: 'Clipboard', items: ['edit.cut', 'edit.copy'] },
  {
    id: 'home.tools',
    tab: 'home',
    label: 'Tools',
    items: ['tool.hand', '-', { kind: 'toggle', command: 'view.rulers', pressed: () => false }],
  },
  { id: 'view.zoom', tab: 'view', label: 'Zoom', items: ['view.zoomIn', 'view.zoomOut'] },
];

describe('itemId', () => {
  it('reads a plain command id, a rich item’s own id and a command-only item', () => {
    expect(itemId('edit.copy')).toBe('edit.copy');
    expect(itemId({ kind: 'dropdown', id: 'x.menu', label: 'Menu', menu: [] })).toBe('x.menu');
    expect(itemId({ kind: 'button', command: 'file.open' })).toBe('file.open');
  });

  it('builds the key a hidden item is stored under', () => {
    expect(itemKey('home.tools', 'tool.hand')).toBe('home.tools/tool.hand');
  });
});

describe('applyCustomisation', () => {
  it('changes nothing when nothing has been customised', () => {
    expect(applyCustomisation(GROUPS, EMPTY_CUSTOM)).toEqual(GROUPS);
    expect(isCustomised(EMPTY_CUSTOM)).toBe(false);
  });

  it('removes a hidden group', () => {
    const state = setGroupHidden(EMPTY_CUSTOM, 'home.tools', true);
    const out = applyCustomisation(GROUPS, state);
    expect(out.map((g) => g.id)).toEqual(['home.clipboard', 'view.zoom']);
    expect(isCustomised(state)).toBe(true);
  });

  it('removes a hidden button and tidies the separator it left behind', () => {
    const state = setItemHidden(EMPTY_CUSTOM, 'home.tools', 'view.rulers', true);
    const tools = applyCustomisation(GROUPS, state).find((g) => g.id === 'home.tools');
    expect(tools?.items).toEqual(['tool.hand']);
  });

  it('drops a group whose every button has been hidden', () => {
    let state = setItemHidden(EMPTY_CUSTOM, 'home.clipboard', 'edit.cut', true);
    state = setItemHidden(state, 'home.clipboard', 'edit.copy', true);
    expect(applyCustomisation(GROUPS, state).map((g) => g.id)).not.toContain('home.clipboard');
  });

  it('hides the same command in one group without hiding it in another', () => {
    const twice: RibbonGroupSpec[] = [
      { id: 'a', tab: 'home', label: 'A', items: ['edit.copy'] },
      { id: 'b', tab: 'home', label: 'B', items: ['edit.copy'] },
    ];
    const state = setItemHidden(EMPTY_CUSTOM, 'a', 'edit.copy', true);
    expect(applyCustomisation(twice, state).map((g) => g.id)).toEqual(['b']);
  });

  it('reorders groups within their own tab only', () => {
    const state: RibbonCustomState = {
      ...EMPTY_CUSTOM,
      groupOrder: { home: ['home.tools', 'home.clipboard'] },
    };
    expect(applyCustomisation(GROUPS, state).map((g) => g.id)).toEqual([
      'home.tools',
      'home.clipboard',
      'view.zoom',
    ]);
  });

  it('reorders the buttons inside a group', () => {
    const state: RibbonCustomState = {
      ...EMPTY_CUSTOM,
      itemOrder: { 'home.clipboard': ['edit.copy', 'edit.cut'] },
    };
    const group = applyCustomisation(GROUPS, state).find((g) => g.id === 'home.clipboard');
    expect(group?.items).toEqual(['edit.copy', 'edit.cut']);
  });

  it('ignores an id that no longer exists rather than breaking the ribbon', () => {
    const state: RibbonCustomState = {
      hiddenGroups: ['gone.group'],
      hiddenItems: ['gone.group/gone.item'],
      groupOrder: { home: ['gone.group', 'home.tools'] },
      itemOrder: { 'gone.group': ['a', 'b'] },
    };
    // Only `home.tools` survives the order, and one surviving name cannot reorder anything —
    // so the ribbon is exactly what the manifests say.
    expect(applyCustomisation(GROUPS, state).map((g) => g.id)).toEqual([
      'home.clipboard',
      'home.tools',
      'view.zoom',
    ]);
  });

  it('shows a group a module added after the reader last customised anything', () => {
    const state: RibbonCustomState = {
      ...EMPTY_CUSTOM,
      groupOrder: { home: ['home.tools', 'home.clipboard'] },
    };
    const later = [
      ...GROUPS,
      { id: 'home.new', tab: 'home', label: 'Brand new', items: ['new.thing'] } as RibbonGroupSpec,
    ];
    expect(applyCustomisation(later, state).map((g) => g.id)).toContain('home.new');
  });
});

describe('applyOrder', () => {
  it('keeps a value the order does not mention in the slot it already had', () => {
    const values = ['a', 'b', 'c', 'd'];
    // Only a and c are listed, and they swap; b and d never move.
    expect(applyOrder(values, ['c', 'a'], (v) => v)).toEqual(['c', 'b', 'a', 'd']);
  });

  it('is a no-op for an empty or wholly unknown order', () => {
    expect(applyOrder(['a', 'b'], [], (v) => v)).toEqual(['a', 'b']);
    expect(applyOrder(['a', 'b'], ['z'], (v) => v)).toEqual(['a', 'b']);
  });
});

describe('moving', () => {
  it('moves one place at a time and stops at the ends', () => {
    expect(moveInList(['a', 'b', 'c'], 'b', -1)).toEqual(['b', 'a', 'c']);
    expect(moveInList(['a', 'b', 'c'], 'a', -1)).toEqual(['a', 'b', 'c']);
    expect(moveInList(['a', 'b', 'c'], 'c', 1)).toEqual(['a', 'b', 'c']);
    expect(moveInList(['a', 'b', 'c'], 'zz', 1)).toEqual(['a', 'b', 'c']);
  });

  it('records a group move against the order it was shown in', () => {
    const state = moveGroup(
      EMPTY_CUSTOM,
      'home',
      ['home.clipboard', 'home.tools'],
      'home.tools',
      -1,
    );
    expect(state.groupOrder['home']).toEqual(['home.tools', 'home.clipboard']);
  });

  it('records an item move the same way', () => {
    const state = moveItem(
      EMPTY_CUSTOM,
      'home.clipboard',
      ['edit.cut', 'edit.copy'],
      'edit.copy',
      -1,
    );
    expect(state.itemOrder['home.clipboard']).toEqual(['edit.copy', 'edit.cut']);
  });

  it('un-hiding puts a group back', () => {
    const hidden = setGroupHidden(EMPTY_CUSTOM, 'view.zoom', true);
    const shown = setGroupHidden(hidden, 'view.zoom', false);
    expect(shown.hiddenGroups).toEqual([]);
    expect(applyCustomisation(GROUPS, shown)).toEqual(GROUPS);
  });
});

describe('what goes into settings.json', () => {
  const state: RibbonCustomState = {
    hiddenGroups: ['view.panes'],
    hiddenItems: ['home.tools/tool.hand'],
    groupOrder: { home: ['home.tools', 'home.clipboard'] },
    itemOrder: { 'home.clipboard': ['edit.copy', 'edit.cut'] },
  };

  /**
   * A ribbon group id has dots in it and the settings store is a dotted tree, so the two order
   * tables are stored as lists of entries. A map would come back as `{ home: { clipboard: … } }`
   * and the reader's customisation would silently vanish on the next start.
   */
  it('stores the order tables as sorted lists of entries', () => {
    expect(toStoredCustom(state)).toEqual({
      hiddenGroups: ['view.panes'],
      hiddenItems: ['home.tools/tool.hand'],
      groupOrder: [{ tab: 'home', order: ['home.tools', 'home.clipboard'] }],
      itemOrder: [{ group: 'home.clipboard', order: ['edit.copy', 'edit.cut'] }],
    });
  });

  it('round-trips through the store’s flatten/unflatten pair unharmed', () => {
    const onDisk = unflatten(flatten({ ui: { ribbon: { custom: toStoredCustom(state) } } }));
    const readBack = (onDisk as { ui: { ribbon: { custom: unknown } } }).ui.ribbon.custom;
    expect(readCustomState(readBack)).toEqual(state);
  });
});

describe('readCustomState', () => {
  it('reads what was written', () => {
    const state: RibbonCustomState = {
      hiddenGroups: ['a'],
      hiddenItems: ['a/b'],
      groupOrder: { home: ['x', 'y'] },
      itemOrder: { a: ['b'] },
    };
    expect(readCustomState(JSON.parse(JSON.stringify(state)))).toEqual(state);
    expect(readCustomState(JSON.parse(JSON.stringify(toStoredCustom(state))))).toEqual(state);
  });

  it('costs the reader their customisation at worst, never their ribbon', () => {
    expect(readCustomState(undefined)).toEqual(EMPTY_CUSTOM);
    expect(readCustomState('nonsense')).toEqual(EMPTY_CUSTOM);
    expect(readCustomState(['a'])).toEqual(EMPTY_CUSTOM);
    expect(readCustomState({ hiddenGroups: [1, 'a'], groupOrder: { home: 'x' } })).toEqual({
      ...EMPTY_CUSTOM,
      hiddenGroups: ['a'],
    });
  });
});

/**
 * Ribbon customisation (M130) — a diff over the manifests, never a copy of them.
 *
 * What is stored is which groups and buttons the reader hid and what order they put them in. The
 * manifests stay the source of truth for what exists, what it is called and what it does, so a
 * module that adds a button next month shows up straight away instead of being invisible because
 * a saved copy of the ribbon does not mention it. An id that no longer exists is dropped on read
 * rather than breaking the ribbon.
 *
 * Pure — this file has no DOM and no Registry. `Ribbon.ts` asks the Registry for a
 * `ribbonCustomisation` service (ADR 0018) and hands it the group list; the service is a thin
 * wrapper around {@link applyCustomisation}.
 */

import type { RibbonGroupSpec, RibbonItemSpec } from '@shared/module';

/** The settings key the customisation lives under. */
export const RIBBON_CUSTOM_KEY = 'ui.ribbon.custom';

export interface RibbonCustomState {
  /** Group ids the reader hid. */
  readonly hiddenGroups: ReadonlyArray<string>;
  /** Items the reader hid, as `"<groupId>/<itemId>"` — the same command may sit in two groups. */
  readonly hiddenItems: ReadonlyArray<string>;
  /** Per tab, the group ids in the reader's order. Partial: unlisted groups keep their place. */
  readonly groupOrder: Readonly<Record<string, ReadonlyArray<string>>>;
  /** Per group, the item ids in the reader's order. Partial in the same way. */
  readonly itemOrder: Readonly<Record<string, ReadonlyArray<string>>>;
}

export const EMPTY_CUSTOM: RibbonCustomState = {
  hiddenGroups: [],
  hiddenItems: [],
  groupOrder: {},
  itemOrder: {},
};

/** True when the reader has customised anything — drives "Reset" being offered at all. */
export function isCustomised(state: RibbonCustomState): boolean {
  return (
    state.hiddenGroups.length > 0 ||
    state.hiddenItems.length > 0 ||
    Object.keys(state.groupOrder).length > 0 ||
    Object.keys(state.itemOrder).length > 0
  );
}

/** The id a ribbon item is known by: its command id, or the rich spec's own id. */
export function itemId(item: RibbonItemSpec): string {
  if (typeof item === 'string') return item;
  if ('id' in item && item.id) return item.id;
  if ('command' in item && item.command) return item.command;
  return '';
}

/** `"<groupId>/<itemId>"`, the key hidden items are stored under. */
export function itemKey(groupId: string, item: RibbonItemSpec | string): string {
  return `${groupId}/${typeof item === 'string' ? item : itemId(item)}`;
}

/**
 * Reorders `values` to match `order`, keeping anything `order` does not mention where it already
 * is relative to its neighbours.
 *
 * "Where it already is" is the point: a partial order must not send every unlisted item to the
 * end. A group the reader has never dragged should stay put when the module that owns it adds a
 * second one beside it, so an unlisted value keeps the index it had.
 */
export function applyOrder<T>(
  values: ReadonlyArray<T>,
  order: ReadonlyArray<string>,
  idOf: (value: T) => string,
): ReadonlyArray<T> {
  if (order.length === 0) return values;
  const wanted = order.filter((id) => values.some((v) => idOf(v) === id));
  if (wanted.length === 0) return values;
  const listed = new Set(wanted);
  // The slots the listed values occupy today; the reordered ones are dealt back into them.
  const slots: number[] = [];
  values.forEach((value, index) => {
    if (listed.has(idOf(value))) slots.push(index);
  });
  const out = [...values];
  wanted.forEach((id, i) => {
    const slot = slots[i];
    const value = values.find((v) => idOf(v) === id);
    if (slot !== undefined && value !== undefined) out[slot] = value;
  });
  return out;
}

/** Removes leading, trailing and doubled separators left behind by a hidden item. */
function tidySeparators(items: ReadonlyArray<RibbonItemSpec>): ReadonlyArray<RibbonItemSpec> {
  const out: RibbonItemSpec[] = [];
  for (const item of items) {
    if (item === '-' && (out.length === 0 || out[out.length - 1] === '-')) continue;
    out.push(item);
  }
  while (out.length > 0 && out[out.length - 1] === '-') out.pop();
  return out;
}

/**
 * Applies the customisation to the group list the manifests produced. A group whose items are all
 * hidden disappears with them: an empty labelled box on the ribbon is a puzzle, not a feature.
 */
export function applyCustomisation(
  groups: ReadonlyArray<RibbonGroupSpec>,
  state: RibbonCustomState,
): ReadonlyArray<RibbonGroupSpec> {
  const hiddenGroups = new Set(state.hiddenGroups);
  const hiddenItems = new Set(state.hiddenItems);
  const visible = groups.filter((group) => !hiddenGroups.has(group.id));

  const customised = visible.map((group) => {
    const kept = group.items.filter(
      (item) => item === '-' || !hiddenItems.has(itemKey(group.id, item)),
    );
    const ordered = applyOrder(kept, state.itemOrder[group.id] ?? [], (item) =>
      item === '-' ? '' : itemId(item),
    );
    const items = tidySeparators(ordered);
    return items === group.items ? group : { ...group, items };
  });

  const wanted = customised.filter((group) => group.items.some((item) => item !== '-'));

  // Reordering happens per tab: the list the ribbon is given holds every tab's groups at once.
  const tabs = new Set(wanted.map((g) => String(g.tab)));
  let out: ReadonlyArray<RibbonGroupSpec> = wanted;
  for (const tab of tabs) {
    const order = state.groupOrder[tab];
    if (!order || order.length === 0) continue;
    const inTab = out.filter((g) => String(g.tab) === tab);
    const reordered = applyOrder(inTab, order, (g) => g.id);
    let next = 0;
    out = out.map((g) => (String(g.tab) === tab ? (reordered[next++] ?? g) : g));
  }
  return out;
}

// ---- editing --------------------------------------------------------------------------------

/** The state after hiding or showing a group. */
export function setGroupHidden(
  state: RibbonCustomState,
  groupId: string,
  hidden: boolean,
): RibbonCustomState {
  const set = new Set(state.hiddenGroups);
  if (hidden) set.add(groupId);
  else set.delete(groupId);
  return { ...state, hiddenGroups: [...set] };
}

/** The state after hiding or showing one item inside a group. */
export function setItemHidden(
  state: RibbonCustomState,
  groupId: string,
  id: string,
  hidden: boolean,
): RibbonCustomState {
  const set = new Set(state.hiddenItems);
  const key = `${groupId}/${id}`;
  if (hidden) set.add(key);
  else set.delete(key);
  return { ...state, hiddenItems: [...set] };
}

/** Moves a value one place earlier (`-1`) or later (`+1`) in a list of ids. */
export function moveInList(
  ids: ReadonlyArray<string>,
  id: string,
  direction: -1 | 1,
): ReadonlyArray<string> {
  const from = ids.indexOf(id);
  if (from < 0) return ids;
  const to = from + direction;
  if (to < 0 || to >= ids.length) return ids;
  const out = [...ids];
  const [moved] = out.splice(from, 1);
  if (moved !== undefined) out.splice(to, 0, moved);
  return out;
}

/** The state after moving a group within its tab. `current` is the tab's group ids as drawn. */
export function moveGroup(
  state: RibbonCustomState,
  tab: string,
  current: ReadonlyArray<string>,
  groupId: string,
  direction: -1 | 1,
): RibbonCustomState {
  const order = moveInList(state.groupOrder[tab] ?? current, groupId, direction);
  return { ...state, groupOrder: { ...state.groupOrder, [tab]: order } };
}

/** The state after moving an item within its group. `current` is the group's item ids as drawn. */
export function moveItem(
  state: RibbonCustomState,
  groupId: string,
  current: ReadonlyArray<string>,
  id: string,
  direction: -1 | 1,
): RibbonCustomState {
  const order = moveInList(state.itemOrder[groupId] ?? current, id, direction);
  return { ...state, itemOrder: { ...state.itemOrder, [groupId]: order } };
}

/**
 * The customisation as it is written to `settings.json`.
 *
 * The two orders are arrays of entries rather than the maps used in memory, because a ribbon
 * group id has dots in it (`home.clipboard`) and the settings store is a dotted tree: a map keyed
 * that way would come back as `{ home: { clipboard: … } }`. See the note on `flatten` in
 * `src/shared/settings.ts`.
 */
export interface StoredRibbonCustom {
  readonly hiddenGroups: ReadonlyArray<string>;
  readonly hiddenItems: ReadonlyArray<string>;
  readonly groupOrder: ReadonlyArray<{
    readonly tab: string;
    readonly order: ReadonlyArray<string>;
  }>;
  readonly itemOrder: ReadonlyArray<{
    readonly group: string;
    readonly order: ReadonlyArray<string>;
  }>;
}

/** The state in the form that survives the store. Sorted, so the file has a stable diff. */
export function toStoredCustom(state: RibbonCustomState): StoredRibbonCustom {
  return {
    hiddenGroups: [...state.hiddenGroups].sort(),
    hiddenItems: [...state.hiddenItems].sort(),
    groupOrder: Object.keys(state.groupOrder)
      .sort()
      .map((tab) => ({ tab, order: state.groupOrder[tab] ?? [] })),
    itemOrder: Object.keys(state.itemOrder)
      .sort()
      .map((group) => ({ group, order: state.itemOrder[group] ?? [] })),
  };
}

/**
 * Validates a stored blob. Everything is optional and anything of the wrong shape is dropped: a
 * hand-edited or half-migrated settings file must cost the reader their customisation at worst,
 * never their ribbon. Both the array form written today and a plain map are accepted.
 */
export function readCustomState(value: unknown): RibbonCustomState {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return EMPTY_CUSTOM;
  const raw = value as Record<string, unknown>;
  return {
    hiddenGroups: stringArray(raw['hiddenGroups']),
    hiddenItems: stringArray(raw['hiddenItems']),
    groupOrder: orderMap(raw['groupOrder'], 'tab'),
    itemOrder: orderMap(raw['itemOrder'], 'group'),
  };
}

/** Reads an order table from either the stored array of entries or a plain map. */
function orderMap(
  value: unknown,
  nameKey: 'tab' | 'group',
): Readonly<Record<string, ReadonlyArray<string>>> {
  if (!Array.isArray(value)) return stringArrayMap(value);
  const out: Record<string, ReadonlyArray<string>> = {};
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const name = record[nameKey];
    const order = stringArray(record['order']);
    if (typeof name === 'string' && name !== '' && order.length > 0) out[name] = order;
  }
  return out;
}

function stringArray(value: unknown): ReadonlyArray<string> {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function stringArrayMap(value: unknown): Readonly<Record<string, ReadonlyArray<string>>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const out: Record<string, ReadonlyArray<string>> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const list = stringArray(raw);
    if (list.length > 0) out[key] = list;
  }
  return out;
}

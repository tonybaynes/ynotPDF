/**
 * Ribbon model (M02): turns manifests + the current context into the tabs and groups to draw.
 * Pure — no DOM — so it is unit-tested directly and the Ribbon view only renders what it
 * returns. Contextual tabs are filtered by their `when()`; groups by theirs; the items are
 * normalised so the view never has to special-case a bare command-id string again.
 */

import type {
  CommandSpec,
  RibbonGroupSpec,
  RibbonItemSpec,
  RibbonItemSize,
  RibbonTabId,
  RibbonTabSpec,
  ServiceContext,
} from '@shared/module';

/** The built-in tabs in Foxit order. File is a real tab; the shell builds its groups (`fileTab.ts`). */
export const BUILT_IN_TABS: ReadonlyArray<{ id: RibbonTabId; label: string }> = [
  { id: 'file', label: 'File' },
  { id: 'home', label: 'Home' },
  { id: 'edit', label: 'Edit' },
  { id: 'comment', label: 'Comment' },
  { id: 'view', label: 'View' },
  { id: 'form', label: 'Form' },
  { id: 'protect', label: 'Protect' },
  { id: 'organize', label: 'Organize' },
  { id: 'convert', label: 'Convert' },
  { id: 'accessibility', label: 'Accessibility' },
  { id: 'help', label: 'Help' },
];

export type ItemKind = Exclude<RibbonItemSpec, string>['kind'] | 'separator';

/** A normalised ribbon control. `spec` is the original object form (absent for plain buttons). */
export interface RibbonItemModel {
  readonly kind: ItemKind;
  /** Stable id for DOM/keytips: the command id, or the spec's own id. */
  readonly id: string;
  readonly command: string | undefined;
  readonly label: string;
  readonly icon: string | undefined;
  readonly size: RibbonItemSize;
  readonly keyTip: string | undefined;
  readonly spec: Exclude<RibbonItemSpec, string> | null;
}

export interface RibbonGroupModel {
  readonly id: string;
  readonly label: string;
  readonly items: ReadonlyArray<RibbonItemModel>;
}

export interface RibbonTabModel {
  readonly id: string;
  readonly label: string;
  readonly contextual: boolean;
  readonly groups: ReadonlyArray<RibbonGroupModel>;
}

/** What the model needs from the registry (narrow so tests pass plain objects). */
export interface RibbonSource {
  ribbonGroups(): ReadonlyArray<RibbonGroupSpec>;
  ribbonTabs(): ReadonlyArray<RibbonTabSpec>;
  get(commandId: string): CommandSpec | undefined;
  context(): ServiceContext;
}

function safeWhen(
  when: ((ctx: ServiceContext) => boolean) | undefined,
  ctx: ServiceContext,
): boolean {
  if (!when) return true;
  try {
    return when(ctx);
  } catch (error) {
    console.warn('ribbon: when() threw', error);
    return false;
  }
}

/** Normalises one item. Unknown command ids still render (disabled) so a typo is visible. */
export function normalizeItem(
  item: RibbonItemSpec,
  group: RibbonGroupSpec,
  source: RibbonSource,
): RibbonItemModel {
  const large = new Set(group.large ?? []);
  if (typeof item === 'string') {
    if (item === '-') {
      return {
        kind: 'separator',
        id: '-',
        command: undefined,
        label: '',
        icon: undefined,
        size: 'small',
        keyTip: undefined,
        spec: null,
      };
    }
    const cmd = source.get(item);
    return {
      kind: 'button',
      id: item,
      command: item,
      label: cmd?.label ?? item,
      icon: cmd?.icon,
      size: large.has(item) ? 'large' : 'small',
      keyTip: cmd?.keyTip,
      spec: null,
    };
  }
  const commandId = 'command' in item ? item.command : undefined;
  const cmd = commandId ? source.get(commandId) : undefined;
  const ownId = 'id' in item ? item.id : (commandId ?? '');
  const label = 'label' in item && item.label ? item.label : (cmd?.label ?? ownId);
  const icon = 'icon' in item && item.icon ? item.icon : cmd?.icon;
  const size: RibbonItemSize =
    'size' in item && item.size
      ? item.size
      : large.has(ownId) || (commandId !== undefined && large.has(commandId))
        ? 'large'
        : 'small';
  return {
    kind: item.kind,
    id: ownId,
    command: commandId,
    label,
    icon,
    size,
    keyTip: cmd?.keyTip,
    spec: item,
  };
}

/** Groups of one tab, `when`-filtered and normalised. Empty groups are dropped. */
export function groupsFor(tabId: string, source: RibbonSource): RibbonGroupModel[] {
  const ctx = source.context();
  const out: RibbonGroupModel[] = [];
  for (const g of source.ribbonGroups()) {
    if (g.tab !== tabId) continue;
    if (!safeWhen(g.when, ctx)) continue;
    const items = g.items
      .map((i) => normalizeItem(i, g, source))
      .filter((i) => {
        if (i.kind === 'separator') return true;
        const when = i.spec && 'when' in i.spec ? i.spec.when : undefined;
        return safeWhen(when, ctx);
      });
    // Drop leading/trailing/double separators left by filtered items.
    const cleaned: RibbonItemModel[] = [];
    for (const i of items) {
      if (
        i.kind === 'separator' &&
        (cleaned.length === 0 || cleaned[cleaned.length - 1]?.kind === 'separator')
      )
        continue;
      cleaned.push(i);
    }
    while (cleaned.length && cleaned[cleaned.length - 1]?.kind === 'separator') cleaned.pop();
    if (cleaned.length === 0) continue;
    out.push({ id: g.id, label: g.label, items: cleaned });
  }
  return out;
}

/**
 * The tab strip: every built-in tab (in Foxit order) followed by the contextual tabs whose
 * `when()` holds, each with its groups.
 */
export function buildRibbon(source: RibbonSource): RibbonTabModel[] {
  const ctx = source.context();
  const tabs: RibbonTabModel[] = BUILT_IN_TABS.map((t) => ({
    id: t.id,
    label: t.label,
    contextual: false,
    groups: groupsFor(t.id, source),
  }));
  const contextual = [...source.ribbonTabs()]
    .filter((t) => safeWhen(t.when, ctx))
    .sort((a, b) => (a.order ?? 100) - (b.order ?? 100) || a.id.localeCompare(b.id));
  for (const t of contextual) {
    tabs.push({ id: t.id, label: t.label, contextual: true, groups: groupsFor(t.id, source) });
  }
  return tabs;
}

/**
 * Per-item dynamic state used for granular re-rendering: a group re-renders only when its
 * signature changes.
 */
export interface ItemState {
  readonly enabled: boolean;
  readonly pressed: boolean | null;
  readonly value: string | null;
}

export interface StateSource {
  isEnabled(commandId: string): boolean;
  context(): ServiceContext;
}

export function itemState(item: RibbonItemModel, source: StateSource): ItemState {
  const ctx = source.context();
  const enabled = item.command ? source.isEnabled(item.command) : true;
  let pressed: boolean | null = null;
  let value: string | null = null;
  const spec = item.spec;
  if (spec) {
    try {
      if (spec.kind === 'toggle') pressed = spec.pressed(ctx);
      else if (spec.kind === 'gallery') value = spec.selected?.(ctx) ?? null;
      else if (spec.kind === 'color' || spec.kind === 'input') value = spec.value(ctx);
    } catch (error) {
      console.warn(`ribbon: state of ${item.id} threw`, error);
    }
  }
  return { enabled, pressed, value };
}

/** A cheap string that changes when any item's dynamic state changes. */
export function groupSignature(group: RibbonGroupModel, source: StateSource): string {
  return group.items
    .map((i) => {
      if (i.kind === 'separator') return '|';
      const s = itemState(i, source);
      return `${i.id}:${s.enabled ? 1 : 0}${s.pressed === null ? '-' : s.pressed ? 1 : 0}${s.value ?? ''}`;
    })
    .join(';');
}

/** Signature of the whole tab strip structure (tabs and group ids), for structural re-render. */
export function ribbonSignature(tabs: ReadonlyArray<RibbonTabModel>): string {
  return tabs
    .map(
      (t) =>
        `${t.id}[${t.groups.map((g) => `${g.id}(${g.items.map((i) => i.id).join(',')})`).join(' ')}]`,
    )
    .join(' ');
}

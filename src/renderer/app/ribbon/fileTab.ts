/**
 * The File tab (M02). The operator wants File to behave like every other tab — a horizontal
 * ribbon under the tab strip, not a full-window panel — so the shell builds its groups from the
 * same `BackstageSpec` slots modules fill (ADR 0004): Open, Recent (a dropdown of recent files,
 * pinned first), New (a dropdown of creators), Save, Save As, Print, Properties, Preferences,
 * Exit. A slot nobody has filled renders as a disabled button whose tooltip says "Not available
 * yet". A slot filled with a `mount` page opens that page in a non-modal dialog.
 */

import type { Registry } from '@core/Registry';
import { hasBridge, invoke, on, type RecentFile } from '@shared/ipc';
import type {
  BackstageSlot,
  BackstageSpec,
  CreatorSpec,
  MenuItemSpec,
  RibbonGroupSpec,
  RibbonItemSpec,
} from '@shared/module';
import { BACKSTAGE_SLOTS } from '../backstage/Backstage';
import type { Dialogs } from '../dialog/Dialogs';
import { el } from '../dom';

/** Keeps the recent-files list in sync with main so the Recent dropdown is always current. */
export class RecentCache {
  private files: RecentFile[] = [];
  private readonly listeners = new Set<() => void>();
  private unsub: (() => void) | null = null;

  start(): void {
    if (!hasBridge()) return;
    void invoke('recent:list').then((list) => {
      this.files = list;
      this.notify();
    });
    this.unsub = on('recent:changed', (list) => {
      this.files = list;
      this.notify();
    });
  }

  get list(): ReadonlyArray<RecentFile> {
    return this.files;
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  dispose(): void {
    this.unsub?.();
  }

  private notify(): void {
    for (const l of Array.from(this.listeners)) l();
  }
}

export interface FileTabDeps {
  readonly registry: Registry;
  readonly recent: RecentCache;
  readonly dialogs: Dialogs;
}

const SLOT_ICON: Record<BackstageSlot, string> = Object.fromEntries(
  BACKSTAGE_SLOTS.map((s) => [s.id, s.icon]),
) as Record<BackstageSlot, string>;

function filledSlots(registry: Registry): Map<BackstageSlot, BackstageSpec> {
  const map = new Map<BackstageSlot, BackstageSpec>();
  const ctx = registry.context();
  for (const m of registry.modules()) {
    for (const s of m.backstage ?? []) {
      if (s.when && !s.when(ctx)) continue;
      if (!map.has(s.slot)) map.set(s.slot, s);
    }
  }
  return map;
}

function creators(registry: Registry): CreatorSpec[] {
  const ctx = registry.context();
  const out: CreatorSpec[] = [];
  for (const m of registry.modules()) out.push(...(m.creators ?? []));
  return out
    .filter((c) => !c.when || c.when(ctx))
    .sort((a, b) => (a.order ?? 100) - (b.order ?? 100) || a.label.localeCompare(b.label));
}

/** Menu of recent files for the Recent dropdown, pinned first, plus "Clear unpinned". */
export function recentMenu(recent: ReadonlyArray<RecentFile>): MenuItemSpec[] {
  if (recent.length === 0) return [{ label: 'No recent files yet' }];
  const items: MenuItemSpec[] = recent.map((f) => ({
    label: f.name,
    icon: f.pinned ? 'pin' : 'file-text',
    command: 'file.openRecent',
    args: { path: f.path },
  }));
  items.push('-', { label: 'Clear unpinned', command: 'file.recent.clear', icon: 'trash-2' });
  return items;
}

/** Menu of creators for the New dropdown. */
export function creatorMenu(list: ReadonlyArray<CreatorSpec>): MenuItemSpec[] {
  if (list.length === 0) return [{ label: 'No document creators yet (arrives with M91)' }];
  return list.map((c) => ({
    label: c.label,
    ...(c.icon ? { icon: c.icon } : {}),
    command: c.command,
  }));
}

/**
 * Opens a slot's mounted page (Properties, Preferences…) as a non-modal dialog. The page keeps
 * the id `file-page-<slot>` so tests and modules can find it.
 */
export function openSlotPage(
  registry: Registry,
  dialogs: Dialogs,
  slot: BackstageSlot,
  spec: BackstageSpec,
): void {
  if (!spec.mount) return;
  const label = spec.label ?? BACKSTAGE_SLOTS.find((s) => s.id === slot)?.label ?? slot;
  let dispose: (() => void) | null = null;
  const handle = dialogs.open({
    id: `file-page-${slot}`,
    title: label,
    modal: false,
    width: 720,
    content: (body) => {
      const host = el('div.file-page', { 'data-page': slot });
      body.append(host);
      dispose = spec.mount?.(host, registry.context()) ?? null;
    },
    buttons: [{ id: 'close', label: 'Close', primary: true }],
    initialFocus: 'first',
  });
  void handle.result.then(() => {
    dispose?.();
  });
}

/**
 * The File tab's ribbon groups, rebuilt on every ribbon refresh (cheap: a handful of specs).
 * The slot commands `file.<slot>.action` are registered by the M02 manifest and dispatch here.
 */
export function fileTabGroups(deps: FileTabDeps): RibbonGroupSpec[] {
  const filled = filledSlots(deps.registry);
  const slotItem = (slot: BackstageSlot): RibbonItemSpec => {
    if (slot === 'open') return { kind: 'button', command: 'file.open', size: 'large' };
    const def = BACKSTAGE_SLOTS.find((s) => s.id === slot);
    const spec = filled.get(slot);
    const label = spec?.label ?? def?.label ?? slot;
    const icon = spec?.icon ?? SLOT_ICON[slot];
    if (spec?.command) return { kind: 'button', command: spec.command, label, icon, size: 'large' };
    if (spec?.mount) {
      return { kind: 'button', command: `file.slot.${slot}`, label, icon, size: 'large' };
    }
    return {
      kind: 'button',
      command: `file.slot.${slot}`,
      label,
      icon,
      size: 'large',
      title: `${label} — not available yet`,
    };
  };
  const recentDropdown: RibbonItemSpec = {
    kind: 'dropdown',
    id: 'file.recent',
    label: 'Recent',
    icon: 'history',
    size: 'large',
    menu: () => recentMenu(deps.recent.list),
  };
  const newDropdown: RibbonItemSpec = {
    kind: 'dropdown',
    id: 'file.new',
    label: 'New',
    icon: 'file-plus',
    size: 'large',
    menu: () => creatorMenu(creators(deps.registry)),
  };
  return [
    {
      id: 'file.open',
      tab: 'file',
      label: 'Open',
      order: 1,
      items: [slotItem('open'), recentDropdown, newDropdown],
    },
    {
      id: 'file.save',
      tab: 'file',
      label: 'Save & print',
      order: 2,
      items: [slotItem('save'), slotItem('saveAs'), slotItem('print')],
    },
    {
      id: 'file.document',
      tab: 'file',
      label: 'Document',
      order: 3,
      items: [slotItem('properties'), slotItem('preferences')],
    },
    { id: 'file.exit', tab: 'file', label: 'Application', order: 4, items: [slotItem('exit')] },
  ];
}

/** Whether a slot is filled (used by the `file.slot.<slot>` commands' `when`). */
export function slotState(
  registry: Registry,
  slot: BackstageSlot,
): { filled: boolean; spec: BackstageSpec | undefined } {
  const spec = filledSlots(registry).get(slot);
  return {
    filled: spec !== undefined && (spec.command !== undefined || spec.mount !== undefined),
    spec,
  };
}

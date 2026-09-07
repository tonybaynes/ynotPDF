/**
 * Menus (M02): dropdowns, split-button menus, submenus and context menus share this one
 * widget. Built from `MenuItemSpec`s (a command id, `"-"`, or an object with label / args /
 * submenu / checked). Keyboard: arrows move, Home/End jump, Enter/Space activates, Right opens
 * a submenu, Left closes it, typing a letter jumps to the next item starting with it, Escape
 * closes (handled by the popup layer).
 *
 * Checked items carry `aria-checked` and a tick icon plus the word "on" for screen readers —
 * status is never colour alone.
 */

import { formatShortcut, type Registry } from '@core/Registry';
import type { MenuItemSpec } from '@shared/module';
import { el, srOnly } from './dom';
import { icon } from './icons';
import { closeAllPopups, openPopup, type Placement, type PopupHandle } from './popup';

export interface MenuOptions {
  readonly anchor: HTMLElement | { x: number; y: number };
  readonly items: ReadonlyArray<MenuItemSpec>;
  readonly registry: Registry;
  readonly isMac: boolean;
  readonly parent?: PopupHandle | null;
  readonly placement?: Placement;
  readonly align?: 'start' | 'end';
  readonly label?: string;
  /** Extra class for the popup container. */
  readonly className?: string;
  /** Called after an item ran (the popup chain is closed already). */
  readonly onSelect?: (commandId: string) => void;
  /** Where focus returns after the menu closes (default: the anchor). */
  readonly restoreFocusTo?: HTMLElement | null;
}

interface ResolvedItem {
  readonly label: string;
  readonly command: string | undefined;
  readonly args: Readonly<Record<string, unknown>> | undefined;
  readonly icon: string | undefined;
  readonly submenu: ReadonlyArray<MenuItemSpec> | undefined;
  readonly checked: boolean | null;
  readonly enabled: boolean;
  readonly shortcut: string | undefined;
}

/** Resolves a spec against the registry; `null` for separators, `undefined` when `when` hides it. */
export function resolveMenuItem(
  spec: MenuItemSpec,
  registry: Registry,
): ResolvedItem | null | undefined {
  if (spec === '-') return null;
  const ctx = registry.context();
  if (typeof spec === 'string') {
    const cmd = registry.get(spec);
    return {
      label: cmd?.label ?? spec,
      command: spec,
      args: undefined,
      icon: cmd?.icon,
      submenu: undefined,
      checked: null,
      enabled: cmd ? registry.isEnabled(spec) : false,
      shortcut: registry.shortcutFor(spec),
    };
  }
  if (spec.when && !spec.when(ctx)) return undefined;
  const cmd = spec.command ? registry.get(spec.command) : undefined;
  let checked: boolean | null = null;
  if (spec.checked) {
    try {
      checked = spec.checked(ctx);
    } catch {
      checked = false;
    }
  }
  return {
    label: spec.label ?? cmd?.label ?? spec.command ?? '',
    command: spec.command,
    args: spec.args,
    icon: spec.icon ?? cmd?.icon,
    submenu: spec.submenu,
    checked,
    enabled: spec.submenu ? true : spec.command ? registry.isEnabled(spec.command) : false,
    shortcut: spec.command ? registry.shortcutFor(spec.command) : undefined,
  };
}

/** Opens a menu popup and returns its handle. */
export function openMenu(options: MenuOptions): PopupHandle {
  const { registry, isMac } = options;
  const list = el('ul.menu', { role: 'menu', 'aria-label': options.label });
  const entries: { element: HTMLElement; item: ResolvedItem }[] = [];
  let handle: PopupHandle | null = null;
  let submenu: PopupHandle | null = null;

  const closeSubmenu = (): void => {
    submenu?.close();
    submenu = null;
  };

  const activate = async (item: ResolvedItem, element: HTMLElement): Promise<void> => {
    if (!item.enabled) return;
    if (item.submenu) {
      openSub(item, element);
      return;
    }
    if (!item.command) return;
    const id = item.command;
    // Close the whole chain first so the command's own UI (a dialog) gets focus.
    closeAllPopups('select');
    try {
      await registry.run(id, item.args ?? {});
    } catch (error) {
      console.error(`menu command ${id} failed`, error);
    }
    options.onSelect?.(id);
  };

  const openSub = (item: ResolvedItem, element: HTMLElement): void => {
    if (!item.submenu || !handle) return;
    closeSubmenu();
    submenu = openMenu({
      anchor: element,
      items: item.submenu,
      registry,
      isMac,
      parent: handle,
      placement: 'right',
      label: item.label,
      ...(options.onSelect ? { onSelect: options.onSelect } : {}),
    });
  };

  let lastWasSeparator = true;
  for (const spec of options.items) {
    const item = resolveMenuItem(spec, registry);
    if (item === undefined) continue;
    if (item === null) {
      if (lastWasSeparator) continue;
      list.append(el('li.menu-separator', { role: 'separator' }));
      lastWasSeparator = true;
      continue;
    }
    lastWasSeparator = false;
    const li = el('li.menu-item', {
      role: item.checked === null ? 'menuitem' : 'menuitemcheckbox',
      tabindex: -1,
      'aria-disabled': item.enabled ? undefined : 'true',
      'aria-checked': item.checked === null ? undefined : item.checked ? 'true' : 'false',
      'aria-haspopup': item.submenu ? 'menu' : undefined,
      'data-command': item.command,
    });
    const check = el('span.menu-check');
    if (item.checked) {
      check.append(icon('check'), srOnly(' (on)'));
    } else if (item.icon) {
      check.append(icon(item.icon));
    }
    const label = el('span.menu-label', null, item.label);
    li.append(check, label);
    if (item.shortcut) li.append(el('kbd.menu-key', null, formatShortcut(item.shortcut, isMac)));
    if (item.submenu) li.append(el('span.menu-arrow', null, icon('chevron-right')));
    li.addEventListener('click', (e) => {
      e.stopPropagation();
      void activate(item, li);
    });
    li.addEventListener('pointerenter', () => {
      li.focus();
      if (item.submenu && item.enabled) openSub(item, li);
      else closeSubmenu();
    });
    entries.push({ element: li, item });
    list.append(li);
  }
  if (list.lastElementChild?.classList.contains('menu-separator')) list.lastElementChild.remove();
  if (entries.length === 0) {
    list.append(
      el(
        'li.menu-item.menu-empty',
        { role: 'menuitem', 'aria-disabled': 'true' },
        'Nothing to show',
      ),
    );
  }

  const focusIndex = (i: number): void => {
    const n = entries.length;
    if (n === 0) return;
    const idx = ((i % n) + n) % n;
    entries[idx]?.element.focus();
  };
  const current = (): number => entries.findIndex((e) => e.element === document.activeElement);

  list.addEventListener('keydown', (e) => {
    switch (e.key) {
      case 'ArrowDown':
        focusIndex(current() + 1);
        break;
      case 'ArrowUp':
        focusIndex(current() - 1);
        break;
      case 'Home':
        focusIndex(0);
        break;
      case 'End':
        focusIndex(entries.length - 1);
        break;
      case 'Enter':
      case ' ': {
        const entry = entries[current()];
        if (entry) void activate(entry.item, entry.element);
        break;
      }
      case 'ArrowRight': {
        const entry = entries[current()];
        if (entry?.item.submenu) openSub(entry.item, entry.element);
        else return;
        break;
      }
      case 'ArrowLeft':
        if (options.parent) handle?.close('programmatic');
        else return;
        break;
      default: {
        if (e.key.length !== 1 || e.ctrlKey || e.metaKey || e.altKey) return;
        const ch = e.key.toLowerCase();
        const start = current();
        for (let k = 1; k <= entries.length; k++) {
          const entry = entries[(start + k) % entries.length];
          if (entry?.item.label.toLowerCase().startsWith(ch)) {
            entry.element.focus();
            break;
          }
        }
      }
    }
    e.preventDefault();
    e.stopPropagation();
  });

  handle = openPopup({
    anchor: options.anchor,
    content: list,
    placement: options.placement ?? 'below',
    ...(options.align ? { align: options.align } : {}),
    role: 'presentation',
    ...(options.label !== undefined ? { label: options.label } : {}),
    className: `menu-popup${options.className ? ` ${options.className}` : ''}`,
    parent: options.parent ?? null,
    ...(options.restoreFocusTo !== undefined ? { restoreFocusTo: options.restoreFocusTo } : {}),
    autoFocus: false,
    onClose: () => {
      closeSubmenu();
    },
  });
  focusIndex(0);
  return handle;
}

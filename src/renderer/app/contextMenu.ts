/**
 * Context-menu service (M02). Modules contribute items through `ModuleManifest.contextMenus`
 * (region + items) or at runtime with `append()`. A right-click (or Shift+F10 / the Menu key)
 * collects every contribution whose region matches the target — a named shell region, `'any'`,
 * or a CSS selector matched against the element and its ancestors — sorts them by `order` and
 * opens one menu, separated per contribution.
 */

import type { Registry } from '@core/Registry';
import type { ContextMenuSpec, MenuItemSpec } from '@shared/module';
import { regionOf } from './dom';
import { openMenu } from './menu';
import type { PopupHandle } from './popup';

export interface ContextMenuOpenOptions {
  /** Position; defaults to the target's bounding box for keyboard-opened menus. */
  readonly x?: number;
  readonly y?: number;
  readonly target: Element | null;
}

const REGION_MAP: Record<string, string> = {
  document: 'document',
  tab: 'tab',
  'left-pane': 'left-pane',
  'right-pane': 'right-pane',
  ribbon: 'ribbon',
  status: 'status',
};

export class ContextMenus {
  private readonly runtime: ContextMenuSpec[] = [];
  private current: PopupHandle | null = null;

  private readonly registry: Registry;
  private readonly isMac: boolean;

  constructor(registry: Registry, isMac: boolean) {
    this.registry = registry;
    this.isMac = isMac;
  }

  /** Adds a contribution at runtime; returns a disposer. */
  append(spec: ContextMenuSpec): () => void {
    this.runtime.push(spec);
    return () => {
      const i = this.runtime.indexOf(spec);
      if (i >= 0) this.runtime.splice(i, 1);
    };
  }

  /** Every contribution: manifests first, then runtime. */
  all(): ContextMenuSpec[] {
    const out: ContextMenuSpec[] = [];
    for (const m of this.registry.modules()) out.push(...(m.contextMenus ?? []));
    out.push(...this.runtime);
    return out;
  }

  /** The items that apply to `target`, in order, separated per contribution. */
  itemsFor(target: Element | null): MenuItemSpec[] {
    const region = regionOf(target);
    const tabEl = target instanceof Element ? target.closest('[data-tab-id]') : null;
    const ctx = this.registry.context();
    const matching = this.all()
      .filter((c) => {
        if (c.when && !c.when(ctx)) return false;
        if (c.region === 'any') return true;
        if (c.region === 'tab') return tabEl !== null;
        if (REGION_MAP[c.region]) return region === c.region;
        // CSS selector
        try {
          return target instanceof Element && target.closest(c.region) !== null;
        } catch {
          return false;
        }
      })
      .sort((a, b) => (a.order ?? 100) - (b.order ?? 100) || a.id.localeCompare(b.id));
    const items: MenuItemSpec[] = [];
    for (const c of matching) {
      if (items.length) items.push('-');
      items.push(...c.items);
    }
    return items;
  }

  /** Opens the menu for a target. Returns `null` when nothing applies. */
  open(options: ContextMenuOpenOptions): PopupHandle | null {
    this.current?.close();
    const items = this.itemsFor(options.target);
    if (items.length === 0) return null;
    const anchorEl = options.target instanceof HTMLElement ? options.target : null;
    const anchor =
      options.x !== undefined && options.y !== undefined
        ? { x: options.x, y: options.y }
        : (anchorEl ?? { x: 0, y: 0 });
    this.current = openMenu({
      anchor,
      items,
      registry: this.registry,
      isMac: this.isMac,
      label: 'Context menu',
      className: 'context-menu',
      restoreFocusTo: anchorEl,
    });
    return this.current;
  }

  /** Installs the right-click and keyboard listeners on `root`. */
  install(root: HTMLElement): () => void {
    const onContext = (e: MouseEvent): void => {
      const target = e.target as Element | null;
      // Native menus stay for text inputs (cut/copy/paste) unless a contribution targets them.
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
        if (this.itemsFor(target).length === 0) return;
      }
      e.preventDefault();
      // Keyboard-originated contextmenu events carry (0,0) or the element position.
      const fromKeyboard = e.button === 0 && e.clientX === 0 && e.clientY === 0;
      this.open(fromKeyboard ? { target } : { x: e.clientX, y: e.clientY, target });
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
        e.preventDefault();
        this.open({ target: document.activeElement });
      }
    };
    root.addEventListener('contextmenu', onContext);
    root.addEventListener('keydown', onKey);
    return () => {
      root.removeEventListener('contextmenu', onContext);
      root.removeEventListener('keydown', onKey);
    };
  }
}

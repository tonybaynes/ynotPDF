/**
 * Focus model (M02).
 *
 * - **Regions**: the shell marks its five regions with `data-region` (ribbon, document,
 *   left-pane, right-pane, status). F6 / Shift+F6 cycle through the ones that are visible,
 *   focusing the region's remembered control (or its first focusable one).
 * - **Roving tabindex**: a toolbar is one Tab stop; arrow keys move between its controls.
 *   `makeRoving()` installs that behaviour on any container and keeps `tabindex` in step as
 *   controls appear and disappear.
 *
 * The visible focus ring itself is the theme's two-ring `:focus-visible` (M01) and is never
 * removed anywhere in the shell.
 */

import { focusables, isVisible } from './dom';
import { REGIONS, type Region, type UiStore } from './ui/UiState';

const lastFocused = new Map<Region, HTMLElement>();

export function regionElement(region: Region): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-region="${region}"]`);
}

/** Focuses a region: its last-focused control if still there, else the first focusable. */
export function focusRegion(region: Region): boolean {
  const root = regionElement(region);
  if (!root || !isVisible(root)) return false;
  const remembered = lastFocused.get(region);
  if (remembered && root.contains(remembered) && isVisible(remembered)) {
    remembered.focus();
    return true;
  }
  const roving = root.querySelector<HTMLElement>('[data-roving] [tabindex="0"]');
  const target = roving ?? focusables(root)[0] ?? root;
  if (target === root && !root.hasAttribute('tabindex')) root.tabIndex = -1;
  target.focus();
  return true;
}

/** The region containing `element`, if any. */
export function regionOfElement(element: Element | null): Region | null {
  const r = element?.closest<HTMLElement>('[data-region]')?.dataset['region'];
  return REGIONS.includes(r as Region) ? (r as Region) : null;
}

/** Moves to the next/previous visible region in F6 order. Returns the region focused. */
export function cycleRegion(ui: UiStore, direction: 1 | -1): Region | null {
  const from = regionOfElement(document.activeElement) ?? ui.get().region;
  const visible = REGIONS.filter((r) => {
    const e = regionElement(r);
    return e !== null && isVisible(e);
  });
  if (visible.length === 0) return null;
  const idx = visible.indexOf(from);
  for (let k = 1; k <= visible.length; k++) {
    const next = visible[(idx + k * direction + visible.length * 2) % visible.length];
    if (next && focusRegion(next)) {
      ui.set({ region: next });
      return next;
    }
  }
  return null;
}

/** Installs the focus tracking that remembers the last control per region. */
export function installFocusTracking(ui: UiStore): () => void {
  const onFocus = (e: FocusEvent): void => {
    const target = e.target;
    if (!(target instanceof HTMLElement)) return;
    const region = regionOfElement(target);
    if (!region) return;
    lastFocused.set(region, target);
    if (ui.get().region !== region) ui.set({ region });
  };
  document.addEventListener('focusin', onFocus);
  return () => {
    document.removeEventListener('focusin', onFocus);
  };
}

export interface RovingOptions {
  /** Selector for the controls that take part. */
  readonly selector: string;
  readonly orientation?: 'horizontal' | 'vertical' | 'both';
  /** Wrap from last to first (default true). */
  readonly wrap?: boolean;
}

/**
 * Makes `container` a roving-tabindex group. Call `refresh()` after the children change; the
 * returned disposer removes the listeners.
 */
export function makeRoving(
  container: HTMLElement,
  options: RovingOptions,
): { refresh(): void; dispose(): void; focusFirst(): void } {
  container.dataset['roving'] = '';
  const orientation = options.orientation ?? 'horizontal';
  const items = (): HTMLElement[] =>
    Array.from(container.querySelectorAll<HTMLElement>(options.selector)).filter(
      (e) => !e.hasAttribute('disabled') && isVisible(e),
    );

  const refresh = (): void => {
    const list = items();
    const current =
      list.find((e) => e.tabIndex === 0) ?? list.find((e) => e.contains(document.activeElement));
    const active = current ?? list[0];
    for (const e of Array.from(container.querySelectorAll<HTMLElement>(options.selector))) {
      e.tabIndex = e === active ? 0 : -1;
    }
  };

  const move = (delta: number): void => {
    const list = items();
    if (list.length === 0) return;
    const idx = list.findIndex(
      (e) => e === document.activeElement || e.contains(document.activeElement),
    );
    let next = idx + delta;
    if (options.wrap !== false) next = (next + list.length) % list.length;
    else next = Math.max(0, Math.min(list.length - 1, next));
    const target = list[next];
    if (!target) return;
    for (const e of list) e.tabIndex = -1;
    target.tabIndex = 0;
    target.focus();
  };

  const onKey = (e: KeyboardEvent): void => {
    const target = e.target as HTMLElement | null;
    // Text inputs inside the toolbar keep their own arrow keys.
    if (
      target instanceof HTMLInputElement &&
      (target.type === 'text' || target.type === 'number' || target.type === 'range')
    ) {
      if (e.key !== 'Home' && e.key !== 'End') return;
      if (target.type === 'range') return;
    }
    if (target instanceof HTMLSelectElement) return;
    const h = orientation !== 'vertical';
    const v = orientation !== 'horizontal';
    if ((h && e.key === 'ArrowRight') || (v && e.key === 'ArrowDown')) move(1);
    else if ((h && e.key === 'ArrowLeft') || (v && e.key === 'ArrowUp')) move(-1);
    else if (e.key === 'Home') move(-1000);
    else if (e.key === 'End') move(1000);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };
  const onFocusIn = (e: FocusEvent): void => {
    const target = e.target;
    if (!(target instanceof HTMLElement)) return;
    const list = items();
    const item = list.find((i) => i === target || i.contains(target));
    if (!item) return;
    for (const i of list) i.tabIndex = i === item ? 0 : -1;
  };
  container.addEventListener('keydown', onKey);
  container.addEventListener('focusin', onFocusIn);
  refresh();
  return {
    refresh,
    focusFirst: () => {
      items()[0]?.focus();
    },
    dispose: () => {
      container.removeEventListener('keydown', onKey);
      container.removeEventListener('focusin', onFocusIn);
    },
  };
}

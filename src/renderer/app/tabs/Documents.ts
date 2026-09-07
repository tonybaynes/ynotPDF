/**
 * `Documents` — the open-document tabs (M02). Each entry is what the tab strip needs
 * (`title`, `path`, `dirty`); M20/M11 attach the real `Document` and viewport by tab id through
 * `attach()`. Closing runs the `beforeClose` hooks (M21 plugs Save / Don't save / Cancel in
 * here); the shell's default hook asks "Close without saving?" only when no other hook exists.
 *
 * Pure enough to unit-test in Node: no DOM, only the Store.
 */

import { createStore, type Store, type Unsubscribe } from '@core/Store';

export interface DocumentTab {
  readonly id: string;
  readonly title: string;
  /** Absolute path, or `null` for a new / unsaved document. */
  readonly path: string | null;
  readonly dirty: boolean;
  readonly readOnly: boolean;
}

export interface DocumentsState {
  readonly tabs: ReadonlyArray<DocumentTab>;
  readonly active: string | null;
}

export type CloseDecision = 'close' | 'cancel';
export type BeforeCloseHook = (tab: DocumentTab) => Promise<CloseDecision> | CloseDecision;

export interface OpenOptions {
  readonly title: string;
  readonly path?: string | null;
  readonly dirty?: boolean;
  readonly readOnly?: boolean;
  /** Reuse an id (a tab moved in from another window). */
  readonly id?: string;
  /** Activate the new tab (default true). */
  readonly activate?: boolean;
}

let counter = 0;

export class Documents {
  readonly store: Store<DocumentsState> = createStore<DocumentsState>({ tabs: [], active: null });
  private readonly hooks: BeforeCloseHook[] = [];
  private defaultHook: BeforeCloseHook | null = null;
  private readonly attachments = new Map<string, unknown>();
  private readonly closeListeners = new Set<(tab: DocumentTab) => void>();

  get state(): DocumentsState {
    return this.store.get();
  }

  get tabs(): ReadonlyArray<DocumentTab> {
    return this.state.tabs;
  }

  get active(): DocumentTab | null {
    const { tabs, active } = this.state;
    return tabs.find((t) => t.id === active) ?? null;
  }

  get(id: string): DocumentTab | null {
    return this.tabs.find((t) => t.id === id) ?? null;
  }

  /** Opens a tab. If a tab with the same non-null `path` exists it is activated instead. */
  open(options: OpenOptions): DocumentTab {
    const path = options.path ?? null;
    if (path) {
      const existing = this.tabs.find((t) => t.path === path);
      if (existing) {
        this.activate(existing.id);
        return existing;
      }
    }
    const tab: DocumentTab = {
      id: options.id ?? `tab-${++counter}`,
      title: options.title,
      path,
      dirty: options.dirty ?? false,
      readOnly: options.readOnly ?? false,
    };
    this.store.set((s) => ({
      tabs: [...s.tabs, tab],
      active: options.activate === false ? (s.active ?? tab.id) : tab.id,
    }));
    return tab;
  }

  activate(id: string): void {
    if (!this.get(id)) return;
    this.store.set({ active: id });
  }

  update(id: string, patch: Partial<Omit<DocumentTab, 'id'>>): void {
    this.store.set((s) => ({
      tabs: s.tabs.map((t) => (t.id === id ? { ...t, ...patch } : t)),
    }));
  }

  setDirty(id: string, dirty: boolean): void {
    this.update(id, { dirty });
  }

  /** Moves a tab to `toIndex` (clamped). */
  move(id: string, toIndex: number): void {
    this.store.set((s) => {
      const from = s.tabs.findIndex((t) => t.id === id);
      if (from < 0) return {};
      const tabs = [...s.tabs];
      const [tab] = tabs.splice(from, 1);
      if (!tab) return {};
      const to = Math.max(0, Math.min(toIndex, tabs.length));
      tabs.splice(to, 0, tab);
      return { tabs };
    });
  }

  /** Cycles the active tab; wraps around. */
  next(): DocumentTab | null {
    return this.step(1);
  }

  previous(): DocumentTab | null {
    return this.step(-1);
  }

  private step(dir: 1 | -1): DocumentTab | null {
    const { tabs, active } = this.state;
    if (tabs.length === 0) return null;
    const idx = tabs.findIndex((t) => t.id === active);
    const nextIdx = (idx + dir + tabs.length) % tabs.length;
    const tab = tabs[nextIdx];
    if (!tab) return null;
    this.activate(tab.id);
    return tab;
  }

  /**
   * Closes a tab after asking the `beforeClose` hooks. Resolves `true` when it closed. Hooks
   * run in registration order; the first `'cancel'` wins. Force skips the hooks (used when
   * a tab is moved to another window).
   */
  async close(id: string, options: { force?: boolean } = {}): Promise<boolean> {
    const tab = this.get(id);
    if (!tab) return false;
    if (!options.force) {
      const hooks = this.hooks.length ? this.hooks : this.defaultHook ? [this.defaultHook] : [];
      for (const hook of hooks) {
        if ((await hook(tab)) === 'cancel') return false;
      }
    }
    this.store.set((s) => {
      const idx = s.tabs.findIndex((t) => t.id === id);
      const tabs = s.tabs.filter((t) => t.id !== id);
      let active = s.active;
      if (active === id) {
        const neighbour = tabs[Math.min(idx, tabs.length - 1)];
        active = neighbour ? neighbour.id : null;
      }
      return { tabs, active };
    });
    this.attachments.delete(id);
    for (const l of Array.from(this.closeListeners)) l(tab);
    return true;
  }

  /** Closes every tab except `keepId`; stops at the first cancel. Resolves `true` if all closed. */
  async closeOthers(keepId: string): Promise<boolean> {
    for (const t of [...this.tabs]) {
      if (t.id === keepId) continue;
      if (!(await this.close(t.id))) return false;
    }
    return true;
  }

  async closeAll(): Promise<boolean> {
    for (const t of [...this.tabs]) {
      if (!(await this.close(t.id))) return false;
    }
    return true;
  }

  /** Registers a close hook (M21). Returns a disposer. */
  onBeforeClose(hook: BeforeCloseHook): Unsubscribe {
    this.hooks.push(hook);
    return () => {
      const i = this.hooks.indexOf(hook);
      if (i >= 0) this.hooks.splice(i, 1);
    };
  }

  /** The shell's fallback hook, used only while no module registered one. */
  setDefaultCloseHook(hook: BeforeCloseHook | null): void {
    this.defaultHook = hook;
  }

  /** Fires after a tab has closed (viewers dispose their resources). */
  onClosed(listener: (tab: DocumentTab) => void): Unsubscribe {
    this.closeListeners.add(listener);
    return () => {
      this.closeListeners.delete(listener);
    };
  }

  /** Attaches module state (a `Document`, a viewport) to a tab. */
  attach<T>(id: string, value: T): void {
    this.attachments.set(id, value);
  }

  attachment<T>(id: string): T | undefined {
    return this.attachments.get(id) as T | undefined;
  }

  subscribe(listener: (state: DocumentsState) => void): Unsubscribe {
    return this.store.subscribe(listener);
  }
}

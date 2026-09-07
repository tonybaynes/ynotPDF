/**
 * Persisted application settings (M01), backed by `electron-store` — JSON in the OS user-data
 * dir, no database (PLAN.md §4.4). Keys are dotted strings (`theme.name`, `ui.scale`);
 * `electron-store` treats dots as a path, which is exactly the namespacing modules want.
 * M130's preferences UI is built on the same two IPC channels.
 */

import Store from 'electron-store';

interface SettingsSchema {
  /** Schema version so M130 can migrate. */
  version: number;
  [key: string]: unknown;
}

const SCHEMA_VERSION = 1;

export class Settings {
  private readonly store: Store<SettingsSchema>;

  constructor(cwd?: string) {
    this.store = new Store<SettingsSchema>({
      name: 'settings',
      ...(cwd !== undefined ? { cwd } : {}),
      defaults: { version: SCHEMA_VERSION },
    });
  }

  /** Reads one key. `undefined` when unset. */
  get(key: string): unknown {
    return this.store.get(key);
  }

  /** Writes one key; `undefined` deletes it. */
  set(key: string, value: unknown): void {
    if (value === undefined) this.store.delete(key);
    else this.store.set(key, value);
  }

  /** Absolute path of the JSON file (useful in logs and the About dialog). */
  get path(): string {
    return this.store.path;
  }
}

/** Settings keys owned by M01. Other modules use their own namespace. */
export const THEME_KEY = 'theme.name';
export const UI_SCALE_KEY = 'ui.scale';

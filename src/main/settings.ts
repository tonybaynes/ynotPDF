/**
 * Persisted application settings (M01), backed by `electron-store` — JSON in the OS user-data
 * dir, no database (PLAN.md §4.4). Keys are dotted strings (`theme.name`, `ui.scale`);
 * `electron-store` treats dots as a path, which is exactly the namespacing modules want.
 * M130's preferences UI is built on the same channels.
 *
 * M130 added the bulk operations (ADR 0018): reading everything (Export and the preferences
 * dialog), writing many keys at once (Import), and deleting a namespace or the lot (Reset).
 * The schema version and its migrations live in `src/shared/settings.ts` so the same code runs
 * over an imported file, and are applied here when the store opens.
 */

import Store from 'electron-store';
import {
  dropTree,
  flatten,
  migrate,
  SCHEMA_VERSION,
  under,
  unflatten,
  VERSION_KEY,
  type SettingsRecord,
} from '../shared/settings';

interface StoreShape {
  /** Schema version; see `src/shared/settings.ts`. */
  version: number;
  [key: string]: unknown;
}

export class Settings {
  private readonly store: Store<StoreShape>;

  constructor(cwd?: string) {
    this.store = new Store<StoreShape>({
      name: 'settings',
      ...(cwd !== undefined ? { cwd } : {}),
      defaults: { version: SCHEMA_VERSION },
    });
    this.migrate();
  }

  /**
   * Brings the file up to the current schema version. Runs on every start: it is a no-op once
   * the version matches, and running it eagerly means no module can read a stale key before the
   * migration that renames it has happened.
   */
  private migrate(): void {
    const before = flatten(this.store.store);
    const { record, applied } = migrate(before);
    if (applied.length === 0 && record[VERSION_KEY] === before[VERSION_KEY]) return;
    for (const note of applied) console.info(`settings: migrated — ${note.note}`);
    this.store.store = unflatten(record) as unknown as StoreShape;
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

  /** Every setting as flat dotted keys, version included. */
  all(): SettingsRecord {
    return flatten(this.store.store);
  }

  /**
   * Writes many keys in one go. `undefined` deletes. Written through a single assignment of the
   * whole object so an import is one file write and one `did-change` per listener, not one per
   * setting — importing two hundred keys one at a time is two hundred disk writes.
   */
  setMany(values: Readonly<SettingsRecord>): void {
    const record = this.all();
    for (const [key, value] of Object.entries(values)) {
      if (key === VERSION_KEY) continue;
      if (value === undefined) dropTree(record, key);
      else record[key] = value;
    }
    record[VERSION_KEY] = SCHEMA_VERSION;
    this.store.store = unflatten(record) as unknown as StoreShape;
  }

  /**
   * Deletes settings under the given dotted prefixes, or all of them when none are given. The
   * version key always survives — a reset returns the reader to the defaults, not to a file the
   * next start would have to guess the age of.
   */
  reset(prefixes?: ReadonlyArray<string>): void {
    if (!prefixes || prefixes.length === 0) {
      this.store.store = { version: SCHEMA_VERSION };
      return;
    }
    const record = this.all();
    for (const key of Object.keys(record)) {
      if (key === VERSION_KEY) continue;
      if (prefixes.some((prefix) => under(key, prefix))) dropTree(record, key);
    }
    record[VERSION_KEY] = SCHEMA_VERSION;
    this.store.store = unflatten(record) as unknown as StoreShape;
  }

  /** Absolute path of the JSON file (useful in logs, the About dialog and Preferences). */
  get path(): string {
    return this.store.path;
  }
}

/** Settings keys owned by M01. Other modules use their own namespace. */
export const THEME_KEY = 'theme.name';
export const UI_SCALE_KEY = 'ui.scale';

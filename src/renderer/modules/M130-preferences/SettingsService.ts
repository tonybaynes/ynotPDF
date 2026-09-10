/**
 * The settings hub (M130, ADR 0018).
 *
 * Everything above it — the Preferences dialog, the shortcut editor, the ribbon customiser —
 * reads and writes through this one object, and it is the only thing in the app that knows how
 * a changed setting reaches the module that owns it.
 *
 * **Live apply.** Every module service already exposes `load()`, which re-reads its settings and
 * applies them; after a write this calls it on every registered service that has one. Two values
 * are held in memory rather than re-read, so they get their own path: `theme.*` goes to M01's
 * `ThemeManager`, and the shell's `ui.*` keys go to the `UiState` store. Nothing in another
 * module's folder had to change for any of it.
 *
 * **Aliases.** Where a module's schema declares one key and its code reads another (M01's
 * `theme.scale` / `ui.scale`), `resources/preferences.json` records the pair and this writes
 * both, so the setting the reader changes is the setting the app obeys.
 */

import { hasBridge, invoke } from '@shared/ipc';
import {
  buildExport,
  dropTree,
  parseExport,
  under,
  valueAt,
  VERSION_KEY,
  type SettingsRecord,
} from '@shared/settings';
import { aliasMap, PREFERENCES_CONFIG, type PreferencesConfig } from './model';

/** Where settings live. Tests pass {@link memorySettingsStorage}. */
export interface SettingsStorage {
  all(): Promise<SettingsRecord>;
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  setMany(values: Readonly<SettingsRecord>): Promise<void>;
  reset(prefixes?: ReadonlyArray<string>): Promise<void>;
  path(): Promise<string>;
}

/** The settings IPC (ADR 0003 + ADR 0018). Outside Electron every call is a harmless no-op. */
export function ipcSettingsStorage(): SettingsStorage {
  return {
    all: async () => (hasBridge() ? await invoke('settings:all') : {}),
    get: async (key) => (hasBridge() ? await invoke('settings:get', key) : undefined),
    set: async (key, value) => {
      if (hasBridge()) await invoke('settings:set', key, value);
    },
    setMany: async (values) => {
      if (hasBridge()) await invoke('settings:setMany', values as Record<string, unknown>);
    },
    reset: async (prefixes) => {
      if (hasBridge()) await invoke('settings:reset', prefixes ? [...prefixes] : undefined);
    },
    path: async () => (hasBridge() ? await invoke('settings:path') : ''),
  };
}

export function memorySettingsStorage(initial: Readonly<SettingsRecord> = {}): SettingsStorage {
  const map = new Map<string, unknown>(Object.entries(initial));
  return {
    all: () => Promise.resolve(Object.fromEntries(map)),
    get: (key) => Promise.resolve(map.get(key)),
    set: (key, value) => {
      if (value === undefined) map.delete(key);
      else map.set(key, value);
      return Promise.resolve();
    },
    setMany: (values) => {
      for (const [key, value] of Object.entries(values)) {
        if (value === undefined) map.delete(key);
        else map.set(key, value);
      }
      return Promise.resolve();
    },
    reset: (prefixes) => {
      if (!prefixes || prefixes.length === 0) map.clear();
      else
        for (const key of Array.from(map.keys()))
          if (prefixes.some((p) => under(key, p))) map.delete(key);
      return Promise.resolve();
    },
    path: () => Promise.resolve('(in memory)'),
  };
}

/** What the service needs from the Registry to reach the modules that own the settings. */
export interface ServiceLookup {
  serviceNames(): ReadonlyArray<string>;
  service<T>(name: string): T;
  hasService(name: string): boolean;
}

/** A module service that re-reads its settings on demand — the convention of ADR 0018 §6. */
interface Reloadable {
  load?: () => void | Promise<void>;
}

export type SettingsListener = (keys: ReadonlyArray<string>) => void;

export interface SettingsServiceOptions {
  readonly storage?: SettingsStorage;
  /** Absent in unit tests: nothing is reloaded, and the writes are still made. */
  readonly registry?: ServiceLookup;
  readonly config?: PreferencesConfig;
  /**
   * Extra appliers run before the module services reload — the shell's `ui.*` store and M01's
   * `ThemeManager`, wired by the manifest so this file needs neither import.
   */
  readonly appliers?: ReadonlyArray<SettingsApplier>;
  /**
   * Service names to leave alone when reloading. M130's own two are in here: they *are* the
   * settings, and reloading them after every write would re-run this on itself.
   */
  readonly skipServices?: ReadonlyArray<string>;
}

/**
 * Applies the keys it recognises to something that holds them in memory (the theme, the shell's
 * UI state, M130's own language and units).
 *
 * `apply` is given the whole settings record **and the set of keys that actually changed**, and must
 * act only on the second. Applying everything on every write would push a stale cached value back
 * over whatever another module had just set directly through `settings:set` — this service's cache is
 * not the only writer of the file, and must never behave as though it were.
 *
 * A key that changed but is absent from `values` was deleted: the reader reset it, and the applier
 * should restore that setting's default rather than leave the old value in place.
 */
export interface SettingsApplier {
  /** Dotted prefixes this applier cares about. */
  readonly prefixes: ReadonlyArray<string>;
  apply(values: Readonly<SettingsRecord>, changed: ReadonlySet<string>): void | Promise<void>;
}

export class SettingsService {
  private readonly storage: SettingsStorage;
  private readonly registry: ServiceLookup | undefined;
  private readonly aliases: ReadonlyMap<string, string>;
  private readonly appliers: ReadonlyArray<SettingsApplier>;
  private readonly skip: ReadonlySet<string>;
  private readonly listeners = new Set<SettingsListener>();
  private cache: SettingsRecord = {};
  private loaded = false;

  constructor(options: SettingsServiceOptions = {}) {
    this.storage = options.storage ?? ipcSettingsStorage();
    this.registry = options.registry;
    this.aliases = aliasMap(options.config ?? PREFERENCES_CONFIG);
    this.appliers = options.appliers ?? [];
    this.skip = new Set(options.skipServices ?? []);
  }

  /** Reads the whole file into the cache. Called once when Preferences opens, and after import. */
  async load(): Promise<void> {
    this.cache = await this.storage.all();
    this.loaded = true;
  }

  get isLoaded(): boolean {
    return this.loaded;
  }

  /** Every setting as flat dotted keys, from the cache. Empty until {@link load}. */
  snapshot(): SettingsRecord {
    return { ...this.cache };
  }

  /** Absolute path of `settings.json`, for the "where is this kept" line in the dialog. */
  filePath(): Promise<string> {
    return this.storage.path();
  }

  /** The storage key a declared key is actually written under. */
  storageKey(declaredKey: string): string {
    return this.aliases.get(declaredKey) ?? declaredKey;
  }

  /** Reads one key from the cache, `undefined` when unset. */
  peek(key: string): unknown {
    return valueAt(this.cache, key);
  }

  /** Reads one key straight from the store, bypassing the cache. */
  async read(key: string): Promise<unknown> {
    const value = await this.storage.get(key);
    if (value === undefined) dropTree(this.cache, key);
    else this.cache[key] = value;
    return value;
  }

  /**
   * Writes one setting and applies it. `undefined` deletes the key, which is how a single
   * setting is reset: the module then falls back to its own default.
   */
  async write(key: string, value: unknown): Promise<void> {
    await this.writeMany({ [key]: value });
  }

  /**
   * Writes several settings and applies them once. Preferred over a loop: one reload of the
   * owning services rather than one per key.
   */
  async writeMany(values: Readonly<SettingsRecord>): Promise<void> {
    const expanded: SettingsRecord = {};
    for (const [key, value] of Object.entries(values)) {
      if (key === VERSION_KEY) continue;
      expanded[key] = value;
      // A declared key and the key its module really reads must not drift apart.
      const alias = this.aliases.get(key);
      if (alias !== undefined) expanded[alias] = value;
      for (const [declared, target] of this.aliases) {
        if (target === key && declared !== key) expanded[declared] = value;
      }
    }
    if (Object.keys(expanded).length === 0) return;
    await this.storage.setMany(expanded);
    for (const [key, value] of Object.entries(expanded)) {
      if (value === undefined) dropTree(this.cache, key);
      else this.cache[key] = value;
    }
    await this.apply(Object.keys(expanded));
  }

  /**
   * Deletes every setting under the given prefixes (one page's Reset), or all of them when the
   * list is empty (Reset everything), then applies.
   */
  async reset(prefixes: ReadonlyArray<string> = []): Promise<void> {
    const before = Object.keys(this.cache);
    await this.storage.reset(prefixes);
    await this.load();
    const touched =
      prefixes.length === 0 ? before : before.filter((k) => prefixes.some((p) => under(k, p)));
    await this.apply(touched);
  }

  /** The JSON text an Export writes. */
  async exportText(appVersion?: string): Promise<string> {
    await this.load();
    const envelope = buildExport(this.cache, appVersion !== undefined ? { app: appVersion } : {});
    return `${JSON.stringify(envelope, null, 2)}\n`;
  }

  /**
   * Reads an exported file and writes it in. Returns what happened so the dialog can say it in
   * words: how many settings arrived, which lines were dropped, which migrations ran.
   *
   * Import **merges**: a key the file does not mention keeps its current value. Replacing the
   * whole file instead would mean an export from a build with fewer modules silently resetting
   * the settings of every module it did not know about.
   */
  async importText(text: string): Promise<{
    readonly written: number;
    readonly dropped: ReadonlyArray<string>;
    readonly migrated: ReadonlyArray<string>;
  }> {
    const { settings, dropped, migrated } = parseExport(text);
    await this.writeMany(settings);
    await this.load();
    await this.applyAll();
    return { written: Object.keys(settings).length, dropped, migrated };
  }

  subscribe(listener: SettingsListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Reloads every module service, whatever changed. Used after an import or a full reset. */
  applyAll(): Promise<void> {
    return this.apply(Object.keys(this.cache));
  }

  /**
   * Pushes the changed keys out: the in-memory holders first (theme, shell UI state), then every
   * registered service that can re-read itself, then this service's own listeners.
   *
   * A service that throws is logged and skipped. One module refusing to reload must not stop the
   * other twelve, and must not leave the dialog looking as though nothing was saved — the value
   * is already on disk by the time this runs.
   */
  private async apply(keys: ReadonlyArray<string>): Promise<void> {
    if (keys.length === 0) return;
    const changed = new Set(keys);
    for (const applier of this.appliers) {
      if (!applier.prefixes.some((prefix) => keys.some((key) => under(key, prefix)))) continue;
      try {
        await applier.apply(this.cache, changed);
      } catch (error) {
        console.warn('settings: an applier failed', error);
      }
    }
    if (this.registry) {
      for (const name of this.registry.serviceNames()) {
        if (this.skip.has(name)) continue;
        let service: Reloadable;
        try {
          service = this.registry.service<Reloadable>(name);
        } catch {
          continue;
        }
        if (typeof service?.load !== 'function') continue;
        try {
          await service.load();
        } catch (error) {
          console.warn(`settings: service "${name}" could not reload`, error);
        }
      }
    }
    for (const listener of Array.from(this.listeners)) {
      try {
        listener(keys);
      } catch (error) {
        console.warn('settings: a listener threw', error);
      }
    }
  }
}

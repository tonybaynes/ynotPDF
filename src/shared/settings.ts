/**
 * The persisted settings file, as a *shape* rather than as a store (M130, ADR 0018).
 *
 * `src/main/settings.ts` owns the `electron-store` instance; this file owns everything about it
 * that both processes have to agree on and that a test wants to exercise without Electron:
 *
 * - the **schema version** and the ordered list of **migrations** between versions,
 * - the **envelope** an exported settings file uses, and the validation that reads one back,
 * - the small rules about dotted keys that both the store and the preferences UI apply.
 *
 * Keys are dotted strings (`theme.name`, `viewer.cache.megabytes`). `electron-store` treats a dot
 * as a path, so a key is also a place in a nested JSON object — which is why the flatten/unflatten
 * pair below exists: the file on disk is nested, everything above it thinks in flat dotted keys.
 *
 * Pure. No imports from Electron, the DOM or the renderer.
 */

/**
 * Bump this when a migration is added, and add the migration in the same commit.
 *
 * It is still 1: M00's store has never had a key renamed, so there is nothing to migrate yet.
 * The mechanism ships now rather than later because the cost of adding it to a store that is
 * already on a thousand machines is a great deal higher than the cost of adding it to an empty
 * one, and because an importer needs it before the first rename, not after.
 */
export const SCHEMA_VERSION = 1;

/** The key the version lives under. Never migrated, never exported as a setting. */
export const VERSION_KEY = 'version';

/** A settings file as everything above the store sees it: flat, dotted keys. */
export type SettingsRecord = Record<string, unknown>;

/** One step between two schema versions. `apply` may mutate the record it is given. */
export interface Migration {
  /** The version the record is at *after* this ran. */
  readonly to: number;
  /** Human sentence for the log — what moved, and why. */
  readonly note: string;
  apply(record: SettingsRecord): void;
}

/**
 * Migrations in order. Each one takes a record at `to - 1` and leaves it at `to`.
 *
 * A migration must be safe to run on a record that never had the old key: readers upgrade from
 * every version, including ones that never wrote the setting at all.
 */
export const MIGRATIONS: ReadonlyArray<Migration> = [];

/**
 * Brings a record up to {@link SCHEMA_VERSION}, running every migration it has not had yet.
 * Returns a new record; the input is not modified.
 *
 * A record from a *newer* version than this build knows is left alone apart from its version
 * number, which is kept: downgrading and re-upgrading must not throw away settings a later
 * build wrote, and a key this build does not understand is simply a key it never reads.
 */
export function migrate(
  record: Readonly<SettingsRecord>,
  /** The steps to consider. A parameter so the ordering rule can be tested with real steps. */
  migrations: ReadonlyArray<Migration> = MIGRATIONS,
): {
  readonly record: SettingsRecord;
  readonly applied: ReadonlyArray<Migration>;
} {
  const out: SettingsRecord = { ...record };
  const raw = out[VERSION_KEY];
  const from = typeof raw === 'number' && Number.isFinite(raw) ? Math.floor(raw) : 1;
  const applied: Migration[] = [];
  for (const migration of migrations) {
    if (migration.to <= from) continue;
    migration.apply(out);
    applied.push(migration);
  }
  out[VERSION_KEY] = Math.max(from, SCHEMA_VERSION);
  return { record: out, applied };
}

// ---- dotted keys --------------------------------------------------------------------------------

/** True for a usable settings key: dotted segments, no empty segment, no leading/trailing dot. */
export function isSettingsKey(key: string): boolean {
  if (key.length === 0 || key.length > 200) return false;
  return key.split('.').every((segment) => segment.length > 0 && !/[\s"[\]]/.test(segment));
}

/**
 * Removes one key from a settings record.
 *
 * A function rather than `delete record[key]` because a settings record is a map in all but
 * name — its keys are data, not properties of a type — and the project's lint rules (rightly)
 * refuse `delete` on a computed key.
 */
export function drop(record: SettingsRecord, key: string): void {
  Reflect.deleteProperty(record, key);
}

/**
 * Removes a key **and everything under it**.
 *
 * The distinction matters because a settings key may hold an object — M130's
 * `shortcuts.bindings`, M30's `annot.defaults.note` — and {@link flatten} turns that object into
 * one key per field. Deleting only the exact key would leave those fields behind, and the setting
 * would come back from the dead on the next read.
 */
export function dropTree(record: SettingsRecord, key: string): void {
  for (const existing of Object.keys(record)) {
    if (under(existing, key)) Reflect.deleteProperty(record, existing);
  }
}

/**
 * The value at `key`: the leaf stored there, or — when the value is an object that
 * {@link flatten} has spread across several keys — that object, rebuilt.
 *
 * A settings file is a tree, and a key names a node in it. Most nodes are leaves, so most reads
 * are a lookup; a node that is a subtree (a stored object) has to be put back together, because
 * the module that wrote it expects the object it wrote.
 */
export function valueAt(record: Readonly<SettingsRecord>, key: string): unknown {
  if (key in record) return record[key];
  const prefix = `${key}.`;
  const subtree: SettingsRecord = {};
  let found = false;
  for (const [existing, value] of Object.entries(record)) {
    if (!existing.startsWith(prefix)) continue;
    found = true;
    subtree[existing.slice(prefix.length)] = value;
  }
  return found ? unflatten(subtree) : undefined;
}

/** True when `key` is `prefix` itself or sits under it: `under('a.b.c', 'a.b')`. */
export function under(key: string, prefix: string): boolean {
  return key === prefix || key.startsWith(`${prefix}.`);
}

/**
 * Flattens a nested object into dotted keys. Arrays and `null` are values, not branches — a list
 * setting is one key holding an array, not a key per element.
 *
 * **The rule this imposes on every module.** The store is a dotted *tree*: a key is a path, and
 * an object stored at a key is a subtree. So a setting whose value is an object must not use dots
 * in that object's own keys — `{ "edit.find": "Mod+F" }` would come back as `{ edit: { find: … } }`
 * and the module would not recognise its own data. A map keyed by something dotted (a command id,
 * a ribbon group id) is stored as an **array of entries** instead, which is a leaf and survives
 * the round trip. M130's shortcut bindings and ribbon customisation both do this; M30's tool
 * defaults are keyed by plain names and need not.
 */
export function flatten(value: unknown, prefix = ''): SettingsRecord {
  if (!isPlainObject(value)) return prefix === '' ? {} : { [prefix]: value };
  const out: SettingsRecord = {};
  for (const [name, child] of Object.entries(value)) {
    const key = prefix === '' ? name : `${prefix}.${name}`;
    if (isPlainObject(child) && Object.keys(child).length > 0) {
      Object.assign(out, flatten(child, key));
    } else {
      out[key] = child;
    }
  }
  return out;
}

/** The inverse of {@link flatten}. Later keys win over earlier ones on a collision. */
export function unflatten(record: Readonly<SettingsRecord>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    const parts = key.split('.');
    let node = out;
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i] ?? '';
      const next = node[part];
      if (!isPlainObject(next)) node[part] = {};
      node = node[part] as Record<string, unknown>;
    }
    node[parts[parts.length - 1] ?? key] = value;
  }
  return out;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ---- the exported file --------------------------------------------------------------------------

/** What `Preferences → Export` writes and `Import` reads. */
export interface SettingsExport {
  /** Always `"ynotPDF-settings"`, so a file picked by mistake is refused with a sentence. */
  readonly kind: 'ynotPDF-settings';
  /** The schema version the settings were at when they were exported. */
  readonly version: number;
  /** ISO 8601, for the reader's benefit only. */
  readonly exported: string;
  /** The application version that wrote it. Informational. */
  readonly app?: string;
  /** Flat dotted keys. */
  readonly settings: SettingsRecord;
}

export const EXPORT_KIND = 'ynotPDF-settings';

/** Builds the envelope. `settings` is taken as-is apart from the version key, which is dropped. */
export function buildExport(
  settings: Readonly<SettingsRecord>,
  options: { readonly now?: Date; readonly app?: string } = {},
): SettingsExport {
  const values: SettingsRecord = {};
  for (const [key, value] of Object.entries(settings)) {
    if (key === VERSION_KEY) continue;
    values[key] = value;
  }
  return {
    kind: EXPORT_KIND,
    version: typeof settings[VERSION_KEY] === 'number' ? settings[VERSION_KEY] : SCHEMA_VERSION,
    exported: (options.now ?? new Date()).toISOString(),
    ...(options.app !== undefined ? { app: options.app } : {}),
    settings: values,
  };
}

/** What {@link parseExport} says about a file that is not one of ours. */
export class SettingsImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SettingsImportError';
  }
}

/**
 * Reads an exported file back, migrating it to the current schema version.
 *
 * Throws {@link SettingsImportError} with a sentence the dialog can show verbatim — "this is a
 * PDF, not a settings file" is more use to the reader than a stack trace. Keys that are not
 * valid settings keys are dropped rather than rejecting the whole file: one bad line in a
 * hand-edited export must not cost the reader the other two hundred.
 */
export function parseExport(text: string): {
  readonly settings: SettingsRecord;
  readonly dropped: ReadonlyArray<string>;
  readonly migrated: ReadonlyArray<string>;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new SettingsImportError('That file is not JSON, so it cannot be a settings export.');
  }
  if (!isPlainObject(parsed)) {
    throw new SettingsImportError('That file does not contain a settings export.');
  }
  if (parsed['kind'] !== EXPORT_KIND) {
    throw new SettingsImportError(
      'That file was not exported from ynotPDF Preferences — its "kind" line does not say so.',
    );
  }
  const raw = parsed['settings'];
  if (!isPlainObject(raw)) {
    throw new SettingsImportError('That settings export has no settings in it.');
  }
  // An export written by hand may be nested rather than flat; accept both.
  const flat = flatten(raw);
  const dropped: string[] = [];
  const kept: SettingsRecord = {};
  for (const [key, value] of Object.entries(flat)) {
    if (key === VERSION_KEY) continue;
    if (!isSettingsKey(key)) {
      dropped.push(key);
      continue;
    }
    kept[key] = value;
  }
  const version = typeof parsed['version'] === 'number' ? parsed['version'] : 1;
  const { record, applied } = migrate({ ...kept, [VERSION_KEY]: version });
  drop(record, VERSION_KEY);
  return { settings: record, dropped, migrated: applied.map((m) => m.note) };
}

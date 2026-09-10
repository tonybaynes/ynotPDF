/**
 * The keyboard-shortcut table (M130). Pure: no DOM, no Registry, no IPC, so every rule below is
 * unit-tested directly and the editor only draws what this returns.
 *
 * **Overrides, not a table.** What is stored is a map of command id → key, or `null` for "the
 * reader deliberately unbound this". Anything a reader has not touched is absent, and keeps
 * whatever its module declares — so a module that changes its own default binding in a later
 * version is still obeyed, and Reset is deleting an entry rather than restoring a snapshot of
 * how the app looked the day the reader first opened this dialog.
 */

import { normalizeKey } from '@core/Registry';
import type { CommandCategory } from '@shared/module';

/** What the editor needs to know about one command. Narrow so tests pass plain objects. */
export interface BindableCommand {
  readonly id: string;
  readonly label: string;
  readonly category: CommandCategory;
  /** The key the module declares, already normalised, or `undefined` for none. */
  readonly defaultKey?: string | undefined;
  readonly description?: string | undefined;
  /** Hidden commands are still bindable — they just do not appear in the palette. */
  readonly hidden?: boolean;
}

/** command id → key, or `null` for "unbound on purpose". */
export type ShortcutOverrides = Readonly<Record<string, string | null>>;

/** The settings key the overrides live under. */
export const OVERRIDES_KEY = 'shortcuts.bindings';

/** One row of the editor. */
export interface BindingRow {
  readonly commandId: string;
  readonly label: string;
  readonly category: string;
  readonly description: string | undefined;
  /** What the module declares. */
  readonly defaultKey: string | undefined;
  /** What is bound now: the override if there is one, else the default. `undefined` = nothing. */
  readonly key: string | undefined;
  /** True when the reader has changed this row away from its default. */
  readonly changed: boolean;
}

/** Builds the rows, sorted by category then label — the order the cheat sheet prints in too. */
export function buildRows(
  commands: ReadonlyArray<BindableCommand>,
  overrides: ShortcutOverrides = {},
): ReadonlyArray<BindingRow> {
  const rows = commands.map((command) => {
    const declared = command.defaultKey ? normalizeKey(command.defaultKey) : undefined;
    const hasOverride = Object.prototype.hasOwnProperty.call(overrides, command.id);
    const raw = hasOverride ? overrides[command.id] : undefined;
    const override = typeof raw === 'string' ? normalizeKey(raw) : raw === null ? null : undefined;
    const key = hasOverride ? (override ?? undefined) : declared;
    return {
      commandId: command.id,
      label: command.label,
      category: command.category,
      description: command.description,
      defaultKey: declared,
      key,
      changed: hasOverride && key !== declared,
    };
  });
  return rows.sort(
    (a, b) => a.category.localeCompare(b.category) || a.label.localeCompare(b.label),
  );
}

/** The row that already owns `key`, ignoring `exceptCommandId`. `null` when the key is free. */
export function conflictFor(
  rows: ReadonlyArray<BindingRow>,
  key: string,
  exceptCommandId?: string,
): BindingRow | null {
  const wanted = normalizeKey(key);
  for (const row of rows) {
    if (row.commandId === exceptCommandId) continue;
    if (row.key !== undefined && normalizeKey(row.key) === wanted) return row;
  }
  return null;
}

/** Why a recorded key cannot be used, as a sentence, or `null` when it can. */
export function keyProblem(key: string | null): string | null {
  if (key === null || key.trim() === '') {
    return 'That was a modifier on its own. Hold it and press the key you want as well.';
  }
  const parts = normalizeKey(key).split('+');
  const name = parts[parts.length - 1] ?? '';
  const bare = parts.length === 1;
  if (bare && (name === 'Tab' || name === 'Escape' || name === 'Enter')) {
    return `${name} on its own moves around the application, so it cannot be a shortcut. Add Ctrl, Alt or Shift.`;
  }
  if (name === '' || name === 'Dead' || name === 'Unidentified') {
    return 'That key did not come through as anything the application can store.';
  }
  return null;
}

/** A warning worth showing about an otherwise usable key, or `null`. */
export function keyWarning(key: string): string | null {
  const parts = normalizeKey(key).split('+');
  const name = parts[parts.length - 1] ?? '';
  const modifiers = parts.slice(0, -1);
  if (modifiers.length === 0 && name.length === 1) {
    return 'A single key only works when you are not typing in a box — in a text field it types the letter instead.';
  }
  if (modifiers.length === 1 && modifiers[0] === 'Shift' && name.length === 1) {
    return 'Shift and a letter only works when you are not typing in a box.';
  }
  return null;
}

/**
 * The overrides after binding `key` to `commandId`.
 *
 * Binding a key that another command already holds **displaces** it: that command is recorded as
 * deliberately unbound rather than left pointing at a key it no longer answers. Two commands
 * quietly sharing one key is the bug this whole editor exists to make visible.
 */
export function bind(
  rows: ReadonlyArray<BindingRow>,
  overrides: ShortcutOverrides,
  commandId: string,
  key: string,
): ShortcutOverrides {
  const wanted = normalizeKey(key);
  const next: Record<string, string | null> = { ...overrides };
  const clash = conflictFor(rows, wanted, commandId);
  if (clash) next[clash.commandId] = null;
  const row = rows.find((r) => r.commandId === commandId);
  if (row?.defaultKey === wanted) Reflect.deleteProperty(next, commandId);
  else next[commandId] = wanted;
  return next;
}

/** The overrides after unbinding `commandId`. */
export function unbind(
  rows: ReadonlyArray<BindingRow>,
  overrides: ShortcutOverrides,
  commandId: string,
): ShortcutOverrides {
  const next: Record<string, string | null> = { ...overrides };
  const row = rows.find((r) => r.commandId === commandId);
  // A command that never had a key needs no "unbound" entry — absent already means unbound.
  if (row !== undefined && row.defaultKey === undefined) Reflect.deleteProperty(next, commandId);
  else next[commandId] = null;
  return next;
}

/** The overrides after resetting one command to whatever its module declares. */
export function resetOne(overrides: ShortcutOverrides, commandId: string): ShortcutOverrides {
  const next: Record<string, string | null> = { ...overrides };
  Reflect.deleteProperty(next, commandId);
  return next;
}

/** Rows the reader has changed — what "Reset all" is about to undo, counted for the warning. */
export function changedRows(rows: ReadonlyArray<BindingRow>): ReadonlyArray<BindingRow> {
  return rows.filter((r) => r.changed);
}

/** Rows filtered by a search over label, command id, category and the key itself. */
export function filterRows(
  rows: ReadonlyArray<BindingRow>,
  query: string,
): ReadonlyArray<BindingRow> {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return rows;
  return rows.filter((row) => {
    const haystack = [row.label, row.commandId, row.category, row.key ?? '', row.description ?? '']
      .join(' ')
      .toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}

// ---- export / import ----------------------------------------------------------------------------

/** The envelope `Export shortcuts` writes. */
export interface ShortcutExport {
  readonly kind: 'ynotPDF-shortcuts';
  readonly version: 1;
  readonly exported: string;
  /** Only what the reader changed — a full table would freeze today's defaults for ever. */
  readonly bindings: ShortcutOverrides;
}

export const SHORTCUT_EXPORT_KIND = 'ynotPDF-shortcuts';

export function buildShortcutExport(
  overrides: ShortcutOverrides,
  now: Date = new Date(),
): ShortcutExport {
  return {
    kind: SHORTCUT_EXPORT_KIND,
    version: 1,
    exported: now.toISOString(),
    bindings: { ...overrides },
  };
}

export class ShortcutImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShortcutImportError';
  }
}

/**
 * Reads an exported shortcut file. Entries whose command does not exist in this build are
 * dropped and named, rather than kept as dead weight or refused wholesale: importing a colleague's
 * shortcuts should bring over the ones that apply here and say what it could not.
 */
export function parseShortcutExport(
  text: string,
  knownCommandIds: ReadonlySet<string>,
): {
  readonly bindings: ShortcutOverrides;
  readonly unknown: ReadonlyArray<string>;
  readonly invalid: ReadonlyArray<string>;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ShortcutImportError('That file is not JSON, so it cannot be a shortcut export.');
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new ShortcutImportError('That file does not contain a shortcut export.');
  }
  const envelope = parsed as Record<string, unknown>;
  if (envelope['kind'] !== SHORTCUT_EXPORT_KIND) {
    throw new ShortcutImportError(
      'That file was not exported from the ynotPDF shortcut editor — its "kind" line does not say so.',
    );
  }
  const raw = envelope['bindings'];
  if (typeof raw !== 'object' || raw === null) {
    throw new ShortcutImportError('That shortcut export has no bindings in it.');
  }
  const bindings: Record<string, string | null> = {};
  const unknown: string[] = [];
  const invalid: string[] = [];
  for (const [commandId, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!knownCommandIds.has(commandId)) {
      unknown.push(commandId);
      continue;
    }
    if (value === null) {
      bindings[commandId] = null;
      continue;
    }
    if (typeof value !== 'string' || keyProblem(value) !== null) {
      invalid.push(`${commandId}: ${describeValue(value)}`);
      continue;
    }
    bindings[commandId] = normalizeKey(value);
  }
  return { bindings, unknown, invalid };
}

/** A stored value as a short phrase for the "could not be used" list. */
function describeValue(value: unknown): string {
  return typeof value === 'string' ? `"${value}"` : typeof value;
}

/**
 * One binding as it is written to `settings.json`.
 *
 * An array of these, rather than the map the rest of this file uses, because the settings store
 * is a dotted tree and a command id has dots in it: `{ "edit.find": "Mod+F" }` would come back as
 * `{ edit: { find: … } }`. See the note on `flatten` in `src/shared/settings.ts`.
 */
export interface StoredBinding {
  readonly command: string;
  /** `null` means "deliberately unbound". */
  readonly key: string | null;
}

/** The overrides in the form that survives the store. Sorted, so the file has a stable diff. */
export function toStoredOverrides(overrides: ShortcutOverrides): ReadonlyArray<StoredBinding> {
  return Object.keys(overrides)
    .sort()
    .map((command) => ({ command, key: overrides[command] ?? null }));
}

/**
 * Validates a stored blob. Anything odd is dropped rather than throwing: a hand-edited file must
 * cost the reader their bindings at worst, never the application.
 *
 * Both the array form written today and a plain map are accepted — the map only ever worked for
 * command ids without dots, but where it worked it should keep working.
 */
export function readOverrides(value: unknown): ShortcutOverrides {
  const out: Record<string, string | null> = {};
  const put = (command: unknown, raw: unknown): void => {
    if (typeof command !== 'string' || command === '') return;
    if (raw === null) out[command] = null;
    else if (typeof raw === 'string' && keyProblem(raw) === null) out[command] = normalizeKey(raw);
  };
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (typeof entry !== 'object' || entry === null) continue;
      const record = entry as Record<string, unknown>;
      put(record['command'], record['key'] ?? null);
    }
    return out;
  }
  if (typeof value !== 'object' || value === null) return {};
  for (const [command, raw] of Object.entries(value as Record<string, unknown>)) put(command, raw);
  return out;
}

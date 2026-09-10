/**
 * The shortcut editor's rules (M130) and the printable sheet it produces.
 *
 * The brief's second acceptance line — "rebind Ctrl+F to Ctrl+Shift+F; the conflict warns" — has
 * two halves. The wording and the displacement are decided here; that the find bar then actually
 * opens on the new key is proved in `test/e2e/preferences.spec.ts`, because only a running
 * application can answer that.
 */

import { describe, expect, it } from 'vitest';
import { normalizeKey } from '@core/Registry';
import { flatten, unflatten } from '@shared/settings';
import {
  bind,
  buildRows,
  buildShortcutExport,
  changedRows,
  conflictFor,
  filterRows,
  keyProblem,
  keyWarning,
  parseShortcutExport,
  readOverrides,
  resetOne,
  SHORTCUT_EXPORT_KIND,
  toStoredOverrides,
  ShortcutImportError,
  unbind,
  type BindableCommand,
  type ShortcutOverrides,
} from '@modules/M130-preferences/shortcuts/model';
import {
  buildCheatSheet,
  printableKey,
  sections,
  winAnsiSafe,
} from '@modules/M130-preferences/shortcuts/cheatsheet';

const COMMANDS: ReadonlyArray<BindableCommand> = [
  { id: 'edit.find', label: 'Find', category: 'Edit', defaultKey: 'Mod+F' },
  { id: 'edit.search', label: 'Search in folder', category: 'Edit', defaultKey: 'Mod+Shift+F' },
  { id: 'file.open', label: 'Open', category: 'File', defaultKey: 'Mod+O' },
  { id: 'view.rulers', label: 'Rulers', category: 'View' },
  { id: 'dev.thing', label: 'A hidden thing', category: 'Developer', hidden: true },
];

describe('buildRows', () => {
  it('shows the key each module declares when nothing has been changed', () => {
    const rows = buildRows(COMMANDS);
    expect(rows.find((r) => r.commandId === 'edit.find')?.key).toBe('Mod+F');
    expect(rows.find((r) => r.commandId === 'view.rulers')?.key).toBeUndefined();
    expect(rows.every((r) => !r.changed)).toBe(true);
  });

  it('sorts by category then label — the order the cheat sheet prints in', () => {
    const rows = buildRows(COMMANDS);
    expect(rows.map((r) => r.category)).toEqual(['Developer', 'Edit', 'Edit', 'File', 'View']);
  });

  it('lets an override win, and marks the row as changed', () => {
    const rows = buildRows(COMMANDS, { 'edit.find': 'Mod+Alt+F' });
    const find = rows.find((r) => r.commandId === 'edit.find');
    expect(find?.key).toBe('Mod+Alt+F');
    expect(find?.defaultKey).toBe('Mod+F');
    expect(find?.changed).toBe(true);
  });

  it('reads null as "deliberately unbound"', () => {
    const rows = buildRows(COMMANDS, { 'edit.find': null });
    const find = rows.find((r) => r.commandId === 'edit.find');
    expect(find?.key).toBeUndefined();
    expect(find?.changed).toBe(true);
  });

  it('normalises whatever a hand-edited file says', () => {
    const rows = buildRows(COMMANDS, { 'view.rulers': 'shift+mod+r' });
    expect(rows.find((r) => r.commandId === 'view.rulers')?.key).toBe('Mod+Shift+R');
  });

  it('keeps obeying a module that changes its own default, for untouched commands', () => {
    const moved: BindableCommand[] = COMMANDS.map((c) =>
      c.id === 'file.open' ? { ...c, defaultKey: 'Mod+Alt+O' } : c,
    );
    const rows = buildRows(moved, { 'edit.find': 'Mod+Alt+F' });
    expect(rows.find((r) => r.commandId === 'file.open')?.key).toBe('Mod+Alt+O');
  });
});

describe('conflicts', () => {
  const rows = buildRows(COMMANDS);

  it('names the command that already holds a key', () => {
    expect(conflictFor(rows, 'Mod+Shift+F')?.commandId).toBe('edit.search');
    expect(conflictFor(rows, 'shift+mod+f')?.commandId).toBe('edit.search');
  });

  it('does not call a command a conflict with itself', () => {
    expect(conflictFor(rows, 'Mod+F', 'edit.find')).toBeNull();
  });

  it('reports a free key as free', () => {
    expect(conflictFor(rows, 'Mod+Alt+Y')).toBeNull();
  });

  it('the brief’s case: taking Ctrl+Shift+F for Find unbinds the command that had it', () => {
    const next = bind(rows, {}, 'edit.find', 'Mod+Shift+F');
    expect(next['edit.find']).toBe('Mod+Shift+F');
    expect(next['edit.search']).toBeNull();
    const after = buildRows(COMMANDS, next);
    expect(after.find((r) => r.commandId === 'edit.find')?.key).toBe('Mod+Shift+F');
    expect(after.find((r) => r.commandId === 'edit.search')?.key).toBeUndefined();
    // And Ctrl+F is genuinely free afterwards.
    expect(conflictFor(after, 'Mod+F')).toBeNull();
  });

  it('never leaves two commands on one key', () => {
    let overrides: ShortcutOverrides = {};
    for (const command of ['edit.find', 'file.open', 'view.rulers']) {
      overrides = bind(buildRows(COMMANDS, overrides), overrides, command, 'Mod+J');
    }
    const bound = buildRows(COMMANDS, overrides).filter((r) => r.key === 'Mod+J');
    expect(bound).toHaveLength(1);
    expect(bound[0]?.commandId).toBe('view.rulers');
  });
});

describe('bind / unbind / reset', () => {
  const rows = buildRows(COMMANDS);

  it('binding a command back to its own default removes the override', () => {
    const next = bind(rows, { 'edit.find': 'Mod+J' }, 'edit.find', 'Mod+F');
    expect('edit.find' in next).toBe(false);
  });

  it('unbinding a command that had a default records the choice', () => {
    expect(unbind(rows, {}, 'edit.find')['edit.find']).toBeNull();
  });

  it('unbinding a command that never had a key needs no entry at all', () => {
    expect('view.rulers' in unbind(rows, {}, 'view.rulers')).toBe(false);
  });

  it('resetting one command forgets it and leaves the rest', () => {
    const next = resetOne({ 'edit.find': 'Mod+J', 'file.open': null }, 'edit.find');
    expect(next).toEqual({ 'file.open': null });
  });

  it('counts what "Reset all" would undo', () => {
    expect(changedRows(buildRows(COMMANDS, { 'edit.find': 'Mod+J' }))).toHaveLength(1);
    expect(changedRows(buildRows(COMMANDS))).toHaveLength(0);
  });
});

describe('what a key may be', () => {
  it('refuses a bare modifier with a sentence that says what to do', () => {
    expect(keyProblem(null)).toMatch(/modifier on its own/);
    expect(keyProblem('  ')).toMatch(/modifier on its own/);
  });

  it('refuses the three keys that move around the application', () => {
    for (const key of ['Tab', 'Escape', 'Enter']) {
      expect(keyProblem(key)).toMatch(/cannot be a shortcut/);
    }
  });

  it('allows those keys with a modifier — Ctrl+Tab is a real shortcut', () => {
    expect(keyProblem('Mod+Tab')).toBeNull();
    expect(keyProblem('Mod+Enter')).toBeNull();
  });

  it('allows a single key but warns what it costs', () => {
    expect(keyProblem('H')).toBeNull();
    expect(keyWarning('H')).toMatch(/not typing in a box/);
    expect(keyWarning('Shift+H')).toMatch(/not typing in a box/);
    expect(keyWarning('Mod+H')).toBeNull();
    expect(keyWarning('F7')).toBeNull();
  });

  it('refuses a key the browser could not identify', () => {
    expect(keyProblem('Unidentified')).toMatch(/did not come through/);
  });
});

describe('filterRows', () => {
  const rows = buildRows(COMMANDS);

  it('matches the label, the id, the category and the key', () => {
    expect(filterRows(rows, 'find')).toHaveLength(1);
    expect(filterRows(rows, 'edit.')).toHaveLength(2);
    expect(filterRows(rows, 'Mod+O')).toHaveLength(1);
    expect(filterRows(rows, 'developer')).toHaveLength(1);
  });

  it('needs every word to match', () => {
    expect(filterRows(rows, 'search folder')).toHaveLength(1);
    expect(filterRows(rows, 'search nonsense')).toHaveLength(0);
  });

  it('an empty query is everything', () => {
    expect(filterRows(rows, '   ')).toHaveLength(rows.length);
  });
});

describe('export and import', () => {
  const known = new Set(COMMANDS.map((c) => c.id));

  it('exports only what the reader changed', () => {
    const envelope = buildShortcutExport({ 'edit.find': 'Mod+J' }, new Date('2026-09-10'));
    expect(envelope.kind).toBe(SHORTCUT_EXPORT_KIND);
    expect(envelope.bindings).toEqual({ 'edit.find': 'Mod+J' });
  });

  it('reads its own output back', () => {
    const text = JSON.stringify(buildShortcutExport({ 'edit.find': 'Mod+J', 'file.open': null }));
    const result = parseShortcutExport(text, known);
    expect(result.bindings).toEqual({ 'edit.find': 'Mod+J', 'file.open': null });
    expect(result.unknown).toEqual([]);
    expect(result.invalid).toEqual([]);
  });

  it('names the commands this build does not have instead of keeping dead weight', () => {
    const text = JSON.stringify(buildShortcutExport({ 'edit.find': 'Mod+J', 'm90.ocr': 'Mod+9' }));
    const result = parseShortcutExport(text, known);
    expect(result.bindings).toEqual({ 'edit.find': 'Mod+J' });
    expect(result.unknown).toEqual(['m90.ocr']);
  });

  it('names an unusable key rather than storing it', () => {
    const text = JSON.stringify({
      kind: SHORTCUT_EXPORT_KIND,
      version: 1,
      exported: '',
      bindings: { 'edit.find': 'Tab', 'file.open': 42 },
    });
    const result = parseShortcutExport(text, known);
    expect(result.bindings).toEqual({});
    expect(result.invalid).toHaveLength(2);
    expect(result.invalid[1]).toContain('number');
  });

  it('says in a sentence why a file is not one of ours', () => {
    expect(() => parseShortcutExport('nope', known)).toThrow(ShortcutImportError);
    expect(() => parseShortcutExport('{}', known)).toThrow(/not exported from the ynotPDF/);
  });
});

describe('what goes into settings.json', () => {
  /**
   * A command id has dots in it and the settings store is a dotted tree, so a map keyed by
   * command id cannot survive a round trip — it comes back as a nested object. The stored form
   * is a list of entries, which is a leaf. This is the test that would have caught it.
   */
  it('is a sorted list of entries, not a map keyed by command id', () => {
    expect(toStoredOverrides({ 'file.open': 'Mod+J', 'edit.find': null })).toEqual([
      { command: 'edit.find', key: null },
      { command: 'file.open', key: 'Mod+J' },
    ]);
  });

  it('round-trips through the store’s flatten/unflatten pair unharmed', () => {
    const overrides: ShortcutOverrides = { 'edit.find': 'Mod+Alt+Y', 'file.open': null };
    const stored = toStoredOverrides(overrides);
    const onDisk = unflatten(flatten({ shortcuts: { bindings: stored } }));
    const readBack = (onDisk as { shortcuts: { bindings: unknown } }).shortcuts.bindings;
    expect(readOverrides(readBack)).toEqual(overrides);
  });

  it('reads the stored list back, and a plain map as well', () => {
    expect(readOverrides([{ command: 'edit.find', key: 'mod+shift+f' }])).toEqual({
      'edit.find': 'Mod+Shift+F',
    });
    expect(readOverrides({ 'edit.find': 'mod+shift+f', 'file.open': null })).toEqual({
      'edit.find': 'Mod+Shift+F',
      'file.open': null,
    });
  });

  it('drops anything a hand-edited file may have put there', () => {
    expect(readOverrides({ a: 1, b: 'Tab', c: {}, d: 'Mod+J' })).toEqual({ d: 'Mod+J' });
    expect(readOverrides([{ command: '', key: 'Mod+J' }, 'nonsense', null])).toEqual({});
    expect(readOverrides(null)).toEqual({});
    expect(readOverrides('nonsense')).toEqual({});
  });
});

describe('the printable sheet', () => {
  const rows = buildRows(COMMANDS);

  it('spells the modifiers in words, per platform', () => {
    expect(printableKey('Mod+Shift+P', false)).toBe('Ctrl+Shift+P');
    expect(printableKey('Mod+Shift+P', true)).toBe('Cmd+Shift+P');
    expect(printableKey('Alt+ArrowLeft', true)).toBe('Opt+ArrowLeft');
    expect(printableKey('Meta+Q', false)).toBe('Win+Q');
  });

  it('groups by category and puts the bound commands first inside each', () => {
    const grouped = sections(rows);
    expect(grouped.map((s) => s.category)).toEqual(['Developer', 'Edit', 'File', 'View']);
    const edit = grouped.find((s) => s.category === 'Edit');
    expect(edit?.rows.every((r) => r.key !== undefined)).toBe(true);
  });

  it('replaces a character the standard fonts cannot encode rather than failing', () => {
    expect(winAnsiSafe('Sign — café')).toBe('Sign — café');
    // One character, one replacement: the walk is by code point, not by UTF-16 unit.
    expect(winAnsiSafe('Emoji \u{1f600} here')).toBe('Emoji ? here');
  });

  it('lists every command, bound or not, and says how many have a key', async () => {
    const sheet = await buildCheatSheet(rows, { date: new Date('2026-09-10T00:00:00Z') });
    expect(sheet.commandCount).toBe(rows.length);
    expect(sheet.boundCount).toBe(3);
    expect(sheet.pageCount).toBeGreaterThanOrEqual(1);
    expect(sheet.fileName).toMatch(/\.pdf$/);
    expect(new TextDecoder().decode(sheet.bytes.slice(0, 5))).toBe('%PDF-');
  });

  it('is deterministic for the same rows and date', async () => {
    const date = new Date('2026-09-10T00:00:00Z');
    const a = await buildCheatSheet(rows, { date });
    const b = await buildCheatSheet(rows, { date });
    expect(a.pageCount).toBe(b.pageCount);
    expect(a.bytes.length).toBe(b.bytes.length);
  });

  it('paginates rather than running off the bottom of the page', async () => {
    const many: BindableCommand[] = Array.from({ length: 400 }, (_, i) => ({
      id: `demo.command${String(i)}`,
      label: `A command with a reasonably long label number ${String(i)}`,
      category: 'Edit',
      defaultKey: `Mod+Alt+${String(i % 10)}`,
    }));
    const sheet = await buildCheatSheet(buildRows(many), {
      date: new Date('2026-09-10T00:00:00Z'),
    });
    expect(sheet.pageCount).toBeGreaterThan(1);
    expect(sheet.commandCount).toBe(400);
  });

  it('survives a label full of characters the standard fonts have never heard of', async () => {
    const odd = buildRows([
      { id: 'x.y', label: 'Sign \u{1f58a}\u{fe0f} 中文', category: 'Edit', defaultKey: 'Mod+J' },
    ]);
    const sheet = await buildCheatSheet(odd);
    expect(sheet.pageCount).toBe(1);
  });
});

describe('normalizeKey, as the editor relies on it', () => {
  it('puts the modifiers in one order whatever order they were typed', () => {
    expect(normalizeKey('shift+mod+p')).toBe('Mod+Shift+P');
    expect(normalizeKey('Mod+Shift+P')).toBe('Mod+Shift+P');
  });
});

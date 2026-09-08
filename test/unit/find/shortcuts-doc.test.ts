/**
 * `docs/shortcuts.md` for M13, checked the same way M11 checks its own rows: a document that has
 * drifted from the code is worse than none.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Registry, normalizeKey } from '@core/Registry';
import selectFindManifest from '@modules/M13-select-find-print/manifest';

const DOC = readFileSync(join(process.cwd(), 'docs', 'shortcuts.md'), 'utf8');

/** Command ids the document claims a key for, as `command → the keys listed beside it`. */
function documentedCommands(): Map<string, string> {
  const rows = new Map<string, string>();
  for (const line of DOC.split('\n')) {
    const cells = line.split('|').map((c) => c.trim());
    if (cells.length < 4) continue;
    const keys = cells[1] ?? '';
    const command = (cells[2] ?? '').replaceAll('`', '');
    if (!/^[a-z][a-zA-Z0-9]*(\.[a-zA-Z0-9]+)+$/.test(command)) continue;
    rows.set(command, keys);
  }
  return rows;
}

describe('docs/shortcuts.md — M13', () => {
  const registry = new Registry();
  registry.register(selectFindManifest);

  it('documents every key M13 binds', () => {
    const documented = documentedCommands();
    for (const spec of registry.allShortcuts()) {
      expect(documented.has(spec.command), `${spec.key} → ${spec.command}`).toBe(true);
    }
  });

  it('the keys it lists for M13 commands are the keys M13 binds', () => {
    const documented = documentedCommands();
    for (const spec of registry.allShortcuts()) {
      const listed = documented.get(spec.command) ?? '';
      const wanted = normalizeKey(spec.key).replace('Mod+', '');
      const last = wanted.split('+').pop() ?? wanted;
      expect(listed.toLowerCase(), `${spec.command} lists "${listed}"`).toContain(
        last.toLowerCase(),
      );
    }
  });

  it('names the module’s headline commands', () => {
    const documented = documentedCommands();
    for (const command of [
      'edit.find',
      'edit.findNext',
      'edit.findPrevious',
      'edit.search',
      'edit.copy',
      'edit.copyFormatted',
      'edit.selectAll',
      'file.print',
      'tool.snapshot.activate',
    ]) {
      expect(documented.has(command), command).toBe(true);
    }
  });

  it('says what happens inside a text field, and what Select Text can do', () => {
    expect(DOC).toContain('Inside a text field');
    expect(DOC).toContain('Alt`-drag to take a column');
  });
});

describe('the M13 manifest', () => {
  const registry = new Registry();
  registry.register(selectFindManifest);

  it('registers every command with a category the palette can group by', () => {
    for (const command of registry.allCommands()) {
      expect(command.label.length).toBeGreaterThan(0);
      expect(command.category.length).toBeGreaterThan(0);
    }
  });

  it('keeps the developer probes out of the palette', () => {
    const visible = registry.allCommands().filter((c) => !c.hidden);
    expect(visible.some((c) => c.id.startsWith('dev.'))).toBe(false);
    expect(visible.length).toBeGreaterThan(15);
  });

  it('contributes the search panel, the snapshot tool and the print backstage slot', () => {
    expect(registry.panels().map((p) => p.id)).toContain('nav.search');
    expect(registry.tools().map((t) => t.id)).toContain('tool.snapshot');
    expect(selectFindManifest.backstage?.map((b) => b.slot)).toContain('print');
  });

  it('every ribbon item names a command that exists', () => {
    const known = new Set(registry.allCommands().map((c) => c.id));
    // `tool.selectText.activate` is M11's; everything else must be ours.
    known.add('tool.selectText.activate');
    for (const group of registry.ribbonGroups()) {
      for (const item of group.items) {
        const id = typeof item === 'string' ? item : 'command' in item ? item.command : undefined;
        if (!id || id === '-') continue;
        expect(known.has(id), `${group.id} → ${id}`).toBe(true);
      }
    }
  });

  it('every context-menu item names a command that exists', () => {
    const known = new Set(registry.allCommands().map((c) => c.id));
    for (const menu of selectFindManifest.contextMenus ?? []) {
      for (const item of menu.items) {
        const id = typeof item === 'string' ? item : item.command;
        if (!id || id === '-') continue;
        expect(known.has(id), `${menu.id} → ${id}`).toBe(true);
      }
    }
  });
});

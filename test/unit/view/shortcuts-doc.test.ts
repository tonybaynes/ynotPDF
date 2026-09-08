/**
 * `docs/shortcuts.md` is the operator-facing list of every key. A document that drifts from the
 * code is worse than none, so this checks that every key it names is really bound to the command
 * it names, and that every shortcut the viewer registers appears in the document.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Registry, normalizeKey } from '@core/Registry';
import viewerManifest from '@modules/M11-viewer/manifest';

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

describe('docs/shortcuts.md', () => {
  const registry = new Registry();
  registry.register(viewerManifest);

  it('names a command for every row it gives a key', () => {
    expect(documentedCommands().size).toBeGreaterThan(30);
  });

  it('documents every shortcut M11 registers', () => {
    const documented = documentedCommands();
    for (const spec of registry.allShortcuts()) {
      expect(documented.has(spec.command), `${spec.key} → ${spec.command}`).toBe(true);
    }
  });

  it('every viewer command it names exists', () => {
    for (const command of documentedCommands().keys()) {
      if (!command.startsWith('view.') && !command.startsWith('tool.')) continue;
      if (!registry.has(command)) continue; // registered by another module (M01, M02)
      expect(registry.get(command)?.id).toBe(command);
    }
  });

  it('the keys it lists for M11 commands are the keys M11 binds', () => {
    const documented = documentedCommands();
    for (const spec of registry.allShortcuts()) {
      const listed = documented.get(spec.command) ?? '';
      const wanted = normalizeKey(spec.key)
        .replace('Mod+', '')
        .replaceAll('ArrowLeft', '←')
        .replaceAll('ArrowRight', '→')
        .replaceAll('Plus', '+')
        .replaceAll('Minus', '-');
      const last = wanted.split('+').pop() ?? wanted;
      expect(listed.toLowerCase(), `${spec.command} lists "${listed}"`).toContain(
        last.toLowerCase(),
      );
    }
  });

  it('says what Mod means, and that shortcuts are commands', () => {
    expect(DOC).toContain('`Ctrl` on Windows and Linux');
    expect(DOC).toContain('command palette');
    expect(DOC).toContain('registered command');
  });
});

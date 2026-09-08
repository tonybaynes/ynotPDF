/**
 * The manifest, and the two documents that have to agree with it.
 *
 * A shortcut bound twice is worse than one bound not at all — the Registry's rule is
 * last-binding-wins, so the loser vanishes silently — and `docs/shortcuts.md` is what the operator
 * reads instead of the source. Both are checked here against the whole app's manifests, not just
 * M30's, because a conflict is by definition between two modules.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Registry, normalizeKey } from '@core/Registry';
import { findConflicts } from '@app/shortcuts';
import type { ModuleManifest } from '@shared/module';
import themeManifest from '@modules/M01-theme-system/manifest';
import shellManifest from '@modules/M02-app-shell/manifest';
import viewerManifest from '@modules/M11-viewer/manifest';
import selectFindManifest from '@modules/M13-select-find-print/manifest';
import documentManifest from '@modules/M20-document-model/manifest';
import saveManifest from '@modules/M21-save/manifest';
import annotationManifest from '@modules/M30-markup-annotations/manifest';
import { ANNOTATION_TOOLS } from '@modules/M30-markup-annotations/settings';

const MANIFESTS: ReadonlyArray<ModuleManifest> = [
  themeManifest,
  shellManifest,
  documentManifest,
  viewerManifest,
  saveManifest,
  selectFindManifest,
  annotationManifest,
];

function bindings(): Array<{ key: string; command: string }> {
  const out: Array<{ key: string; command: string }> = [];
  for (const m of MANIFESTS) {
    for (const c of m.commands ?? []) if (c.shortcut) out.push({ key: c.shortcut, command: c.id });
    for (const s of m.shortcuts ?? []) out.push({ key: s.key, command: s.command });
  }
  return out;
}

describe('M30’s manifest', () => {
  const registry = new Registry();
  for (const m of MANIFESTS) registry.register(m);

  it('registers a command for every tool it ships', () => {
    for (const tool of ANNOTATION_TOOLS) {
      expect(registry.has(`annot.${tool}`), tool).toBe(true);
    }
    for (const tool of annotationManifest.tools ?? []) {
      expect(registry.has(`${tool.id}.activate`), tool.id).toBe(true);
    }
  });

  it('every command is in the palette, or hidden on purpose', () => {
    for (const command of annotationManifest.commands ?? []) {
      if (command.hidden) {
        expect(command.id.startsWith('dev.') || command.id === 'annot.setText', command.id).toBe(
          true,
        );
        continue;
      }
      expect(command.category, command.id).toBe('Comment');
      expect(command.description, command.id).toBeTruthy();
    }
  });

  it('everything that changes the document asks for the annotate permission', () => {
    const changes = [
      'annot.highlight',
      'annot.underline',
      'annot.squiggly',
      'annot.strikeout',
      'annot.replace',
      'annot.insert',
      'annot.note',
      'annot.typewriter',
      'annot.textbox',
      'annot.callout',
      'annot.delete',
      'annot.cut',
      'annot.paste',
      'annot.reply',
      'annot.setColor',
      'annot.setStatus',
    ];
    for (const id of changes) {
      expect(registry.get(id)?.permission, id).toBe('annotate');
    }
    // Copying and selecting change nothing, so a protected file must still allow them.
    expect(registry.get('annot.copy')?.permission).toBeUndefined();
    expect(registry.get('annot.selectAll')?.permission).toBeUndefined();
  });

  it('binds no key another module has already taken', () => {
    const ours = new Set(
      bindings()
        .filter((b) => b.command.startsWith('annot.'))
        .map((b) => normalizeKey(b.key)),
    );
    const clashes = findConflicts(bindings()).filter((c) => ours.has(c.key));
    expect(clashes).toEqual([]);
    /*
     * There *is* one conflict in the app, and it is not M30's: `Mod+G` is bound by M11 to
     * `view.page.goTo` and by M13 to `edit.findNext`, and the Registry's last-binding-wins rule
     * makes it Find Next. That happens to be what Foxit does with the key, so the behaviour is
     * right and the binding is redundant rather than wrong; it is recorded here so the next
     * change to either module does not think it introduced it. M130's shortcut editor is where it
     * gets resolved.
     */
    expect(findConflicts(bindings()).map((c) => c.key)).toEqual(['Mod+G']);
  });

  it('its ribbon groups all live on the Comment tab and are small enough to fit', () => {
    const groups = annotationManifest.ribbon ?? [];
    expect(groups.length).toBeGreaterThan(0);
    for (const group of groups) {
      expect(group.tab, group.id).toBe('comment');
      // A group that does not fit collapses into one button and takes its neighbours with it
      // (the lesson M13 recorded), so six controls is the ceiling here.
      expect(group.items.length, group.id).toBeLessThanOrEqual(6);
    }
  });

  it('the properties panel is on the right and only appears with a selection', () => {
    const panel = (annotationManifest.panels ?? [])[0];
    expect(panel?.dock).toBe('right');
    expect(panel?.when).toBeTypeOf('function');
  });
});

describe('docs/shortcuts.md', () => {
  const doc = readFileSync(join(process.cwd(), 'docs', 'shortcuts.md'), 'utf8');

  /** Command ids the document gives a key, as `command → the keys beside it`. */
  const documented = new Map<string, string>();
  for (const line of doc.split('\n')) {
    const cells = line.split('|').map((c) => c.trim());
    if (cells.length < 4) continue;
    const command = (cells[2] ?? '').replaceAll('`', '');
    if (!/^[a-z][a-zA-Z0-9]*(\.[a-zA-Z0-9]+)+$/.test(command)) continue;
    documented.set(command, cells[1] ?? '');
  }

  it('documents every key M30 binds, with the key it actually binds', () => {
    for (const spec of bindings()) {
      if (!spec.command.startsWith('annot.')) continue;
      const row = documented.get(spec.command);
      expect(row, `${spec.key} → ${spec.command}`).toBeDefined();
      expect(row?.replaceAll('`', '')).toContain(normalizeKey(spec.key));
    }
  });

  it('names every comment command it lists, and they all exist', () => {
    const registry = new Registry();
    for (const m of MANIFESTS) registry.register(m);
    let named = 0;
    for (const command of documented.keys()) {
      if (!command.startsWith('annot.')) continue;
      named++;
      expect(registry.has(command), command).toBe(true);
    }
    expect(named).toBeGreaterThan(10);
  });
});

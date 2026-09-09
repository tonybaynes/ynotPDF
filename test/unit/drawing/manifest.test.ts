/**
 * M31's manifest, and the two documents that have to agree with it — the same checks M30 runs,
 * over the whole app's manifests, because a shortcut clash is by definition between two modules.
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
import navigationManifest from '@modules/M12-navigation-panels/manifest';
import selectFindManifest from '@modules/M13-select-find-print/manifest';
import documentManifest from '@modules/M20-document-model/manifest';
import saveManifest from '@modules/M21-save/manifest';
import annotationManifest from '@modules/M30-markup-annotations/manifest';
import drawingManifest from '@modules/M31-shapes-ink-stamps/manifest';
import { DRAWING_TOOLS } from '@modules/M31-shapes-ink-stamps/settings';
import { TOOL_ID } from '@modules/M31-shapes-ink-stamps/tools';

const MANIFESTS: ReadonlyArray<ModuleManifest> = [
  themeManifest,
  shellManifest,
  documentManifest,
  viewerManifest,
  navigationManifest,
  saveManifest,
  selectFindManifest,
  annotationManifest,
  drawingManifest,
];

function bindings(): Array<{ key: string; command: string }> {
  const out: Array<{ key: string; command: string }> = [];
  for (const m of MANIFESTS) {
    for (const c of m.commands ?? []) if (c.shortcut) out.push({ key: c.shortcut, command: c.id });
    for (const s of m.shortcuts ?? []) out.push({ key: s.key, command: s.command });
  }
  return out;
}

describe('M31’s manifest', () => {
  const registry = new Registry();
  for (const m of MANIFESTS) registry.register(m);

  it('registers a command for every drawing tool it ships', () => {
    for (const tool of DRAWING_TOOLS) expect(registry.has(`draw.${tool}`), tool).toBe(true);
    expect(registry.has('draw.eraser')).toBe(true);
    for (const id of Object.values(TOOL_ID)) expect(registry.has(`${id}.activate`), id).toBe(true);
    expect((drawingManifest.tools ?? []).map((t) => t.id).sort()).toEqual(
      Object.values(TOOL_ID).sort(),
    );
  });

  it('every command is in the palette, or hidden on purpose', () => {
    for (const command of drawingManifest.commands ?? []) {
      if (command.hidden) {
        expect(
          command.id.startsWith('dev.') || command.id === 'draw.pencilEndGroup',
          command.id,
        ).toBe(true);
        continue;
      }
      expect(['Comment', 'View']).toContain(command.category);
      expect(command.description, command.id).toBeTruthy();
    }
  });

  it('everything that changes the document asks for the annotate permission', () => {
    for (const id of [
      'draw.rectangle',
      'draw.ellipse',
      'draw.line',
      'draw.arrow',
      'draw.polygon',
      'draw.polyline',
      'draw.cloud',
      'draw.areaHighlight',
      'draw.pencil',
      'draw.eraser',
      'draw.stamp',
      'draw.stampRotate',
      'draw.attachFile',
    ]) {
      expect(registry.get(id)?.permission, id).toBe('annotate');
    }
    // The palette and the settings change nothing in the file.
    expect(registry.get('draw.stamps')?.permission).toBeUndefined();
    expect(registry.get('draw.stampFavourite')?.permission).toBeUndefined();
  });

  it('binds no key another module has already taken', () => {
    const ours = new Set(
      bindings()
        .filter((b) => b.command.startsWith('draw.'))
        .map((b) => normalizeKey(b.key)),
    );
    expect(ours.size).toBeGreaterThan(0);
    const clashes = findConflicts(bindings()).filter((c) => ours.has(c.key));
    expect(clashes).toEqual([]);
    // The one pre-existing clash M30 recorded, and nothing new.
    expect(findConflicts(bindings()).map((c) => c.key)).toEqual(['Mod+G']);
  });

  it('its ribbon groups all live on the Comment tab and are small enough to fit', () => {
    const groups = drawingManifest.ribbon ?? [];
    expect(groups.length).toBe(3);
    for (const group of groups) {
      expect(group.tab, group.id).toBe('comment');
      expect(group.items.length, group.id).toBeLessThanOrEqual(6);
    }
  });

  it('the stamp palette docks on the left with a toggle command of its own', () => {
    const panel = (drawingManifest.panels ?? [])[0];
    expect(panel?.dock).toBe('left');
    expect(panel?.toggleCommand).toBe('draw.stamps');
    expect(registry.has('draw.stamps')).toBe(true);
  });
});

describe('docs/shortcuts.md', () => {
  const doc = readFileSync(join(process.cwd(), 'docs', 'shortcuts.md'), 'utf8');
  const documented = new Map<string, string>();
  for (const line of doc.split('\n')) {
    const cells = line.split('|').map((c) => c.trim());
    if (cells.length < 4) continue;
    const command = (cells[2] ?? '').replaceAll('`', '');
    if (!/^[a-z][a-zA-Z0-9]*(\.[a-zA-Z0-9]+)+$/.test(command)) continue;
    documented.set(command, cells[1] ?? '');
  }

  it('documents every key M31 binds, with the key it actually binds', () => {
    for (const spec of bindings()) {
      if (!spec.command.startsWith('draw.')) continue;
      const row = documented.get(spec.command);
      expect(row, `${spec.key} → ${spec.command}`).toBeDefined();
      expect(row?.replaceAll('`', '')).toContain(normalizeKey(spec.key));
    }
  });

  it('names every drawing command it lists, and they all exist', () => {
    const registry = new Registry();
    for (const m of MANIFESTS) registry.register(m);
    let named = 0;
    for (const command of documented.keys()) {
      if (!command.startsWith('draw.')) continue;
      named++;
      expect(registry.has(command), command).toBe(true);
    }
    expect(named).toBeGreaterThanOrEqual(12);
  });
});

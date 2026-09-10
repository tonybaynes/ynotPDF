/**
 * M33's manifest, and the two documents that have to agree with it — the same checks M30 and M31
 * run, over the whole app's manifests, because a shortcut clash is by definition between two
 * modules.
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
import measuringManifest from '@modules/M33-measuring-tools/manifest';
import { RESULTS_PANEL_ID } from '@modules/M33-measuring-tools/MeasureService';
import { TOOL_ID } from '@modules/M33-measuring-tools/tools';

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
  measuringManifest,
];

function bindings(): Array<{ key: string; command: string }> {
  const out: Array<{ key: string; command: string }> = [];
  for (const m of MANIFESTS) {
    for (const c of m.commands ?? []) if (c.shortcut) out.push({ key: c.shortcut, command: c.id });
    for (const s of m.shortcuts ?? []) out.push({ key: s.key, command: s.command });
  }
  return out;
}

describe('M33’s manifest', () => {
  const registry = new Registry();
  for (const m of MANIFESTS) registry.register(m);

  it('registers a command for every tool and every action it ships', () => {
    for (const id of [
      'measure.distance',
      'measure.perimeter',
      'measure.area',
      'measure.calibrate',
      'measure.scale',
      'measure.clearPageScale',
      'measure.snap',
      'measure.snapKind',
      'measure.results',
      'measure.copy',
      'measure.export',
    ]) {
      expect(registry.has(id), id).toBe(true);
    }
    for (const id of Object.values(TOOL_ID)) expect(registry.has(`${id}.activate`), id).toBe(true);
    expect((measuringManifest.tools ?? []).map((t) => t.id).sort()).toEqual(
      Object.values(TOOL_ID).sort(),
    );
  });

  it('every command is in the palette, or hidden on purpose', () => {
    for (const command of measuringManifest.commands ?? []) {
      if (command.hidden) {
        expect(command.id.startsWith('dev.') || command.id === 'measure.reveal', command.id).toBe(
          true,
        );
        continue;
      }
      expect(['Comment', 'View']).toContain(command.category);
      expect(command.description, command.id).toBeTruthy();
    }
  });

  it('everything that changes the document asks for the annotate permission', () => {
    for (const id of [
      'measure.distance',
      'measure.perimeter',
      'measure.area',
      'measure.calibrate',
    ]) {
      expect(registry.get(id)?.permission, id).toBe('annotate');
    }
    // The panel, the snap toggles and the exports change nothing in the file.
    for (const id of ['measure.results', 'measure.snap', 'measure.copy', 'measure.export']) {
      expect(registry.get(id)?.permission, id).toBeUndefined();
    }
  });

  it('binds no key another module has already taken', () => {
    const ours = new Set(
      bindings()
        .filter((b) => b.command.startsWith('measure.'))
        .map((b) => normalizeKey(b.key)),
    );
    expect(ours.size).toBe(2);
    const clashes = findConflicts(bindings()).filter((c) => ours.has(c.key));
    expect(clashes).toEqual([]);
    // The one pre-existing clash M30 recorded, and nothing new.
    expect(findConflicts(bindings()).map((c) => c.key)).toEqual(['Mod+G']);
  });

  it('its ribbon group lives on the Comment tab, after M31’s, and is small enough to fit', () => {
    const groups = measuringManifest.ribbon ?? [];
    expect(groups).toHaveLength(1);
    const group = groups[0];
    expect(group?.tab).toBe('comment');
    expect(group?.items.length ?? 0).toBeLessThanOrEqual(6);
    // M31's three groups are at 25, 26 and 27.
    expect(group?.order ?? 0).toBeGreaterThan(27);
  });

  it('the results panel docks on the left with a toggle command of its own', () => {
    const panel = (measuringManifest.panels ?? [])[0];
    expect(panel?.id).toBe(RESULTS_PANEL_ID);
    expect(panel?.dock).toBe('left');
    expect(panel?.toggleCommand).toBe('measure.results');
    expect(registry.has('measure.results')).toBe(true);
  });

  it('offers a settings schema M130 can render', () => {
    expect(measuringManifest.settings?.namespace).toBe('measure');
    expect(Object.keys(measuringManifest.settings?.properties ?? {}).length).toBeGreaterThan(4);
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

  it('documents every key M33 binds, with the key it actually binds', () => {
    for (const spec of bindings()) {
      if (!spec.command.startsWith('measure.')) continue;
      const row = documented.get(spec.command);
      expect(row, `${spec.key} → ${spec.command}`).toBeDefined();
      expect(row?.replaceAll('`', '')).toContain(normalizeKey(spec.key));
    }
  });

  it('names every measuring command it lists, and they all exist', () => {
    const registry = new Registry();
    for (const m of MANIFESTS) registry.register(m);
    let named = 0;
    for (const command of documented.keys()) {
      if (!command.startsWith('measure.')) continue;
      named++;
      expect(registry.has(command), command).toBe(true);
    }
    expect(named).toBeGreaterThanOrEqual(10);
  });

  it('lists every measuring tool under Tools', () => {
    for (const id of Object.values(TOOL_ID)) {
      expect(documented.has(`${id}.activate`), id).toBe(true);
    }
  });
});

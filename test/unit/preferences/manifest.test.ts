/**
 * M130's manifest, and the two contract additions it leans on (`Registry.unbindShortcut` and
 * `Registry.serviceNames`).
 *
 * The most valuable assertion here is the last one: **every shortcut in the whole application,
 * with M130 in the build, is claimed by exactly one command.** M130 is the module that makes
 * conflicts visible to the reader, so it would be a poor joke for it to introduce one.
 */

import { describe, expect, it } from 'vitest';
import { Dialogs } from '@app/dialog/Dialogs';
import { fileTabGroups, RecentCache } from '@app/ribbon/fileTab';
import { findConflicts } from '@app/shortcuts';
import { Registry, normalizeKey } from '@core/Registry';
import type { ModuleManifest } from '@shared/module';
import preferencesManifest, {
  PAGE_CUSTOMISE,
  PAGE_FILE,
  PAGE_SHORTCUTS,
} from '@modules/M130-preferences/manifest';
import { APP_KEYS } from '@modules/M130-preferences/PreferencesService';
import { RIBBON_CUSTOM_KEY } from '@modules/M130-preferences/customise/model';
import { OVERRIDES_KEY } from '@modules/M130-preferences/shortcuts/model';
import { RULER_UNITS_KEY, UNITS_KEY } from '@modules/M130-preferences/units';

/** Every manifest `src/renderer/main.ts` registers, in the same order. */
const MODULE_PATHS = [
  '@modules/M00-scaffold/manifest',
  '@modules/M01-theme-system/manifest',
  '@modules/M02-app-shell/manifest',
  '@modules/M10-engine-layer/manifest',
  '@modules/M20-document-model/manifest',
  '@modules/M11-viewer/manifest',
  '@modules/M12-navigation-panels/manifest',
  '@modules/M21-save/manifest',
  '@modules/M13-select-find-print/manifest',
  '@modules/M30-markup-annotations/manifest',
  '@modules/M31-shapes-ink-stamps/manifest',
  '@modules/M32-comments-panel/manifest',
  '@modules/M33-measuring-tools/manifest',
  '@modules/M40-organise-pages/manifest',
  '@modules/M41-merge-split-crop/manifest',
  '@modules/M70-encryption/manifest',
  '@modules/M72-properties-metadata/manifest',
  '@modules/M91-create-pdf/manifest',
  '@modules/M42-portfolios/manifest',
  '@modules/M50-object-model/manifest',
  '@modules/M60-forms/manifest',
  '@modules/M130-preferences/manifest',
];

async function wholeApp(): Promise<Registry> {
  const registry = new Registry();
  // `main.ts` registers these before any manifest; some `when()` clauses look them up.
  registry.provide('registry', registry);
  registry.provide('shell', { get: () => ({ documentTitle: null }) });
  for (const path of MODULE_PATHS) {
    const module = (await import(/* @vite-ignore */ path)) as { default: ModuleManifest };
    registry.register(module.default);
  }
  return registry;
}

describe('the manifest', () => {
  it('is M130 and fills the File tab’s Preferences slot', () => {
    expect(preferencesManifest.id).toBe('M130');
    expect(preferencesManifest.backstage?.[0]).toMatchObject({
      slot: 'preferences',
      command: 'app.preferences',
    });
  });

  it('registers a command for everything the module does', () => {
    const ids = (preferencesManifest.commands ?? []).map((c) => c.id);
    for (const id of [
      'app.preferences',
      'app.identity.edit',
      'app.shortcuts.edit',
      'app.shortcuts.reset',
      'app.shortcuts.cheatSheet',
      'app.shortcuts.export',
      'app.shortcuts.import',
      'app.customise.ribbon',
      'app.customise.reset',
      'app.settings.export',
      'app.settings.import',
      'app.settings.reset',
      'app.settings.reveal',
      'app.language.set',
      'app.uiFont.set',
      'app.units.set',
    ]) {
      expect(ids).toContain(id);
    }
  });

  it('gives every visible command a label, a category and a description', () => {
    for (const command of preferencesManifest.commands ?? []) {
      expect(command.label).not.toBe('');
      expect(command.category).not.toBe('');
      if (command.hidden !== true) expect(command.description).toBeTruthy();
    }
  });

  it('opens on Ctrl/Cmd+K, with Mod+, as the other convention', () => {
    const open = (preferencesManifest.commands ?? []).find((c) => c.id === 'app.preferences');
    expect(open?.shortcut).toBe('Mod+K');
    expect(preferencesManifest.shortcuts).toContainEqual({
      key: 'Mod+,',
      command: 'app.preferences',
      scope: 'global',
    });
  });

  it('declares the identity, language, units and font settings', () => {
    const properties = preferencesManifest.settings?.properties ?? {};
    expect(preferencesManifest.settings?.namespace).toBe('app');
    for (const name of [
      'identity.name',
      'identity.initials',
      'identity.email',
      'identity.organisation',
      'language',
      'units',
      'uiFont',
    ]) {
      expect(properties[name]).toBeDefined();
    }
  });

  it('puts the identity settings in a section of their own', () => {
    const properties = preferencesManifest.settings?.properties ?? {};
    expect(properties['identity.name']?.section).toBe('Identity');
    expect(properties['units']?.section).toBe('Language and units');
  });

  it('names its three non-schema pages once each', () => {
    expect(new Set([PAGE_SHORTCUTS, PAGE_CUSTOMISE, PAGE_FILE]).size).toBe(3);
  });

  it('keeps the settings keys it owns in one place', () => {
    expect(APP_KEYS.units).toBe(UNITS_KEY);
    expect(UNITS_KEY).not.toBe(RULER_UNITS_KEY);
    expect(OVERRIDES_KEY).toBe('shortcuts.bindings');
    expect(RIBBON_CUSTOM_KEY).toBe('ui.ribbon.custom');
  });

  it('adds a Help ribbon group and a ribbon context menu, and no document commands', () => {
    expect(preferencesManifest.ribbon?.[0]?.tab).toBe('help');
    expect(preferencesManifest.contextMenus?.[0]?.region).toBe('ribbon');
    // Nothing here changes a document, so nothing here is a tool.
    expect(preferencesManifest.tools ?? []).toEqual([]);
  });
});

describe('the whole application, with M130 in it', () => {
  it('no two commands claim the same key', async () => {
    const registry = await wholeApp();
    expect(findConflicts(registry.allShortcuts())).toEqual([]);
  });

  it('has no duplicate command ids', async () => {
    // `Registry.register` throws on a duplicate, so getting here is the assertion.
    const registry = await wholeApp();
    const ids = registry.allCommands().map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  /**
   * The palette lists every registered command whose `when()` passes and that is not hidden.
   * A `when()` needs the running application's services, so what is checked here is what this
   * module controls — that each command is registered and only deliberately hidden ones say so.
   * The palette itself is driven for real in `test/e2e/preferences.spec.ts`.
   */
  it('registers every M130 command, and hides only the two meant for tests', async () => {
    const registry = await wholeApp();
    const hidden = new Set<string>();
    for (const command of preferencesManifest.commands ?? []) {
      expect(registry.has(command.id)).toBe(true);
      if (command.hidden === true) hidden.add(command.id);
    }
    expect([...hidden].sort()).toEqual([
      'app.preferences.close',
      'app.settings.get',
      'app.settings.set',
      'app.shortcuts.set',
    ]);
  });

  it('binds Preferences to one key, and to the second convention as well', async () => {
    const registry = await wholeApp();
    expect(registry.shortcutForKey('Mod+K')?.command).toBe('app.preferences');
    expect(registry.shortcutForKey('Mod+,')?.command).toBe('app.preferences');
    expect(registry.shortcutFor('app.preferences')).toBe('Mod+K');
  });
});

/**
 * M130 fills the last empty File-tab slot, which leaves `shell.spec.ts` with nothing to point at
 * when it checks that an *unfilled* slot is disabled and says "not available yet". That behaviour
 * is M02's and still matters — the next module to add a slot will rely on it — so it is kept
 * under test here, against the function that produces it.
 */
describe('the File tab’s slots', () => {
  it('renders a filled command slot as that command’s own button', async () => {
    const registry = await wholeApp();
    const groups = fileTabGroups({
      registry,
      recent: new RecentCache(),
      dialogs: new Dialogs(),
    });
    const items = groups.flatMap((group) => group.items);
    const preferences = items.find(
      (item) => typeof item === 'object' && 'command' in item && item.command === 'app.preferences',
    );
    expect(preferences).toBeDefined();
    expect(items).not.toContainEqual(expect.objectContaining({ command: 'file.slot.preferences' }));
  });

  it('renders an unfilled slot disabled, with the words "not available yet"', () => {
    // A registry with no module in it: every slot is unfilled.
    const empty = new Registry();
    const groups = fileTabGroups({
      registry: empty,
      recent: new RecentCache(),
      dialogs: new Dialogs(),
    });
    const items = groups.flatMap((group) => group.items);
    const preferences = items.find(
      (item) =>
        typeof item === 'object' && 'command' in item && item.command === 'file.slot.preferences',
    );
    expect(preferences).toMatchObject({ title: 'Preferences — not available yet' });
  });
});

describe('Registry.unbindShortcut (ADR 0018)', () => {
  it('frees a key so a rebound command does not leave its old one live', () => {
    const registry = new Registry();
    registry.register({
      id: 'M900',
      name: 'Test',
      commands: [
        { id: 'a.one', label: 'One', category: 'Edit', shortcut: 'Mod+F', run: () => 1 },
        { id: 'a.two', label: 'Two', category: 'Edit', run: () => 2 },
      ],
    });
    expect(registry.shortcutForKey('Mod+F')?.command).toBe('a.one');
    const removed = registry.unbindShortcut('mod+f');
    expect(removed?.command).toBe('a.one');
    expect(registry.shortcutForKey('Mod+F')).toBeUndefined();
    expect(registry.shortcutFor('a.one')).toBeUndefined();
    registry.bindShortcut({ key: normalizeKey('Mod+Shift+F'), command: 'a.one' });
    expect(registry.shortcutFor('a.one')).toBe('Mod+Shift+F');
  });

  it('says nothing was there when nothing was', () => {
    expect(new Registry().unbindShortcut('Mod+Alt+Y')).toBeUndefined();
  });
});

describe('Registry.serviceNames (ADR 0018)', () => {
  it('lists what is registered, sorted, so the reload order is the same everywhere', () => {
    const registry = new Registry();
    registry.provide('zebra', {});
    registry.provide('alpha', {});
    expect(registry.serviceNames()).toEqual(['alpha', 'zebra']);
  });
});

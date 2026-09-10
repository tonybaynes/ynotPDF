/**
 * M60's manifest, and the three promises it makes to the rest of the app: every action is a
 * command in the palette, no key it binds is one another module already had, and the panels and
 * tools it declares are the ones the service and the controller look for by id.
 *
 * The shortcut check registers every manifest the renderer registers, because a clash is by
 * definition between two modules — the same check M30, M31 and M33 run.
 */

import { describe, expect, it } from 'vitest';
import { Registry } from '@core/Registry';
import { findConflicts } from '@app/shortcuts';
import type { ModuleManifest } from '@shared/module';
import { FIELD_ROLES, FIELD_ROLE_LABELS, TAB_ORDER_MODES } from '@engine/forms/model';
import formsManifest, { parsePages } from '@modules/M60-forms/manifest';
import {
  FIELD_PANEL_ID,
  FIELD_PROPERTIES_PANEL_ID,
  FORM_SERVICE,
} from '@modules/M60-forms/FormService';
import {
  PLACE_TOOL_PREFIX,
  SELECT_TOOL_ID,
  placeToolId,
  roleOfTool,
} from '@modules/M60-forms/tools';

/** Every manifest `main.ts` registers, in the order it registers them. */
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
  registry.provide('registry', registry);
  registry.provide('shell', { get: () => ({ documentTitle: null }) });
  for (const path of MODULE_PATHS) {
    const module = (await import(/* @vite-ignore */ path)) as { default: ModuleManifest };
    registry.register(module.default);
  }
  return registry;
}

describe('M60’s manifest', () => {
  it('is M60 and registers its service, panels and tools by the ids the code looks for', () => {
    expect(formsManifest.id).toBe('M60');
    const panels = (formsManifest.panels ?? []).map((p) => p.id);
    expect(panels).toEqual([FIELD_PANEL_ID, FIELD_PROPERTIES_PANEL_ID]);
    const tools = (formsManifest.tools ?? []).map((t) => t.id);
    expect(tools).toContain(SELECT_TOOL_ID);
    for (const role of FIELD_ROLES) expect(tools).toContain(placeToolId(role));
    expect(FORM_SERVICE).toBe('forms');
  });

  it('offers a placement command for every field type, on the Form tab', () => {
    const ids = (formsManifest.commands ?? []).map((c) => c.id);
    for (const role of FIELD_ROLES) expect(ids).toContain(`form.place.${role}`);
    const group = (formsManifest.ribbon ?? []).find((g) => g.id === 'form.fields');
    expect(group?.tab).toBe('form');
    for (const role of FIELD_ROLES) {
      const named = (group?.items ?? []).some((item) =>
        typeof item === 'string'
          ? item === `form.place.${role}`
          : 'command' in item && item.command === `form.place.${role}`,
      );
      expect(named, `${FIELD_ROLE_LABELS[role]} is on the ribbon`).toBe(true);
    }
  });

  it('gives every command a category, a description and a `when` clause', () => {
    for (const command of formsManifest.commands ?? []) {
      expect(command.category, command.id).toBeTruthy();
      expect(command.description, command.id).toBeTruthy();
      expect(typeof command.when, command.id).toBe('function');
    }
  });

  it('marks every command that changes the document with the permission it needs', () => {
    const changes =
      /^form\.(place|delete|cut|paste|duplicate|move|align|distribute|matchSize|setTabOrder|tabOrder|select$)/;
    for (const command of formsManifest.commands ?? []) {
      if (!changes.test(command.id)) continue;
      expect(command.permission, command.id).toBeTruthy();
    }
  });

  it('has a command for each tab-order rule, and one to set an order by hand', () => {
    const ids = (formsManifest.commands ?? []).map((c) => c.id);
    for (const mode of TAB_ORDER_MODES) {
      if (mode === 'manual') continue;
      expect(ids).toContain(`form.tabOrder.${mode}`);
    }
    expect(ids).toContain('form.setTabOrder');
    expect(ids).toContain('form.showTabOrder');
  });

  it('hides the probes and the argument-only commands from the palette', () => {
    const hidden = (formsManifest.commands ?? []).filter((c) => c.hidden).map((c) => c.id);
    expect(hidden).toContain('form.probe.fields');
    expect(hidden).toContain('form.probe.selection');
    expect(hidden).toContain('form.place');
  });

  it('binds no key another module already had', async () => {
    const registry = await wholeApp();
    expect(findConflicts(registry.allShortcuts())).toEqual([]);
  });

  it('registers every one of its commands, under an id nothing else claims', async () => {
    const registry = await wholeApp();
    const all = registry.allCommands();
    expect(new Set(all.map((c) => c.id)).size).toBe(all.length);
    const registered = new Set(all.map((c) => c.id));
    for (const command of formsManifest.commands ?? []) {
      expect(registered.has(command.id), command.id).toBe(true);
    }
  });
});

describe('the tools', () => {
  it('names a placement tool after the role it places, and reads it back', () => {
    for (const role of FIELD_ROLES) {
      expect(placeToolId(role)).toBe(`${PLACE_TOOL_PREFIX}${role}`);
      expect(roleOfTool(placeToolId(role))).toBe(role);
    }
    expect(roleOfTool(SELECT_TOOL_ID)).toBeNull();
    expect(roleOfTool(null)).toBeNull();
    expect(roleOfTool(`${PLACE_TOOL_PREFIX}nonsense`)).toBeNull();
  });
});

describe('the page list Duplicate Across Pages takes', () => {
  it('reads a range, a list and "all"', () => {
    expect(parsePages('2-4', 10)).toEqual([1, 2, 3]);
    expect(parsePages('1,3,5', 10)).toEqual([0, 2, 4]);
    expect(parsePages('all', 3)).toEqual([0, 1, 2]);
    expect(parsePages('', 2)).toEqual([0, 1]);
  });

  it('drops what is not in the document rather than guessing', () => {
    expect(parsePages('0,1,99', 3)).toEqual([0]);
    expect(parsePages('nonsense', 3)).toEqual([]);
  });

  it('reads a backwards range forwards, which is what the reader meant', () => {
    expect(parsePages('4-2', 10)).toEqual([1, 2, 3]);
  });
});

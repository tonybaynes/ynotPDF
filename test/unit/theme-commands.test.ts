/**
 * M01 manifest tests: every theme action is a registered command with a palette entry, the
 * arguments are validated, and the UI-scale commands disable themselves at the limits.
 */

import { describe, expect, it } from 'vitest';
import { Registry } from '@core/Registry';
import { memoryStorage, ThemeManager, type ThemeState } from '@theme/ThemeManager';
import { THEMES, UI_SCALE_MAX, UI_SCALE_MIN } from '@theme/themes';
import themeManifest, { THEME_SERVICE } from '@modules/M01-theme-system/manifest';

/** See theme-manager.test.ts: ThemeManager only needs `dataset` and `style.setProperty`. */
function fakeRoot(): HTMLElement {
  return {
    dataset: {},
    style: { setProperty: () => undefined },
  } as unknown as HTMLElement;
}

async function setup(saved?: Partial<ThemeState>): Promise<{
  registry: Registry;
  themes: ThemeManager;
}> {
  const themes = await ThemeManager.create({
    root: fakeRoot(),
    storage: memoryStorage(saved ?? {}),
  });
  const registry = new Registry();
  registry.provide(THEME_SERVICE, themes);
  registry.register(themeManifest);
  registry.activateAll();
  return { registry, themes };
}

describe('M01 manifest', () => {
  it('registers every theme command in the palette', async () => {
    const { registry } = await setup();
    const ids = registry.allCommands().map((c) => c.id);
    expect(ids).toContain('view.theme.set');
    expect(ids).toContain('view.theme.next');
    expect(ids).toContain('view.theme.previous');
    for (const theme of THEMES) expect(ids).toContain(`view.theme.set.${theme.name}`);
    for (const id of ['view.uiScale.increase', 'view.uiScale.decrease', 'view.uiScale.reset']) {
      expect(ids).toContain(id);
    }
    const palette = registry.paletteEntries().map((e) => e.id);
    expect(palette).toContain('view.theme.next');
    expect(palette).toContain('view.theme.set.daylight');
    // The internal reporter stays out of the palette.
    expect(palette).not.toContain('view.theme.current');
  });

  it('binds shortcuts for cycling and scaling', async () => {
    const { registry } = await setup();
    expect(registry.shortcutFor('view.theme.next')).toBe('Mod+Alt+T');
    expect(registry.shortcutFor('view.uiScale.reset')).toBe('Mod+Alt+0');
    expect(registry.shortcutForKey('Mod+Alt+T')?.command).toBe('view.theme.next');
  });

  it('adds an Appearance group to the View ribbon tab', async () => {
    const { registry } = await setup();
    const group = registry.ribbonGroups().find((g) => g.id === 'view.appearance');
    expect(group?.tab).toBe('view');
    expect(group?.items).toContain('view.theme.next');
  });

  it('declares a settings schema M130 can build a preferences page from', () => {
    expect(themeManifest.settings?.namespace).toBe('theme');
    const scale = themeManifest.settings?.properties['scale'];
    expect(scale).toMatchObject({ type: 'number', min: UI_SCALE_MIN, max: UI_SCALE_MAX });
    const name = themeManifest.settings?.properties['name'];
    expect(name).toMatchObject({ type: 'enum', default: 'graphite' });
  });

  it('applies a theme by name', async () => {
    const { registry, themes } = await setup();
    await expect(registry.run('view.theme.set', { theme: 'daylight' })).resolves.toBe('daylight');
    expect(themes.current).toBe('daylight');
    await expect(registry.run('view.theme.set.high-contrast')).resolves.toBe('high-contrast');
    expect(themes.current).toBe('high-contrast');
  });

  it('rejects a missing or unknown theme argument', async () => {
    const { registry } = await setup();
    await expect(registry.run('view.theme.set')).rejects.toThrow(/needs \{ theme \}/);
    await expect(registry.run('view.theme.set', { theme: 'beige' })).rejects.toThrow(
      /needs \{ theme \}/,
    );
  });

  it('cycles themes through the command table', async () => {
    const { registry, themes } = await setup();
    await registry.run('view.theme.next');
    expect(themes.current).toBe('midnight');
    await registry.run('view.theme.previous');
    expect(themes.current).toBe('graphite');
  });

  it('reports the current state', async () => {
    const { registry } = await setup({ theme: 'midnight', scale: 120 });
    await expect(registry.run('view.theme.current')).resolves.toEqual({
      theme: 'midnight',
      scale: 120,
    });
  });

  it('scales the interface and disables the commands at the limits', async () => {
    const { registry, themes } = await setup();
    expect(registry.isEnabled('view.uiScale.decrease')).toBe(false); // already at 100 %
    expect(registry.isEnabled('view.uiScale.increase')).toBe(true);
    await expect(registry.run('view.uiScale.increase')).resolves.toBe(110);
    expect(registry.isEnabled('view.uiScale.decrease')).toBe(true);
    await expect(registry.run('view.uiScale.set', { percent: 200 })).resolves.toBe(200);
    expect(registry.isEnabled('view.uiScale.increase')).toBe(false);
    await expect(registry.run('view.uiScale.reset')).resolves.toBe(100);
    expect(themes.uiScale).toBe(100);
  });

  it('rejects a UI scale that is not a number', async () => {
    const { registry } = await setup();
    await expect(registry.run('view.uiScale.set', { percent: '150' })).rejects.toThrow(
      /needs \{ percent \}/,
    );
  });
});

/**
 * Renderer entry (M00): boots the Registry, registers module manifests, mounts the empty
 * shell frame, wires keyboard shortcuts and native-menu commands, and (only when launched
 * with `YNOT_E2E=1`) installs the `window.__ynot` test harness.
 */

import { Registry } from '@core/Registry';
import { Selection } from '@core/Selection';
import { createStore } from '@core/Store';
import { EngineClient } from '@engine/EngineClient';
import { hasBridge, on, getBridge } from '@shared/ipc';
import { installShortcuts } from '@app/shortcuts';
import { mountShell, type ShellState } from '@app/shell';
import { installTestHarness } from '@app/testHarness';
import scaffoldManifest from '@modules/M00-scaffold/manifest';
import themeManifest, { THEME_SERVICE } from '@modules/M01-theme-system/manifest';
import { ipcThemeStorage } from '@modules/M01-theme-system/storage';
import { ThemeManager } from '@theme/ThemeManager';

/**
 * Boot order: the theme is applied before the shell mounts so the first paint is already in the
 * user's chosen theme (M01).
 */
const themes = await ThemeManager.create({ storage: ipcThemeStorage() });

const registry = new Registry();
const selection = new Selection();
const shell = createStore<ShellState>({
  documentTitle: null,
  statusMessage: 'Ready',
  theme: themes.current,
});
themes.onChange((state) => {
  shell.set({ theme: state.theme });
});

// The engine Worker starts at boot; M10 makes it a real PDFium engine.
const engineClient = EngineClient.spawn();

registry.provide('selection', selection);
registry.provide('shell', shell);
registry.provide('registry', registry);
registry.provide('engine', engineClient.engine);
registry.provide('engineClient', engineClient);
registry.provide(THEME_SERVICE, themes);

registry.register(scaffoldManifest);
registry.register(themeManifest);

const isMac = hasBridge() ? getBridge().platform === 'darwin' : navigator.userAgent.includes('Mac');
registry.provide('platform', { isMac });

const root = document.getElementById('app');
if (!root) throw new Error('#app root missing');
mountShell(root, registry, shell);
registry.activateAll();
installShortcuts(registry, isMac);

if (hasBridge()) {
  on('menu:command', ({ id, args }) => {
    void registry.run(id, args ?? {}).catch((error: unknown) => {
      console.error(`menu command ${id} failed`, error);
    });
  });
  on('file:openRequested', (file) => {
    void registry.run('file.openBytes', { file }).catch((error: unknown) => {
      console.error('open request failed', error);
    });
  });
  if (getBridge().e2e) installTestHarness(registry);
}

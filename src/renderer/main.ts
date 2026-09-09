/**
 * Renderer entry (M00): boots the Registry, registers module manifests, mounts the shell
 * (M02), wires keyboard shortcuts and native-menu commands, and (only when launched with
 * `YNOT_E2E=1`) installs the `window.__ynot` test harness plus the demo module that exercises
 * every shell widget.
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
import shellManifest from '@modules/M02-app-shell/manifest';
import engineManifest from '@modules/M10-engine-layer/manifest';
import viewerManifest from '@modules/M11-viewer/manifest';
import navigationManifest from '@modules/M12-navigation-panels/manifest';
import portfolioManifest from '@modules/M42-portfolios/manifest';
import selectFindManifest from '@modules/M13-select-find-print/manifest';
import annotationManifest from '@modules/M30-markup-annotations/manifest';
import drawingManifest from '@modules/M31-shapes-ink-stamps/manifest';
import commentsManifest from '@modules/M32-comments-panel/manifest';
import documentManifest from '@modules/M20-document-model/manifest';
import saveManifest from '@modules/M21-save/manifest';
import organiseManifest from '@modules/M40-organise-pages/manifest';
import securityManifest from '@modules/M70-encryption/manifest';
import createManifest from '@modules/M91-create-pdf/manifest';
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

const isMac = hasBridge() ? getBridge().platform === 'darwin' : navigator.userAgent.includes('Mac');
registry.provide('platform', { isMac });

registry.register(scaffoldManifest);
registry.register(themeManifest);
registry.register(shellManifest);
registry.register(engineManifest);
registry.register(documentManifest);
registry.register(viewerManifest);
registry.register(navigationManifest);
registry.register(saveManifest);
registry.register(selectFindManifest);
registry.register(annotationManifest);
registry.register(drawingManifest);
registry.register(commentsManifest);
registry.register(organiseManifest);
registry.register(securityManifest);
registry.register(createManifest);
registry.register(portfolioManifest);

const e2e = hasBridge() && getBridge().e2e;
if (e2e) {
  // The demo module is the shell's regression suite; it exists only in e2e runs.
  const { default: demoManifest } = await import('../../test/e2e/demo-module/manifest');
  registry.register(demoManifest);
}

const root = document.getElementById('app');
if (!root) throw new Error('#app root missing');
const shellHandle = await mountShell(root, { registry, selection, isMac, shellState: shell });
registry.activateAll();
installShortcuts(registry, isMac, {
  onAltTap: () => {
    shellHandle.ribbon.toggleKeyTips();
  },
});

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
  if (e2e) installTestHarness(registry);
}

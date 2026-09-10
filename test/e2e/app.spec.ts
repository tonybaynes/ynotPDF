import { expect, test } from '@playwright/test';
import { launchApp, type App } from './harness';

let app: App;

test.beforeAll(async () => {
  app = await launchApp();
});

test.afterAll(async () => {
  await app.close();
});

/**
 * The guard on the invisible test windows.
 *
 * A run parks its windows off every display and makes them transparent so it cannot take over
 * the operator's machine. Chromium's answer to a window nobody can see is to background its
 * renderer: `requestAnimationFrame` drops to one frame a second and timers are coalesced. Every
 * test that measures a frame rate, drags something or waits for a paint then fails, and none of
 * them says why — seven did exactly that on the Linux runner on 2026-09-10, reporting 1.19 fps
 * where they wanted 30.
 *
 * So this asks the renderer directly, and it asks first: the page must consider itself visible,
 * and it must really turn frames over. Twenty a second is far below what any machine manages and
 * far above the one a second a throttled renderer gives, so it separates the two without being a
 * performance test of the runner.
 */
test('the renderer is not background-throttled, however the window is shown', async () => {
  const measured = await app.page.evaluate(async () => {
    const started = performance.now();
    let frames = 0;
    await new Promise<void>((resolve) => {
      const tick = (): void => {
        frames++;
        if (performance.now() - started >= 600) resolve();
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    return {
      fps: (frames * 1000) / (performance.now() - started),
      hidden: document.hidden,
      visibility: document.visibilityState,
    };
  });
  expect(measured.hidden, 'the page thinks it is hidden').toBe(false);
  expect(measured.visibility).toBe('visible');
  expect(
    measured.fps,
    `animation frames are throttled (${String(Math.round(measured.fps))} fps)`,
  ).toBeGreaterThan(20);
});

test('launches to the empty shell', async () => {
  await expect(app.page).toHaveTitle('ynotPDF');
  await expect(app.page.locator('#empty-state')).toBeVisible();
  await expect(app.page.locator('#statusbar')).toContainText('Ready');
  await expect(app.page.locator('#ribbon-tabs [role="tab"]')).toHaveCount(11);
  await expect(app.page.locator('#ribbon-tabs [data-tab="file"]')).toHaveText('File');
  expect(await app.page.evaluate(() => document.documentElement.dataset['theme'])).toBe('graphite');
  // Shortcut hints are rendered per platform, never as the raw "Mod" token.
  const hint = await app.page.locator('#empty-state kbd').first().textContent();
  expect(hint).toMatch(/^(Ctrl|⌘)\+O$/);
  // The empty document host must not be laid out with nothing open: visible it claims `flex: 1`
  // and pushes the tiles into the bottom half behind a dead black band (2026-09-10).
  await expect(app.page.locator('#doc-host')).toBeHidden();
  // …and the tiles must start at the top of the document area, not be centre-clipped above it.
  const clippedAbove = await app.page.evaluate(() => {
    const state = document.querySelector('#empty-state');
    const first = document.querySelector('#empty-state .empty-title');
    if (!state || !first) return null;
    return first.getBoundingClientRect().top - state.getBoundingClientRect().top;
  });
  expect(clippedAbove).not.toBeNull();
  expect(clippedAbove).toBeGreaterThanOrEqual(0);
});

// A panel mounted before `registry.activateAll()` is built against services that do not exist
// yet, and the nav pane caches it: M12's Pages panel came up as "the navigation panels are not
// available" and never recovered, so no thumbnail ever appeared (2026-09-10).
test('the panel open at startup is mounted after the modules activate', async () => {
  expect(await app.run('demo.panelMountedActivated')).toBe(true);
  await expect(app.page.locator('#pane-left .nav-empty')).toHaveCount(0);
  await expect(app.page.locator('#pane-left .panel-error')).toHaveCount(0);
});

// One tab row, not two: off macOS the ribbon's tabs are the only tabs, so there is no
// application menu drawing File/Edit/View/Window/Help above them (2026-09-10). Every command it
// held is in the ribbon or the palette, and the renderer binds all of its accelerators itself.
test('there is no second tab row above the ribbon', async () => {
  const hasAppMenu = await app.electron.evaluate(({ Menu }) => Menu.getApplicationMenu() !== null);
  expect(hasAppMenu).toBe(process.platform === 'darwin');
  // The tab row is always there, and the ribbon below it is open unless the reader minimises it.
  await expect(app.page.locator('#ribbon-tabs')).toBeVisible();
  await expect(app.page.locator('#ribbon-body')).toBeVisible();
});

test('registers the core commands', async () => {
  const ids = await app.commands();
  for (const id of [
    'file.open',
    'app.about',
    'app.commandPalette',
    'edit.undo',
    'edit.redo',
    'app.quit',
  ]) {
    expect(ids).toContain(id);
  }
});

test("__ynot.run('app.about') opens the About dialog", async () => {
  const result = await app.run('app.about');
  expect(result).toEqual({ open: true });
  const dialog = app.page.locator('#about-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('About ynotPDF');
  await expect(dialog).toContainText('Electron');
  // Who makes it and where to find them (operator, 2026-09-10). One source: @shared/brand.
  // The app's own version, not Electron's — `app.getVersion()` answers with Electron's when the
  // app is not packaged, and About said "ynotPDF 44.2.0" (2026-09-10).
  const version = await dialog.locator('dd[data-field="version"]').textContent();
  const electron = await dialog.locator('dd[data-field="electron"]').textContent();
  expect(version).not.toBe(electron);
  expect(version).toMatch(/^\d+\.\d+\.\d+/);
  await expect(dialog).toContainText('Made by Ynot Apps');
  await expect(dialog.locator('#about-website')).toHaveText('ynot-apps.com');
  await expect(dialog.locator('#about-copyright')).toContainText('Ynot Apps');
  await app.page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});

test('the command palette lists commands and runs one', async () => {
  await app.run('app.commandPalette');
  const palette = app.page.locator('#command-palette');
  await expect(palette).toBeVisible();
  await palette.locator('input').fill('about');
  await expect(palette.locator('li[data-command="app.about"]')).toBeVisible();
  await app.page.keyboard.press('Enter');
  await expect(palette).toBeHidden();
  await expect(app.page.locator('#about-dialog')).toBeVisible();
  await app.page.keyboard.press('Escape');
});

test('unknown commands reject', async () => {
  await expect(app.run('does.not.exist')).rejects.toThrow(/Unknown command/);
});

test('the engine worker answers over RPC', async () => {
  const info = await app.run('dev.engineInfo');
  // M10: the worker now serves PDFium (WASM); M00 shipped the NotImplemented stub here.
  expect(info).toMatchObject({ name: 'pdfium' });
});

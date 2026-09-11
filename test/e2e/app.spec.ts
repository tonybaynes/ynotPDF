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
 * A run hides its windows so it cannot take over the operator's machine, and a hidden window is
 * one Chromium may stop drawing. `requestAnimationFrame` is driven by the compositor, and the
 * compositor draws surfaces that are on a screen: park a window off every display under X11 and
 * the frames fall to about two a second. Every test that measures a frame rate, drags something,
 * waits for a `ResizeObserver` or waits for a paint then fails, and none of them says why — seven
 * did exactly that on the Linux runner on 2026-09-10, one of them reporting 1.19 fps against a
 * floor of 30.
 *
 * The page reports itself **visible** the whole time, which is what made it so hard to see. So
 * this asks the renderer both questions, and asks them first: does it think it is visible, and
 * does it actually turn frames over. Twenty a second is far below what any machine manages and
 * far above what a window that is not being drawn gives, so it separates the two without being a
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

/**
 * A run never interrupts Tony's machine.
 *
 * He works on his Windows PC while a suite runs, so a window there is parked off-screen and
 * transparent (`CLAUDE.md`). Nowhere else needs it: the macOS, Linux and ARM runners have nobody
 * in front of them, and macOS would not have obliged anyway — it clamps a window back onto the
 * display, which CI proved the first time this test ran, reporting **0,31** for a window that
 * asked for -32000,-32000 (2026-09-11).
 *
 * So this is a Windows test, deliberately, and it is the only thing holding that promise —
 * `window.ts` decides parking on one condition that someone will eventually simplify.
 */
test('a window in a run on Tony’s machine is off every display, and transparent', async () => {
  test.skip(process.platform !== 'win32', 'windows are only parked on Tony’s Windows machine');
  test.skip(
    process.env['YNOT_E2E_VISIBLE'] === '1',
    'the run was asked for visible windows on purpose',
  );

  // Asked as "does it overlap a display the reader has", not as a coordinate threshold: the
  // number `window.ts` passes is not the number that takes effect — Windows clamps -32000 to
  // -16384 — and a threshold would be a guess about a platform rather than a statement about a
  // screen.
  const where = await app.electron.evaluate(({ BrowserWindow, screen }) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) return { bounds: { x: 0, y: 0, width: 0, height: 0 }, opacity: 1, overlaps: 0 };
    const b = win.getBounds();
    const overlaps = screen
      .getAllDisplays()
      .map((display) => display.bounds)
      .filter(
        (d) =>
          b.x < d.x + d.width &&
          b.x + b.width > d.x &&
          b.y < d.y + d.height &&
          b.y + b.height > d.y,
      ).length;
    return { bounds: b, opacity: win.getOpacity(), overlaps };
  });

  const at = `${String(where.bounds.x)},${String(where.bounds.y)} ${String(where.bounds.width)}x${String(where.bounds.height)}`;
  expect(where.overlaps, `the window at ${at} overlaps a display Tony can see`).toBe(0);
  expect(where.opacity, `the window at ${at} is not transparent`).toBe(0);
});

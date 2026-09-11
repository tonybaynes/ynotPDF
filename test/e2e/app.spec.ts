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
 * A window in an e2e run is parked off a real display, and transparent.
 *
 * `CLAUDE.md`: "E2E windows are invisible (off-screen, transparent, inactive) so a run never
 * interrupts the operator's machine." That is the promise; this is the only thing holding it, and
 * `window.ts` now parks conditionally per platform after the Xvfb work — the shape of code
 * someone simplifies later without knowing what the branch was for.
 *
 * **What this does not cover.** Tony sees a window outline flash up during runs, every now and
 * again, and this is not a test for that. A probe of two full runs (`src/main/windowProbe.ts`)
 * recorded every window created, shown, focused, maximised and taken full screen, and **no window
 * was ever both visible and on a real display** — so whatever he is seeing does not come from
 * this suite's window lifecycle, and there is nothing here to regress against. See
 * `docs/open-work.md` §3 (2026-09-11).
 *
 * Linux is exempt: `window.ts` does not park windows there.
 */
test('a window in a run is parked off-screen and transparent', async () => {
  test.skip(process.platform === 'linux', 'windows are not parked off-screen on Linux');
  test.skip(
    process.env['YNOT_E2E_VISIBLE'] === '1',
    'the run was asked for visible windows on purpose',
  );

  const where = await app.electron.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) return { x: 0, y: 0, opacity: 1 };
    const bounds = win.getBounds();
    return { x: bounds.x, y: bounds.y, opacity: win.getOpacity() };
  });

  // Windows clamps the requested -32000 to -16384, so this asks "far off any display", not for
  // the exact number `window.ts` passes.
  expect(
    where.x < -1000 || where.y < -1000,
    `the window is at ${String(where.x)},${String(where.y)} — on a real display`,
  ).toBe(true);
  expect(where.opacity, 'a parked window is transparent').toBe(0);
});

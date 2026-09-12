import { expect, test } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { launchApp, type App } from '../harness';
import { closeEverything, journey } from '../journey';
import { expectWindowSound } from '../layout';

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';
let app: App;
let workspace: string;
let bytes: Uint8Array;
let serial = 0;

interface Guide {
  page: number;
  axis: 'vertical' | 'horizontal';
  at: number;
}
interface ViewState {
  zoom: number;
  readingMode: boolean;
  fullScreen: boolean;
  guides: Guide[];
}

test.beforeAll(async () => {
  workspace = mkdtempSync(join(tmpdir(), 'ynot-viewer-input-'));
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([600, 800]);
  page.drawText('Viewer keyboard and guide acceptance', { x: 60, y: 720, size: 16 });
  bytes = await pdf.save();
  app = await launchApp({ noDemo: true });
});

async function fullScreen(): Promise<boolean> {
  return app.electron.evaluate(({ BrowserWindow }) =>
    Boolean(BrowserWindow.getAllWindows()[0]?.isFullScreen()),
  );
}

async function state(): Promise<ViewState> {
  return (await app.run('dev.viewerState')) as ViewState;
}

async function open(): Promise<string> {
  const path = join(workspace, `viewer-input-${++serial}.pdf`);
  writeFileSync(path, bytes);
  const j = journey(app);
  await j.openDocument(path);
  await j.clickRibbon('view', 'Tool: Hand');
  await j.clickRibbon('view', 'Fit Page');
  await j.clickPageAt([0.5, 0.5]);
  return path;
}

test.afterEach(async () => {
  // A failed Escape assertion must still return the shared app to windowed reading.
  if (await fullScreen()) {
    await app.page.keyboard.press('F11');
    await expect.poll(fullScreen).toBe(false);
  }
  if (await app.page.locator('.viewer-reading-bar').isVisible()) {
    await app.page.keyboard.press(`${MOD}+h`);
    await expect(app.page.locator('.viewer-reading-bar')).toHaveCount(0);
  }
  await closeEverything(app);
});

test.afterAll(async () => {
  await app.close();
  rmSync(workspace, { recursive: true, force: true });
});

test('M11 — F11 enters full screen and Escape returns to the window', async () => {
  await open();
  expect(await fullScreen()).toBe(false);
  await app.page.keyboard.press('F11');
  await expect.poll(fullScreen, { timeout: 15000 }).toBe(true);
  await expect.poll(async () => (await state()).fullScreen).toBe(true);
  await app.page.keyboard.press('Escape');
  await expect.poll(fullScreen, { timeout: 15000 }).toBe(false);
  await expect.poll(async () => (await state()).fullScreen).toBe(false);
  await expectWindowSound(app.page);
});

test('M11 — Escape dismisses an active tool before leaving full screen', async () => {
  await open();
  const j = journey(app);
  await j.clickRibbon('view', 'Loupe');
  await expect(app.page.locator('.viewer-loupe')).toBeVisible();
  await app.page.keyboard.press('F11');
  await expect.poll(fullScreen, { timeout: 15000 }).toBe(true);

  await app.page.keyboard.press('Escape');
  await expect(app.page.locator('.viewer-loupe')).toHaveCount(0);
  expect(await fullScreen()).toBe(true);

  await app.page.keyboard.press('Escape');
  await expect.poll(fullScreen, { timeout: 15000 }).toBe(false);
  await expectWindowSound(app.page);
});

test('M11 — reading mode leaves by Escape and restores its chrome', async () => {
  await open();
  await app.page.keyboard.press(`${MOD}+h`);
  await expect.poll(async () => (await state()).readingMode).toBe(true);
  await expect(app.page.locator('#ribbon')).toBeHidden();
  await expect(app.page.locator('.viewer-reading-bar')).toBeVisible();
  await app.page.keyboard.press('Escape');
  await expect.poll(async () => (await state()).readingMode).toBe(false);
  await expect(app.page.locator('#ribbon')).toBeVisible();
  await expect(app.page.locator('#tabstrip')).toBeVisible();
  await expect(app.page.locator('#statusbar')).toBeVisible();
  await expect(app.page.locator('.viewer-reading-bar')).toHaveCount(0);
  await expectWindowSound(app.page);
});

test('M11 — Escape closes a modal before leaving reading mode', async () => {
  await open();
  await app.page.keyboard.press(`${MOD}+h`);
  await expect.poll(async () => (await state()).readingMode).toBe(true);

  await app.page.keyboard.press(`${MOD}+Shift+p`);
  const palette = app.page.locator('#command-palette');
  await expect(palette).toBeVisible();
  await app.page.keyboard.press('Escape');
  await expect(palette).toBeHidden();
  expect((await state()).readingMode).toBe(true);

  await app.page.keyboard.press('Escape');
  await expect.poll(async () => (await state()).readingMode).toBe(false);
  await expectWindowSound(app.page);
});

test('M11 — guides dragged from both rulers persist through closing and Recent-file reopening', async () => {
  const path = await open();
  const j = journey(app);
  await j.clickRibbon('view', 'Rulers');
  const horizontal = app.page.locator('.viewer-ruler-h:visible');
  const vertical = app.page.locator('.viewer-ruler-v:visible');
  await expect(horizontal).toBeVisible();
  await expect(vertical).toBeVisible();
  const page = await j.pageBox();
  const target = { x: page.x + page.width * 0.4, y: page.y + page.height * 0.35 };
  const expected: Guide[] = [];
  for (const [axis, ruler] of [
    ['horizontal', horizontal],
    ['vertical', vertical],
  ] as const) {
    const box = await ruler.boundingBox();
    if (!box) throw new Error(`${axis} ruler has no visible bounds`);
    await app.page.mouse.move(
      axis === 'horizontal' ? target.x : box.x + box.width / 2,
      axis === 'vertical' ? target.y : box.y + box.height / 2,
    );
    await app.page.mouse.down();
    await app.page.mouse.move(target.x, target.y, { steps: 12 });
    await app.page.mouse.up();
    await expect.poll(async () => (await state()).guides.length).toBe(expected.length + 1);
    const current = await state();
    const guide = current.guides.find((g) => g.axis === axis);
    if (!guide) throw new Error(`${axis} ruler drag did not create a guide`);
    const at =
      axis === 'vertical'
        ? (target.x - page.x) / current.zoom
        : 800 - (target.y - page.y) / current.zoom;
    expect(guide.page).toBe(0);
    expect(Math.abs(guide.at - at)).toBeLessThanOrEqual(1 / current.zoom);
    expected.push(guide);
    const line = app.page.locator(`.viewer-guide-${axis === 'vertical' ? 'v' : 'h'}`);
    await expect(line).toBeVisible();
    const lineBox = await line.boundingBox();
    if (!lineBox) throw new Error(`${axis} guide has no visible bounds`);
    // The box includes the symmetric three-pixel transparent grab area. Its centre is the
    // one-pixel guide ink and must still land on the independent pointer-drop coordinate.
    const ink =
      axis === 'vertical' ? lineBox.x + lineBox.width / 2 : lineBox.y + lineBox.height / 2;
    expect(Math.abs(ink - (axis === 'vertical' ? target.x : target.y))).toBeLessThanOrEqual(1);
  }

  await app.page.getByRole('button', { name: `Close ${basename(path)}`, exact: true }).click();
  await expect(app.page.locator('.viewer-content .page')).toHaveCount(0);
  // Reopen through the visible Recent-files button, not a command-created guide or document.
  await app.page
    .locator('.recent-open:visible')
    .filter({ hasText: basename(path) })
    .first()
    .click();
  await expect(j.page()).toBeVisible();
  await expect.poll(async () => (await state()).guides).toEqual(expected);
  await expect(app.page.locator('.viewer-guide')).toHaveCount(2);
  await expect(app.page.locator('.viewer-guide-v')).toBeVisible();
  await expect(app.page.locator('.viewer-guide-h')).toBeVisible();
  await expectWindowSound(app.page);
});

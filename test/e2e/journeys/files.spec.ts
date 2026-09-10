/**
 * Journeys — files in and out (M21, M42, M70, M72, M91).
 *
 * Saving from the ribbon, opening a file inside a portfolio by double-clicking it, protecting a
 * document with a password and finding it asked for on the way back in, reading the document's
 * properties, and making a PDF by dropping a picture on the window.
 */

import { expect, test } from '@playwright/test';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchApp, type App } from '../harness';
import { closeEverything, journey } from '../journey';
import { expectNothingClipped, expectReadable, expectWindowSound } from '../layout';

const FIXTURES = join(process.cwd(), 'test', 'fixtures');

let app: App;
let workspace: string;

test.beforeAll(async () => {
  app = await launchApp({ noDemo: true });
  workspace = mkdtempSync(join(tmpdir(), 'ynot-m04-files-'));
});

test.afterAll(async () => {
  await app.close();
  rmSync(workspace, { recursive: true, force: true });
});

test.afterEach(async () => {
  await closeEverything(app);
});

function stage(name: string, as: string): string {
  const path = join(workspace, as);
  copyFileSync(join(FIXTURES, name), path);
  return path;
}

// ---- M21 -------------------------------------------------------------------------------------

test('M21 — an edited document is saved with the ribbon’s Save button and the file changes', async () => {
  const j = journey(app);
  const path = stage('multipage.pdf', 'save.pdf');
  const before = statSync(path).size;
  await j.openDocument(path);

  await j.clickRibbon('organize', 'Rotate Right');
  await app.page.waitForTimeout(600);
  expect(((await app.run('dev.saveState')) as { dirty: boolean }).dirty).toBe(true);
  // The status bar says so in a word, not just a colour.
  await expect(app.page.locator('#statusbar')).toContainText(/unsaved|not saved|edited/i);

  await j.clickRibbon('home', 'Save');
  await expect
    .poll(async () => ((await app.run('dev.saveState')) as { dirty: boolean }).dirty, {
      timeout: 20_000,
    })
    .toBe(false);
  expect(statSync(path).size, 'the file on disk did not change').not.toBe(before);

  await expectWindowSound(app.page);
});

// ---- M42 -------------------------------------------------------------------------------------

test('M42 — a portfolio shows its files, and double-clicking one opens it', async () => {
  const j = journey(app);
  await j.openDocument(stage('portfolio.pdf', 'portfolio.pdf'));

  const grid = app.page.locator('[data-testid="portfolio-grid"]');
  await expect(grid, 'a portfolio must open on its file list, not its cover sheet').toBeVisible({
    timeout: 20_000,
  });
  const rows = grid.locator('[data-row]');
  expect(await rows.count(), 'the portfolio listed no files').toBeGreaterThan(0);
  await expectNothingClipped(grid);
  await expectReadable(grid);

  // The PDF inside it: the fixture also holds a .txt and a .csv, which are the OS's to open.
  const inner = rows.filter({ hasText: 'instruction.pdf' }).first();
  await expect(inner, 'the portfolio does not list the PDF inside it').toHaveCount(1);
  const tabsBefore = await app.page.locator('.tab').count();
  await inner.dblclick();
  await expect(app.page.locator('.tab'), 'double-clicking a file did not open it').toHaveCount(
    tabsBefore + 1,
    { timeout: 20_000 },
  );
  await expect(app.page.locator('.viewer-content .page').first()).toBeVisible({ timeout: 20_000 });

  await expectWindowSound(app.page);
});

// ---- M70 -------------------------------------------------------------------------------------

test('M70 — a password set in the Protect dialog is asked for when the file is opened again', async () => {
  const j = journey(app);
  const path = stage('multipage.pdf', 'protected.pdf');
  await j.openDocument(path);

  await j.clickRibbon('protect', 'Protect…');
  const dialog = app.page.locator('#security-dialog');
  await expect(dialog).toBeVisible({ timeout: 15_000 });
  await expectNothingClipped(dialog);
  await expectReadable(dialog);

  await dialog.locator('#security-user-password').fill('open-sesame');
  await dialog.locator('#security-user-confirm').fill('open-sesame');
  await j.clickDialogButton('#security-dialog', 'Apply');
  await expect(dialog).toHaveCount(0);

  // "Protection is applied when the document is next saved" — so save it.
  await j.clickRibbon('home', 'Save');
  await expect
    .poll(async () => ((await app.run('dev.saveState')) as { dirty: boolean }).dirty, {
      timeout: 30_000,
    })
    .toBe(false);
  expect(
    readFileSync(path).toString('latin1').includes('/Encrypt'),
    'the saved file carries no encryption dictionary',
  ).toBe(true);
  await closeEverything(app);

  // Open it again in a *new session*. The session that set the password still holds it, which is
  // right — it would be absurd to ask the reader for a password they typed a moment ago — so the
  // question this test asks (does the file ask?) can only be asked by a fresh launch.
  const second = await launchApp({ noDemo: true, open: [path] });
  try {
    const ask = second.page.locator('#password-dialog');
    await expect(ask, 'the protected file opened without asking for a password').toBeVisible({
      timeout: 30_000,
    });
    await expectReadable(ask);
    await ask.locator('#password-input').fill('open-sesame');
    await journey(second).clickDialogButton('#password-dialog', 'Open');
    await expect(second.page.locator('.viewer-content .page').first()).toBeVisible({
      timeout: 30_000,
    });
    await expectWindowSound(second.page);
  } finally {
    await second.close();
  }
});

// ---- M72 -------------------------------------------------------------------------------------

test('M72 — Document Properties opens from the ribbon and reads the file back', async () => {
  const j = journey(app);
  await j.openDocument(stage('multipage.pdf', 'properties.pdf'));

  await j.clickRibbon('view', 'Document Properties…');
  const dialog = app.page.locator('#properties-dialog');
  await expect(dialog).toBeVisible({ timeout: 15_000 });
  await expect(dialog).toContainText('properties.pdf');
  await expectNothingClipped(dialog);
  await expectReadable(dialog);
  await app.page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);

  await expectWindowSound(app.page);
});

// ---- M91 -------------------------------------------------------------------------------------

test('M91 — a picture dropped on the window becomes a PDF', async () => {
  const j = journey(app);
  const png = readFileSync(join(FIXTURES, 'create', 'logo-alpha.png'));

  // A real drop on the window, which is how a person makes a PDF out of a picture — not a
  // command call with the bytes already in hand.
  await app.page.evaluate(async (data: number[]) => {
    const file = new File([new Uint8Array(data)], 'logo-alpha.png', { type: 'image/png' });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    const root = document.getElementById('app');
    if (!root) throw new Error('#app missing');
    root.dispatchEvent(new DragEvent('dragover', { dataTransfer: transfer, bubbles: true }));
    root.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true }));
    await Promise.resolve();
  }, Array.from(png));

  const dialog = app.page.locator('#create-images-dialog');
  await expect(dialog, 'dropping a picture did not offer to make a PDF of it').toBeVisible({
    timeout: 20_000,
  });
  await expect(dialog).toContainText('logo-alpha.png');
  await expectNothingClipped(dialog);
  await expectReadable(dialog);

  await j.clickDialogButton('#create-images-dialog', 'Create');
  await expect(app.page.locator('.viewer-content .page').first()).toBeVisible({ timeout: 30_000 });
  const summary = (await app.run('dev.documentSummary')) as { pageCount: number };
  expect(summary.pageCount).toBe(1);

  await expectWindowSound(app.page);
});

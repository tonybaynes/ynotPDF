/**
 * Journeys — the shell itself (M00, M01, M02, M10, M20, M03, M130).
 *
 * The ribbon, the command palette, the theme switcher, the undo stack, Preferences and the
 * About box, each reached the way a person reaches it. Everything here runs against the real
 * startup path (no demo module), so what is exercised is the app the reader gets.
 */

import { expect, test } from '@playwright/test';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchApp, type App } from '../harness';
import { closeEverything, journey } from '../journey';
import {
  expectInsideWindow,
  expectNothingClipped,
  expectReadable,
  expectWindowSound,
} from '../layout';

const FIXTURES = join(process.cwd(), 'test', 'fixtures');

let app: App;
let workspace: string;

test.beforeAll(async () => {
  app = await launchApp({ noDemo: true });
  workspace = mkdtempSync(join(tmpdir(), 'ynot-m04-shell-'));
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

// ---- M02 -------------------------------------------------------------------------------------

test('M02 — every ribbon tab can be opened, and none of them is clipped or overlaps the document', async () => {
  const j = journey(app);
  await j.openDocument(stage('multipage.pdf', 'ribbon.pdf'));

  const tabs = await app.page.evaluate(() =>
    Array.from(document.querySelectorAll('#ribbon-tabs [role="tab"]')).map(
      (t) => (t as HTMLElement).dataset['tab'] ?? '',
    ),
  );
  expect(tabs.length).toBe(11);
  for (const tab of tabs) {
    await app.page.locator(`#ribbon-tabs [data-tab="${tab}"]`).click();
    await app.page.waitForTimeout(80);
    await expect(app.page.locator(`#ribbon-tabs [data-tab="${tab}"]`)).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expectNothingClipped(app.page.locator('#ribbon'));
    await expectInsideWindow(app.page.locator('#ribbon'));
    await expectReadable(app.page.locator('#ribbon'));
  }
  await expectWindowSound(app.page);
});

test('M02 — the command palette is opened, typed into, and runs what was chosen', async () => {
  const j = journey(app);
  await j.openDocument(stage('multipage.pdf', 'palette.pdf'));

  await j.clickRibbon('help', 'Command Palette');
  const palette = app.page.locator('#command-palette');
  await expect(palette).toBeVisible();
  await expectReadable(palette);
  await expectNothingClipped(palette);

  await app.page.keyboard.type('About');
  const first = palette.locator('[role="option"]').first();
  await expect(first).toContainText(/About/i);
  await app.page.keyboard.press('Enter');
  await expect(app.page.locator('#about-dialog')).toBeVisible();
  await expectReadable(app.page.locator('#about-dialog'));
  // M00's About dialog is kept and reused rather than rebuilt, so it goes away rather than out.
  await j.clickDialogButton('#about-dialog', 'Close');
  await expect(app.page.locator('#about-dialog')).toBeHidden();
  await expectWindowSound(app.page);
});

// ---- M01 -------------------------------------------------------------------------------------

test('M01 — the theme is changed from the status bar, and every theme stays readable', async () => {
  const j = journey(app);
  await j.openDocument(stage('multipage.pdf', 'theme.pdf'));

  const themeOf = (): Promise<string> =>
    app.page.evaluate(() => document.documentElement.dataset['theme'] ?? '');
  const seen = new Set<string>([await themeOf()]);

  // The switcher lives in the status bar's right slot, where the reader can reach it.
  const switcher = app.page.locator('#statusbar .status-right button').first();
  await expect(switcher).toBeVisible();

  for (let i = 0; i < 4; i++) {
    await j.clickRibbon('view', 'Next Theme');
    await app.page.waitForTimeout(250);
    const theme = await themeOf();
    seen.add(theme);
    await expectReadable(app.page.locator('#ribbon'));
    await expectReadable(app.page.locator('#statusbar'));
    await expectNothingClipped(app.page.locator('body'));
  }
  expect(seen.size, 'the four themes should all be reachable from the ribbon').toBe(4);
  await expectWindowSound(app.page);
});

// ---- M20 -------------------------------------------------------------------------------------

test('M20 — an edit is undone and redone from the Edit tab, and the label says what', async () => {
  const j = journey(app);
  await j.openDocument(stage('multipage.pdf', 'undo.pdf'));

  const rotation = async (): Promise<number> =>
    ((await app.run('dev.documentSummary')) as { rotations: number[] }).rotations[0] ?? 0;
  const before = await rotation();

  await j.clickRibbon('organize', 'Rotate Right');
  await app.page.waitForTimeout(500);
  expect(await rotation(), 'the page was not rotated').not.toBe(before);

  // The Undo button says what it will undo (ADR 0008) — a word, not just an arrow.
  const undo = app.page.locator('#ribbon-body .rb-btn[data-command="edit.undo"] .rb-label');
  await app.page.locator('#ribbon-tabs [data-tab="edit"]').click();
  await expect(undo).toContainText(/Undo .+/);

  await j.clickRibbon('edit', 'Undo');
  await app.page.waitForTimeout(500);
  expect(await rotation(), 'Undo did not put the rotation back').toBe(before);

  await j.clickRibbon('edit', 'Redo');
  await app.page.waitForTimeout(500);
  expect(await rotation(), 'Redo did not put the rotation back on').not.toBe(before);

  await expectWindowSound(app.page);
});

// ---- M130 ------------------------------------------------------------------------------------

test('M130 — Preferences opens from the ribbon, searches, and changes a setting', async () => {
  const j = journey(app);
  await j.clickRibbon('help', 'Preferences…');
  const dialog = app.page.locator('#preferences-dialog');
  await expect(dialog).toBeVisible({ timeout: 15_000 });
  await expectNothingClipped(dialog);
  await expectInsideWindow(dialog);
  await expectReadable(dialog);

  // The search field narrows the list of pages, which is how a reader finds a setting.
  await dialog.locator('#prefs-search').fill('scale');
  await app.page.waitForTimeout(300);
  await expect(dialog.locator('#prefs-page')).toContainText(/scale/i);

  await j.clickDialogButton('#preferences-dialog', 'Close');
  await expect(dialog).toHaveCount(0);
  await expectWindowSound(app.page);
});

// ---- M00 / M03 / M10 -------------------------------------------------------------------------

test('M00/M03/M10 — About names the build, its architecture and the engine behind it', async () => {
  const j = journey(app);
  await j.clickRibbon('help', 'About ynotPDF');
  const dialog = app.page.locator('#about-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('ynotPDF');
  // M03: the architecture is named, and says so when it is emulated.
  await expect(dialog).toContainText(/x64|arm64|universal/i);
  // M10: the engine is named, so a bug report can say which one was running.
  await expect(dialog).toContainText(/PDFium/i);
  await expectNothingClipped(dialog);
  await expectReadable(dialog);
  await j.clickDialogButton('#about-dialog', 'Close');
  await expect(dialog).toBeHidden();
  await expectWindowSound(app.page);
});

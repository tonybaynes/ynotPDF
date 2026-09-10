/**
 * Journeys — reading and reorganising a document (M11, M12, M13, M40, M41, M50).
 *
 * Zooming with the ribbon's own buttons, stepping through find hits with the find bar's own
 * arrow, dragging a thumbnail to a new place in the order, cropping by dragging a rectangle,
 * picking an object up off the page. Nothing here is driven by a command id.
 */

import { expect, test } from '@playwright/test';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
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
  workspace = mkdtempSync(join(tmpdir(), 'ynot-m04-document-'));
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

const viewerState = async (): Promise<{ zoom: number; page: number; layout: string }> =>
  (await app.run('dev.viewerState')) as { zoom: number; page: number; layout: string };

// ---- M11 -------------------------------------------------------------------------------------

test('M11 — the reader zooms and changes the layout from the View tab, and sees it in the status bar', async () => {
  const j = journey(app);
  await j.openDocument(stage('multipage.pdf', 'view.pdf'));

  const before = await viewerState();
  await j.clickRibbon('view', 'Zoom In');
  await app.page.waitForTimeout(300);
  expect((await viewerState()).zoom, 'Zoom In did not zoom in').toBeGreaterThan(before.zoom);

  // The status bar is where the reader reads the zoom back, so it has to agree with the viewer.
  await j.clickRibbon('view', 'Actual Size (100 %)');
  await app.page.waitForTimeout(300);
  expect(await app.page.locator('#status-zoom-input').inputValue()).toBe('100%');
  expect((await viewerState()).zoom).toBeCloseTo(1, 2);

  await j.clickRibbon('view', 'Fit Page');
  await app.page.waitForTimeout(300);
  expect((await viewerState()).zoom, 'Fit Page did not change the zoom').not.toBeCloseTo(1, 2);

  await j.clickRibbon('view', 'Layout: Facing');
  await app.page.waitForTimeout(400);
  expect((await viewerState()).layout).toBe('facing');

  await expectWindowSound(app.page);
});

// ---- M12 + M40 -------------------------------------------------------------------------------

test('M12/M40 — a page is reordered by dragging its thumbnail, and undone from the ribbon', async () => {
  const j = journey(app);
  await j.openDocument(stage('multipage.pdf', 'reorder.pdf'));
  await j.openPanel('nav.pages');

  const panel = app.page.locator('#nav-host .panel[data-panel="nav.pages"]');
  const cells = panel.locator('.thumb-cell');
  await expect(cells.first()).toBeVisible();
  expect(await cells.count(), 'the Pages panel showed no thumbnails').toBeGreaterThan(2);
  await expectNothingClipped(panel);

  const labelOf = async (n: number): Promise<string> =>
    ((await cells.nth(n).locator('.thumb-label').textContent()) ?? '').trim();
  const firstLabel = await labelOf(0);
  const secondLabel = await labelOf(1);
  expect(firstLabel).not.toBe(secondLabel);

  // Pick the first thumbnail up and drop it past the second.
  await j.dragElement(cells.nth(0), cells.nth(1), { after: true });
  await app.page.waitForTimeout(600);

  const summary = (await app.run('dev.documentSummary')) as { pageCount: number };
  expect(summary.pageCount, 'a reorder must not lose or add a page').toBeGreaterThan(2);
  expect(await labelOf(0), 'dragging the first thumbnail past the second changed nothing').toBe(
    secondLabel,
  );

  await j.clickRibbon('edit', 'Undo');
  await app.page.waitForTimeout(600);
  expect(await labelOf(0), 'Undo did not put the page back').toBe(firstLabel);

  await expectWindowSound(app.page);
});

// ---- M13 -------------------------------------------------------------------------------------

test('M13 — a find is typed into the bar and its hits are stepped through with the arrow', async () => {
  const j = journey(app);
  await j.openDocument(stage('text.pdf', 'find.pdf'));

  await j.clickRibbon('home', 'Find');
  const bar = app.page.locator('#find-bar');
  await expect(bar).toBeVisible();
  await expectReadable(bar);

  await bar.locator('.find-input').fill('the');
  await expect
    .poll(async () => ((await app.run('dev.findState')) as { total: number }).total, {
      timeout: 15_000,
    })
    .toBeGreaterThan(1);
  const total = ((await app.run('dev.findState')) as { total: number }).total;
  await expect(bar.locator('.find-count')).toHaveText(`1 of ${total}`);
  // The current hit is marked, not just highlighted with the rest.
  expect(await app.page.locator('.text-highlight-find-current').count()).toBe(1);

  // Step with the bar's own button, twice, and watch the counter move.
  for (let i = 2; i <= Math.min(3, total); i++) {
    await bar.getByRole('button', { name: 'Next match' }).click();
    await expect(bar.locator('.find-count')).toHaveText(`${i} of ${total}`);
  }

  await expectWindowSound(app.page);
});

// ---- M41 -------------------------------------------------------------------------------------

test('M41 — the crop tool takes a rectangle dragged on the page and crops to it', async () => {
  const j = journey(app);
  await j.openDocument(stage('multipage.pdf', 'crop.pdf'));

  const cropWidth = async (): Promise<number> => {
    const boxes = (await app.run('dev.pageBoxes', { page: 0 })) as {
      media: { x0: number; x1: number };
      crop: { x0: number; x1: number } | null;
    };
    const box = boxes.crop ?? boxes.media;
    return box.x1 - box.x0;
  };
  const before = await cropWidth();

  await j.clickRibbon('organize', 'Crop Tool');
  await j.dragOnPageAt([0.2, 0.2], [0.7, 0.6]);
  await app.page.waitForTimeout(400);

  // The tool draws the rectangle it was dragged and waits; Enter is what crops to it.
  await expect(
    app.page.locator('.crop-frame').first(),
    'the crop tool drew no rectangle where it was dragged',
  ).toBeVisible({ timeout: 10_000 });
  await app.page.keyboard.press('Enter');
  await app.page.waitForTimeout(1000);

  expect(await cropWidth(), 'the page was not cropped').toBeLessThan(before);

  await expectWindowSound(app.page);
});

// ---- M50 -------------------------------------------------------------------------------------

test('M50 — an object on the page is picked up by clicking it with the object tool', async () => {
  const j = journey(app);
  await j.openDocument(stage('image.pdf', 'objects.pdf'));

  await j.clickRibbon('edit', 'Edit Object');
  await app.page.waitForTimeout(400);
  // Where `image.pdf` keeps its picture: PDF (72..328, 494..750) on a 612x792 page, so a third
  // of the way across and a fifth of the way down.
  await j.clickPageAt([0.33, 0.215]);
  await app.page.waitForTimeout(400);

  const selection = (await app.run('dev.objectSelection')) as {
    objectIds?: string[];
    description?: string;
  };
  expect(
    selection.objectIds ?? [],
    'clicking the page with the object tool selected nothing',
  ).not.toEqual([]);
  // And the properties pane says what it is, in a word.
  expect(selection.description).toBe('Image');

  await expectWindowSound(app.page);
});

// ---- M92 -------------------------------------------------------------------------------------

test('M92 — Export is found on the Convert tab, and its dialog offers what it should', async () => {
  const j = journey(app);
  await j.openDocument(stage('text.pdf', 'export.pdf'));

  // Two clicks, which is what the reader makes: the Export dropdown, then the kind of export.
  await j.clickRibbon('convert', 'Export');
  await j.clickMenuItem('Export text…');

  const dialog = app.page.locator('#export-text-dialog');
  await expect(dialog, 'choosing "Export text…" did not open its dialog').toBeVisible({
    timeout: 15_000,
  });
  await expectNothingClipped(dialog);
  await expectReadable(dialog);
  // The reader chooses a range and an encoding here; where the file goes is the OS's dialog,
  // which is not ours to drive, so the journey stops at the last thing this app owns.
  const pages = dialog.getByRole('textbox', { name: 'Pages' });
  await expect(pages).toBeVisible();
  await pages.fill('1');
  const encoding = dialog.getByRole('combobox', { name: 'Encoding' }).first();
  await expect(encoding).toBeVisible();
  await encoding.selectOption({ index: 1 });
  await expect(dialog, 'the dialog should say what it will write').toContainText(/page|text/i);
  await j.clickDialogButton('#export-text-dialog', 'Cancel');
  await expect(dialog).toBeHidden();

  await expectWindowSound(app.page);
});

// ---- M100 ------------------------------------------------------------------------------------

test('M100 — Reduce File Size is pressed on the Convert tab, and says what it would save', async () => {
  const j = journey(app);
  await j.openDocument(stage('bloated.pdf', 'optimise.pdf'));

  await j.clickRibbon('convert', 'Reduce File Size…');
  const dialog = app.page.locator('#optimise-dialog');
  await expect(dialog, 'Reduce File Size did not open its dialog').toBeVisible({ timeout: 30_000 });
  await expectNothingClipped(dialog);
  await expectReadable(dialog);

  // The reader's question is "how much smaller?", and the dialog has to answer it in words
  // before they commit to anything.
  await expect(dialog, 'the dialog should say what the saving would be').toContainText(
    /\d+(\.\d+)?\s*(KB|MB|bytes)/i,
  );
  await j.clickDialogButton('#optimise-dialog', 'Cancel');
  await expect(dialog).toBeHidden();

  await expectWindowSound(app.page);
});

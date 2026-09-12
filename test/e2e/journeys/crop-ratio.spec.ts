import { expect, test } from '@playwright/test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument, degrees } from 'pdf-lib';
import { launchApp, type App } from '../harness';
import { journey, closeEverything } from '../journey';
import { expectNothingClipped, expectReadable, expectWindowSound } from '../layout';

let app: App;
let workspace: string;
test.beforeAll(() => {
  workspace = mkdtempSync(join(tmpdir(), 'ynot-crop-ratio-'));
});
test.afterAll(() => {
  rmSync(workspace, { recursive: true, force: true });
});
test.afterEach(async () => {
  await app.close();
});

async function palette(label: string): Promise<void> {
  await app.page.keyboard.press('ControlOrMeta+Shift+P');
  const palette = app.page.locator('#command-palette');
  await palette.getByRole('combobox').fill(label);
  await palette.getByRole('option').filter({ hasText: label }).first().click();
}

async function fixture(rotation: number): Promise<string> {
  const pdf = await PDFDocument.create();
  for (const [width, height] of [
    [500, 700],
    [600, 800],
  ] as const) {
    const page = pdf.addPage([width, height]);
    page.setCropBox(35, 45, width - 70, height - 90);
    page.setRotation(degrees(rotation));
    page.drawText('Crop ratio journey', { x: 80, y: 160, size: 16 });
  }
  const path = join(workspace, `crop-${rotation}.pdf`);
  writeFileSync(path, await pdf.save());
  return path;
}

const crop = async (page = 0) =>
  (await app.run('dev.pageBoxes', { page })) as {
    crop: { x0: number; y0: number; x1: number; y1: number };
  };

const rangeBoxes = async () => Promise.all([crop(0), crop(1)]);

test('M41 — rotated crop ratio drag, dialog, range, undo, save and reopen agree', async () => {
  app = await launchApp({ noDemo: true });
  const j = journey(app);
  const path = await fixture(90);
  await j.openDocument(path);
  const before = await rangeBoxes();
  await palette('Crop Aspect Ratio');
  const chooser = app.page.locator('#crop-ratio-dialog');
  await chooser.getByLabel('Aspect ratio', { exact: true }).selectOption('wide');
  await chooser.getByRole('button', { name: 'Use ratio', exact: true }).click();
  await j.clickRibbon('organize', 'Crop Tool');
  await j.dragOnPageAt([0.15, 0.2], [0.8, 0.75]);
  const frame = app.page.locator('.crop-frame').first();
  const frameBox = await frame.boundingBox();
  expect(frameBox).not.toBeNull();
  if (!frameBox) throw new Error('No crop frame');
  expect(frameBox.width / frameBox.height).toBeCloseTo(16 / 9, 1);
  await app.page.keyboard.press('Shift+ArrowRight');
  const nudged = await frame.boundingBox();
  if (!nudged) throw new Error('No crop frame after resizing');
  expect(nudged.width).toBeGreaterThan(frameBox.width);
  expect(nudged.width / nudged.height).toBeCloseTo(16 / 9, 1);
  await app.page.keyboard.press('Enter');
  const dialog = app.page.locator('#ops-crop');
  await expect(dialog.getByLabel('Aspect ratio', { exact: true })).toHaveValue('wide');
  await expectNothingClipped(dialog);
  await expectReadable(dialog);
  await dialog.getByLabel('Apply to', { exact: true }).fill('all');
  await dialog.getByRole('button', { name: 'Crop', exact: true }).click();
  // A page's boxes change before the complete range is committed to undo history.
  await expect(app.page.getByText('Cropped 2 pages.', { exact: true })).toBeVisible();
  const quickAccess = app.page.getByRole('toolbar', { name: 'Quick access toolbar' });
  await expect(quickAccess.getByRole('button', { name: /^Undo\b/ })).toBeEnabled();
  const after = await rangeBoxes();
  for (const { crop } of after)
    expect((crop.y1 - crop.y0) / (crop.x1 - crop.x0)).toBeCloseTo(16 / 9, 4);
  await app.page.keyboard.press('ControlOrMeta+z');
  await expect.poll(rangeBoxes).toEqual(before);
  await expect(quickAccess.getByRole('button', { name: /^Redo\b/ })).toBeEnabled();
  await app.page.keyboard.press('ControlOrMeta+Shift+z');
  await expect.poll(rangeBoxes).toEqual(after);
  await expect(quickAccess.getByRole('button', { name: /^Undo\b/ })).toBeEnabled();
  await j.clickRibbon('home', 'Save');
  await expect
    .poll(async () => ((await app.run('dev.saveState')) as { dirty: boolean }).dirty)
    .toBe(false);
  const saved = await PDFDocument.load(readFileSync(path));
  for (const page of saved.getPages())
    expect(page.getCropBox().height / page.getCropBox().width).toBeCloseTo(16 / 9, 4);
  await closeEverything(app);
  await j.openDocument(path);
  await expect.poll(rangeBoxes).toEqual(after);
  await expectWindowSound(app.page);
});

test('M41 — custom ratio validates by keyboard and crop controls remain readable at 200 percent', async () => {
  app = await launchApp({
    noDemo: true,
    settings: { 'ui.scale': 200, 'theme.name': 'high-contrast' },
    window: { width: 1280, height: 800 },
  });
  const j = journey(app);
  await j.openDocument(await fixture(0));
  await palette('Crop Pages');
  const dialog = app.page.locator('#ops-crop');
  await dialog.getByLabel('Aspect ratio', { exact: true }).selectOption('custom');
  const width = dialog.getByLabel('Ratio width', { exact: true });
  const height = dialog.getByLabel('Ratio height', { exact: true });
  await width.fill('0');
  await expect(dialog.getByRole('button', { name: 'Crop', exact: true })).toBeDisabled();
  await expect(dialog.getByRole('alert')).toContainText('0.01');
  await width.fill('5');
  await height.fill('2');
  await expect(dialog.getByRole('button', { name: 'Crop', exact: true })).toBeEnabled();
  await height.press('Tab');
  await expectNothingClipped(dialog);
  await expectReadable(dialog);
  await dialog.getByRole('button', { name: 'Crop', exact: true }).click();
  const after = (await crop()).crop;
  expect((after.x1 - after.x0) / (after.y1 - after.y0)).toBeCloseTo(2.5, 4);
  await palette('Crop Pages');
  await dialog.getByLabel('Aspect ratio', { exact: true }).selectOption('free');
  await dialog.getByRole('button', { name: 'Whole page', exact: true }).click();
  await dialog.getByLabel('Left', { exact: true }).fill('5');
  await dialog.getByRole('button', { name: 'Crop', exact: true }).click();
  const free = (await crop()).crop;
  expect((free.x1 - free.x0) / (free.y1 - free.y0)).not.toBeCloseTo(2.5, 2);
  await expectWindowSound(app.page);
});

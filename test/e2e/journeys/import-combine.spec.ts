import { expect, test, type Locator } from '@playwright/test';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { PDFDocument, PDFName, PDFRawStream } from 'pdf-lib';
import { launchApp, type App } from '../harness';
import { closeEverything } from '../journey';
import { expectNothingClipped, expectReadable, expectWindowSound } from '../layout';
import { scanImage } from '../../unit/create/scanImage';

function required(values: string[], index: number): string {
  const value = values[index];
  if (value === undefined) throw new Error('Missing fixture or output');
  return value;
}

let app: App;
let workspace: string;
const paths: string[] = [];
test.beforeAll(() => {
  workspace = mkdtempSync(join(tmpdir(), 'ynot-import-combine-'));
  for (const [index, angle] of [2.3, -1.1, 0, null].entries()) {
    const path = join(workspace, `scan-${index}.png`);
    writeFileSync(path, scanImage(angle));
    paths.push(path);
  }
});
test.afterEach(async () => {
  await app?.close();
});
test.afterAll(() => {
  rmSync(workspace, { recursive: true, force: true });
});

async function palette(label: string): Promise<void> {
  await app.page.keyboard.press('ControlOrMeta+Shift+P');
  const chooser = app.page.locator('#command-palette');
  await chooser.getByRole('combobox').fill(label);
  await chooser.getByRole('option').filter({ hasText: label }).first().click();
}
async function chooseFiles(files: string[]): Promise<void> {
  // Replace only the native picker. Production IPC still performs every read/grant.
  await app.electron.evaluate(({ dialog }, selected) => {
    dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: selected });
  }, files);
}
async function openFile(path: string): Promise<void> {
  await chooseFiles([path]);
  await app.page.keyboard.press('ControlOrMeta+o');
  await expect(app.page.locator('.viewer-content .page').first()).toBeVisible();
}
async function save(path: string): Promise<void> {
  await app.electron.evaluate(({ dialog }, selected) => {
    dialog.showSaveDialog = () => Promise.resolve({ canceled: false, filePath: selected });
  }, path);
  await app.page.keyboard.press('ControlOrMeta+Shift+s');
  await expect
    .poll(async () => ((await app.run('dev.saveState')) as { dirty: boolean; path: string }).path)
    .toBe(path);
  await expect
    .poll(async () => ((await app.run('dev.saveState')) as { dirty: boolean }).dirty)
    .toBe(false);
}
async function dropFiles(target: Locator, files: string[]): Promise<void> {
  // Files come from Chromium's native file input, then enter the actual DOM drop handler.
  await app.page.evaluate(() => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.id = 'desktop-drop-source';
    input.hidden = true;
    document.body.append(input);
  });
  await app.page.locator('#desktop-drop-source').setInputFiles(files);
  await target.evaluate((host) => {
    const input = document.querySelector<HTMLInputElement>('#desktop-drop-source');
    const transfer = new DataTransfer();
    for (const file of Array.from(input?.files ?? [])) transfer.items.add(file);
    host.dispatchEvent(
      new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: transfer }),
    );
    host.dispatchEvent(
      new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }),
    );
    input?.remove();
  });
}
async function imageStreams(path: string): Promise<string[]> {
  const pdf = await PDFDocument.load(readFileSync(path));
  return pdf.context
    .enumerateIndirectObjects()
    .flatMap(([, value]) =>
      value instanceof PDFRawStream &&
      value.dict.get(PDFName.of('Subtype'))?.toString() === '/Image'
        ? [Buffer.from(value.contents).toString('base64')]
        : [],
    )
    .sort();
}
const summary = async () =>
  app.run('dev.documentSummary') as Promise<{
    pageCount: number;
    canUndo: boolean;
    canRedo: boolean;
  }>;
const skew = async (page: number) =>
  ((await app.run('dev.detectSkew', { page })) as { angle: number }).angle;

test('M41 — image creation preference corrects real scans and preserves saved image streams', async () => {
  const outputs: string[] = [];
  for (const enabled of [false, true]) {
    app = await launchApp({ noDemo: true, settings: { 'scan.autoDeskew': enabled } });
    await chooseFiles(paths);
    await palette('Create PDF from images');
    const dialog = app.page.locator('#create-images-dialog');
    await expect(dialog).toBeVisible();
    await expectNothingClipped(dialog);
    await expectReadable(dialog);
    await app.page.screenshot({ path: test.info().outputPath(`image-options-${enabled}.png`) });
    await dialog.getByRole('button', { name: 'Create', exact: true }).click();
    await expect(app.page.locator('.viewer-content .page').first()).toBeVisible();
    await expect.poll(async () => (await summary()).pageCount).toBe(4);
    for (const [page, original] of [2.3, -1.1, 0].entries())
      expect(Math.abs((await skew(page)) - (enabled ? 0 : original))).toBeLessThanOrEqual(0.2);
    const output = join(workspace, `auto-${enabled}.pdf`);
    outputs.push(output);
    await save(output);
    await closeEverything(app);
    await openFile(output);
    await expect.poll(async () => (await summary()).pageCount).toBe(4);
    expect(Math.abs((await skew(0)) - (enabled ? 0 : 2.3))).toBeLessThanOrEqual(0.2);
    await expectWindowSound(app.page);
    if (!enabled) await app.close();
  }
  expect(await imageStreams(required(outputs, 1))).toEqual(
    await imageStreams(required(outputs, 0)),
  );
  expect(
    (await PDFDocument.load(readFileSync(required(outputs, 1))))
      .getPages()
      .map((page) => page.getSize()),
  ).toEqual(
    (await PDFDocument.load(readFileSync(required(outputs, 0))))
      .getPages()
      .map((page) => page.getSize()),
  );
});

test('M41 — Combine Add files, recursive folder, external File drop, ranges and save/reopen', async () => {
  app = await launchApp({ noDemo: true, settings: { 'scan.autoDeskew': true } });
  const folder = join(workspace, 'folder');
  mkdirSync(join(folder, 'sub'), { recursive: true });
  copyFileSync(required(paths, 0), join(folder, '2.png'));
  copyFileSync(required(paths, 1), join(folder, 'sub', '10.png'));
  writeFileSync(join(folder, 'bad.xyz'), 'Unsupported file');
  await palette('Combine Files');
  const dialog = app.page.locator('#ops-combine');
  const combine = dialog.getByRole('button', { name: 'Combine', exact: true });
  await expect(combine).toBeDisabled();
  await chooseFiles([folder]);
  await dialog.getByLabel('Include subfolders', { exact: true }).uncheck();
  await dialog.getByRole('button', { name: 'Add folder…', exact: true }).click();
  await expect(dialog.locator('.ops-file')).toHaveCount(1);
  await expect(dialog.getByRole('alert')).toContainText('bad.xyz');
  await expect(combine).toBeEnabled();
  await dialog.getByRole('button', { name: 'Remove all', exact: true }).click();
  await dialog.getByLabel('Include subfolders', { exact: true }).check();
  await dialog.getByRole('button', { name: 'Add folder…', exact: true }).click();
  await expect(dialog.locator('.ops-file')).toHaveCount(2);
  await expect(combine).toBeEnabled();
  await chooseFiles([required(paths, 2)]);
  await dialog.getByRole('button', { name: 'Add files…', exact: true }).click();
  await expect(dialog.locator('.ops-file')).toHaveCount(3);
  await dropFiles(dialog, [required(paths, 3)]);
  await expect(dialog.locator('.ops-file')).toHaveCount(4);
  await expect(combine).toBeEnabled();
  await expect(app.page.locator('#tabstrip [role="tab"]')).toHaveCount(0);
  const range = dialog.getByLabel('Pages of 2.png', { exact: true });
  await range.fill('9');
  await expect(combine).toBeDisabled();
  await range.press('Backspace');
  await expect(dialog.locator('.ops-file')).toHaveCount(4);
  await expect(combine).toBeEnabled();
  await dialog
    .locator('.ops-file')
    .last()
    .getByRole('button', { name: 'Move up', exact: true })
    .click();
  await expect(dialog.locator('.ops-file-name')).toHaveText([
    '2.png',
    '10.png',
    basename(required(paths, 3)),
    basename(required(paths, 2)),
  ]);
  await expectNothingClipped(dialog);
  await expectReadable(dialog);
  await expect(dialog.locator('.ops-file canvas')).toHaveCount(4);
  await app.page.screenshot({ path: test.info().outputPath('combine-inputs.png') });
  await dialog.getByLabel('Open the result in a new tab', { exact: true }).scrollIntoViewIfNeeded();
  await app.page.screenshot({ path: test.info().outputPath('combine-options.png') });
  await combine.click();
  await expect(app.page.locator('.viewer-content .page').first()).toBeVisible();
  await expect.poll(async () => (await summary()).pageCount).toBe(4);
  expect(Math.abs(await skew(0))).toBeLessThanOrEqual(0.2);
  expect(Math.abs(await skew(1))).toBeLessThanOrEqual(0.2);
  const output = join(workspace, 'combined.pdf');
  await save(output);
  await closeEverything(app);
  await openFile(output);
  await expect.poll(async () => (await summary()).pageCount).toBe(4);
  await expectWindowSound(app.page);
});

test('M41 — cancelling a desktop-drop Combine import leaves the current document untouched', async () => {
  app = await launchApp({ noDemo: true, settings: { 'scan.autoDeskew': true } });
  const base = join(workspace, 'base.pdf');
  const pdf = await PDFDocument.create();
  pdf.addPage([500, 700]);
  writeFileSync(base, await pdf.save());
  await openFile(base);
  const before = await summary();
  await palette('Combine Files');
  const dialog = app.page.locator('#ops-combine');
  await dropFiles(
    dialog,
    Array.from({ length: 40 }, () => required(paths, 0)),
  );
  await expect(dialog.getByRole('button', { name: 'Combine', exact: true })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect.poll(summary).toEqual(before);
  // Reopening gives a fresh list and proves the cancelled queue cannot populate a later dialog.
  await palette('Combine Files');
  await expect(dialog.locator('.ops-file')).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Add files…', exact: true })).toBeEnabled();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await chooseFiles([required(paths, 0)]);
  await palette('Insert Pages from a File');
  const insert = app.page.locator('#organise-insert-file');
  await expect(insert).toBeVisible();
  await insert.getByRole('button', { name: 'Insert', exact: true }).click();
  await expect.poll(async () => (await summary()).pageCount).toBe(2);
  await expect.poll(async () => (await summary()).canUndo).toBe(true);
  expect(Math.abs(await skew(0))).toBeLessThanOrEqual(0.2);
  expect(Math.abs(await skew(1))).toBeLessThanOrEqual(0.2);
  await app.page.keyboard.press('ControlOrMeta+z');
  await expect.poll(async () => (await summary()).pageCount).toBe(1);
  await expect.poll(async () => (await summary()).canRedo).toBe(true);
  await app.page.keyboard.press('ControlOrMeta+Shift+z');
  await expect.poll(async () => (await summary()).pageCount).toBe(2);
  const saved = join(workspace, 'inserted.pdf');
  await save(saved);
  await expect.poll(async () => (await summary()).canUndo).toBe(true);
  await closeEverything(app);
  await openFile(saved);
  await expect.poll(async () => (await summary()).pageCount).toBe(2);
  await expectWindowSound(app.page);
});

import { expect, test } from '@playwright/test';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import UTIF from 'utif';
import { launchApp } from './harness';
import { journey } from './journey';
import { expectNothingClipped, expectReadable, expectWindowSound } from './layout';

for (const multiPage of [false, true]) {
  test(`M92 — export Group 4 through the ribbon and dialog, multi-page ${String(multiPage)}`, async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'ynot-g4-'));
    const source = join(workspace, 'source.pdf');
    const output = join(workspace, 'pages.tif');
    const pdf = await PDFDocument.create();
    // Odd pixel widths and mixed page sizes, with actual black content on white paper.
    for (const [width, height] of [
      [73, 61],
      [81, 67],
      [95, 71],
    ]) {
      const page = pdf.addPage([must(width), must(height)]);
      page.drawRectangle({ x: 7, y: 9, width: 19, height: 23 });
    }
    writeFileSync(source, await pdf.save());
    const app = await launchApp({ noDemo: true });
    try {
      // Substitute only the native destination picker; all export options and the action
      // go through the real ribbon/dialog, worker, PDFium and filesystem.
      await app.electron.evaluate(
        ({ dialog }, paths) => {
          dialog.showSaveDialog = () =>
            Promise.resolve({ canceled: false, filePath: paths.output });
          dialog.showOpenDialog = () =>
            Promise.resolve({ canceled: false, filePaths: [paths.workspace] });
        },
        { output, workspace },
      );
      const j = journey(app);
      await j.openDocument(source);
      await j.clickRibbon('convert', 'Export');
      await j.clickMenuItem('Export pages as images…');
      const dialog = app.page.locator('#export-images-dialog');
      await dialog.getByLabel('Format', { exact: true }).selectOption('tiff');
      await dialog.getByLabel('Resolution (dpi)').fill('72');
      await dialog.getByLabel('TIFF compression', { exact: true }).selectOption('group4');
      await expect(dialog.getByRole('button', { name: 'Export', exact: true })).toBeDisabled();
      await expect(dialog.locator('.export-summary')).toContainText('requires black and white');
      await dialog.getByLabel('Colour', { exact: true }).selectOption('grey');
      await expect(dialog.getByRole('button', { name: 'Export', exact: true })).toBeDisabled();
      await dialog.getByLabel('Colour', { exact: true }).selectOption('mono');
      await dialog.getByLabel('Black and white method').selectOption('none');
      await dialog.getByLabel('Put every page in one TIFF file').setChecked(multiPage);
      await expect(dialog.getByLabel('Compression (0–9)', { exact: true })).toBeHidden();
      await expect(dialog.getByRole('button', { name: 'Export', exact: true })).toBeEnabled();
      await expectNothingClipped(dialog);
      await expectReadable(dialog);
      await j.clickDialogButton('#export-images-dialog', 'Export');
      await expect
        .poll(() => readdirSync(workspace).filter((name) => name.endsWith('.tif')).length)
        .toBe(multiPage ? 1 : 3);
      const tiffs = readdirSync(workspace)
        .filter((name) => name.endsWith('.tif'))
        .sort();
      const decoded = tiffs.flatMap((name) => {
        const buffer = Uint8Array.from(readFileSync(join(workspace, name))).buffer;
        const ifds = UTIF.decode(buffer);
        for (const ifd of ifds) UTIF.decodeImage(buffer, ifd);
        return ifds;
      });
      expect(decoded.map((ifd) => [ifd.width, ifd.height])).toEqual([
        [73, 61],
        [81, 67],
        [95, 71],
      ]);
      for (const ifd of decoded) {
        expect(ifd.t259).toEqual([4]);
        expect(ifd.t262).toEqual([0]);
        expect(ifd.t282).toEqual([72]);
        expect(ifd.t283).toEqual([72]);
        const pixels = UTIF.toRGBA8(ifd);
        // Known interior/exterior pixels prove polarity and the actual PDF rendering.
        const width = must(ifd.width);
        const height = must(ifd.height);
        const inside = ((height - 15) * width + 15) * 4;
        expect([...pixels.subarray(inside, inside + 4)]).toEqual([0, 0, 0, 255]);
        expect([...pixels.subarray(0, 4)]).toEqual([255, 255, 255, 255]);
      }
      await j.clickRibbon('convert', 'Export');
      await j.clickMenuItem('Export pages as images…');
      await expect(dialog.getByLabel('TIFF compression', { exact: true })).toHaveValue('group4');
      await expect(dialog.getByLabel('Colour', { exact: true })).toHaveValue('mono');
      await j.clickDialogButton('#export-images-dialog', 'Cancel');
      await expectWindowSound(app.page);
    } finally {
      await app.close();
      rmSync(workspace, { recursive: true, force: true });
    }
  });
}

test('M92 — Group 4 validation remains readable in every theme at 200 percent scale', async () => {
  const app = await launchApp({
    noDemo: true,
    settings: { 'ui.scale': 2 },
    window: { width: 1280, height: 800 },
  });
  try {
    await journey(app).openDocument(join(process.cwd(), 'test/fixtures/multipage.pdf'));
    for (const theme of ['graphite', 'midnight', 'daylight', 'high-contrast']) {
      await app.run('view.theme.set', { theme });
      await journey(app).clickRibbon('convert', 'Export');
      await journey(app).clickMenuItem('Export pages as images…');
      const dialog = app.page.locator('#export-images-dialog');
      await dialog.getByLabel('Format', { exact: true }).selectOption('tiff');
      await dialog.getByLabel('TIFF compression', { exact: true }).selectOption('group4');
      await expect(dialog.getByRole('button', { name: 'Export', exact: true })).toBeDisabled();
      await expectNothingClipped(dialog);
      await expectReadable(dialog);
      await journey(app).clickDialogButton('#export-images-dialog', 'Cancel');
      await expectWindowSound(app.page);
    }
  } finally {
    await app.close();
  }
});

function must<T>(value: T | null | undefined): T {
  if (value === undefined || value === null) throw new Error('Missing test value');
  return value;
}

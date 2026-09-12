import { expect, test } from '@playwright/test';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import type * as Upng from '@pdf-lib/upng';
import { pathToFileURL } from 'node:url';
import { launchApp } from './harness';
import { journey } from './journey';
import { expectNothingClipped, expectReadable, expectWindowSound } from './layout';
import { ALPHA, OTHER_ALPHA, RGB, JP2, embeddedFixture } from '../unit/export/embedded-fixtures';
import { appearanceFixture } from '../unit/export/appearance-fixtures';

// This transitive pdf-lib decoder publishes CJS as { default: codec }; Playwright's
// transform differs from Vitest's ESM interop, so load that documented module shape explicitly.
const UPNG = (
  createRequire(join(process.cwd(), 'package.json'))('@pdf-lib/upng') as {
    default: typeof Upng;
  }
).default;

function pixels(bytes: Uint8Array): Uint8Array {
  const png = UPNG.decode(Uint8Array.from(bytes).buffer);
  expect([png.width, png.height]).toEqual([3, 2]);
  expect(png.ctype).toBe(6);
  return new Uint8Array(must(UPNG.toRGBA8(png)[0]));
}

function hasSamples(actual: Uint8Array, alpha: Uint8Array): boolean {
  for (let i = 0; i < alpha.length; i++) {
    if (actual[i * 4 + 3] !== alpha[i]) return false;
    if (alpha[i] === 0) continue;
    for (let c = 0; c < 3; c++) if (actual[i * 4 + c] !== RGB[i * 3 + c]) return false;
  }
  return true;
}

test('M92 — export originals and transparent PNGs through the ribbon, with nested mask variants and remembered choices', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'ynot-embedded-'));
  const fixture = await embeddedFixture();
  const source = join(workspace, 'synthetic.pdf');
  writeFileSync(source, fixture.bytes);
  const app = await launchApp({
    noDemo: true,
    settings: { 'ui.scale': 2 },
    window: { width: 1280, height: 800 },
  });
  try {
    const j = journey(app);
    await j.openDocument(source);
    for (const [output, duplicates, count] of [
      ['original', false, 4],
      ['png', false, 3],
      ['png', true, 8],
    ] as const) {
      const directory = join(workspace, `${output}-${String(duplicates)}`);
      mkdirSync(directory);
      // Only the native folder chooser is substituted; the real command, dialog,
      // engine RPC, export worker, naming, PNG encoder and filesystem all execute.
      await app.electron.evaluate(({ dialog }, destination) => {
        dialog.showOpenDialog = () =>
          Promise.resolve({ canceled: false, filePaths: [destination] });
      }, directory);
      await j.clickRibbon('convert', 'Export');
      await j.clickMenuItem('Export all images…');
      const dialog = app.page.locator('#export-embedded-dialog');
      await dialog.getByLabel('Output', { exact: true }).selectOption(output);
      await dialog.getByLabel('Smallest picture worth keeping (px)').fill('1');
      await dialog
        .getByLabel('Write a file for every placement', { exact: true })
        .setChecked(duplicates);
      await expect(dialog).toContainText('external PDF masks may be omitted');
      await expectNothingClipped(dialog);
      await expectReadable(dialog);
      const captures = process.env['M92_CAPTURE_DIR'];
      if (captures)
        await app.page.screenshot({
          path: join(captures, `embedded-${output}-${String(duplicates)}.png`),
        });
      await j.clickDialogButton('#export-embedded-dialog', 'Export');
      await expect.poll(() => readdirSync(directory).length).toBe(count);
      const names = readdirSync(directory);
      const pngs = names
        .filter((file) => file.endsWith('.png'))
        .map((file) => pixels(readFileSync(join(directory, file))));
      expect(pngs.some((rgba) => hasSamples(rgba, ALPHA))).toBe(true);
      expect(pngs.some((rgba) => hasSamples(rgba, OTHER_ALPHA))).toBe(true);
      if (output === 'original') {
        expect(
          readFileSync(join(directory, must(names.find((file) => file.endsWith('.jpg'))))),
        ).toEqual(Buffer.from(fixture.jpegBytes));
        expect(
          readFileSync(join(directory, must(names.find((file) => file.endsWith('.jp2'))))),
        ).toEqual(Buffer.from(JP2));
      } else {
        expect(pngs).toHaveLength(count);
        if (duplicates) {
          // Original JP2 is now PNG, and its mask is identical to A. These are
          // all preserved when every placement is requested, including page 2.
          expect(pngs.filter((rgba) => hasSamples(rgba, ALPHA))).toHaveLength(5);
          expect(pngs.filter((rgba) => hasSamples(rgba, OTHER_ALPHA))).toHaveLength(2);
        }
      }
    }
    await j.clickRibbon('convert', 'Export');
    await j.clickMenuItem('Export all images…');
    const dialog = app.page.locator('#export-embedded-dialog');
    await expect(dialog.getByLabel('Output', { exact: true })).toHaveValue('png');
    await expect(
      dialog.getByLabel('Write a file for every placement', { exact: true }),
    ).toBeChecked();
    await j.clickDialogButton('#export-embedded-dialog', 'Cancel');
    // Headless callers can explicitly override the remembered PNG choice.
    const directory = join(workspace, 'headless-original');
    mkdirSync(directory);
    await app.run('convert.exportAllImages', {
      directory,
      output: 'original',
      minPixels: 1,
      keepDuplicates: false,
    });
    expect(readdirSync(directory).filter((file) => file.endsWith('.jpg'))).toHaveLength(1);
    expect(readdirSync(directory).filter((file) => file.endsWith('.jp2'))).toHaveLength(1);
    await expectWindowSound(app.page);
  } finally {
    await app.close();
    rmSync(workspace, { recursive: true, force: true });
  }
});

function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Missing expected output');
  return value;
}

test('M92 — positioned HTML in Chromium keeps rotated/clipped colour images and nested opacity without sibling contamination', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'ynot-appearance-'));
  const source = join(workspace, 'appearance.pdf');
  const directory = join(workspace, 'html');
  mkdirSync(directory);
  writeFileSync(source, await appearanceFixture());
  const app = await launchApp({ noDemo: true });
  try {
    const j = journey(app);
    await j.openDocument(source);
    await app.electron.evaluate(({ dialog }, destination) => {
      dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [destination] });
    }, directory);
    await j.clickRibbon('convert', 'Export');
    await j.clickMenuItem('Export as HTML…');
    const dialog = app.page.locator('#export-html-dialog');
    await dialog.getByLabel('Layout', { exact: true }).selectOption('positioned');
    await expectNothingClipped(dialog);
    await expectReadable(dialog);
    await j.clickDialogButton('#export-html-dialog', 'Export');
    await expect.poll(() => readdirSync(directory)).toEqual(['appearance.html']);
    const browserResult = await app.electron.evaluate(
      async ({ BrowserWindow }, { target, capture }) => {
        const win = new BrowserWindow({
          show: false,
          width: 600,
          height: 400,
          webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
        });
        try {
          await win.loadURL(target);
          const pictures = (await win.webContents.executeJavaScript(`(async () => {
          const pictures=[...document.querySelectorAll('.pic img')];
          await Promise.all(pictures.map(image=>image.decode()));
          return pictures.map(image=>{
            const canvas=document.createElement('canvas');
            canvas.width=image.naturalWidth; canvas.height=image.naturalHeight;
            const context=canvas.getContext('2d'); context.drawImage(image,0,0);
            const at=(x,y)=>Array.from(context.getImageData(x,y,1,1).data);
            const style=getComputedStyle(image.parentElement);
            return {size:[canvas.width,canvas.height],topLeft:at(5,5),bottomLeft:at(5,15),topRight:at(15,5),bottomRight:at(15,15),left:parseFloat(style.left),top:parseFloat(style.top),width:parseFloat(style.width)};
          });
        })()`)) as Array<{
            size: number[];
            topLeft: number[];
            bottomLeft: number[];
            topRight: number[];
            bottomRight: number[];
            left: number;
            top: number;
            width: number;
          }>;
          let screenshot: number[] = [];
          if (capture) {
            await win.webContents.executeJavaScript("document.body.style.zoom = '3'");
            screenshot = Array.from((await win.webContents.capturePage()).toPNG());
          }
          return { pictures, screenshot };
        } finally {
          win.destroy();
        }
      },
      {
        target: pathToFileURL(join(directory, 'appearance.html')).href,
        capture: !!process.env['M92_CAPTURE_DIR'],
      },
    );
    const shown = browserResult.pictures;
    const captures = process.env['M92_CAPTURE_DIR'];
    if (captures)
      writeFileSync(join(captures, 'appearance-html.png'), Buffer.from(browserResult.screenshot));
    expect(shown).toHaveLength(2);
    expect(shown.map((p) => p.size)).toEqual([
      [20, 20],
      [20, 20],
    ]);
    expect(shown[0]?.topLeft).toEqual([0, 255, 0, 128]);
    expect(shown[0]?.bottomLeft).toEqual([255, 0, 0, 128]);
    expect(shown[0]?.topRight[3]).toBe(0);
    expect(shown[1]?.topLeft[3]).toBe(0);
    expect(shown[1]?.bottomLeft).toEqual([255, 0, 0, 63]);
    expect(shown[1]?.bottomRight[3]).toBe(0); // page clip outside the nested forms
    expect(must(shown[0]).left).toBeCloseTo((20 * 4) / 3, 2);
    expect(must(shown[1]).left).toBeCloseTo((55 * 4) / 3, 2);
    for (const picture of shown) {
      expect(picture.top).toBeCloseTo((20 * 4) / 3, 2);
      expect(picture.width).toBeCloseTo((20 * 4) / 3, 2);
    }
    await expectWindowSound(app.page);
  } finally {
    await app.close();
    rmSync(workspace, { recursive: true, force: true });
  }
});

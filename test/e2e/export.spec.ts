/**
 * M92 acceptance tests — exporting inside the real, built app, with a real PDFium behind it.
 *
 * The unit tests own the arithmetic: the encoders byte for byte, the colour pipeline, the name
 * patterns, the reading order. This file owns what only exists once there is a window, an engine
 * worker, an export worker and a filesystem — that a folder really has three PNGs in it, that
 * they really are the size the page is at 150 dpi, that the multi-page TIFF really has three
 * frames, that the text really is the engine's text, and that Chromium really reads the exported
 * HTML in the same order.
 *
 * Each acceptance line in `docs/modules/M92-export.md` has a test named after it.
 */

import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { launchApp, type App } from './harness';

const FIXTURES = join(process.cwd(), 'test', 'fixtures');

interface PageSize {
  readonly width: number;
  readonly height: number;
  readonly rotation: number;
}

/**
 * Every page's size in points, from the engine (M91's developer probe).
 *
 * `multipage.pdf` is mixed sizes on purpose, so "page size × dpi" has to be asked page by page —
 * asserting A4 for all of them would be asserting something that is not true of the fixture.
 */
const pageSizes = (): Promise<PageSize[]> => app.run('dev.pageSizes') as Promise<PageSize[]>;

/** What a page of `size` points comes out as at `dpi`. */
function expectedPixels(size: PageSize, dpi: number): { width: number; height: number } {
  return {
    width: Math.round((size.width * dpi) / 72),
    height: Math.round((size.height * dpi) / 72),
  };
}

interface Outcome {
  readonly kind: string;
  readonly files: string[];
  readonly bytes: number;
  readonly warnings: string[];
  readonly directory: string | null;
}

interface ExportState {
  readonly available: boolean;
  readonly offThread: boolean;
  readonly settings: Record<string, unknown>;
  readonly last: Outcome | null;
  readonly pageCount: number;
  readonly hasEmbeddedImages: boolean;
}

let app: App;
let workspace: string;

test.beforeAll(async () => {
  workspace = mkdtempSync(join(tmpdir(), 'ynot-export-'));
  app = await launchApp();
});

test.afterAll(async () => {
  await app.close();
  rmSync(workspace, { recursive: true, force: true });
});

const state = (): Promise<ExportState> => app.run('dev.exportState') as Promise<ExportState>;

/** The bytes of a fixture, as a plain array for the structured-clone bridge. */
const fileArg = (name: string): { path: string; name: string; bytes: number[] } => ({
  path: `C:/fixtures/${name}`,
  name,
  bytes: Array.from(readFileSync(join(FIXTURES, name))),
});

async function open(name: string): Promise<void> {
  await app.run('file.openBytes', { file: fileArg(name) });
  await app.page.waitForSelector('.viewer-content .page');
  await app.page.waitForTimeout(150);
}

async function closeAll(): Promise<void> {
  const closing = app.run('app.tabs.closeAll').catch(() => undefined);
  const dialog = app.page.locator('#save-unsaved-dialog');
  for (let i = 0; i < 8; i++) {
    if (!(await dialog.isVisible().catch(() => false))) break;
    await dialog
      .getByRole('button', { name: "Don't save" })
      .click()
      .catch(() => undefined);
    await app.page.waitForTimeout(120);
  }
  await closing;
  await app.page.waitForTimeout(120);
}

/** A fresh empty folder to export into. */
function outDir(name: string): string {
  const dir = join(workspace, `${name}-${String(Date.now())}-${String(Math.random()).slice(2, 8)}`);
  return dir;
}

function must<T>(value: T | null | undefined, what = 'value'): T {
  if (value === null || value === undefined) throw new Error(`there is no ${what}`);
  return value;
}

/** A PNG's `IHDR` size and its `pHYs` resolution, read from the file on disk. */
function pngHeader(path: string): { width: number; height: number; perMetre: number | null } {
  const bytes = readFileSync(path);
  expect([...bytes.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 8;
  let size: { width: number; height: number } | null = null;
  let perMetre: number | null = null;
  while (at + 8 <= bytes.length) {
    const length = view.getUint32(at);
    const type = bytes.subarray(at + 4, at + 8).toString('latin1');
    if (type === 'IHDR') size = { width: view.getUint32(at + 8), height: view.getUint32(at + 12) };
    if (type === 'pHYs') perMetre = view.getUint32(at + 8);
    if (type === 'IEND') break;
    at += 12 + length;
  }
  return { ...must(size, 'IHDR'), perMetre };
}

/** How many image file directories a little-endian TIFF chains together, and their sizes. */
function tiffFrames(path: string): Array<{ width: number; height: number }> {
  const bytes = readFileSync(path);
  expect([bytes[0], bytes[1]]).toEqual([0x49, 0x49]);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const frames: Array<{ width: number; height: number }> = [];
  let at = view.getUint32(4, true);
  const seen = new Set<number>();
  while (at !== 0 && at + 2 <= bytes.length && !seen.has(at)) {
    seen.add(at);
    const count = view.getUint16(at, true);
    let width = 0;
    let height = 0;
    for (let i = 0; i < count; i++) {
      const entry = at + 2 + i * 12;
      const tag = view.getUint16(entry, true);
      if (tag === 256) width = view.getUint32(entry + 8, true);
      if (tag === 257) height = view.getUint32(entry + 8, true);
    }
    frames.push({ width, height });
    at = view.getUint32(at + 2 + count * 12, true);
  }
  return frames;
}

/** Runs one expression against a file loaded in a real Chromium window. */
async function inChrome(path: string, expression: string): Promise<unknown> {
  const url = pathToFileURL(path).href;
  return await app.electron.evaluate(
    async ({ BrowserWindow }, { target, script }) => {
      const win = new BrowserWindow({
        show: false,
        width: 1000,
        height: 1400,
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
      });
      try {
        await win.loadURL(target);
        return (await win.webContents.executeJavaScript(script)) as unknown;
      } finally {
        win.destroy();
      }
    },
    { target: url, script: expression },
  );
}

/** Loads a file in a real Chromium window and reads back what it says. */
async function readInChrome(path: string): Promise<string> {
  const text = await inChrome(path, 'document.body.innerText');
  return typeof text === 'string' ? text : '';
}

test.describe('the commands are all reachable', () => {
  test.afterEach(closeAll);

  test('every command is registered, and the ones that need a document are off without one', async () => {
    const ids = await app.commands();
    for (const id of [
      'convert.exportImages',
      'convert.exportAllImages',
      'convert.exportText',
      'convert.exportHtml',
      'convert.exportRtf',
    ]) {
      expect(ids, `${id} is registered`).toContain(id);
      expect(await app.isEnabled(id), `${id} without a document`).toBe(false);
    }
  });

  test('the encoding happens off the main thread, and the engine can read embedded pictures', async () => {
    await open('image.pdf');
    // `client` is created lazily; asking for the state is what starts it.
    await app.run('convert.exportImages', {
      pages: [0],
      dpi: 36,
      ask: false,
    });
    const after = await state();
    expect(after.offThread).toBe(true);
    expect(after.hasEmbeddedImages).toBe(true);
  });
});

test.describe('export to images', () => {
  test.afterEach(closeAll);

  test('three pages at 150 dpi PNG have pixel dimensions of page size × dpi', async () => {
    await open('multipage.pdf');
    const dir = outDir('png150');
    const outcome = (await app.run('convert.exportImages', {
      range: '1-3',
      format: 'png',
      dpi: 150,
      colour: 'colour',
      directory: dir,
    })) as Outcome;
    expect(outcome.files).toEqual([
      'multipage_page1.png',
      'multipage_page2.png',
      'multipage_page3.png',
    ]);
    expect(readdirSync(dir).sort()).toEqual(outcome.files);
    const sizes = await pageSizes();
    for (const [index, name] of outcome.files.entries()) {
      const expected = expectedPixels(must(sizes[index], `page ${String(index + 1)}`), 150);
      const header = pngHeader(join(dir, name));
      expect([header.width, header.height], name).toEqual([expected.width, expected.height]);
      expect(header.perMetre, `${name} records 150 dpi`).toBe(Math.round(150 / 0.0254));
    }
  });

  test('the same three pages as one TIFF have three frames', async () => {
    await open('multipage.pdf');
    const dir = outDir('tiff3');
    const outcome = (await app.run('convert.exportImages', {
      range: '1-3',
      format: 'tiff',
      dpi: 150,
      multiPage: true,
      directory: dir,
    })) as Outcome;
    expect(outcome.files).toEqual(['multipage.tif']);
    const frames = tiffFrames(join(dir, 'multipage.tif'));
    expect(frames).toHaveLength(3);
    const sizes = await pageSizes();
    for (const [index, frame] of frames.entries()) {
      expect(frame, `frame ${String(index + 1)}`).toEqual(
        expectedPixels(must(sizes[index], `page ${String(index + 1)}`), 150),
      );
    }
  });

  test('a page at 72 dpi is its size in points, and at 300 dpi it is four times as wide', async () => {
    await open('multipage.pdf');
    const low = outDir('dpi72');
    const high = outDir('dpi300');
    await app.run('convert.exportImages', { pages: [0], dpi: 72, directory: low });
    await app.run('convert.exportImages', { pages: [0], dpi: 300, directory: high });
    const at72 = pngHeader(join(low, 'multipage_page1.png'));
    const at300 = pngHeader(join(high, 'multipage_page1.png'));
    const first = must((await pageSizes())[0], 'page 1');
    expect(at72.width).toBe(Math.round(first.width));
    expect(at300.width / at72.width).toBeCloseTo(300 / 72, 1);
  });

  test('every format writes a file its own reader recognises', async () => {
    await open('text.pdf');
    const dir = outDir('formats');
    for (const [format, extension] of [
      ['png', '.png'],
      ['jpeg', '.jpg'],
      ['tiff', '.tif'],
      ['bmp', '.bmp'],
    ] as const) {
      const outcome = (await app.run('convert.exportImages', {
        pages: [0],
        format,
        dpi: 72,
        directory: dir,
        namePattern: `page-${format}`,
      })) as Outcome;
      const bytes = readFileSync(join(dir, must(outcome.files[0], 'file')));
      expect(must(outcome.files[0]).endsWith(extension), format).toBe(true);
      if (format === 'png') expect(bytes[1]).toBe(0x50);
      if (format === 'jpeg') expect([bytes[0], bytes[1]]).toEqual([0xff, 0xd8]);
      if (format === 'tiff') expect([bytes[0], bytes[1]]).toEqual([0x49, 0x49]);
      if (format === 'bmp') expect([bytes[0], bytes[1]]).toEqual([0x42, 0x4d]);
    }
  });

  test('a black-and-white PNG is one bit a pixel and much smaller than the colour one', async () => {
    await open('text.pdf');
    const dir = outDir('mono');
    await app.run('convert.exportImages', {
      pages: [0],
      dpi: 150,
      colour: 'colour',
      directory: dir,
      namePattern: 'colour',
    });
    await app.run('convert.exportImages', {
      pages: [0],
      dpi: 150,
      colour: 'mono',
      directory: dir,
      namePattern: 'mono',
    });
    const colour = readFileSync(join(dir, 'colour.png'));
    const mono = readFileSync(join(dir, 'mono.png'));
    expect(mono.length).toBeLessThan(colour.length);
    // IHDR bit depth is the ninth byte of the chunk data, which starts at 16.
    expect(mono[24]).toBe(1);
    expect(colour[24]).toBe(8);
  });

  test('the name pattern decides the file names', async () => {
    await open('multipage.pdf');
    const dir = outDir('names');
    const outcome = (await app.run('convert.exportImages', {
      range: '2-3',
      dpi: 36,
      namePattern: 'scan-{n}-at-{dpi}dpi',
      directory: dir,
    })) as Outcome;
    expect(outcome.files).toEqual(['scan-2-at-36dpi.png', 'scan-3-at-36dpi.png']);
  });

  test('the whole document is the default when nothing was chosen', async () => {
    await open('multipage.pdf');
    const dir = outDir('all');
    const outcome = (await app.run('convert.exportImages', { dpi: 36, directory: dir })) as Outcome;
    expect(outcome.files).toHaveLength(5);
  });
});

test.describe('export all images', () => {
  test.afterEach(closeAll);

  test('takes the picture out of the document rather than a picture of the page', async () => {
    // `image.pdf` embeds one 64×64 PNG and draws it twice, so one file — not two — is right.
    await open('image.pdf');
    const dir = outDir('embedded');
    const outcome = (await app.run('convert.exportAllImages', { directory: dir })) as Outcome;
    expect(outcome.files).toHaveLength(1);
    const name = must(outcome.files[0], 'file');
    const header = pngHeader(join(dir, name));
    expect([header.width, header.height]).toEqual([64, 64]);
    expect(outcome.warnings.join(' ')).toMatch(/the same image drawn more than once/);
  });

  test('writing every placement gives one file per drawing', async () => {
    await open('image.pdf');
    const dir = outDir('embedded-dupes');
    const outcome = (await app.run('convert.exportAllImages', {
      directory: dir,
      keepDuplicates: true,
    })) as Outcome;
    expect(outcome.files).toHaveLength(2);
  });

  test('says plainly when a document has no pictures in it', async () => {
    await open('blank.pdf');
    const dir = outDir('embedded-none');
    const outcome = (await app.run('convert.exportAllImages', { directory: dir })) as Outcome;
    expect(outcome.files).toEqual([]);
    expect(outcome.warnings).toEqual(['This document has no images in it.']);
  });
});

test.describe('export text, HTML and RTF', () => {
  test.afterEach(closeAll);

  test('the exported text is the engine’s text', async () => {
    await open('text.pdf');
    const dir = outDir('text');
    const outcome = (await app.run('convert.exportText', {
      directory: dir,
      pageSeparator: 'none',
    })) as Outcome;
    expect(outcome.files).toEqual(['text.txt']);
    const exported = readFileSync(join(dir, 'text.txt'), 'utf8');
    const engine = (await app.run('dev.pageText', { page: 0 })) as string;
    // The engine reports runs in content-stream order with no separators; the export groups them
    // into lines. Compare what both agree on: every non-space character, in order.
    const bare = (s: string): string => s.replace(/\s+/g, '');
    expect(bare(exported)).toBe(bare(engine));
    expect(exported).toContain('The quick brown fox jumps over the lazy dog.');
  });

  test('UTF-16 is written little-endian with a byte-order mark', async () => {
    await open('text.pdf');
    const dir = outDir('utf16');
    await app.run('convert.exportText', { directory: dir, encoding: 'utf-16le' });
    const bytes = readFileSync(join(dir, 'text.txt'));
    expect([bytes[0], bytes[1]]).toEqual([0xff, 0xfe]);
    expect(bytes.toString('utf16le').slice(1)).toContain('quick brown fox');
  });

  test('the page separator is what the reader asked for', async () => {
    await open('multipage.pdf');
    const dir = outDir('separators');
    await app.run('convert.exportText', { directory: dir, pageSeparator: 'form-feed' });
    const text = readFileSync(join(dir, 'multipage.txt'), 'utf8');
    expect(text).toContain('\f');
    expect((text.match(/\f/g) ?? []).length).toBe(4); // five pages, four separators
  });

  test('HTML opens in Chrome with the same reading order', async () => {
    await open('text.pdf');
    const dir = outDir('html');
    const outcome = (await app.run('convert.exportHtml', {
      directory: dir,
      layout: 'positioned',
    })) as Outcome;
    expect(outcome.files).toEqual(['text.html']);
    const shown = await readInChrome(join(dir, 'text.html'));
    expect(shown.length).toBeGreaterThan(0);
    // Chromium's own idea of what the page says, against the plain-text export of the same pages.
    const textDir = outDir('html-text');
    await app.run('convert.exportText', { directory: textDir, pageSeparator: 'none' });
    const plain = readFileSync(join(textDir, 'text.txt'), 'utf8');
    const words = (s: string): string[] => s.split(/\s+/u).filter((w) => w.length > 2);
    expect(words(shown)).toEqual(words(plain));
  });

  /**
   * Chromium's *computed* view of the file, not its text. A font stack quoted with double quotes
   * closes the `style="..."` attribute it sits in, and the words are still all there and still in
   * order — they are just no longer in a positioned box, in the right font, at the right size.
   * Only asking the browser what it *computed* catches that; the raw markup is checked in
   * `test/unit/export/documents.test.ts`.
   */
  test('Chromium computes the positions and fonts the export wrote', async () => {
    await open('text.pdf');
    const dir = outDir('html-computed');
    await app.run('convert.exportHtml', { directory: dir, layout: 'positioned' });
    const computed = (await inChrome(
      join(dir, 'text.html'),
      `(() => {
        const lines = [...document.querySelectorAll('.line')];
        const first = lines[0];
        const style = first ? getComputedStyle(first) : null;
        return {
          lines: lines.length,
          position: style?.position ?? '',
          left: style ? Math.round(parseFloat(style.left)) : -1,
          top: style ? Math.round(parseFloat(style.top)) : -1,
          fontFamily: style?.fontFamily ?? '',
          fontSize: style?.fontSize ?? '',
          pageWidth: Math.round(document.querySelector('.page')?.getBoundingClientRect().width ?? 0),
        };
      })()`,
    )) as {
      lines: number;
      position: string;
      left: number;
      top: number;
      fontFamily: string;
      fontSize: string;
      pageWidth: number;
    };
    expect(computed.lines).toBeGreaterThan(3);
    expect(computed.position).toBe('absolute');
    expect(computed.left).toBeGreaterThan(0);
    expect(computed.top).toBeGreaterThan(0);
    expect(computed.fontFamily).toContain('Helvetica');
    expect(computed.fontSize).toBe('32px'); // 24 pt
    // A4 is 595.28 pt wide; a CSS point is 4/3 of a CSS pixel.
    expect(computed.pageWidth).toBeGreaterThan(780);
    expect(computed.pageWidth).toBeLessThan(800);
  });

  test('flowing HTML joins a wrapped paragraph back into one block', async () => {
    await open('text.pdf');
    const dir = outDir('html-flow');
    await app.run('convert.exportHtml', { directory: dir, layout: 'flowing' });
    const html = readFileSync(join(dir, 'text.html'), 'utf8');
    expect(html).toContain('<p');
    expect(html).not.toContain('class="line"');
    const shown = await readInChrome(join(dir, 'text.html'));
    expect(shown).toContain('quick brown fox');
  });

  test('one HTML file per page when that is what was asked for', async () => {
    await open('multipage.pdf');
    const dir = outDir('html-per-page');
    const outcome = (await app.run('convert.exportHtml', {
      range: '1-3',
      directory: dir,
      perPage: true,
    })) as Outcome;
    expect(outcome.files).toEqual([
      'multipage_page1.html',
      'multipage_page2.html',
      'multipage_page3.html',
    ]);
    expect(await readInChrome(join(dir, 'multipage_page2.html'))).toContain('Page 2');
  });

  test('the pictures in a document are embedded in its HTML', async () => {
    await open('image.pdf');
    const dir = outDir('html-images');
    await app.run('convert.exportHtml', { directory: dir, embedImages: true });
    const html = readFileSync(join(dir, 'image.html'), 'utf8');
    expect(html).toContain('src="data:image/');
  });

  test('the RTF holds the document’s words, fonts and sizes', async () => {
    await open('text.pdf');
    const dir = outDir('rtf');
    const outcome = (await app.run('convert.exportRtf', { directory: dir })) as Outcome;
    expect(outcome.files).toEqual(['text.rtf']);
    const rtf = readFileSync(join(dir, 'text.rtf'), 'latin1');
    expect(rtf.startsWith('{\\rtf1\\ansi')).toBe(true);
    expect(rtf).toContain('{\\fonttbl');
    expect(rtf).toContain('Heading in Helvetica 24 pt');
    expect(rtf).toContain('\\fs48'); // 24 pt, in half-points
    expect(rtf).toContain('Helvetica');
    // Pure ASCII by construction, so any reader opens it whatever it thinks the code page is.
    expect([...readFileSync(join(dir, 'text.rtf'))].every((b) => b < 0x80)).toBe(true);
  });

  /**
   * "RTF opens in WordPad" — done objectively rather than by eye, the same way M13 proved its
   * clipboard RTF: the file is loaded into a `System.Windows.Forms.RichTextBox`, which is the
   * RichEdit control WordPad itself is built on. If it parses there it opens in WordPad.
   */
  test('the RTF opens in the control WordPad is built on', async () => {
    test.skip(process.platform !== 'win32', 'RichEdit is a Windows control');
    await open('text.pdf');
    const dir = outDir('rtf-wordpad');
    await app.run('convert.exportRtf', { directory: dir });
    const rtfPath = join(dir, 'text.rtf');
    const scriptPath = join(dir, 'check.ps1');
    writeFileSync(
      scriptPath,
      [
        'Add-Type -AssemblyName System.Windows.Forms',
        '$box = New-Object System.Windows.Forms.RichTextBox',
        `$box.Rtf = [System.IO.File]::ReadAllText(${JSON.stringify(rtfPath)})`,
        '$box.SelectAll()',
        '$font = $box.SelectionFont',
        '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
        'Write-Output ("TEXT:" + $box.Text.Replace("`r","").Replace("`n"," "))',
        'Write-Output ("FONT:" + $box.Font.Name)',
      ].join('\n'),
      'utf8',
    );
    const output = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
      { encoding: 'utf8', timeout: 60_000 },
    );
    expect(output).toContain('TEXT:');
    expect(output).toContain('quick brown fox');
  });

  test('a document with no text layer says so rather than writing an empty file silently', async () => {
    await open('scanned.pdf');
    const dir = outDir('scan-text');
    const outcome = (await app.run('convert.exportText', { directory: dir })) as Outcome;
    expect(outcome.warnings.join(' ')).toMatch(/no text layer/);
  });
});

test.describe('the dialogs', () => {
  test.afterEach(closeAll);

  test('the image dialog opens opaque, is keyboard-reachable, and says what it will write', async () => {
    await open('multipage.pdf');
    const opening = app.run('convert.exportImages').catch(() => undefined);
    const dialog = app.page.locator('#export-images-dialog');
    await expect(dialog).toBeVisible();
    const summary = dialog.locator('.export-summary');
    await expect(summary).toContainText('pixels a page');
    await expect(summary).toContainText('PNG');
    // Fully opaque: no alpha, no opacity, no backdrop-filter (the operator's rule).
    const opacity = await dialog.evaluate((el) => {
      const style = getComputedStyle(el);
      return {
        opacity: style.opacity,
        background: style.backgroundColor,
        backdrop: style.backdropFilter,
      };
    });
    expect(opacity.opacity).toBe('1');
    expect(opacity.background).not.toMatch(/rgba\([^)]*,\s*0?\.\d+\)/);
    expect(['none', '']).toContain(opacity.backdrop);
    // Every control is reachable and the focus ring is drawn.
    const focusable = await dialog.evaluate(
      (el) => el.querySelectorAll('input, select, button, textarea').length,
    );
    expect(focusable).toBeGreaterThan(8);
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await opening;
    await expect(dialog).toBeHidden();
  });

  test('choosing TIFF and “one file” takes the per-page name field away', async () => {
    await open('multipage.pdf');
    const opening = app.run('convert.exportImages').catch(() => undefined);
    const dialog = app.page.locator('#export-images-dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByLabel('Format').selectOption('tiff');
    await dialog.getByLabel('Put every page in one TIFF file').check();
    await expect(dialog.locator('.export-summary')).toContainText('1 file');
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await opening;
  });

  test('the other four dialogs open and cancel cleanly', async () => {
    await open('text.pdf');
    for (const [command, id] of [
      ['convert.exportAllImages', '#export-embedded-dialog'],
      ['convert.exportText', '#export-text-dialog'],
      ['convert.exportHtml', '#export-html-dialog'],
      ['convert.exportRtf', '#export-rtf-dialog'],
    ] as const) {
      const opening = app.run(command).catch(() => undefined);
      const dialog = app.page.locator(id);
      await expect(dialog, id).toBeVisible();
      await dialog.getByRole('button', { name: 'Cancel' }).click();
      await opening;
      await expect(dialog, id).toBeHidden();
    }
  });

  test('what the dialog chose is what the next one opens with', async () => {
    await open('multipage.pdf');
    // `ask: true` means "put them there, but let me choose the rest" — the dialog still opens.
    const opening = app
      .run('convert.exportImages', { directory: outDir('remember'), ask: true })
      .catch(() => undefined);
    const dialog = app.page.locator('#export-images-dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByLabel('Resolution (dpi)').fill('222');
    await dialog.getByRole('button', { name: 'Export' }).click();
    await opening;
    await app.page.waitForTimeout(400);
    expect((await state()).settings['imageDpi']).toBe(222);
  });
});

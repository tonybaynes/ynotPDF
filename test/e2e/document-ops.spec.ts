/**
 * M41 acceptance tests — combining, splitting, cropping, flattening and straightening inside the
 * real, built app.
 *
 * The unit tests own the arithmetic: the projection profile, the placement matrix, the name
 * pattern, the range dialect. This file owns what only exists once there is a window, a PDFium
 * worker, an operations worker and a writer — a document that really reopens with the crop it was
 * saved with, an undo that really puts a flattened page back, and a straightening that survives
 * a round trip through the engine.
 *
 * Each acceptance line in `docs/modules/M41-merge-split-crop.md` has a test named after it.
 */

import { expect, test } from '@playwright/test';
import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixturePath, launchApp, type App } from './harness';

const FIXTURES = join(process.cwd(), 'test', 'fixtures');

interface OpsState {
  settings: Record<string, unknown>;
  last: Record<string, unknown> | null;
  offThread: boolean;
  pageCount: number;
  pageIds: string[];
  boxes: Array<{
    crop: { x0: number; y0: number; x1: number; y1: number };
    media: { x0: number; y0: number; x1: number; y1: number };
    trim: { x0: number; y0: number; x1: number; y1: number } | null;
  }>;
  outline: Array<{ title: string; page: number }>;
}

interface DocumentSummary {
  pageCount: number;
  fieldCount: number;
  annotationCount: number;
  canUndo: boolean;
  canRedo: boolean;
  issues: string[];
}

interface SkewReading {
  page: number;
  angle: number;
  confidence: string;
  reason: string;
}

let app: App;
let workspace: string;

test.beforeAll(async () => {
  workspace = mkdtempSync(join(tmpdir(), 'ynot-ops-'));
  app = await launchApp();
});

test.afterAll(async () => {
  await app.close();
  rmSync(workspace, { recursive: true, force: true });
});

const state = (): Promise<OpsState> => app.run('dev.documentOpsState') as Promise<OpsState>;
const summary = (): Promise<DocumentSummary> =>
  app.run('dev.documentSummary') as Promise<DocumentSummary>;

function must<T>(value: T | null | undefined, what = 'value'): T {
  if (value === null || value === undefined) throw new Error(`the document has no ${what}`);
  return value;
}

/** The bytes of a fixture, as a plain array for the structured-clone bridge. */
const fileArg = (name: string): { path: string; name: string; bytes: number[] } => ({
  path: fixturePath(name),
  name,
  bytes: Array.from(readFileSync(join(FIXTURES, name))),
});

async function open(name: string): Promise<void> {
  await app.run('file.openBytes', { file: fileArg(name) });
  await app.page.waitForSelector('.viewer-content .page');
  await app.page.waitForTimeout(150);
}

/** Copies a fixture into the workspace so a test can save over it. */
function stage(fixture: string, as = fixture): string {
  const path = join(workspace, as);
  copyFileSync(join(FIXTURES, fixture), path);
  return path;
}

/** Opens a real file by path, the way Open Recent does. */
async function openPath(path: string): Promise<void> {
  await app.run('file.openRecent', { path });
  await app.page.waitForSelector('.viewer-content .page');
  await app.page.waitForTimeout(200);
}

/** Closes every tab, answering "save your changes?" with "Don't save". */
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

test.describe('the commands are all reachable', () => {
  test.afterEach(closeAll);

  test('every command is registered, and the ones that need a document are off without one', async () => {
    const ids = await app.commands();
    for (const id of [
      'convert.combineFiles',
      'organize.splitDocument',
      'organize.cropTool',
      'organize.cropPages',
      'organize.removeWhiteMargins',
      'organize.flatten',
      'organize.deskew',
      'organize.autoDeskew',
    ]) {
      expect(ids, `${id} is registered`).toContain(id);
    }
    // Combining needs no open document — it makes one.
    expect(await app.isEnabled('convert.combineFiles')).toBe(true);
    for (const id of [
      'organize.splitDocument',
      'organize.cropPages',
      'organize.flatten',
      'organize.deskew',
    ]) {
      expect(await app.isEnabled(id), `${id} without a document`).toBe(false);
    }
  });

  test('the work happens off the main thread', async () => {
    await open('multipage.pdf');
    expect((await state()).offThread).toBe(true);
  });
});

test.describe('combine', () => {
  test.afterEach(closeAll);

  test('the corpus combined has as many pages as the corpus, with a bookmark per file', async () => {
    const names = ['blank.pdf', 'multipage.pdf', 'text.pdf', 'outline.pdf', 'rotated.pdf'];
    const result = (await app.run('convert.combineFiles', {
      files: names.map((name) => ({ name, bytes: Array.from(readFileSync(join(FIXTURES, name))) })),
      keepBookmarks: false,
    })) as { pageCount: number; combined: number };
    // 1 + 5 + 1 + 3 + 4
    expect(result.combined).toBe(5);
    expect(result.pageCount).toBe(14);
    await app.page.waitForSelector('.viewer-content .page');
    const after = await state();
    expect(after.pageCount).toBe(14);
    expect(after.outline.map((item) => item.title)).toEqual([
      'blank',
      'multipage',
      'text',
      'outline',
      'rotated',
    ]);
    expect(after.outline.map((item) => item.page)).toEqual([0, 1, 6, 7, 10]);
  });

  test('a combined document opens as a tab that has never been saved', async () => {
    await app.run('convert.combineFiles', { files: [fileArg('blank.pdf')] });
    await app.page.waitForSelector('.viewer-content .page');
    expect((await summary()).canUndo).toBe(false);
    // Closing it asks about unkept work, which is what "never been saved" means to a reader.
    const closing = app.run('app.tabs.closeAll').catch(() => undefined);
    await expect(app.page.locator('#save-unsaved-dialog')).toBeVisible({ timeout: 5000 });
    await app.page
      .locator('#save-unsaved-dialog')
      .getByRole('button', { name: "Don't save" })
      .click();
    await closing;
  });
});

test.describe('split', () => {
  test.afterEach(closeAll);

  test('splitting back by bookmark gives per-file page counts that match the originals', async () => {
    const names = ['blank.pdf', 'multipage.pdf', 'text.pdf', 'outline.pdf', 'rotated.pdf'];
    const originals = [1, 5, 1, 3, 4];
    await app.run('convert.combineFiles', {
      files: names.map((name) => ({ name, bytes: Array.from(readFileSync(join(FIXTURES, name))) })),
      keepBookmarks: false,
    });
    await app.page.waitForSelector('.viewer-content .page');
    const result = (await app.run('organize.splitDocument', { by: 'bookmarks' })) as {
      parts: Array<{ name: string; pages: number[]; range: string }>;
    };
    expect(result.parts.map((p) => p.pages.length)).toEqual(originals);
  });

  test('by size: every part is inside the budget, or is a single page that cannot be', async () => {
    await open('skewed.pdf');
    const budget = 40_000;
    const result = (await app.run('organize.splitDocument', {
      by: 'size',
      bytes: budget,
    })) as { parts: Array<{ pages: number[]; bytes: number }> };
    expect(result.parts.length).toBeGreaterThan(0);
    for (const part of result.parts) {
      if (part.bytes > budget) expect(part.pages).toHaveLength(1);
    }
    expect(result.parts.flatMap((p) => p.pages).sort((a, b) => a - b)).toEqual([0, 1, 2, 3]);
  });

  test('the parts are written into the folder that was chosen', async () => {
    await open('multipage.pdf');
    const folder = mkdtempSync(join(workspace, 'split-'));
    const result = (await app.run('organize.splitDocument', {
      by: 'count',
      pages: 2,
      folder,
      namePattern: '{name}_{index}_{range}',
    })) as { written: string[] };
    expect(result.written).toHaveLength(3);
    const written = readdirSync(folder).sort();
    // `{name}` is the document's *title*, which is what M40's extract uses too — the fixture
    // calls itself "Multi-page" whatever the file on disk is called.
    expect(written).toEqual(['Multi-page_1_1-2.pdf', 'Multi-page_2_3-4.pdf', 'Multi-page_3_5.pdf']);
    // Every one of them is a real PDF a reader could open.
    for (const name of written) {
      const bytes = readFileSync(join(folder, name));
      expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    }
  });
});

test.describe('crop', () => {
  test.afterEach(closeAll);

  test('cropping to a rectangle sets the CropBox to it, and undo puts it back', async () => {
    await open('multipage.pdf');
    const before = must((await state()).boxes[0], 'page').crop;
    const rect = { x0: 40.25, y0: 60.5, x1: 400.75, y1: 500.125 };
    await app.run('organize.cropPages', { pages: [0], rect });

    const after = must((await state()).boxes[0], 'page').crop;
    expect(after.x0).toBeCloseTo(rect.x0, 2);
    expect(after.y0).toBeCloseTo(rect.y0, 2);
    expect(after.x1).toBeCloseTo(rect.x1, 2);
    expect(after.y1).toBeCloseTo(rect.y1, 2);

    await app.run('edit.undo');
    const restored = must((await state()).boxes[0], 'page').crop;
    expect(restored.x0).toBeCloseTo(before.x0, 2);
    expect(restored.x1).toBeCloseTo(before.x1, 2);
    expect((await summary()).issues).toEqual([]);
  });

  test('a crop survives a save and reopen', async () => {
    const path = stage('blank.pdf', 'cropped.pdf');
    await openPath(path);
    const rect = { x0: 20, y0: 30, x1: 300, y1: 400 };
    await app.run('organize.cropPages', { pages: [0], rect });
    const saved = (await app.run('file.save')) as { saved: boolean };
    expect(saved.saved).toBe(true);
    await closeAll();

    await openPath(path);
    const box = must((await state()).boxes[0], 'page').crop;
    expect(box.x0).toBeCloseTo(rect.x0, 1);
    expect(box.y1).toBeCloseTo(rect.y1, 1);
  });

  test('"change the page size" writes the MediaBox too', async () => {
    await open('blank.pdf');
    const rect = { x0: 10, y0: 10, x1: 200, y1: 300 };
    await app.run('organize.cropPages', { pages: [0], rect, changePageSize: true });
    const boxes = must((await state()).boxes[0], 'page');
    expect(boxes.media.x1).toBeCloseTo(rect.x1, 2);
    expect(boxes.crop.x1).toBeCloseTo(rect.x1, 2);
  });

  test('remove white margins crops a text page to what is drawn on it', async () => {
    await open('text.pdf');
    const before = must((await state()).boxes[0], 'page').crop;
    const result = (await app.run('organize.removeWhiteMargins', { pages: [0] })) as {
      cropped: number;
    };
    expect(result.cropped).toBe(1);
    const after = must((await state()).boxes[0], 'page').crop;
    expect(after.x1 - after.x0).toBeLessThan(before.x1 - before.x0);
    expect(after.y1 - after.y0).toBeLessThan(before.y1 - before.y0);
  });

  test('every box a page carries is readable, and the ones it does not are null', async () => {
    await open('mixed-boxes.pdf');
    const first = (await app.run('dev.pageBoxes', { page: 0 })) as Record<string, unknown>;
    expect(first['media']).not.toBeNull();
    expect(first['crop']).not.toBeNull();
    expect(first['trim']).toBeNull();
    const fourth = (await app.run('dev.pageBoxes', { page: 3 })) as Record<string, unknown>;
    expect(fourth['trim']).not.toBeNull();
    expect(fourth['bleed']).not.toBeNull();
    expect(fourth['art']).not.toBeNull();
  });
});

test.describe('flatten', () => {
  test.afterEach(closeAll);

  test('a flattened form has no fields, and undo brings them back', async () => {
    const path = stage('form.pdf', 'flattened.pdf');
    await openPath(path);
    const before = await summary();
    expect(before.fieldCount).toBeGreaterThan(0);

    const result = (await app.run('organize.flatten', {
      action: 'bake',
      pages: [0],
    })) as { flattened: number };
    expect(result.flattened).toBe(1);
    const after = await summary();
    expect(after.fieldCount).toBe(0);
    expect(after.pageCount).toBe(1);

    // One undo entry, and the fields are back.
    await app.run('edit.undo');
    const restored = await summary();
    expect(restored.fieldCount).toBe(before.fieldCount);
    expect(restored.pageCount).toBe(1);
    expect(restored.canUndo).toBe(false);
    expect(restored.issues).toEqual([]);

    // And the file on disk really loses its form: flattened, saved, reopened, no fields.
    await app.run('edit.redo');
    const saving = app.run('file.save');
    const warning = app.page.locator('#save-warnings-dialog');
    await expect(warning).toBeVisible();
    await expect(warning).toContainText(
      'The form was removed: none of its fields is on a page any more',
    );
    await warning.getByRole('button', { name: 'Save with these warnings', exact: true }).click();
    const saved = (await saving) as { saved: boolean };
    expect(saved.saved).toBe(true);
    await closeAll();
    await openPath(path);
    expect((await summary()).fieldCount).toBe(0);
  });

  test('flattening comments leaves the page count alone and is one undo step', async () => {
    await open('annotated.pdf');
    const before = await summary();
    await app.run('organize.flatten', { action: 'bake', pages: [0] });
    const after = await summary();
    expect(after.pageCount).toBe(before.pageCount);
    expect(after.canUndo).toBe(true);
    await app.run('edit.undo');
    const restored = await summary();
    expect(restored.canUndo).toBe(false);
    expect(restored.issues).toEqual([]);
  });

  test('"take them off the page" removes the marks rather than drawing them', async () => {
    await open('annotated.pdf');
    const result = (await app.run('organize.flatten', {
      action: 'remove',
      pages: [0],
    })) as { flattened: number; action: string };
    expect(result.action).toBe('remove');
    expect((await summary()).issues).toEqual([]);
  });
});

test.describe('straighten', () => {
  test.afterEach(closeAll);

  test('measures each page of the skewed fixture to within a fifth of a degree', async () => {
    await open('skewed.pdf');
    for (const [page, expected] of [2.3, -1.1, 7.5].entries()) {
      const reading = (await app.run('dev.detectSkew', { page })) as SkewReading;
      expect(reading.confidence, `page ${String(page + 1)}: ${reading.reason}`).not.toBe('none');
      expect(Math.abs(reading.angle - expected), `page ${String(page + 1)}`).toBeLessThanOrEqual(
        0.2,
      );
    }
  });

  test('the blank page is skipped, and says why in words', async () => {
    await open('skewed.pdf');
    const reading = (await app.run('dev.detectSkew', { page: 3 })) as SkewReading;
    expect(reading.confidence).toBe('none');
    expect(reading.reason).toBe('not enough content to tell');
  });

  test('straightening turns the page, and re-measuring finds it straight', async () => {
    await open('skewed.pdf');
    const result = (await app.run('organize.deskew', {
      angles: { 0: 2.3, 1: -1.1, 2: 7.5 },
    })) as { straightened: number };
    expect(result.straightened).toBe(3);
    for (const page of [0, 1, 2]) {
      const reading = (await app.run('dev.detectSkew', { page })) as SkewReading;
      expect(Math.abs(reading.angle), `page ${String(page + 1)} after`).toBeLessThanOrEqual(0.2);
    }
  });

  test('straightening is one undo entry, and undo restores the pages exactly', async () => {
    await open('skewed.pdf');
    const before = await state();
    expect((await summary()).canUndo).toBe(false);

    await app.run('organize.deskew', { angles: { 0: 2.3 } });
    const after = await state();
    expect(after.pageCount).toBe(before.pageCount);
    // The page was replaced, so it is a different model page with the same place in the order.
    expect(after.pageIds[0]).not.toBe(before.pageIds[0]);

    await app.run('edit.undo');
    const restored = await state();
    expect(restored.pageIds).toEqual(before.pageIds);
    expect((await summary()).canUndo).toBe(false);
    expect((await summary()).issues).toEqual([]);
    // And the page really is crooked again.
    const reading = (await app.run('dev.detectSkew', { page: 0 })) as SkewReading;
    expect(reading.angle).toBeGreaterThan(2);
  });

  test('"straighten every page" skips what it cannot measure and says which', async () => {
    await open('skewed.pdf');
    const result = (await app.run('organize.autoDeskew')) as {
      straightened: number;
      skipped: string[];
    };
    expect(result.straightened).toBe(3);
    expect(result.skipped).toEqual(['4']);
  });

  test('the dialog opens on the whole document, with a row for every page', async () => {
    await open('skewed.pdf');
    void app.run('organize.deskew');
    const dialog = app.page.locator('#ops-deskew');
    await dialog.waitFor({ timeout: 30_000 });
    // Scanned documents are crooked page by page, so the dialog offers the whole document rather
    // than the current page — including the one it could not measure, unticked and saying why.
    await expect(dialog.locator('.ops-row')).toHaveCount(4);
    await expect(dialog.locator('.ops-row input[type="checkbox"]:checked')).toHaveCount(3);
    await expect(dialog.getByText('Skipped')).toBeVisible();
    // Nothing in it is translucent, and the modal is opaque (the operator's rule).
    const opacity = await dialog.evaluate((el) => getComputedStyle(el).opacity);
    expect(opacity).toBe('1');
    await app.page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached', timeout: 10_000 }).catch(() => undefined);
  });

  test('a straightened document saves and reopens straight', async () => {
    const path = stage('skewed.pdf', 'straightened.pdf');
    await openPath(path);
    await app.run('organize.deskew', { angles: { 0: 2.3 } });
    const saved = (await app.run('file.save')) as { saved: boolean };
    expect(saved.saved).toBe(true);
    await closeAll();

    await openPath(path);
    const reading = (await app.run('dev.detectSkew', { page: 0 })) as SkewReading;
    expect(Math.abs(reading.angle)).toBeLessThanOrEqual(0.2);
  });
});

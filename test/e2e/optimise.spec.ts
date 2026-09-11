/**
 * M100 acceptance tests — optimising, auditing and repairing inside the real, built app.
 *
 * The unit tests own the arithmetic: the resampler, the Group 4 encoder, the sfnt surgery, the
 * audit's bookkeeping. This file owns what only exists once there is a window, a PDFium worker,
 * an optimise worker and a main process with qpdf in it — a file that really lands on disk at the
 * size the dialog promised, a damaged document that really opens after a repair, and the one
 * decision that spans three processes: fast web view on save.
 *
 * Each acceptance line in `docs/modules/M100-optimise-repair.md` has a test named after it.
 */

import { expect, test } from '@playwright/test';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixturePath, launchApp, type App } from './harness';

const FIXTURES = join(process.cwd(), 'test', 'fixtures');

interface OptimiseState {
  settings: {
    preset: string;
    linearizeOnSave: boolean;
    checkOnOpen: boolean;
    confirmReplace: boolean;
  };
  presets: Array<{ id: string; name: string; lossless: boolean }>;
  last: {
    before: number;
    after: number;
    path: string | null;
    changes: string[];
    warnings: string[];
    linearised: boolean;
  } | null;
  check: {
    ok: boolean;
    unreadable: boolean;
    linearised: boolean;
    encrypted: boolean;
    version: string | null;
    warnings: string[];
    errors: string[];
  } | null;
  offThread: boolean;
}

interface AuditState {
  total: number;
  slices: Array<{ category: string; bytes: number; share: number; objects: number }>;
}

interface DocumentSummary {
  pageCount: number;
  fieldCount: number;
  annotationCount: number;
  canUndo: boolean;
  canRedo: boolean;
  issues: string[];
}

let app: App;
let workspace: string;

test.beforeAll(async () => {
  workspace = mkdtempSync(join(tmpdir(), 'ynot-optimise-'));
  app = await launchApp();
});

test.afterAll(async () => {
  await app.close();
  rmSync(workspace, { recursive: true, force: true });
});

const state = (): Promise<OptimiseState> => app.run('dev.optimiseState') as Promise<OptimiseState>;
const summary = (): Promise<DocumentSummary> =>
  app.run('dev.documentSummary') as Promise<DocumentSummary>;

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

async function openPath(path: string): Promise<void> {
  await app.run('file.openRecent', { path });
  await app.page.waitForSelector('.viewer-content .page');
  await app.page.waitForTimeout(200);
}

/**
 * Dismisses any message box left open.
 *
 * `optimise.check` deliberately does not wait for its own dialog — a command that only answers
 * once somebody has pressed OK is a command nothing can drive — so a test that asks for a check
 * and then moves on leaves one behind for the next test to trip over.
 */
async function closeDialogs(): Promise<void> {
  const boxes = app.page.locator('dialog.dlg-messagebox[open]');
  for (let i = 0; i < 6; i++) {
    if ((await boxes.count()) === 0) break;
    await boxes
      .last()
      .press('Escape')
      .catch(() => undefined);
    await app.page.waitForTimeout(60);
  }
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
    await app.page.waitForTimeout(60);
  }
  await closing;
  await app.page.waitForTimeout(80);
}

test.describe('M100 — optimise', () => {
  test.afterEach(async () => {
    await closeDialogs();
    await closeAll();
  });

  test('every command is registered and reachable from the palette', async () => {
    const commands = await app.commands();
    for (const id of [
      'optimise.reduce',
      'optimise.audit',
      'optimise.check',
      'optimise.repair',
      'optimise.fastWebView.toggle',
    ]) {
      expect(commands).toContain(id);
    }
  });

  test('the bloated fixture shrinks by at least half with the Standard preset', async () => {
    await open('bloated.pdf');
    const path = join(workspace, 'bloated-standard.pdf');
    const outcome = (await app.run('optimise.reduce', {
      preset: 'standard',
      path,
    })) as OptimiseState['last'];

    expect(outcome).not.toBeNull();
    expect(outcome?.after).toBeLessThanOrEqual((outcome?.before ?? 0) / 2);
    // The number the app reported is the size of the file it actually wrote.
    expect(statSync(path).size).toBe(outcome?.after);

    // And the document it wrote is the same document.
    const before = await summary();
    await openPath(path);
    const after = await summary();
    expect(after.pageCount).toBe(before.pageCount);
  });

  test('the optimised copy is clean by qpdf’s own reckoning', async () => {
    const path = join(workspace, 'bloated-clean.pdf');
    await open('bloated.pdf');
    await app.run('optimise.reduce', { preset: 'standard', path });
    await closeAll();

    await openPath(path);
    const check = (await app.run('optimise.check')) as OptimiseState['check'];
    expect(check?.errors).toEqual([]);
    expect(check?.ok).toBe(true);
  });

  test('the lossless preset makes it smaller without changing a pixel', async () => {
    await open('bloated.pdf');
    const path = join(workspace, 'bloated-lossless.pdf');
    const outcome = (await app.run('optimise.reduce', {
      preset: 'lossless',
      path,
    })) as OptimiseState['last'];
    expect(outcome?.after).toBeLessThan(outcome?.before ?? 0);
    // Lossless means what it says: nothing about the pages was discarded.
    expect((outcome?.changes ?? []).join(' ')).not.toMatch(/removed/i);
  });

  test('the report says what was done, in words', async () => {
    await open('bloated.pdf');
    await app.run('optimise.reduce', {
      preset: 'standard',
      path: join(workspace, 'bloated-report.pdf'),
    });
    const { last } = await state();
    expect(last?.changes.length).toBeGreaterThan(0);
    expect(last?.changes.join(' ')).toMatch(/duplicate|image/i);
  });

  test('a document with nothing to gain is not made worse', async () => {
    await open('blank.pdf');
    const path = join(workspace, 'blank-optimised.pdf');
    const outcome = (await app.run('optimise.reduce', {
      preset: 'standard',
      path,
    })) as OptimiseState['last'];
    expect(outcome).not.toBeNull();
    await openPath(path);
    expect((await summary()).pageCount).toBe(1);
  });

  test('the work happens off the main thread', async () => {
    await open('bloated.pdf');
    await app.run('optimise.reduce', {
      preset: 'lossless',
      path: join(workspace, 'bloated-thread.pdf'),
    });
    expect((await state()).offThread).toBe(true);
  });
});

test.describe('M100 — the space audit', () => {
  test.afterEach(async () => {
    await closeDialogs();
    await closeAll();
  });

  test('divides the whole file up and puts most of the bloated fixture down to its images', async () => {
    await open('bloated.pdf');
    const audit = (await app.run('dev.optimiseAudit')) as AuditState;
    const sum = audit.slices.reduce((n, s) => n + s.bytes, 0);
    expect(Math.abs(sum - audit.total)).toBeLessThanOrEqual(audit.slices.length);
    const images = audit.slices.find((s) => s.category === 'images');
    expect(images?.share).toBeGreaterThan(0.5);
  });

  test('the dialog draws a chart and a table, and neither needs colour to be read', async () => {
    await open('bloated.pdf');
    const opening = app.run('optimise.audit');
    const dialog = app.page.locator('#optimise-audit');
    await expect(dialog).toBeVisible();

    // The chart: a labelled image, with its slices filled by pattern rather than by colour alone.
    const chart = dialog.locator('svg.opt-donut');
    await expect(chart).toHaveAttribute('role', 'img');
    await expect(chart).toHaveAttribute('aria-label', /bytes are/i);
    expect(await chart.locator('pattern').count()).toBeGreaterThan(0);

    // The table: the part that answers the question on its own.
    await expect(dialog.locator('.opt-audit-table tbody tr').first()).toBeVisible();
    await expect(dialog.locator('.opt-audit-table tfoot')).toContainText(/MB|kB|bytes/);

    await dialog.getByRole('button', { name: 'Close' }).click();
    await opening;
  });

  test('the chart’s colours are theme tokens, not literals', async () => {
    await open('bloated.pdf');
    const opening = app.run('optimise.audit');
    const dialog = app.page.locator('#optimise-audit');
    await expect(dialog).toBeVisible();
    const fills = await dialog
      .locator('svg.opt-donut pattern rect')
      .evaluateAll((nodes) => nodes.map((n) => n.getAttribute('fill') ?? ''));
    expect(fills.length).toBeGreaterThan(0);
    for (const fill of fills) expect(fill).toMatch(/^var\(--/);
    await dialog.getByRole('button', { name: 'Close' }).click();
    await opening;
  });
});

test.describe('M100 — repair', () => {
  test.afterEach(async () => {
    await closeDialogs();
    await closeAll();
  });

  test('the broken-xref fixture repairs and the repaired copy opens', async () => {
    // Opened from a real file, not from bytes: the check reads the *file*, and a document opened
    // through PDFium has already had its cross-reference table rebuilt on the way in.
    await openPath(stage('broken-xref.pdf', 'broken-source.pdf'));
    const path = join(workspace, 'broken-repaired.pdf');
    const result = (await app.run('optimise.repair', { path })) as { path: string } | null;
    expect(result?.path).toBe(path);
    expect(statSync(path).size).toBeGreaterThan(0);

    await closeAll();
    await openPath(path);
    expect((await summary()).pageCount).toBe(1);

    const check = (await app.run('optimise.check')) as OptimiseState['check'];
    expect(check?.ok).toBe(true);
  });

  test('a healthy document is reported as healthy', async () => {
    await open('text.pdf');
    const check = (await app.run('optimise.check')) as OptimiseState['check'];
    expect(check?.ok).toBe(true);
    expect(check?.version).toBe('1.7');
    const dialog = app.page.locator('dialog.dlg-messagebox[open]').last();
    await expect(dialog).toContainText(/Nothing wrong/i);
    await dialog.getByRole('button', { name: 'OK' }).click();
    await expect(dialog).toBeHidden();
  });

  test('a damaged document is reported as damaged, with the offer to repair it', async () => {
    await openPath(stage('broken-xref.pdf', 'broken-reported.pdf'));
    const found = (await app.run('optimise.check')) as OptimiseState['check'];
    expect(found?.ok).toBe(false);
    const dialog = app.page.locator('dialog.dlg-messagebox[open]').last();
    await expect(dialog).toContainText(/damage/i);
    // The offer is a worded button, not a colour.
    await expect(dialog.getByRole('button', { name: /Repair a copy/i })).toBeVisible();
    await dialog.getByRole('button', { name: 'Close' }).click();
    await expect(dialog).toBeHidden();
  });
});

test.describe('M100 — fast web view', () => {
  test.afterEach(async () => {
    await closeDialogs();
    await closeAll();
    await app.run('optimise.fastWebView.toggle', { on: false });
  });

  test('is off until it is asked for, and then it is on', async () => {
    expect((await state()).settings.linearizeOnSave).toBe(false);
    await app.run('optimise.fastWebView.toggle', { on: true });
    expect((await state()).settings.linearizeOnSave).toBe(true);
    await app.run('optimise.fastWebView.toggle', { on: false });
    expect((await state()).settings.linearizeOnSave).toBe(false);
  });

  test('linearises a saved file, and Properties says so', async () => {
    const path = stage('text.pdf', 'fast-web-view.pdf');
    await openPath(path);
    await app.run('optimise.fastWebView.toggle', { on: true });
    // Something has to change for a save to happen at all: Save on a clean document is a no-op,
    // and a stage that never runs proves nothing.
    await app.run('organize.rotateRight', { pages: [0] });
    await app.run('file.save');
    await app.page.waitForTimeout(400);

    await closeAll();
    await openPath(path);
    const check = (await app.run('optimise.check')) as OptimiseState['check'];
    expect(check?.linearised).toBe(true);
  });

  test('the optimise dialog can ask for it directly', async () => {
    await open('bloated.pdf');
    const path = join(workspace, 'bloated-fwv.pdf');
    const outcome = (await app.run('optimise.reduce', {
      preset: 'small',
      path,
    })) as OptimiseState['last'];
    // "Small" and "Smallest" both linearise.
    expect(outcome?.linearised).toBe(true);
    await closeAll();
    await openPath(path);
    expect(((await app.run('optimise.check')) as OptimiseState['check'])?.linearised).toBe(true);
  });
});

test.describe('M100 — the dialog', () => {
  test.afterEach(async () => {
    await closeDialogs();
    await closeAll();
  });

  test('opens with six tabs, every one of them keyboard-reachable', async () => {
    await open('bloated.pdf');
    const opening = app.run('optimise.reduce');
    const dialog = app.page.locator('#optimise-dialog');
    await expect(dialog).toBeVisible();

    const tabs = dialog.locator('[role="tab"]');
    await expect(tabs).toHaveCount(6);
    await tabs.first().focus();
    for (let i = 0; i < 5; i++) await app.page.keyboard.press('ArrowRight');
    await expect(tabs.last()).toHaveAttribute('aria-selected', 'true');

    await dialog.getByRole('button', { name: 'Cancel' }).click();
    expect(await opening).toBeNull();
  });

  test('names the two codecs it will not write rather than leaving them out', async () => {
    await open('bloated.pdf');
    const opening = app.run('optimise.reduce');
    const dialog = app.page.locator('#optimise-dialog');
    await dialog.locator('[data-tab="images"]').click();
    const images = dialog.locator('#optimise-panel-images');
    await expect(images).toContainText(/JPEG 2000/);
    await expect(images).toContainText(/JBIG2/);
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await opening;
  });

  test('says the size it would produce only after it has actually produced it', async () => {
    await open('bloated.pdf');
    const opening = app.run('optimise.reduce');
    const dialog = app.page.locator('#optimise-dialog');
    await expect(dialog.locator('.opt-summary')).toContainText(/Check the size/);

    await dialog.getByRole('button', { name: /Check the size/ }).click();
    await expect(dialog.locator('.opt-summary')).toContainText(/smaller/, { timeout: 30_000 });
    await expect(dialog.locator('.opt-changes li').first()).toBeVisible();

    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await opening;
  });

  test('is fully opaque, like every dialog in this app', async () => {
    await open('bloated.pdf');
    const opening = app.run('optimise.reduce');
    const dialog = app.page.locator('#optimise-dialog');
    await expect(dialog).toBeVisible();
    const opacity = await dialog.evaluate((node) => {
      const style = getComputedStyle(node);
      return {
        opacity: style.opacity,
        backdrop: style.getPropertyValue('backdrop-filter'),
        background: style.backgroundColor,
      };
    });
    expect(opacity.opacity).toBe('1');
    expect(opacity.backdrop === '' || opacity.backdrop === 'none').toBe(true);
    expect(opacity.background).not.toMatch(/rgba\([^)]*,\s*0(\.\d+)?\)/);
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await opening;
  });
});

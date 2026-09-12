/**
 * The real startup paths (M04).
 *
 * Defect 2 lived here for a month. The nav pane mounts each panel once and caches it, and the
 * shell is built before `registry.activateAll()`, so the panel restored at startup was built
 * against services that did not exist: M12's Pages panel took its "the navigation panels are
 * not available" path and stayed that way for the session. **No test could see it**, because
 * under `YNOT_E2E` a demo module registers two left panels that sort before M12's, and the
 * panel a fresh profile opened was `demo.alpha`. The real first launch was never taken.
 *
 * Every launch in this file therefore passes `noDemo: true`. That is the app a reader gets.
 *
 * The window chrome is here too (defect 4): off macOS there is no application menu, because
 * Electron drew one inside the window and the operator saw two rows of tabs.
 */

import { expect, test, type Page } from '@playwright/test';
import { realpathSync, copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchApp, type App } from './harness';
import { journey } from './journey';
import { expectInsideWindow, expectNoOverlap, expectNothingClipped } from './layout';

const FIXTURES = join(process.cwd(), 'test', 'fixtures');
let workspace: string;

test.beforeAll(() => {
  workspace = realpathSync.native(mkdtempSync(join(tmpdir(), 'ynot-m04-startup-')));
});

test.afterAll(() => {
  rmSync(workspace, { recursive: true, force: true });
});

function stage(name: string, as: string): string {
  const path = join(workspace, as);
  copyFileSync(join(FIXTURES, name), path);
  return path;
}

/**
 * Every word the window is showing, and the fallback elements that mean a panel gave up.
 *
 * The strings matter more than the classes: `.nav-empty` is also how a panel says "no bookmarks
 * in this document", which is a true and useful thing to say. "not available" never is.
 */
async function fallbacks(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const found: string[] = [];
    const text = document.body.innerText;
    for (const pattern of [
      /[^.\n]*\bnot available\b[^.\n]*/gi,
      /[^.\n]*\bfailed to load\b[^.\n]*/gi,
      /[^.\n]*\bcould not be loaded\b[^.\n]*/gi,
    ]) {
      for (const m of text.matchAll(pattern)) found.push(m[0].trim());
    }
    for (const el of document.querySelectorAll('.panel-error')) {
      found.push(`.panel-error: ${el.textContent ?? ''}`);
    }
    return found;
  });
}

/** The panel the left pane is actually showing, or null when the pane is collapsed. */
async function openPanelId(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const pressed = document.querySelector('#nav-strip button[aria-pressed="true"]');
    return pressed instanceof HTMLElement ? (pressed.dataset['panel'] ?? null) : null;
  });
}

// ---- first launch, fresh profile -----------------------------------------------------------------

test.describe('a fresh profile, with no demo module', () => {
  let app: App;

  test.beforeAll(async () => {
    app = await launchApp({ noDemo: true });
    await app.grantPath(workspace, true);
  });

  test.afterAll(async () => {
    await app.close();
  });

  test('the demo module really is absent, so this is the reader’s app', async () => {
    const commands = await app.commands();
    expect(commands.filter((id) => id.startsWith('demo.'))).toEqual([]);
    await expect(app.page.locator('#nav-strip button[data-panel^="demo."]')).toHaveCount(0);
    // The first left panel is now M12's, which is the one a fresh profile opens.
    const panels = await app.page.evaluate(() =>
      Array.from(document.querySelectorAll('#nav-strip button')).map(
        (b) => (b as HTMLElement).dataset['panel'] ?? '',
      ),
    );
    expect(panels[0]).toBe('nav.pages');
  });

  test('the start page is whole: nothing clipped, nothing outside the window', async () => {
    await expect(app.page.locator('#empty-state')).toBeVisible();
    // Visible is not enough — the whole defect. The document host must not be laid out at all
    // with nothing open, and the tiles must start at the top of the area, not above it.
    await expect(app.page.locator('#doc-host')).toBeHidden();
    await expectNothingClipped(app.page.locator('body'));
    await expectInsideWindow(app.page.locator('body'));
  });

  test('no panel anywhere says it is not available', async () => {
    const j = journey(app);
    const ids = await app.page.evaluate(() =>
      Array.from(document.querySelectorAll('#nav-strip button')).map(
        (b) => (b as HTMLElement).dataset['panel'] ?? '',
      ),
    );
    expect(ids.length).toBeGreaterThan(4);
    for (const id of ids) {
      await j.openPanel(id);
      await app.page.waitForTimeout(120);
      expect(await fallbacks(app.page), `after opening ${id}`).toEqual([]);
      await expect(app.page.locator('#pane-left .panel-error')).toHaveCount(0);
    }
  });

  /**
   * One panel, one copy. A panel whose `mount` changes UI state re-entered the pane's own
   * `refresh` before the pane had recorded it, and the Pages panel — the one a fresh profile
   * opens — came up twice, stacked. Nothing saw it because with the demo module registered the
   * panel a fresh profile opens is `demo.alpha`, whose mount changes nothing (M04, 2026-09-10).
   */
  test('every panel is mounted exactly once', async () => {
    const counts = await app.page.evaluate(() => {
      const seen: Record<string, number> = {};
      for (const el of document.querySelectorAll('#nav-host > .panel, #props-host > .panel')) {
        const id = (el as HTMLElement).dataset['panel'] ?? '?';
        seen[id] = (seen[id] ?? 0) + 1;
      }
      return seen;
    });
    expect(Object.entries(counts).filter(([, n]) => n !== 1)).toEqual([]);
  });

  test('there is one row of tabs, and the ribbon does not sit on the document', async () => {
    const hasAppMenu = await app.electron.evaluate(
      ({ Menu }) => Menu.getApplicationMenu() !== null,
    );
    // macOS keeps its menu where the platform expects it — outside the window. Everywhere else
    // Electron would draw it *inside*, immediately above the ribbon's own tabs (defect 4).
    expect(hasAppMenu).toBe(process.platform === 'darwin');
    await expect(app.page.locator('#ribbon-tabs')).toBeVisible();
    await expectNoOverlap(app.page.locator('#ribbon'), app.page.locator('#doc-area'));
    await expectNoOverlap(app.page.locator('#ribbon'), app.page.locator('#statusbar'));
  });
});

// ---- launched with a document ----------------------------------------------------------------------

test.describe('launched with a document on the command line', () => {
  test('the file association path opens the document and the Pages panel', async () => {
    const path = stage('multipage.pdf', 'launched.pdf');
    const app = await launchApp({ noDemo: true, open: [path] });
    await app.grantPath(workspace, true);
    try {
      await app.page.waitForSelector('.viewer-content .page', { timeout: 30_000 });
      await expect(app.page.locator('.tab')).toHaveCount(1);
      await expect(app.page.locator('#doc-host')).toBeVisible();
      // Defect 2 in one line: with the demo module gone this *is* M12's Pages panel, mounted
      // for real, and a thumbnail has to be in it.
      expect(await openPanelId(app.page)).toBe('nav.pages');
      await expect(
        app.page.locator('#nav-host .panel[data-panel="nav.pages"] .thumb-cell'),
      ).not.toHaveCount(0);
      expect(await fallbacks(app.page)).toEqual([]);
      await expectNothingClipped(app.page.locator('body'));
      await expectInsideWindow(app.page.locator('body'));
    } finally {
      await app.close();
    }
  });
});

// ---- ui.leftPaneOnOpen ------------------------------------------------------------------------------

test.describe('ui.leftPaneOnOpen decides the panel a document opens on', () => {
  // `bookmarks` needs a document that has some; `outline.pdf` is the fixture with an outline.
  const cases = [
    { value: 'pages', fixture: 'multipage.pdf', expected: 'nav.pages' },
    { value: 'bookmarks', fixture: 'outline.pdf', expected: 'nav.bookmarks' },
    { value: 'last-used', fixture: 'multipage.pdf', expected: 'nav.pages' },
    { value: 'closed', fixture: 'multipage.pdf', expected: null },
  ] as const;

  for (const { value, fixture, expected } of cases) {
    test(`"${value}" opens ${expected ?? 'nothing'}`, async () => {
      const path = stage(fixture, `pane-${value}.pdf`);
      const app = await launchApp({
        noDemo: true,
        settings: { 'ui.leftPaneOnOpen': value },
        open: [path],
      });
      try {
        await app.page.waitForSelector('.viewer-content .page', { timeout: 30_000 });
        await app.page.waitForTimeout(500);
        expect(await openPanelId(app.page)).toBe(expected);
        expect(await fallbacks(app.page)).toEqual([]);
        await expectNothingClipped(app.page.locator('body'));
      } finally {
        await app.close();
      }
    });
  }
});

// ---- relaunch after a crash --------------------------------------------------------------------------

test.describe('relaunch after a crash', () => {
  test('the recovery dialog is offered, and the window behind it is sound', async () => {
    const path = stage('multipage.pdf', 'crashed-startup.pdf');
    const first = await launchApp({ noDemo: true });
    await first.grantPath(workspace, true);
    const bytes = Array.from(readFileSync(path));
    await first.run('file.openBytes', { file: { path, name: 'crashed-startup.pdf', bytes } });
    await first.page.waitForSelector('.viewer-content .page', { timeout: 30_000 });
    await first.run('dev.documentApply', { kind: 'rotate', page: 0, rotation: 90 });
    expect((await first.run('file.autosaveNow')) as { written: number }).toEqual({ written: 1 });
    // Kill it outright: a clean quit clears the record, and a crash is the case under test.
    await first.electron.evaluate(({ app }) => {
      app.exit(1);
    });

    const second = await launchApp({ noDemo: true, reuseUserData: true });
    await second.grantPath(workspace, true);
    try {
      const dialog = second.page.locator('#save-recovery-dialog');
      await expect(dialog).toBeVisible({ timeout: 20_000 });
      expect(await fallbacks(second.page)).toEqual([]);
      await expectNothingClipped(dialog);
      await expectInsideWindow(second.page.locator('body'));
      await dialog.getByRole('button', { name: 'Recover' }).click();
      await expect(second.page.locator('.tab')).toHaveCount(1, { timeout: 20_000 });
      // And the panel the recovered session lands on is the real one, mounted after activation.
      await expect(second.page.locator('#pane-left .panel-error')).toHaveCount(0);
      expect(await fallbacks(second.page)).toEqual([]);
    } finally {
      await second.close();
    }
  });
});

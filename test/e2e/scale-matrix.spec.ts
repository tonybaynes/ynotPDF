/**
 * The scale and window matrix (M04).
 *
 * Every test in this suite ran at 100 % UI scale, in one window size. Two of the operator's
 * five defects lived in the gap:
 *
 * - **150 %** is where defect 3 lived. Everything inside a pane is sized in rem and grows with
 *   `--ui-scale`, but the pane widths were a fixed pixel count and did not, so the right pane
 *   stayed 280 px while its contents needed more and four swatch labels were cut off.
 * - **A short window** is where defect 1 lived. `.empty-state` centred its content while
 *   scrolling, so as soon as the content was taller than the box it overflowed at *both* ends
 *   and its top could never be scrolled to. At 1280×800 the content fits and nothing shows.
 *
 * So: three scales × three window sizes, over the start page, a document with both panes open,
 * every ribbon tab, the comments panel and the three largest dialogs.
 *
 * The scale is **seeded into the profile** rather than set by a command afterwards, because the
 * first paint has to happen at that scale — which is when a layout that only works at 100 %
 * gets to look correct and then never be re-measured.
 */

import { expect, test } from '@playwright/test';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchApp, type App, type WindowSize } from './harness';
import { journey } from './journey';
import { expectInsideWindow, expectNothingClipped, expectReadable } from './layout';

const FIXTURES = join(process.cwd(), 'test', 'fixtures');
const SCALES = [100, 150, 200] as const;
/** Deliberately short: this is the shape the start page could not survive. */
const SHORT = { name: '1280x600 (short)', width: 1280, height: 600 } as const;

const SIZES: ReadonlyArray<WindowSize & { readonly name: string }> = [
  { name: '1280x800', width: 1280, height: 800 },
  { name: '1920x1080', width: 1920, height: 1080 },
  SHORT,
];

/** The three widest dialogs in the app, by the width they ask for. */
const BIG_DIALOGS = [
  { command: 'app.preferences', selector: '#preferences-dialog', label: 'Preferences (940 px)' },
  { command: 'file.print', selector: '#print-dialog', label: 'Print (900 px)' },
  { command: 'organize.deskew', selector: '#ops-deskew', label: 'Deskew (860 px)' },
] as const;

let workspace: string;

test.beforeAll(() => {
  workspace = mkdtempSync(join(tmpdir(), 'ynot-m04-matrix-'));
});

test.afterAll(() => {
  rmSync(workspace, { recursive: true, force: true });
});

/** Nothing clipped, nothing outside the window, over the whole window. */
async function windowIsSound(app: App, where: string): Promise<void> {
  await test.step(where, async () => {
    await expectNothingClipped(app.page.locator('body'));
    await expectInsideWindow(app.page.locator('body'));
  });
}

/**
 * Resizes, and answers whether the window really became that size.
 *
 * A matrix that silently tests one size three times is worse than no matrix. A machine whose
 * screen is smaller than the size under test is exactly how that happens: macOS clamps a window
 * to the visible screen, and GitHub's macOS runners are 1024x768, so 1280x800 comes back as
 * 1280x645. CI's Xvfb screen is set to 1920x1080 for the same reason.
 *
 * So a size the machine cannot give is **recorded as not tested** and skipped, rather than
 * quietly measured at some other size. The short window is the one this suite cannot do without
 * — it is where defect 1 lived — and it fits on every runner; the tests below insist on it.
 */
async function resizeTo(app: App, size: WindowSize & { readonly name: string }): Promise<boolean> {
  await app.resize(size);
  const got = await app.viewportSize();
  if (got.width === size.width && got.height === size.height) return true;
  test.info().annotations.push({
    type: 'size not available',
    description:
      `${size.name} is bigger than this machine's screen — the window became ` +
      `${String(got.width)}x${String(got.height)}, so the layout assertions did not run at it.`,
  });
  return false;
}

/** The short window has to be one of the sizes that actually ran. */
function expectShortWindowTested(tested: ReadonlyArray<string>): void {
  expect(
    tested,
    'the short window is where defect 1 lived and fits on every runner; it must be tested',
  ).toContain(SHORT.name);
}

for (const scale of SCALES) {
  test.describe(`UI scale ${scale}%`, () => {
    let app: App;

    test.beforeAll(async () => {
      app = await launchApp({ noDemo: true, settings: { 'ui.scale': scale } });
      // The scale really is the one asked for, at the first paint rather than after a command.
      const applied = await app.page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue('--ui-scale').trim(),
      );
      expect(Number.parseFloat(applied)).toBeCloseTo(scale / 100, 2);
    });

    test.afterAll(async () => {
      await app.close();
    });

    test('the start page survives every window size this machine can give', async () => {
      const tested: string[] = [];
      for (const size of SIZES) {
        if (!(await resizeTo(app, size))) continue;
        tested.push(size.name);
        await expect(app.page.locator('#empty-state')).toBeVisible();
        await windowIsSound(app, `start page at ${scale}% in ${size.name}`);
        await expectReadable(app.page.locator('#empty-state'));
      }
      expectShortWindowTested(tested);
    });

    test('a document with both panes, every ribbon tab, comments and the big dialogs', async () => {
      const j = journey(app);
      const path = join(workspace, `matrix-${scale}.pdf`);
      copyFileSync(join(FIXTURES, 'comments.pdf'), path);
      await j.openDocument(path);
      // Both panes open: the left one shows Pages, the right one needs a selection to have
      // anything to show, which `annot.selectAll` gives it.
      await j.openPanel('nav.pages');
      await app.run('annot.selectAll');
      if ((await app.run('view.pane.right.toggle')) === false) {
        await app.run('view.pane.right.toggle');
      }
      await expect(app.page.locator('#pane-right')).toBeVisible();

      const tabs = await app.page.evaluate(() =>
        Array.from(document.querySelectorAll('#ribbon-tabs [role="tab"]')).map(
          (t) => (t as HTMLElement).dataset['tab'] ?? '',
        ),
      );
      expect(tabs.length).toBeGreaterThan(8);

      const tested: string[] = [];
      for (const size of SIZES) {
        if (!(await resizeTo(app, size))) continue;
        tested.push(size.name);
        await windowIsSound(app, `document with both panes at ${scale}% in ${size.name}`);
        // Defect 3 exactly: the pane is a fixed width, its contents are in rem, and at 150 %
        // the labels run off the right edge of a box that never grew.
        await expectReadable(app.page.locator('#pane-right'));
        await expectReadable(app.page.locator('#pane-left'));

        for (const tab of tabs) {
          await app.page.locator(`#ribbon-tabs [data-tab="${tab}"]`).click();
          await app.page.waitForTimeout(80);
          await expectNothingClipped(app.page.locator('#ribbon'));
          await expectInsideWindow(app.page.locator('#ribbon'));
        }
        await app.page.locator('#ribbon-tabs [data-tab="home"]').click();

        await j.openPanel('nav.comments');
        await windowIsSound(app, `comments panel at ${scale}% in ${size.name}`);
        await expectReadable(app.page.locator('#pane-left'));
        await j.openPanel('nav.pages');

        for (const { command, selector, label } of BIG_DIALOGS) {
          void app.run(command);
          const dialog = app.page.locator(selector);
          await expect(dialog, `${label} did not open`).toBeVisible({ timeout: 15_000 });
          await app.page.waitForTimeout(150);
          await test.step(`${label} at ${scale}% in ${size.name}`, async () => {
            await expectNothingClipped(dialog);
            await expectInsideWindow(dialog);
            await expectReadable(dialog);
          });
          await app.page.keyboard.press('Escape');
          await expect(dialog).toHaveCount(0);
        }
      }
      expectShortWindowTested(tested);
    });
  });
}

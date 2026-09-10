/**
 * Visual regression, kept cheap (M04).
 *
 * Ten screens at one window size with a generous tolerance. **The point is catching a layout
 * collapse — a pane that vanished, a ribbon that fell into one column, a theme that painted the
 * text the same colour as the panel — not policing pixels.** A suite that fails on antialiasing
 * gets switched off within a week, and then it catches nothing at all.
 *
 * Baselines are per platform and committed. A platform with no baselines skips rather than
 * failing: generate them on that machine with
 *
 * ```bash
 * npx playwright test test/e2e/visual.spec.ts --update-snapshots
 * ```
 *
 * and commit what it writes. See `docs/modules/M04-ui-journey-tests.md` for which platforms are
 * seeded today.
 */

import { expect, test, type Locator } from '@playwright/test';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { launchApp, type App } from './harness';
import { journey } from './journey';

const SNAPSHOTS = join(process.cwd(), 'test', 'e2e', 'visual.spec.ts-snapshots');
const SIZE = { width: 1280, height: 800 } as const;

/** How much of the picture may differ before it counts as a change. */
const COMPARE = { maxDiffPixelRatio: 0.02, animations: 'disabled' } as const;

let app: App;

/** True when this platform has baselines committed; false the first time anyone runs it here. */
function seeded(): boolean {
  if (!existsSync(SNAPSHOTS)) return false;
  const tag =
    process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux';
  return readdirSync(SNAPSHOTS).some((name) => name.includes(tag));
}

test.beforeAll(async () => {
  app = await launchApp({ noDemo: true, window: SIZE });
});

test.afterAll(async () => {
  await app.close();
});

test.beforeEach(() => {
  // `--update-snapshots` is how the baselines get written in the first place, so it must not skip.
  const writing = test.info().config.updateSnapshots === 'all';
  test.skip(
    !seeded() && !writing,
    `no visual baselines for ${process.platform} yet — run this spec with --update-snapshots on ` +
      'this platform and commit test/e2e/visual.spec.ts-snapshots/',
  );
});

/** Settles the window: fonts loaded, tiles rendered, no caret blinking. */
async function settle(where: Locator = app.page.locator('body')): Promise<void> {
  await app.page.evaluate(() => document.fonts.ready);
  await app.page.waitForTimeout(600);
  await where.evaluate(() => undefined);
}

test('the start page', async () => {
  await settle();
  await expect(app.page).toHaveScreenshot('start-page.png', COMPARE);
});

test('a document with both panes open', async () => {
  const j = journey(app);
  await j.openDocument(join(process.cwd(), 'test', 'fixtures', 'outline.pdf'));
  await j.openPanel('nav.pages');
  if ((await app.run('view.pane.right.toggle')) === false) {
    await app.run('view.pane.right.toggle');
  }
  await settle();
  await expect(app.page).toHaveScreenshot('document-both-panes.png', COMPARE);
});

for (const theme of ['graphite', 'midnight', 'daylight', 'high-contrast'] as const) {
  test(`the ${theme} theme`, async () => {
    await app.run(`view.theme.set.${theme}`);
    await settle();
    await expect(app.page).toHaveScreenshot(`theme-${theme}.png`, COMPARE);
  });
}

for (const tab of ['home', 'comment', 'view', 'organize'] as const) {
  test(`the ribbon on the ${tab} tab`, async () => {
    await app.run('view.theme.set.graphite');
    await app.page.locator(`#ribbon-tabs [data-tab="${tab}"]`).click();
    await settle();
    await expect(app.page.locator('#ribbon')).toHaveScreenshot(`ribbon-${tab}.png`, COMPARE);
  });
}

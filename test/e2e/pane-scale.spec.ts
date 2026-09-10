/**
 * Pane widths against the reader's UI scale.
 *
 * Everything inside a pane is sized in rem, so it grows with `--ui-scale` — but the pane widths
 * were a fixed pixel count and did not. At the scale the operator runs, the right pane stayed
 * 280 px while its contents needed more, and the labels were cut off at the edge (2026-09-10).
 * Widths are now stored at scale 1 and multiplied on the way to the DOM.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { launchApp, type App } from './harness';

let app: App;

test.beforeAll(async () => {
  app = await launchApp();
});

test.afterAll(async () => {
  await app.close();
});

/** Elements whose own content is wider than the box drawn for it. */
const clipped = (selector: string): Promise<string[]> =>
  app.page.evaluate((sel) => {
    const out: string[] = [];
    document.querySelectorAll(`${sel} *`).forEach((n) => {
      const e = n as HTMLElement;
      if (e.clientWidth > 0 && e.scrollWidth > e.clientWidth + 1) {
        out.push(`${e.className || e.tagName} ${e.scrollWidth}>${e.clientWidth}`);
      }
    });
    return out;
  }, selector);

const paneWidth = (id: string): Promise<number> =>
  app.page.evaluate(
    (sel) => Math.round(document.querySelector(sel)?.getBoundingClientRect().width ?? 0),
    id,
  );

test('both panes grow with the UI scale, and nothing inside is cut off', async () => {
  const name = 'annotations-all.pdf';
  const bytes = Array.from(readFileSync(join(process.cwd(), 'test', 'fixtures', name)));
  await app.run('file.openBytes', { file: { path: `C:/fixtures/${name}`, name, bytes } });
  await app.page.waitForSelector('.viewer-content .page');
  await app.run('annot.selectAll');
  if ((await app.run('view.pane.right.toggle')) === false) {
    await app.run('view.pane.right.toggle');
  }
  await expect(app.page.locator('#pane-right')).toBeVisible();

  const rightAt100 = await paneWidth('#pane-right');
  const leftAt100 = await paneWidth('#pane-left');
  expect(rightAt100).toBeGreaterThan(0);
  expect(await clipped('#pane-right')).toEqual([]);

  // Five steps up (10% each): the panes must grow with their contents, not clip them.
  for (let i = 0; i < 5; i++) await app.run('view.uiScale.increase');
  await app.page.waitForTimeout(300);

  expect(await paneWidth('#pane-right')).toBeGreaterThan(rightAt100 * 1.3);
  expect(await paneWidth('#pane-left')).toBeGreaterThan(leftAt100 * 1.3);
  expect(await clipped('#pane-right')).toEqual([]);

  await app.run('view.uiScale.reset');
  await app.page.waitForTimeout(300);
  expect(await paneWidth('#pane-right')).toBe(rightAt100);
});

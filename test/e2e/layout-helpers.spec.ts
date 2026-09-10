/**
 * The layout assertions, tested against faults (M04).
 *
 * A check that never fires is worth nothing, and three of these can only be *seen* to work by
 * breaking the app on purpose: the whole point of `expectNothingClipped` is that it says
 * something where `toBeVisible()` says nothing. So each helper is given the fault it exists for
 * — injected as a stylesheet, undone straight after — and has to name the element and both
 * numbers in what it says.
 *
 * The faults are the five defects in miniature: content pushed out of its box, chrome laid over
 * the document, a control off the edge of the window, grey text on a dark panel.
 */

import { expect, test, type Locator } from '@playwright/test';
import { launchApp, type App } from './harness';
import {
  expectInsideWindow,
  expectNoOverlap,
  expectNothingClipped,
  expectReadable,
} from './layout';

let app: App;

test.beforeAll(async () => {
  app = await launchApp({ noDemo: true });
});

test.afterAll(async () => {
  await app.close();
});

/** Applies a stylesheet, runs `check`, removes it again, and answers with what `check` said. */
async function withFault(css: string, check: () => Promise<void>): Promise<string> {
  // Tagged rather than kept as a handle, so removing it is one `evaluate` with a typed argument.
  const id = `m04-fault-${String(faults++)}`;
  await app.page.addStyleTag({ content: `/* ${id} */ ${css}` });
  await app.page.evaluate((tag) => {
    const sheet = Array.from(document.querySelectorAll('style')).at(-1);
    if (sheet) sheet.id = tag;
  }, id);
  await app.page.waitForTimeout(150);
  try {
    await check();
    return 'no failure';
  } catch (error) {
    return String(error);
  } finally {
    await app.page.evaluate((tag) => {
      document.getElementById(tag)?.remove();
    }, id);
    await app.page.waitForTimeout(150);
  }
}

let faults = 0;

const body = (): Locator => app.page.locator('body');

test('a sound window passes all four', async () => {
  await expectNothingClipped(body());
  await expectInsideWindow(body());
  await expectReadable(app.page.locator('#statusbar'));
  await expectNoOverlap(app.page.locator('#ribbon'), app.page.locator('#doc-area'));
});

test('expectNothingClipped names what is cut off, and by how much', async () => {
  const said = await withFault('#statusbar { height: 6px; overflow: hidden; }', () =>
    expectNothingClipped(app.page.locator('#statusbar')),
  );
  expect(said).toContain('cut off');
  expect(said).toContain('#statusbar');
  expect(said).toMatch(/scrollHeight \d+ > clientHeight \d+/);
});

test('expectNothingClipped names a scrolling box whose top cannot be reached', async () => {
  // Defect 1 in miniature: centred content in a scrolling box overflows at both ends, and the
  // top slides above the scroll origin where no scrollbar reaches it.
  const said = await withFault(
    '#empty-state { justify-content: center; height: 40px; overflow: auto; }',
    () => expectNothingClipped(app.page.locator('#empty-state')),
  );
  expect(said).toContain('can never be reached');
  expect(said).toContain('#empty-state');
});

test('expectInsideWindow names what has left the window, and which edge', async () => {
  const said = await withFault('#statusbar { position: relative; left: 400px; }', () =>
    expectInsideWindow(app.page.locator('#statusbar')),
  );
  expect(said).toContain('is outside the window');
  expect(said).toContain('#statusbar');
  expect(said).toMatch(/right \d+ > \d+/);
});

test('expectNoOverlap names both boxes and the overlap', async () => {
  const said = await withFault('#ribbon { position: relative; top: 200px; }', () =>
    expectNoOverlap(app.page.locator('#ribbon'), app.page.locator('#doc-area')),
  );
  expect(said).toContain('overlaps');
  expect(said).toMatch(/by \d+x\d+ px/);
});

test('expectReadable names low-contrast text, its ratio and the words', async () => {
  const said = await withFault('#statusbar #status-message { color: #3a3a3a; }', () =>
    expectReadable(app.page.locator('#statusbar')),
  );
  expect(said).toContain('below the contrast floor');
  expect(said).toContain('#status-message');
  expect(said).toMatch(/\d\.\d\d:1 \(needs 4\.5:1\)/);
  expect(said).toContain('Ready');
});

test('expectReadable names translucency, which the modal rule forbids outright', async () => {
  const said = await withFault('#ribbon-tabs { opacity: 0.8; }', () =>
    expectReadable(app.page.locator('#ribbon')),
  );
  expect(said).toContain('is translucent');
  expect(said).toContain('opacity 0.8');
});

test('a deliberate clip is declared with data-allow-clip, and then it is not a defect', async () => {
  const clipped = '#statusbar { height: 6px; overflow: hidden; }';
  expect(
    await withFault(clipped, () => expectNothingClipped(app.page.locator('#statusbar'))),
  ).toContain('cut off');
  await app.page.locator('#statusbar').evaluate((el) => {
    el.setAttribute('data-allow-clip', 'a test');
  });
  expect(await withFault(clipped, () => expectNothingClipped(app.page.locator('#statusbar')))).toBe(
    'no failure',
  );
  await app.page.locator('#statusbar').evaluate((el) => {
    el.removeAttribute('data-allow-clip');
  });
});

test('expectReadable can be asked for the translucency half alone', async () => {
  // Over the document, the colours belong to whoever made the file. The modal rule still does.
  const said = await withFault('#statusbar #status-message { color: #3a3a3a; }', () =>
    expectReadable(app.page.locator('#statusbar'), { contrast: false }),
  );
  expect(said).toBe('no failure');
});

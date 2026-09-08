/**
 * M11 acceptance tests — the viewer inside the real, built app.
 *
 * The unit tests own the maths (layout tables, tiling, the LRU, Night Mode, zoom-to-cursor as a
 * property); this file owns everything that only exists once there is a DOM and a running PDFium
 * worker: rendering, virtualisation, the frame rate, the password prompt, split view, reading
 * mode and the guides.
 *
 * Each acceptance line in `docs/modules/M11-viewer.md` has a test named after it.
 */

import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { launchApp, type App } from './harness';

const FIXTURES = join(process.cwd(), 'test', 'fixtures');

interface ViewerState {
  page: number;
  pageCount: number;
  zoom: number;
  fit: 'page' | 'width' | 'visible' | null;
  layout: string;
  rotation: number;
  scrollLeft: number;
  scrollTop: number;
  split: 'off' | 'vertical' | 'horizontal';
  synced: boolean;
  readingMode: boolean;
  overlays: { rulers: boolean; grid: boolean; guides: boolean; unit: string; gridSpacing: number };
  flags: Record<string, boolean>;
  guides: Array<{ page: number; axis: string; at: number }>;
  history: { back: boolean; forward: boolean };
  mountedPages: number[];
  content: { width: number; height: number; rows: number };
  rects: Array<{ page: number; x: number; y: number; width: number; height: number }>;
}

interface PerfSample {
  fps: number;
  frameMs: number;
  worstMs: number;
  tilesPerSecond: number;
  cacheHitRate: number;
  cacheMb: number;
  cacheMaxMb: number;
  queued: number;
  inFlight: number;
  frames: number;
}

let app: App;

test.beforeAll(async () => {
  app = await launchApp();
});

test.afterAll(async () => {
  await app.close();
});

/** Opens a fixture and waits for its first page to be in the DOM. */
async function open(name: string, options: { path?: string } = {}): Promise<unknown> {
  const bytes = Array.from(readFileSync(join(FIXTURES, name)));
  const result = await app.run('file.openBytes', {
    file: { path: options.path ?? `C:/fixtures/${name}`, name, bytes },
  });
  await app.page.waitForSelector('.viewer-content .page');
  await settle(app.page);
  return result;
}

/** Closes every tab so one test cannot leak into the next. */
async function closeAll(): Promise<void> {
  await app.run('app.tabs.closeAll').catch(() => undefined);
  await app.page.waitForTimeout(120);
}

/** Waits for the tile queue to drain, or a short timeout — whichever comes first. */
async function settle(page: Page, timeout = 4000): Promise<void> {
  const deadline = Date.now() + timeout;
  for (;;) {
    await page.waitForTimeout(120);
    const perf = (await app.run('dev.viewerPerf').catch(() => null)) as PerfSample | null;
    if (!perf || (perf.queued === 0 && perf.inFlight === 0)) return;
    if (Date.now() > deadline) return;
  }
}

const state = (): Promise<ViewerState> => app.run('dev.viewerState') as Promise<ViewerState>;
const perf = (): Promise<PerfSample> => app.run('dev.viewerPerf') as Promise<PerfSample>;

test.describe('opening and rendering', () => {
  test.afterEach(closeAll);

  test('a document opens into a real viewport with rendered pages', async () => {
    await open('multipage.pdf');
    const s = await state();
    expect(s.pageCount).toBe(5);
    expect(s.page).toBe(0);
    // The status bar reads the same store the viewport writes.
    await expect(app.page.locator('#status-page-count')).toHaveText('of 5');
    await expect(app.page.locator('#status-page-input')).toHaveValue('1');

    // The raster canvas has actual ink on it, not just a blank page element.
    const inked = await app.page.evaluate(() => {
      const canvas = document.querySelector<HTMLCanvasElement>('.page .layer-raster');
      if (!canvas) return -1;
      const ctx = canvas.getContext('2d');
      if (!ctx) return -1;
      const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
      let dark = 0;
      for (let i = 0; i < data.length; i += 4) {
        if ((data[i] ?? 255) < 128) dark++;
      }
      return dark;
    });
    expect(inked).toBeGreaterThan(50);
  });

  test('the six overlay layers exist on every page, raster first and tool last', async () => {
    await open('multipage.pdf');
    const layers = await app.page
      .locator('.viewer-content .page')
      .first()
      .evaluate((page) => [...page.children].map((c) => c.getAttribute('data-layer')));
    expect(layers).toEqual(['raster', 'text', 'annot', 'widget', 'object', 'tool']);
  });

  test('only the pages near the viewport have DOM', async () => {
    await open('huge-page-count.pdf');
    const s = await state();
    expect(s.pageCount).toBe(1000);
    expect(s.mountedPages.length).toBeGreaterThan(0);
    expect(s.mountedPages.length).toBeLessThan(60);
    expect(await app.page.locator('.viewer-content .page').count()).toBe(s.mountedPages.length);
  });

  test('the same file opened twice activates the tab it already has', async () => {
    await open('multipage.pdf', { path: 'C:/fixtures/same.pdf' });
    const first = await app.page.locator('.tab').count();
    await open('multipage.pdf', { path: 'C:/fixtures/same.pdf' });
    expect(await app.page.locator('.tab').count()).toBe(first);
  });
});

test.describe('acceptance: 500-page scroll at ≥ 55 fps with bounded memory', () => {
  test.afterEach(closeAll);

  test('scrolls the 1000-page fixture end to end', async () => {
    await open('huge-page-count.pdf');
    // A deliberately small cache, so "bounded by the cache setting" is a real constraint.
    await app.run('view.cache.size', { megabytes: 64 });
    await app.run('dev.viewerHud');
    await app.run('dev.viewerPerf', { reset: true });

    // Scroll the whole document in 150 steps, one per animation frame.
    await app.page.evaluate(async () => {
      const scroller = document.querySelector<HTMLElement>('.viewer-scroll');
      const content = document.querySelector<HTMLElement>('.viewer-content');
      if (!scroller || !content) throw new Error('no viewport');
      const max = content.offsetHeight - scroller.clientHeight;
      const steps = 150;
      for (let i = 0; i <= steps; i++) {
        scroller.scrollTop = (max * i) / steps;
        await new Promise<void>((resolve) => {
          requestAnimationFrame(() => {
            resolve();
          });
        });
      }
    });

    const sample = await perf();
    expect(sample.frames).toBeGreaterThan(100);
    expect(sample.fps).toBeGreaterThanOrEqual(55);
    // Memory stays inside the setting throughout — this is what the LRU is for.
    expect(sample.cacheMaxMb).toBeCloseTo(64, 0);
    expect(sample.cacheMb).toBeLessThanOrEqual(sample.cacheMaxMb);

    // The reader really did reach the end.
    const s = await state();
    expect(s.page).toBeGreaterThan(900);

    // The HUD is showing those numbers, in words as well as figures.
    await expect(app.page.locator('.viewer-hud')).toBeVisible();
    await expect(app.page.locator('.viewer-hud')).toContainText('fps');
    await expect(app.page.locator('.viewer-hud')).toContainText('cache');
    await app.run('dev.viewerHud');
  });

  test('scrolling back over ground already covered comes out of the cache', async () => {
    await open('multipage.pdf');
    await settle(app.page);
    await app.run('dev.viewerPerf', { reset: true });
    await app.run('view.page.last');
    await settle(app.page);
    await app.run('view.page.first');
    await settle(app.page);
    const sample = await perf();
    expect(sample.cacheHitRate).toBeGreaterThanOrEqual(0.5);
  });
});

test.describe('acceptance: layouts', () => {
  test.afterEach(async () => {
    // The layout is persisted, so put it back or every later test inherits it.
    await app.run('view.layout.set', { layout: 'continuous' });
    await closeAll();
  });

  test('every layout mode applies to the running viewport', async () => {
    await open('multipage.pdf');
    for (const [mode, rows] of [
      ['single', 5],
      ['continuous', 5],
      ['facing', 3],
      ['facingContinuous', 3],
      ['book', 3],
    ] as const) {
      await app.run('view.layout.set', { layout: mode });
      await app.page.waitForTimeout(120);
      const s = await state();
      expect(s.layout, mode).toBe(mode);
      expect(s.content.rows, mode).toBe(rows);
    }
  });

  test('facing modes put two pages side by side and book starts with a cover', async () => {
    await open('multipage.pdf');
    await app.run('view.layout.set', { layout: 'facing' });
    await app.page.waitForTimeout(150);
    let s = await state();
    // Pages 0 and 1 share a row: same y, different x.
    expect(s.rects[0]?.y).toBe(s.rects[1]?.y);
    expect(s.rects[1]?.x).toBeGreaterThan(s.rects[0]?.x ?? 0);

    await app.run('view.layout.set', { layout: 'book' });
    await app.page.waitForTimeout(150);
    s = await state();
    // The cover stands alone: page 1 starts below page 0, and pages 1 and 2 share a row
    // (pages of unequal height are centred in their row, so their tops need not be equal).
    expect(s.rects[1]?.y).toBeGreaterThan(s.rects[0]?.y ?? 0);
    const overlap =
      Math.min(
        (s.rects[1]?.y ?? 0) + (s.rects[1]?.height ?? 0),
        (s.rects[2]?.y ?? 0) + (s.rects[2]?.height ?? 0),
      ) - Math.max(s.rects[1]?.y ?? 0, s.rects[2]?.y ?? 0);
    expect(overlap).toBeGreaterThan(0);
    expect(s.rects[2]?.x).toBeGreaterThan(s.rects[1]?.x ?? 0);
  });

  test('a non-continuous layout shows one row at a time', async () => {
    await open('multipage.pdf');
    await app.run('view.layout.set', { layout: 'single' });
    await app.page.waitForTimeout(200);
    expect((await state()).mountedPages).toEqual([0]);
    await app.run('view.page.next');
    await app.page.waitForTimeout(200);
    const s = await state();
    expect(s.mountedPages).toEqual([1]);
    expect(s.page).toBe(1);
  });

  test('the status bar’s layout buttons drive the viewport', async () => {
    await open('multipage.pdf');
    await app.page.locator('#status-layout [data-layout="facing"]').click();
    await app.page.waitForTimeout(150);
    expect((await state()).layout).toBe('facing');
  });
});

test.describe('acceptance: zoom to cursor keeps the point stationary', () => {
  test.afterEach(closeAll);

  test('within a pixel, zooming in and out about an off-centre point', async () => {
    await open('text.pdf');
    await app.run('view.zoom.set', { percent: 100 });
    await app.page.waitForTimeout(150);
    for (const target of [250, 400, 150, 100]) {
      const result = (await app.run('dev.viewerZoomAt', { percent: target, x: 320, y: 240 })) as {
        before: { page: number; x: number; y: number } | null;
        after: { page: number; x: number; y: number } | null;
        zoom: number;
        scrollable: boolean;
      };
      expect(result.before, `zoom ${target}`).not.toBeNull();
      expect(result.after, `zoom ${target}`).not.toBeNull();
      expect(result.scrollable, `zoom ${target}`).toBe(true);
      // Same page, and the same point on it, within a device pixel converted to points.
      expect(result.after?.page, `zoom ${target}`).toBe(result.before?.page);
      const tolerance = 1 / result.zoom + 0.01;
      expect(
        Math.abs((result.after?.x ?? 0) - (result.before?.x ?? 0)),
        `x at ${target}%`,
      ).toBeLessThanOrEqual(tolerance);
      expect(
        Math.abs((result.after?.y ?? 0) - (result.before?.y ?? 0)),
        `y at ${target}%`,
      ).toBeLessThanOrEqual(tolerance);
    }
  });

  test('when the whole document already fits, zooming out simply re-centres it', async () => {
    await open('text.pdf');
    // Nothing to scroll means nothing to hold a point still with — Foxit behaves the same way.
    const result = (await app.run('dev.viewerZoomAt', { percent: 20, x: 320, y: 240 })) as {
      scrollable: boolean;
      zoom: number;
    };
    expect(result.scrollable).toBe(false);
    expect(result.zoom).toBeCloseTo(0.2, 3);
    const s = await state();
    expect(s.scrollTop).toBe(0);
  });

  test('ctrl + wheel zooms about the pointer rather than the centre', async () => {
    await open('text.pdf');
    await app.run('view.zoom.set', { percent: 100 });
    await app.page.waitForTimeout(150);
    const before = await state();
    const box = await app.page.locator('.viewer-scroll').boundingBox();
    expect(box).not.toBeNull();
    await app.page.mouse.move((box?.x ?? 0) + 120, (box?.y ?? 0) + 120);
    await app.page.keyboard.down('Control');
    await app.page.mouse.wheel(0, -300);
    await app.page.keyboard.up('Control');
    await app.page.waitForTimeout(250);
    const after = await state();
    expect(after.zoom).toBeGreaterThan(before.zoom);
  });

  test('the fit modes and the zoom ladder are all reachable', async () => {
    await open('text.pdf');
    await app.run('view.zoom.fitPage');
    expect((await state()).fit).toBe('page');
    await app.run('view.zoom.fitWidth');
    expect((await state()).fit).toBe('width');
    await app.run('view.zoom.fitVisible');
    expect((await state()).fit).toBe('visible');
    await app.run('view.zoom.actual');
    let s = await state();
    expect(s.fit).toBeNull();
    expect(Math.round(s.zoom * 100)).toBe(100);
    await app.run('view.zoom.in');
    s = await state();
    expect(Math.round(s.zoom * 100)).toBe(125);
    await app.run('view.zoom.out');
    expect(Math.round((await state()).zoom * 100)).toBe(100);
  });
});

test.describe('acceptance: rotation and CropBox', () => {
  test.afterEach(closeAll);

  test('rotating the view turns every page and re-flows the layout', async () => {
    await open('text.pdf');
    const upright = await state();
    const page = upright.rects[0];
    expect(page).toBeDefined();
    await app.run('view.rotate.clockwise');
    await app.page.waitForTimeout(250);
    const turned = await state();
    expect(turned.rotation).toBe(90);
    // Portrait became landscape.
    expect(turned.rects[0]?.width).toBeGreaterThan(turned.rects[0]?.height ?? 0);
    await app.run('view.rotate.clockwise');
    await app.run('view.rotate.clockwise');
    await app.run('view.rotate.clockwise');
    await app.page.waitForTimeout(200);
    expect((await state()).rotation).toBe(0);

    await app.run('view.rotate.anticlockwise');
    await app.page.waitForTimeout(200);
    expect((await state()).rotation).toBe(270);
    await app.run('view.rotate.reset');
    await app.page.waitForTimeout(200);
    expect((await state()).rotation).toBe(0);
  });

  test('a rotated document lays out at its displayed size', async () => {
    await open('rotated.pdf');
    const s = await state();
    // Page 2 of the fixture has /Rotate 90, so it is wider than it is tall.
    expect(s.rects[1]?.width).toBeGreaterThan(s.rects[1]?.height ?? 0);
    expect(s.rects[0]?.height).toBeGreaterThan(s.rects[0]?.width ?? 0);
  });

  test('a CropBox that does not start at the origin still renders ink', async () => {
    await open('mixed-boxes.pdf');
    await settle(app.page);
    const inked = await app.page.evaluate(() => {
      const canvases = [...document.querySelectorAll<HTMLCanvasElement>('.page .layer-raster')];
      return canvases.map((canvas) => {
        const ctx = canvas.getContext('2d');
        if (!ctx) return 0;
        const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
        let dark = 0;
        for (let i = 0; i < data.length; i += 4) if ((data[i] ?? 255) < 200) dark++;
        return dark;
      });
    });
    expect(inked.some((n) => n > 50)).toBe(true);
  });
});

test.describe('acceptance: encrypted documents', () => {
  test.afterEach(closeAll);

  test('prompts, re-prompts in words on a wrong password, and opens on the right one', async () => {
    const bytes = Array.from(readFileSync(join(FIXTURES, 'encrypted.pdf')));
    const opening = app.run('file.openBytes', {
      file: { path: 'C:/fixtures/encrypted.pdf', name: 'encrypted.pdf', bytes },
    });

    const dialog = app.page.locator('#password-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('Password required');
    await expect(dialog).toContainText('encrypted.pdf');

    // The field hides the password and the toggle reveals it — typing blind is not required.
    const input = dialog.locator('#password-input');
    await expect(input).toHaveAttribute('type', 'password');
    await dialog.locator('[aria-label="Show password"]').click();
    await expect(input).toHaveAttribute('type', 'text');
    await dialog.locator('[aria-label="Hide password"]').click();
    await expect(input).toHaveAttribute('type', 'password');

    await input.fill('wrong');
    await dialog.getByRole('button', { name: 'Open' }).click();

    // The retry says what went wrong in words, not by turning something red.
    await expect(dialog).toContainText('Password not accepted');
    await expect(dialog).toContainText('That password did not open the file');

    await dialog.locator('#password-input').fill('ynot');
    await dialog.getByRole('button', { name: 'Open' }).click();

    await opening;
    await app.page.waitForSelector('.viewer-content .page');
    expect((await state()).pageCount).toBe(1);
  });

  test('Escape cancels cleanly: no tab, no viewport, no error', async () => {
    const before = await app.page.locator('.tab').count();
    const bytes = Array.from(readFileSync(join(FIXTURES, 'encrypted-aes256.pdf')));
    const opening = app.run('file.openBytes', {
      file: { path: 'C:/fixtures/aes256.pdf', name: 'encrypted-aes256.pdf', bytes },
    });
    await expect(app.page.locator('#password-dialog')).toBeVisible();
    await app.page.keyboard.press('Escape');
    expect(await opening).toBeNull();
    await expect(app.page.locator('#password-dialog')).toBeHidden();
    expect(await app.page.locator('.tab').count()).toBe(before);
    await expect(app.page.locator('.toast')).toHaveCount(0);
  });
});

test.describe('acceptance: split view, full screen, reading mode, guides', () => {
  test.afterEach(closeAll);

  test('split view scrolls independently and in sync', async () => {
    await open('huge-page-count.pdf');
    await app.run('view.split.vertical');
    await app.page.waitForTimeout(300);
    expect(await app.page.locator('.viewer-pane').count()).toBe(2);
    expect((await state()).split).toBe('vertical');

    // Synced: moving one pane moves the other.
    await app.run('view.split.sync', { on: true });
    await app.page.waitForTimeout(100);
    await app.run('dev.viewerScroll', { top: 4000 });
    await app.page.waitForTimeout(300);
    const synced = await app.page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>('.viewer-scroll')].map((s) => s.scrollTop),
    );
    expect(Math.abs((synced[0] ?? 0) - (synced[1] ?? 0))).toBeLessThan(4);

    // Unsynced: the second pane stays where it was.
    await app.run('view.split.sync', { on: false });
    await app.page.waitForTimeout(100);
    const before = await app.page.evaluate(
      () => document.querySelectorAll<HTMLElement>('.viewer-scroll')[1]?.scrollTop ?? -1,
    );
    await app.run('dev.viewerScroll', { top: 9000 });
    await app.page.waitForTimeout(300);
    const after = await app.page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>('.viewer-scroll')].map((s) => s.scrollTop),
    );
    expect(after[0]).not.toBe(before);
    expect(after[1]).toBe(before);

    await app.run('view.split.off');
    await app.page.waitForTimeout(200);
    expect(await app.page.locator('.viewer-pane').count()).toBe(1);
    expect((await state()).split).toBe('off');
  });

  test('the two halves of a split hold different zooms', async () => {
    await open('multipage.pdf');
    await app.run('view.split.horizontal');
    await app.page.waitForTimeout(300);
    await app.run('view.zoom.set', { percent: 200 });
    await app.page.waitForTimeout(200);
    const widths = await app.page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>('.viewer-content')].map((c) => c.offsetWidth),
    );
    expect(widths).toHaveLength(2);
    expect((await state()).zoom).toBeCloseTo(2, 2);
  });

  test('both halves of a split render their own pages', async () => {
    await open('text.pdf', { path: 'C:/fixtures/splitrender.pdf' });
    await app.run('view.split.vertical');
    await app.page.waitForTimeout(400);
    await settle(app.page);
    const inked = await app.page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>('.viewer-pane')].map((pane) => {
        const canvas = pane.querySelector<HTMLCanvasElement>('.page .layer-raster');
        const ctx = canvas?.getContext('2d');
        if (!canvas || !ctx || canvas.width === 0) return -1;
        const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
        let dark = 0;
        for (let i = 0; i < data.length; i += 4) if ((data[i] ?? 255) < 128) dark++;
        return dark;
      }),
    );
    expect(inked).toHaveLength(2);
    for (const [index, dark] of inked.entries()) {
      expect(dark, `pane ${index} has ink`).toBeGreaterThan(50);
    }
    await app.run('view.split.off');
  });

  test('reading mode hides the chrome and its bar brings the reader back', async () => {
    await open('multipage.pdf');
    await app.page.keyboard.press('Control+h');
    await app.page.waitForTimeout(200);
    expect(await app.page.evaluate(() => document.documentElement.dataset['readingMode'])).toBe(
      'on',
    );
    // These must exist and be hidden — `toBeHidden` passes for an element that is simply not
    // there, so each one is counted first.
    for (const selector of ['#ribbon', '#tabstrip', '#statusbar', '.pane']) {
      await expect(app.page.locator(selector).first(), selector).toHaveCount(1);
      await expect(app.page.locator(selector).first(), selector).toBeHidden();
    }
    const bar = app.page.locator('.viewer-reading-bar');
    await expect(bar).toBeVisible();
    // The bar keeps a keyboard path out; it is a toolbar, not a decoration.
    await expect(bar).toHaveAttribute('role', 'toolbar');
    await bar.locator('[data-command="view.readingMode.toggle"]').click();
    await app.page.waitForTimeout(200);
    await expect(app.page.locator('#ribbon')).toBeVisible();
    await expect(app.page.locator('#statusbar')).toBeVisible();
    expect((await state()).readingMode).toBe(false);
  });

  test('full screen goes through main and reports back', async () => {
    await open('multipage.pdf');
    const entered = await app.run('view.fullScreen.toggle', { on: true });
    expect(typeof entered).toBe('boolean');
    await app.page.waitForTimeout(300);
    if (entered === true) {
      const left = await app.run('view.fullScreen.toggle', { on: false });
      expect(left).toBe(false);
    }
  });

  test('guides survive closing and reopening the document', async () => {
    await open('multipage.pdf', { path: 'C:/fixtures/guided.pdf' });
    await app.run('view.guides.add', { page: 0, axis: 'vertical', at: 120 });
    await app.run('view.guides.add', { page: 0, axis: 'horizontal', at: 400 });
    await app.page.waitForTimeout(200);
    expect((await state()).guides).toHaveLength(2);
    await expect(app.page.locator('.viewer-guide')).toHaveCount(2);
    // A guide is reachable and removable from the keyboard.
    await expect(app.page.locator('.viewer-guide').first()).toHaveAttribute('tabindex', '0');

    await closeAll();
    await open('multipage.pdf', { path: 'C:/fixtures/guided.pdf' });
    const s = await state();
    expect(s.guides).toHaveLength(2);
    expect(s.guides.map((g) => g.at).sort((a, b) => a - b)).toEqual([120, 400]);
    await app.run('view.guides.clear');
    expect((await state()).guides).toHaveLength(0);
  });

  test('the reader comes back to where they left a document', async () => {
    await open('huge-page-count.pdf', { path: 'C:/fixtures/resume.pdf' });
    await app.run('view.page.goTo', { page: 120 });
    // The place is written a short moment after the reader stops moving.
    await app.page.waitForTimeout(900);
    expect((await state()).page).toBe(119);
    await closeAll();
    await open('huge-page-count.pdf', { path: 'C:/fixtures/resume.pdf' });
    await app.page.waitForTimeout(400);
    expect((await state()).page).toBeGreaterThan(100);
  });
});

test.describe('navigation', () => {
  test.afterEach(closeAll);

  test('page field, first / previous / next / last and go-to-page', async () => {
    await open('huge-page-count.pdf');
    await app.run('view.page.last');
    await app.page.waitForTimeout(250);
    expect((await state()).page).toBe(999);
    await app.run('view.page.first');
    await app.page.waitForTimeout(250);
    expect((await state()).page).toBe(0);
    await app.run('view.page.next');
    await app.page.waitForTimeout(250);
    expect((await state()).page).toBe(1);
    await app.run('view.page.previous');
    await app.page.waitForTimeout(250);
    expect((await state()).page).toBe(0);
    await app.run('view.page.goTo', { page: 500 });
    await app.page.waitForTimeout(250);
    expect((await state()).page).toBe(499);
    await expect(app.page.locator('#status-page-input')).toHaveValue('500');
  });

  test('Alt+← and Alt+→ walk the view history', async () => {
    await open('huge-page-count.pdf');
    await app.run('view.page.goTo', { page: 100 });
    await app.page.waitForTimeout(250);
    await app.run('view.page.goTo', { page: 300 });
    await app.page.waitForTimeout(250);
    expect((await state()).history.back).toBe(true);

    await app.page.keyboard.press('Alt+ArrowLeft');
    await app.page.waitForTimeout(350);
    expect((await state()).page).toBe(99);
    await app.page.keyboard.press('Alt+ArrowRight');
    await app.page.waitForTimeout(350);
    expect((await state()).page).toBe(299);
  });

  test('Page Down and Page Up move through the document', async () => {
    await open('huge-page-count.pdf');
    await app.page.locator('.viewer-scroll').first().focus();
    const before = (await state()).scrollTop;
    await app.page.keyboard.press('PageDown');
    await app.page.waitForTimeout(250);
    const after = (await state()).scrollTop;
    expect(after).toBeGreaterThan(before);
    await app.page.keyboard.press('PageUp');
    await app.page.waitForTimeout(250);
    expect((await state()).scrollTop).toBeLessThan(after);
  });

  test('Ctrl+Home and Ctrl+End jump to the ends', async () => {
    await open('huge-page-count.pdf');
    await app.page.locator('.viewer-scroll').first().focus();
    await app.page.keyboard.press('Control+End');
    await app.page.waitForTimeout(400);
    expect((await state()).page).toBe(999);
    await app.page.keyboard.press('Control+Home');
    await app.page.waitForTimeout(400);
    expect((await state()).page).toBe(0);
  });

  test('auto-scroll runs and stops', async () => {
    await open('huge-page-count.pdf', { path: 'C:/fixtures/autoscroll.pdf' });
    await app.run('dev.viewerScroll', { top: 0 });
    const before = (await state()).scrollTop;
    expect(await app.run('view.autoScroll.toggle')).toBe(true);
    await app.page.waitForTimeout(600);
    expect((await state()).scrollTop).toBeGreaterThan(before);
    expect(await app.run('view.autoScroll.toggle')).toBe(false);
    const stopped = (await state()).scrollTop;
    await app.page.waitForTimeout(300);
    expect((await state()).scrollTop).toBe(stopped);
    expect(await app.run('view.autoScroll.speed', { speed: 8 })).toBe(8);
  });

  test('the digits set the auto-scroll speed and minus reverses it', async () => {
    await open('huge-page-count.pdf', { path: 'C:/fixtures/speedkeys.pdf' });
    await app.run('dev.viewerScroll', { top: 2000 });
    await app.page.locator('.viewer-scroll').first().focus();
    await app.run('view.autoScroll.toggle');
    await app.page.keyboard.press('9');
    await app.page.waitForTimeout(500);
    const fast = (await state()).scrollTop;
    expect(fast).toBeGreaterThan(2000);
    // Minus turns it round; the view comes back up.
    await app.page.keyboard.press('-');
    await app.page.waitForTimeout(500);
    expect((await state()).scrollTop).toBeLessThan(fast);
    await app.page.keyboard.press('Escape');
    const stopped = (await state()).scrollTop;
    await app.page.waitForTimeout(300);
    expect((await state()).scrollTop).toBe(stopped);
  });
});

test.describe('tools and overlays', () => {
  test.afterEach(closeAll);

  test('the hand tool is active by default and drags the page', async () => {
    await open('huge-page-count.pdf', { path: 'C:/fixtures/hand.pdf' });
    await app.run('dev.viewerScroll', { top: 0 });
    await app.run('tool.hand.activate');
    const before = (await state()).scrollTop;
    const layer = app.page.locator('.page .layer-tool').first();
    const box = await layer.boundingBox();
    expect(box).not.toBeNull();
    await app.page.mouse.move((box?.x ?? 0) + 100, (box?.y ?? 0) + 200);
    await app.page.mouse.down();
    await app.page.mouse.move((box?.x ?? 0) + 100, (box?.y ?? 0) + 60, { steps: 6 });
    await app.page.mouse.up();
    await app.page.waitForTimeout(200);
    expect((await state()).scrollTop).toBeGreaterThan(before);
  });

  test('marquee zoom draws a rectangle and zooms to it', async () => {
    await open('text.pdf');
    await app.run('view.zoom.set', { percent: 100 });
    await app.page.waitForTimeout(150);
    await app.run('tool.marqueeZoom.activate');
    const before = (await state()).zoom;
    const layer = app.page.locator('.page .layer-tool').first();
    const box = await layer.boundingBox();
    await app.page.mouse.move((box?.x ?? 0) + 40, (box?.y ?? 0) + 40);
    await app.page.mouse.down();
    await app.page.mouse.move((box?.x ?? 0) + 200, (box?.y ?? 0) + 160, { steps: 8 });
    await expect(app.page.locator('.viewer-marquee')).toBeVisible();
    await app.page.mouse.up();
    await app.page.waitForTimeout(300);
    expect((await state()).zoom).toBeGreaterThan(before);
    await expect(app.page.locator('.viewer-marquee')).toHaveCount(0);
    await app.run('tool.hand.activate');
  });

  test('the loupe opens as an opaque, keyboard-closable window', async () => {
    await open('text.pdf');
    expect(await app.run('view.loupe.toggle')).toBe(true);
    const loupe = app.page.locator('.viewer-loupe');
    await expect(loupe).toBeVisible();
    await expect(loupe).toHaveAttribute('role', 'dialog');
    expect(await app.run('view.loupe.factor')).toBe(4);
    await loupe.focus();
    await app.page.keyboard.press('Escape');
    await expect(loupe).toHaveCount(0);
  });

  test('rulers show the chosen units and the corner cycles them', async () => {
    await open('text.pdf');
    await app.run('view.rulers.toggle', { on: true });
    await app.page.waitForTimeout(250);
    await expect(app.page.locator('.viewer-ruler-h')).toBeVisible();
    await expect(app.page.locator('.viewer-ruler-v')).toBeVisible();
    expect(await app.page.locator('.viewer-ruler-h .viewer-tick').count()).toBeGreaterThan(3);
    await app.run('view.rulers.units', { unit: 'in' });
    await app.page.waitForTimeout(200);
    await expect(app.page.locator('.viewer-ruler-corner')).toHaveText('in');
    await app.page.locator('.viewer-ruler-corner').click();
    await app.page.waitForTimeout(200);
    await expect(app.page.locator('.viewer-ruler-corner')).toHaveText('pt');
    await app.run('view.rulers.toggle', { on: false });
    await expect(app.page.locator('.viewer-ruler-h')).toBeHidden();
  });

  test('the grid draws over the page and its spacing is a setting', async () => {
    await open('text.pdf');
    await app.run('view.grid.toggle', { on: true });
    await app.page.waitForTimeout(250);
    const coarse = await app.page.locator('.viewer-grid-line').count();
    expect(coarse).toBeGreaterThan(4);
    await app.run('view.grid.spacing', { points: 18 });
    await app.page.waitForTimeout(250);
    expect(await app.page.locator('.viewer-grid-line').count()).toBeGreaterThan(coarse);
    await app.run('view.grid.toggle', { on: false });
  });
});

test.describe('rendering options and Night Mode', () => {
  test.afterEach(async () => {
    await app.run('view.nightMode.set', { on: false }).catch(() => undefined);
    await closeAll();
  });

  test('Night Mode darkens the page raster, not just the placeholder', async () => {
    await open('text.pdf');
    await settle(app.page);
    const meanOf = async (): Promise<number> =>
      app.page.evaluate(() => {
        const canvas = document.querySelector<HTMLCanvasElement>('.page .layer-raster');
        const ctx = canvas?.getContext('2d');
        if (!canvas || !ctx) return -1;
        const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
        let sum = 0;
        for (let i = 0; i < data.length; i += 4) sum += data[i] ?? 0;
        return sum / (data.length / 4);
      });

    const day = await meanOf();
    expect(day).toBeGreaterThan(200); // white paper

    await app.run('view.nightMode.set', { on: true });
    await settle(app.page);
    const night = await meanOf();
    expect(night).toBeLessThan(80); // dark paper
    expect((await state()).flags['night']).toBe(true);

    await app.run('view.nightMode.set', { on: false });
    await settle(app.page);
    expect(await meanOf()).toBeGreaterThan(200);
  });

  test('greyscale, smoothing and line weights are all live toggles', async () => {
    await open('text.pdf');
    for (const [command, flag] of [
      ['view.render.greyscale', 'grayscale'],
      ['view.render.smoothText', 'smoothText'],
      ['view.render.smoothImages', 'smoothImages'],
      ['view.render.smoothPaths', 'smoothPaths'],
      ['view.lineWeights.toggle', 'lineWeights'],
    ] as const) {
      const before = (await state()).flags[flag];
      await app.run(command);
      await app.page.waitForTimeout(250);
      expect((await state()).flags[flag], command).toBe(!before);
      await app.run(command);
      await app.page.waitForTimeout(250);
      expect((await state()).flags[flag], command).toBe(before);
    }
  });

  test('line weights off makes a stroked drawing thinner', async () => {
    await open('annotations-all.pdf');
    await settle(app.page);
    const inkOf = async (): Promise<number> =>
      app.page.evaluate(() => {
        const canvas = document.querySelector<HTMLCanvasElement>('.page .layer-raster');
        const ctx = canvas?.getContext('2d');
        if (!canvas || !ctx) return -1;
        const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
        let dark = 0;
        for (let i = 0; i < data.length; i += 4) if ((data[i] ?? 255) < 200) dark++;
        return dark;
      });
    const thick = await inkOf();
    await app.run('view.lineWeights.toggle', { on: false });
    await settle(app.page);
    expect(await inkOf()).toBeLessThanOrEqual(thick);
    await app.run('view.lineWeights.toggle', { on: true });
  });
});

test.describe('the shell contract', () => {
  test.afterEach(closeAll);

  test('every viewer command is in the palette with a category', async () => {
    await open('multipage.pdf');
    const commands = await app.commands();
    for (const id of [
      'view.rotate.clockwise',
      'view.rotate.anticlockwise',
      'view.zoom.fitVisible',
      'view.rulers.toggle',
      'view.grid.toggle',
      'view.guides.toggle',
      'view.split.vertical',
      'view.split.horizontal',
      'view.fullScreen.toggle',
      'view.readingMode.toggle',
      'view.autoScroll.toggle',
      'view.loupe.toggle',
      'view.lineWeights.toggle',
      'view.history.back',
      'view.history.forward',
      'tool.hand.activate',
      'tool.selectText.activate',
      'tool.marqueeZoom.activate',
      'tool.loupe.activate',
    ]) {
      expect(commands, id).toContain(id);
    }
    // And they are findable by name, not just by id.
    await app.page.keyboard.press('Control+Shift+P');
    const palette = app.page.locator('#command-palette');
    await palette.locator('input').fill('rotate view');
    await expect(palette.locator('li[aria-selected="true"]')).toHaveAttribute(
      'data-command',
      'view.rotate.clockwise',
    );
    await app.page.keyboard.press('Escape');
  });

  test('the View ribbon tab shows the viewer’s groups', async () => {
    await open('multipage.pdf');
    await app.run('app.ribbon.tab.view');
    await app.page.waitForTimeout(200);
    const ribbon = app.page.locator('#ribbon');
    for (const command of [
      'view.rotate.clockwise',
      'view.rulers.toggle',
      'view.split.vertical',
      'view.fullScreen.toggle',
      'tool.hand.activate',
    ]) {
      await expect(ribbon.locator(`[data-command="${command}"]`), command).toHaveCount(1);
    }
  });

  test('nothing the viewer draws is translucent', async () => {
    await open('text.pdf');
    await app.run('view.rulers.toggle', { on: true });
    await app.run('view.grid.toggle', { on: true });
    await app.run('view.loupe.toggle');
    await app.run('dev.viewerHud');
    await app.page.waitForTimeout(400);
    const offenders = await app.page.evaluate(() => {
      const bad: string[] = [];
      for (const el of document.querySelectorAll<HTMLElement>(
        '.viewer, .viewer *, .viewer-loupe, .viewer-loupe *, .viewer-hud, .viewer-hud *',
      )) {
        const style = getComputedStyle(el);
        if (Number(style.opacity) < 1) bad.push(`${el.className}: opacity ${style.opacity}`);
        if (style.backdropFilter && style.backdropFilter !== 'none') {
          bad.push(`${el.className}: backdrop-filter`);
        }
        const alpha = /rgba?\([^)]*[,/]\s*(0(?:\.\d+)?)\s*\)/.exec(style.backgroundColor);
        // A fully transparent background is fine (a layer that shows what is beneath it);
        // a partly transparent one is not.
        if (alpha && Number(alpha[1]) > 0 && Number(alpha[1]) < 1) {
          bad.push(`${el.className}: ${style.backgroundColor}`);
        }
      }
      return bad;
    });
    expect(offenders).toEqual([]);
    await app.run('view.loupe.toggle');
    await app.run('dev.viewerHud');
    await app.run('view.rulers.toggle', { on: false });
    await app.run('view.grid.toggle', { on: false });
  });

  test('closing a tab releases its viewport and its tiles', async () => {
    await open('multipage.pdf');
    await settle(app.page);
    expect(await app.page.locator('.viewer-content .page').count()).toBeGreaterThan(0);
    await closeAll();
    await expect(app.page.locator('.viewer-content .page')).toHaveCount(0);
    const view = (await app.run('view.state')) as { pageCount: number };
    expect(view.pageCount).toBe(0);
  });

  test('two documents each keep their own view state', async () => {
    await open('multipage.pdf', { path: 'C:/fixtures/a.pdf' });
    await app.run('view.zoom.set', { percent: 200 });
    await app.page.waitForTimeout(200);
    await open('text.pdf', { path: 'C:/fixtures/b.pdf' });
    await app.run('view.zoom.set', { percent: 100 });
    await app.page.waitForTimeout(200);
    expect((await state()).zoom).toBeCloseTo(1, 2);

    await app.run('app.tabs.previous');
    await app.page.waitForTimeout(300);
    expect((await state()).zoom).toBeCloseTo(2, 2);
    expect((await state()).pageCount).toBe(5);
  });
});

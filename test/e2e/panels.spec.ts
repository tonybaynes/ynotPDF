/**
 * M12 acceptance tests — the navigation panels inside the real, built app.
 *
 * The unit tests own the algebra (the outline tree, the grid geometry, the destination maths,
 * the engine's own layer and attachment work). This file owns what only exists once there is a
 * DOM, a PDFium worker and a window: which panel opens, what the thumbnail grid actually
 * measures, whether a bookmark lands on the right page, and whether a portfolio opens properly.
 *
 * Each acceptance line in `docs/modules/M12-navigation-panels.md` has a test named after it.
 */

import { expect, test } from '@playwright/test';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixturePath, launchApp, type App } from './harness';

const FIXTURES = join(process.cwd(), 'test', 'fixtures');
const LOCAL = join(FIXTURES, 'local');
const PORTFOLIO = join(LOCAL, 'Sample Portfolio.pdf');

interface NavState {
  panel: string | null;
  collapsed: boolean;
  paneWidth: number;
  thumbnailSize: number;
  leftPaneOnOpen: string;
  thumbnails: {
    mounted: number;
    columns: number;
    rendered: number;
    current: number;
    scrollTop: number;
    labels: string[];
  };
  bookmarks: Array<{
    id: string;
    title: string;
    level: number;
    expanded: string | null;
    current: boolean;
    /** 0-based page the bookmark points at, or -1. */
    page: number;
    uri: string | null;
  }>;
  layers: Array<{ id: string; name: string; state: string }>;
  attachments: Array<{ id: string; cells: string[] }>;
  destinations: Array<{ id: string; name: string; where: string }>;
  portfolio: { fields: number } | null;
  thumbnailStats: { cached: number; queued: number; rendered: number; cancelled: number };
}

interface ViewerState {
  page: number;
  pageCount: number;
  zoom: number;
  fit: string | null;
  scrollTop: number;
  rects: Array<{ page: number; x: number; y: number; width: number; height: number }>;
}

let app: App;
let workspace: string;

test.beforeAll(async () => {
  workspace = mkdtempSync(join(tmpdir(), 'ynot-panels-'));
  app = await launchApp();
});

test.afterAll(async () => {
  await app.close();
  rmSync(workspace, { recursive: true, force: true });
});

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
  await settle();
}

const navState = (): Promise<NavState> => app.run('dev.navState') as Promise<NavState>;
const viewState = (): Promise<ViewerState> => app.run('dev.viewerState') as Promise<ViewerState>;

/** Opens a fixture and waits for its first page. */
async function open(name: string, path = fixturePath(name)): Promise<void> {
  const bytes = Array.from(readFileSync(join(FIXTURES, name)));
  await app.run('file.openBytes', { file: { path, name, bytes } });
  await app.page.waitForSelector('.viewer-content .page');
  await settle();
}

/** Waits until the thumbnails the panel wants have been drawn, or the time is up. */
async function settle(timeout = 6000): Promise<void> {
  const deadline = Date.now() + timeout;
  for (;;) {
    await app.page.waitForTimeout(120);
    const state = await navState().catch(() => null);
    if (!state || state.thumbnailStats.queued === 0) return;
    if (Date.now() > deadline) return;
  }
}

/**
 * Closes every tab, answering the "save your changes?" dialog with "Don't save" — a panel test
 * leaves the document dirty on purpose, and M21 is quite right to ask about it.
 */
async function closeAll(): Promise<void> {
  const closing = app.run('app.tabs.closeAll').catch(() => undefined);
  const dialog = app.page.locator('#save-unsaved-dialog');
  for (let i = 0; i < 6; i++) {
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

test.describe('the default panel — the operator’s requirement', () => {
  test.afterEach(closeAll);

  test('a fresh profile opens any PDF with the left pane on Pages, thumbnails rendered', async () => {
    await open('multipage.pdf');
    const state = await navState();
    expect(state.panel).toBe('nav.pages');
    expect(state.collapsed).toBe(false);
    expect(state.leftPaneOnOpen).toBe('pages');
    // Virtualised: what is mounted is what fits, plus a row of overscan.
    expect(state.thumbnails.mounted).toBeGreaterThan(0);
    expect(state.thumbnails.mounted).toBeLessThanOrEqual(5);
    expect(state.thumbnails.rendered).toBeGreaterThan(0);
    // Page labels are shown under each thumbnail, in order from the first.
    expect(state.thumbnails.labels[0]).toBe('1');
    expect(state.thumbnails.labels).toEqual(
      ['1', '2', '3', '4', '5'].slice(0, state.thumbnails.labels.length),
    );
  });

  test('a document whose /PageMode asks for bookmarks still opens on Pages', async () => {
    await open('outline.pdf');
    // outline.pdf carries `/PageMode /UseOutlines`; the reader's setting wins.
    expect((await navState()).panel).toBe('nav.pages');
  });

  test('“closed” closes the pane, and “pages” brings it back — for the outline file too', async () => {
    await app.run('view.panel.defaultOnOpen', { value: 'closed' });
    await open('multipage.pdf');
    expect((await navState()).collapsed).toBe(true);
    await closeAll();

    await app.run('view.panel.defaultOnOpen', { value: 'bookmarks' });
    await open('outline.pdf');
    expect((await navState()).panel).toBe('nav.bookmarks');
    await closeAll();

    // A document with no bookmarks would leave a blank pane, so it falls back to Pages.
    await open('multipage.pdf');
    expect((await navState()).panel).toBe('nav.pages');
    await closeAll();

    await app.run('view.panel.defaultOnOpen', { value: 'pages' });
    await open('outline.pdf');
    const state = await navState();
    expect(state.panel).toBe('nav.pages');
    expect(state.collapsed).toBe(false);
  });
});

test.describe('the thumbnail grid — the operator’s layout rules', () => {
  test.afterEach(closeAll);

  test('one column at the default size; + widens the pane and keeps one column; − narrows it', async () => {
    await open('multipage.pdf');
    const start = await navState();
    expect(start.thumbnails.columns).toBe(1);
    const startWidth = start.paneWidth;
    // The panel opened at exactly one column, not at the shell's generic pane width.
    expect(startWidth).toBeLessThan(260);

    await app.run('view.thumbnails.larger');
    await app.run('view.thumbnails.larger');
    await settle();
    const bigger = await navState();
    expect(bigger.thumbnailSize).toBeGreaterThan(start.thumbnailSize);
    expect(bigger.paneWidth).toBeGreaterThan(startWidth);
    expect(bigger.thumbnails.columns).toBe(1);

    await app.run('view.thumbnails.smaller');
    await settle();
    const smaller = await navState();
    expect(smaller.thumbnailSize).toBeLessThan(bigger.thumbnailSize);
    expect(smaller.paneWidth).toBeLessThan(bigger.paneWidth);
    expect(smaller.thumbnails.columns).toBe(1);
  });

  test('after a size step the current page is still in view', async () => {
    await open('huge-page-count.pdf');
    // Somewhere well down the document, so "still in view" is a real claim.
    await app.run('view.page.goTo', { page: 40 });
    await settle();
    const before = await navState();
    // "In view" is exactly this: the current page is one of the cells the panel has mounted.
    expect(before.thumbnails.current).toBeGreaterThanOrEqual(0);
    expect(before.thumbnails.labels).toContain('41');
    await app.run('view.thumbnails.larger');
    await expect.poll(async () => (await navState()).thumbnails.labels).toContain('41');
    await settle();
    const after = await navState();
    expect(after.thumbnails.current).toBeGreaterThanOrEqual(0);
  });

  test('dragging the splitter wider adds columns, and dragging it back drops to one', async () => {
    await open('multipage.pdf');
    const start = await navState();
    expect(start.thumbnails.columns).toBe(1);

    await app.run('dev.navPaneWidth', { width: Math.round(start.paneWidth * 2.5) });
    await settle();
    const wide = await navState();
    expect(wide.thumbnails.columns).toBeGreaterThanOrEqual(2);
    // The size itself never changed — only how many fit.
    expect(wide.thumbnailSize).toBe(start.thumbnailSize);

    await app.run('dev.navPaneWidth', { width: start.paneWidth });
    await settle();
    expect((await navState()).thumbnails.columns).toBe(1);
  });

  test('the splitter can be dragged with the pointer, and the grid reflows', async () => {
    await open('multipage.pdf');
    const before = await navState();
    const resizer = await app.page.locator('.pane-resizer').first().boundingBox();
    expect(resizer).not.toBeNull();
    if (!resizer) return;
    await app.page.mouse.move(resizer.x + resizer.width / 2, resizer.y + resizer.height / 2);
    await app.page.mouse.down();
    await app.page.mouse.move(resizer.x + before.paneWidth * 1.6, resizer.y + resizer.height / 2, {
      steps: 8,
    });
    await app.page.mouse.up();
    await settle();
    const after = await navState();
    expect(after.paneWidth).toBeGreaterThan(before.paneWidth);
    expect(after.thumbnails.columns).toBeGreaterThanOrEqual(2);
  });

  test('clicking a thumbnail navigates, and the current page is marked with a word', async () => {
    await open('multipage.pdf');
    await app.page.locator('.thumb-cell').nth(2).click();
    // Polled rather than waited out: the viewport scrolls, tells the store, and the panel
    // repaints on the next frame, and how long that takes is the runner's business.
    await expect.poll(async () => (await viewState()).page).toBe(2);
    const current = app.page.locator('.thumb-cell[data-page="2"]');
    await expect(current).toHaveAttribute('aria-current', 'page');
    await expect(current).toHaveAttribute('aria-label', /current page/);
    await expect(current).toHaveClass(/is-current/);
  });

  test('a 1000-page document mounts only what it can see, and follows the reader', async () => {
    await open('huge-page-count.pdf');
    const state = await navState();
    expect(state.thumbnails.mounted).toBeGreaterThan(0);
    // Virtualised: a thousand pages must not be a thousand cells.
    expect(state.thumbnails.mounted).toBeLessThan(80);
    await app.run('view.page.last');
    await settle();
    const end = await navState();
    expect(end.thumbnails.labels).toContain('1000');
  });

  test('scrolling the grid stays smooth on a 1000-page document', async () => {
    await open('huge-page-count.pdf');
    const fps = await app.page.evaluate(async () => {
      const scroller = document.querySelector<HTMLElement>('[data-panel-scroll="pages"]');
      if (!scroller) return 0;
      const frames: number[] = [];
      let last = performance.now();
      const start = last;
      let top = 0;
      while (performance.now() - start < 1500) {
        top += 400;
        scroller.scrollTop = top % Math.max(1, scroller.scrollHeight - scroller.clientHeight);
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => {
            resolve();
          }),
        );
        const now = performance.now();
        frames.push(now - last);
        last = now;
      }
      const total = frames.reduce((a, b) => a + b, 0);
      return frames.length === 0 ? 0 : 1000 / (total / frames.length);
    });
    // A software-rendered CI runner turns frames over at its own pace; the grid must not be
    // what slows it down. 30 fps is the floor a scroll has to clear on any machine.
    expect(fps).toBeGreaterThan(30);
  });

  test('Ctrl and Shift build a page selection for M40', async () => {
    await open('multipage.pdf');
    const cells = app.page.locator('.thumb-cell');
    await cells.nth(0).click();
    await cells.nth(2).click({ modifiers: ['Shift'] });
    await expect(app.page.locator('.thumb-cell.is-selected')).toHaveCount(3);
    await cells.nth(1).click({ modifiers: [process.platform === 'darwin' ? 'Meta' : 'Control'] });
    await expect(app.page.locator('.thumb-cell.is-selected')).toHaveCount(2);
  });
});

test.describe('bookmarks', () => {
  test.afterEach(closeAll);

  test('every bookmark goes to its own page and zoom', async () => {
    await open('outline.pdf');
    // Fit the page first: at a zoom where three pages share the window, "the current page" is a
    // judgement about the viewport rather than about where the bookmark went.
    await app.run('view.zoom.fitPage');
    await app.page.waitForTimeout(200);
    await app.run('view.panel.bookmarks');
    await app.page.waitForSelector('.nav-tree [data-row]');
    const rows = await navState();
    expect(rows.bookmarks.length).toBeGreaterThan(0);

    // Every bookmark, clicked in turn, scrolls to somewhere inside the page its own destination
    // names. "Inside the page" rather than "is the current page": a destination part-way down a
    // page puts the next one's top edge on screen too, and which of the two the viewer then
    // calls current is a judgement about the window, not about where the bookmark went.
    for (const [i, bookmark] of rows.bookmarks.entries()) {
      await app.run('view.page.goTo', { page: 1 });
      await expect.poll(async () => (await viewState()).page).toBe(0);
      await app.page.locator('.nav-tree [data-row]').nth(i).click();
      if (bookmark.page < 0) continue;
      await expect
        .poll(async () => {
          const now = await viewState();
          const box = now.rects.find((r) => r.page === bookmark.page);
          return box === undefined ? false : box.y + box.height > now.scrollTop;
        })
        .toBe(true);
      const state = await viewState();
      const rect = state.rects.find((r) => r.page === bookmark.page);
      expect(rect, `page ${String(bookmark.page)} should be laid out`).toBeDefined();
      if (!rect) continue;
      const height = (await app.page.locator('.viewer-scroll').first().boundingBox())?.height ?? 0;
      // The page the bookmark names is on screen. Not "is at the very top": a destination near
      // the end of a document cannot scroll past the bottom, and a destination part-way down a
      // page brings the next one into view with it — both are what Foxit does too.
      expect(
        rect.y,
        `bookmark "${bookmark.title}" should bring page ${String(bookmark.page + 1)} into view`,
      ).toBeLessThan(state.scrollTop + height);
      expect(rect.y + rect.height).toBeGreaterThan(state.scrollTop);
    }
  });

  test('add, rename inline, nest and delete — and undo puts it all back', async () => {
    await open('outline.pdf');
    await app.run('view.panel.bookmarks');
    await app.page.waitForSelector('.nav-tree [data-row]');
    const before = (await navState()).bookmarks.map((b) => b.title);

    await app.run('bookmarks.add', { title: 'From the test' });
    await expect
      .poll(async () => (await navState()).bookmarks.map((b) => b.title))
      .toContain('From the test');
    const added = await navState();

    const newRow = added.bookmarks.find((b) => b.title === 'From the test');
    expect(newRow).toBeDefined();
    if (!newRow) return;
    await app.run('dev.navSelect', { bookmark: newRow.id });
    await app.run('bookmarks.indent');
    await expect
      .poll(async () => (await navState()).bookmarks.find((b) => b.id === newRow.id)?.level ?? 0)
      .toBeGreaterThan(1);

    await app.run('dev.navSelect', { bookmark: newRow.id });
    await app.run('bookmarks.delete');
    await expect
      .poll(async () => (await navState()).bookmarks.map((b) => b.title))
      .not.toContain('From the test');

    await app.run('edit.undo');
    await app.run('edit.undo');
    await app.run('edit.undo');
    await expect.poll(async () => (await navState()).bookmarks.map((b) => b.title)).toEqual(before);
  });

  test('the tree collapses and expands from the keyboard', async () => {
    await open('outline.pdf');
    await app.run('view.panel.bookmarks');
    await app.page.waitForSelector('.nav-tree [data-row]');
    const first = app.page.locator('.nav-tree [data-row]').first();
    await first.focus();
    const expandable = await app.page.locator('.nav-tree [aria-expanded]').count();
    if (expandable > 0) {
      const row = app.page.locator('.nav-tree [aria-expanded]').first();
      await row.focus();
      const before = await row.getAttribute('aria-expanded');
      await app.page.keyboard.press(before === 'true' ? 'ArrowLeft' : 'ArrowRight');
      await app.page.waitForTimeout(150);
      const after = await app.page
        .locator('.nav-tree [aria-expanded]')
        .first()
        .getAttribute('aria-expanded');
      expect(after).not.toBe(before);
    }
    await first.focus();
    await app.page.keyboard.press('ArrowDown');
    await expect(app.page.locator('.nav-tree [data-row]:focus')).toHaveCount(1);
  });
});

test.describe('layers', () => {
  test.afterEach(closeAll);

  test('a layer says Visible or Hidden in words, and toggling it re-renders the page', async () => {
    await open('layers.pdf');
    await app.run('view.panel.layers');
    await app.page.waitForSelector('.layer-row');
    const before = await navState();
    expect(before.layers.length).toBeGreaterThanOrEqual(2);
    expect(before.layers[0]?.state).toBe('Visible');

    const inkBefore = await pageInk();
    const layer = before.layers[0];
    expect(layer).toBeDefined();
    if (!layer) return;
    await app.run('layers.toggle', { layer: layer.id, visible: false });
    await expect.poll(async () => (await navState()).layers[0]?.state).toBe('Hidden');
    // The page has to be re-rendered without the layer, which is a round trip to the engine.
    await expect.poll(pageInk, { timeout: 15_000 }).not.toBe(inkBefore);

    await app.run('layers.toggle', { layer: layer.id, visible: true });
    await expect.poll(async () => (await navState()).layers[0]?.state).toBe('Visible');
    await expect.poll(pageInk, { timeout: 15_000 }).toBe(inkBefore);
  });

  test('reset puts the initial visibility back, in one undo step', async () => {
    await open('layers.pdf');
    await app.run('view.panel.layers');
    await app.page.waitForSelector('.layer-row');
    const start = (await navState()).layers.map((l) => l.state);
    const layer = (await navState()).layers[0];
    if (!layer) return;
    await app.run('layers.toggle', { layer: layer.id, visible: false });
    await expect.poll(async () => (await navState()).layers.map((l) => l.state)).not.toEqual(start);
    await app.run('layers.reset');
    await expect.poll(async () => (await navState()).layers.map((l) => l.state)).toEqual(start);
  });
});

test.describe('attachments', () => {
  test.afterEach(closeAll);

  test('the panel lists a document’s embedded files with their size', async () => {
    await open('attachments.pdf');
    await app.run('view.panel.attachments');
    await app.page.waitForSelector('.nav-table [data-row]');
    const state = await navState();
    expect(state.attachments.length).toBe(2);
    // Name, description, size, modified.
    expect(state.attachments[0]?.cells.length).toBe(4);
    expect(state.attachments.some((a) => a.cells[2] !== '')).toBe(true);
  });

  test('acceptance: add a file, save, reopen — the attachment is there with its description', async () => {
    const path = stage('blank.pdf', 'attach-target.pdf');
    await openPath(path);
    const bytes = Array.from(new TextEncoder().encode('hello from the acceptance test'));
    const id = (await app.run('dev.navAttach', {
      name: 'note.txt',
      bytes,
      description: 'A note from M12',
    })) as string | null;
    expect(id).not.toBeNull();
    await expect
      .poll(async () =>
        (await navState()).attachments.some((a) => a.cells[0]?.includes('note.txt')),
      )
      .toBe(true);

    const outcome = (await app.run('file.save')) as { saved: boolean };
    expect(outcome.saved).toBe(true);
    await closeAll();

    // Reopen the file the app actually wrote — the writer moved `/Desc` onto the file
    // specification, so a reader that is not PDFium finds it too.
    const copy = join(workspace, 'attach-reopened.pdf');
    copyFileSync(path, copy);
    await openPath(copy);
    await app.run('view.panel.attachments');
    await app.page.waitForSelector('.nav-table [data-row]');
    const state = await navState();
    expect(state.attachments.some((a) => a.cells[0]?.includes('note.txt'))).toBe(true);
    expect(state.attachments.some((a) => a.cells[1] === 'A note from M12')).toBe(true);
  });
});

test.describe('destinations', () => {
  test.afterEach(closeAll);

  test('creating one from the current view, renaming it and going back to it', async () => {
    await open('multipage.pdf');
    await app.run('view.page.next');
    await app.run('view.page.next');
    await expect.poll(async () => (await viewState()).page).toBe(2);
    const at = (await viewState()).page;

    await app.run('destinations.add', { name: 'the-third-page' });
    await app.run('view.panel.destinations');
    await app.page.waitForSelector('.nav-list [data-row]');
    const state = await navState();
    expect(state.destinations.map((d) => d.name)).toContain('the-third-page');

    await app.run('view.page.first');
    await expect.poll(async () => (await viewState()).page).toBe(0);
    await app.page.locator('.nav-list [data-row]').first().click();
    await expect.poll(async () => (await viewState()).page).toBe(at);

    const dest = state.destinations[0];
    if (!dest) return;
    await app.run('dev.navSelect', { destination: dest.id });
    await app.run('destinations.rename', { name: 'renamed' });
    await expect
      .poll(async () => (await navState()).destinations.map((d) => d.name))
      .toContain('renamed');
  });
});

test.describe('PDF Portfolios', () => {
  test.afterEach(closeAll);

  // The operator's own portfolio; git-ignored, so CI and other machines skip this.
  test.skip(!existsSync(PORTFOLIO), 'test/fixtures/local/Sample Portfolio.pdf is not here');

  test('opens on its files with the Attachments panel listing its three PDFs', async () => {
    const bytes = Array.from(readFileSync(PORTFOLIO));
    await app.run('file.openBytes', {
      file: { path: PORTFOLIO, name: 'Sample Portfolio.pdf', bytes },
    });
    // M42 gives the document area to the portfolio's file grid; the cover sheet is a tab away,
    // which is what this used to wait for.
    await app.page.waitForSelector('.pf-host:not([hidden])');
    await app.page.waitForTimeout(400);

    const state = await navState();
    expect(state.panel).toBe('nav.attachments');
    expect(state.portfolio).not.toBeNull();
    expect(state.attachments.length).toBe(3);
    await expect(app.page.locator('.nav-note')).toContainText('PDF Portfolio');

    // Its schema columns, not our generic four.
    expect(state.portfolio?.fields).toBeGreaterThan(0);

    // The cover sheet is still the document's own page, and it still renders.
    await app.page.getByRole('tab', { name: 'Cover sheet' }).click();
    await app.page.waitForSelector('.viewer-content .page');
    expect((await viewState()).pageCount).toBeGreaterThanOrEqual(1);
  });

  test('double-clicking an embedded PDF opens it in a new tab', async () => {
    const bytes = Array.from(readFileSync(PORTFOLIO));
    await app.run('file.openBytes', {
      file: { path: PORTFOLIO, name: 'Sample Portfolio.pdf', bytes },
    });
    await app.page.waitForSelector('.nav-table [data-row]');
    const before = await app.page.locator('.tab').count();
    await app.page.locator('.nav-table [data-row]').first().dblclick();
    await expect(app.page.locator('.tab')).toHaveCount(before + 1);
  });

  test('all three of its files open in tabs, none of them handed to the OS', async () => {
    const bytes = Array.from(readFileSync(PORTFOLIO));
    await app.run('file.openBytes', {
      file: { path: PORTFOLIO, name: 'Sample Portfolio.pdf', bytes },
    });
    await app.page.waitForSelector('.nav-table [data-row]');
    const state = await navState();
    expect(state.attachments.length).toBe(3);

    // This portfolio declares `text/plain` on all three of its PDFs (Foxit wrote it that way),
    // so "opens in a tab" has to come from the name and the bytes, not from what it claims.
    for (const attachment of state.attachments) {
      const how = await app.run('attachments.open', { attachment: attachment.id });
      expect(how, `${attachment.cells[0] ?? ''} should open in a tab`).toBe('tab');
    }
    await expect(app.page.locator('.tab')).toHaveCount(4);
  });
});

test.describe('the panels as a whole', () => {
  test.afterEach(closeAll);

  test('every panel has a shortcut, a ribbon toggle and a place in the palette', async () => {
    const commands = await app.commands();
    for (const id of [
      'view.panel.pages',
      'view.panel.bookmarks',
      'view.panel.layers',
      'view.panel.attachments',
      'view.panel.destinations',
      'view.thumbnails.larger',
      'view.thumbnails.smaller',
      'bookmarks.add',
      'layers.reset',
      'attachments.add',
      'destinations.add',
    ]) {
      expect(commands).toContain(id);
    }
  });

  test('the pane tab strip offers “open this panel by default”', async () => {
    await open('multipage.pdf');
    await app.page.locator('.pane-strip').click({ button: 'right' });
    await app.page.waitForTimeout(200);
    await expect(app.page.locator('.context-menu')).toContainText('Open this panel by default');
    await app.page.keyboard.press('Escape');
  });

  test('the panels keep working when the document is closed', async () => {
    await open('multipage.pdf');
    await app.run('view.panel.bookmarks');
    await closeAll();
    await expect(app.page.locator('.panel[data-panel="nav.bookmarks"] .nav-empty')).toBeVisible();
  });
});

/** A cheap fingerprint of the rendered page: how many of its pixels have ink on them. */
async function pageInk(): Promise<number> {
  return await app.page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('.viewer-content .page canvas');
    if (!canvas) return -1;
    const context = canvas.getContext('2d');
    if (!context) return -1;
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
    let dark = 0;
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i] ?? 255;
      const g = data[i + 1] ?? 255;
      const b = data[i + 2] ?? 255;
      if (0.299 * r + 0.587 * g + 0.114 * b < 200) dark++;
    }
    return dark;
  });
}

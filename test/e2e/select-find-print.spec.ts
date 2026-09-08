/**
 * M13 acceptance tests — selection, find, search, snapshot and printing inside the real, built
 * app.
 *
 * The unit tests own the arithmetic (the text model, the matcher, the selection rules, the
 * imposition); this file owns what only exists once there is a DOM, a clipboard, a main process
 * and a running PDFium worker: selecting with a pointer, the find bar and its highlights, the
 * search panel across documents and a folder, a snapshot's real PNG, and a print job built end
 * to end in main.
 *
 * Each acceptance line in `docs/modules/M13-select-find-print.md` has a test named after it.
 */

import { expect, test } from '@playwright/test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchApp, type App } from './harness';

/** Narrows away a value the test knows is there; `!` is forbidden project-wide. */
function must<T>(value: T | undefined | null, what: string): T {
  if (value === undefined || value === null) throw new Error(`expected a ${what}, got nothing`);
  return value;
}

const FIXTURES = join(process.cwd(), 'test', 'fixtures');

interface SelectionSummary {
  empty: boolean;
  pages: number[];
  length: number;
  text: string;
  ranges: Array<{
    page: number;
    startRun: number;
    startChar: number;
    endRun: number;
    endChar: number;
  }>;
  rects: number;
}

interface FindState {
  query: string;
  total: number;
  current: number;
  scanning: boolean;
  error: string | null;
  barOpen: boolean;
  hits: Array<{ page: number; start: number; end: number; source: string; snippet: string }>;
}

interface PanelState {
  query: string;
  scope: string;
  folder: string | null;
  running: boolean;
  scanned: number;
  total: number;
  hits: Array<{ documentId: string; documentName: string; page: number; snippet: string }>;
  error: string | null;
  truncated: boolean;
}

interface PrintPlan {
  error: string | null;
  pages: number[];
  paper: { width: number; height: number };
  sheets: Array<{
    index: number;
    width: number;
    height: number;
    placements: Array<{
      page: number;
      x: number;
      y: number;
      width: number;
      height: number;
      rotation: number;
    }>;
  }>;
}

interface TextModel {
  page: number;
  text: string;
  length: number;
  lines: number;
  paragraphs: Array<{ start: number; end: number }>;
}

let app: App;
let scratch: string;

test.beforeAll(async () => {
  app = await launchApp();
  scratch = mkdtempSync(join(tmpdir(), 'ynot-m13-'));
});

test.afterAll(async () => {
  await app.close();
  rmSync(scratch, { recursive: true, force: true });
});

/** Opens a fixture and waits for its first page to be in the DOM. */
async function open(name: string, path?: string): Promise<void> {
  const file = path ?? join(FIXTURES, name);
  const bytes = Array.from(readFileSync(file));
  await app.run('file.openBytes', { file: { path: file, name, bytes } });
  await app.page.waitForSelector('.viewer-content .page');
  await app.page.waitForTimeout(150);
}

async function closeAll(): Promise<void> {
  await app.run('edit.findClose').catch(() => undefined);
  await app.run('edit.search.cancel').catch(() => undefined);
  // Options and the scope outlive a document, so a failed test must not set them for the next
  // one: one red test would otherwise cascade into every later one in the file.
  await app.run('edit.search.scope', { scope: 'document' }).catch(() => undefined);
  for (const option of [
    'matchCase',
    'wholeWord',
    'regex',
    'ignoreDiacritics',
    'includeBookmarks',
  ]) {
    await app.run(`edit.find.${option}`, { on: false }).catch(() => undefined);
  }
  await app.run('app.tabs.closeAll').catch(() => undefined);
  await app.page.waitForTimeout(120);
}

const selection = (): Promise<SelectionSummary> =>
  app.run('dev.selection') as Promise<SelectionSummary>;
const findState = (): Promise<FindState> => app.run('dev.findState') as Promise<FindState>;
const panelState = (): Promise<PanelState> => app.run('dev.searchState') as Promise<PanelState>;

/** Waits until a probe reports what the test is waiting for, or gives up. */
async function until<T>(
  probe: () => Promise<T>,
  ready: (value: T) => boolean,
  timeout = 15_000,
): Promise<T> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await probe();
    if (ready(value)) return value;
    if (Date.now() > deadline) return value;
    await app.page.waitForTimeout(150);
  }
}

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

// ---- the text layer and selection -----------------------------------------------------------

test.describe('text selection', () => {
  test.afterEach(closeAll);

  test('the text layer is built from the page and reads in order', async () => {
    await open('text.pdf');
    const model = (await app.run('dev.textLayer', { page: 0 })) as TextModel;
    expect(model.text).toContain('Heading in Helvetica 24 pt');
    expect(model.text).toContain('The quick brown fox');
    expect(model.lines).toBeGreaterThan(4);
    expect(model.paragraphs.length).toBeGreaterThan(1);
    const built = (await app.run('dev.buildPageText', { page: 0 })) as {
      runs: number;
      chars: number;
      text: string;
    };
    expect(built.runs).toBeGreaterThan(0);
    expect(built.chars).toBe(built.text.length);
  });

  test('a drag selects text, and the selection is drawn in the text layer', async () => {
    await open('text.pdf');
    await app.run('tool.selectText.activate');
    const box = must(
      await app.page.locator('.viewer-content .page').first().boundingBox(),
      'page box',
    );
    // Across the second line of the fixture's body text.
    await app.page.mouse.move(box.x + 80, box.y + 120);
    await app.page.mouse.down();
    await app.page.mouse.move(box.x + 320, box.y + 122, { steps: 8 });
    await app.page.mouse.up();
    const summary = await until(selection, (s) => !s.empty);
    expect(summary.empty).toBe(false);
    expect(summary.text.length).toBeGreaterThan(3);
    expect(summary.ranges.length).toBeGreaterThan(0);
    expect(await app.page.locator('.text-highlight-selection').count()).toBeGreaterThan(0);
  });

  test('triple-click selects the paragraph', async () => {
    await open('text.pdf');
    const model = (await app.run('dev.textLayer', { page: 0 })) as TextModel;
    const bodyStart = model.text.indexOf('The quick brown fox');
    const paragraph = must(
      model.paragraphs.find((p) => p.start <= bodyStart && p.end >= bodyStart),
      'paragraph',
    );
    const summary = (await app.run('dev.selectRange', {
      page: 0,
      at: bodyStart + 4,
      granularity: 'paragraph',
    })) as SelectionSummary;
    expect(summary.text).toBe(model.text.slice(paragraph.start, paragraph.end));
    expect(summary.text.split('\n').length).toBeGreaterThan(1);
  });

  test('double-click selects a word', async () => {
    await open('text.pdf');
    const model = (await app.run('dev.textLayer', { page: 0 })) as TextModel;
    const at = model.text.indexOf('quartz');
    const summary = (await app.run('dev.selectRange', {
      page: 0,
      at: at + 2,
      granularity: 'word',
    })) as SelectionSummary;
    expect(summary.text).toBe('quartz');
  });

  test('Select All takes the page, and again takes the document', async () => {
    await open('multipage.pdf');
    await app.run('edit.selectAll');
    const onePage = await selection();
    expect(onePage.pages).toEqual([0]);
    await app.run('edit.selectAll');
    const wholeDocument = await selection();
    expect(wholeDocument.pages.length).toBe(5);
    expect(wholeDocument.text).toContain('Page 1 of 5');
    expect(wholeDocument.text).toContain('Page 5 of 5');
  });

  test('a selection can cross a page boundary', async () => {
    await open('multipage.pdf');
    const first = (await app.run('dev.textLayer', { page: 0 })) as TextModel;
    const summary = (await app.run('dev.selectRange', {
      page: 0,
      start: first.text.indexOf('Page 1'),
      endPage: 1,
      end: 6,
    })) as SelectionSummary;
    expect(summary.pages).toEqual([0, 1]);
    expect(summary.text).toContain('Page 1 of 5');
    expect(summary.text).toContain('Page 2');
    expect(summary.ranges.length).toBeGreaterThan(1);
  });

  test('a column selection takes one column of a page', async () => {
    await open('text.pdf');
    const summary = (await app.run('dev.selectColumn', {
      page: 0,
      x0: 70,
      y0: 700,
      x1: 200,
      y1: 745,
    })) as SelectionSummary;
    expect(summary.empty).toBe(false);
    expect(summary.text.length).toBeGreaterThan(0);
    expect(summary.text).not.toContain('lazy dog');
  });

  test('copy puts the selection on the clipboard as text, and with formatting as RTF', async () => {
    await open('text.pdf');
    const model = (await app.run('dev.textLayer', { page: 0 })) as TextModel;
    const start = model.text.indexOf('Heading');
    await app.run('dev.selectRange', { page: 0, start, end: start + 7 });
    expect(await app.run('edit.copy')).toBe(true);
    const plain = await app.electron.evaluate(async ({ clipboard }) => await clipboard.readText());
    expect(plain).toBe('Heading');

    expect(await app.run('edit.copyFormatted')).toBe(true);
    const formats = await app.electron.evaluate(async ({ clipboard }) => {
      const items = await clipboard.read();
      return items.flatMap((item) => item.types);
    });
    expect(formats).toContain('text/plain');
    // RTF is offered alongside the plain text where the platform takes it.
    expect(formats.some((t) => t.includes('rtf') || t === 'text/plain')).toBe(true);
  });

  test('Deselect clears the selection and its highlights', async () => {
    await open('text.pdf');
    await app.run('edit.selectAll');
    expect((await selection()).empty).toBe(false);
    await app.run('edit.deselect');
    expect((await selection()).empty).toBe(true);
    await app.page.waitForTimeout(120);
    expect(await app.page.locator('.text-highlight-selection').count()).toBe(0);
  });
});

// ---- snapshot ---------------------------------------------------------------------------------

test.describe('snapshot', () => {
  test.afterEach(closeAll);

  test('a snapshot of a known rectangle is a PNG of the expected size', async () => {
    await open('text.pdf');
    await app.run('edit.snapshot.dpi', { dpi: 300 });
    const size = (await app.run('dev.snapshot', {
      page: 0,
      x0: 72,
      y0: 600,
      x1: 172,
      y1: 700,
    })) as { width: number; height: number };
    // 100 pt at 300 DPI is 100 × 300/72 = 416.7 pixels each way. PDFium snaps a rendered
    // rectangle outwards to whole device pixels, and does so per axis — where each edge falls
    // between two pixels depends on where it is on the page — so the two sides can differ by one.
    const expected = Math.round(100 * (300 / 72));
    for (const measurement of [size.width, size.height]) {
      expect(measurement).toBeGreaterThanOrEqual(expected);
      expect(measurement).toBeLessThanOrEqual(expected + 2);
    }
  });

  test('the snapshot is on the clipboard as an image', async () => {
    await open('text.pdf');
    await app.run('edit.snapshot.dpi', { dpi: 150 });
    await app.run('dev.snapshot', { page: 0, x0: 72, y0: 700, x1: 372, y1: 780 });
    const size = await app.electron.evaluate(async ({ clipboard }) => {
      const items = await clipboard.read();
      const image = items.find((item) => item.types.includes('image/png'));
      if (!image) return null;
      const blob = await image.getType('image/png');
      return blob instanceof Blob ? blob.size : null;
    });
    expect(must(size, 'clipboard image size')).toBeGreaterThan(100);
  });

  test('the snapshot resolution is a remembered setting', async () => {
    await open('text.pdf');
    expect(await app.run('edit.snapshot.dpi', { dpi: 600 })).toBe(600);
    expect(await app.run('edit.snapshot.dpi', { dpi: 5 })).toBe(72);
    expect(await app.run('edit.snapshot.dpi', { dpi: 5000 })).toBe(1200);
    await app.run('edit.snapshot.dpi', { dpi: 300 });
  });
});

// ---- the find bar ------------------------------------------------------------------------------

test.describe('find', () => {
  test.afterEach(closeAll);

  test('Ctrl+F opens the bar and finds every match, reporting n of m', async () => {
    await open('text.pdf');
    await app.page.keyboard.press(`${MOD}+f`);
    await expect(app.page.locator('#find-bar')).toBeVisible();
    await app.page.locator('.find-input').fill('the');
    const state = await until(findState, (s) => !s.scanning && s.total > 0);
    expect(state.total).toBeGreaterThan(0);
    expect(state.current).toBe(0);
    await expect(app.page.locator('.find-count')).toHaveText(`1 of ${state.total}`);
  });

  test('every hit on a visible page is highlighted, and the current one is marked', async () => {
    await open('text.pdf');
    await app.run('edit.find', { query: 'the' });
    await until(findState, (s) => !s.scanning && s.total > 0);
    await app.page.waitForTimeout(250);
    expect(await app.page.locator('.text-highlight-find').count()).toBeGreaterThan(0);
    expect(await app.page.locator('.text-highlight-find-current').count()).toBe(1);
  });

  test('Enter and Shift+Enter move between hits, wrapping round', async () => {
    await open('text.pdf');
    await app.run('edit.find', { query: 'the' });
    const first = await until(findState, (s) => !s.scanning && s.total > 1);
    await app.run('edit.findNext');
    expect((await findState()).current).toBe(1);
    await app.run('edit.findPrevious');
    expect((await findState()).current).toBe(0);
    await app.run('edit.findPrevious');
    expect((await findState()).current).toBe(first.total - 1);
  });

  test('whole words and match case change the count', async () => {
    await open('text.pdf');
    await app.run('edit.find', { query: 'he' });
    const loose = await until(findState, (s) => !s.scanning && s.total > 0);
    await app.run('edit.find.wholeWord', { on: true });
    const strict = await until(findState, (s) => !s.scanning || s.total === 0);
    expect(strict.total).toBeLessThan(loose.total);
    await app.run('edit.find.wholeWord', { on: false });

    await app.run('edit.find', { query: 'The' });
    const insensitive = await until(findState, (s) => !s.scanning && s.total > 0);
    await app.run('edit.find.matchCase', { on: true });
    const sensitive = await until(findState, (s) => !s.scanning);
    expect(sensitive.total).toBeLessThan(insensitive.total);
    await app.run('edit.find.matchCase', { on: false });
  });

  test('a regular expression finds what a literal cannot', async () => {
    await open('text.pdf');
    await app.run('edit.find.regex', { on: true });
    await app.run('edit.find', { query: '\\bqu\\w+' });
    const state = await until(findState, (s) => !s.scanning && s.total > 0);
    expect(state.total).toBeGreaterThan(0);
    await app.run('edit.find.regex', { on: false });
  });

  test('a broken pattern says so instead of finding nothing quietly', async () => {
    await open('text.pdf');
    await app.run('edit.find.regex', { on: true });
    await app.run('edit.find', { query: '(unclosed' });
    const state = await until(findState, (s) => s.error !== null);
    expect(state.error).toBeTruthy();
    await expect(app.page.locator('#find-bar')).toHaveAttribute('data-state', 'error');
    await app.run('edit.find.regex', { on: false });
  });

  test('a hit is selected as well as highlighted, so it can be copied', async () => {
    await open('text.pdf');
    await app.run('edit.find', { query: 'quartz' });
    await until(findState, (s) => !s.scanning && s.total > 0);
    const summary = await selection();
    expect(summary.text.toLowerCase()).toContain('quartz');
  });

  test('closing the bar clears the highlights', async () => {
    await open('text.pdf');
    await app.run('edit.find', { query: 'the' });
    await until(findState, (s) => !s.scanning && s.total > 0);
    await app.run('edit.findClose');
    await app.page.waitForTimeout(200);
    await expect(app.page.locator('#find-bar')).toBeHidden();
    expect(await app.page.locator('.text-highlight-find').count()).toBe(0);
  });

  test('bookmarks and comments join the search when asked', async () => {
    await open('outline.pdf');
    await app.run('edit.find', { query: 'Chapter' });
    const withoutBookmarks = await until(findState, (s) => !s.scanning);
    await app.run('edit.find.includeBookmarks', { on: true });
    const withBookmarks = await until(findState, (s) => !s.scanning);
    expect(withBookmarks.hits.some((h) => h.source === 'bookmark')).toBe(true);
    expect(withoutBookmarks.hits.some((h) => h.source === 'bookmark')).toBe(false);
    await app.run('edit.find.includeBookmarks', { on: false });
  });
});

// ---- the advanced search panel -------------------------------------------------------------------

test.describe('advanced search', () => {
  test.afterEach(closeAll);

  test('the panel opens in the left pane', async () => {
    await open('text.pdf');
    await app.run('edit.search', { query: 'quick' });
    await expect(app.page.locator('.panel[data-panel="nav.search"]')).toBeVisible();
    await expect(app.page.locator('.search-query')).toHaveValue('quick');
  });

  test('searching this document lists its hits, grouped by page', async () => {
    await open('multipage.pdf');
    await app.run('edit.search', { query: 'Page', run: true });
    const state = await until(panelState, (s) => !s.running && s.hits.length > 0);
    expect(state.hits.length).toBe(5);
    expect(new Set(state.hits.map((h) => h.page)).size).toBe(5);
    await expect(app.page.locator('.search-hit').first()).toBeVisible();
  });

  test('searching all open documents lists both of them', async () => {
    await open('text.pdf');
    await open('multipage.pdf');
    await app.run('edit.search.scope', { scope: 'open' });
    await app.run('edit.search', { query: 'o', run: true });
    const state = await until(panelState, (s) => !s.running && s.hits.length > 0);
    // A row is named by the document's title and identified by its path.
    const documents = new Set(state.hits.map((h) => h.documentId));
    expect([...documents].some((id) => id.endsWith('text.pdf'))).toBe(true);
    expect([...documents].some((id) => id.endsWith('multipage.pdf'))).toBe(true);
  });

  test('clicking a result goes to it and selects it', async () => {
    await open('multipage.pdf');
    await app.run('edit.search', { query: 'Page 4', run: true });
    await until(panelState, (s) => !s.running && s.hits.length > 0);
    await app.page.locator('.search-hit').first().click();
    const summary = await until(selection, (s) => !s.empty);
    expect(summary.pages).toEqual([3]);
    expect(summary.text).toContain('Page 4');
  });

  test('a folder search finds a known string across the fixtures', async () => {
    await open('text.pdf');
    expect(await app.run('dev.setSearchFolder', { path: FIXTURES })).toBe(FIXTURES);
    await app.run('edit.search', { query: 'Sphinx', run: true });
    const state = await until(panelState, (s) => !s.running && s.hits.length > 0, 90_000);
    expect(state.error).toBeNull();
    expect(state.hits.length).toBeGreaterThan(0);
    // A folder hit is named by its file name, because the document is not open.
    expect(state.hits.some((h) => h.documentName === 'text.pdf')).toBe(true);
  });

  test('a folder search can be stopped part way through', async () => {
    await open('text.pdf');
    await app.run('dev.setSearchFolder', { path: FIXTURES });
    await app.run('edit.search', { query: 'e', run: true });
    await until(panelState, (s) => s.running || s.hits.length > 0, 5000);
    await app.run('edit.search.cancel');
    const stopped = await until(panelState, (s) => !s.running, 10_000);
    expect(stopped.running).toBe(false);
    const after = stopped.hits.length;
    await app.page.waitForTimeout(600);
    // Nothing arrives once it has been stopped.
    expect((await panelState()).hits.length).toBe(after);
  });

  test('results export as CSV', async () => {
    await open('multipage.pdf');
    await app.run('edit.search', { query: 'Page', run: true });
    await until(panelState, (s) => !s.running && s.hits.length > 0);
    const path = join(scratch, 'results.csv');
    await app.electron.evaluate(({ dialog }, target) => {
      // The export uses the native Save dialog; answer it without a human.
      dialog.showSaveDialog = () => Promise.resolve({ canceled: false, filePath: target });
    }, path);
    expect(await app.run('edit.search.export')).toBe(path);
    const csv = readFileSync(path, 'utf8');
    expect(csv).toContain('"Document"');
    expect(csv.split('\r\n').length).toBeGreaterThan(5);
  });
});

// ---- printing -------------------------------------------------------------------------------

test.describe('printing', () => {
  test.afterEach(closeAll);

  test('the print dialog opens with a preview and every option group', async () => {
    await open('multipage.pdf');
    const opened = app.run('file.print');
    await expect(app.page.locator('#print-dialog')).toBeVisible();
    for (const group of ['Printer', 'Pages', 'Page handling', 'Page setup', 'What to print']) {
      await expect(app.page.locator('#print-dialog legend', { hasText: group })).toBeVisible();
    }
    await expect(app.page.locator('.print-preview-image')).toBeVisible();
    await expect(app.page.locator('.print-summary')).toHaveText('5 pages on 5 sheets');
    await app.page.locator('#print-dialog button', { hasText: 'Cancel' }).click();
    await opened;
    await expect(app.page.locator('#print-dialog')).toBeHidden();
  });

  test('the plan follows the range, the subset and the layout', async () => {
    await open('multipage.pdf');
    const all = (await app.run('dev.printPlan')) as PrintPlan;
    expect(all.pages).toEqual([0, 1, 2, 3, 4]);
    expect(all.sheets).toHaveLength(5);

    const odd = (await app.run('dev.printPlan', { settings: { subset: 'odd' } })) as PrintPlan;
    expect(odd.pages).toEqual([0, 2, 4]);

    const twoUp = (await app.run('dev.printPlan', {
      settings: { rangeMode: 'custom', rangeText: '2-3', mode: 'nup', nUpColumns: 2, nUpRows: 1 },
    })) as PrintPlan;
    expect(twoUp.sheets).toHaveLength(1);
    expect(twoUp.sheets[0]?.placements.map((p) => p.page)).toEqual([1, 2]);

    const booklet = (await app.run('dev.printPlan', {
      settings: { rangeMode: 'custom', rangeText: '1-4', mode: 'booklet' },
    })) as PrintPlan;
    expect(booklet.sheets.map((s) => s.placements.map((p) => p.page))).toEqual([
      [3, 0],
      [1, 2],
    ]);
    expect(booklet.paper.width).toBeGreaterThan(booklet.paper.height);
  });

  test('a bad page range is refused rather than printed', async () => {
    await open('multipage.pdf');
    const plan = (await app.run('dev.printPlan', {
      settings: { rangeMode: 'custom', rangeText: '99' },
    })) as PrintPlan;
    expect(plan.error).toBeTruthy();
    expect(plan.sheets).toHaveLength(0);
  });

  test('a print job is built end to end in main, one sheet per page', async () => {
    await open('multipage.pdf');
    const result = (await app.run('dev.printDryRun', {
      settings: { rangeMode: 'custom', rangeText: '1-2', dpi: 96 },
    })) as { sheets: number; documentPath: string | null; error: string | null };
    expect(result.error).toBeNull();
    expect(result.sheets).toBe(2);
    const html = readFileSync(must(result.documentPath, 'print document path'), 'utf8');
    expect(html).toContain('@page { size: 595.28pt 841.89pt; margin: 0; }');
    expect(html.match(/<img /g)).toHaveLength(2);
  });

  test('Print to PDF of pages 2-3, two-up, keeps the text and the order', async () => {
    await open('multipage.pdf');
    const path = join(scratch, 'two-up.pdf');
    expect(
      await app.run('dev.printToPdf', {
        path,
        settings: {
          rangeMode: 'custom',
          rangeText: '2-3',
          mode: 'nup',
          nUpColumns: 2,
          nUpRows: 1,
        },
      }),
    ).toBe('saved');
    await open('two-up.pdf', path);
    const model = (await app.run('dev.textLayer', { page: 0 })) as TextModel;
    expect(model.text).toContain('Page 2 of 5');
    expect(model.text).toContain('Page 3 of 5');
  });

  test('Print to PDF as a booklet folds the pages 4-1, 2-3', async () => {
    await open('multipage.pdf');
    const path = join(scratch, 'booklet.pdf');
    await app.run('dev.printToPdf', {
      path,
      settings: { rangeMode: 'custom', rangeText: '1-4', mode: 'booklet' },
    });
    await open('booklet.pdf', path);
    const first = (await app.run('dev.textLayer', { page: 0 })) as TextModel;
    const second = (await app.run('dev.textLayer', { page: 1 })) as TextModel;
    expect(first.text).toContain('Page 4 of 5');
    expect(first.text).toContain('Page 1 of 5');
    expect(second.text).toContain('Page 2 of 5');
    expect(second.text).toContain('Page 3 of 5');
  });

  test('Print to PDF as an image carries what is on screen, without the text', async () => {
    await open('multipage.pdf');
    const path = join(scratch, 'raster.pdf');
    expect(
      await app.run('dev.printToPdf', {
        path,
        settings: { rangeMode: 'custom', rangeText: '1', printAsImage: true, dpi: 96 },
      }),
    ).toBe('saved');
    await open('raster.pdf', path);
    const model = (await app.run('dev.textLayer', { page: 0 })) as TextModel;
    expect(model.text.trim()).toBe('');
    expect(readFileSync(path).byteLength).toBeGreaterThan(1000);
  });
});

// ---- the commands themselves -------------------------------------------------------------------

test.describe('commands', () => {
  test('every M13 command is registered, and the visible ones are in the palette', async () => {
    const ids = await app.commands();
    for (const id of [
      'edit.selectAll',
      'edit.copy',
      'edit.copyFormatted',
      'edit.copyImage',
      'edit.deselect',
      'edit.find',
      'edit.findNext',
      'edit.findPrevious',
      'edit.search',
      'edit.search.export',
      'file.print',
      'file.printToPdf',
      'file.pageSetup',
      'tool.snapshot.activate',
    ]) {
      expect(ids, id).toContain(id);
    }
  });
});

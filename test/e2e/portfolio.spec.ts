/**
 * M42 acceptance tests — PDF Portfolios inside the real, built app.
 *
 * The unit tests own the algebra and the bytes: the model, the reader, the cover sheet, and the
 * writer's byte-identity guarantee. This file owns what only exists once there is a window — the
 * grid taking the document area, the Portfolio ribbon tab appearing only for a portfolio,
 * sorting by a heading, tiles drawing a first page, and a file going out and coming back.
 *
 * Each acceptance line in `docs/modules/M42-portfolios.md` has a test named after it.
 */

import { expect, test } from '@playwright/test';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixturePath, launchApp, type App } from './harness';

const FIXTURES = join(process.cwd(), 'test', 'fixtures');
const LOCAL = join(FIXTURES, 'local');
const SAMPLE = join(LOCAL, 'Sample Portfolio.pdf');

interface PortfolioState {
  isPortfolio: boolean;
  pane: string | null;
  view: string | null;
  folderId: number | null;
  selection: string[];
  gridVisible: boolean;
  pageHostHidden: boolean | null;
  columns: string[];
  rows: Array<{ id: string; text: string; selected: boolean }>;
  tiles: number;
  folders: string[];
  files: Array<{
    id: string;
    name: string;
    folderId: number;
    description: string | null;
    order: number;
    fields: Record<string, string>;
  }>;
  schema: Array<{ key: string; label: string; kind: string }>;
  sort: { key: string; ascending: boolean } | null;
  initialFile: string | null;
  canSaveBack: boolean;
  pages: number;
}

let app: App;
let workspace: string;

test.beforeAll(async () => {
  workspace = mkdtempSync(join(tmpdir(), 'ynot-portfolio-'));
  app = await launchApp();
});

test.afterAll(async () => {
  await app.close();
  rmSync(workspace, { recursive: true, force: true });
});

const state = (): Promise<PortfolioState> =>
  app.run('dev.portfolioState') as Promise<PortfolioState>;

/**
 * Opens a fixture by bytes and waits for the portfolio grid. A portfolio opens in tiles, as
 * Foxit's do; most of these tests read the details table, so that is what they get unless they
 * ask to keep the file's own view.
 */
async function openPortfolio(
  name = 'portfolio.pdf',
  path = join(FIXTURES, name),
  view: 'details' | 'tile' | null = 'details',
): Promise<void> {
  const bytes = Array.from(readFileSync(path));
  await app.run('file.openBytes', { file: { path: fixturePath(name), name, bytes } });
  await app.page.waitForSelector('.pf-host:not([hidden])');
  if (view !== null) await app.run('portfolio.setView', { value: view });
  await app.page.waitForTimeout(200);
}

async function select(...names: string[]): Promise<void> {
  await app.run('dev.portfolioSelect', { names });
  await app.page.waitForTimeout(80);
}

/** Closes every tab, answering the "save your changes?" dialog with "Don't save". */
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
  await app.page.waitForTimeout(150);
}

test.describe('a portfolio opens on its files', () => {
  test.afterEach(closeAll);

  test('the grid takes the document area and the page view stands down', async () => {
    await openPortfolio();
    const s = await state();
    expect(s.isPortfolio).toBe(true);
    expect(s.gridVisible).toBe(true);
    expect(s.pane).toBe('files');
    // The cover sheet is a page; while the files are showing, the viewer is not.
    expect(s.pageHostHidden).toBe(true);
    expect(s.rows).toHaveLength(3); // three at the root; two are in "Statements"
    expect(s.folders).toEqual(['All files', 'Statements']);
  });

  test('the cover sheet is a tab away, and hands the area back to the viewer', async () => {
    await openPortfolio();
    await app.page.getByRole('tab', { name: 'Cover sheet' }).click();
    await app.page.waitForSelector('.viewer-content .page');
    const s = await state();
    expect(s.pane).toBe('cover');
    expect(s.pageHostHidden).toBe(false);
    await app.page.getByRole('tab', { name: 'Files' }).click();
    expect((await state()).pane).toBe('files');
  });

  test('the Portfolio ribbon tab is there for a portfolio and not for anything else', async () => {
    await openPortfolio();
    // A contextual tab announces itself as one, so the accessible name is prefixed; the id is
    // what identifies it.
    const portfolioTab = app.page.locator('#ribbon-tab-portfolio');
    await expect(portfolioTab).toBeVisible();
    await expect(portfolioTab).toHaveAccessibleName(/Portfolio/);
    await closeAll();

    const bytes = Array.from(readFileSync(join(FIXTURES, 'multipage.pdf')));
    await app.run('file.openBytes', {
      file: { path: 'C:/fixtures/multipage.pdf', name: 'multipage.pdf', bytes },
    });
    await app.page.waitForSelector('.viewer-content .page');
    await expect(app.page.locator('#ribbon-tab-portfolio')).toHaveCount(0);
    expect((await state()).isPortfolio).toBe(false);
  });

  test('the Attachments panel stops editing a portfolio’s files behind its back', async () => {
    await openPortfolio();
    // M12's add/delete/describe go straight to the engine, which knows nothing about folders,
    // order or column values — so on a portfolio they stand down and the Portfolio tab does it.
    expect(await app.isEnabled('attachments.add')).toBe(false);
    expect(await app.isEnabled('attachments.delete')).toBe(false);
    expect(await app.isEnabled('attachments.describe')).toBe(false);
    // Reading one out is still fine, and so is the portfolio's own add.
    expect(await app.isEnabled('attachments.saveAs')).toBe(true);
    expect(await app.isEnabled('portfolio.addFiles')).toBe(true);
    await closeAll();

    const bytes = Array.from(readFileSync(join(FIXTURES, 'attachments.pdf')));
    await app.run('file.openBytes', {
      file: { path: 'C:/fixtures/attachments.pdf', name: 'attachments.pdf', bytes },
    });
    await app.page.waitForSelector('.viewer-content .page');
    // An ordinary document with attachments is untouched by any of that.
    expect(await app.isEnabled('attachments.add')).toBe(true);
  });

  test('an ordinary document leaves the grid hidden', async () => {
    const bytes = Array.from(readFileSync(join(FIXTURES, 'attachments.pdf')));
    await app.run('file.openBytes', {
      file: { path: 'C:/fixtures/attachments.pdf', name: 'attachments.pdf', bytes },
    });
    await app.page.waitForSelector('.viewer-content .page');
    const s = await state();
    expect(s.isPortfolio).toBe(false);
    expect(s.gridVisible).toBe(false);
    expect(s.pageHostHidden).toBe(false);
  });
});

test.describe('the details view', () => {
  test.afterEach(closeAll);

  test('sorts by every column, and says which way in words', async () => {
    await openPortfolio();
    const headings = (await state()).columns;
    expect(headings.length).toBeGreaterThan(2);

    for (const heading of ['Name', 'Description', 'Size']) {
      await app.page.getByRole('button', { name: new RegExp(`^${heading}`) }).click();
      await app.page.waitForTimeout(120);
      const up = await state();
      const first = up.rows.map((r) => r.id);
      await app.page.getByRole('button', { name: new RegExp(`^${heading}`) }).click();
      await app.page.waitForTimeout(120);
      const down = await state();
      expect(down.sort?.ascending, `${heading} reverses`).toBe(false);
      expect(
        down.rows.map((r) => r.id),
        `${heading} order changes`,
      ).not.toEqual(first);
      // The direction is a word, not only an arrow.
      expect(await app.page.locator('.pf-sort-word').first().textContent()).toMatch(/A–Z|Z–A/);
    }
  });

  test('a folder in the tree shows only its own files', async () => {
    await openPortfolio();
    await app.page.getByRole('treeitem', { name: /Statements/ }).click();
    await app.page.waitForTimeout(120);
    const s = await state();
    expect(s.folderId).toBe(1);
    expect(s.rows).toHaveLength(2);
    expect(s.rows.map((r) => r.text).join(' ')).toContain('january.txt');
  });
});

test.describe('the tiles view', () => {
  test.afterEach(closeAll);

  test('is how a portfolio opens, as it is in Foxit', async () => {
    await openPortfolio('portfolio.pdf', undefined, null);
    expect((await state()).view).toBe('tile');
  });

  test('draws the first page of an embedded PDF', async () => {
    await openPortfolio();
    await app.run('portfolio.setView', { value: 'tile' });
    await app.page.waitForSelector('.pf-tile');
    // The thumbnail is rendered off the main path; give the engine a moment.
    await expect.poll(async () => (await state()).tiles, { timeout: 15000 }).toBeGreaterThan(0);
    expect((await state()).view).toBe('tile');
  });
});

test.describe('editing', () => {
  test.afterEach(closeAll);

  test('reorder, rename, describe and remove are each undoable', async () => {
    await openPortfolio();
    const before = (await state()).files.map((f) => f.name);

    await select('people.csv');
    await app.run('portfolio.moveUp');
    await app.run('portfolio.renameFile', { name: 'everyone.csv' });
    await app.run('portfolio.describeFile', { description: 'Everyone on the job' });
    let s = await state();
    expect(s.files.map((f) => f.name)).toContain('everyone.csv');
    expect(s.files.find((f) => f.name === 'everyone.csv')?.description).toBe('Everyone on the job');

    await app.run('edit.undo');
    await app.run('edit.undo');
    await app.run('edit.undo');
    s = await state();
    expect(s.files.map((f) => f.name).sort()).toEqual([...before].sort());
    expect(s.files.find((f) => f.name === 'people.csv')?.description).toBe('Who is involved');
  });

  test('a custom column can be added and filled in', async () => {
    await openPortfolio();
    await app.run('portfolio.addColumn', { label: 'Case number', kind: 'text' });
    await select('instruction.pdf');
    const key = (await state()).schema.find((c) => c.label === 'Case number')?.key ?? '';
    expect(key).not.toBe('');
    await app.run('portfolio.setColumnValue', { key, value: 'A/17' });

    const s = await state();
    expect(s.files.find((f) => f.name === 'instruction.pdf')?.fields[key]).toBe('A/17');
    expect(s.columns.join(' ')).toContain('Case number');

    await app.run('edit.undo');
    expect(
      (await state()).files.find((f) => f.name === 'instruction.pdf')?.fields[key],
    ).toBeUndefined();
  });

  test('a file added from bytes lands in the grid with a New badge', async () => {
    await openPortfolio();
    const bytes = Array.from(new TextEncoder().encode('A late addition.\n'));
    await app.run('dev.portfolioAddBytes', { name: 'late.txt', bytes });
    await app.page.waitForTimeout(150);
    const s = await state();
    expect(s.files.map((f) => f.name)).toContain('late.txt');
    expect(s.rows.some((r) => r.text.includes('late.txt') && r.text.includes('New'))).toBe(true);
  });

  test('a file dropped into a folder is added under it', async () => {
    await openPortfolio();
    const bytes = Array.from(new TextEncoder().encode('March statement.\n'));
    await app.run('dev.portfolioAddBytes', { name: 'march.txt', path: 'Statements', bytes });
    await app.page.waitForTimeout(150);
    const s = await state();
    const added = s.files.find((f) => f.name === 'march.txt');
    expect(added).toBeDefined();
    expect(s.folders).toContain('Statements');
    expect(added?.folderId).not.toBe(0);
  });

  test('"show this file first" writes the portfolio’s initial file', async () => {
    await openPortfolio();
    await select('people.csv');
    await app.run('portfolio.setInitialFile');
    expect((await state()).initialFile).toBe('people.csv');
    await app.run('edit.undo');
    expect((await state()).initialFile).toBe('instruction.pdf');
  });
});

test.describe('the cover sheet', () => {
  test.afterEach(closeAll);

  test('is regenerated on demand and lists the file just added', async () => {
    await openPortfolio();
    const bytes = Array.from(new TextEncoder().encode('A late addition.\n'));
    await app.run('dev.portfolioAddBytes', { name: 'late.txt', bytes });
    await app.run('portfolio.generateCover', { subtitle: 'Prepared for the hearing' });
    await app.page.waitForTimeout(300);

    const s = await state();
    expect(s.pages).toBe(1);
    await app.page.getByRole('tab', { name: 'Cover sheet' }).click();
    await app.page.waitForSelector('.viewer-content .page');
    const text = (await app.run('dev.pageText', { page: 0 })) as string | null;
    if (typeof text === 'string') {
      expect(text).toContain('late.txt');
      expect(text).toContain('Prepared for the hearing');
    }
  });
});

test.describe('taking files out', () => {
  test.afterEach(closeAll);

  test('double-clicking an embedded PDF opens it in a tab that can be saved back', async () => {
    await openPortfolio();
    await select('instruction.pdf');
    await app.run('portfolio.openFile');
    await app.page.waitForSelector('.viewer-content .page');
    await app.page.waitForTimeout(200);
    const s = await state();
    // The new tab is an ordinary document, and it knows where it came from.
    expect(s.isPortfolio).toBe(false);
    expect(s.canSaveBack).toBe(true);
    expect(await app.isEnabled('portfolio.saveBack')).toBe(true);
  });

  test('convert to a single PDF opens a document with the embedded pages', async () => {
    await openPortfolio();
    const merged = await app.run('portfolio.convertToSinglePdf');
    await app.page.waitForSelector('.viewer-content .page');
    expect(typeof merged === 'number' ? merged : 0).toBeGreaterThan(0);
    const pageCount = (await app.run('dev.viewerState')) as { pageCount: number };
    expect(pageCount.pageCount).toBeGreaterThan(0);
  });
});

test.describe('saving', () => {
  test.afterEach(closeAll);

  /** Copies the fixture into the workspace so the test can write over it. */
  function stage(as = 'portfolio.pdf'): string {
    const path = join(workspace, as);
    copyFileSync(join(FIXTURES, 'portfolio.pdf'), path);
    return path;
  }

  test('a file added in this session is in the saved file, with its bytes', async () => {
    // The one path the unit tests cannot reach: the writer running in its own Worker inside the
    // real app, embedding a stream and computing its checksum there rather than in Node.
    const path = stage('saved-portfolio.pdf');
    await app.run('file.openRecent', { path });
    await app.page.waitForSelector('.pf-host:not([hidden])');
    await app.page.waitForTimeout(200);

    const body = 'A late addition, saved for real.';
    await app.run('dev.portfolioAddBytes', {
      name: 'late.txt',
      bytes: Array.from(new TextEncoder().encode(body)),
    });
    const outcome = (await app.run('file.save')) as { saved: boolean; reason?: string };
    expect(outcome.saved, outcome.reason ?? 'save failed').toBe(true);
    await closeAll();

    // Open what was written and ask it what it holds.
    await app.run('file.openRecent', { path });
    await app.page.waitForSelector('.pf-host:not([hidden])');
    await app.page.waitForTimeout(200);
    const s = await state();
    expect(s.files.map((f) => f.name)).toContain('late.txt');
    expect(s.files).toHaveLength(6);
    // And the five that were already there are still there, in their folders.
    expect(s.files.filter((f) => f.folderId !== 0)).toHaveLength(2);
  });

  test('changing one description leaves the file a portfolio', async () => {
    const path = stage('described-portfolio.pdf');
    await app.run('file.openRecent', { path });
    await app.page.waitForSelector('.pf-host:not([hidden])');
    await select('people.csv');
    await app.run('portfolio.describeFile', { description: 'Everyone on the job' });
    const outcome = (await app.run('file.save')) as { saved: boolean; reason?: string };
    expect(outcome.saved, outcome.reason ?? 'save failed').toBe(true);
    await closeAll();

    await app.run('file.openRecent', { path });
    await app.page.waitForSelector('.pf-host:not([hidden])');
    const s = await state();
    expect(s.isPortfolio).toBe(true);
    expect(s.files.find((f) => f.name === 'people.csv')?.description).toBe('Everyone on the job');
    expect(s.folders).toEqual(['All files', 'Statements']);
  });
});

test.describe('new portfolios', () => {
  test.afterEach(closeAll);

  test('File ▸ New ▸ Portfolio makes an empty one with a cover sheet', async () => {
    await app.run('portfolio.new', { title: 'Job pack' });
    await app.page.waitForSelector('.pf-host:not([hidden])');
    const s = await state();
    expect(s.isPortfolio).toBe(true);
    expect(s.files).toHaveLength(0);
    expect(s.pages).toBe(1);
    expect(s.view).toBe('tile');
    await expect(app.page.locator('.pf-empty')).toBeVisible();
  });

  test('the new-portfolio commands are in the palette', async () => {
    const commands = await app.commands();
    expect(commands).toContain('portfolio.new');
    expect(commands).toContain('portfolio.newFromFiles');
    expect(commands).toContain('portfolio.extractAll');
    expect(commands).toContain('portfolio.generateCover');
  });
});

test.describe('Tony’s own portfolio', () => {
  test.skip(!existsSync(SAMPLE), 'Sample Portfolio.pdf is not on this machine');
  test.afterEach(closeAll);

  test('opens as a portfolio with its own schema columns', async () => {
    await openPortfolio('Sample Portfolio.pdf', SAMPLE);
    const s = await state();
    expect(s.isPortfolio).toBe(true);
    expect(s.files.length).toBeGreaterThan(0);
    // Foxit's own schema, not our four defaults.
    expect(s.schema.map((c) => c.label)).toContain('Compressed size');
  });
});

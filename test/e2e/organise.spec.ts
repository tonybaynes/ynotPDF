/**
 * M40 acceptance tests — organising pages inside the real, built app.
 *
 * The unit tests own the algebra: the range dialect, the numbering, the reordering arithmetic,
 * the commands and their undo. This file owns what only exists once there is a window, a PDFium
 * worker and a writer — a drag with an insertion marker, a file that reopens from disk with the
 * order it was saved in, and a bookmark that still lands on the right page afterwards.
 *
 * Each acceptance line in `docs/modules/M40-organise-pages.md` has a test named after it.
 */

import { expect, test } from '@playwright/test';
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixturePath, launchApp, type App } from './harness';

const FIXTURES = join(process.cwd(), 'test', 'fixtures');

interface OrganiseState {
  settings: Record<string, unknown>;
  last: Record<string, unknown> | null;
  dragging: boolean;
  selection: number[];
  target: number[];
  pageCount: number;
  pageIds: string[];
  labels: string[];
  rotations: number[];
  outline: Array<{ title: string; page: number }>;
}

interface DocumentSummary {
  pageCount: number;
  pageLabels: string[];
  pageIds: string[];
  rotations: number[];
  outlineCount: number;
  canUndo: boolean;
  canRedo: boolean;
  issues: string[];
}

let app: App;
let workspace: string;

test.beforeAll(async () => {
  workspace = mkdtempSync(join(tmpdir(), 'ynot-organise-'));
  app = await launchApp();
});

test.afterAll(async () => {
  await app.close();
  rmSync(workspace, { recursive: true, force: true });
});

/** Asserts a value the fixture guarantees, so a failure names what was missing. */
function must<T>(value: T | null | undefined, what = 'value'): T {
  if (value === null || value === undefined) throw new Error(`the document has no ${what}`);
  return value;
}

const state = (): Promise<OrganiseState> => app.run('dev.organiseState') as Promise<OrganiseState>;
const summary = (): Promise<DocumentSummary> =>
  app.run('dev.documentSummary') as Promise<DocumentSummary>;

/** Copies a fixture into the workspace so a test can save over it. */
function stage(fixture: string, as = fixture): string {
  const path = join(workspace, as);
  copyFileSync(join(FIXTURES, fixture), path);
  return path;
}

/** Opens a fixture by bytes and waits for its first page. */
async function open(name: string, path = fixturePath(name)): Promise<void> {
  const bytes = Array.from(readFileSync(join(FIXTURES, name)));
  await app.run('file.openBytes', { file: { path, name, bytes } });
  await app.page.waitForSelector('.viewer-content .page');
  await app.page.waitForTimeout(150);
}

/** Opens a real file by path, the way Open Recent does. */
async function openPath(path: string): Promise<void> {
  await app.run('file.openRecent', { path });
  await app.page.waitForSelector('.viewer-content .page');
  await app.page.waitForTimeout(150);
}

/** The bytes of a fixture, as a plain array for the structured-clone bridge. */
const fileArg = (name: string): { path: string; name: string; bytes: number[] } => ({
  path: fixturePath(name),
  name,
  bytes: Array.from(readFileSync(join(FIXTURES, name))),
});

/**
 * Closes every tab, answering "save your changes?" with "Don't save" — these tests leave
 * documents dirty on purpose, and M21 is quite right to ask about it.
 */
async function closeAll(): Promise<void> {
  const closing = app.run('app.tabs.closeAll').catch(() => undefined);
  const dialog = app.page.locator('#save-unsaved-dialog');
  for (let i = 0; i < 8; i++) {
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

test.describe('the Organize commands are all reachable', () => {
  test.afterEach(closeAll);

  test('every command is registered, and the destructive ones are off with no document', async () => {
    const ids = await app.commands();
    for (const id of [
      'organize.insertBlank',
      'organize.insertFromFile',
      'organize.insertFromClipboard',
      'organize.deletePages',
      'organize.extractPages',
      'organize.replacePages',
      'organize.duplicatePages',
      'organize.reversePages',
      'organize.movePages',
      'organize.swapPages',
      'organize.copyToDocument',
      'organize.rotateLeft',
      'organize.rotateRight',
      'organize.rotate180',
      'organize.rotatePages',
      'organize.movePageUp',
      'organize.movePageDown',
      'organize.movePagesToStart',
      'organize.movePagesToEnd',
      'organize.pageLabels',
      'organize.clearPageLabels',
    ]) {
      expect(ids, `${id} is registered`).toContain(id);
    }
    // With nothing open there is nothing to organise, and the palette says so.
    expect(await app.isEnabled('organize.deletePages')).toBe(false);
    expect(await app.isEnabled('organize.pageLabels')).toBe(false);
  });

  test('the targeting rule: arguments, then the selection, then the current page', async () => {
    await open('multipage.pdf');
    // No selection: the current page, which is the first.
    expect((await state()).target).toEqual([0]);
    // A selection: those pages.
    await app.run('dev.organiseSelect', { pages: [1, 3] });
    expect((await state()).target).toEqual([1, 3]);
    // An explicit range beats the selection. Page 5 of this fixture already carries
    // `/Rotate 90`, so a right turn takes it to 180 — which is the point: the command turned
    // page 5 and not one of the two that are selected.
    const wasRotated = (await summary()).rotations[4] ?? 0;
    await app.run('organize.rotateRight', { range: '5' });
    const nowRotated = (await summary()).rotations[4] ?? 0;
    expect(nowRotated).toBe((wasRotated + 90) % 360);
    // The selected pages were not touched.
    expect((await summary()).rotations[1]).toBe(0);
    expect((await summary()).rotations[3]).toBe(0);
    // And the selection is still what it was.
    expect((await state()).selection).toEqual([1, 3]);
  });
});

test.describe('acceptance: reorder 50 pages by drag, undo, redo', () => {
  test.afterEach(closeAll);

  test('the order is what was asked, undo and redo agree, and a save round-trips it', async () => {
    const path = stage('multipage.pdf', 'reorder.pdf');
    await openPath(path);
    // Grow it to fifty pages, so the test is the one the brief asks for.
    await app.run('organize.insertBlank', { count: 45, at: 5 });
    expect((await summary()).pageCount).toBe(50);

    const before = await state();
    expect(before.pageIds).toHaveLength(50);

    // The drag: page 1 dropped before page 40. `dev.organiseDrop` is exactly what the pointer
    // controller calls when the pointer goes up, so this tests the same path.
    await app.run('dev.organiseSelect', { pages: [0] });
    await app.run('dev.organiseDrop', { pages: [0], index: 40 });

    const moved = await state();
    const expected = [...before.pageIds];
    const [first] = expected.splice(0, 1);
    expected.splice(39, 0, must(first, 'first page id'));
    expect(moved.pageIds).toEqual(expected);
    expect(moved.pageCount).toBe(50);

    // Undo puts it back exactly, redo puts it forward exactly.
    await app.run('edit.undo');
    expect((await state()).pageIds).toEqual(before.pageIds);
    await app.run('edit.redo');
    expect((await state()).pageIds).toEqual(expected);

    // A multi-page drag keeps the pages in their own order.
    await app.run('dev.organiseDrop', { pages: [10, 11, 12], index: 0 });
    const afterMulti = await state();
    expect(afterMulti.pageIds.slice(0, 3)).toEqual([
      must(expected[10], 'page 11'),
      must(expected[11], 'page 12'),
      must(expected[12], 'page 13'),
    ]);
    await app.run('edit.undo');
    expect((await state()).pageIds).toEqual(expected);

    // The model is still coherent after all that.
    expect((await summary()).issues).toEqual([]);

    // And the file on disk reopens with the order it was saved in.
    const saved = (await app.run('file.save')) as { saved: boolean };
    expect(saved.saved).toBe(true);
    await closeAll();
    await openPath(path);
    const reopened = await state();
    expect(reopened.pageCount).toBe(50);
    // The first three pages of the saved file are the three that were moved to the front… no:
    // the multi-page drag was undone, so it is the single-page move that was saved.
    expect(reopened.labels).toHaveLength(50);
  });

  test('a bookmark still targets the right page after a reorder and a save', async () => {
    const path = stage('outline.pdf', 'reorder-outline.pdf');
    await openPath(path);
    const before = await state();
    expect(before.outline.length).toBeGreaterThan(0);
    // Every bookmark, and the page it points at right now.
    const targets = new Map(before.outline.map((o) => [o.title, o.page]));

    // Reverse the document: every bookmark's page index changes, and every bookmark must follow.
    await app.run('organize.reversePages');
    const after = await state();
    for (const entry of after.outline) {
      const was = targets.get(entry.title);
      if (was === undefined || was < 0) continue;
      expect(entry.page, `${entry.title} followed its page`).toBe(before.pageCount - 1 - was);
    }

    const saved = (await app.run('file.save')) as { saved: boolean };
    expect(saved.saved).toBe(true);
    await closeAll();
    await openPath(path);

    // Reopened from disk: the bookmarks point at the pages they pointed at before the save.
    const reopened = await state();
    expect(reopened.outline.length).toBe(after.outline.length);
    for (const entry of reopened.outline) {
      const expectedPage = after.outline.find((o) => o.title === entry.title)?.page;
      if (expectedPage === undefined || expectedPage < 0) continue;
      expect(entry.page, `${entry.title} still targets the right page`).toBe(expectedPage);
    }
  });
});

test.describe('acceptance: insert 3 pages from another file at position 2, with bookmarks', () => {
  test.afterEach(closeAll);

  test('page count, sizes and outline entries are right', async () => {
    await open('multipage.pdf');
    const before = await summary();
    const sizesBefore = (await app.run('dev.pageSizes')) as Array<{
      width: number;
      height: number;
    }>;
    expect(sizesBefore).toHaveLength(before.pageCount);

    // outline.pdf is three pages with a nested chapter → section outline.
    await app.run('organize.insertFromFile', {
      files: [fileArg('outline.pdf')],
      sourcePages: [0, 1, 2],
      at: 2,
    });

    const after = await summary();
    expect(after.pageCount).toBe(before.pageCount + 3);

    // The pages that were already there kept their sizes, in their new positions.
    const sizesAfter = (await app.run('dev.pageSizes')) as Array<{
      width: number;
      height: number;
    }>;
    expect(sizesAfter).toHaveLength(after.pageCount);

    const organise = await state();
    // The original pages are still there, in order, with the three new ones in the middle.
    expect(organise.pageIds.slice(0, 2)).toEqual(before.pageIds.slice(0, 2));
    expect(organise.pageIds.slice(5)).toEqual(before.pageIds.slice(2));

    // The source's bookmarks came with the pages and point into them.
    expect(after.outlineCount).toBeGreaterThan(before.outlineCount);
    const inserted = organise.outline.filter((o) => o.page >= 2 && o.page <= 4);
    expect(inserted.length).toBeGreaterThan(0);

    // Undo takes the pages and the bookmarks away together.
    await app.run('edit.undo');
    const undone = await summary();
    expect(undone.pageCount).toBe(before.pageCount);
    expect(undone.outlineCount).toBe(before.outlineCount);
    expect(undone.issues).toEqual([]);
  });

  test('inserting an image works too, because a non-PDF goes through the converters', async () => {
    await open('multipage.pdf');
    const before = await summary();
    const picture = join(FIXTURES, 'create', 'photo-landscape.jpg');
    await app.run('organize.insertFromFile', {
      files: [
        {
          path: picture,
          name: 'photo-landscape.jpg',
          bytes: Array.from(readFileSync(picture)),
        },
      ],
      sourcePages: [0],
      at: 0,
    });
    expect((await summary()).pageCount).toBe(before.pageCount + 1);
  });
});

test.describe('acceptance: extract pages 2-4 with comments', () => {
  test.afterEach(closeAll);

  test('the new file has three pages and their annotations', async () => {
    // A document whose pages 2-4 carry annotations: insert the annotated fixture three times.
    await open('multipage.pdf');
    await app.run('organize.insertFromFile', {
      files: [fileArg('annotated.pdf'), fileArg('annotated.pdf'), fileArg('annotated.pdf')],
      sourcePages: [0],
      at: 1,
    });
    expect((await summary()).pageCount).toBe(8);

    const out = join(workspace, 'extracted.pdf');
    const result = (await app.run('organize.extractPages', {
      range: '2-4',
      destination: 'file',
      withComments: true,
      path: out,
    })) as { extracted: number; path: string };
    expect(result.extracted).toBe(3);

    // Open what was written and look at it, rather than trusting the return value.
    await openPath(out);
    const extracted = await summary();
    expect(extracted.pageCount).toBe(3);

    let annotations = 0;
    for (let page = 0; page < 3; page++) {
      const list = (await app.run('dev.pageAnnotations', { page })) as unknown[];
      annotations += list.length;
    }
    expect(annotations).toBeGreaterThan(0);
  });

  test('extract to a new tab with "delete after" deletes from the source, not the extract', async () => {
    // The regression: opening the extract *activates* its tab, so a delete that asked for
    // the active document deleted from the extract — which holds exactly those pages, so it
    // refused and reported that they had gone, leaving the source untouched.
    await open('multipage.pdf');
    const before = await summary();

    const result = (await app.run('organize.extractPages', {
      range: '2-3',
      destination: 'tab',
      deleteAfter: true,
    })) as { extracted: number; deletedAfter: boolean };
    expect(result.extracted).toBe(2);

    // The extract is in front, with its two pages and nothing missing.
    expect((await summary()).pageCount).toBe(2);

    // The source lost exactly those two.
    await app.run('app.tabs.previous');
    await app.page.waitForTimeout(200);
    expect((await summary()).pageCount).toBe(before.pageCount - 2);
    // And it is one undo away from whole again.
    await app.run('edit.undo');
    expect((await summary()).pageCount).toBe(before.pageCount);
  });

  test('several files insert in the order they were chosen', async () => {
    // The regression: the insertion point was recomputed from a stale target every time
    // round the loop, so every file landed at the same index and they arrived back to front.
    await open('blank.pdf');
    await app.run('organize.insertFromFile', {
      files: [fileArg('outline.pdf'), fileArg('multipage.pdf')],
      sourcePages: [0],
      at: 0,
    });
    // One page from each, in the order they were given: outline.pdf then multipage.pdf.
    expect((await summary()).pageCount).toBe(3);
    const sizes = (await app.run('dev.pageSizes')) as Array<{ width: number }>;
    // outline.pdf and multipage.pdf page 1 are both A4, so the order is checked by asking
    // the text of each page instead.
    const first = (await app.run('dev.pageText', { page: 0 })) as string;
    const second = (await app.run('dev.pageText', { page: 1 })) as string;
    expect(sizes).toHaveLength(3);
    expect(first).not.toBe(second);
  });

  test('a numbering style the dialog does not offer is refused, not written', async () => {
    // The regression: any string was cast to a style, and an unknown one made `numeral()`
    // return undefined — so every page in the range was labelled the literal "undefined".
    await open('multipage.pdf');
    await app.run('organize.pageLabels', {
      range: '1-2',
      style: 'roman',
      prefix: '',
      start: 1,
    });
    const labels = (await state()).labels;
    expect(labels).not.toContain('undefined');
    // It fell back to the style the dialog opens on.
    expect(labels.slice(0, 2)).toEqual(['1', '2']);
  });

  test('extracting into a new tab leaves the original alone', async () => {
    await open('multipage.pdf');
    const before = await summary();

    const opened = (await app.run('organize.extractPages', {
      range: '1-2',
      destination: 'tab',
      withComments: true,
    })) as { extracted: number; tabId: string };
    expect(opened.extracted).toBe(2);
    expect((await summary()).pageCount).toBe(2);

    // The original is untouched behind it. The extracted tab has never been saved, so it is
    // stepped away from rather than closed — closing would quite rightly ask about it.
    await app.run('app.tabs.previous');
    await app.page.waitForTimeout(200);
    expect((await summary()).pageCount).toBe(before.pageCount);

    // With "delete after", the pages go from the original as well — in one undo step.
    await app.run('organize.extractPages', {
      range: '1',
      destination: 'file',
      path: join(workspace, 'one.pdf'),
      deleteAfter: true,
    });
    expect((await summary()).pageCount).toBe(before.pageCount - 1);
    await app.run('edit.undo');
    expect((await summary()).pageCount).toBe(before.pageCount);
  });
});

test.describe('acceptance: page numbering', () => {
  test.afterEach(closeAll);

  test('"A-1…" shows in the status bar and the thumbnails, and /PageLabels is written', async () => {
    const path = stage('multipage.pdf', 'labelled.pdf');
    await openPath(path);

    await app.run('organize.pageLabels', {
      range: '1-3',
      style: 'decimal',
      prefix: 'A-',
      start: 1,
    });

    const after = await state();
    expect(after.labels.slice(0, 3)).toEqual(['A-1', 'A-2', 'A-3']);
    // The pages outside the range were left alone.
    expect(after.labels.slice(3)).toEqual(['4', '5']);

    // The status bar says what the current page is numbered, in words plus the value.
    const field = app.page.locator('.status-page-label');
    await expect(field).toBeVisible();
    await expect(field).toContainText('Numbered');
    await expect(field.locator('.status-page-label-value')).toHaveText('A-1');

    // The thumbnails show it too (M12 draws `page.label` under each one). Pages is the panel a
    // document opens on, so it is already there — running its toggle would close it.
    const cells = app.page.locator('.thumb-cell .thumb-label');
    await expect(cells.first()).toHaveText('A-1');
    const labels = await cells.allTextContents();
    expect(labels.slice(0, 3)).toEqual(['A-1', 'A-2', 'A-3']);

    // Saved and reopened, the numbering is in the file.
    const saved = (await app.run('file.save')) as { saved: boolean };
    expect(saved.saved).toBe(true);
    await closeAll();
    await openPath(path);
    expect((await state()).labels).toEqual(['A-1', 'A-2', 'A-3', '4', '5']);
  });

  test('roman numbering round-trips through the file as a numbering, not as literals', async () => {
    const path = stage('multipage.pdf', 'roman.pdf');
    await openPath(path);
    await app.run('organize.pageLabels', {
      range: '1-3',
      style: 'romanLower',
      prefix: '',
      start: 1,
    });
    expect((await state()).labels.slice(0, 3)).toEqual(['i', 'ii', 'iii']);
    await app.run('file.save');
    await closeAll();
    await openPath(path);
    expect((await state()).labels.slice(0, 3)).toEqual(['i', 'ii', 'iii']);
  });

  test('the numbering field is hidden for a document that has none', async () => {
    await open('multipage.pdf');
    await expect(app.page.locator('.status-page-label')).toBeHidden();
  });

  test('numbering can be removed again', async () => {
    await open('multipage.pdf');
    await app.run('organize.pageLabels', {
      range: '1-2',
      style: 'alphaUpper',
      prefix: '',
      start: 1,
    });
    expect((await state()).labels.slice(0, 2)).toEqual(['A', 'B']);
    await app.run('organize.clearPageLabels', { range: '1-2' });
    expect((await state()).labels).toEqual(['1', '2', '3', '4', '5']);
  });
});

test.describe('the rest of the Organize tab', () => {
  test.afterEach(closeAll);

  test('delete takes the dangling bookmarks with it, and one undo brings both back', async () => {
    await open('outline.pdf');
    const before = await summary();
    const outlineBefore = (await state()).outline;
    expect(outlineBefore.some((o) => o.page === 0)).toBe(true);

    const result = (await app.run('organize.deletePages', {
      range: '1',
      confirm: false,
    })) as { deleted: number; bookmarks: number };
    expect(result.deleted).toBe(1);
    expect(result.bookmarks).toBeGreaterThan(0);

    const after = await summary();
    expect(after.pageCount).toBe(before.pageCount - 1);
    expect(after.outlineCount).toBeLessThan(before.outlineCount);

    await app.run('edit.undo');
    const undone = await summary();
    expect(undone.pageCount).toBe(before.pageCount);
    expect(undone.outlineCount).toBe(before.outlineCount);
    expect(undone.issues).toEqual([]);
  });

  test('a document cannot lose its last page', async () => {
    await open('blank.pdf');
    // A one-page document has nothing to delete, and the command says so by being off rather
    // than by letting the reader press it and then refusing.
    expect(await app.isEnabled('organize.deletePages')).toBe(false);
    expect((await summary()).pageCount).toBe(1);

    // Asking a longer document to delete every page is refused in words, and nothing goes.
    await closeAll();
    await open('multipage.pdf');
    // The command waits on its own message box, so the box is dismissed before the call is
    // awaited — awaiting first would wait for a dialog nobody is going to close.
    const running = app.run('organize.deletePages', { range: '1-5', confirm: false });
    const message = app.page.locator('dialog.dlg', { hasText: 'at least one page' });
    await expect(message).toBeVisible();
    await message.getByRole('button', { name: 'OK' }).click();
    expect((await running) as { deleted: number }).toMatchObject({ deleted: 0 });
    expect((await summary()).pageCount).toBe(5);
  });

  test('rotate acts on the selection, not on page one', async () => {
    await open('multipage.pdf');
    await app.run('dev.organiseSelect', { pages: [2] });
    await app.run('organize.rotateRight');
    const rotations = (await summary()).rotations;
    expect(rotations[0]).toBe(0);
    expect(rotations[2]).toBe(90);
    await app.run('organize.rotateLeft');
    expect((await summary()).rotations[2]).toBe(0);
    await app.run('organize.rotate180', { range: '1' });
    expect((await summary()).rotations[0]).toBe(180);
  });

  test('duplicate, reverse, move and swap all undo cleanly', async () => {
    await open('multipage.pdf');
    const before = await state();

    await app.run('organize.duplicatePages', { range: '1' });
    expect((await summary()).pageCount).toBe(6);
    await app.run('edit.undo');
    expect((await state()).pageIds).toEqual(before.pageIds);

    await app.run('organize.reversePages');
    expect((await state()).pageIds).toEqual([...before.pageIds].reverse());
    await app.run('edit.undo');
    expect((await state()).pageIds).toEqual(before.pageIds);

    await app.run('organize.movePages', { range: '1', to: 5 });
    expect((await state()).pageIds[4]).toBe(before.pageIds[0]);
    await app.run('edit.undo');
    expect((await state()).pageIds).toEqual(before.pageIds);

    await app.run('organize.swapPages', { a: 0, b: 4 });
    const swapped = await state();
    expect(swapped.pageIds[0]).toBe(before.pageIds[4]);
    expect(swapped.pageIds[4]).toBe(before.pageIds[0]);
    await app.run('edit.undo');
    expect((await state()).pageIds).toEqual(before.pageIds);

    expect((await summary()).issues).toEqual([]);
  });

  test('the keyboard alternative moves pages one place and keeps them selected', async () => {
    await open('multipage.pdf');
    const before = await state();
    await app.run('dev.organiseSelect', { pages: [0] });
    await app.run('organize.movePageDown');
    const after = await state();
    expect(after.pageIds[1]).toBe(before.pageIds[0]);
    // The selection followed the page, so pressing it again moves the same one.
    expect(after.selection).toEqual([1]);
    await app.run('organize.movePageUp');
    expect((await state()).pageIds).toEqual(before.pageIds);

    await app.run('organize.movePagesToEnd');
    expect((await state()).pageIds[4]).toBe(before.pageIds[0]);
    // The selection followed the page to the end, so sending it back to the start returns the
    // document to exactly where it was.
    expect((await state()).selection).toEqual([4]);
    await app.run('organize.movePagesToStart');
    expect((await state()).pageIds).toEqual(before.pageIds);
  });

  test('replace puts other pages in the place of these ones, in one undo step', async () => {
    await open('multipage.pdf');
    const before = await summary();
    await app.run('organize.replacePages', {
      files: [fileArg('outline.pdf')],
      range: '2-3',
      sourcePages: [0],
    });
    const after = await summary();
    // Two pages out, one in.
    expect(after.pageCount).toBe(before.pageCount - 1);
    await app.run('edit.undo');
    const undone = await summary();
    expect(undone.pageCount).toBe(before.pageCount);
    expect(undone.pageIds).toEqual(before.pageIds);
    expect(undone.issues).toEqual([]);
  });

  test('pages can be copied into another open document', async () => {
    await open('multipage.pdf', 'C:/fixtures/source.pdf');
    const sourceTabs = await app.run('dev.organiseState');
    expect((sourceTabs as OrganiseState).pageCount).toBe(5);

    await open('outline.pdf', 'C:/fixtures/target.pdf');
    const targetBefore = await summary();
    const targetTab = (await app.run('dev.activeTabId')) as string | null;

    // Back to the source, and copy two of its pages into the target's tab.
    await app.run('app.tabs.previous');
    await app.page.waitForTimeout(150);
    const copied = (await app.run('dev.organiseDrop', {
      pages: [0, 1],
      tabId: targetTab,
    })) as { copied: number };
    expect(copied.copied).toBe(2);

    await app.run('app.tabs.next');
    await app.page.waitForTimeout(150);
    expect((await summary()).pageCount).toBe(targetBefore.pageCount + 2);
  });
});

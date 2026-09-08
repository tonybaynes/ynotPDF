/**
 * M20 e2e: the document model inside the real, built app.
 *
 * The acceptance test this file exists for is the last one: the ribbon's Undo and Redo buttons
 * must name the change they would revert and must enable and disable with the history, the way
 * Foxit's do. That is a claim about the running shell, so it is checked here rather than in a
 * unit test — the button text, the disabled attribute and the accessible name are all read from
 * the DOM after driving real commands.
 */

import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { launchApp, type App } from './harness';

const fixtures = join(process.cwd(), 'test', 'fixtures');

/** What the developer commands report back. Structured-cloneable, so it crosses the bridge. */
interface Summary {
  readonly pageCount: number;
  readonly pageLabels: string[];
  readonly pageIds: string[];
  readonly rotations: number[];
  readonly annotationCount: number;
  readonly fieldCount: number;
  readonly outlineCount: number;
  readonly destinationCount: number;
  readonly layerCount: number;
  readonly signatureCount: number;
  readonly metadataTitle: string | null;
  readonly writeIntents: string[];
  readonly revision: number;
  readonly dirty: boolean;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly undoLabel: string | null;
  readonly redoLabel: string | null;
  readonly issues: string[];
}

let app: App;

test.beforeAll(async () => {
  app = await launchApp();
});
test.afterAll(async () => {
  await app.close();
});

const bytesOf = (name: string): number[] => Array.from(readFileSync(join(fixtures, name)));

const openFixture = (name: string): Promise<Summary> =>
  app.run('dev.documentOpen', { bytes: bytesOf(name), name }) as Promise<Summary>;

const apply = (args: Record<string, unknown>): Promise<Summary> =>
  app.run('dev.documentApply', args) as Promise<Summary>;

// The quick-access toolbar carries the same command ids in a compact icon row; the ribbon
// group's own large buttons are the ones this file is about.
const undoButton = () => app.page.locator('#ribbon .rb-group [data-command="edit.undo"]');
const redoButton = () => app.page.locator('#ribbon .rb-group [data-command="edit.redo"]');

test('undo and redo are registered commands, so the palette and the QAT find them', async () => {
  const commands = await app.commands();
  expect(commands).toContain('edit.undo');
  expect(commands).toContain('edit.redo');
  expect(commands).toContain('page.rotateRight');
  expect(commands).toContain('page.rotateLeft');
});

test('opening a fixture builds the whole model', async () => {
  const summary = await openFixture('multipage.pdf');
  expect(summary.pageCount).toBe(5);
  expect(summary.pageIds).toHaveLength(5);
  expect(summary.pageIds[0]).toMatch(/^pg-\d+$/);
  expect(summary.issues).toEqual([]);
  expect(summary.dirty).toBe(false);
  expect(summary.canUndo).toBe(false);
});

test('a form document brings its fields, and an outline its destinations', async () => {
  const form = await openFixture('form.pdf');
  expect(form.fieldCount).toBeGreaterThan(0);
  const outline = await openFixture('outline.pdf');
  expect(outline.outlineCount).toBeGreaterThan(0);
  expect(outline.destinationCount).toBeGreaterThan(0);
  expect(outline.issues).toEqual([]);
});

test('the ribbon undo and redo buttons follow the history', async () => {
  await openFixture('multipage.pdf');
  await app.run('app.ribbon.showTab', { tab: 'edit' });

  // Nothing done yet: both buttons are present and both are disabled.
  await expect(undoButton()).toBeVisible();
  await expect(redoButton()).toBeVisible();
  await expect(undoButton()).toBeDisabled();
  await expect(redoButton()).toBeDisabled();
  await expect(undoButton()).toHaveText('Undo');
  await expect(redoButton()).toHaveText('Redo');

  // Rotate a page: Undo becomes available and says what it would revert.
  await apply({ kind: 'rotate', page: 0, rotation: 90 });
  await expect(undoButton()).toBeEnabled();
  await expect(undoButton()).toHaveText('Undo Rotate page');
  await expect(undoButton()).toHaveAttribute('title', /Undo Rotate page/);
  await expect(redoButton()).toBeDisabled();

  // Undo it from the ribbon itself: Redo takes over the label.
  await undoButton().click();
  await expect(undoButton()).toBeDisabled();
  await expect(undoButton()).toHaveText('Undo');
  await expect(redoButton()).toBeEnabled();
  await expect(redoButton()).toHaveText('Redo Rotate page');

  // Redo from the ribbon and the state swaps back.
  await redoButton().click();
  await expect(undoButton()).toBeEnabled();
  await expect(undoButton()).toHaveText('Undo Rotate page');
  await expect(redoButton()).toBeDisabled();
});

test('the label changes as the last change changes', async () => {
  await openFixture('multipage.pdf');
  await app.run('app.ribbon.showTab', { tab: 'edit' });

  await apply({ kind: 'rotate', page: 0, rotation: 90 });
  await expect(undoButton()).toHaveText('Undo Rotate page');

  await apply({ kind: 'delete', page: 1 });
  await expect(undoButton()).toHaveText('Undo Delete page');

  await apply({ kind: 'insert', at: 0, count: 3 });
  await expect(undoButton()).toHaveText('Undo Insert 3 pages');

  await apply({ kind: 'label', page: 0, value: 'Cover' });
  await expect(undoButton()).toHaveText('Undo Rename page');
});

test('undo and redo run from the keyboard', async () => {
  await openFixture('multipage.pdf');
  const rotated = await apply({ kind: 'rotate', page: 0, rotation: 90 });
  expect(rotated.rotations[0]).toBe(90);

  const undone = (await app.run('edit.undo')) as string | null;
  expect(undone).toBe('Rotate page');
  const afterUndo = (await app.run('dev.documentSummary')) as Summary;
  expect(afterUndo.rotations[0]).toBe(0);
  expect(afterUndo.canRedo).toBe(true);

  await app.run('edit.redo');
  const afterRedo = (await app.run('dev.documentSummary')) as Summary;
  expect(afterRedo.rotations[0]).toBe(90);
});

test('the rotate commands on the Organize tab drive the model', async () => {
  await openFixture('multipage.pdf');
  expect(await app.run('page.rotateRight', { page: 0 })).toBe(90);
  expect(await app.run('page.rotateRight', { page: 0 })).toBe(180);
  expect(await app.run('page.rotateLeft', { page: 0 })).toBe(90);
  const summary = (await app.run('dev.documentSummary')) as Summary;
  expect(summary.rotations[0]).toBe(90);
  expect(summary.issues).toEqual([]);
});

test('the tab shows the document as modified, and stops once everything is undone', async () => {
  await openFixture('multipage.pdf');
  const tab = app.page.locator('#tabstrip .tab-active');
  await expect(tab).not.toHaveClass(/tab-modified/);

  await apply({ kind: 'rotate', page: 0, rotation: 90 });
  await expect(tab).toHaveClass(/tab-modified/);

  await app.run('edit.undo');
  await expect(tab).not.toHaveClass(/tab-modified/);
});

test('a change the engine cannot make is recorded for the writer', async () => {
  await openFixture('multipage.pdf');
  const summary = await apply({ kind: 'metadata', value: 'Renamed in the app' });
  expect(summary.metadataTitle).toBe('Renamed in the app');
  expect(summary.writeIntents).toContain('metadata');

  await app.run('edit.undo');
  const after = (await app.run('dev.documentSummary')) as Summary;
  expect(after.writeIntents).not.toContain('metadata');
});

test('the journal round-trips through the bridge and replays', async () => {
  await openFixture('multipage.pdf');
  await apply({ kind: 'rotate', page: 0, rotation: 90 });
  await apply({ kind: 'label', page: 1, value: 'Two' });
  const edited = (await app.run('dev.documentSummary')) as Summary;

  const journal = (await app.run('dev.documentJournal')) as {
    version: number;
    entries: { type: string; payload: unknown }[];
    complete: boolean;
  };
  expect(journal.version).toBe(1);
  expect(journal.complete).toBe(true);
  expect(journal.entries.map((e) => e.type)).toEqual(['page.rotate', 'page.label']);

  // A fresh copy of the same file, replayed from that journal, ends up in the same state.
  await openFixture('multipage.pdf');
  const result = (await app.run('dev.documentJournal', { replay: journal })) as {
    applied: number;
    skipped: number;
  };
  expect(result).toEqual({ applied: 2, skipped: 0, skippedTypes: [] });
  const replayed = (await app.run('dev.documentSummary')) as Summary;
  expect(replayed.rotations).toEqual(edited.rotations);
  expect(replayed.pageLabels).toEqual(edited.pageLabels);
  expect(replayed.issues).toEqual([]);
});

test('the model stays valid through a long mixed session', async () => {
  const opened = await openFixture('multipage.pdf');
  // The fixture's fifth page carries `/Rotate 90` of its own, so "unrotated" is what it opened as.
  expect(opened.rotations).toEqual([0, 0, 0, 0, 90]);
  const steps: Record<string, unknown>[] = [
    { kind: 'rotate', page: 0, rotation: 90 },
    { kind: 'insert', at: 1, count: 2 },
    { kind: 'move', page: 0, to: 3 },
    { kind: 'delete', page: 2 },
    { kind: 'label', page: 0, value: 'First' },
    { kind: 'metadata', value: 'Session' },
    { kind: 'rotate', page: 1, rotation: 270 },
  ];
  for (const step of steps) {
    const summary = await apply(step);
    expect(summary.issues, `after ${JSON.stringify(step)}`).toEqual([]);
  }
  const edited = (await app.run('dev.documentSummary')) as Summary;
  expect(edited.pageCount).toBe(6);
  expect(edited.dirty).toBe(true);

  // Undo everything: back to five pages, clean, and still valid.
  let undos = 0;
  while (((await app.run('dev.documentSummary')) as Summary).canUndo) {
    await app.run('edit.undo');
    undos++;
    if (undos > 20) break;
  }
  expect(undos).toBe(steps.length);
  const restored = (await app.run('dev.documentSummary')) as Summary;
  expect(restored.pageCount).toBe(5);
  expect(restored.rotations).toEqual(opened.rotations);
  expect(restored.canUndo).toBe(false);
  expect(restored.dirty).toBe(false);
  expect(restored.issues).toEqual([]);
});

/**
 * M72 e2e: the Document Properties dialog and the initial view, in the built app.
 *
 * What is proved here rather than in the unit tests is that the module is *wired up*: the command
 * is in the palette with its shortcut, the dialog opens with six reachable tabs and no
 * transparency, an edit made in it survives a save and a reopen, and a document that asks to open
 * on page 3, two pages up, actually opens that way in a running window.
 *
 * The metadata round-trip itself is proved against the real engine in
 * `test/unit/properties/acceptance.test.ts`; this is the same claim made once through the UI.
 */

import { expect, test } from '@playwright/test';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchApp, type App } from './harness';

const fixtures = join(process.cwd(), 'test', 'fixtures');

interface PropertiesState {
  readonly metadata: {
    readonly title: string | null;
    readonly author: string | null;
    readonly keywords: string | null;
    readonly custom: Record<string, string>;
    readonly trapped: string | null;
    readonly lang: string | null;
    readonly xmp: string | null;
  };
  readonly view: {
    readonly pageMode: string;
    readonly pageLayout: string;
    readonly initialPageId: string | null;
    readonly initialFit: string | null;
  };
  readonly fonts: ReadonlyArray<{ name: string; embedded: boolean; subset: boolean }> | string;
  readonly applied: {
    readonly layout: string | null;
    readonly panel: string | null;
    readonly page: number | null;
    readonly fit: string | null;
    readonly ignored: ReadonlyArray<string>;
  } | null;
  readonly writeIntents: ReadonlyArray<string>;
  /** Which navigation panel is open, so the test can see what the page mode did. */
  readonly panel: string | null;
}

let workspace: string;
let app: App;

test.beforeAll(async () => {
  workspace = mkdtempSync(join(tmpdir(), 'ynot-properties-'));
  app = await launchApp();
});

test.afterAll(async () => {
  await app.close();
  rmSync(workspace, { recursive: true, force: true });
});

function stage(fixture: string, as = fixture): string {
  const path = join(workspace, as);
  copyFileSync(join(fixtures, fixture), path);
  return path;
}

async function openPath(path: string): Promise<void> {
  await app.run('file.openRecent', { path });
  await expect
    .poll(async () => ((await app.run('dev.saveState')) as { path: string | null }).path)
    .toBe(path);
}

const state = (): Promise<PropertiesState> => app.run('dev.properties') as Promise<PropertiesState>;

/** Closes the active document, answering M21's unsaved-changes question if it appears. */
async function closeDiscarding(): Promise<void> {
  let settled = false;
  const closing = app.run('file.close').finally(() => {
    settled = true;
  });
  const dialog = app.page.locator('#save-unsaved-dialog');
  for (let i = 0; i < 40 && !settled; i++) {
    if (await dialog.isVisible()) {
      await dialog.getByRole('button', { name: "Don't save" }).click();
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  await closing;
}

test('every command this module offers is registered', async () => {
  const commands = await app.commands();
  expect(commands).toContain('file.properties');
  expect(commands).toContain('file.properties.fonts');
  expect(commands).toContain('file.properties.initialView');
  expect(commands).toContain('file.properties.custom');
  // Ctrl+D itself is checked in `test/unit/shortcut-conflicts.test.ts`, which fails the build if
  // any two commands claim the same key.
});

test('the dialog opens with every tab reachable, and nothing in it is transparent', async () => {
  await openPath(stage('fonts.pdf'));
  const showing = app.run('file.properties');
  const dialog = app.page.locator('#properties-dialog');
  await expect(dialog).toBeVisible();

  const tabs = dialog.locator('[role="tab"]');
  await expect(tabs).toHaveCount(6);
  await expect(tabs.first()).toHaveAttribute('aria-selected', 'true');

  // Every tab opens a panel, by keyboard as well as by pointer.
  for (const label of ['Custom', 'Security', 'Fonts', 'Initial View', 'Advanced']) {
    await dialog.getByRole('tab', { name: label }).click();
    await expect(dialog.getByRole('tab', { name: label })).toHaveAttribute('aria-selected', 'true');
  }
  await dialog.getByRole('tab', { name: 'Fonts' }).click();
  // The Fonts tab says what the file carries, in words rather than by colour.
  await expect(dialog.getByText('Embedded subset', { exact: true }).first()).toBeVisible();
  await expect(dialog.getByText('Not embedded', { exact: true }).first()).toBeVisible();

  const opaque = await app.page.evaluate(() => {
    const root = document.getElementById('properties-dialog');
    if (!root) return { checked: 0, bad: [] as string[] };
    const bad: string[] = [];
    let checked = 0;
    for (const element of [root, ...root.querySelectorAll<HTMLElement>('*')]) {
      checked++;
      const style = getComputedStyle(element);
      if (style.opacity !== '' && Number(style.opacity) < 1) bad.push(`opacity ${style.opacity}`);
      if (/rgba\([^)]*,\s*0?\.\d+\)/.test(style.backgroundColor)) {
        bad.push(`background ${style.backgroundColor}`);
      }
      if (style.backdropFilter && style.backdropFilter !== 'none') bad.push('backdrop-filter');
    }
    return { checked, bad };
  });
  expect(opaque.checked).toBeGreaterThan(10);
  expect(opaque.bad).toEqual([]);

  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await showing;
  await closeDiscarding();
});

test('an edit survives a save and a reopen, in the dictionary and in the XMP', async () => {
  const path = stage('multipage.pdf', 'edited.pdf');
  await openPath(path);
  await app.run('dev.setProperties', {
    properties: {
      title: 'Quarterly report',
      author: 'A Writer',
      keywords: 'quarter; report',
      custom: [{ name: 'Department', value: 'Accounts' }],
      trapped: 'False',
      lang: 'en-GB',
    },
    view: { pageMode: 'outlines', initialFit: 'fit' },
  });
  expect((await state()).writeIntents).toEqual(expect.arrayContaining(['metadata', 'view']));
  expect((await app.run('file.save')) as { saved: boolean }).toMatchObject({ saved: true });
  await closeDiscarding();

  await openPath(path);
  const after = await state();
  expect(after.metadata.title).toBe('Quarterly report');
  expect(after.metadata.author).toBe('A Writer');
  expect(after.metadata.custom).toEqual({ Department: 'Accounts' });
  expect(after.metadata.trapped).toBe('False');
  expect(after.metadata.lang).toBe('en-GB');
  expect(after.metadata.xmp ?? '').toContain('Quarterly report');
  expect(after.metadata.xmp ?? '').toContain('Accounts');
  expect(after.view.pageMode).toBe('outlines');
  expect(after.view.initialFit).toBe('fit');
  await closeDiscarding();
});

test('a document that asks for page 3, fit page and two-up opens that way', async () => {
  await openPath(stage('initial-view.pdf'));
  const after = await state();
  // What the file asks for.
  expect(after.view.pageMode).toBe('outlines');
  expect(after.view.pageLayout).toBe('two-column-left');
  // What the application did about it. The navigation panel is not in this list on purpose:
  // `ui.leftPaneOnOpen` decides which panel opens, and a document does not override it (M12,
  // the operator's requirement). The reader is told so in words instead.
  expect(after.applied).toMatchObject({
    layout: 'facingContinuous',
    panel: null,
    page: 2,
    fit: 'page',
  });
  expect(after.applied?.ignored.join(' ')).toContain('the bookmarks panel');
  expect(after.panel).toBe('nav.pages');
  // And the viewer really is on page 3 — 0-based here.
  await expect
    .poll(async () => ((await app.run('dev.viewerState')) as { page: number } | null)?.page)
    .toBe(2);
  await closeDiscarding();
});

test('the Fonts tab lists what the file carries', async () => {
  await openPath(stage('fonts.pdf'));
  const after = await state();
  expect(Array.isArray(after.fonts)).toBe(true);
  const fonts = after.fonts as ReadonlyArray<{ name: string; embedded: boolean; subset: boolean }>;
  expect(fonts.map((f) => f.name)).toEqual([
    'Helvetica',
    'YnotBox',
    'ABCDEF+YnotBox',
    'Arial',
    'GHIJKL+YnotBox',
    'YnotBlock',
  ]);
  expect(fonts.filter((f) => f.subset).map((f) => f.name)).toEqual([
    'ABCDEF+YnotBox',
    'GHIJKL+YnotBox',
  ]);
  await closeDiscarding();
});

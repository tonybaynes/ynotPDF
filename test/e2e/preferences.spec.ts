/**
 * Preferences e2e (M130). Drives the real Electron app, because everything interesting about
 * this module only exists once there is a settings file on disk, a ribbon to customise and a
 * dispatcher to rebind.
 *
 * Acceptance (M130 brief):
 *
 * 1. Every setting every merged module exposes appears in the dialog, changes, persists across a
 *    restart and applies live where it is declared to; the search finds "tile cache".
 * 2. Rebinding Ctrl+F to Ctrl+Shift+F opens the find bar on the new key, and the conflict warns
 *    in words before it happens.
 * 3. The cheat-sheet PDF lists every binding.
 */

import { expect, test, type Locator } from '@playwright/test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchApp, type App } from './harness';
import { expectReadable } from './layout';
import { formatShortcut } from '../../src/renderer/core/Registry';

const FIXTURES = join(process.cwd(), 'test', 'fixtures');

/**
 * The app runs on the machine the test runs on, so `Mod` is Cmd on a Mac and Ctrl elsewhere —
 * both for the chord Playwright presses and for the text the editor shows. Using the app's own
 * formatter for the second means this file cannot drift from what the reader actually sees.
 */
const IS_MAC = process.platform === 'darwin';
/** The modifier name Playwright's `keyboard.press` wants for `Mod`. */
const MOD = IS_MAC ? 'Meta' : 'Control';
/** A normalised binding as the shortcut editor displays it on this platform. */
const shown = (key: string): string => formatShortcut(key, IS_MAC);

let app: App;
let scratch: string;

interface SheetResult {
  pageCount: number;
  commandCount: number;
  boundCount: number;
  name: string;
}

const dialog = (): Locator => app.page.locator('#preferences-dialog');
const setting = (key: string): Locator =>
  dialog().locator(`[data-setting="pref-${key.replace(/\./g, '-')}"]`);

/** Reads one setting straight from the store. */
const read = (key: string): Promise<unknown> => app.run('app.settings.get', { key });
/** Writes one setting through the same path the dialog uses (so it applies live too). */
const write = (key: string, value: unknown): Promise<unknown> =>
  app.run('app.settings.set', { key, value });

async function openPreferences(args: Record<string, unknown> = {}): Promise<void> {
  await app.run('app.preferences', args);
  await expect(dialog()).toBeVisible();
}

async function closePreferences(): Promise<void> {
  await app.run('app.preferences.close');
  await expect(dialog()).toBeHidden();
}

async function openFixture(name: string): Promise<void> {
  const file = join(FIXTURES, name);
  const bytes = Array.from(readFileSync(file));
  await app.run('file.openBytes', { file: { path: file, name, bytes } });
  await app.page.waitForSelector('.viewer-content .page');
}

test.beforeAll(async () => {
  app = await launchApp();
  scratch = mkdtempSync(join(tmpdir(), 'ynot-prefs-'));
  await app.electron.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setSize(1280, 900);
  });
});

test.afterAll(async () => {
  await app.close();
  rmSync(scratch, { recursive: true, force: true });
});

test.afterEach(async () => {
  await app.run('app.preferences.close').catch(() => undefined);
});

// ---- the dialog ---------------------------------------------------------------------------------

test.describe('the Preferences dialog', () => {
  test('opens from the command, the shortcut and the File tab’s slot', async () => {
    await openPreferences();
    await expect(dialog().locator('.prefs-title')).toBeVisible();
    await closePreferences();

    // The shortcut the manifest declares, pressed for real.
    await app.page.keyboard.press(`${MOD}+K`);
    await expect(dialog()).toBeVisible();
    await closePreferences();

    // The File tab draws a Preferences button from M02's backstage slot.
    await app.run('app.ribbon.showTab', { tab: 'file' }).catch(() => undefined);
    await app.page.locator('#ribbon-body [data-item="app.preferences"]').first().click();
    await expect(dialog()).toBeVisible();
  });

  test('lists a page for every module that has settings, with the operator’s names', async () => {
    await openPreferences();
    const labels = await dialog().locator('.prefs-cat span').allTextContents();
    for (const expected of [
      'General',
      'Appearance',
      'Page display',
      'Panels',
      'Commenting',
      'Keyboard shortcuts',
      'Ribbon and toolbar',
      'Settings file',
    ]) {
      expect(labels).toContain(expected);
    }
  });

  test('shows every setting on its page, and the operator’s left-pane choice in words', async () => {
    await openPreferences({ page: 'M12' });
    const pane = setting('ui.leftPaneOnOpen');
    await expect(pane).toBeVisible();
    await expect(pane.locator('select')).toHaveValue('pages');
    const options = await pane.locator('option').allTextContents();
    expect(options).toEqual(['Pages (thumbnails)', 'Bookmarks', 'The panel I used last', 'Closed']);
  });

  test('search finds "tile cache" — the operator’s words, not the module author’s', async () => {
    await openPreferences();
    await dialog().locator('#prefs-search').fill('tile cache');
    await expect(setting('viewer.cache.megabytes')).toBeVisible();
    await expect(dialog().locator('.prefs-search-summary')).toContainText('match');
    // The result says which page it lives on, so the search also teaches where things are.
    await expect(dialog().locator('.prefs-result-heading')).toContainText('Page display');
  });

  test('search says so, in words, when nothing matches', async () => {
    await openPreferences();
    await dialog().locator('#prefs-search').fill('zzzz no such setting');
    await expect(dialog().locator('.prefs-search-summary')).toContainText('No setting matches');
  });

  test('Escape clears the search before it closes the dialog', async () => {
    await openPreferences();
    const search = dialog().locator('#prefs-search');
    await search.fill('cache');
    await search.press('Escape');
    await expect(search).toHaveValue('');
    await expect(dialog()).toBeVisible();
  });
});

// ---- changing, persisting, applying -------------------------------------------------------------

test.describe('a setting changes, persists and applies', () => {
  test('a tick box writes the file and says the word "changed"', async () => {
    await openPreferences({ page: 'M30' });
    const row = setting('annot.showTooltips');
    const box = row.locator('input[type="checkbox"]');
    await expect(box).toBeChecked();
    await box.uncheck();
    await expect(row.locator('.pref-changed')).toContainText('Changed from the default');
    expect(await read('annot.showTooltips')).toBe(false);

    // "Put it back" is the per-setting reset, and the badge goes with it.
    await row.locator('.pref-changed button').click();
    await expect(row.locator('.pref-changed')).toHaveCount(0);
    expect(await read('annot.showTooltips')).toBeUndefined();
  });

  test('a number setting offers a slider as well as the figure, and both agree', async () => {
    await openPreferences({ page: 'M11' });
    const row = setting('viewer.cache.megabytes');
    await expect(row.locator('input[type="range"]')).toBeVisible();
    await row.locator('input[type="number"]').fill('512');
    await row.locator('input[type="number"]').blur();
    expect(await read('viewer.cache.megabytes')).toBe(512);
    await expect(row.locator('input[type="range"]')).toHaveValue('512');
  });

  test('a number is snapped to the step rather than refused', async () => {
    await openPreferences({ page: 'M11' });
    const number = setting('viewer.cache.megabytes').locator('input[type="number"]');
    await number.fill('137');
    await number.blur();
    expect(await read('viewer.cache.megabytes')).toBe(128);
  });

  test('the theme applies live, without a restart', async () => {
    await openPreferences({ page: 'M01' });
    await setting('theme.name').locator('select').selectOption('midnight');
    await expect(app.page.locator('html')).toHaveAttribute('data-theme', 'midnight');
    await setting('theme.name').locator('select').selectOption('graphite');
    await expect(app.page.locator('html')).toHaveAttribute('data-theme', 'graphite');
  });

  test('the UI scale applies live, and the dialog it is in scales with it', async () => {
    /** What `ThemeManager` writes on `<html>`; the root font size follows it. */
    const uiScale = (): Promise<string> =>
      app.page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue('--ui-scale').trim(),
      );
    const fontSize = (): Promise<string> =>
      app.page.evaluate(() => getComputedStyle(document.documentElement).fontSize);

    await openPreferences({ page: 'M01' });
    expect(await uiScale()).toBe('1');
    await setting('ui.scale').locator('input[type="number"]').fill('150');
    await setting('ui.scale').locator('input[type="number"]').blur();
    await expect.poll(uiScale).toBe('1.5');
    // The dialog holding the slider scales with it: everything in it is sized in rem.
    expect(await fontSize()).toBe('21px');
    // The alias in resources/preferences.json means the key M01 actually reads was written.
    expect(await read('ui.scale')).toBe(150);

    // Setting it back through Preferences, the same way the reader would.
    await setting('ui.scale').locator('input[type="number"]').fill('100');
    await setting('ui.scale').locator('input[type="number"]').blur();
    await expect.poll(uiScale).toBe('1');
    expect(await fontSize()).toBe('14px');
    await write('ui.scale', undefined);
  });

  test('the interface font applies live', async () => {
    await openPreferences({ page: 'M130' });
    await setting('app.uiFont').locator('select').selectOption('dejavu-sans');
    await expect
      .poll(() =>
        app.page.evaluate(() =>
          getComputedStyle(document.documentElement).getPropertyValue('--font-ui'),
        ),
      )
      .toContain('DejaVu Sans');
    await setting('app.uiFont').locator('select').selectOption('system');
  });

  test('the app-wide unit is written to the ruler key M11 reads as well', async () => {
    await app.run('app.units.set', { value: 'in' });
    expect(await read('app.units')).toBe('in');
    expect(await read('viewer.rulers.units')).toBe('in');
    await app.run('app.units.set', { value: 'mm' });
  });

  test('the identity is written where the annotation module looks for it', async () => {
    await openPreferences({ page: 'M130' });
    const name = setting('identity.name').locator('input');
    await name.fill('Test Operator');
    await name.blur();
    expect(await read('identity.name')).toBe('Test Operator');
    // Declared as app.identity.name, stored as identity.name — the alias, working.
    expect(await read('app.identity.name')).toBe('Test Operator');
  });

  test('a page resets only its own settings', async () => {
    await write('viewer.grid', true);
    await write('annot.showTooltips', false);
    await openPreferences({ page: 'M11' });
    await dialog().locator('.prefs-page-actions button').click();
    await app.page.locator('.dlg-messagebox button:has-text("Reset the page")').click();
    await expect.poll(() => read('viewer.grid')).toBeUndefined();
    expect(await read('annot.showTooltips')).toBe(false);
    await write('annot.showTooltips', undefined);
  });

  test('advanced settings are hidden until they are asked for', async () => {
    await openPreferences();
    const box = dialog().locator('#prefs-advanced');
    await expect(box).not.toBeChecked();
    await box.check();
    await expect(box).toBeChecked();
    await box.uncheck();
  });
});

test('a setting survives a restart', async () => {
  await write('viewer.cache.megabytes', 384);
  await app.close();
  app = await launchApp({ reuseUserData: true });
  expect(await read('viewer.cache.megabytes')).toBe(384);
  await write('viewer.cache.megabytes', undefined);
});

// ---- shortcuts ----------------------------------------------------------------------------------

test.describe('the shortcut editor', () => {
  test.afterEach(async () => {
    await app.run('app.shortcuts.reset');
  });

  test('lists every command with its key, and finds one by name', async () => {
    await openPreferences({ page: 'shortcuts' });
    await dialog().locator('#shortcut-search').fill('Find');
    const row = dialog().locator('.shortcut-row[data-command="edit.find"]');
    await expect(row).toBeVisible();
    await expect(row.locator('kbd')).toHaveText(shown('Mod+F'));
  });

  test('the brief’s case: Ctrl+F becomes Ctrl+Shift+F, the conflict warns in words', async () => {
    await openFixture('text.pdf');
    await openPreferences({ page: 'shortcuts' });
    await dialog().locator('#shortcut-search').fill('Find');
    const row = dialog().locator('.shortcut-row[data-command="edit.find"]');
    await row.locator('button:has-text("Change")').click();
    await app.page.keyboard.press(`${MOD}+Shift+F`);

    // Ctrl+Shift+F is M13's folder search, so the reader is told whose key they are taking.
    const warning = app.page.locator('.dlg-messagebox');
    await expect(warning).toBeVisible();
    await expect(warning).toContainText('already taken');
    await expect(warning).toContainText('Search');
    await warning.locator('button:has-text("Use it here")').click();

    await expect(row.locator('kbd')).toHaveText(shown('Mod+Shift+F'));
    await expect(dialog().locator('.shortcut-status')).toContainText('now runs');
    await closePreferences();

    // The new key opens the find bar…
    await app.page.locator('#doc-area').click();
    await app.page.keyboard.press(`${MOD}+Shift+F`);
    await expect(app.page.locator('#find-bar')).toBeVisible();
    await app.run('edit.findClose');
    await expect(app.page.locator('#find-bar')).toBeHidden();

    // …and the old one does nothing, because it was genuinely unbound.
    await app.page.keyboard.press(`${MOD}+F`);
    await expect(app.page.locator('#find-bar')).toBeHidden();

    await app.run('app.tabs.closeAll');
  });

  test('Escape while recording changes nothing', async () => {
    await openPreferences({ page: 'shortcuts' });
    await dialog().locator('#shortcut-search').fill('Find');
    const row = dialog().locator('.shortcut-row[data-command="edit.find"]');
    await row.locator('button:has-text("Change")').click();
    await app.page.keyboard.press('Escape');
    await expect(dialog()).toBeVisible();
    await expect(row.locator('kbd')).toHaveText(shown('Mod+F'));
  });

  test('a rebinding survives a restart, and Reset all puts it back', async () => {
    await app.run('app.shortcuts.set', { command: 'edit.find', key: 'Mod+Alt+Y' });
    await app.close();
    app = await launchApp({ reuseUserData: true });
    await openPreferences({ page: 'shortcuts' });
    await dialog().locator('#shortcut-search').fill('Find');
    await expect(dialog().locator('.shortcut-row[data-command="edit.find"] kbd')).toHaveText(
      shown('Mod+Alt+Y'),
    );
    await app.run('app.shortcuts.reset');
    await expect(dialog().locator('.shortcut-row[data-command="edit.find"] kbd')).toHaveText(
      shown('Mod+F'),
    );
  });

  test('the cheat sheet lists every binding and opens as a document', async () => {
    const sheet = (await app.run('app.shortcuts.cheatSheet')) as SheetResult;
    const commands = await app.commands();
    expect(sheet.commandCount).toBeGreaterThan(100);
    expect(sheet.commandCount).toBeLessThanOrEqual(commands.length);
    expect(sheet.boundCount).toBeGreaterThan(30);
    expect(sheet.pageCount).toBeGreaterThanOrEqual(1);
    expect(sheet.name).toMatch(/shortcuts\.pdf$/);
    // It arrives as an unsaved document, the way the comment summary does.
    await app.page.waitForSelector('.viewer-content .page');
    await app.run('app.tabs.closeAll');
  });

  test('shortcuts import as JSON, and a command this build lacks is left out', async () => {
    // Export writes through a native save dialog, which an e2e run cannot answer, so the import
    // side is driven with the text directly — the same shape the export command produces.
    const imported = await app.run('app.shortcuts.import', {
      text: JSON.stringify({
        kind: 'ynotPDF-shortcuts',
        version: 1,
        exported: new Date().toISOString(),
        bindings: { 'edit.find': 'Mod+Alt+Y', 'no.such.command': 'Mod+Alt+Z' },
      }),
    });
    expect(imported).toBe(1);
    await openPreferences({ page: 'shortcuts' });
    await dialog().locator('#shortcut-search').fill('Find');
    await expect(dialog().locator('.shortcut-row[data-command="edit.find"] kbd')).toHaveText(
      shown('Mod+Alt+Y'),
    );
  });
});

// ---- the ribbon and the toolbar -----------------------------------------------------------------

test.describe('customising the ribbon and the toolbar', () => {
  test.afterEach(async () => {
    await app.run('app.customise.reset');
  });

  test('unticking a group takes it off the ribbon, and ticking it puts it back', async () => {
    await app.run('app.ribbon.showTab', { tab: 'view' });
    const group = app.page.locator('#ribbon-body [data-group="view.panes"]');
    await expect(group).toHaveCount(1);

    await openPreferences({ page: 'customise' });
    const row = dialog().locator(
      '.customise-group[data-group="view.panes"] input[type="checkbox"]',
    );
    await row.uncheck();
    await closePreferences();
    await expect(group).toHaveCount(0);

    await openPreferences({ page: 'customise' });
    await dialog()
      .locator('.customise-group[data-group="view.panes"] input[type="checkbox"]')
      .check();
    await closePreferences();
    await expect(group).toHaveCount(1);
  });

  test('a hidden group stays hidden across a restart', async () => {
    await openPreferences({ page: 'customise' });
    await dialog()
      .locator('.customise-group[data-group="view.panes"] input[type="checkbox"]')
      .uncheck();
    await app.close();
    app = await launchApp({ reuseUserData: true });
    await app.run('app.ribbon.showTab', { tab: 'view' });
    await expect(app.page.locator('#ribbon-body [data-group="view.panes"]')).toHaveCount(0);
  });

  test('a command can be added to the quick-access toolbar and taken off again', async () => {
    await openPreferences({ page: 'customise' });
    await dialog().locator('.customise-qat-picker').selectOption('app.preferences');
    await dialog().locator('.customise-qat-add-btn').click();
    await closePreferences();
    await expect(app.page.locator('#qat [data-qat="app.preferences"]')).toHaveCount(1);

    await openPreferences({ page: 'customise' });
    await dialog()
      .locator('.customise-qat li[data-qat="app.preferences"] button[title="Remove"]')
      .click();
    await closePreferences();
    await expect(app.page.locator('#qat [data-qat="app.preferences"]')).toHaveCount(0);
  });

  test('the reset command puts the whole ribbon and toolbar back', async () => {
    await openPreferences({ page: 'customise' });
    await dialog()
      .locator('.customise-group[data-group="view.panes"] input[type="checkbox"]')
      .uncheck();
    await closePreferences();
    await app.run('app.customise.reset');
    await app.run('app.ribbon.showTab', { tab: 'view' });
    await expect(app.page.locator('#ribbon-body [data-group="view.panes"]')).toHaveCount(1);
  });
});

// ---- the settings file --------------------------------------------------------------------------

test.describe('the settings file', () => {
  test('says where it is, and export/import round-trips through it', async () => {
    await openPreferences({ page: 'settings-file' });
    await expect(dialog().locator('.prefs-file-path')).toContainText('settings.json');

    await write('theme.name', 'high-contrast');
    const exported = (await app.run('app.settings.get', { key: 'theme.name' })) as string;
    expect(exported).toBe('high-contrast');

    await app.run('app.settings.import', {
      text: JSON.stringify({
        kind: 'ynotPDF-settings',
        version: 1,
        exported: new Date().toISOString(),
        settings: { 'theme.name': 'daylight', 'viewer.grid': true },
      }),
    });
    await expect(app.page.locator('html')).toHaveAttribute('data-theme', 'daylight');
    expect(await read('viewer.grid')).toBe(true);

    await app.run('view.theme.set', { theme: 'graphite' });
    await write('viewer.grid', undefined);
  });

  test('refuses a file that is not a settings export, in a sentence', async () => {
    // The command waits for the error dialog to be dismissed, so the run is not awaited yet.
    const running = app.run('app.settings.import', { text: '%PDF-1.7 not json' });
    const error = app.page.locator('.dlg-messagebox');
    await expect(error).toBeVisible();
    await expect(error).toContainText('not JSON');
    await error.locator('button:has-text("OK")').click();
    expect(await running).toBeNull();
  });

  test('Reset everything puts every setting back, with a warning first', async () => {
    await write('viewer.grid', true);
    await write('annot.showTooltips', false);
    const cancelled = app.run('app.settings.reset');
    const warning = app.page.locator('.dlg-messagebox');
    await expect(warning).toBeVisible();
    await expect(warning).toContainText('cannot be undone');
    await warning.locator('button:has-text("Cancel")').click();
    expect(await cancelled).toBe(false);
    expect(await read('viewer.grid')).toBe(true);

    expect(await app.run('app.settings.reset', { confirm: true })).toBe(true);
    expect(await read('viewer.grid')).toBeUndefined();
    expect(await read('annot.showTooltips')).toBeUndefined();
  });
});

// ---- the language switch ------------------------------------------------------------------------

test.describe('language', () => {
  test.afterEach(async () => {
    await app.run('app.language.set', { value: 'en-GB' });
  });

  test('switching to American English respells the interface', async () => {
    await openPreferences({ page: 'M130' });
    await expect(dialog().locator('.prefs-cats-heading').last()).toHaveText(
      'Customisation and files',
    );
    await setting('app.language').locator('select').selectOption('en-US');
    await closePreferences();
    await openPreferences({ page: 'M130' });
    await expect(dialog().locator('.prefs-cats-heading').last()).toHaveText(
      'Customization and files',
    );
    await expect(app.page.locator('html')).toHaveAttribute('lang', 'en-US');
    // And the unit labels, which is where the operator would actually notice it.
    const units = await setting('app.units').locator('option').allTextContents();
    expect(units).toContain('Millimeters');
  });
});

// ---- accessibility ------------------------------------------------------------------------------

test.describe('the dialog obeys the operator’s rules', () => {
  test('nothing in it is translucent, and every word in it is readable', async () => {
    await openPreferences();
    // M04's shared check, rather than a fifth copy of the walk: no `opacity < 1`, no `rgba()`
    // alpha, no `backdrop-filter` — fully transparent is fine, *partly* transparent is what the
    // rule forbids — plus 4.5:1 on every piece of text.
    await expectReadable(dialog());
  });

  test('every control is reachable by keyboard and shows a focus ring', async () => {
    await openPreferences({ page: 'M11' });
    await dialog().locator('.prefs-cat').first().focus();
    const outline = await app.page.evaluate(() => {
      const active = document.activeElement as HTMLElement | null;
      if (!active) return '';
      active.classList.add('focus-visible');
      return getComputedStyle(active).outlineWidth;
    });
    expect(outline).not.toBe('');
  });

  test('a changed setting says the word, not just a colour', async () => {
    await write('viewer.grid', true);
    await openPreferences({ page: 'M11' });
    await expect(setting('viewer.grid').locator('.pref-changed')).toContainText('Changed');
    await write('viewer.grid', undefined);
  });
});

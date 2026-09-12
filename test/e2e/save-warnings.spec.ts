/** Audit 2: exercise an actual pipeline warning through the visible Save button. */
import { expect, test } from '@playwright/test';
import { realpathSync, copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchApp } from './harness';
import { journey, closeEverything } from './journey';
import { expectInsideWindow, expectReadable } from './layout';

test('Save reviews pipeline warnings before writing; Escape cancels and consent retains unsaved work', async () => {
  const workspace = realpathSync.native(mkdtempSync(join(tmpdir(), 'ynot-save-warnings-')));
  const path = join(workspace, 'warnings.pdf');
  copyFileSync(join(process.cwd(), 'test/fixtures/multipage.pdf'), path);
  const original = readFileSync(path);
  const app = await launchApp({ noDemo: true });
  await app.grantPath(workspace, true);
  try {
    const j = journey(app);
    await app.run('file.openRecent', { path });
    // Real incompatible save options generate a real M100 stage warning, with M70 still
    // encrypting the bytes. The test injects neither a warning nor a bypass into production.
    await app.run('dev.setSecurity', {
      kind: 'password',
      algorithm: 'aes-256',
      user: 'audit-open',
      owner: 'audit-owner',
    });
    await app.run('optimise.fastWebView.toggle', { on: true });
    await app.run('file.autosaveNow');
    const records = await app.run('dev.recoveryList');
    await j.clickRibbon('home', 'Save');
    const dialog = app.page.locator('#save-warnings-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('Fast web view was not applied');
    await expect(dialog).toContainText('Nothing has been written');
    await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
    await expectInsideWindow(dialog);
    await expectReadable(dialog);
    expect(readFileSync(path)).toEqual(original);
    await app.page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
    expect(readFileSync(path)).toEqual(original);
    expect(await app.run('dev.recoveryList')).toEqual(records);
    expect(await app.run('dev.saveState')).toMatchObject({ dirty: true });

    await j.clickRibbon('home', 'Save');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Save with these warnings', exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await expect.poll(() => readFileSync(path).equals(original)).toBe(false);
    expect(await app.run('dev.saveState')).toMatchObject({ dirty: true });
    expect(await app.run('dev.recoveryList')).toEqual(records);
  } finally {
    await closeEverything(app);
    await app.close();
    rmSync(workspace, { recursive: true, force: true });
  }
});

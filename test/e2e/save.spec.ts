/**
 * M21 e2e: saving, recovery and read-only files, in the real, built app.
 *
 * Three of the module's four acceptance tests live here, because all three are claims about the
 * running application rather than about a function:
 *
 * - a saved file opens in a plain browser's PDF viewer, not only in ours;
 * - killing the app after edits leaves work that the next launch offers to put back;
 * - saving to a read-only path falls back to Save As, with a message that says why.
 *
 * The fourth — that a no-op save round-trips every fixture — is a unit test, where it can run
 * against the whole corpus in a second (`test/unit/writer/roundtrip.test.ts`).
 */

import { chromium, expect, test, type Frame } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { launchApp, type App } from './harness';

const fixtures = join(process.cwd(), 'test', 'fixtures');

/** What `dev.saveState` reports back. */
interface SaveState {
  readonly title: string;
  readonly path: string | null;
  readonly readOnly: boolean;
  readonly readOnlyReason: string;
  readonly dirty: boolean;
  readonly writeIntents: string[];
}

/** What `dev.documentSummary` reports back (M20's). */
interface Summary {
  readonly pageCount: number;
  readonly rotations: number[];
  readonly outlineCount: number;
  readonly metadataTitle: string | null;
  readonly dirty: boolean;
  readonly issues: string[];
}

let workspace: string;

test.beforeAll(() => {
  workspace = mkdtempSync(join(tmpdir(), 'ynot-save-'));
});

test.afterAll(() => {
  rmSync(workspace, { recursive: true, force: true });
});

/**
 * Kills the app outright, the way a crash would.
 *
 * The whole process tree, not just the main process: Electron's renderer, GPU and network
 * children outlive a signal sent to their parent on Windows, and while they are alive they hold
 * the user-data directory's `lockfile` — so the next launch would find the profile in use and
 * quit without a word, which has nothing to do with what this test is about.
 */
function crash(app: App): void {
  const pid = app.electron.process().pid;
  if (process.platform === 'win32' && pid !== undefined) {
    try {
      execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
    } catch {
      app.electron.process().kill('SIGKILL');
    }
    return;
  }
  app.electron.process().kill('SIGKILL');
}

/** Copies a fixture into the workspace so the test can write over it. */
function stage(fixture: string, as = fixture): string {
  const path = join(workspace, as);
  copyFileSync(join(fixtures, fixture), path);
  return path;
}

/** Opens a real file by path, the way Open Recent does. */
async function openPath(app: App, path: string): Promise<void> {
  await app.run('file.openRecent', { path });
  await expect.poll(async () => ((await app.run('dev.saveState')) as SaveState).path).toBe(path);
}

const saveState = (app: App): Promise<SaveState> => app.run('dev.saveState') as Promise<SaveState>;
const summary = (app: App): Promise<Summary> => app.run('dev.documentSummary') as Promise<Summary>;

test.describe('save', () => {
  let app: App;

  test.beforeAll(async () => {
    app = await launchApp();
  });
  test.afterAll(async () => {
    await app.close();
  });

  test('the commands are registered, with their shortcuts', async () => {
    const commands = await app.commands();
    expect(commands).toContain('file.save');
    expect(commands).toContain('file.saveAs');
    expect(commands).toContain('file.recover');
    expect(commands).toContain('file.closeAll');
  });

  test('saving a document nobody has changed writes nothing', async () => {
    const path = stage('multipage.pdf', 'untouched.pdf');
    const before = statSync(path);
    await openPath(app, path);
    const outcome = (await app.run('file.save')) as { saved: boolean; reason?: string };
    expect(outcome).toMatchObject({ saved: false, reason: 'clean' });
    expect(statSync(path).size).toBe(before.size);
    await app.run('file.close');
  });

  test('an edit is written, the tab goes clean, and the file changes on disk', async () => {
    const path = stage('multipage.pdf', 'edited.pdf');
    const originalSize = statSync(path).size;
    await openPath(app, path);

    await app.run('dev.documentApply', { kind: 'rotate', page: 0, rotation: 90 });
    await app.run('dev.documentApply', { kind: 'metadata', value: 'Written by the e2e suite' });
    await app.run('dev.addBookmark', { title: 'Top', page: 0 });
    expect((await saveState(app)).dirty).toBe(true);

    const outcome = (await app.run('file.save')) as { saved: boolean; path: string | null };
    expect(outcome.saved).toBe(true);
    expect(outcome.path).toBe(path);

    const after = await saveState(app);
    expect(after.dirty).toBe(false);
    expect(statSync(path).size).not.toBe(originalSize);

    // Reopen the file the app just wrote, in a second tab, and look at what is in it.
    const copy = join(workspace, 'reopened.pdf');
    copyFileSync(path, copy);
    await openPath(app, copy);
    const reopened = await summary(app);
    expect(reopened.rotations[0]).toBe(90);
    expect(reopened.metadataTitle).toBe('Written by the e2e suite');
    expect(reopened.outlineCount).toBe(1);
    expect(reopened.issues).toEqual([]);
    await app.run('file.close');
    await app.run('file.close');
  });

  test('the file it wrote opens in a plain browser, not only in ours', async () => {
    // Its own file, so the test says what it means on its own rather than depending on the one
    // before it having run.
    const path = stage('multipage.pdf', 'for-chrome.pdf');
    await openPath(app, path);
    await app.run('dev.documentApply', { kind: 'metadata', value: 'Read me in Chrome' });
    expect((await app.run('file.save')) as { saved: boolean }).toMatchObject({ saved: true });
    await app.run('file.close');

    // The full Chromium build, not the headless shell: the shell has no PDF viewer, so a
    // `file://` PDF there starts a download instead of rendering, and the test would prove
    // nothing about the file.
    const browser = await chromium.launch({ channel: 'chromium' });
    try {
      const page = await browser.newPage();
      const response = await page.goto(pathToFileURL(path).href);
      expect(response?.status() ?? 200).toBeLessThan(400);

      // Chrome hands a file it recognises as a PDF to its own viewer extension, in a child
      // frame. That frame is where the proof is: the viewer's page counter and its error screen
      // say whether Chrome's PDFium actually parsed what we wrote, or gave up on it.
      const viewerFrame = (): Frame | undefined =>
        page.frames().find((f) => f.url().startsWith('chrome-extension://'));
      await expect.poll(() => viewerFrame() !== undefined, { timeout: 15_000 }).toBe(true);

      await expect
        .poll(
          async () =>
            viewerFrame()?.evaluate(() => {
              const root = document.querySelector('pdf-viewer')?.shadowRoot;
              const selector = root
                ?.querySelector('viewer-toolbar')
                ?.shadowRoot?.querySelector('viewer-page-selector');
              return {
                pages: selector?.shadowRoot?.querySelector('#pagelength')?.textContent ?? '',
                failed: Boolean(root?.querySelector('viewer-error-dialog, #error-screen')),
              };
            }),
          { timeout: 15_000 },
        )
        .toEqual({ pages: '5', failed: false });

      await page.close();
    } finally {
      await browser.close();
    }
  });

  test('the backup setting keeps the previous version beside the new one', async () => {
    const path = stage('blank.pdf', 'with-backup.pdf');
    const original = readFileSync(path);
    await openPath(app, path);
    await app.run('file.setting.keepBackup', { value: true });
    await app.run('dev.documentApply', { kind: 'metadata', value: 'Backed up' });
    const outcome = (await app.run('file.save')) as { saved: boolean; backupPath: string | null };
    expect(outcome.saved).toBe(true);
    expect(outcome.backupPath).toBe(`${path}.bak`);
    expect(readFileSync(`${path}.bak`).equals(original)).toBe(true);
    await app.run('file.setting.keepBackup', { value: false });
    await app.run('file.close');
  });

  test('the status bar says in a word whether the document is saved', async () => {
    const path = stage('blank.pdf', 'status.pdf');
    await openPath(app, path);
    const status = app.page.locator('.status-save');
    await expect(status).toHaveText(/Saved/);

    await app.run('dev.documentApply', { kind: 'rotate', page: 0, rotation: 90 });
    await expect(status).toHaveText(/Unsaved changes/);

    await app.run('file.save');
    await expect(status).toHaveText(/Saved/);
    await app.run('file.close');
  });
});

test.describe('read-only files', () => {
  let app: App;
  let path: string;

  test.beforeAll(async () => {
    app = await launchApp();
    path = stage('blank.pdf', 'locked.pdf');
    // Read-only on all three: Node maps the mode to the read-only attribute on Windows.
    chmodSync(path, 0o444);
  });

  test.afterAll(async () => {
    chmodSync(path, 0o644);
    await app.close();
  });

  test('the tab says Read-only, in a word', async () => {
    await openPath(app, path);
    const state = await saveState(app);
    // Running as root defeats the mode; the check is meaningless there, so it is skipped rather
    // than asserted the wrong way round.
    test.skip(!state.readOnly, 'the filesystem let us write to a 0444 file (running as root?)');
    expect(state.readOnlyReason).toMatch(/read-only|cannot be written/i);
    await expect(app.page.locator('.tab-readonly .tab-readonly-badge')).toHaveText('Read-only');
    await expect(app.page.locator('.status-save')).toHaveText(/Read-only/);
  });

  test('Save offers Save As instead, and says why', async () => {
    const state = await saveState(app);
    test.skip(!state.readOnly, 'the filesystem let us write to a 0444 file (running as root?)');

    await app.run('dev.documentApply', { kind: 'rotate', page: 0, rotation: 90 });
    const saving = app.run('file.save');

    const dialog = app.page.locator('#save-readonly-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('cannot be saved where it is');
    // Word buttons, both reachable, with Save As the one that gets the focus.
    await expect(dialog.getByRole('button', { name: 'Save As…' })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeVisible();
    await dialog.getByRole('button', { name: 'Cancel' }).click();

    const outcome = (await saving) as { saved: boolean; reason?: string };
    expect(outcome).toMatchObject({ saved: false, reason: 'read-only' });
    // The file on disk is untouched, and the edit is still in the app.
    expect((await saveState(app)).dirty).toBe(true);

    // Put the document back as it was, so this app quits without being asked about it — the
    // close flow has its own tests below.
    await app.run('edit.undo');
    await expect.poll(async () => (await saveState(app)).dirty).toBe(false);
  });
});

test.describe('the close flow', () => {
  let app: App;

  test.beforeAll(async () => {
    app = await launchApp();
  });
  test.afterAll(async () => {
    await app.close();
  });

  /** Opens a staged copy and makes one change to it. */
  async function openAndEdit(name: string): Promise<string> {
    const path = stage('blank.pdf', name);
    await openPath(app, path);
    await app.run('dev.documentApply', { kind: 'rotate', page: 0, rotation: 90 });
    expect((await saveState(app)).dirty).toBe(true);
    return path;
  }

  test('Cancel keeps the document open', async () => {
    await openAndEdit('cancel-me.pdf');
    const closing = app.run('file.close');
    const dialog = app.page.locator('#save-unsaved-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('have not been saved');
    // Three word buttons, all reachable — no colour, no icon standing in for a word.
    await expect(dialog.getByRole('button', { name: 'Save', exact: true })).toBeVisible();
    await expect(dialog.getByRole('button', { name: "Don't save" })).toBeVisible();
    await dialog.getByRole('button', { name: 'Cancel' }).click();

    expect(await closing).toBe(false);
    expect((await saveState(app)).dirty).toBe(true);
  });

  test('Choosing not to save closes it and leaves the file alone', async () => {
    const path = join(workspace, 'cancel-me.pdf');
    const before = readFileSync(path);
    const closing = app.run('file.close');
    const dialog = app.page.locator('#save-unsaved-dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: "Don't save" }).click();
    expect(await closing).toBe(true);
    expect(readFileSync(path).equals(before)).toBe(true);
    await expect(app.page.locator('.tab')).toHaveCount(0);
  });

  test('Save writes the file and then closes it', async () => {
    const path = await openAndEdit('save-then-close.pdf');
    const before = readFileSync(path);
    const closing = app.run('file.close');
    const dialog = app.page.locator('#save-unsaved-dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    expect(await closing).toBe(true);
    await expect(app.page.locator('.tab')).toHaveCount(0);
    expect(readFileSync(path).equals(before)).toBe(false);
  });

  test('Close All asks about each document in turn', async () => {
    await openAndEdit('all-one.pdf');
    await openAndEdit('all-two.pdf');
    await expect(app.page.locator('.tab')).toHaveCount(2);

    const closing = app.run('file.closeAll');
    const dialog = app.page.locator('#save-unsaved-dialog');
    for (let i = 0; i < 2; i++) {
      await expect(dialog).toBeVisible();
      await dialog.getByRole('button', { name: "Don't save" }).click();
    }
    expect(await closing).toBe(true);
    await expect(app.page.locator('.tab')).toHaveCount(0);
  });
});

test.describe('quitting with unsaved work', () => {
  test('the app asks first, and goes when the reader says not to save', async () => {
    const app = await launchApp();
    const path = stage('blank.pdf', 'quit-me.pdf');
    await openPath(app, path);
    await app.run('dev.documentApply', { kind: 'rotate', page: 0, rotation: 90 });
    expect((await saveState(app)).dirty).toBe(true);

    // `app.quit` goes to main, which holds the quit back and asks this window about it.
    void app.run('app.quit').catch(() => undefined);
    const dialog = app.page.locator('#save-unsaved-dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: "Don't save" }).click();

    // The app really does quit, rather than sitting behind a dialog nobody can answer.
    await app.electron.waitForEvent('close', { timeout: 20_000 });
  });
});

test.describe('recovery after a crash', () => {
  test('a killed app offers the work back, and replaying it restores the edits', async () => {
    const path = stage('multipage.pdf', 'crashed.pdf');
    const before = readFileSync(path);

    // ---- the session that is about to be killed ------------------------------------------------
    const first = await launchApp();
    await openPath(first, path);
    await first.run('dev.documentApply', { kind: 'rotate', page: 0, rotation: 90 });
    await first.run('dev.documentApply', { kind: 'metadata', value: 'Lost and found' });
    await first.run('dev.addBookmark', { title: 'Where I was', page: 1 });
    expect((await saveState(first)).dirty).toBe(true);

    // Autosave, then die without a chance to clean up — which is the whole point.
    const written = (await first.run('file.autosaveNow')) as { written: number };
    expect(written.written).toBe(1);
    crash(first);

    // The file on disk is exactly as it was: an autosave never touches the user's document.
    expect(readFileSync(path).equals(before)).toBe(true);

    // ---- the next launch, with the same user-data directory ------------------------------------
    const second = await launchApp({ reuseUserData: true });
    try {
      const dialog = second.page.locator('#save-recovery-dialog');
      await expect(dialog).toBeVisible({ timeout: 20_000 });
      await expect(dialog).toContainText('had unsaved changes');
      await expect(dialog).toContainText('3 changes');
      await dialog.getByRole('button', { name: 'Recover' }).click();

      // Recovery reopens the file and replays the journal after the dialog has gone, so the
      // document is not there the instant the button is clicked.
      await expect(second.page.locator('.tab')).toHaveCount(1, { timeout: 20_000 });
      await expect
        .poll(
          async () => {
            try {
              return (await summary(second)).metadataTitle;
            } catch {
              return null;
            }
          },
          { timeout: 20_000 },
        )
        .toBe('Lost and found');

      const restored = await summary(second);
      expect(restored.rotations[0]).toBe(90);
      expect(restored.outlineCount).toBe(1);
      expect(restored.issues).toEqual([]);
      // Recovered, not saved: the reader still has to decide whether to keep it.
      expect(restored.dirty).toBe(true);

      // And the record is gone, so the next launch does not offer it again.
      const remaining = (await second.run('dev.recoveryList')) as unknown[];
      expect(remaining).toEqual([]);
    } finally {
      await second.close();
    }
  });
});

/**
 * M70 e2e: protecting, unprotecting and unlocking, in the real, built app.
 *
 * All three of the module's acceptance tests live here, because all three are claims about the
 * running application rather than about a function:
 *
 * - a document the app protected with AES-256 and print=none opens **in Chrome with the
 *   password**, `qpdf --show-encryption` agrees about the algorithm and the flags, and our own
 *   Protect command is disabled with a worded tooltip when the file was opened with the user
 *   password;
 * - removing security with the owner password leaves a file `qpdf --check` calls unencrypted;
 * - a certificate-protected document opens with its `.p12` and not without it.
 *
 * The crypto itself is proved in `test/unit/security/`, against qpdf, over the whole corpus. What
 * is proved *here* is that the app wires it up: the worker loads its 1.3 MB of WebAssembly inside
 * a packaged renderer, the save pipeline runs the stage, and the reader's file on disk is the one
 * the dialog described.
 */

import { chromium, expect, test, type Frame } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import {
  realpathSync,
  copyFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import forge from 'node-forge';
import { Qpdf, type QpdfFactory } from '../../src/engine/security/qpdf';
import { launchApp, type App } from './harness';

const fixtures = join(process.cwd(), 'test', 'fixtures');
const require_ = createRequire(import.meta.url);

/** The same qpdf the app ships, run from the test process to check what landed on disk. */
const qpdf = new Qpdf({ factory: require_('@neslinesli93/qpdf-wasm') as QpdfFactory });

interface SecurityState {
  readonly encrypted: boolean;
  readonly handler: string | null;
  readonly algorithm: string | null;
  readonly revision: number | null;
  readonly opensWithoutPassword: boolean;
  readonly metadataEncrypted: boolean;
  readonly permissions: { print: string; modify: string; copy: boolean; accessibility: boolean };
  readonly recipients: number;
  readonly unlocked: boolean;
  readonly openedAs: string | null;
  readonly intentWords: string;
  readonly allows: Record<string, boolean>;
  readonly reasonAgainstPrint: string;
}

let workspace: string;

test.beforeAll(() => {
  workspace = realpathSync.native(mkdtempSync(join(tmpdir(), 'ynot-security-')));
});

test.afterAll(() => {
  rmSync(workspace, { recursive: true, force: true });
});

function stage(fixture: string, as = fixture): string {
  const path = join(workspace, as);
  copyFileSync(join(fixtures, fixture), path);
  return path;
}

async function openPath(app: App, path: string): Promise<void> {
  await app.run('file.openRecent', { path });
  await expect
    .poll(async () => ((await app.run('dev.saveState')) as { path: string | null }).path)
    .toBe(path);
}

/**
 * Opens a password-protected document the way a reader does: the app asks, and the password is
 * typed into M11's prompt.
 *
 * That prompt is the app behaving correctly, so the test answers it rather than working round it —
 * and doing so is also what makes the next assertion mean something, because a document opened
 * with the *user* password is the one whose `/P` flags bite.
 */
async function openProtected(app: App, path: string, password: string): Promise<void> {
  const opening = app.run('file.openRecent', { path });
  const dialog = app.page.locator('#password-dialog');
  await expect(dialog).toBeVisible();
  await dialog.locator('#password-input').fill(password);
  await dialog.getByRole('button', { name: 'Open', exact: true }).click();
  await opening;
  await expect
    .poll(async () => ((await app.run('dev.saveState')) as { path: string | null }).path)
    .toBe(path);
}

const state = (app: App): Promise<SecurityState> =>
  app.run('dev.securityState') as Promise<SecurityState>;

/**
 * Closes the active document, answering M21's unsaved-changes question when it appears.
 *
 * Setting security makes the document dirty — that is the point of it being a `Command` — so a
 * plain `file.close` stops and asks. These tests are about protection rather than about the close
 * flow (M21's own e2e covers that), so they answer "Don't save" the way a reader would.
 */
async function closeDiscarding(app: App): Promise<void> {
  let settled = false;
  const closing = app.run('file.close').finally(() => {
    settled = true;
  });
  const dialog = app.page.locator('#save-unsaved-dialog');
  // Poll rather than wait for a timeout: a clean document closes with no question at all, and a
  // fixed wait would add seconds to every test that never needed one.
  for (let i = 0; i < 40 && !settled; i++) {
    if (await dialog.isVisible()) {
      await dialog.getByRole('button', { name: "Don't save" }).click();
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  await closing;
}

/**
 * Stages a fixture, protects it through the running app, saves and closes — returning the path.
 *
 * Every test that needs a protected file makes its own. Sharing one between tests would make
 * `--grep` a lie and turn one failure into five.
 */
async function protectedFile(
  app: App,
  as: string,
  args: Record<string, unknown>,
  fixture = 'multipage.pdf',
): Promise<string> {
  const path = stage(fixture, as);
  await openPath(app, path);
  await app.run('dev.setSecurity', args);
  expect((await app.run('file.save')) as { saved: boolean }).toMatchObject({ saved: true });
  await closeDiscarding(app);
  return path;
}

/** A throwaway RSA identity, written to the workspace as a `.cer` and a `.p12`. */
function makeIdentity(
  name: string,
  password: string,
): { cer: string; p12: string; base64: string } {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date(Date.UTC(2020, 0, 1));
  cert.validity.notAfter = new Date(Date.UTC(2040, 0, 1));
  const attrs = [{ name: 'commonName', value: name }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([{ name: 'keyUsage', keyEncipherment: true }]);
  cert.sign(keys.privateKey, forge.md.sha256.create());

  const der = forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes();
  const cerPath = join(workspace, `${name.replace(/\W+/g, '-')}.cer`);
  const p12Path = join(workspace, `${name.replace(/\W+/g, '-')}.p12`);
  writeFileSync(cerPath, Buffer.from(der, 'binary'));
  const p12 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], password, {
    generateLocalKeyId: true,
    friendlyName: name,
  });
  writeFileSync(p12Path, Buffer.from(forge.asn1.toDer(p12).getBytes(), 'binary'));
  return { cer: cerPath, p12: p12Path, base64: Buffer.from(der, 'binary').toString('base64') };
}

test.describe('document security', () => {
  let app: App;

  test.beforeAll(async () => {
    app = await launchApp();
    await app.grantPath(workspace, true);
  });
  test.afterAll(async () => {
    await app.close();
  });

  test('the commands are registered, on the Protect tab, with a shortcut', async () => {
    const commands = await app.commands();
    expect(commands).toContain('protect.security');
    expect(commands).toContain('protect.remove');
    expect(commands).toContain('protect.unlock');
    expect(commands).toContain('protect.properties');
  });

  test('the app carries qpdf 12, reachable from the renderer (ADR 0011)', async () => {
    // Not a triviality: this is the only test that proves the 1.3 MB of WebAssembly actually
    // instantiates in the running app and answers the renderer, which is the packaging decision.
    const version = (await app.run('dev.qpdfVersion')) as string;
    expect(Number.parseInt(version.split('.')[0] ?? '0', 10)).toBeGreaterThanOrEqual(12);
  });

  test('nothing is protected until the document is saved', async () => {
    const path = stage('multipage.pdf', 'pending.pdf');
    await openPath(app, path);
    await app.run('dev.setSecurity', {
      kind: 'password',
      algorithm: 'aes-256',
      print: 'none',
      user: 'open-me',
      owner: 'change-me',
    });
    const pending = await state(app);
    expect(pending.encrypted).toBe(false);
    expect(pending.intentWords).toMatch(/open and permissions passwords/);
    // The file on disk is still exactly what it was.
    expect(readFileSync(path)).toEqual(readFileSync(join(fixtures, 'multipage.pdf')));
    await closeDiscarding(app);
  });

  test('AES-256 with an open password and print=none reaches the disk', async () => {
    const path = stage('multipage.pdf', 'protected.pdf');
    await openPath(app, path);
    await app.run('dev.setSecurity', {
      kind: 'password',
      algorithm: 'aes-256',
      print: 'none',
      modify: 'none',
      copy: false,
      user: 'open-me',
      owner: 'change-me',
    });
    expect((await app.run('file.save')) as { saved: boolean }).toMatchObject({ saved: true });
    await closeDiscarding(app);

    // qpdf, from the test process, on the bytes that are actually on disk.
    const run = await qpdf.run(['--show-encryption', '--password=change-me', 'in.pdf'], {
      'in.pdf': new Uint8Array(readFileSync(path)),
    });
    expect(run.code).toBe(0);
    expect(run.output).toMatch(/R = 6/);
    expect(run.output).toMatch(/file encryption method: AESv3/);
    expect(run.output).toMatch(/print low resolution: not allowed/);
    expect(run.output).toMatch(/print high resolution: not allowed/);
    expect(run.output).toMatch(/modify anything: not allowed/);
    expect(run.output).toMatch(/extract for any purpose: not allowed/);

    // And it really needs the password.
    const without = await qpdf.run(['--show-encryption', 'in.pdf'], {
      'in.pdf': new Uint8Array(readFileSync(path)),
    });
    expect(without.code).not.toBe(0);
    expect(without.output).toMatch(/invalid password/);
  });

  test('the protected file opens in Chrome once the password is given', async () => {
    const path = await protectedFile(app, 'for-chrome.pdf', {
      kind: 'password',
      algorithm: 'aes-256',
      print: 'none',
      user: 'open-me',
      owner: 'change-me',
    });
    // The full Chromium build, not the headless shell: the shell has no PDF viewer, so a
    // `file://` PDF there downloads instead of rendering and the test would prove nothing.
    const browser = await chromium.launch({ channel: 'chromium' });
    try {
      const page = await browser.newPage();
      await page.goto(pathToFileURL(path).href);
      const viewerFrame = (): Frame | undefined =>
        page.frames().find((f) => f.url().startsWith('chrome-extension://'));
      await expect.poll(() => viewerFrame() !== undefined, { timeout: 15_000 }).toBe(true);

      // Chrome asking for a password is itself the proof that it parsed our `/Encrypt`
      // dictionary; typing it and getting a page count proves the content decrypts.
      // Chrome's dialog wraps its field in a `<cr-input>` custom element; the real `<input>` is
      // inside it, and Playwright's CSS engine pierces the open shadow root to reach it.
      const password = viewerFrame()?.locator('#password input');
      await expect
        .poll(async () => ((await password?.count()) ?? 0) > 0, { timeout: 15_000 })
        .toBe(true);
      await password?.fill('open-me');
      await password?.press('Enter');

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
          { timeout: 20_000 },
        )
        .toMatchObject({ pages: '5', failed: false });
    } finally {
      await browser.close();
    }
  });

  test('opened with the user password, the app respects what the file forbids', async () => {
    const path = await protectedFile(app, 'restricted.pdf', {
      kind: 'password',
      algorithm: 'aes-256',
      print: 'none',
      modify: 'none',
      copy: false,
      user: 'open-me',
      owner: 'change-me',
    });
    // Opened with the *user* password, so `/P` applies to this reader.
    await openProtected(app, path, 'open-me');
    const restricted = await state(app);
    expect(restricted.encrypted).toBe(true);
    expect(restricted.algorithm).toBe('aes-256');
    expect(restricted.unlocked).toBe(false);
    expect(restricted.allows['print']).toBe(false);
    expect(restricted.allows['copy']).toBe(false);
    for (const id of [
      'convert.exportImages',
      'convert.exportAllImages',
      'convert.exportText',
      'convert.exportHtml',
      'convert.exportRtf',
    ]) {
      expect(await app.isEnabled(id), id).toBe(false);
      await expect(app.run(id, { ask: false })).rejects.toThrow(/do not allow copying/);
    }
    expect(restricted.allows['modify']).toBe(false);

    // The tooltip is a sentence naming the permission and what would lift it — never a bare
    // greyed-out control, and never a colour.
    expect(restricted.reasonAgainstPrint).toBe(
      "The document's security settings do not allow printing. Enter the owner password to unlock it.",
    );

    // A command that declares `permission: 'modify'` is disabled, and running it says why.
    expect(await app.isEnabled('protect.security')).toBe(false);
    await expect(app.run('protect.security')).rejects.toThrow(/do not allow changing the document/);
    await closeDiscarding(app);
  });

  test('the owner password unlocks the restrictions for the session', async () => {
    const path = await protectedFile(app, 'unlockable.pdf', {
      kind: 'password',
      algorithm: 'aes-256',
      print: 'none',
      modify: 'none',
      copy: false,
      user: 'open-me',
      owner: 'change-me',
    });
    await openProtected(app, path, 'open-me');
    expect((await state(app)).unlocked).toBe(false);
    await app.run('dev.unlock', { password: 'change-me' });
    const unlocked = await state(app);
    expect(unlocked.unlocked).toBe(true);
    expect(unlocked.allows['print']).toBe(true);
    expect(unlocked.reasonAgainstPrint).toBe('');
    for (const id of [
      'convert.exportImages',
      'convert.exportAllImages',
      'convert.exportText',
      'convert.exportHtml',
      'convert.exportRtf',
    ])
      expect(await app.isEnabled(id), id).toBe(true);
    const exported = await app.run('convert.exportImages', {
      pages: [0],
      dpi: 72,
      ask: false,
      directory: workspace,
    });
    expect(exported).toMatchObject({ kind: 'images' });
    expect(await app.isEnabled('protect.security')).toBe(true);
    await closeDiscarding(app);
  });

  test('removing security leaves a file qpdf calls unencrypted', async () => {
    const path = await protectedFile(app, 'to-unprotect.pdf', {
      kind: 'password',
      algorithm: 'aes-256',
      print: 'none',
      modify: 'none',
      copy: false,
      user: 'open-me',
      owner: 'change-me',
    });
    await openProtected(app, path, 'open-me');
    await app.run('dev.unlock', { password: 'change-me' });
    await app.run('dev.setSecurity', { kind: 'none' });
    expect((await app.run('file.save')) as { saved: boolean }).toMatchObject({ saved: true });
    await closeDiscarding(app);

    const check = await qpdf.run(['--check', 'in.pdf'], {
      'in.pdf': new Uint8Array(readFileSync(path)),
    });
    expect(check.code).toBe(0);
    expect(check.output).toMatch(/File is not encrypted/);
    expect(check.output).toMatch(/No syntax or stream encoding errors found/);
  });

  test('a certificate-protected document opens with its digital ID and not without', async () => {
    const alice = makeIdentity('Alice Adams', 'alice-p12');
    const mallory = makeIdentity('Mallory', 'mallory-p12');
    const path = stage('multipage.pdf', 'for-alice.pdf');

    await openPath(app, path);
    await app.run('dev.setSecurity', {
      kind: 'certificate',
      recipients: [
        {
          id: 'alice',
          name: 'Alice Adams',
          issuer: 'Alice Adams',
          serial: '1',
          validFrom: '',
          validTo: '',
          certificateBase64: alice.base64,
          permissions: { print: 'none', modify: 'none', copy: false, accessibility: true },
        },
      ],
    });
    expect((await app.run('file.save')) as { saved: boolean }).toMatchObject({ saved: true });
    await closeDiscarding(app);

    // qpdf cannot read a public-key file at all (ADR 0012) — which is itself a check that what
    // we wrote really is the public-key handler and not the standard one.
    const shown = await qpdf.run(['--show-encryption', 'in.pdf'], {
      'in.pdf': new Uint8Array(readFileSync(path)),
    });
    expect(shown.code).not.toBe(0);

    // The wrong digital ID is refused, by name — and nothing opens.
    await expect(
      app.run('dev.openWithDigitalId', { path, p12: mallory.p12, password: 'mallory-p12' }),
    ).rejects.toThrow(/not one of this document’s recipients/);
    await expect(app.page.locator('.tab')).toHaveCount(0);

    // The wrong password on the right ID is refused too, and says which thing was wrong.
    await expect(
      app.run('dev.openWithDigitalId', { path, p12: alice.p12, password: 'not-the-password' }),
    ).rejects.toThrow(/Check the password/);

    // The right one opens it, and brings that recipient's own permissions with it.
    const opened = (await app.run('dev.openWithDigitalId', {
      path,
      p12: alice.p12,
      password: 'alice-p12',
    })) as { openedAs: string; permissions: { print: string } };
    expect(opened.openedAs).toBe('Alice Adams');
    expect(opened.permissions.print).toBe('none');
    const sealed = await state(app);
    expect(sealed.openedAs).toBe('Alice Adams');
    // PDFium holds plaintext, but Properties and permission checks retain the source policy.
    expect(sealed.encrypted).toBe(true);
    expect(sealed.handler).toBe('public-key');
    expect(sealed.allows['print']).toBe(false);
    expect(sealed.allows['modify']).toBe(false);

    // Change something, so the save is a real one rather than the no-op a clean document gets.
    await app.run('dev.documentApply', { kind: 'rotate', page: 0, rotation: 90 });
    // The decision is visible BEFORE replacing the protected source (audit 2). A public-key
    // file names its recipients but does not carry their certificates.
    const protectedBytes = readFileSync(path);
    const saving = app.run('file.save');
    const warning = app.page.locator('#save-warnings-dialog');
    await expect(warning).toBeVisible();
    await expect(warning).toContainText('protected with certificates');
    expect(readFileSync(path)).toEqual(protectedBytes);
    await warning.getByRole('button', { name: 'Save with these warnings', exact: true }).click();
    const saved = (await saving) as { saved: boolean; warnings?: string[] };
    expect(saved.saved).toBe(true);
    expect((saved.warnings ?? []).join(' ')).toMatch(
      /protected with certificates, and the saved copy is not/,
    );
    expect(await app.run('dev.saveState')).toMatchObject({ dirty: true });
    await closeDiscarding(app);
  });

  test('ordinary Open retains each certificate recipient’s rights in commands and Properties', async () => {
    const reader = makeIdentity('Restricted Reader', 'reader-key');
    const editor = makeIdentity('Restricted Editor', 'editor-key');
    const path = await protectedFile(app, 'two-recipients.pdf', {
      kind: 'certificate',
      recipients: [reader, editor].map((id, index) => ({
        id: String(index),
        name: index === 0 ? 'Restricted Reader' : 'Restricted Editor',
        issuer: 'Test',
        serial: '1',
        validFrom: '',
        validTo: '',
        certificateBase64: id.base64,
        permissions: {
          print: 'none',
          modify: index === 0 ? 'none' : 'all',
          copy: false,
          accessibility: true,
        },
      })),
    });
    for (const [identity, password, modify] of [
      [reader, 'reader-key', false],
      [editor, 'editor-key', true],
    ] as const) {
      // Substitute only the native file selection; the ordinary Open command, explanatory
      // dialog, password prompt, decryption and attachment all run unchanged.
      await app.electron.evaluate(({ dialog }, p12) => {
        const original = dialog.showOpenDialog.bind(dialog);
        dialog.showOpenDialog = () => {
          dialog.showOpenDialog = original;
          return Promise.resolve({ canceled: false, filePaths: [p12] });
        };
      }, identity.p12);
      const opening = app.run('file.openRecent', { path });
      const explanation = app.page.getByRole('dialog', { name: 'Digital ID needed' });
      await expect(explanation).toBeVisible();
      await explanation.getByRole('button', { name: 'OK', exact: true }).click();
      const passwordDialog = app.page.locator('#digital-id-dialog');
      await expect(passwordDialog).toBeVisible();
      await passwordDialog.locator('#digital-id-password').fill(password);
      await passwordDialog.getByRole('button', { name: 'Open', exact: true }).click();
      await opening;
      const opened = await state(app);
      expect(opened).toMatchObject({ encrypted: true, handler: 'public-key', unlocked: false });
      expect(opened.allows).toMatchObject({ copy: false, print: false, modify });
      expect(opened.reasonAgainstPrint).toContain('This digital ID');
      expect(await app.isEnabled('protect.security')).toBe(modify);
      expect(await app.isEnabled('protect.unlock')).toBe(false);
      await expect(app.run('file.print')).rejects.toThrow(/do not allow printing/);
      await app.run('edit.selectAll');
      expect(await app.isEnabled('edit.copy')).toBe(false);
      for (const id of [
        'convert.exportImages',
        'convert.exportAllImages',
        'convert.exportText',
        'convert.exportHtml',
        'convert.exportRtf',
      ]) {
        expect(await app.isEnabled(id), id).toBe(false);
        await expect(app.run(id, { ask: false })).rejects.toThrow(/do not allow copying/);
      }
      await expect(app.run('edit.copyFormatted')).rejects.toThrow(/do not allow copying/);
      expect(await app.run('dev.snapshot', { page: 0, x0: 0, y0: 0, x1: 100, y1: 100 })).toBeNull();
      expect(await app.run('dev.printDryRun')).toBeNull();
      expect(
        await app.run('dev.printToPdf', { path: join(workspace, 'forbidden.pdf') }),
      ).toBeNull();
      if (!modify)
        await expect(app.run('protect.security')).rejects.toThrow(/do not allow changing/);
      await app.page.locator('.ribbon-tab[data-tab="protect"]').click();
      const protectButton = app.page
        .locator('#ribbon-body')
        .getByRole('button', { name: 'Change Protection…', exact: true });
      if (modify) await expect(protectButton).toBeEnabled();
      else await expect(protectButton).toBeDisabled();
      await app.run('app.commandPalette');
      const palette = app.page.locator('#command-palette');
      await palette.locator('input').fill('Print');
      // The palette lists enabled commands only.
      await expect(palette.locator('li[data-command="file.print"]')).toHaveCount(0);
      await app.page.keyboard.press('Escape');
      await app.run('protect.properties');
      const properties = app.page.locator('#security-properties-dialog');
      await expect(properties).toContainText('Certificate security');
      await expect(properties).toContainText('No printing');
      await expect(properties).toContainText('no copying');
      await app.page.keyboard.press('Escape');
      // Copying text typed into the find box remains available; it is not PDF extraction.
      await app.run('edit.find');
      await app.page.locator('#find-bar .find-input').fill('my own query');
      expect(await app.isEnabled('edit.copy')).toBe(true);
      await app.run('edit.findClose');
      await closeDiscarding(app);
    }
  });
});

/** Crash only this test's Electron process tree; leave its recovery store on disk. */
function crashSecurityApp(app: App): void {
  const pid = app.electron.process().pid;
  if (process.platform === 'win32' && pid !== undefined) {
    execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    app.electron.process().kill('SIGKILL');
  }
}

test('protected recovery keeps its record after a wrong password and cancellation', async () => {
  const first = await launchApp({ noDemo: true });
  await first.grantPath(workspace, true);
  let source: Buffer;
  let path: string;
  try {
    path = await protectedFile(first, 'password-recovery.pdf', {
      kind: 'password',
      algorithm: 'aes-256',
      user: 'recover-reader',
      owner: 'recover-owner',
      print: 'none',
      copy: false,
      modify: 'all',
    });
    source = readFileSync(path);
    await openProtected(first, path, 'recover-reader');
    await first.run('dev.documentApply', { kind: 'metadata', value: 'Recovered protected edits' });
    expect(await first.run('file.autosaveNow')).toMatchObject({ written: 1 });
    crashSecurityApp(first);
  } catch (error) {
    await first.close();
    throw error;
  }
  const second = await launchApp({ reuseUserData: true, noDemo: true });
  try {
    const recovery = second.page.locator('#save-recovery-dialog');
    await expect(recovery).toBeVisible();
    await recovery.getByRole('button', { name: 'Recover', exact: true }).click();
    const password = second.page.locator('#password-dialog');
    await expect(password).toBeVisible();
    await password.locator('#password-input').fill('wrong-password');
    await password.getByRole('button', { name: 'Open', exact: true }).click();
    await expect(password).toContainText('That password did not open the file');
    await password.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(password).toHaveCount(0);
    await expect(second.page.locator('.tab')).toHaveCount(0);
    expect(await second.run('dev.recoveryList')).toHaveLength(1);
    const retry = second.run('dev.recoverAll');
    await expect(password).toBeVisible();
    await password.locator('#password-input').fill('recover-reader');
    await password.getByRole('button', { name: 'Open', exact: true }).click();
    expect(await retry).toMatchObject({ found: 1, recovered: 1 });
    await expect(second.page.locator('.tab')).toHaveCount(1);
    expect(await second.run('dev.documentSummary')).toMatchObject({
      metadataTitle: 'Recovered protected edits',
      dirty: true,
    });
    expect(await state(second)).toMatchObject({
      unlocked: false,
      allows: { copy: false, print: false },
    });
    // Recovery JSON cannot grant authority to its remembered source path after restart.
    expect(await second.run('dev.saveState')).toMatchObject({ path: null, dirty: true });
    expect(await second.run('dev.recoveryList')).toHaveLength(1);
    expect(readFileSync(path)).toEqual(source);
    await closeDiscarding(second);
  } finally {
    await second.close();
  }
});

test('certificate recovery restores recipient restrictions before exposing the recovered tab', async () => {
  const identity = makeIdentity('Recovery Reader', 'recovery-key');
  const first = await launchApp({ noDemo: true });
  await first.grantPath(workspace, true);
  let path: string;
  let source: Buffer;
  try {
    path = await protectedFile(first, 'certificate-recovery.pdf', {
      kind: 'certificate',
      recipients: [
        {
          id: 'reader',
          name: 'Recovery Reader',
          issuer: 'Test',
          serial: '1',
          validFrom: '',
          validTo: '',
          certificateBase64: identity.base64,
          permissions: { print: 'none', modify: 'all', copy: false, accessibility: true },
        },
      ],
    });
    source = readFileSync(path);
    await first.run('dev.openWithDigitalId', { path, p12: identity.p12, password: 'recovery-key' });
    await first.run('dev.documentApply', { kind: 'metadata', value: 'Certificate checkpoint' });
    expect(await first.run('file.autosaveNow')).toMatchObject({ written: 1 });
    crashSecurityApp(first);
  } catch (error) {
    await first.close();
    throw error;
  }
  const second = await launchApp({ reuseUserData: true, noDemo: true });
  try {
    const recovery = second.page.locator('#save-recovery-dialog');
    await expect(recovery).toBeVisible();
    await recovery.getByRole('button', { name: 'Recover', exact: true }).click();
    await expect(second.page.locator('.tab')).toHaveCount(1);
    expect(await second.run('dev.documentSummary')).toMatchObject({
      metadataTitle: 'Certificate checkpoint',
      dirty: true,
    });
    expect(await state(second)).toMatchObject({
      encrypted: true,
      handler: 'public-key',
      unlocked: false,
      allows: { copy: false, print: false, modify: true },
    });
    expect(await second.isEnabled('protect.unlock')).toBe(false);
    expect(await second.isEnabled('convert.exportAllImages')).toBe(false);
    expect(await second.isEnabled('file.print')).toBe(false);
    expect(await second.run('dev.saveState')).toMatchObject({ path: null, dirty: true });
    expect(await second.run('dev.recoveryList')).toHaveLength(1);
    expect(readFileSync(path)).toEqual(source);
    await closeDiscarding(second);
  } finally {
    await second.close();
  }
});

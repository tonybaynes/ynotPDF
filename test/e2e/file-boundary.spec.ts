import type { YnotBridge } from '../../src/shared/ipc';
import { expect, test } from '@playwright/test';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchApp } from './harness';

test('file grants belong to the selected window and Recent enumeration grants nothing', async () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'ynot-boundary-')));
  const path = join(root, 'private.pdf');
  writeFileSync(path, 'original');
  const app = await launchApp({ noDemo: true });
  try {
    await expect(
      app.page.evaluate(
        (p) => (window as unknown as { ynot: YnotBridge }).ynot.invoke('file:read', p),
        path,
      ),
    ).rejects.toThrow(/not granted/);
    await app.grantPath(path);
    expect(
      await app.page.evaluate(
        async (p) =>
          (await (window as unknown as { ynot: YnotBridge }).ynot.invoke('file:read', p)).bytes
            .length,
        path,
      ),
    ).toBe(8);
    const opened = app.electron.waitForEvent('window');
    await app.page.evaluate(() =>
      (window as unknown as { ynot: YnotBridge }).ynot.invoke('window:new'),
    );
    const second = await opened;
    await second.waitForFunction(() => typeof window.__ynot?.run === 'function');
    expect(
      await second.evaluate(
        async () =>
          (await (window as unknown as { ynot: YnotBridge }).ynot.invoke('recent:list')).length,
      ),
    ).toBeGreaterThan(0);
    await expect(
      second.evaluate(
        (p) =>
          (window as unknown as { ynot: YnotBridge }).ynot.invoke(
            'file:write',
            p,
            new Uint8Array([0]),
          ),
        path,
      ),
    ).rejects.toThrow(/not granted/);
    await expect(
      second.evaluate(
        (p) => (window as unknown as { ynot: YnotBridge }).ynot.invoke('file:read', p),
        path,
      ),
    ).rejects.toThrow(/not granted/);
    await second.evaluate(
      (p) => (window as unknown as { ynot: YnotBridge }).ynot.invoke('recent:open', p),
      path,
    );
    expect(
      await second.evaluate(
        async (p) =>
          (await (window as unknown as { ynot: YnotBridge }).ynot.invoke('file:read', p)).bytes
            .length,
        path,
      ),
    ).toBe(8);
    const settings = await second.evaluate(() =>
      (window as unknown as { ynot: YnotBridge }).ynot.invoke('settings:path'),
    );
    await expect(
      second.evaluate(
        (p) =>
          (window as unknown as { ynot: YnotBridge }).ynot.invoke(
            'file:write',
            p,
            new Uint8Array(),
          ),
        settings,
      ),
    ).rejects.toThrow(/not granted/);
    // Knowledge of the settings path, including its read-only grant, must not
    // become write authority through Recent or a new window.
    for (const channel of ['recent:add', 'recent:open', 'window:new'] as const) {
      await expect(
        second.evaluate(
          ({ p, command }) => (window as unknown as { ynot: YnotBridge }).ynot.invoke(command, p),
          { p: settings, command: channel },
        ),
      ).rejects.toThrow(/not granted/);
    }
    expect(readFileSync(path, 'utf8')).toBe('original');
    await expect(
      second.evaluate(() =>
        (window as unknown as { ynot: YnotBridge }).ynot.invoke('file:read', {} as never),
      ),
    ).rejects.toThrow(/Invalid text/);
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('embedded file policy precedes native confirmation and OS opening', async () => {
  const app = await launchApp({ noDemo: true });
  try {
    await app.electron.evaluate(({ dialog }) => {
      Object.assign(globalThis, { attachmentConfirmations: 0 });
      dialog.showMessageBox = () => {
        const state = globalThis as unknown as { attachmentConfirmations: number };
        state.attachmentConfirmations++;
        return Promise.resolve({ response: 0, checkboxChecked: false });
      };
    });
    await expect(
      app.page.evaluate(() =>
        (window as unknown as { ynot: YnotBridge }).ynot.invoke(
          'shell:openTempFile',
          'payload.exe',
          new Uint8Array([1]),
        ),
      ),
    ).rejects.toThrow(/cannot be opened directly/);
    expect(
      await app.electron.evaluate(
        () =>
          (globalThis as unknown as { attachmentConfirmations: number }).attachmentConfirmations,
      ),
    ).toBe(0);
    await expect(
      app.page.evaluate(() =>
        (window as unknown as { ynot: YnotBridge }).ynot.invoke(
          'shell:openTempFile',
          'notes.txt',
          new Uint8Array([1]),
        ),
      ),
    ).rejects.toThrow(/cancelled/);
    expect(
      await app.electron.evaluate(
        () =>
          (globalThis as unknown as { attachmentConfirmations: number }).attachmentConfirmations,
      ),
    ).toBe(1);
  } finally {
    await app.close();
  }
});

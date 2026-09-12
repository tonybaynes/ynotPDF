import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Files from '../../../src/main/files';
import type { IpcInvokeChannel } from '../../../src/shared/ipc';

const ipc = vi.hoisted(() => ({
  confirm: vi.fn(),
  writeTemp: vi.fn(),
  openPath: vi.fn(),
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  windows: [] as unknown[],
  bySender: new Map<unknown, unknown>(),
}));
vi.mock('electron', () => ({
  app: {},
  clipboard: {},
  ClipboardItem: {},
  dialog: { showMessageBox: ipc.confirm },
  nativeTheme: {},
  shell: { openPath: ipc.openPath },
  BrowserWindow: { fromWebContents: (sender: unknown) => ipc.bySender.get(sender) ?? null },
  ipcMain: {
    handle: (name: string, handler: (event: unknown, ...args: unknown[]) => unknown) => {
      ipc.handlers.set(name, handler);
    },
  },
}));
vi.mock('../../../src/main/window', () => ({
  allWindows: () => ipc.windows,
  broadcast: vi.fn(),
}));
vi.mock('../../../src/main/files', async (importOriginal) => ({
  ...(await importOriginal<typeof Files>()),
  writeTempFile: ipc.writeTemp,
}));
import { registerIpcHandlers } from '../../../src/main/ipc';

beforeEach(() => {
  ipc.confirm.mockReset().mockResolvedValue({ response: 1 });
  ipc.writeTemp.mockReset().mockResolvedValue('C:/synthetic/quarter_one.pdf');
  ipc.openPath.mockReset().mockResolvedValue('');
  ipc.handlers.clear();
  ipc.windows = [];
  ipc.bySender.clear();
  registerIpcHandlers({ list: () => [] } as never, {} as never, {} as never);
});
function invoke(channel: IpcInvokeChannel, event: unknown, ...args: unknown[]): unknown {
  const handler = ipc.handlers.get(channel);
  if (!handler) throw new Error('Missing registered handler');
  return handler(event, ...args);
}

describe('registered IPC sender boundary', () => {
  it('rejects unknown senders and auxiliary windows before parsing their file paths', () => {
    const sender = { mainFrame: {} };
    expect(() => invoke('file:read', { sender, senderFrame: sender.mainFrame }, {})).toThrow(
      'An application window is required',
    );
    ipc.bySender.set(sender, { id: 99, isDestroyed: () => false });
    expect(() => invoke('file:read', { sender, senderFrame: sender.mainFrame }, {})).toThrow(
      'An application window is required',
    );
  });
  it('rejects a child frame even in a registered application window', () => {
    const sender = { mainFrame: {} };
    const win = { id: 1, isDestroyed: () => false };
    ipc.bySender.set(sender, win);
    ipc.windows.push(win);
    expect(() => invoke('file:read', { sender, senderFrame: {} }, {})).toThrow(
      'Only the application main frame',
    );
    expect(() => invoke('file:read', { sender, senderFrame: null }, {})).toThrow(
      'Only the application main frame',
    );
  });
  it('validates file arguments after accepting the owning main frame', () => {
    const sender = { mainFrame: {} };
    const win = { id: 1, isDestroyed: () => false };
    ipc.bySender.set(sender, win);
    ipc.windows.push(win);
    const event = { sender, senderFrame: sender.mainFrame };
    expect(invoke('recent:list', event)).toEqual([]);
    expect(() => invoke('file:read', event, {})).toThrow('Invalid text argument');
  });
});

describe('registered attachment launch boundary', () => {
  function event() {
    const sender = { mainFrame: {} };
    const win = { id: 1, isDestroyed: () => false };
    ipc.bySender.set(sender, win);
    ipc.windows.push(win);
    return { sender, senderFrame: sender.mainFrame };
  }
  it('rejects an extension changed by truncation before prompting, writing or opening', async () => {
    const name = 'evil.ps1' + ' '.repeat(120) + '.pdf';
    await expect(invoke('shell:openTempFile', event(), name, new Uint8Array())).rejects.toThrow(
      /filename cleanup/,
    );
    expect(ipc.confirm).not.toHaveBeenCalled();
    expect(ipc.writeTemp).not.toHaveBeenCalled();
    expect(ipc.openPath).not.toHaveBeenCalled();
  });
  it('writes the exact approved basename shown in the confirmation', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    await invoke('shell:openTempFile', event(), 'quarter:one.pdf', bytes);
    const options = ipc.confirm.mock.calls[0]?.[1] as { detail: string };
    expect(options.detail).toContain('quarter_one.pdf');
    expect(ipc.writeTemp).toHaveBeenCalledWith('quarter_one.pdf', bytes);
  });
});

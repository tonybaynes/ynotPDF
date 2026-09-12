import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ShellServices } from '@app/services';
import type { Registry } from '@core/Registry';
import { RotatePagesCommand } from '@core/commands';
import { SelectFindService } from '@modules/M13-select-find-print/SelectFindService';
import { openPrintDialog } from '@modules/M13-select-find-print/print/PrintDialog';
import {
  DEFAULT_PRINT_SETTINGS,
  type SettingsStorage,
} from '@modules/M13-select-find-print/settings';
import { invoke } from '@shared/ipc';
import { openFake, must } from '../core/helpers';

vi.mock('@shared/ipc', () => ({
  hasBridge: () => true,
  invoke: vi.fn(),
  on: () => () => undefined,
}));
vi.mock('@modules/M13-select-find-print/print/PrintDialog', () => ({ openPrintDialog: vi.fn() }));
afterEach(() => vi.restoreAllMocks());

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function fixture(storage: SettingsStorage) {
  const { doc, engine } = await openFake({ pageCount: 1 });
  const error = vi.fn(() => Promise.resolve());
  const progress = { signal: new AbortController().signal, set: vi.fn(), close: vi.fn() };
  const shell = {
    documents: {
      onClosed: () => () => undefined,
      subscribe: () => () => undefined,
      onAttached: () => () => undefined,
    },
    ui: { select: () => () => undefined },
    dialogs: { error, progress: () => progress },
    toasts: { show: vi.fn() },
  } as unknown as ShellServices;
  const service = new SelectFindService({
    registry: { hasService: () => false } as unknown as Registry,
    shell,
    engine,
    host: {
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    } as unknown as HTMLElement,
    storage,
  });
  vi.spyOn(service, 'activeDocument').mockReturnValue(doc);
  vi.spyOn(service, 'activeSource').mockReturnValue({
    key: doc.id,
    handle: doc.handle,
    pageCount: 1,
  });
  vi.spyOn(service, 'hasSelection').mockReturnValue(false);
  vi.spyOn(service.print, 'printers').mockResolvedValue([]);
  vi.spyOn(service, 'planFor').mockReturnValue(
    service.print.plan({
      settings: DEFAULT_PRINT_SETTINGS,
      pageSizes: [{ width: 300, height: 400 }],
      currentPage: 0,
      selectedPages: [],
    }),
  );
  return { doc, engine, error, service };
}

describe('print dialog context across awaits', () => {
  it.each(['print', 'pdf'] as const)(
    'does not dispatch %s to another tab while remembering settings',
    async (action) => {
      const entered = deferred<void>();
      const release = deferred<void>();
      const storage: SettingsStorage = {
        get: () => Promise.resolve(undefined),
        set: () => {
          entered.resolve();
          return release.promise;
        },
      };
      const { doc, service, error } = await fixture(storage);
      const other = await openFake({ pageCount: 2 });
      vi.mocked(openPrintDialog).mockResolvedValue({ action, settings: DEFAULT_PRINT_SETTINGS });
      const print = vi.spyOn(service, 'runPrint').mockResolvedValue('printed');
      const pdf = vi.spyOn(service, 'runPrintToPdf').mockResolvedValue('saved');
      try {
        const pending = service.openPrint();
        await entered.promise;
        vi.spyOn(service, 'activeDocument').mockReturnValue(other.doc);
        release.resolve();
        expect(await pending).toBeNull();
        expect(print).not.toHaveBeenCalled();
        expect(pdf).not.toHaveBeenCalled();
        expect(error).toHaveBeenCalledWith(
          'Print',
          expect.stringContaining('remembering print settings'),
        );
      } finally {
        service.dispose();
        await doc.close();
        await other.doc.close();
      }
    },
  );

  it('rejects a document edit made while the PDF destination dialog is open before materialising bytes', async () => {
    const entered = deferred<void>();
    const release = deferred<string>();
    vi.mocked(invoke)
      .mockReset()
      .mockImplementation((...args) => {
        if (args[0] === 'file:saveAsDialog') {
          entered.resolve();
          return release.promise;
        }
        return Promise.resolve(undefined);
      });
    const { doc, engine, service, error } = await fixture({
      get: () => Promise.resolve(undefined),
      set: () => Promise.resolve(),
    });
    const save = vi.spyOn(engine, 'save');
    try {
      const pending = service.runPrintToPdf(DEFAULT_PRINT_SETTINGS);
      await entered.promise;
      await doc.apply(new RotatePagesCommand(doc, [must(doc.state.pages[0], 'page').id], 90));
      release.resolve('synthetic-output.pdf');
      expect(await pending).toBeNull();
      expect(save).not.toHaveBeenCalled();
      expect(vi.mocked(invoke).mock.calls.map(([channel]) => channel)).not.toContain('file:write');
      expect(error).toHaveBeenCalledWith(
        'Print to PDF',
        expect.stringContaining('document changed'),
      );
    } finally {
      service.dispose();
      await doc.close();
    }
  });
});

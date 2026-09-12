import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConvertCancelled, type ConvertResult } from '@engine/create/types';
import { CreateService } from '@modules/M91-create-pdf/CreateService';
import { ConvertClient } from '@modules/M91-create-pdf/ConvertClient';
import { startImportDeskew } from '@modules/M41-merge-split-crop/importDeskewClient';
import type { ShellServices } from '@app/services';
import type { Registry } from '@core/Registry';

vi.mock('@modules/M41-merge-split-crop/importDeskewClient', () => ({ startImportDeskew: vi.fn() }));
const input = { name: 'scan.png', bytes: new Uint8Array([1]) };
const converted: ConvertResult = {
  bytes: new Uint8Array([1, 2]),
  title: 'Scan',
  pageCount: 1,
  warnings: ['Original'],
};
const services: CreateService[] = [];
function setup(enabled: unknown) {
  const client = new ConvertClient(null);
  const convert = vi
    .spyOn(client, 'convert')
    .mockReturnValue({ promise: Promise.resolve(converted), cancel: vi.fn() });
  const get = vi.fn(() => Promise.resolve(enabled));
  const service = new CreateService({
    registry: {} as Registry,
    shell: {} as ShellServices,
    client,
    settingsStorage: { get, set: () => Promise.resolve() },
  });
  services.push(service);
  return { service, convert, get };
}
afterEach(() => {
  services.splice(0).forEach((service) => {
    service.dispose();
  });
  vi.restoreAllMocks();
  vi.mocked(startImportDeskew).mockReset();
});

describe('image import preference and cancellation', () => {
  it.each([false, undefined, 'true', 1])(
    'returns the exact original conversion result when preference is %s',
    async (enabled) => {
      const { service } = setup(enabled);
      expect(await service.convert('image', [input], {}).promise).toBe(converted);
      expect(startImportDeskew).not.toHaveBeenCalled();
    },
  );
  it.each(['text', 'blank'] as const)('does not consult scan settings for %s', async (kind) => {
    const { service, get } = setup(true);
    expect(await service.convert(kind, [input], {}).promise).toBe(converted);
    expect(get).not.toHaveBeenCalled();
    expect(startImportDeskew).not.toHaveBeenCalled();
  });
  it('straightens only after conversion, and propagates progress and the corrected result', async () => {
    const { service, convert } = setup(true);
    const output = { ...converted, bytes: new Uint8Array([3]) };
    vi.mocked(startImportDeskew).mockImplementation((result, progress) => {
      expect(result).toBe(converted);
      progress?.(0.5, 'Straightening');
      return { promise: Promise.resolve(output), cancel: vi.fn() };
    });
    const progress = vi.fn();
    expect(await service.convert('image', [input], {}, { progress }).promise).toBe(output);
    expect(convert).toHaveBeenCalledTimes(1);
    expect(progress).toHaveBeenCalledWith(0.8, 'Straightening');
  });
  it('does not start conversion if already aborted', async () => {
    const { service, convert } = setup(true);
    const controller = new AbortController();
    controller.abort();
    await expect(
      service.convert('image', [input], {}, { signal: controller.signal }).promise,
    ).rejects.toBeInstanceOf(ConvertCancelled);
    expect(convert).not.toHaveBeenCalled();
  });
  it('forwards convertFile cancellation to the active deskew worker and suppresses a late successful result', async () => {
    const { service } = setup(true);
    let resolve!: (value: ConvertResult) => void;
    const cancel = vi.fn();
    vi.mocked(startImportDeskew).mockReturnValue({
      promise: new Promise((done) => {
        resolve = done;
      }),
      cancel,
    });
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const job = service.convertFile(input, {}, { signal: controller.signal });
    const rejected = expect(job).rejects.toBeInstanceOf(ConvertCancelled);
    await vi.waitFor(() => {
      expect(startImportDeskew).toHaveBeenCalled();
    });
    controller.abort();
    expect(cancel).toHaveBeenCalledTimes(1);
    resolve(converted);
    await rejected;
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
  });
  it('cancels conversion on dispose and never starts a late straightening job', async () => {
    const { service, convert } = setup(true);
    let resolve!: (value: ConvertResult) => void;
    const cancel = vi.fn();
    convert.mockReturnValue({
      promise: new Promise((done) => {
        resolve = done;
      }),
      cancel,
    });
    const job = service.convert('image', [input], {});
    const rejected = expect(job.promise).rejects.toBeInstanceOf(ConvertCancelled);
    await vi.waitFor(() => {
      expect(convert).toHaveBeenCalled();
    });
    service.dispose();
    expect(cancel).toHaveBeenCalledTimes(1);
    resolve(converted);
    await rejected;
    expect(startImportDeskew).not.toHaveBeenCalled();
  });
});

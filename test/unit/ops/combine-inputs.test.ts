import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@shared/ipc';
import type * as Ipc from '@shared/ipc';
import {
  addCombineDrop,
  addCombineFiles,
  addCombineFolder,
  type CombineInput,
} from '@modules/M41-merge-split-crop/combineInputs';
import { MergeService } from '@modules/M41-merge-split-crop/MergeService';
import { OrganiseService } from '@modules/M40-organise-pages/OrganiseService';

vi.mock('@shared/ipc', async (original) => ({
  ...(await original<typeof Ipc>()),
  invoke: vi.fn(),
}));
beforeEach(() => vi.mocked(invoke).mockReset());
const hooks = () => ({ signal: new AbortController().signal, progress: vi.fn() });
const input = (name: string): CombineInput => ({ name, bytes: new Uint8Array([1, 2]) });

describe('Combine inputs', () => {
  it('reads a selected folder in listing order and retains readable neighbours of failures', async () => {
    const calls: unknown[][] = [];
    vi.mocked(invoke).mockImplementation((...args: unknown[]) => {
      calls.push(args);
      if (args[0] === 'file:readFolder')
        return Promise.resolve([
          { path: '/chosen/2.pdf', relativePath: '2.pdf' },
          { path: '/chosen/bad.bin', relativePath: 'bad.bin' },
          { path: '/chosen/sub/10.png', relativePath: 'sub/10.png' },
        ]);
      if (args[1] === '/chosen/bad.bin') return Promise.reject(new Error('Unsupported file'));
      return Promise.resolve({ ...input(String(args[1]).split('/').at(-1) ?? ''), path: args[1] });
    });
    const result = await addCombineFolder(
      '/chosen',
      false,
      (file) => Promise.resolve(file),
      hooks(),
    );
    expect(calls[0]).toEqual(['file:readFolder', '/chosen', { recursive: false, limit: 5000 }]);
    expect(result.entries.map((entry) => entry.name)).toEqual(['2.pdf', '10.png']);
    expect(result.entries[1]?.path).toBe('/chosen/sub/10.png');
    expect(result.problems).toEqual(['bad.bin: Unsupported file']);
  });
  it('reads desktop File bytes without reading or granting their paths', async () => {
    const file = new File([new Uint8Array([4, 5, 6])], 'dropped.pdf');
    Object.defineProperty(file, 'path', { value: '/untrusted/path.pdf' });
    const reader = vi.fn((value: ReturnType<typeof input>) => Promise.resolve(value));
    const result = await addCombineDrop([file], reader, hooks());
    expect(result.entries[0]).toMatchObject({
      name: 'dropped.pdf',
      bytes: new Uint8Array([4, 5, 6]),
    });
    expect(result.entries[0]).not.toHaveProperty('path');
    expect(reader.mock.calls[0]?.[0]).not.toHaveProperty('path');
    expect(invoke).not.toHaveBeenCalled();
  });
  it('propagates cancellation/progress and suppresses the active late result and subsequent reads', async () => {
    const controller = new AbortController();
    const progress = vi.fn();
    let finish!: () => void;
    const reader = vi.fn(
      async (
        file: ReturnType<typeof input>,
        conversion: { signal: AbortSignal; progress: (fraction: number, message: string) => void },
      ) => {
        expect(conversion.signal).toBe(controller.signal);
        conversion.progress(0.5, 'Converting image');
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        return file;
      },
    );
    const job = addCombineFiles([input('first.png'), input('second.png')], reader, {
      signal: controller.signal,
      progress,
    });
    await vi.waitFor(() => {
      expect(reader).toHaveBeenCalledTimes(1);
    });
    controller.abort();
    finish();
    expect(await job).toEqual({ entries: [], problems: [] });
    expect(reader).toHaveBeenCalledTimes(1);
    expect(progress).toHaveBeenCalledWith('Converting image');
  });
  it('does no conversion for a cancelled selection and names conversion errors', async () => {
    const controller = new AbortController();
    controller.abort();
    const reader = vi.fn(() => Promise.reject(new Error('Unreadable')));
    expect(
      await addCombineFiles([input('bad.png')], reader, {
        signal: controller.signal,
        progress: vi.fn(),
      }),
    ).toEqual({ entries: [], problems: [] });
    expect(reader).not.toHaveBeenCalled();
    expect((await addCombineFiles([input('bad.png')], reader, hooks())).problems).toEqual([
      'bad.png: Unreadable',
    ]);
  });
  it('forwards hooks through both services without changing source shape or existing PDF bytes', async () => {
    const file = input('scan.png');
    const conversion = { signal: new AbortController().signal, progress: vi.fn() };
    const converted = new Uint8Array([7, 8]);
    const convertFile = vi.fn(() => Promise.resolve({ bytes: converted }));
    const organise = { creates: { convertFile } };
    const pdfBytesOf = (source: typeof file, options: typeof conversion) =>
      OrganiseService.prototype.pdfBytesOf.call(
        organise as unknown as OrganiseService,
        source,
        options,
      );
    const merge = { organise: { pdfBytesOf } };
    expect(
      await MergeService.prototype.sourceFor.call(
        merge as unknown as MergeService,
        file,
        conversion,
      ),
    ).toEqual({ name: file.name, bytes: converted });
    expect(convertFile).toHaveBeenCalledWith({ ...file, path: '' }, undefined, conversion);
    convertFile.mockClear();
    const pdf = { name: 'existing.pdf', bytes: new TextEncoder().encode('%PDF-1.7') };
    expect(await pdfBytesOf(pdf, conversion)).toBe(pdf.bytes);
    expect(convertFile).not.toHaveBeenCalled();
  });
});

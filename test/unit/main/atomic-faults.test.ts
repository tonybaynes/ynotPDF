import type * as FsPromises from 'node:fs/promises';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { writeAtomic } from '../../../src/main/fs/atomic';

const fault = vi.hoisted(() => ({ mode: '' }));
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof FsPromises>();
  return {
    ...fs,
    open: async (...args: Parameters<typeof fs.open>) => {
      const handle = await fs.open(...args);
      const write = handle.write.bind(handle);
      if (fault.mode === 'sync')
        vi.spyOn(handle, 'sync').mockRejectedValue(new Error('sync failure'));
      if (fault.mode === 'disk-full')
        vi.spyOn(handle, 'write').mockRejectedValue(new Error('ENOSPC'));
      if (fault.mode === 'zero')
        vi.spyOn(handle, 'write').mockResolvedValue({ bytesWritten: 0, buffer: '' });
      if (fault.mode === 'short') {
        vi.spyOn(handle, 'write').mockImplementation(((
          buffer: Uint8Array,
          offset: number,
          length: number,
          position: number,
        ) => write(buffer, offset, Math.min(length, 1), position)) as typeof handle.write);
      }
      return handle;
    },
    copyFile: (...args: Parameters<typeof fs.copyFile>) =>
      fault.mode === 'backup' ? Promise.reject(new Error('backup failure')) : fs.copyFile(...args),
    rename: (...args: Parameters<typeof fs.rename>) =>
      fault.mode === 'rename' ? Promise.reject(new Error('rename failure')) : fs.rename(...args),
  };
});

const directories: string[] = [];
afterEach(async () => {
  fault.mode = '';
  vi.restoreAllMocks();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

describe('atomic save under filesystem faults', () => {
  it.each(['short', 'zero', 'sync', 'disk-full', 'backup', 'rename'])(
    '%s writes preserve the original or complete fully',
    async (mode) => {
      const directory = await mkdtemp(join(tmpdir(), 'ynot-atomic-'));
      directories.push(directory);
      const path = join(directory, 'document.pdf');
      const original = new Uint8Array([8, 7, 6]);
      const replacement = new Uint8Array([1, 2, 3, 4]);
      await writeFile(path, original);
      fault.mode = mode;
      if (mode === 'short') {
        expect((await writeAtomic(path, replacement, { backup: true })).bytesWritten).toBe(4);
        expect(new Uint8Array(await readFile(path))).toEqual(replacement);
        expect(new Uint8Array(await readFile(`${path}.bak`))).toEqual(original);
      } else {
        await expect(writeAtomic(path, replacement, { backup: true })).rejects.toThrow();
        expect(new Uint8Array(await readFile(path))).toEqual(original);
      }
      expect((await readdir(directory)).filter((name) => name.includes('ynot-tmp'))).toEqual([]);
    },
  );
});

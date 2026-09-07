/**
 * File I/O helpers for main (M00). Bytes cross IPC as `Uint8Array`.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import type { OpenedFile } from '../shared/ipc';

export async function readFileForRenderer(path: string): Promise<OpenedFile> {
  const buf = await readFile(path);
  return {
    path,
    name: basename(path),
    bytes: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength),
  };
}

export async function writeBytes(path: string, bytes: Uint8Array): Promise<void> {
  await writeFile(path, bytes);
}

/**
 * File I/O helpers for main (M00). Bytes cross IPC as `Uint8Array`.
 */

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
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

/**
 * Writes bytes to a temporary file and returns its path (M12, ADR 0011). This is what "open
 * attachment" needs: the renderer has no filesystem, so an embedded file can only reach the OS
 * default application through a real path.
 *
 * Everything goes under one per-session directory in the OS temp folder, removed on quit by
 * {@link cleanTempFiles}. The name is sanitised, because it came from inside a PDF and a file
 * specification is free to say `../../.bashrc`.
 */
export async function writeTempFile(name: string, bytes: Uint8Array): Promise<string> {
  const dir = await tempDir();
  // A folder per file keeps two attachments of the same name apart while leaving the name the
  // other application shows exactly as the PDF spelled it.
  const folder = join(dir, randomUUID());
  await mkdir(folder, { recursive: true });
  const path = join(folder, safeFileName(name));
  await writeFile(path, bytes);
  return path;
}

let sessionTempDir: Promise<string> | null = null;

/** The session's temp directory, created on first use. */
async function tempDir(): Promise<string> {
  sessionTempDir ??= (async (): Promise<string> => {
    const dir = join(tmpdir(), `ynotpdf-${String(process.pid)}-${randomUUID().slice(0, 8)}`);
    await mkdir(dir, { recursive: true });
    return dir;
  })();
  return await sessionTempDir;
}

/** Removes everything {@link writeTempFile} wrote. Called on quit. */
export async function cleanTempFiles(): Promise<void> {
  const pending = sessionTempDir;
  sessionTempDir = null;
  if (!pending) return;
  const dir = await pending.catch(() => null);
  if (dir !== null) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
}

/** Punctuation a file name may not contain on at least one of the three platforms. */
const UNSAFE_PUNCTUATION = '\\/:*?"<>|';

/** Names Windows refuses whatever the extension. */
const RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;

/**
 * A file name that is safe to write: no path separators, no `..`, no control characters,
 * nothing Windows reserves, never empty, and never longer than 120 characters. Exported so the
 * unit test can hold it to that.
 *
 * Written as a scan rather than a regular expression because the control range is precisely
 * what has to go, and a literal one in a pattern is banned by the lint rules for being invisible.
 */
export function safeFileName(name: string): string {
  let cleaned = '';
  for (const ch of name) {
    const code = ch.codePointAt(0) ?? 0;
    cleaned += code < 0x20 || code === 0x7f || UNSAFE_PUNCTUATION.includes(ch) ? '_' : ch;
  }
  const capped = cleaned.replace(/^\.+/, '').trim().slice(0, 120).trim();
  if (capped === '') return 'attachment';
  return RESERVED_NAME.test(capped) ? `_${capped}` : capped;
}

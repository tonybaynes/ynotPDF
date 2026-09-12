/**
 * File I/O helpers for main (M00). Bytes cross IPC as `Uint8Array`.
 */

import { randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, extname, join, relative, resolve, sep } from 'node:path';
import { canonicalPath, containedBy } from './fs/capabilities';
import type { FolderEntry, OpenedFile, ReadFolderOptions } from '../shared/ipc';

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
  const capped = cleaned
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 120)
    .replace(/[. ]+$/, '');
  if (capped === '') return 'attachment';
  return RESERVED_NAME.test(capped) ? `_${capped}` : capped;
}

/**
 * Lists a folder, recursively by default, and returns metadata only (M42, ADR 0014).
 *
 * "New portfolio from a folder" needs the tree before it needs a single byte, and the files are
 * then read one at a time — so this never carries content. Symbolic links are not followed:
 * a link back up the tree would otherwise walk for ever, and a link out of the folder would
 * quietly pull in files the reader did not choose. The limit is a backstop against someone
 * picking their home directory.
 */
export async function readFolder(
  path: string,
  options: ReadFolderOptions = {},
): Promise<FolderEntry[]> {
  const recursive = options.recursive !== false;
  const limit = Math.max(1, options.limit ?? 5000);
  const base = resolve(path);
  const out: FolderEntry[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (out.length >= limit || depth > 32) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // A folder we may not read is skipped, not a reason to fail the whole listing.
    }
    // Alphabetical, so a portfolio built from a folder comes out in the order the reader saw.
    entries.sort((a, b) => a.name.localeCompare(b.name, 'en-GB', { numeric: true }));
    for (const entry of entries) {
      if (out.length >= limit) return;
      if (entry.isSymbolicLink()) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (recursive) await walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        const info = await stat(full);
        out.push({
          path: full,
          relativePath: relative(base, full).split(sep).join('/'),
          name: entry.name,
          size: info.size,
          modified: info.mtime.toISOString(),
        });
      } catch {
        // A file that vanished between the listing and the stat is simply not in the answer.
      }
    }
  };
  await walk(base, 0);
  return out;
}

/**
 * Writes one file under `dir` at `relativePath`, creating the folders on the way, and answers
 * with the absolute path (M42, ADR 0014).
 *
 * Every segment goes through {@link safeFileName} and the result is checked to be inside `dir`.
 * The names come from inside a PDF, where a file specification may say anything at all, so
 * "extract all" must not be able to write outside the folder the reader chose.
 */
export async function writeInto(
  dir: string,
  relativePath: string,
  bytes: Uint8Array,
): Promise<string> {
  const base = canonicalPath(dir);
  if (!(await stat(base)).isDirectory()) throw new Error('The chosen folder no longer exists');
  const segments = relativePath
    .split(/[\\/]+/)
    .filter((part) => part !== '' && part !== '.' && part !== '..')
    .map(safeFileName);
  const leaf = segments.pop();
  if (!leaf) throw new Error('The file has no usable name');
  let parent = base;
  for (const segment of segments) {
    const child = join(parent, segment);
    try {
      await mkdir(child);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const info = await lstat(child);
    if (info.isSymbolicLink() || !info.isDirectory())
      throw new Error('An output folder is a link or is not a directory');
    parent = canonicalPath(child);
    if (!containedBy(base, parent))
      throw new Error('That file would be written outside the chosen folder');
  }
  // Treat case-only differences as collisions on every OS for portable extracted trees.
  const ext = extname(leaf);
  const stem = leaf.slice(0, leaf.length - ext.length);
  for (let suffix = 0; suffix < 10000; suffix++) {
    const name = suffix === 0 ? leaf : stem + ' (' + String(suffix) + ')' + ext;
    if (
      (await readdir(parent)).some(
        (existing) => existing.toLocaleLowerCase('en-US') === name.toLocaleLowerCase('en-US'),
      )
    ) {
      const existing = join(parent, name);
      const info = await lstat(existing).catch(() => null);
      if (info?.isSymbolicLink()) throw new Error('The output file is a symbolic link');
      continue;
    }
    const checkedParent = canonicalPath(parent);
    if (checkedParent !== parent || !containedBy(base, checkedParent))
      throw new Error('The output folder changed while extracting');
    const target = join(parent, name);
    let handle;
    try {
      handle = await open(target, 'wx');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw error;
    }
    try {
      await handle.writeFile(bytes);
      await handle.close();
      return target;
    } catch (error) {
      // Only remove a leaf this call created. A failed exclusive open never owns it.
      await handle.close().catch(() => undefined);
      try {
        await unlink(target);
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          'Extraction failed and its incomplete output could not be removed',
          { cause: cleanupError },
        );
      }
      throw error;
    }
  }
  throw new Error('Too many files have the same output name');
}

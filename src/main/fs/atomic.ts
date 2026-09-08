/**
 * Atomic file writing (M21).
 *
 * A save that is interrupted — the machine loses power, the process is killed, the disk fills —
 * must never leave a half-written PDF where the user's document was. So the bytes go to a
 * temporary file beside the target, are flushed to the platter, and only then does a rename put
 * them in place. A rename within one directory is atomic on every filesystem we support, so at
 * every instant the target path holds either the whole old file or the whole new one.
 *
 * The temporary file is a sibling rather than one in the OS temp directory, because a rename
 * across devices is a copy, and a copy is not atomic.
 */

import { constants } from 'node:fs';
import { access, copyFile, mkdir, open, rename, stat, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export interface AtomicWriteOptions {
  /**
   * Rename the file that is there now to `<name>.bak` before the new one takes its place.
   * A previous `.bak` is replaced.
   */
  readonly backup?: boolean;
}

export interface AtomicWriteResult {
  readonly path: string;
  /** Where the previous version went, when `backup` was asked for and there was one. */
  readonly backupPath: string | null;
  readonly bytesWritten: number;
}

let sequence = 0;

/** A sibling temp name that cannot collide with another save of the same file. */
function tempPathFor(path: string): string {
  const unique = `${String(process.pid)}-${Date.now().toString(36)}-${String(++sequence)}`;
  return join(dirname(path), `.${baseName(path)}.ynot-tmp-${unique}`);
}

function baseName(path: string): string {
  const at = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return at < 0 ? path : path.slice(at + 1);
}

/** Writes `bytes` to `path` through a temporary file and a rename. */
export async function writeAtomic(
  path: string,
  bytes: Uint8Array,
  options: AtomicWriteOptions = {},
): Promise<AtomicWriteResult> {
  await mkdir(dirname(path), { recursive: true }).catch(() => undefined);
  const temp = tempPathFor(path);
  let handle;
  try {
    handle = await open(temp, 'wx');
    await handle.write(bytes);
    // Without the flush the rename can land before the data does, and a power cut then leaves an
    // empty file where the document was — the exact failure this whole dance exists to prevent.
    await handle.sync().catch(() => undefined);
  } finally {
    await handle?.close().catch(() => undefined);
  }

  let backupPath: string | null = null;
  try {
    if (options.backup && (await exists(path))) {
      backupPath = `${path}.bak`;
      // A copy, not a rename: if the write below fails we must not have moved the original away.
      await copyFile(path, backupPath);
    }
    await renameWithRetry(temp, path);
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    throw error;
  }
  return { path, backupPath, bytesWritten: bytes.byteLength };
}

/** Errors that mean "someone has the file open for a moment", rather than "you may not do this". */
const TRANSIENT = new Set(['EPERM', 'EBUSY', 'EACCES', 'EEXIST']);
const RENAME_ATTEMPTS = 12;
const RENAME_BACKOFF_MS = 25;

/**
 * `rename`, retried briefly when Windows says the destination is busy.
 *
 * On Windows a rename over an existing file fails with `EPERM` or `EBUSY` if anything has the
 * target open even momentarily — an antivirus scanner reading the file we have just written, a
 * sync client, a viewer with a preview handle. It clears in milliseconds, and telling the reader
 * "the document was not saved" because a scanner blinked would be both wrong and alarming. After
 * about a third of a second the error is real and is passed on.
 */
async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? '';
      if (attempt >= RENAME_ATTEMPTS - 1 || !TRANSIENT.has(code)) throw error;
      await new Promise((resolve) => setTimeout(resolve, RENAME_BACKOFF_MS));
    }
  }
}

/** What the renderer needs to know about a path before it saves to it. */
export interface FileProbe {
  readonly path: string;
  readonly exists: boolean;
  readonly size: number;
  /** Modification time in Unix ms, or 0 when the file is not there. */
  readonly modifiedAt: number;
  /** The file itself can be written to. False for a missing file. */
  readonly writable: boolean;
  /** A new file can be created in the containing directory (which is what the rename needs). */
  readonly directoryWritable: boolean;
  /** True when the file is there but cannot be replaced: Save has to become Save As. */
  readonly readOnly: boolean;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function writable(path: string): Promise<boolean> {
  try {
    await access(path, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Asks the filesystem whether a path can be saved to.
 *
 * Both halves matter: replacing a file needs write permission on the *file* on Windows (which
 * honours the read-only attribute) and on the *directory* everywhere, because the last step is a
 * rename into it. A file you may write but whose folder you may not is not saveable in place.
 */
export async function probeFile(path: string): Promise<FileProbe> {
  const info = await stat(path).catch(() => null);
  const present = info !== null;
  const [fileWritable, dirWritable] = await Promise.all([
    present ? writable(path) : Promise.resolve(false),
    writable(dirname(path)),
  ]);
  return {
    path,
    exists: present,
    size: info?.size ?? 0,
    modifiedAt: info ? Math.round(info.mtimeMs) : 0,
    writable: fileWritable,
    directoryWritable: dirWritable,
    readOnly: present && !(fileWritable && dirWritable),
  };
}

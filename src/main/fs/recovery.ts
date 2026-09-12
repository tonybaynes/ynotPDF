/**
 * The recovery store (M21) — `<userData>/recovery/<id>.ynot`.
 *
 * One JSON file per unsaved document: where it came from, a fingerprint of the source, and the
 * journal of everything the user did to it. Written by autosave every few minutes and deleted
 * the moment the document is saved or closed, so anything still here on the next launch is work
 * a crash took away.
 *
 * The store knows nothing about PDFs. It stores a string against an id and lists what it holds;
 * the renderer decides what that string means (`M21-save/recovery.ts`), which keeps the format
 * free to grow without touching the main process.
 */

import { mkdir, readFile, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { writeAtomic } from './atomic';

const EXTENSION = '.ynot';
/** Ids come from the renderer and become filenames, so they are checked rather than trusted. */
const ID_PATTERN = /^[A-Za-z0-9_-]{1,120}$/;

/** One recoverable document, as the launch dialog lists it. */
export interface RecoveryEntry {
  readonly id: string;
  /** Unix ms of the last autosave. */
  readonly savedAt: number;
  readonly size: number;
  /** The record itself, for the renderer to parse. */
  readonly payload: string;
}

export class RecoveryStore {
  private readonly directory: string;

  constructor(userDataDir: string) {
    this.directory = join(userDataDir, 'recovery');
  }

  /** Absolute path of the folder, for the About dialog and diagnostics. */
  get path(): string {
    return this.directory;
  }

  /** Writes (or replaces) one record. Atomic, so a crash mid-autosave cannot corrupt it. */
  async save(id: string, payload: string): Promise<void> {
    assertId(id);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await writeAtomic(this.fileFor(id), new TextEncoder().encode(payload), { mode: 0o600 });
    // Only the published generation owns blobs now. SaveService serializes writes for a record;
    // collection happens after publication, so a failed update cannot break the older manifest.
    let parsed: {
      version?: number;
      checkpoint?: { engine?: unknown; blobs?: Record<string, unknown> };
    };
    try {
      parsed = JSON.parse(payload) as typeof parsed;
    } catch {
      return;
    }
    if (parsed.version !== 2 || !parsed.checkpoint?.blobs) return;
    const keep = new Set([parsed.checkpoint.engine, ...Object.values(parsed.checkpoint.blobs)]);
    const directory = join(this.directory, `${id}.blobs`);
    for (const name of await readdir(directory).catch(() => [] as string[])) {
      if (/^[a-f0-9]{64}$/.test(name) && !keep.has(name)) {
        await rm(join(directory, name), { force: true }).catch(() => undefined);
      }
    }
  }

  async read(id: string): Promise<string | null> {
    assertId(id);
    return readFile(this.fileFor(id), 'utf8').catch(() => null);
  }

  /** Content addressed within a record; publish the JSON only after all blobs are durable. */
  async putBlob(id: string, bytes: Uint8Array): Promise<string> {
    assertId(id);
    const hash = createHash('sha256').update(bytes).digest('hex');
    const directory = join(this.directory, `${id}.blobs`);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, hash);
    // Existing content is checked too: an interrupted/corrupted earlier write must be repaired.
    const existing = await readFile(path).catch(() => null);
    if (!existing || createHash('sha256').update(existing).digest('hex') !== hash) {
      await writeAtomic(path, bytes, { mode: 0o600 });
    }
    return hash;
  }

  async readBlob(id: string, hash: string): Promise<Uint8Array> {
    assertId(id);
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('Invalid recovery content hash');
    const bytes = await readFile(join(this.directory, `${id}.blobs`, hash));
    if (createHash('sha256').update(bytes).digest('hex') !== hash) {
      throw new Error('Recovery content failed its integrity check');
    }
    return new Uint8Array(bytes);
  }

  /** Deletes one record. Never throws: a record that is already gone is the state we wanted. */
  async discard(id: string): Promise<void> {
    assertId(id);
    await rm(this.fileFor(id), { force: true }).catch(() => undefined);
    await rm(join(this.directory, `${id}.blobs`), { recursive: true, force: true }).catch(
      () => undefined,
    );
  }

  async clear(): Promise<void> {
    await rm(this.directory, { recursive: true, force: true }).catch(() => undefined);
  }

  /** Every record, newest first. Unreadable files are skipped rather than failing the list. */
  async list(): Promise<RecoveryEntry[]> {
    const names = await readdir(this.directory).catch(() => [] as string[]);
    const entries: RecoveryEntry[] = [];
    for (const name of names) {
      if (!name.endsWith(EXTENSION)) continue;
      const id = name.slice(0, -EXTENSION.length);
      if (!ID_PATTERN.test(id)) continue;
      const file = join(this.directory, name);
      const [info, payload] = await Promise.all([
        stat(file).catch(() => null),
        readFile(file, 'utf8').catch(() => null),
      ]);
      if (!info || payload === null) continue;
      entries.push({ id, savedAt: Math.round(info.mtimeMs), size: info.size, payload });
    }
    return entries.sort((a, b) => b.savedAt - a.savedAt);
  }

  private fileFor(id: string): string {
    return join(this.directory, `${id}${EXTENSION}`);
  }
}

function assertId(id: string): void {
  if (!ID_PATTERN.test(id)) throw new Error(`Not a usable recovery id: ${id}`);
}

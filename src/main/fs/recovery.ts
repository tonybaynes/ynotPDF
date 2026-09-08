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
    await mkdir(this.directory, { recursive: true });
    await writeAtomic(this.fileFor(id), new TextEncoder().encode(payload));
  }

  async read(id: string): Promise<string | null> {
    assertId(id);
    return readFile(this.fileFor(id), 'utf8').catch(() => null);
  }

  /** Deletes one record. Never throws: a record that is already gone is the state we wanted. */
  async discard(id: string): Promise<void> {
    assertId(id);
    await rm(this.fileFor(id), { force: true }).catch(() => undefined);
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

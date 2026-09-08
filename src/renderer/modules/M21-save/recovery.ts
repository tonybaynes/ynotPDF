/**
 * Crash recovery (M21).
 *
 * A recovery record is the document's journal plus a fingerprint of the file it came from. That
 * is all it needs to be: the journal is already the complete, replayable description of
 * everything the user did (M20, ADR 0007), so recovery is "open the source again and replay",
 * not "restore a copy of the bytes". The records are therefore tiny — kilobytes for an hour's
 * work — and they can be written every few minutes without the reader ever noticing.
 *
 * The fingerprint is what keeps it honest. If the source has changed since the crash, replaying
 * page-3 edits onto a document whose pages have moved would produce a plausible-looking wrong
 * answer, so the mismatch is stated in words and the reader decides.
 */

import type { Document } from '@core/Document';
import { replayJournal, serialiseJournal, type JournalFile } from '@core/Journal';
import { hasBridge, invoke, type RecoveryEntry } from '@shared/ipc';

/** Bumped only when an old record can no longer be read. */
export const RECOVERY_VERSION = 1;

/** A fingerprint of the file the journal was recorded against. */
export interface SourceFingerprint {
  readonly size: number;
  /** Unix ms of the source's last modification when we opened it, or 0 when unknown. */
  readonly modifiedAt: number;
  /** FNV-1a 64-bit of the bytes, as hex. Not a security boundary — a change detector. */
  readonly hash: string;
}

export interface RecoveryRecord {
  readonly version: number;
  /** Stable per document per session; also the record's filename. */
  readonly id: string;
  /** Where the document came from, or null when it has never been saved. */
  readonly path: string | null;
  readonly title: string;
  /** Unix ms. */
  readonly savedAt: number;
  readonly source: SourceFingerprint | null;
  readonly journal: JournalFile;
  /** Number of changes in the journal, so the dialog can say how much is at stake. */
  readonly changes: number;
}

/**
 * A 64-bit change detector over the bytes, as hex.
 *
 * Two independent 32-bit FNV-1a passes with different offset bases, concatenated — rather than
 * one true 64-bit FNV, which JavaScript cannot do without splitting every multiply by hand for
 * no gain here. This answers "is this the same file?", runs while the reader waits for a document
 * to open, and has no adversary; a cryptographic hash would be slower and no more use.
 */
export function hashBytes(bytes: Uint8Array): string {
  const PRIME = 0x0100_0193;
  let a = 0x811c_9dc5;
  let b = 0x1000_0193;
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i] ?? 0;
    a = Math.imul(a ^ byte, PRIME);
    // The second pass folds in the position as well, so a transposition changes the hash.
    b = Math.imul(b ^ (byte + (i & 0xff)), PRIME);
  }
  return `${(a >>> 0).toString(16).padStart(8, '0')}${(b >>> 0).toString(16).padStart(8, '0')}`;
}

/** How much of a large file is hashed at each end. */
const SAMPLE_BYTES = 1024 * 1024;

/**
 * A fingerprint of a document's bytes. Files up to 4 MB are hashed whole; larger ones are hashed
 * at both ends together with their exact length, which catches every edit a PDF writer makes
 * (the header, the trailer and the length all move) without reading hundreds of megabytes while
 * the reader waits.
 */
export function fingerprintBytes(bytes: Uint8Array, modifiedAt = 0): SourceFingerprint {
  const size = bytes.byteLength;
  if (size <= SAMPLE_BYTES * 4) {
    return { size, modifiedAt, hash: hashBytes(bytes) };
  }
  const head = bytes.subarray(0, SAMPLE_BYTES);
  const tail = bytes.subarray(size - SAMPLE_BYTES);
  return { size, modifiedAt, hash: `${hashBytes(head)}-${hashBytes(tail)}` };
}

/** Whether two fingerprints describe the same file. A missing one on either side means "unknown". */
export function sameSource(a: SourceFingerprint | null, b: SourceFingerprint | null): boolean {
  if (!a || !b) return false;
  return a.size === b.size && a.hash === b.hash;
}

/** Builds the record for one document. Pure: the caller supplies the clock and the fingerprint. */
export function buildRecoveryRecord(
  doc: Document,
  options: { id: string; source: SourceFingerprint | null; now: number },
): RecoveryRecord {
  const journal = serialiseJournal(doc);
  return {
    version: RECOVERY_VERSION,
    id: options.id,
    path: doc.state.path,
    title: doc.state.title,
    savedAt: options.now,
    source: options.source,
    journal,
    changes: journal.entries.length,
  };
}

/** Parses a record, returning `null` for anything we do not understand. */
export function parseRecoveryRecord(payload: string): RecoveryRecord | null {
  try {
    const data = JSON.parse(payload) as Partial<RecoveryRecord>;
    if (data.version !== RECOVERY_VERSION) return null;
    if (typeof data.id !== 'string' || !data.journal || !Array.isArray(data.journal.entries)) {
      return null;
    }
    return {
      version: RECOVERY_VERSION,
      id: data.id,
      path: typeof data.path === 'string' ? data.path : null,
      title: typeof data.title === 'string' ? data.title : 'Untitled',
      savedAt: typeof data.savedAt === 'number' ? data.savedAt : 0,
      source: data.source ?? null,
      journal: data.journal,
      changes: data.journal.entries.length,
    };
  } catch {
    return null;
  }
}

/** What a recovery attempt did, in the words the dialog and the toast use. */
export interface RecoveryOutcome {
  readonly applied: number;
  readonly skipped: number;
  readonly skippedTypes: ReadonlyArray<string>;
  /** True when the file on disk is not the one the journal was recorded against. */
  readonly sourceChanged: boolean;
}

/** Replays a record's journal into a freshly opened document. */
export async function replayRecord(
  doc: Document,
  record: RecoveryRecord,
  currentSource: SourceFingerprint | null,
): Promise<RecoveryOutcome> {
  const result = await replayJournal(doc, record.journal.entries);
  return {
    applied: result.applied,
    skipped: result.skipped,
    skippedTypes: result.skippedTypes,
    sourceChanged: record.source !== null && !sameSource(record.source, currentSource),
  };
}

/** One sentence saying what a recovery managed, for a toast or a dialog. */
export function describeOutcome(record: RecoveryRecord, outcome: RecoveryOutcome): string {
  const restored =
    outcome.applied === 1 ? 'Restored 1 change' : `Restored ${outcome.applied} changes`;
  const lost =
    outcome.skipped === 0
      ? ''
      : `, but ${outcome.skipped} of ${record.changes} could not be restored`;
  const moved = outcome.sourceChanged
    ? ' The file on disk has changed since then, so check the result before saving.'
    : '';
  return `${restored} to ${record.title}${lost}.${moved}`;
}

// ---- the store, through IPC --------------------------------------------------------------------

/** Reading and writing recovery records. Tests pass a memory implementation. */
export interface RecoveryStorage {
  list(): Promise<ReadonlyArray<RecoveryEntry>>;
  save(id: string, payload: string): Promise<void>;
  discard(id: string): Promise<void>;
  clear(): Promise<void>;
}

export function ipcRecoveryStorage(): RecoveryStorage {
  return {
    list: async () => (hasBridge() ? await invoke('recovery:list') : []),
    save: async (id, payload) => {
      if (hasBridge()) await invoke('recovery:save', id, payload);
    },
    discard: async (id) => {
      if (hasBridge()) await invoke('recovery:discard', id);
    },
    clear: async () => {
      if (hasBridge()) await invoke('recovery:clear');
    },
  };
}

export function memoryRecoveryStorage(): RecoveryStorage & { readonly size: number } {
  const map = new Map<string, { payload: string; savedAt: number }>();
  return {
    get size() {
      return map.size;
    },
    list: () =>
      Promise.resolve(
        [...map.entries()]
          .map(([id, v]) => ({
            id,
            payload: v.payload,
            savedAt: v.savedAt,
            size: v.payload.length,
          }))
          .sort((a, b) => b.savedAt - a.savedAt),
      ),
    save: (id, payload) => {
      map.set(id, { payload, savedAt: Date.now() });
      return Promise.resolve();
    },
    discard: (id) => {
      map.delete(id);
      return Promise.resolve();
    },
    clear: () => {
      map.clear();
      return Promise.resolve();
    },
  };
}

/** Every record the store holds that we can still read, newest first. */
export async function listRecoverable(storage: RecoveryStorage): Promise<RecoveryRecord[]> {
  const entries = await storage.list();
  const records: RecoveryRecord[] = [];
  for (const entry of entries) {
    const record = parseRecoveryRecord(entry.payload);
    // A record we cannot read is dropped rather than shown as an empty row the reader cannot act
    // on; an unreadable record has nothing in it we could restore anyway.
    if (record && record.journal.entries.length > 0) records.push(record);
  }
  return records;
}

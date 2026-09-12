/** Self-contained engine/model recovery checkpoints (ADR 0023), plus legacy journal parsing. */

import type { Document, DocumentCheckpoint } from '@core/Document';
import { contentIdentity } from '@shared/contentIdentity';
export { hashBytes } from '@shared/contentIdentity';
import type { SecurityInfo } from '@engine/security/types';
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
  readonly checkpoint?: {
    readonly document: DocumentCheckpoint;
    readonly engine: string;
    readonly blobs: Readonly<Record<string, string>>;
    readonly security?: { readonly info: SecurityInfo; readonly openedAs: string | null };
  };
}

/** Captures one coherent engine/model pair, then publishes its binary inputs before the JSON. */
export async function checkpointRecord(
  doc: Document,
  storage: RecoveryStorage,
  options: { id: string; source: SourceFingerprint | null; now: number },
  security?: { readonly info: SecurityInfo; readonly openedAs: string | null },
): Promise<RecoveryRecord> {
  const captured = await doc.undo.capture(async () => {
    const bytes = await doc.engine.save(doc.handle);
    return {
      bytes,
      document: doc.checkpoint(),
      record: buildRecoveryRecord(doc, options),
      blobs: [...doc.blobs].map(([key, value]) => [key, value.slice()] as const),
    };
  });
  const engine = await storage.putBlob(options.id, captured.bytes);
  const blobs: [string, string][] = [];
  for (const [key, bytes] of captured.blobs) {
    blobs.push([key, await storage.putBlob(options.id, bytes)]);
  }
  return {
    ...captured.record,
    version: 2,
    checkpoint: {
      document: captured.document,
      engine,
      blobs: Object.fromEntries(blobs),
      ...(security ? { security } : {}),
    },
  };
}

/** Complete source identity: an in-place edit can leave both file ends and its length unchanged. */
export function fingerprintBytes(bytes: Uint8Array, modifiedAt = 0): SourceFingerprint {
  return { ...contentIdentity(bytes), modifiedAt };
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
    if (data.version !== RECOVERY_VERSION && data.version !== 2) return null;
    if (typeof data.id !== 'string' || !data.journal || !Array.isArray(data.journal.entries)) {
      return null;
    }
    if (
      data.version === 2 &&
      (!data.checkpoint?.document || !data.checkpoint.engine || !data.checkpoint.blobs)
    )
      return null;
    return {
      version: data.version,
      id: data.id,
      path: typeof data.path === 'string' ? data.path : null,
      title: typeof data.title === 'string' ? data.title : 'Untitled',
      savedAt: typeof data.savedAt === 'number' ? data.savedAt : 0,
      source: data.source ?? null,
      journal: data.journal,
      changes: data.journal.entries.length,
      ...(data.version === 2 && data.checkpoint ? { checkpoint: data.checkpoint } : {}),
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
  const sourceChanged = !sameSource(record.source, currentSource);
  if (sourceChanged)
    return { applied: 0, skipped: record.changes, skippedTypes: [], sourceChanged: true };
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
  putBlob(id: string, bytes: Uint8Array): Promise<string>;
  readBlob(id: string, hash: string): Promise<Uint8Array>;
}

export function ipcRecoveryStorage(): RecoveryStorage {
  return {
    putBlob: (id, bytes) => invoke('recovery:putBlob', id, bytes),
    readBlob: (id, hash) => invoke('recovery:readBlob', id, hash),
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
  const binaries = new Map<string, Uint8Array>();
  return {
    putBlob: async (id, bytes) => {
      const digest = await crypto.subtle.digest('SHA-256', bytes.slice());
      const hash = [...new Uint8Array(digest)].map((n) => n.toString(16).padStart(2, '0')).join('');
      binaries.set(`${id}/${hash}`, bytes.slice());
      return hash;
    },
    readBlob: (id, hash) => {
      const bytes = binaries.get(`${id}/${hash}`);
      if (!bytes) return Promise.reject(new Error('Missing recovery content'));
      return Promise.resolve(bytes.slice());
    },
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
      for (const key of binaries.keys()) if (key.startsWith(`${id}/`)) binaries.delete(key);
      return Promise.resolve();
    },
    clear: () => {
      map.clear();
      binaries.clear();
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
    if (record && (record.checkpoint || record.journal.entries.length > 0)) records.push(record);
  }
  return records;
}

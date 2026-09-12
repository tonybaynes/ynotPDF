/**
 * Crash recovery (M21): the record, the fingerprint that keeps it honest, and the replay.
 *
 * The acceptance test the brief asks for — kill the app after edits, next launch offers recovery
 * and replays them — is here in miniature and again end to end in `test/e2e/save.spec.ts`. This
 * suite proves the parts: that a record round-trips, that a changed source is noticed, that a
 * replay puts the model back exactly, and that a step which cannot be replayed is counted rather
 * than quietly dropped.
 */

import { describe, expect, it } from 'vitest';
import type { Document } from '@core/Document';
import {
  MovePageCommand,
  RotatePagesCommand,
  SetMetadataCommand,
  SetPageLabelCommand,
} from '@core/commands';
import { command } from '@core/Command';
import {
  buildRecoveryRecord,
  describeOutcome,
  fingerprintBytes,
  hashBytes,
  listRecoverable,
  memoryRecoveryStorage,
  parseRecoveryRecord,
  RECOVERY_VERSION,
  replayRecord,
  sameSource,
} from '@modules/M21-save/recovery';
import { relativeTime } from '@modules/M21-save/dialogs';
import { openFake, must } from '../core/helpers';

const NOW = Date.UTC(2026, 8, 8, 12, 0, 0);

/** A document with four changes in its journal, and its record. */
async function editedDocument(): Promise<Document> {
  const { doc } = await openFake();
  await doc.apply(new RotatePagesCommand(doc, [doc.page(0).id], 90, true));
  doc.breakMerge();
  await doc.apply(new SetPageLabelCommand(doc, doc.page(1).id, 'Two'));
  await doc.apply(new MovePageCommand(doc, doc.page(3).id, 0));
  await doc.apply(new SetMetadataCommand(doc, { title: 'Half-finished' }));
  return doc;
}

describe('the fingerprint', () => {
  it('changes when a single byte changes', () => {
    const a = new Uint8Array([1, 2, 3, 4, 5]);
    const b = new Uint8Array([1, 2, 3, 4, 6]);
    expect(hashBytes(a)).not.toBe(hashBytes(b));
  });

  it('changes when two bytes swap places', () => {
    // A plain sum would miss this; the position is folded into the second pass for exactly this.
    expect(hashBytes(new Uint8Array([1, 2]))).not.toBe(hashBytes(new Uint8Array([2, 1])));
  });

  it('is stable for the same bytes', () => {
    const bytes = new Uint8Array(1000).map((_v, i) => i % 251);
    expect(hashBytes(bytes)).toBe(hashBytes(bytes.slice()));
  });

  it('hashes the whole of a large file, including its middle', () => {
    const size = 5 * 1024 * 1024;
    const big = new Uint8Array(size).map((_v, i) => i % 253);
    const base = fingerprintBytes(big);
    expect(base.size).toBe(size);
    expect(base.hash).toHaveLength(16);
    const middleChanged = big.slice();
    const middle = Math.floor(size / 2);
    middleChanged[middle] = (middleChanged[middle] ?? 0) ^ 0xff;
    expect(sameSource(base, fingerprintBytes(middleChanged))).toBe(false);

    const headChanged = big.slice();
    headChanged[0] = (headChanged[0] ?? 0) ^ 0xff;
    expect(sameSource(base, fingerprintBytes(headChanged))).toBe(false);

    const tailChanged = big.slice();
    tailChanged[size - 1] = (tailChanged[size - 1] ?? 0) ^ 0xff;
    expect(sameSource(base, fingerprintBytes(tailChanged))).toBe(false);
  });

  it('a length change alone is enough', () => {
    const a = fingerprintBytes(new Uint8Array(10));
    const b = fingerprintBytes(new Uint8Array(11));
    expect(sameSource(a, b)).toBe(false);
  });

  it('an unknown fingerprint never claims a match', () => {
    expect(sameSource(null, fingerprintBytes(new Uint8Array(1)))).toBe(false);
    expect(sameSource(fingerprintBytes(new Uint8Array(1)), null)).toBe(false);
  });
});

describe('the record', () => {
  it('carries the journal, the path and the fingerprint', async () => {
    const doc = await editedDocument();
    const source = fingerprintBytes(new Uint8Array([1, 2, 3]), 1234);
    const record = buildRecoveryRecord(doc, { id: 'abc', source, now: NOW });
    expect(record.version).toBe(RECOVERY_VERSION);
    expect(record.changes).toBe(4);
    expect(record.journal.complete).toBe(true);
    expect(record.source).toEqual(source);
    expect(record.savedAt).toBe(NOW);
    await doc.close();
  });

  it('round-trips through JSON', async () => {
    const doc = await editedDocument();
    const record = buildRecoveryRecord(doc, { id: 'abc', source: null, now: NOW });
    const parsed = must(parseRecoveryRecord(JSON.stringify(record)), 'parsed record');
    expect(parsed).toEqual(record);
    await doc.close();
  });

  it('refuses anything it does not understand rather than half-reading it', () => {
    expect(parseRecoveryRecord('not json')).toBeNull();
    expect(parseRecoveryRecord('{}')).toBeNull();
    expect(parseRecoveryRecord(JSON.stringify({ version: 999 }))).toBeNull();
    expect(parseRecoveryRecord(JSON.stringify({ version: RECOVERY_VERSION, id: 'a' }))).toBeNull();
  });

  it('counts a step it cannot replay rather than dropping it', async () => {
    const { doc } = await openFake();
    await doc.apply(new RotatePagesCommand(doc, [doc.page(0).id], 90, true));
    // A command with no `toJSON` — which is what a module that has not written a codec yet gives.
    await doc.apply(
      command(
        'mystery.change',
        'Do something',
        () => undefined,
        () => undefined,
      ),
    );
    const record = buildRecoveryRecord(doc, { id: 'x', source: null, now: NOW });
    expect(record.changes).toBe(2);
    expect(record.journal.complete).toBe(false);
    await doc.close();
  });
});

describe('replaying a record', () => {
  it('puts the model back exactly where it was', async () => {
    const doc = await editedDocument();
    const wanted = doc.snapshot();
    const source = fingerprintBytes(new Uint8Array([1, 2, 3]));
    const record = buildRecoveryRecord(doc, { id: 'r', source, now: NOW });
    await doc.close();

    const { doc: fresh } = await openFake();
    const outcome = await replayRecord(fresh, record, source);
    expect(outcome.applied).toBe(4);
    expect(outcome.skipped).toBe(0);
    expect(fresh.snapshot()).toEqual(wanted);
    // The history came back too, so the reader can still undo what they had done.
    expect(fresh.undo.state.length).toBe(4);
    await fresh.close();
  });

  it('says so when the file on disk has changed underneath the journal', async () => {
    const doc = await editedDocument();
    const record = buildRecoveryRecord(doc, {
      id: 'r',
      source: fingerprintBytes(new Uint8Array([1, 2, 3])),
      now: NOW,
    });
    await doc.close();

    const { doc: fresh } = await openFake();
    const outcome = await replayRecord(fresh, record, fingerprintBytes(new Uint8Array([9, 9])));
    expect(outcome.sourceChanged).toBe(true);
    expect(outcome.applied).toBe(0);
    expect(fresh.undo.state.length).toBe(0);
    expect(describeOutcome(record, outcome)).toContain('changed since then');
    await fresh.close();
  });

  it('reports what it could not restore, in words', async () => {
    const { doc } = await openFake();
    await doc.apply(new RotatePagesCommand(doc, [doc.page(0).id], 90, true));
    await doc.apply(
      command(
        'mystery.change',
        'Do something',
        () => undefined,
        () => undefined,
      ),
    );
    const source = fingerprintBytes(new Uint8Array([1, 2, 3]));
    const record = buildRecoveryRecord(doc, { id: 'r', source, now: NOW });
    await doc.close();

    const { doc: fresh } = await openFake();
    const outcome = await replayRecord(fresh, record, source);
    expect(outcome.applied).toBe(1);
    expect(outcome.skipped).toBe(1);
    expect(outcome.skippedTypes).toEqual(['mystery.change']);
    const sentence = describeOutcome(record, outcome);
    expect(sentence).toContain('Restored 1 change');
    expect(sentence).toContain('1 of 2 could not be restored');
    await fresh.close();
  });
});

describe('the store', () => {
  it('lists newest first and skips what it cannot read', async () => {
    const storage = memoryRecoveryStorage();
    const doc = await editedDocument();
    await storage.save(
      'good',
      JSON.stringify(buildRecoveryRecord(doc, { id: 'good', source: null, now: NOW })),
    );
    await storage.save('rubbish', 'not a record');
    await doc.close();

    const records = await listRecoverable(storage);
    expect(records.map((r) => r.id)).toEqual(['good']);
  });

  it('a record with no changes in it is not offered', async () => {
    const storage = memoryRecoveryStorage();
    const { doc } = await openFake();
    await storage.save(
      'empty',
      JSON.stringify(buildRecoveryRecord(doc, { id: 'empty', source: null, now: NOW })),
    );
    await doc.close();
    expect(await listRecoverable(storage)).toEqual([]);
  });

  it('discarding removes one and clearing removes them all', async () => {
    const storage = memoryRecoveryStorage();
    await storage.save('a', '{}');
    await storage.save('b', '{}');
    expect(storage.size).toBe(2);
    await storage.discard('a');
    expect(storage.size).toBe(1);
    await storage.clear();
    expect(storage.size).toBe(0);
  });
});

describe('how long ago', () => {
  it('says it in words, in en-GB', () => {
    const now = Date.UTC(2026, 8, 8, 12, 0, 0);
    expect(relativeTime(now - 30_000, now)).toMatch(/30 seconds ago/);
    expect(relativeTime(now - 4 * 60_000, now)).toMatch(/4 minutes ago/);
    expect(relativeTime(now - 3 * 3_600_000, now)).toMatch(/3 hours ago/);
    expect(relativeTime(now - 26 * 3_600_000, now)).toMatch(/yesterday/i);
  });
});

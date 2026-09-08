/**
 * Save settings and the writer client (M21).
 *
 * The settings half checks the same thing M11's does: an unset key falls back to the default, a
 * value of the wrong shape is ignored rather than trusted, and the schema the preferences dialog
 * will render actually matches the defaults the code uses.
 *
 * The client half proves the worker protocol without a `Worker`: `serveWriter` and `WriterClient`
 * are joined by a pair of fake ports, so the messages that would cross a thread boundary are
 * exercised on this one.
 */

import { describe, expect, it } from 'vitest';
import { emptyWritePlan, WriteCancelled, WriteUnsupported } from '@engine/Writer';
import {
  DEFAULT_SAVE_SETTINGS,
  memorySettingsStorage,
  readSaveSettings,
  SAVE_SETTINGS_SCHEMA,
  saveSettingKey,
  writeSaveSetting,
  type SaveSettings,
} from '@modules/M21-save/settings';
import { WriterClient, type WriterWorkerLike } from '@modules/M21-save/WriterClient';
import { serveWriter, type WriterPort } from '@modules/M21-save/writer.worker';
import type { WriterFromWorker, WriterToWorker } from '@modules/M21-save/writerProtocol';
import { PDFDocument } from 'pdf-lib';

describe('settings', () => {
  it('an unset key falls back to its default', async () => {
    expect(await readSaveSettings(memorySettingsStorage())).toEqual(DEFAULT_SAVE_SETTINGS);
  });

  it('reads what was written', async () => {
    const storage = memorySettingsStorage();
    await writeSaveSetting(storage, 'autosaveMinutes', 15);
    await writeSaveSetting(storage, 'keepBackup', true);
    const settings = await readSaveSettings(storage);
    expect(settings.autosaveMinutes).toBe(15);
    expect(settings.keepBackup).toBe(true);
    // Everything else is still the default.
    expect(settings.objectStreams).toBe(DEFAULT_SAVE_SETTINGS.objectStreams);
  });

  it('a value of the wrong type is ignored rather than trusted', async () => {
    const storage = memorySettingsStorage({
      'save.autosaveMinutes': 'lots',
      'save.keepBackup': 1,
      'save.watchFiles': null,
    });
    expect(await readSaveSettings(storage)).toEqual(DEFAULT_SAVE_SETTINGS);
  });

  it('every setting has a key, and every key is under the save namespace', () => {
    for (const name of Object.keys(DEFAULT_SAVE_SETTINGS) as Array<keyof SaveSettings>) {
      expect(saveSettingKey(name)).toMatch(/^save\./);
    }
  });

  it('the schema the preferences dialog renders matches the defaults the code uses', () => {
    expect(SAVE_SETTINGS_SCHEMA.namespace).toBe('save');
    for (const [key, spec] of Object.entries(SAVE_SETTINGS_SCHEMA.properties)) {
      const name = key as keyof SaveSettings;
      expect(DEFAULT_SAVE_SETTINGS[name], key).toBeDefined();
      expect(spec.default, key).toEqual(DEFAULT_SAVE_SETTINGS[name]);
      // Every setting is titled in words a reader can act on, not in a variable name.
      expect(spec.title.length, key).toBeGreaterThan(8);
    }
    expect(Object.keys(SAVE_SETTINGS_SCHEMA.properties).sort()).toEqual(
      Object.keys(DEFAULT_SAVE_SETTINGS).sort(),
    );
  });
});

/** Joins a `WriterClient` to `serveWriter` through a pair of in-process ports. */
function connectedWriter(): { client: WriterClient; dispose: () => void } {
  const toWorker: ((ev: MessageEvent<WriterToWorker>) => void)[] = [];
  const toClient: ((ev: MessageEvent) => void)[] = [];
  let alive = true;
  const deliver = (listeners: ((ev: MessageEvent) => void)[], data: unknown): void => {
    if (!alive) return;
    // Asynchronously, like a real `postMessage`, so nothing depends on synchronous delivery.
    queueMicrotask(() => {
      for (const l of listeners) l({ data } as MessageEvent);
    });
  };

  const port: WriterPort = {
    postMessage: (message: WriterFromWorker) => {
      deliver(toClient, message);
    },
    addEventListener: (_type, listener) => {
      toWorker.push(listener);
    },
  };
  const worker: WriterWorkerLike = {
    postMessage: (message: WriterToWorker) => {
      deliver(toWorker as ((ev: MessageEvent) => void)[], message);
    },
    addEventListener: (type: string, listener: (ev: never) => void) => {
      if (type === 'message') toClient.push(listener as (ev: MessageEvent) => void);
    },
    terminate: () => {
      alive = false;
    },
  };
  serveWriter(port);
  const client = new WriterClient(worker);
  return {
    client,
    dispose: () => {
      client.dispose();
    },
  };
}

/** A tiny one-page document to hand the writer. */
async function onePage(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create({ updateMetadata: false });
  pdf.addPage([200, 200]);
  return pdf.save({ useObjectStreams: false, updateFieldAppearances: false });
}

describe('the writer client', () => {
  it('runs in-process when there is no Worker, which is what Node gets', async () => {
    const client = new WriterClient(null);
    expect(client.offThread).toBe(false);
    const result = await client.write({ bytes: await onePage(), plan: emptyWritePlan(1) }).promise;
    expect(result.bytes.byteLength).toBeGreaterThan(0);
    client.dispose();
  });

  it('carries a write across the port and reports progress', async () => {
    const { client, dispose } = connectedWriter();
    expect(client.offThread).toBe(true);
    const phases: string[] = [];
    const result = await client.write({
      bytes: await onePage(),
      plan: emptyWritePlan(1),
      onProgress: (_fraction, phase) => {
        phases.push(phase);
      },
    }).promise;
    expect(result.bytes.byteLength).toBeGreaterThan(0);
    expect(result.warnings).toEqual([]);
    expect(phases).toContain('serialise');
    dispose();
  });

  it('a cancel crosses the port and comes back as WriteCancelled', async () => {
    const { client, dispose } = connectedWriter();
    const handle = client.write({
      bytes: await onePage(),
      plan: emptyWritePlan(1),
      onProgress: () => {
        handle.cancel();
      },
    });
    await expect(handle.promise).rejects.toThrow(WriteCancelled);
    dispose();
  });

  it('a typed failure survives the crossing with its reason intact', async () => {
    const { client, dispose } = connectedWriter();
    const handle = client.write({
      bytes: new TextEncoder().encode('not a pdf'),
      plan: emptyWritePlan(1),
    });
    await expect(handle.promise).rejects.toMatchObject({
      name: 'WriteUnsupported',
      reason: 'corrupt',
    });
    await expect(handle.promise).rejects.toBeInstanceOf(WriteUnsupported);
    dispose();
  });

  it('disposing rejects anything still in flight rather than leaving it hanging', async () => {
    const { client } = connectedWriter();
    const handle = client.write({ bytes: await onePage(), plan: emptyWritePlan(1) });
    client.dispose();
    await expect(handle.promise).rejects.toThrow(WriteCancelled);
  });

  it('cancelling a write that has already finished does nothing', async () => {
    const { client, dispose } = connectedWriter();
    const handle = client.write({ bytes: await onePage(), plan: emptyWritePlan(1) });
    await handle.promise;
    expect(() => {
      handle.cancel();
    }).not.toThrow();
    dispose();
  });
});

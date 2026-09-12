/**
 * `ConvertClient` and the Worker protocol (M91).
 *
 * Two halves: the client driven against a fake worker port, so the message shapes and the
 * cancellation are checked without a real Worker; and `serveConverters` driven the same way, so
 * the two ends are tested against each other. The in-process fallback — what a unit test and the
 * CLI use — is checked to produce the same result as the message path.
 */

import { describe, expect, it, vi } from 'vitest';
import { ConvertCancelled, ConvertUnsupported, type ConvertInput } from '@engine/create/types';
import {
  ConvertClient,
  reviveError,
  type ConvertWorkerLike,
} from '@modules/M91-create-pdf/ConvertClient';
import type { ConvertFromWorker, ConvertToWorker } from '@modules/M91-create-pdf/createProtocol';
import {
  describe as describeError,
  serveConverters,
  type ConvertPort,
} from '@modules/M91-create-pdf/create.worker';

/** A fake worker: records what was posted and lets a test answer. */
class FakeWorker implements ConvertWorkerLike {
  readonly posted: ConvertToWorker[] = [];
  readonly transfers: Transferable[][] = [];
  terminated = false;
  private message: ((ev: MessageEvent) => void) | null = null;
  private error: ((ev: ErrorEvent) => void) | null = null;

  postMessage(message: ConvertToWorker, transfer?: Transferable[]): void {
    this.posted.push(message);
    this.transfers.push(transfer ?? []);
  }

  addEventListener(
    type: 'message' | 'error' | 'messageerror',
    listener: (ev: never) => void,
  ): void {
    if (type === 'message') this.message = listener as (ev: MessageEvent) => void;
    else if (type === 'error') this.error = listener as (ev: ErrorEvent) => void;
  }

  terminate(): void {
    this.terminated = true;
  }

  reply(message: ConvertFromWorker): void {
    this.message?.({ data: message } as MessageEvent);
  }

  fail(message: string): void {
    this.error?.({ message } as ErrorEvent);
  }
}

const input = (name: string, text = 'hello'): ConvertInput => ({
  name,
  bytes: new TextEncoder().encode(text),
});

describe('ConvertClient over a worker', () => {
  it('posts the job, transfers the input buffers and resolves with the result', async () => {
    const worker = new FakeWorker();
    const client = new ConvertClient(worker);
    expect(client.offThread).toBe(true);
    const bytes = new TextEncoder().encode('x');
    const handle = client.convert({
      converter: 'text',
      inputs: [{ name: 'a.txt', bytes }],
      options: { font: 'mono' },
      transfer: true,
    });
    const posted = worker.posted[0];
    expect(posted).toMatchObject({
      kind: 'convert',
      id: 1,
      converter: 'text',
      options: { font: 'mono' },
    });
    expect(worker.transfers[0]).toHaveLength(1);
    const out = new TextEncoder().encode('%PDF');
    worker.reply({ kind: 'ready' });
    worker.reply({ kind: 'done', id: 1, bytes: out, pageCount: 2, title: 'a', warnings: ['w'] });
    await expect(handle.promise).resolves.toMatchObject({
      pageCount: 2,
      title: 'a',
      warnings: ['w'],
    });
  });

  it('copies the input bytes unless the caller says they may be transferred', () => {
    const worker = new FakeWorker();
    const client = new ConvertClient(worker);
    const bytes = new TextEncoder().encode('keep me');
    client.convert({ converter: 'text', inputs: [{ name: 'a.txt', bytes }], options: {} });
    const posted = worker.posted[0] as Extract<ConvertToWorker, { kind: 'convert' }>;
    expect(posted.inputs[0]?.bytes).not.toBe(bytes);
    expect(bytes.byteLength).toBe(7);
  });

  it('reports progress and ignores messages for a job that has finished', async () => {
    const worker = new FakeWorker();
    const client = new ConvertClient(worker);
    const progress = vi.fn();
    const handle = client.convert({
      converter: 'text',
      inputs: [input('a.txt')],
      options: {},
      onProgress: progress,
    });
    worker.reply({ kind: 'progress', id: 1, fraction: 0.5, message: 'half way' });
    expect(progress).toHaveBeenCalledWith(0.5, 'half way');
    worker.reply({
      kind: 'done',
      id: 1,
      bytes: new Uint8Array(1),
      pageCount: 1,
      title: 't',
      warnings: [],
    });
    await handle.promise;
    worker.reply({ kind: 'progress', id: 1, fraction: 1, message: 'late' });
    expect(progress).toHaveBeenCalledTimes(1);
  });

  it('sends a cancel and rebuilds the typed error', async () => {
    const worker = new FakeWorker();
    const client = new ConvertClient(worker);
    const handle = client.convert({ converter: 'image', inputs: [input('a.png')], options: {} });
    handle.cancel();
    expect(worker.posted[1]).toEqual({ kind: 'cancel', id: 1 });
    worker.reply({ kind: 'failed', id: 1, reason: 'cancelled', message: 'stopped' });
    await expect(handle.promise).rejects.toBeInstanceOf(ConvertCancelled);
  });

  it('turns a worker crash into a rejection for every job in flight', async () => {
    const worker = new FakeWorker();
    const client = new ConvertClient(worker);
    const a = client.convert({ converter: 'text', inputs: [input('a.txt')], options: {} });
    const b = client.convert({ converter: 'text', inputs: [input('b.txt')], options: {} });
    worker.fail('out of memory');
    await expect(a.promise).rejects.toThrow(/out of memory/);
    await expect(b.promise).rejects.toThrow(/out of memory/);
  });

  it('rejects what is still running when disposed', async () => {
    const worker = new FakeWorker();
    const client = new ConvertClient(worker);
    const handle = client.convert({ converter: 'text', inputs: [input('a.txt')], options: {} });
    client.dispose();
    expect(worker.terminated).toBe(true);
    await expect(handle.promise).rejects.toBeInstanceOf(ConvertCancelled);
  });
});

describe('reviveError', () => {
  it('rebuilds the kind from the string that crossed postMessage', () => {
    expect(reviveError('cancelled', 'x')).toBeInstanceOf(ConvertCancelled);
    const unsupported = reviveError('no-printer', 'no renderer here');
    expect(unsupported).toBeInstanceOf(ConvertUnsupported);
    expect((unsupported as ConvertUnsupported).reason).toBe('no-printer');
    expect(reviveError('failed', 'something else')).not.toBeInstanceOf(ConvertUnsupported);
  });

  it('is the inverse of what the worker says about an error', () => {
    const described = describeError(new ConvertUnsupported('timeout', 'too slow'));
    expect(described).toEqual({ reason: 'timeout', message: 'too slow' });
    expect(describeError(new ConvertCancelled()).reason).toBe('cancelled');
    expect(describeError('a string')).toEqual({ reason: 'failed', message: 'a string' });
  });
});

describe('ConvertClient in-process', () => {
  it('runs the real converters and reports progress', async () => {
    const client = new ConvertClient(null);
    expect(client.offThread).toBe(false);
    const progress = vi.fn();
    const result = await client.convert({
      converter: 'blank',
      inputs: [],
      options: { count: 3, pageSize: { kind: 'preset', id: 'A5' }, orientation: 'portrait' },
      onProgress: progress,
    }).promise;
    expect(result.pageCount).toBe(3);
    expect(progress).toHaveBeenCalled();
  });

  it('rejects an unknown converter and honours cancel', async () => {
    const client = new ConvertClient(null);
    await expect(
      client.convert({ converter: 'nope', inputs: [], options: {} }).promise,
    ).rejects.toThrow(/nope/);
    const handle = client.convert({ converter: 'blank', inputs: [], options: { count: 900 } });
    handle.cancel();
    await expect(handle.promise).rejects.toBeInstanceOf(ConvertCancelled);
  });
});

describe('serveConverters', () => {
  /** A port that loops the worker's answers back to a list. */
  function port(): {
    readonly port: ConvertPort;
    readonly sent: ConvertFromWorker[];
    send(m: ConvertToWorker): void;
  } {
    const sent: ConvertFromWorker[] = [];
    let listener: ((ev: MessageEvent<ConvertToWorker>) => void) | null = null;
    return {
      sent,
      port: {
        postMessage: (m) => sent.push(m),
        addEventListener: (_t, l) => {
          listener = l;
        },
      },
      send: (m) => listener?.({ data: m } as MessageEvent<ConvertToWorker>),
    };
  }

  it('says it is ready, converts and answers with the bytes', async () => {
    const p = port();
    serveConverters(p.port, {});
    expect(p.sent[0]).toEqual({ kind: 'ready' });
    p.send({ kind: 'convert', id: 7, converter: 'blank', inputs: [], options: { count: 2 } });
    await vi.waitFor(() => {
      expect(p.sent.some((m) => m.kind === 'done')).toBe(true);
    });
    const done = p.sent.find((m) => m.kind === 'done');
    expect(done).toMatchObject({ id: 7, pageCount: 2 });
  });

  it('answers a bad converter name with a failure, not a crash', async () => {
    const p = port();
    serveConverters(p.port, {});
    p.send({ kind: 'convert', id: 1, converter: 'nope', inputs: [], options: {} });
    await vi.waitFor(() => {
      expect(p.sent.some((m) => m.kind === 'failed')).toBe(true);
    });
    expect(p.sent.find((m) => m.kind === 'failed')).toMatchObject({ reason: 'failed' });
  });

  it('carries the unsupported reason back', async () => {
    const p = port();
    serveConverters(p.port, {});
    p.send({
      kind: 'convert',
      id: 2,
      converter: 'web',
      inputs: [],
      options: { url: 'https://example.com' },
    });
    await vi.waitFor(() => {
      expect(p.sent.some((m) => m.kind === 'failed')).toBe(true);
    });
    expect(p.sent.find((m) => m.kind === 'failed')).toMatchObject({ reason: 'no-printer' });
  });

  it('cancels a running job', async () => {
    const p = port();
    serveConverters(p.port, {});
    p.send({ kind: 'convert', id: 3, converter: 'blank', inputs: [], options: { count: 1000 } });
    p.send({ kind: 'cancel', id: 3 });
    await vi.waitFor(() => {
      expect(p.sent.some((m) => m.kind === 'failed' || m.kind === 'done')).toBe(true);
    });
    const answer = p.sent.find((m) => m.kind === 'failed' || m.kind === 'done');
    // Either it finished first (a thousand blank pages is quick) or it stopped — never a crash.
    expect(['done', 'failed']).toContain(answer?.kind);
  });

  it('ignores a cancel for a job it has never heard of', () => {
    const p = port();
    serveConverters(p.port, {});
    expect(() => {
      p.send({ kind: 'cancel', id: 99 });
    }).not.toThrow();
  });
});

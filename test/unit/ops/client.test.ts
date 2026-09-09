/**
 * `OpsClient` and the Worker it talks to (M41), driven through a fake port.
 *
 * The protocol is where a cancel either works or silently does not, and where a job's answer
 * either reaches the caller who asked for it or the one before. Both are invisible in the app
 * until the day they matter, so they are tested here rather than left to the e2e suite.
 *
 * The in-process path — what runs in a unit test and in a browser with no `Worker` — is exercised
 * by every other file in this folder, so what is left is the two ends of the message passing.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { OpsClient, type OpsWorkerLike } from '@modules/M41-merge-split-crop/OpsClient';
import { serveOps, type OpsPort } from '@modules/M41-merge-split-crop/ops.worker';
import type { OpsFromWorker, OpsToWorker } from '@modules/M41-merge-split-crop/opsProtocol';
import { OpCancelled, OpFailed } from '@engine/ops/types';

const FIXTURES = join(process.cwd(), 'test', 'fixtures');

function fixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(FIXTURES, name)));
}

/**
 * A `Worker` that is actually `serveOps` on this thread, with the messages posted asynchronously
 * so the ordering is the ordering a real worker would give.
 */
function looped(): OpsWorkerLike {
  const toClient = new Set<(ev: MessageEvent) => void>();
  const toWorker = new Set<(ev: MessageEvent<OpsToWorker>) => void>();
  const port: OpsPort = {
    postMessage: (message: OpsFromWorker) => {
      queueMicrotask(() => {
        for (const listener of toClient) listener({ data: message } as MessageEvent);
      });
    },
    addEventListener: (_type, listener) => {
      toWorker.add(listener);
    },
  };
  serveOps(port);
  return {
    postMessage: (message) => {
      queueMicrotask(() => {
        for (const listener of toWorker) listener({ data: message } as MessageEvent<OpsToWorker>);
      });
    },
    addEventListener: (type, listener) => {
      if (type === 'message') toClient.add(listener as (ev: MessageEvent) => void);
    },
    terminate: () => {
      toClient.clear();
      toWorker.clear();
    },
  };
}

describe('OpsClient over a port', () => {
  it('says it is off-thread when it has a worker, and not when it has not', () => {
    expect(new OpsClient(looped()).offThread).toBe(true);
    expect(new OpsClient(null).offThread).toBe(false);
  });

  it('combines and answers the caller who asked', async () => {
    const client = new OpsClient(looped());
    const first = client.combine([{ name: 'blank.pdf', bytes: fixture('blank.pdf') }], {
      bookmarkPerFile: false,
    });
    const second = client.combine(
      [
        { name: 'multipage.pdf', bytes: fixture('multipage.pdf') },
        { name: 'text.pdf', bytes: fixture('text.pdf') },
      ],
      { bookmarkPerFile: false },
    );
    // Deliberately awaited out of order: the answers are matched by id, not by arrival.
    expect((await second.promise).pageCount).toBe(6);
    expect((await first.promise).pageCount).toBe(1);
    client.dispose();
  });

  it('reports progress as sentences, in order', async () => {
    const client = new OpsClient(looped());
    const messages: string[] = [];
    const job = client.split(
      fixture('multipage.pdf'),
      { rule: { kind: 'count', pages: 1 }, baseName: 'multipage' },
      (_fraction, message) => messages.push(message),
    );
    const result = await job.promise;
    expect(result.parts).toHaveLength(5);
    expect(messages.length).toBeGreaterThan(0);
    expect(messages[messages.length - 1]).toBe('Done');
    client.dispose();
  });

  it('a cancel reaches the work and rejects the caller with a cancellation', async () => {
    const client = new OpsClient(looped());
    const job = client.split(fixture('huge-page-count.pdf'), {
      rule: { kind: 'count', pages: 1 },
      baseName: 'huge',
    });
    job.cancel();
    await expect(job.promise).rejects.toBeInstanceOf(OpCancelled);
    client.dispose();
  });

  it('turns a failure into a worded error rather than an unhandled rejection', async () => {
    const client = new OpsClient(looped());
    const job = client.flatten(fixture('corrupt.pdf'), {});
    await expect(job.promise).rejects.toBeInstanceOf(OpFailed);
    client.dispose();
  });

  it('rejects everything in flight when the worker stops', async () => {
    const worker = looped();
    const client = new OpsClient(worker);
    const job = client.deskew(fixture('skewed.pdf'), { angles: { 0: 2 } });
    client.dispose();
    await expect(job.promise).rejects.toBeInstanceOf(OpCancelled);
  });

  it('runs in-process, with the same answers, when there is no worker at all', async () => {
    const client = new OpsClient(null);
    const result = await client.crop(fixture('blank.pdf'), {
      box: 'crop',
      rect: { x0: 10, y0: 10, x1: 200, y1: 300 },
    }).promise;
    expect(result.pageCount).toBe(1);
    const cancelled = client.combine([{ name: 'blank.pdf', bytes: fixture('blank.pdf') }], {});
    cancelled.cancel();
    await expect(cancelled.promise).rejects.toBeInstanceOf(OpCancelled);
  });
});

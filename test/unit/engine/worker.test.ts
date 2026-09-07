import { describe, expect, it } from 'vitest';
import { EngineClient, type WorkerLike } from '@engine/EngineClient';
import { EngineError, NotImplementedEngine, type DocHandle } from '@engine/PdfEngine';
import type { RpcFromWorker, RpcToWorker } from '@engine/rpc';
import { serveEngine } from '@engine/worker';
import { engine, fixture } from './helpers';

/** An in-memory message channel pretending to be a Worker on both ends. */
function fakeChannel(): { worker: WorkerLike; port: Parameters<typeof serveEngine>[1] } {
  const toWorker: ((ev: MessageEvent<RpcToWorker>) => void)[] = [];
  const toClient: ((ev: MessageEvent) => void)[] = [];
  const worker: WorkerLike = {
    postMessage(message) {
      queueMicrotask(() => {
        for (const l of toWorker) l({ data: message } as MessageEvent<RpcToWorker>);
      });
    },
    addEventListener(type: string, listener: (ev: never) => void) {
      if (type === 'message') toClient.push(listener as (ev: MessageEvent) => void);
    },
    terminate() {
      toWorker.length = 0;
    },
  };
  const port = {
    postMessage(message: RpcFromWorker) {
      queueMicrotask(() => {
        for (const l of toClient) l({ data: message } as MessageEvent);
      });
    },
    addEventListener(_type: 'message', listener: (ev: MessageEvent<RpcToWorker>) => void) {
      toWorker.push(listener);
    },
  };
  return { worker, port };
}

/** Renders block on a promise the test controls, so the queue can be observed. */
class SlowEngine extends NotImplementedEngine {
  readonly started: number[] = [];
  cancelCalls = 0;
  private release: (() => void) | null = null;
  override info(): Promise<{ name: string; version: string }> {
    return Promise.resolve({ name: 'slow', version: '1' });
  }
  override render(_doc: DocHandle, page: number): Promise<never> {
    this.started.push(page);
    return new Promise((_resolve, reject) => {
      this.release = () => {
        reject(new EngineError('cancelled', 'aborted'));
      };
    });
  }
  cancelCurrent(): void {
    this.cancelCalls++;
    this.release?.();
  }
}

describe('engine worker queue and cancellation', () => {
  it('serialises requests, drops cancelled queued ones and aborts the in-flight render', async () => {
    const { worker, port } = fakeChannel();
    const client = new EngineClient(worker);
    const slow = new SlowEngine();
    serveEngine(Promise.resolve(slow), port);
    await client.ready();
    const doc = 1 as DocHandle;
    const first = client.request('render', [doc, 0, 1]);
    const second = client.request('render', [doc, 1, 1]);
    const third = client.request('render', [doc, 2, 1]);
    const info = client.request('info', []);
    await new Promise((r) => setTimeout(r, 5));
    expect(slow.started).toEqual([0]); // one at a time
    expect(client.pendingCount).toBe(4);
    // Cancel a queued request: rejected locally, never started.
    second.cancel();
    await expect(second.promise).rejects.toMatchObject({ code: 'cancelled' });
    // Cancel the in-flight one: the engine is told to abort.
    first.cancel();
    await expect(first.promise).rejects.toMatchObject({ code: 'cancelled' });
    await new Promise((r) => setTimeout(r, 5));
    expect(slow.cancelCalls).toBe(1);
    expect(slow.started).toEqual([0, 2]);
    // cancelRenders drops what is left; non-render requests survive.
    expect(client.cancelRenders()).toBe(1);
    await expect(third.promise).rejects.toMatchObject({ code: 'cancelled' });
    expect(await info.promise).toEqual({ name: 'slow', version: '1' });
    expect(client.pendingCount).toBe(0);
    client.terminate();
  });

  it('queues requests that arrive before the engine is ready and reports boot failures', async () => {
    const { worker, port } = fakeChannel();
    const client = new EngineClient(worker);
    const pending = client.engine.info();
    serveEngine(Promise.reject(new Error('wasm missing')), port);
    await expect(pending).rejects.toMatchObject({ code: 'internal', message: /wasm missing/ });
    client.terminate();
  });

  it('stays responsive within 100 ms when 50 queued renders are cancelled mid-scroll', async () => {
    const real = await engine();
    const { worker, port } = fakeChannel();
    const client = new EngineClient(worker);
    serveEngine(real, port);
    await client.ready();
    const doc = await client.engine.open(fixture('scanned.pdf'));
    const handles = Array.from({ length: 50 }, () => client.request('render', [doc, 0, 2]));
    // Attach handlers now: cancellation rejects synchronously and must not count as unhandled.
    const settled = Promise.allSettled(handles.map((h) => h.promise));
    await new Promise((r) => setTimeout(r, 30)); // a couple of renders complete, the rest queue
    const t0 = performance.now();
    const cancelled = client.cancelRenders(doc);
    const count = await client.engine.pageCount(doc);
    const elapsed = performance.now() - t0;
    expect(count).toBe(1);
    expect(cancelled).toBeGreaterThan(40);
    expect(elapsed).toBeLessThan(100);
    const results = await settled;
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(rejected.length).toBeGreaterThanOrEqual(cancelled);
    expect(rejected.every((r) => (r.reason as EngineError).code === 'cancelled')).toBe(true);
    // The engine is intact afterwards: a fresh render succeeds.
    const after = await real.renderRaw(doc, 0, 1);
    expect(after.width).toBe(595);
    await client.engine.close(doc);
    client.terminate();
  });
});

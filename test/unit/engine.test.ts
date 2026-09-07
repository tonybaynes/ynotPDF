import { describe, expect, it } from 'vitest';
import { EngineClient, type WorkerLike } from '@engine/EngineClient';
import {
  ENGINE_METHODS,
  EngineError,
  NotImplementedEngine,
  NotImplementedError,
  type PdfEngine,
} from '@engine/PdfEngine';
import { serveEngine } from '@engine/worker';
import type { RpcFromWorker, RpcToWorker } from '@engine/rpc';
import { collectTransferables } from '@engine/rpc';

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

class FakeEngine extends NotImplementedEngine {
  override info(): Promise<{ name: string; version: string }> {
    return Promise.resolve({ name: 'fake', version: '1' });
  }
  override pageCount(): Promise<number> {
    return Promise.resolve(3);
  }
  override save(_doc: never, _o: never, progress?: (f: number) => void): Promise<Uint8Array> {
    progress?.(0.5);
    progress?.(1);
    return Promise.resolve(new Uint8Array([1, 2, 3]));
  }
  override open(): Promise<never> {
    return Promise.reject(new EngineError('password-required', 'needs a password'));
  }
  override close(): Promise<void> {
    return Promise.reject(new Error('plain failure'));
  }
}

describe('engine RPC', () => {
  it('forwards calls, results, progress and typed errors across the channel', async () => {
    const { worker, port } = fakeChannel();
    const client = new EngineClient(worker);
    serveEngine(new FakeEngine(), port);
    await client.ready();
    expect(await client.engine.info()).toEqual({ name: 'fake', version: '1' });
    expect(await client.engine.pageCount(1 as never)).toBe(3);
    const seen: number[] = [];
    const bytes = await client.engine.save(1 as never, undefined, (f) => seen.push(f));
    expect(Array.from(bytes)).toEqual([1, 2, 3]);
    expect(seen).toEqual([0.5, 1]);
    await expect(client.engine.open(new Uint8Array())).rejects.toMatchObject({
      name: 'EngineError',
      code: 'password-required',
    });
    await expect(client.engine.close(1 as never)).rejects.toMatchObject({
      code: 'internal',
      message: 'plain failure',
    });
    await expect(client.engine.render(1 as never, 0, 1)).rejects.toMatchObject({
      code: 'not-implemented',
    });
    client.terminate();
    await expect(client.engine.pageCount(1 as never)).rejects.toMatchObject({ code: 'internal' });
  });

  it('NotImplementedEngine rejects every method with NotImplementedError', async () => {
    const e: PdfEngine = new NotImplementedEngine();
    for (const m of ENGINE_METHODS) {
      if (m === 'info') continue;
      // eslint-disable-next-line @typescript-eslint/unbound-method -- invoked via Reflect.apply with `e` as this
      const fn = e[m] as (...a: unknown[]) => Promise<unknown>;
      await expect(Reflect.apply(fn, e, [])).rejects.toBeInstanceOf(NotImplementedError);
    }
    expect(await e.info()).toEqual({ name: 'none', version: '0' });
  });

  it('collects transferables from nested results', () => {
    const buf = new ArrayBuffer(4);
    const view = new Uint8Array(8);
    const t = collectTransferables({ a: buf, b: [view, { c: 'x' }], d: 1 });
    expect(t).toEqual([buf, view.buffer]);
  });
});

import { describe, expect, it, vi } from 'vitest';
import { EngineClient, type WorkerLike } from '@engine/EngineClient';

function worker() {
  const listeners = new Map<string, Set<(event: never) => void>>();
  const terminate = vi.fn();
  const fake: WorkerLike = {
    postMessage: vi.fn(),
    terminate,
    addEventListener(type: string, listener: (event: never) => void) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)?.add(listener);
    },
    removeEventListener(type: string, listener: (event: never) => void) {
      listeners.get(type)?.delete(listener);
    },
  };
  const emit = (type: string, event: unknown): void => {
    for (const listener of listeners.get(type) ?? []) listener(event as never);
  };
  return { fake, emit, listeners, terminate };
}

describe('engine terminal states', () => {
  it.each([false, true])(
    'rejects pending and late callers on failure (already ready: %s)',
    async (ready) => {
      const w = worker();
      const client = new EngineClient(w.fake);
      if (ready) {
        w.emit('message', { data: { kind: 'ready' } });
        await client.ready();
      }
      const pending = expect(client.call('info', [])).rejects.toThrow(/crashed/);
      const readiness = ready
        ? Promise.resolve()
        : expect(client.ready()).rejects.toThrow(/crashed/);
      w.emit('error', { message: 'initialization failed' });
      await pending;
      await readiness;
      await expect(client.ready()).rejects.toThrow(/initialization failed/);
      await expect(client.call('info', [])).rejects.toThrow(/initialization failed/);
      expect(client.pendingCount).toBe(0);
      expect([...w.listeners.values()].every((listeners) => listeners.size === 0)).toBe(true);
      expect(w.terminate).toHaveBeenCalledTimes(1);
    },
  );

  it('settles readiness on termination before startup and does not revive on a late ready event', async () => {
    const w = worker();
    const client = new EngineClient(w.fake);
    const pending = expect(client.ready()).rejects.toThrow(/terminated/);
    client.terminate();
    w.emit('message', { data: { kind: 'ready' } });
    await pending;
    await expect(client.ready()).rejects.toThrow(/terminated/);
    client.terminate();
    expect(w.terminate).toHaveBeenCalledTimes(1);
  });
});

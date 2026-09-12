import { describe, expect, it, vi } from 'vitest';
import { emptyWritePlan } from '@engine/Writer';
import { WriterClient } from '@modules/M21-save/WriterClient';
import { OpsClient } from '@modules/M41-merge-split-crop/OpsClient';
import { ConvertClient } from '@modules/M91-create-pdf/ConvertClient';
import { ExportClient } from '@modules/M92-export/ExportClient';
import { OptimiseClient } from '@modules/M100-optimise-repair/OptimiseClient';

function worker() {
  const listeners = new Map<string, (event: never) => void>();
  return {
    postMessage: vi.fn(),
    terminate: vi.fn(),
    addEventListener(type: string, listener: (event: never) => void) {
      listeners.set(type, listener);
    },
    crash() {
      listeners.get('error')?.({ message: 'fault injected' } as never);
    },
  };
}
const factories = {
  writer(w: ReturnType<typeof worker>) {
    const c = new WriterClient(w);
    return {
      request: () => c.write({ bytes: new Uint8Array(), plan: emptyWritePlan(0) }),
      stop: () => {
        c.dispose();
      },
    };
  },
  operations(w: ReturnType<typeof worker>) {
    const c = new OpsClient(w);
    return {
      request: () => c.combine([], {}),
      stop: () => {
        c.dispose();
      },
    };
  },
  converter(w: ReturnType<typeof worker>) {
    const c = new ConvertClient(w);
    return {
      request: () => c.convert({ converter: 'text', inputs: [], options: {} }),
      stop: () => {
        c.dispose();
      },
    };
  },
  exporter(w: ReturnType<typeof worker>) {
    const c = new ExportClient(w);
    return {
      request: () => c.text([], { documentName: 'test' }),
      stop: () => {
        c.terminate();
      },
    };
  },
  optimiser(w: ReturnType<typeof worker>) {
    const c = new OptimiseClient(w, (bytes) => Promise.resolve({ bytes, warnings: [] }));
    return {
      request: () => c.audit(new Uint8Array()),
      stop: () => {
        c.dispose();
      },
    };
  },
};
for (const [name, factory] of Object.entries(factories)) {
  describe(name + ' terminal state', () => {
    it.each(['crash', 'dispose', 'post'] as const)(
      'settles current and future jobs after %s',
      async (cause) => {
        const w = worker();
        const client = factory(w);
        if (cause === 'post')
          w.postMessage.mockImplementation(() => {
            throw new Error('fault injected');
          });
        const first = client.request().promise;
        const settled = expect(first).rejects.toBeInstanceOf(Error);
        if (cause === 'crash') w.crash();
        if (cause === 'dispose') client.stop();
        await settled;
        const failure: unknown = await first.catch((error: unknown) => error);
        await expect(client.request().promise).rejects.toBe(failure);
        client.stop();
        w.crash();
        expect(w.terminate).toHaveBeenCalledTimes(1);
        expect(w.postMessage).toHaveBeenCalledTimes(1);
      },
    );
  });
}

/**
 * The writer Worker (M21).
 *
 * pdf-lib parses and serialises the whole object graph, and on a large document that is seconds
 * of solid work. On the main thread it would freeze the window — no progress bar could move and
 * no Cancel button could be pressed, which is exactly when the reader most wants both. So the
 * writer runs here, reports its phase back, and watches for a cancel between phases.
 *
 * The protocol is deliberately tiny (three message kinds); `WriterClient` is the other end.
 */

import { FullRewriteWriter } from '@engine/writers/FullRewriteWriter';
import {
  WriteCancelled,
  WriteUnsupported,
  type WritePlan,
  type WriteOptions,
} from '@engine/Writer';
import type { WriterFromWorker, WriterToWorker } from './writerProtocol';

/** Minimal worker surface, so `serveWriter` can be driven by a fake port in tests. */
export interface WriterPort {
  postMessage(message: WriterFromWorker, transfer?: Transferable[]): void;
  addEventListener(type: 'message', listener: (ev: MessageEvent<WriterToWorker>) => void): void;
}

/** Wires a writer to a message port. Exported so it can be unit-tested without a real Worker. */
export function serveWriter(port: WriterPort): void {
  const writer = new FullRewriteWriter();
  const controllers = new Map<number, AbortController>();

  const run = async (id: number, bytes: Uint8Array, plan: WritePlan, options: WriteOptions) => {
    const controller = new AbortController();
    controllers.set(id, controller);
    try {
      const result = await writer.write({
        bytes,
        plan,
        options,
        signal: controller.signal,
        progress: (fraction, phase) => {
          port.postMessage({ kind: 'progress', id, fraction, phase });
        },
      });
      port.postMessage(
        {
          kind: 'done',
          id,
          bytes: result.bytes,
          applied: [...result.applied],
          appearances: result.appearances,
          warnings: [...result.warnings],
        },
        [result.bytes.buffer as ArrayBuffer],
      );
    } catch (error) {
      port.postMessage({ kind: 'failed', id, ...describe(error) });
    } finally {
      controllers.delete(id);
    }
  };

  port.addEventListener('message', (ev) => {
    const message = ev.data;
    if (message.kind === 'write') {
      void run(message.id, message.bytes, message.plan, message.options);
      return;
    }
    controllers.get(message.id)?.abort();
  });

  port.postMessage({ kind: 'ready' });
}

/** Errors cross `postMessage` as data, so the kind has to survive as a string. */
function describe(error: unknown): { reason: string; message: string } {
  if (error instanceof WriteCancelled) return { reason: 'cancelled', message: error.message };
  if (error instanceof WriteUnsupported) {
    return { reason: error.reason, message: error.message };
  }
  return { reason: 'failed', message: error instanceof Error ? error.message : String(error) };
}

// Only when actually loaded as a Worker — not when a unit test imports `serveWriter`.
if (
  typeof window === 'undefined' &&
  typeof self !== 'undefined' &&
  typeof document === 'undefined'
) {
  serveWriter(self as unknown as WriterPort);
}

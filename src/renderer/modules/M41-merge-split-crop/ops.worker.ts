/**
 * The document-operations Worker (M41).
 *
 * Combining forty files, splitting a thousand pages or measuring a document against a size
 * budget is seconds of solid pdf-lib work, and on the main thread that is a frozen window with a
 * progress bar that cannot move and a Cancel button that cannot be pressed — exactly when the
 * reader most wants both. So it happens here.
 *
 * `serveOps` is exported so a unit test can drive it through a fake port, and `OpsClient` runs
 * the same functions in-process when there is no `Worker` at all.
 */

import { combine } from '@engine/ops/combine';
import { cropPages } from '@engine/ops/crop';
import { deskewPages } from '@engine/ops/deskew';
import { flatten } from '@engine/ops/flatten';
import { split } from '@engine/ops/split';
import { OpCancelled, type OpContext } from '@engine/ops/types';
import type { OpsAnswer, OpsFromWorker, OpsToWorker } from './opsProtocol';

/** Minimal worker surface, so `serveOps` can be driven by a fake port in tests. */
export interface OpsPort {
  postMessage(message: OpsFromWorker, transfer?: Transferable[]): void;
  addEventListener(type: 'message', listener: (ev: MessageEvent<OpsToWorker>) => void): void;
}

export function serveOps(port: OpsPort): void {
  const controllers = new Map<number, AbortController>();

  const run = async (id: number, work: (ctx: OpContext) => Promise<OpsAnswer>): Promise<void> => {
    const controller = new AbortController();
    controllers.set(id, controller);
    try {
      const result = await work({
        signal: controller.signal,
        progress: (fraction, message) => {
          port.postMessage({ kind: 'progress', id, fraction, message });
        },
      });
      port.postMessage({ kind: 'done', id, result }, transferablesOf(result));
    } catch (error) {
      port.postMessage({ kind: 'failed', id, ...describe(error) });
    } finally {
      controllers.delete(id);
    }
  };

  port.addEventListener('message', (ev) => {
    const message = ev.data;
    switch (message.kind) {
      case 'cancel':
        controllers.get(message.id)?.abort();
        return;
      case 'combine':
        void run(message.id, async (ctx) => ({
          op: 'combine',
          value: await combine(message.sources, message.options, ctx),
        }));
        return;
      case 'split':
        void run(message.id, async (ctx) => ({
          op: 'split',
          value: await split(message.bytes, message.options, ctx),
        }));
        return;
      case 'crop':
        void run(message.id, async (ctx) => ({
          op: 'crop',
          value: await cropPages(message.bytes, message.options, ctx),
        }));
        return;
      case 'flatten':
        void run(message.id, async (ctx) => ({
          op: 'flatten',
          value: await flatten(message.bytes, message.options, ctx),
        }));
        return;
      case 'deskew':
        void run(message.id, async (ctx) => ({
          op: 'deskew',
          value: await deskewPages(message.bytes, message.options, ctx),
        }));
        return;
    }
  });

  port.postMessage({ kind: 'ready' });
}

/** Every buffer in an answer, so a 300 MB combination is handed over rather than copied. */
function transferablesOf(answer: OpsAnswer): Transferable[] {
  if (answer.op === 'split') {
    return answer.value.parts.map((part) => part.bytes.buffer as ArrayBuffer);
  }
  return [answer.value.bytes.buffer as ArrayBuffer];
}

/** Errors cross `postMessage` as data, so the kind has to survive as a string. */
function describe(error: unknown): { reason: string; message: string } {
  if (error instanceof OpCancelled) return { reason: 'cancelled', message: error.message };
  return { reason: 'failed', message: error instanceof Error ? error.message : String(error) };
}

// Only when actually loaded as a Worker — not when a unit test imports `serveOps`.
if (
  typeof window === 'undefined' &&
  typeof self !== 'undefined' &&
  typeof document === 'undefined'
) {
  serveOps(self as unknown as OpsPort);
}

/**
 * The optimise Worker (M100).
 *
 * Decoding, resampling and re-encoding every photograph in a document, and walking every content
 * stream to find out which glyphs a font is actually asked for, is seconds of solid arithmetic.
 * On the main thread that is a frozen window with a progress bar that cannot move and a Cancel
 * button that cannot be pressed — exactly when the reader most wants both. So it happens here,
 * the way M41's ops do.
 *
 * The qpdf pass is **not** here: qpdf runs in the main process (ADR 0011), which a Worker cannot
 * reach. The Worker optimises and hands the bytes back; `OptimiseClient` makes the one IPC call
 * and folds the answer into the report.
 *
 * `serveOptimise` is exported so a unit test can drive it through a fake port, and
 * `OptimiseClient` runs the same functions in-process when there is no `Worker` at all.
 */

import { auditBytes, optimise, OpCancelled, type OptimiseContext } from '@engine/optimise';
import type { OptimiseAnswer, OptimiseFromWorker, OptimiseToWorker } from './optimiseProtocol';

/** Minimal worker surface, so `serveOptimise` can be driven by a fake port in tests. */
export interface OptimisePort {
  postMessage(message: OptimiseFromWorker, transfer?: Transferable[]): void;
  addEventListener(type: 'message', listener: (ev: MessageEvent<OptimiseToWorker>) => void): void;
}

export function serveOptimise(port: OptimisePort): void {
  const controllers = new Map<number, AbortController>();

  const run = async (
    id: number,
    work: (ctx: OptimiseContext) => Promise<OptimiseAnswer>,
  ): Promise<void> => {
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
      case 'optimise':
        void run(message.id, async (ctx) => ({
          op: 'optimise',
          // No `structure` hook: qpdf is main's, and the client applies it afterwards.
          value: await optimise(message.bytes, message.options, {}, ctx),
        }));
        return;
      case 'audit':
        void run(message.id, async () => ({
          op: 'audit',
          value: await auditBytes(message.bytes),
        }));
        return;
    }
  });

  port.postMessage({ kind: 'ready' });
}

/** The finished document is handed over rather than copied; an audit is numbers and has none. */
function transferablesOf(answer: OptimiseAnswer): Transferable[] {
  return answer.op === 'optimise' ? [answer.value.bytes.buffer as ArrayBuffer] : [];
}

/** Errors cross `postMessage` as data, so the kind has to survive as a string. */
function describe(error: unknown): { reason: string; message: string } {
  if (error instanceof OpCancelled) return { reason: 'cancelled', message: error.message };
  return { reason: 'failed', message: error instanceof Error ? error.message : String(error) };
}

// Only when actually loaded as a Worker — not when a unit test imports `serveOptimise`.
if (
  typeof window === 'undefined' &&
  typeof self !== 'undefined' &&
  typeof document === 'undefined'
) {
  serveOptimise(self as unknown as OptimisePort);
}

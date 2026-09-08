/**
 * The conversion Worker (M91). Decoding a TIFF, deflating a raster and laying out a long text
 * file are seconds of solid work on a big input; here they cannot freeze the window, and the
 * progress dialog's Cancel keeps working. `createImageBitmap` is available in a Worker, so the
 * browser's own decoder is installed for the formats pdf-lib has no filter for.
 *
 * `serveConverters` is exported so a unit test can drive it through a fake port.
 */

import { createRegistry } from '@engine/create/registry';
import {
  ConvertCancelled,
  ConvertUnsupported,
  type ConvertEnvironment,
} from '@engine/create/types';
import type { ConvertFromWorker, ConvertToWorker } from './createProtocol';
import { browserRasterDecoder } from './rasterDecoder';

export interface ConvertPort {
  postMessage(message: ConvertFromWorker, transfer?: Transferable[]): void;
  addEventListener(type: 'message', listener: (ev: MessageEvent<ConvertToWorker>) => void): void;
}

export function serveConverters(
  port: ConvertPort,
  env: ConvertEnvironment = { rasterDecoder: browserRasterDecoder },
): void {
  const registry = createRegistry();
  const controllers = new Map<number, AbortController>();

  const run = async (request: Extract<ConvertToWorker, { kind: 'convert' }>): Promise<void> => {
    const controller = new AbortController();
    controllers.set(request.id, controller);
    try {
      const converter = registry.get(request.converter);
      if (!converter) throw new Error(`No converter is called "${request.converter}"`);
      const result = await converter.convert(request.inputs, request.options, {
        env,
        signal: controller.signal,
        progress: (fraction, message) => {
          port.postMessage({ kind: 'progress', id: request.id, fraction, message });
        },
      });
      port.postMessage(
        {
          kind: 'done',
          id: request.id,
          bytes: result.bytes,
          pageCount: result.pageCount,
          title: result.title,
          warnings: [...result.warnings],
        },
        [result.bytes.buffer as ArrayBuffer],
      );
    } catch (error) {
      port.postMessage({ kind: 'failed', id: request.id, ...describe(error) });
    } finally {
      controllers.delete(request.id);
    }
  };

  port.addEventListener('message', (ev) => {
    const message = ev.data;
    if (message.kind === 'convert') {
      void run(message);
      return;
    }
    controllers.get(message.id)?.abort();
  });

  port.postMessage({ kind: 'ready' });
}

/** Errors cross `postMessage` as data, so the kind has to survive as a string. */
export function describe(error: unknown): { reason: string; message: string } {
  if (error instanceof ConvertCancelled) return { reason: 'cancelled', message: error.message };
  if (error instanceof ConvertUnsupported) return { reason: error.reason, message: error.message };
  return { reason: 'failed', message: error instanceof Error ? error.message : String(error) };
}

// Only when actually loaded as a Worker — not when a unit test imports `serveConverters`.
if (
  typeof window === 'undefined' &&
  typeof self !== 'undefined' &&
  typeof document === 'undefined'
) {
  serveConverters(self as unknown as ConvertPort);
}

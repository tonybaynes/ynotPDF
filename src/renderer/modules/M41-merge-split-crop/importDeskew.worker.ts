import { runImportDeskew } from './importDeskewEngine';
import type { ImportDeskewAnswer, ImportDeskewRequest } from './importDeskewProtocol';

export interface ImportDeskewPort {
  postMessage(message: ImportDeskewAnswer, transfer?: Transferable[]): void;
  addEventListener(
    type: 'message',
    listener: (event: MessageEvent<ImportDeskewRequest>) => void,
  ): void;
}

/** One generated PDF per worker. Cancellation terminates this private worker and its WASM heap. */
export function serveImportDeskew(port: ImportDeskewPort): void {
  port.addEventListener('message', (event) => {
    void runImportDeskew(event.data.bytes, {
      progress: (fraction, message) => {
        port.postMessage({ kind: 'progress', fraction, message });
      },
    }).then(
      (result) => {
        port.postMessage({ kind: 'done', result }, [result.bytes.buffer as ArrayBuffer]);
      },
      (error: unknown) => {
        port.postMessage({
          kind: 'failed',
          message: error instanceof Error ? error.message : String(error),
        });
      },
    );
  });
}

if (typeof window === 'undefined' && typeof self !== 'undefined' && typeof document === 'undefined')
  serveImportDeskew(self as unknown as ImportDeskewPort);

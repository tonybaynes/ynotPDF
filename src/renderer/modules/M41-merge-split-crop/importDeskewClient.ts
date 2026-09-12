import { ConvertCancelled, type ConvertProgress, type ConvertResult } from '@engine/create/types';
import type { ConvertHandle } from '@modules/M91-create-pdf/ConvertClient';
import type { ImportDeskewAnswer, ImportDeskewRequest } from './importDeskewProtocol';

export interface ImportDeskewWorker {
  postMessage(message: ImportDeskewRequest, transfer?: Transferable[]): void;
  addEventListener(
    type: 'message',
    listener: (event: MessageEvent<ImportDeskewAnswer>) => void,
  ): void;
  addEventListener(type: 'error', listener: (event: ErrorEvent) => void): void;
  terminate(): void;
}

export function startImportDeskew(
  converted: ConvertResult,
  progress?: ConvertProgress,
  makeWorker: () => ImportDeskewWorker = () =>
    new Worker(new URL('./importDeskew.worker.ts', import.meta.url), {
      type: 'module',
      name: 'ynot-import-deskew',
    }),
): ConvertHandle {
  const worker = makeWorker();
  let done = false;
  let rejectJob: (error: Error) => void = () => undefined;
  const finish = (): boolean => {
    if (done) return false;
    done = true;
    worker.terminate();
    return true;
  };
  const promise = new Promise<ConvertResult>((resolve, reject) => {
    rejectJob = reject;
    worker.addEventListener('message', (event) => {
      if (done) return;
      const answer = event.data;
      if (answer.kind === 'progress') {
        progress?.(answer.fraction, answer.message);
        return;
      }
      if (!finish()) return;
      if (answer.kind === 'failed') reject(new Error(answer.message));
      else if (answer.result.pageCount !== converted.pageCount)
        reject(
          new Error('Straightening changed the number of image pages. No document was created.'),
        );
      else
        resolve({
          ...converted,
          bytes: answer.result.bytes,
          warnings: [...converted.warnings, ...answer.result.warnings],
        });
    });
    worker.addEventListener('error', (event) => {
      if (finish()) reject(new Error(`Image straightening stopped: ${event.message}`));
    });
    try {
      const bytes = converted.bytes.slice();
      worker.postMessage({ bytes }, [bytes.buffer]);
    } catch (error) {
      finish();
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
  return {
    promise,
    cancel: () => {
      if (finish()) rejectJob(new ConvertCancelled());
    },
  };
}

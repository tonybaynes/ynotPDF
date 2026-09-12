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
  addEventListener(type: 'messageerror', listener: (event: MessageEvent) => void): void;
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
      const answer = validatedAnswer(event.data);
      if (answer === null) {
        if (finish()) reject(new Error('Image straightening returned an invalid worker message.'));
        return;
      }
      if (answer.kind === 'progress') {
        try {
          progress?.(answer.fraction, answer.message);
        } catch (error) {
          if (finish()) reject(error instanceof Error ? error : new Error(String(error)));
        }
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
    worker.addEventListener('messageerror', () => {
      if (finish())
        reject(new Error('Image straightening returned a message that could not be read.'));
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

/** Worker transport is a runtime boundary even when both ends are written in TypeScript. */
function validatedAnswer(value: unknown): ImportDeskewAnswer | null {
  if (typeof value !== 'object' || value === null) return null;
  const answer = value as Record<string, unknown>;
  if (answer['kind'] === 'progress') {
    const fraction = answer['fraction'];
    if (
      typeof answer['message'] !== 'string' ||
      !(
        fraction === null ||
        (typeof fraction === 'number' &&
          Number.isFinite(fraction) &&
          fraction >= 0 &&
          fraction <= 1)
      )
    )
      return null;
    return { kind: 'progress', fraction, message: answer['message'] };
  }
  if (answer['kind'] === 'failed')
    return typeof answer['message'] === 'string'
      ? { kind: 'failed', message: answer['message'] }
      : null;
  if (
    answer['kind'] !== 'done' ||
    typeof answer['result'] !== 'object' ||
    answer['result'] === null
  )
    return null;
  const result = answer['result'] as Record<string, unknown>;
  const bytes = result['bytes'];
  const pageCount = result['pageCount'];
  const warnings = result['warnings'];
  if (
    !(bytes instanceof Uint8Array) ||
    bytes.byteLength === 0 ||
    typeof pageCount !== 'number' ||
    !Number.isSafeInteger(pageCount) ||
    pageCount < 1 ||
    !Array.isArray(warnings) ||
    !warnings.every((warning: unknown) => typeof warning === 'string')
  )
    return null;
  return { kind: 'done', result: { bytes, pageCount, warnings } };
}

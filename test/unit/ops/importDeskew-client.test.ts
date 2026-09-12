import { describe, expect, it, vi } from 'vitest';
import { ConvertCancelled, type ConvertResult } from '@engine/create/types';
import {
  startImportDeskew,
  type ImportDeskewWorker,
} from '@modules/M41-merge-split-crop/importDeskewClient';
import type { ImportDeskewAnswer } from '@modules/M41-merge-split-crop/importDeskewProtocol';

class WorkerPort implements ImportDeskewWorker {
  postMessage = vi.fn();
  terminate = vi.fn();
  message: (event: MessageEvent<ImportDeskewAnswer>) => void = () => undefined;
  error: (event: ErrorEvent) => void = () => undefined;
  addEventListener(type: 'message' | 'error', listener: (event: never) => void): void {
    if (type === 'message') this.message = listener as typeof this.message;
    else this.error = listener as typeof this.error;
  }
  reply(data: ImportDeskewAnswer): void {
    this.message({ data } as MessageEvent<ImportDeskewAnswer>);
  }
}
const converted: ConvertResult = {
  bytes: new Uint8Array([1, 2, 3]),
  pageCount: 1,
  title: 'Scan',
  warnings: ['Original warning'],
};
const result = { bytes: new Uint8Array([4, 5]), pageCount: 1, warnings: ['Blank page'] };

describe('private image straightening worker lifecycle', () => {
  it('copies the input before transfer and preserves title/warnings on success', async () => {
    const port = new WorkerPort();
    const progress = vi.fn();
    const job = startImportDeskew(converted, progress, () => port);
    const posted = port.postMessage.mock.calls[0]?.[0] as { bytes: Uint8Array };
    expect(posted.bytes).toEqual(converted.bytes);
    expect(posted.bytes.buffer).not.toBe(converted.bytes.buffer);
    port.reply({ kind: 'progress', fraction: 0.4, message: 'Measuring' });
    expect(progress).toHaveBeenCalledWith(0.4, 'Measuring');
    port.reply({ kind: 'done', result });
    expect(await job.promise).toEqual({
      ...converted,
      bytes: result.bytes,
      warnings: [...converted.warnings, ...result.warnings],
    });
    job.cancel();
    expect(port.terminate).toHaveBeenCalledTimes(1);
  });
  it('terminates on cancellation and ignores all late results/progress', async () => {
    const port = new WorkerPort();
    const progress = vi.fn();
    const job = startImportDeskew(converted, progress, () => port);
    const rejected = expect(job.promise).rejects.toBeInstanceOf(ConvertCancelled);
    job.cancel();
    job.cancel();
    port.reply({ kind: 'done', result });
    port.reply({ kind: 'progress', fraction: 1, message: 'Late' });
    await rejected;
    expect(progress).not.toHaveBeenCalled();
    expect(port.terminate).toHaveBeenCalledTimes(1);
  });
  it.each(['failed', 'crashed', 'count', 'posting'])(
    'settles and terminates after %s failure',
    async (failure) => {
      const port = new WorkerPort();
      if (failure === 'posting')
        port.postMessage.mockImplementation(() => {
          throw new Error('Cannot post');
        });
      const job = startImportDeskew(converted, undefined, () => port);
      const rejected = expect(job.promise).rejects.toThrow();
      if (failure === 'failed') port.reply({ kind: 'failed', message: 'Cannot straighten' });
      if (failure === 'crashed') port.error({ message: 'Worker crashed' } as ErrorEvent);
      if (failure === 'count') port.reply({ kind: 'done', result: { ...result, pageCount: 2 } });
      await rejected;
      expect(port.terminate).toHaveBeenCalledTimes(1);
    },
  );
});

/** A disposable, print-only engine handle shared by every sheet of one operation. */
import { PDFDocument } from 'pdf-lib';
import type { DocHandle, PdfEngine } from '@engine/PdfEngine';
import { bakePrintAppearances, type PrintAppearanceOptions } from './appearances';

export interface RasterPrintSource {
  readonly engine: PdfEngine;
  readonly doc: DocHandle;
  readonly snapshot?: (signal?: AbortSignal) => Promise<Uint8Array>;
  readonly assertCurrent?: () => void;
}

export async function withRasterSnapshot<T>(
  source: RasterPrintSource,
  pages: ReadonlySet<number>,
  options: PrintAppearanceOptions,
  signal: AbortSignal | undefined,
  use: (doc: DocHandle) => Promise<T>,
): Promise<T> {
  const check = (): void => {
    signal?.throwIfAborted();
    source.assertCurrent?.();
  };
  check();
  const bytes = source.snapshot
    ? await source.snapshot(signal)
    : await source.engine.save(source.doc, { removeSecurity: true });
  check();
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  check();
  bakePrintAppearances(pdf, pages, options);
  const materialised = await pdf.save({ updateFieldAppearances: false });
  check();
  const handle = await source.engine.open(materialised);
  try {
    check();
    return await use(handle);
  } finally {
    await source.engine.close(handle);
  }
}

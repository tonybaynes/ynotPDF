import type { PdfiumEngine } from '../pdfium/PdfiumEngine';
import { yieldMacrotask } from '../yield';
import { deskewPages, detectSkew } from './deskew';
import { checkCancelled, type OpContext, type OpResult } from './types';

export type ImportDeskewEngine = Pick<
  PdfiumEngine,
  'open' | 'close' | 'pageCount' | 'pageSize' | 'renderRaw' | 'cancelCurrent'
>;

/** Automatic correction leaves angles within the detector's 0.2 degree tolerance alone. */
export const AUTO_DESKEW_MIN_ANGLE = 0.2;

/** Measure final image-page geometry; only the content matrix is rewritten, never its images. */
export async function straightenImportedImages(
  bytes: Uint8Array,
  engine: ImportDeskewEngine,
  ctx: OpContext = {},
): Promise<OpResult> {
  checkCancelled(ctx.signal);
  const handle = await engine.open(bytes, { name: 'Created image pages' });
  const cancel = (): void => {
    engine.cancelCurrent();
  };
  ctx.signal?.addEventListener('abort', cancel);
  const warnings: string[] = [];
  const angles: Record<number, number> = {};
  let pageCount: number;
  try {
    pageCount = await engine.pageCount(handle);
    for (let page = 0; page < pageCount; page++) {
      checkCancelled(ctx.signal);
      ctx.progress?.(
        (0.7 * page) / Math.max(1, pageCount),
        `Measuring image page ${String(page + 1)} of ${String(pageCount)}`,
      );
      try {
        const size = await engine.pageSize(handle, page);
        const scale = Math.min(110 / 72, 1400 / Math.max(size.width, size.height));
        const raster = await engine.renderRaw(handle, page, scale, undefined, {
          background: 0xffffff,
        });
        checkCancelled(ctx.signal);
        const estimate = detectSkew({
          width: raster.width,
          height: raster.height,
          data: raster.rgba,
        });
        if (estimate.confidence !== 'clear')
          warnings.push(`Page ${String(page + 1)} was not straightened: ${estimate.reason}.`);
        else if (Math.abs(estimate.angle) > AUTO_DESKEW_MIN_ANGLE) angles[page] = estimate.angle;
      } catch (error) {
        checkCancelled(ctx.signal);
        warnings.push(
          `Page ${String(page + 1)} was not straightened: ${error instanceof Error ? error.message : String(error)}.`,
        );
      }
      await yieldMacrotask();
    }
  } finally {
    ctx.signal?.removeEventListener('abort', cancel);
    await engine.close(handle);
  }
  checkCancelled(ctx.signal);
  if (Object.keys(angles).length === 0) {
    ctx.progress?.(1, 'No image pages needed automatic straightening');
    return { bytes, pageCount, warnings };
  }
  const result = await deskewPages(
    bytes,
    { angles, trimEdges: false, background: 'white' },
    {
      ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
      progress: (fraction, message) => ctx.progress?.(0.7 + 0.3 * (fraction ?? 0), message),
    },
  );
  checkCancelled(ctx.signal);
  return { ...result, warnings: [...warnings, ...result.warnings] };
}

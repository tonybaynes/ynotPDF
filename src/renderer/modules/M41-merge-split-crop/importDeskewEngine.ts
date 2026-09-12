import type { OpContext, OpResult } from '@engine/ops/types';
import { straightenImportedImages } from '@engine/ops/importDeskew';

/** A private, short-lived PDFium instance; no live document handle enters this operation. */
export async function runImportDeskew(bytes: Uint8Array, ctx: OpContext = {}): Promise<OpResult> {
  const [{ PdfiumEngine }, { dataUrlToBytes }, { default: wasm }] = await Promise.all([
    import('@engine/pdfium/PdfiumEngine'),
    import('@engine/worker-assets'),
    import('@hyzyla/pdfium/pdfium.wasm?inline'),
  ]);
  const engine = await PdfiumEngine.create({ wasm: dataUrlToBytes(wasm) });
  try {
    return await straightenImportedImages(bytes, engine, ctx);
  } finally {
    engine.destroy();
  }
}

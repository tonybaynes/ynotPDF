/** M92 HTML pictures: isolate native page objects in a disposable document (ADR 0027). */
import type { PdfMatrix } from '@shared/pdf';
import { EngineError, type EmbeddedImage } from '../PdfEngine';
import type { PageGeometry } from '../geometry';
import { applyToRect, IDENTITY, invert, multiply } from '../content/matrix';
import { BITMAP, PAGEOBJ, RENDER } from './constants';
import { Scope, type Ffi } from './ffi';

interface Placement {
  path: number[];
  index: number;
  matrix: PdfMatrix;
  storedWidth: number;
  storedHeight: number;
}

export async function imageAppearances(
  ffi: Ffi,
  bytes: Uint8Array,
  pageIndex: number,
  geometry: PageGeometry,
): Promise<EmbeddedImage[]> {
  // An async scope must remain alive until the temporary document has closed.
  const scope = new Scope(ffi);
  let doc = 0;
  let page = 0;
  try {
    doc = ffi.call('FPDF_LoadMemDocument', scope.bytes(bytes), bytes.length, 0);
    if (!doc) throw new EngineError('corrupt', 'Could not open the image appearance copy');
    page = ffi.call('FPDF_LoadPage', doc, pageIndex);
    if (!page) throw new EngineError('corrupt', 'Could not open the image appearance page');
    const matrixPtr = scope.alloc(24);
    const dimensions = scope.alloc(8);
    const placements: Placement[] = [];
    const active = new Set<number>();
    let objects = 0;
    const visit = (
      count: number,
      get: (i: number) => number,
      ancestors: number[],
      parent: PdfMatrix,
      root?: number,
    ): void => {
      if (ancestors.length >= 256)
        throw new EngineError('unsupported', 'Image appearance nesting exceeds the limit');
      for (let i = 0; i < count; i++) {
        if (++objects > 100_000)
          throw new EngineError('unsupported', 'Image appearance object count exceeds the limit');
        const obj = get(i);
        if (!obj || active.has(obj))
          throw new EngineError('corrupt', 'Invalid or cyclic image appearance object');
        if (!ffi.call('FPDFPageObj_GetMatrix', obj, matrixPtr))
          throw new EngineError('corrupt', 'Could not read image appearance matrix');
        const local: PdfMatrix = [
          ffi.f32(matrixPtr, 0),
          ffi.f32(matrixPtr, 1),
          ffi.f32(matrixPtr, 2),
          ffi.f32(matrixPtr, 3),
          ffi.f32(matrixPtr, 4),
          ffi.f32(matrixPtr, 5),
        ];
        const matrix = multiply(local, parent);
        const path = [...ancestors, obj];
        const kind = ffi.call('FPDFPageObj_GetType', obj);
        if (kind === PAGEOBJ.IMAGE) {
          if (!ffi.call('FPDFImageObj_GetImagePixelSize', obj, dimensions, dimensions + 4))
            throw new EngineError('corrupt', 'Could not read image appearance dimensions');
          placements.push({
            path,
            index: root ?? i,
            matrix,
            storedWidth: ffi.u32(dimensions),
            storedHeight: ffi.u32(dimensions, 1),
          });
        } else if (kind === PAGEOBJ.FORM) {
          active.add(obj);
          visit(
            ffi.call('FPDFFormObj_CountObjects', obj),
            (index) => ffi.call('FPDFFormObj_GetObject', obj, index),
            path,
            matrix,
            root ?? i,
          );
          active.delete(obj);
        }
        if (!ffi.call('FPDFPageObj_SetIsActive', obj, 0))
          throw new EngineError('internal', 'Could not isolate image appearance');
      }
    };
    visit(
      ffi.call('FPDFPage_CountObjects', page),
      (i) => ffi.call('FPDFPage_GetObject', page, i),
      [],
      IDENTITY,
    );
    // PDFium composes the supplied matrix after its default page-to-display matrix.
    // Cancel that transform so each returned rect stays in the HTML contract's original
    // unrotated PDF coordinates, including nonzero CropBox origins and page /Rotate.
    const origin = geometry.toDevice({ x: 0, y: 0 }, 1);
    const x = geometry.toDevice({ x: 1, y: 0 }, 1);
    const y = geometry.toDevice({ x: 0, y: 1 }, 1);
    const displayInverse = invert([
      x.x - origin.x,
      x.y - origin.y,
      y.x - origin.x,
      y.y - origin.y,
      origin.x,
      origin.y,
    ]);
    if (!displayInverse) throw new EngineError('corrupt', 'Invalid image appearance page geometry');
    const clipPtr = scope.alloc(16);
    const out: EmbeddedImage[] = [];
    let retainedBytes = 0;
    for (const placement of placements) {
      const { matrix, storedWidth, storedHeight } = placement;
      if (!storedWidth || !storedHeight)
        throw new EngineError('corrupt', 'Invalid image appearance dimensions');
      const bounds = applyToRect(matrix, { x0: 0, y0: 0, x1: 1, y1: 1 });
      const rect = {
        x0: Math.max(bounds.x0, geometry.box.x0),
        y0: Math.max(bounds.y0, geometry.box.y0),
        x1: Math.min(bounds.x1, geometry.box.x1),
        y1: Math.min(bounds.y1, geometry.box.y1),
      };
      if (rect.x1 <= rect.x0 || rect.y1 <= rect.y0) continue;
      const sx = Math.hypot(matrix[0], matrix[1]);
      const sy = Math.hypot(matrix[2], matrix[3]);
      if (!sx || !sy) continue;
      const scale = Math.max(1, storedWidth / sx, storedHeight / sy);
      const width = Math.ceil((rect.x1 - rect.x0) * scale);
      const height = Math.ceil((rect.y1 - rect.y0) * scale);
      if (
        !Number.isSafeInteger(width) ||
        !Number.isSafeInteger(height) ||
        width * height > 64 * 1024 * 1024
      )
        throw new EngineError('unsupported', 'Image appearance dimensions exceed the limit');
      retainedBytes += width * height * 4;
      if (retainedBytes > 512 * 1024 * 1024)
        throw new EngineError('unsupported', 'Image appearance page exceeds the memory limit');
      const px = width / (rect.x1 - rect.x0);
      const py = height / (rect.y1 - rect.y0);
      const renderMatrix = multiply(displayInverse, [px, 0, 0, -py, -rect.x0 * px, rect.y1 * py]);
      renderMatrix.forEach((value, index) => {
        ffi.setF32(matrixPtr, value, index);
      });
      [0, 0, width, height].forEach((value, index) => {
        ffi.setF32(clipPtr, value, index);
      });
      for (const obj of placement.path)
        if (!ffi.call('FPDFPageObj_SetIsActive', obj, 1))
          throw new EngineError('internal', 'Could not activate image appearance');
      const bitmap = ffi.call('FPDFBitmap_CreateEx', width, height, BITMAP.BGRA, 0, 0);
      if (!bitmap) throw new EngineError('internal', 'Could not allocate image appearance');
      try {
        ffi.call('FPDFBitmap_FillRect', bitmap, 0, 0, width, height, 0);
        ffi.call(
          'FPDF_RenderPageBitmapWithMatrix',
          bitmap,
          page,
          matrixPtr,
          clipPtr,
          RENDER.REVERSE_BYTE_ORDER,
        );
        const stride = ffi.call('FPDFBitmap_GetStride', bitmap);
        const buffer = ffi.call('FPDFBitmap_GetBuffer', bitmap);
        if (!buffer) throw new EngineError('internal', 'Could not read image appearance pixels');
        const data = new Uint8Array(width * height * 4);
        for (let row = 0; row < height; row++)
          data.set(
            ffi.m.HEAPU8.subarray(buffer + row * stride, buffer + row * stride + width * 4),
            row * width * 4,
          );
        out.push({
          page: pageIndex,
          index: placement.index,
          width,
          height,
          rect,
          dpiX: px * 72,
          dpiY: py * 72,
          filters: [],
          encoding: 'rgba',
          data,
        });
      } finally {
        ffi.call('FPDFBitmap_Destroy', bitmap);
        for (const obj of placement.path) ffi.call('FPDFPageObj_SetIsActive', obj, 0);
      }
      if (out.length % 8 === 0) await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    return out;
  } finally {
    if (page) ffi.call('FPDF_ClosePage', page);
    if (doc) ffi.call('FPDF_CloseDocument', doc);
    scope.release();
  }
}

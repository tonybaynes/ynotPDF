/**
 * The one canvas helper M13 needs in more than one place (snapshots and print sheets).
 *
 * `getContext('2d')` has a different return type on each canvas kind, so the branch is written
 * out rather than cast: TypeScript then picks the right overload for each and the caller gets a
 * union it can actually use.
 */

/** A canvas of the right kind for wherever this is running. */
export function makeCanvas(width: number, height: number): OffscreenCanvas | HTMLCanvasElement {
  if (typeof OffscreenCanvas === 'function') return new OffscreenCanvas(width, height);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

/** The 2D context of either canvas kind. */
export function context2d(
  canvas: OffscreenCanvas | HTMLCanvasElement,
): CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null {
  return canvas instanceof HTMLCanvasElement ? canvas.getContext('2d') : canvas.getContext('2d');
}

/** PNG bytes of either canvas kind. */
export async function canvasToPng(
  canvas: OffscreenCanvas | HTMLCanvasElement,
): Promise<Uint8Array> {
  if (canvas instanceof HTMLCanvasElement) {
    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, 'image/png');
    });
    if (!blob) throw new Error('The canvas could not be encoded as PNG');
    return new Uint8Array(await blob.arrayBuffer());
  }
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  return new Uint8Array(await blob.arrayBuffer());
}

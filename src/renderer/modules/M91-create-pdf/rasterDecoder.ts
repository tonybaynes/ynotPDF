/**
 * Raster decoders for the renderer (M91). Chromium decodes BMP, GIF, WebP and AVIF natively
 * through `createImageBitmap`, in a window and in a Worker alike; what it cannot decode (HEIC)
 * is offered to main's `nativeImage` over IPC, which can only be reached from the window.
 */

import { hasBridge, invoke } from '@shared/ipc';
import type { RasterDecoder } from '@engine/create/types';

/** The browser's own decoder. Returns `null` when the format is not one Chromium knows. */
export const browserRasterDecoder: RasterDecoder = async (bytes, mime) => {
  if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas === 'undefined')
    return null;
  let bitmap: ImageBitmap;
  try {
    const blob = new Blob([bytes as BlobPart], mime ? { type: mime } : {});
    bitmap = await createImageBitmap(blob);
  } catch {
    return null;
  }
  try {
    const { width, height } = bitmap;
    if (width <= 0 || height <= 0) return null;
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) return null;
    context.drawImage(bitmap, 0, 0);
    const data = context.getImageData(0, 0, width, height).data;
    return { width, height, rgba: new Uint8Array(data.buffer, data.byteOffset, data.byteLength) };
  } finally {
    bitmap.close();
  }
};

/** Main's `nativeImage`, for what Chromium declines (HEIC on macOS). Window only. */
export const nativeRasterDecoder: RasterDecoder = async (bytes) => {
  if (!hasBridge()) return null;
  try {
    return await invoke('image:decode', bytes);
  } catch {
    return null;
  }
};

/** Browser first, then the OS. */
export const windowRasterDecoder: RasterDecoder = async (bytes, mime) =>
  (await browserRasterDecoder(bytes, mime)) ?? (await nativeRasterDecoder(bytes, mime));

/** Turns a decoded raster into a picture element the dialogs can preview. */
export function previewUrl(bytes: Uint8Array, mime: string | undefined): string | null {
  if (typeof URL.createObjectURL !== 'function') return null;
  try {
    return URL.createObjectURL(new Blob([bytes as BlobPart], mime ? { type: mime } : {}));
  } catch {
    return null;
  }
}

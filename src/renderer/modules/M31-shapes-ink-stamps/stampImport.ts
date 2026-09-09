/**
 * Turning anything into a custom stamp (M31): a picture file, the clipboard, or a page of a PDF —
 * all of it to **PNG**, so there is one stored format and one transparency rule.
 *
 * A picture is decoded by the browser (Chromium reads PNG, JPEG, GIF, WebP and BMP) or, for the
 * formats it does not, by main's own codecs through `image:decode`; a PDF page is rendered by the
 * engine at a resolution that gives the longer side about 1 200 pixels. The reader may then crop,
 * and may ask for white to become transparent — a scanned signature or a logo on paper — which is
 * done per pixel here, before the PNG is encoded.
 *
 * Needs a canvas, so it runs in the renderer only; the arithmetic it delegates to is pure.
 */

import type { EngineClient } from '@engine/EngineClient';
import { hasBridge, invoke } from '@shared/ipc';

/** A decoded picture ready to be cropped and encoded. */
export interface SourcePicture {
  readonly bitmap: ImageBitmap;
  readonly width: number;
  readonly height: number;
}

/** A crop in picture pixels, top-left origin. */
export interface CropBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** The longer side a rendered PDF page is given, in pixels. */
export const PAGE_RENDER_SIDE = 1200;

/** Decodes an image file's bytes, trying the browser first and main's codecs second. */
export async function decodePicture(
  bytes: Uint8Array,
  mime?: string,
): Promise<SourcePicture | null> {
  try {
    const blob = new Blob([bytes.slice()], mime ? { type: mime } : {});
    const bitmap = await createImageBitmap(blob);
    return { bitmap, width: bitmap.width, height: bitmap.height };
  } catch {
    // Not a format Chromium decodes (TIFF, HEIC): ask the platform.
  }
  if (!hasBridge()) return null;
  const raster = await invoke('image:decode', bytes.slice()).catch(() => null);
  if (!raster || raster.width <= 0 || raster.height <= 0) return null;
  const data = new ImageData(new Uint8ClampedArray(raster.rgba), raster.width, raster.height);
  const bitmap = await createImageBitmap(data);
  return { bitmap, width: bitmap.width, height: bitmap.height };
}

/** Renders one page of a PDF to a bitmap, through the engine. */
export async function renderPdfPage(
  client: EngineClient,
  bytes: Uint8Array,
  page: number,
): Promise<{ picture: SourcePicture; pageCount: number } | null> {
  const engine = client.engine;
  const handle = await engine.open(bytes.slice(), { name: 'stamp source' });
  try {
    const count = await engine.pageCount(handle);
    const index = Math.max(0, Math.min(count - 1, page));
    const size = await engine.pageSize(handle, index);
    const scale = PAGE_RENDER_SIDE / Math.max(size.width, size.height, 1);
    const result = await engine.render(handle, index, scale, undefined, { annotations: true });
    return {
      picture: { bitmap: result.bitmap, width: result.bitmap.width, height: result.bitmap.height },
      pageCount: count,
    };
  } finally {
    await engine.close(handle).catch(() => undefined);
  }
}

/** Options for {@link encodeStampPng}. */
export interface EncodeOptions {
  readonly crop?: CropBox;
  /** Make near-white pixels transparent, with a soft edge below the threshold. */
  readonly whiteToAlpha?: boolean;
  /** 0..255; a pixel whose every channel is at or above this is fully transparent. */
  readonly whiteThreshold?: number;
}

/** The encoded stamp: PNG bytes and the size they carry. */
export interface EncodedStamp {
  readonly png: Uint8Array;
  readonly width: number;
  readonly height: number;
}

/**
 * Crops, optionally knocks out white, and encodes to PNG.
 *
 * "White to transparent" is a per-pixel rule on the *lightness* of the pixel: fully transparent
 * from the threshold up, fading in over the 40 levels below it so an anti-aliased edge does not
 * turn into a jagged one. That soft edge is applied to the alpha the pixel already had, so a
 * picture that was transparent stays transparent.
 */
export async function encodeStampPng(
  source: SourcePicture,
  options: EncodeOptions = {},
): Promise<EncodedStamp> {
  const crop = clampCrop(options.crop, source.width, source.height);
  const canvas = new OffscreenCanvas(crop.width, crop.height);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('No 2D canvas context');
  context.drawImage(
    source.bitmap,
    crop.x,
    crop.y,
    crop.width,
    crop.height,
    0,
    0,
    crop.width,
    crop.height,
  );
  if (options.whiteToAlpha) {
    const image = context.getImageData(0, 0, crop.width, crop.height);
    knockOutWhite(image.data, options.whiteThreshold ?? 235);
    context.putImageData(image, 0, 0);
  }
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  return {
    png: new Uint8Array(await blob.arrayBuffer()),
    width: crop.width,
    height: crop.height,
  };
}

/** The white knock-out on raw RGBA. Pure; exported for the unit test. */
export function knockOutWhite(rgba: Uint8ClampedArray, threshold: number): void {
  const fade = 40;
  for (let i = 0; i + 3 < rgba.length; i += 4) {
    const min = Math.min(rgba[i] ?? 0, rgba[i + 1] ?? 0, rgba[i + 2] ?? 0);
    if (min >= threshold) {
      rgba[i + 3] = 0;
    } else if (min > threshold - fade) {
      const keep = (threshold - min) / fade;
      rgba[i + 3] = Math.round((rgba[i + 3] ?? 255) * keep);
    }
  }
}

/** A crop kept inside the picture, at least one pixel each way. */
export function clampCrop(crop: CropBox | undefined, width: number, height: number): CropBox {
  if (!crop) return { x: 0, y: 0, width: Math.max(1, width), height: Math.max(1, height) };
  const x = Math.max(0, Math.min(width - 1, Math.round(crop.x)));
  const y = Math.max(0, Math.min(height - 1, Math.round(crop.y)));
  return {
    x,
    y,
    width: Math.max(1, Math.min(width - x, Math.round(crop.width))),
    height: Math.max(1, Math.min(height - y, Math.round(crop.height))),
  };
}

/** Base64 of some bytes, in chunks so a large picture does not blow the call stack. */
export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** A `data:` URL for a stored PNG, for an `<img>` or the overlay. */
export function pngDataUrl(base64: string): string {
  return `data:image/png;base64,${base64}`;
}

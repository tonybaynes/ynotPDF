/**
 * TIFF decoding (M91): every image directory becomes one page. utif (MIT) does the work; this
 * file turns its output into {@link DecodedRaster}s and keeps the DPI each directory declares.
 */

import './installPako';
import * as UTIF from 'utif';
import type { DecodedRaster } from '@shared/create';
import { ConvertUnsupported } from '../types';
import type { ExifOrientation } from './headers';

export interface TiffPage extends DecodedRaster {
  readonly orientation: ExifOrientation;
  readonly dpiX?: number;
  readonly dpiY?: number;
}

/** Decodes every page. Throws {@link ConvertUnsupported} when the file is not a readable TIFF. */
export function decodeTiffPages(bytes: Uint8Array, name = 'the TIFF'): TiffPage[] {
  // A copy into a plain ArrayBuffer: utif reads offsets from the start of the buffer it is
  // given, and a view over a shared or larger buffer would put every offset off.
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  let ifds: UTIF.IFD[];
  try {
    ifds = UTIF.decode(buffer);
  } catch (error) {
    throw new ConvertUnsupported('corrupt', `${name} could not be read: ${message(error)}`);
  }
  if (ifds.length === 0) throw new ConvertUnsupported('corrupt', `${name} holds no image`);
  const pages: TiffPage[] = [];
  for (const [index, ifd] of ifds.entries()) {
    // Thumbnails (SubIFDs, "reduced-resolution" NewSubfileType bit 0) are not pages.
    const subfile = firstNumber(ifd['t254']);
    if (subfile !== undefined && (subfile & 1) === 1 && ifds.length > 1) continue;
    try {
      UTIF.decodeImage(buffer, ifd);
    } catch (error) {
      throw new ConvertUnsupported(
        'corrupt',
        `Page ${index + 1} of ${name} could not be decoded: ${message(error)}`,
      );
    }
    const width = ifd.width ?? 0;
    const height = ifd.height ?? 0;
    if (width <= 0 || height <= 0 || !ifd.data) {
      throw new ConvertUnsupported('corrupt', `Page ${index + 1} of ${name} has no pixels`);
    }
    const rgba = UTIF.toRGBA8(ifd);
    const unit = firstNumber(ifd['t296']) ?? 2;
    const factor = unit === 3 ? 2.54 : 1;
    const xres = firstNumber(ifd['t282']);
    const yres = firstNumber(ifd['t283']);
    const orientationTag = firstNumber(ifd['t274']);
    const orientation =
      orientationTag !== undefined && orientationTag >= 1 && orientationTag <= 8
        ? (orientationTag as ExifOrientation)
        : 1;
    pages.push({
      width,
      height,
      rgba,
      orientation,
      ...(xres && xres > 0 && unit !== 1 ? { dpiX: round(xres * factor) } : {}),
      ...(yres && yres > 0 && unit !== 1 ? { dpiY: round(yres * factor) } : {}),
    });
  }
  if (pages.length === 0) throw new ConvertUnsupported('corrupt', `${name} holds only thumbnails`);
  return pages;
}

function firstNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return value;
  if (Array.isArray(value) && typeof value[0] === 'number') return value[0];
  return undefined;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

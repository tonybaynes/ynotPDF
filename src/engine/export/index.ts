/**
 * The export operations (M92, ADR 0019) — one import for everything the module, M120's batch
 * runner and M121's command line need.
 *
 * Everything here is pure: pixels, text models and bytes in, files out. See `types.ts` for the
 * conventions every one of them follows.
 */

export * from './types';
export * from './pixels';
export * from './naming';
export * from './images';
export * from './embedded';
export * from './textModel';
export * from './text';
export * from './html';
export * from './rtf';
export {
  encodePngRgb,
  encodePngGrey,
  encodePngMono,
  readPngHeader,
  dpiToMetre,
} from './codecs/png';
export { encodeJpeg, readJfifDensity, readJpegSize, withJfifDensity } from './codecs/jpeg';
export { encodeBmpRgb, encodeBmpGrey, encodeBmpMono, readBmpHeader } from './codecs/bmp';
export { encodeTiff, readTiffFrames, packBits } from './codecs/tiff';
export type { TiffCompression, TiffFrame, TiffOptions } from './codecs/tiff';
export type { PngOptions, PngHeader } from './codecs/png';
export type { JpegOptions } from './codecs/jpeg';
export type { BmpOptions, BmpHeader } from './codecs/bmp';

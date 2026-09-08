/**
 * Image header parsing (M91): what a file is, how big it is, its DPI and its EXIF orientation —
 * read from the bytes themselves so JPEG and PNG can be embedded without being decoded.
 *
 * Everything here is pure and tolerant: a header that cannot be read yields `undefined` fields
 * rather than an exception, and the converter falls back to decoding the image.
 */

export type ImageFormat = 'png' | 'jpeg' | 'tiff' | 'gif' | 'bmp' | 'webp' | 'heic' | 'unknown';

/** EXIF orientation 1–8 (TIFF 6.0 §Orientation). 1 is upright. */
export type ExifOrientation = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

export interface ImageHeader {
  readonly format: ImageFormat;
  /** Stored pixel size (before orientation), when the header could be read. */
  readonly width?: number;
  readonly height?: number;
  /** Dots per inch, when the file says. */
  readonly dpiX?: number;
  readonly dpiY?: number;
  readonly orientation: ExifOrientation;
  /** PNG: colour type has an alpha channel; TIFF/JPEG: never known here. */
  readonly hasAlpha?: boolean;
  /** TIFF: number of image directories (pages). */
  readonly pages?: number;
}

const MIME_BY_FORMAT: Readonly<Record<ImageFormat, string>> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  tiff: 'image/tiff',
  gif: 'image/gif',
  bmp: 'image/bmp',
  webp: 'image/webp',
  heic: 'image/heic',
  unknown: 'application/octet-stream',
};

export function mimeOf(format: ImageFormat): string {
  return MIME_BY_FORMAT[format];
}

/** Formats routed to the image converter, by extension. */
export const IMAGE_EXTENSIONS: ReadonlyArray<string> = [
  'png',
  'jpg',
  'jpeg',
  'jpe',
  'jfif',
  'tif',
  'tiff',
  'gif',
  'bmp',
  'dib',
  'webp',
  'heic',
  'heif',
  'avif',
];

export const IMAGE_MIMES: ReadonlyArray<string> = [
  'image/png',
  'image/jpeg',
  'image/tiff',
  'image/gif',
  'image/bmp',
  'image/x-ms-bmp',
  'image/webp',
  'image/heic',
  'image/heif',
  'image/avif',
];

/** Identifies the format from the magic bytes; the name and MIME type are not trusted. */
export function sniffFormat(bytes: Uint8Array): ImageFormat {
  const b = bytes;
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47)
    return 'png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b.length >= 4) {
    const le = b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a && b[3] === 0x00;
    const be = b[0] === 0x4d && b[1] === 0x4d && b[2] === 0x00 && b[3] === 0x2a;
    if (le || be) return 'tiff';
  }
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38)
    return 'gif';
  if (b.length >= 2 && b[0] === 0x42 && b[1] === 0x4d) return 'bmp';
  if (b.length >= 12 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') return 'webp';
  if (b.length >= 12 && ascii(b, 4, 4) === 'ftyp') {
    const brand = ascii(b, 8, 4);
    if (/^(heic|heix|hevc|hevx|heim|heis|mif1|msf1|avif|avis)$/.test(brand)) return 'heic';
  }
  return 'unknown';
}

/** Reads what the header says. Never throws. */
export function readHeader(bytes: Uint8Array): ImageHeader {
  const format = sniffFormat(bytes);
  try {
    switch (format) {
      case 'png':
        return readPng(bytes);
      case 'jpeg':
        return readJpeg(bytes);
      case 'tiff':
        return readTiff(bytes);
      case 'gif':
        return readGif(bytes);
      case 'bmp':
        return readBmp(bytes);
      case 'webp':
        return readWebp(bytes);
      default:
        return { format, orientation: 1 };
    }
  } catch {
    return { format, orientation: 1 };
  }
}

// ---- PNG ---------------------------------------------------------------------------------------

function readPng(b: Uint8Array): ImageHeader {
  const view = dataView(b);
  let width: number | undefined;
  let height: number | undefined;
  let hasAlpha: boolean | undefined;
  let dpiX: number | undefined;
  let dpiY: number | undefined;
  let at = 8;
  while (at + 8 <= b.length) {
    const length = view.getUint32(at);
    const type = ascii(b, at + 4, 4);
    const data = at + 8;
    if (type === 'IHDR' && data + 13 <= b.length) {
      width = view.getUint32(data);
      height = view.getUint32(data + 4);
      const colourType = b[data + 9] ?? 0;
      // 4 = grey+alpha, 6 = RGBA; a tRNS chunk on the other types also means transparency.
      hasAlpha = colourType === 4 || colourType === 6;
    } else if (type === 'tRNS') {
      hasAlpha = true;
    } else if (type === 'pHYs' && data + 9 <= b.length) {
      const ppuX = view.getUint32(data);
      const ppuY = view.getUint32(data + 4);
      const unit = b[data + 8];
      if (unit === 1 && ppuX > 0 && ppuY > 0) {
        dpiX = round(ppuX * 0.0254);
        dpiY = round(ppuY * 0.0254);
      }
    } else if (type === 'IDAT' || type === 'IEND') {
      break;
    }
    at = data + length + 4;
  }
  return {
    format: 'png',
    ...(width === undefined ? {} : { width }),
    ...(height === undefined ? {} : { height }),
    ...(dpiX === undefined ? {} : { dpiX }),
    ...(dpiY === undefined ? {} : { dpiY }),
    ...(hasAlpha === undefined ? {} : { hasAlpha }),
    orientation: 1,
  };
}

// ---- JPEG --------------------------------------------------------------------------------------

function readJpeg(b: Uint8Array): ImageHeader {
  const view = dataView(b);
  let width: number | undefined;
  let height: number | undefined;
  let dpiX: number | undefined;
  let dpiY: number | undefined;
  let orientation: ExifOrientation = 1;
  let jfifDpi: { x: number; y: number } | undefined;
  let exifDpi: { x: number; y: number } | undefined;
  let at = 2;
  while (at + 4 <= b.length) {
    if (b[at] !== 0xff) {
      at++;
      continue;
    }
    const marker = b[at + 1] ?? 0;
    if (marker === 0xff) {
      at++;
      continue;
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      at += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) break; // EOI / SOS: the header is over
    const length = view.getUint16(at + 2);
    const data = at + 4;
    const end = at + 2 + length;
    if (marker === 0xe0 && ascii(b, data, 4) === 'JFIF' && data + 12 <= b.length) {
      const units = b[data + 7];
      const x = view.getUint16(data + 8);
      const y = view.getUint16(data + 10);
      if (units === 1 && x > 0 && y > 0) jfifDpi = { x, y };
      else if (units === 2 && x > 0 && y > 0) jfifDpi = { x: round(x * 2.54), y: round(y * 2.54) };
    } else if (marker === 0xe1 && ascii(b, data, 4) === 'Exif') {
      const exif = readExif(b, data + 6, end);
      if (exif.orientation) orientation = exif.orientation;
      if (exif.dpiX && exif.dpiY) exifDpi = { x: exif.dpiX, y: exif.dpiY };
    } else if (isSof(marker) && data + 5 <= b.length) {
      height = view.getUint16(data + 1);
      width = view.getUint16(data + 3);
    }
    at = end;
  }
  // The EXIF resolution is the camera's word; JFIF's is the encoder's default (often 72 or 1).
  const dpi = exifDpi ?? jfifDpi;
  if (dpi) {
    dpiX = dpi.x;
    dpiY = dpi.y;
  }
  return {
    format: 'jpeg',
    ...(width === undefined ? {} : { width }),
    ...(height === undefined ? {} : { height }),
    ...(dpiX === undefined ? {} : { dpiX }),
    ...(dpiY === undefined ? {} : { dpiY }),
    orientation,
  };
}

function isSof(marker: number): boolean {
  return (
    (marker >= 0xc0 && marker <= 0xc3) ||
    (marker >= 0xc5 && marker <= 0xc7) ||
    (marker >= 0xc9 && marker <= 0xcb) ||
    (marker >= 0xcd && marker <= 0xcf)
  );
}

interface ExifFields {
  orientation?: ExifOrientation;
  dpiX?: number;
  dpiY?: number;
}

/** Reads IFD0 of an EXIF/TIFF block starting at `start` (the byte order mark). */
function readExif(b: Uint8Array, start: number, end: number): ExifFields {
  const out: ExifFields = {};
  if (start + 8 > end) return out;
  const order = ascii(b, start, 2);
  const little = order === 'II';
  if (!little && order !== 'MM') return out;
  const view = dataView(b);
  const u16 = (at: number): number => view.getUint16(at, little);
  const u32 = (at: number): number => view.getUint32(at, little);
  if (u16(start + 2) !== 42) return out;
  const ifd = start + u32(start + 4);
  if (ifd + 2 > end) return out;
  const count = u16(ifd);
  let unit = 2;
  let xres: number | undefined;
  let yres: number | undefined;
  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + i * 12;
    if (entry + 12 > end) break;
    const tag = u16(entry);
    const type = u16(entry + 2);
    const valueAt = entry + 8;
    if (tag === 0x0112 && type === 3) {
      const v = u16(valueAt);
      if (v >= 1 && v <= 8) out.orientation = v as ExifOrientation;
    } else if ((tag === 0x011a || tag === 0x011b) && type === 5) {
      const offset = start + u32(valueAt);
      if (offset + 8 <= end) {
        const num = u32(offset);
        const den = u32(offset + 4);
        const value = den === 0 ? 0 : num / den;
        if (tag === 0x011a) xres = value;
        else yres = value;
      }
    } else if (tag === 0x0128 && type === 3) {
      unit = u16(valueAt);
    }
  }
  if (xres && yres && xres > 0 && yres > 0) {
    const factor = unit === 3 ? 2.54 : 1;
    out.dpiX = round(xres * factor);
    out.dpiY = round(yres * factor);
  }
  return out;
}

// ---- TIFF --------------------------------------------------------------------------------------

function readTiff(b: Uint8Array): ImageHeader {
  const little = b[0] === 0x49;
  const view = dataView(b);
  const u16 = (at: number): number => view.getUint16(at, little);
  const u32 = (at: number): number => view.getUint32(at, little);
  let ifd = u32(4);
  let pages = 0;
  let first: ImageHeader | undefined;
  const seen = new Set<number>();
  while (ifd > 0 && ifd + 2 <= b.length && !seen.has(ifd) && pages < 10_000) {
    seen.add(ifd);
    pages++;
    const count = u16(ifd);
    if (!first) {
      let width: number | undefined;
      let height: number | undefined;
      let xres: number | undefined;
      let yres: number | undefined;
      let unit = 2;
      let orientation: ExifOrientation = 1;
      for (let i = 0; i < count; i++) {
        const entry = ifd + 2 + i * 12;
        if (entry + 12 > b.length) break;
        const tag = u16(entry);
        const type = u16(entry + 2);
        const valueAt = entry + 8;
        const short = (): number => (type === 3 ? u16(valueAt) : u32(valueAt));
        if (tag === 256) width = short();
        else if (tag === 257) height = short();
        else if (tag === 274 && type === 3) {
          const v = u16(valueAt);
          if (v >= 1 && v <= 8) orientation = v as ExifOrientation;
        } else if (tag === 296 && type === 3) unit = u16(valueAt);
        else if ((tag === 282 || tag === 283) && type === 5) {
          const offset = u32(valueAt);
          if (offset + 8 <= b.length) {
            const den = u32(offset + 4);
            const value = den === 0 ? 0 : u32(offset) / den;
            if (tag === 282) xres = value;
            else yres = value;
          }
        }
      }
      const factor = unit === 3 ? 2.54 : 1;
      const dpiX = xres && xres > 0 ? round(xres * factor) : undefined;
      const dpiY = yres && yres > 0 ? round(yres * factor) : undefined;
      first = {
        format: 'tiff',
        ...(width === undefined ? {} : { width }),
        ...(height === undefined ? {} : { height }),
        ...(dpiX === undefined ? {} : { dpiX }),
        ...(dpiY === undefined ? {} : { dpiY }),
        orientation,
      };
    }
    const next = ifd + 2 + count * 12;
    if (next + 4 > b.length) break;
    ifd = u32(next);
  }
  return { ...(first ?? { format: 'tiff', orientation: 1 }), pages };
}

// ---- GIF / BMP / WebP (size only) --------------------------------------------------------------

function readGif(b: Uint8Array): ImageHeader {
  const view = dataView(b);
  return {
    format: 'gif',
    width: view.getUint16(6, true),
    height: view.getUint16(8, true),
    orientation: 1,
  };
}

function readBmp(b: Uint8Array): ImageHeader {
  const view = dataView(b);
  const headerSize = view.getUint32(14, true);
  if (headerSize === 12) {
    return {
      format: 'bmp',
      width: view.getUint16(18, true),
      height: view.getUint16(20, true),
      orientation: 1,
    };
  }
  const width = view.getInt32(18, true);
  const height = Math.abs(view.getInt32(22, true));
  const ppmX = headerSize >= 40 ? view.getInt32(38, true) : 0;
  const ppmY = headerSize >= 40 ? view.getInt32(42, true) : 0;
  return {
    format: 'bmp',
    width,
    height,
    ...(ppmX > 0 ? { dpiX: round(ppmX * 0.0254) } : {}),
    ...(ppmY > 0 ? { dpiY: round(ppmY * 0.0254) } : {}),
    orientation: 1,
  };
}

function readWebp(b: Uint8Array): ImageHeader {
  const view = dataView(b);
  const chunk = ascii(b, 12, 4);
  if (chunk === 'VP8X' && b.length >= 30) {
    const u24 = (at: number): number =>
      (b[at] ?? 0) | ((b[at + 1] ?? 0) << 8) | ((b[at + 2] ?? 0) << 16);
    const width = 1 + u24(24);
    const height = 1 + u24(27);
    const hasAlpha = ((b[20] ?? 0) & 0x10) !== 0;
    return { format: 'webp', width, height, hasAlpha, orientation: 1 };
  }
  if (chunk === 'VP8L' && b.length >= 25) {
    const bits = view.getUint32(21, true);
    return {
      format: 'webp',
      width: (bits & 0x3fff) + 1,
      height: ((bits >> 14) & 0x3fff) + 1,
      hasAlpha: ((bits >> 28) & 1) === 1,
      orientation: 1,
    };
  }
  if (chunk === 'VP8 ' && b.length >= 30) {
    return {
      format: 'webp',
      width: view.getUint16(26, true) & 0x3fff,
      height: view.getUint16(28, true) & 0x3fff,
      orientation: 1,
    };
  }
  return { format: 'webp', orientation: 1 };
}

// ---- helpers -----------------------------------------------------------------------------------

function dataView(b: Uint8Array): DataView {
  return new DataView(b.buffer, b.byteOffset, b.byteLength);
}

function ascii(b: Uint8Array, at: number, length: number): string {
  let s = '';
  for (let i = at; i < at + length && i < b.length; i++) s += String.fromCharCode(b[i] ?? 0);
  return s;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Whether the orientation swaps width and height when displayed. */
export function orientationSwaps(orientation: ExifOrientation): boolean {
  return orientation >= 5;
}

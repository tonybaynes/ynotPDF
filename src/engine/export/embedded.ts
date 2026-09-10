/**
 * "Export all images" (M92): the pictures that are *inside* the document, not pictures of it.
 *
 * The engine (ADR 0019) hands over each image XObject as either the stream the file already
 * holds — a JPEG or a JPEG 2000, byte for byte — or decoded RGBA when the stream's filters mean
 * its raw bytes are not an image file. This decides what to call each one, encodes the decoded
 * ones as PNG, and drops the duplicates.
 *
 * **Duplicates matter more here than anywhere else in the module.** A letterhead logo drawn on
 * every page of a 200-page document is *one* XObject referenced 200 times, and PDFium reports it
 * once per page; writing 200 identical files would be the wrong answer to "export all images".
 * They are matched on their bytes (length plus an FNV-1a hash of them), which is exact for the
 * `jpeg`/`jp2` case — the same stream really is the same bytes — and for the decoded case is a
 * hash of the pixels, which is the same picture by any definition a reader has.
 */

import { encodePngRgb } from './codecs/png';
import { fillImageName, uniqueNames } from './naming';
import { checkCancelled, type ExportContext, type ExportedFile, type ExportResult } from './types';

/** The shape `PdfEngine.pageImages` answers with (ADR 0019), restated so this file stays pure. */
export interface EmbeddedImageLike {
  readonly page: number;
  readonly index: number;
  readonly width: number;
  readonly height: number;
  readonly dpiX: number;
  readonly dpiY: number;
  readonly encoding: 'jpeg' | 'jp2' | 'rgba';
  readonly data: Uint8Array;
}

export interface EmbeddedExportOptions {
  readonly documentName: string;
  readonly pageCount: number;
  readonly namePattern?: string;
  /** Skip anything smaller than this in either direction — icons, rules, spacer pixels. */
  readonly minPixels?: number;
  /** Write one file per placement rather than one per distinct picture. */
  readonly keepDuplicates?: boolean;
  readonly level?: number;
  readonly when?: Date;
}

export const DEFAULT_EMBEDDED_PATTERN = '{name}_p{page}_img{index}';
/** Below this in either direction a picture is furniture, not a picture. */
export const DEFAULT_MIN_PIXELS = 16;

const EXTENSIONS: Readonly<Record<EmbeddedImageLike['encoding'], string>> = {
  jpeg: '.jpg',
  jp2: '.jp2',
  rgba: '.png',
};

const MEDIA_TYPES: Readonly<Record<EmbeddedImageLike['encoding'], string>> = {
  jpeg: 'image/jpeg',
  jp2: 'image/jp2',
  rgba: 'image/png',
};

/** FNV-1a over the bytes, with the length mixed in — cheap, and good enough to group by. */
export function contentKey(bytes: Uint8Array): string {
  let hash = 0x811c9dc5;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  return `${String(bytes.length)}:${(hash >>> 0).toString(16)}`;
}

/**
 * Turns the images the engine reported into files.
 *
 * `images` is everything from every page, in page order; the caller streams them a page at a time
 * so a scanned document never has all of its pictures in memory at once, and hands the whole list
 * here once it has them.
 */
export function exportEmbeddedImages(
  images: ReadonlyArray<EmbeddedImageLike>,
  options: EmbeddedExportOptions,
  ctx: ExportContext = {},
): ExportResult {
  const typed = options.namePattern?.trim() ?? '';
  const pattern = typed === '' ? DEFAULT_EMBEDDED_PATTERN : typed;
  const minPixels = options.minPixels ?? DEFAULT_MIN_PIXELS;
  const when = options.when ?? new Date();
  const warnings: string[] = [];
  const files: ExportedFile[] = [];
  const names: string[] = [];
  const seen = new Map<string, number>();
  let skippedSmall = 0;
  let skippedDuplicate = 0;
  /** Per page, so `{index}` counts pictures on the page rather than in the document. */
  const perPage = new Map<number, number>();

  for (const [i, image] of images.entries()) {
    checkCancelled(ctx.signal);
    ctx.progress?.(images.length === 0 ? null : i / images.length, `Image ${String(i + 1)}`);
    if (image.width < minPixels || image.height < minPixels) {
      skippedSmall++;
      continue;
    }
    const key = contentKey(image.data);
    if (options.keepDuplicates !== true && seen.has(key)) {
      skippedDuplicate++;
      continue;
    }
    seen.set(key, i);
    const at = (perPage.get(image.page) ?? 0) + 1;
    perPage.set(image.page, at);
    const bytes =
      image.encoding === 'rgba'
        ? encodePngRgb(image.data, image.width, image.height, {
            dpi: { x: image.dpiX || 72, y: image.dpiY || 72 },
            ...(options.level === undefined ? {} : { level: options.level }),
          })
        : image.data;
    names.push(
      fillImageName(pattern, EXTENSIONS[image.encoding], {
        name: options.documentName,
        page: image.page,
        index: at - 1,
        total: images.length,
        pageCount: options.pageCount,
        when,
      }),
    );
    files.push({
      name: '',
      bytes,
      mediaType: MEDIA_TYPES[image.encoding],
      pages: [image.page],
    });
  }

  if (skippedDuplicate > 0) {
    warnings.push(
      `${String(skippedDuplicate)} ${skippedDuplicate === 1 ? 'picture was' : 'pictures were'} the same image drawn more than once and ${skippedDuplicate === 1 ? 'was' : 'were'} written only once.`,
    );
  }
  if (skippedSmall > 0) {
    warnings.push(
      `${String(skippedSmall)} ${skippedSmall === 1 ? 'picture was' : 'pictures were'} smaller than ${String(minPixels)} pixels and ${skippedSmall === 1 ? 'was' : 'were'} left out.`,
    );
  }
  if (files.length === 0 && warnings.length === 0) {
    warnings.push('This document has no images in it.');
  }
  ctx.progress?.(1, 'Done');
  const unique = uniqueNames(names);
  return {
    files: files.map((file, i) => ({ ...file, name: unique[i] ?? `image-${String(i + 1)}` })),
    warnings,
  };
}

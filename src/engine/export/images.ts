/**
 * Pages → image files (M92): the format, the resolution, the colour, the range, one file per page
 * or one multi-page TIFF, and the file names.
 *
 * Pure: the pixels arrive through the `RenderPage` callback the caller supplies, so this same
 * function serves the dialog, the batch runner and a unit test that draws its own pages. The
 * caller decides what "render" means — with or without annotations and form widgets, at whatever
 * background colour — because those are `RenderOptions` on the engine and this layer never holds
 * an engine.
 *
 * Resolution is the whole point of the arithmetic: a page `w` points wide rendered at `d` dpi is
 * `round(w × d / 72)` pixels wide, and that is what the acceptance test measures.
 */

import { DEFAULT_IMAGE_PATTERN, fillImageName, uniqueNames, type NameValues } from './naming';
import { encodeBmpGrey, encodeBmpMono, encodeBmpRgb } from './codecs/bmp';
import { encodeJpeg } from './codecs/jpeg';
import { encodePngGrey, encodePngMono, encodePngRgb } from './codecs/png';
import { encodeTiff, type TiffCompression, type TiffFrame } from './codecs/tiff';
import {
  greyToRgba,
  monoToGrey,
  reduce,
  type ColourMode,
  type MonoOptions,
  type Reduced,
} from './pixels';
import {
  checkCancelled,
  ExportFailed,
  type ExportContext,
  type ExportedFile,
  type ExportResult,
  type Raster,
  type RenderPage,
} from './types';

export type ImageFormat = 'png' | 'jpeg' | 'tiff' | 'bmp';

/** Extension and media type per format — one table, so the name and the header cannot disagree. */
export const IMAGE_FORMATS: Readonly<
  Record<
    ImageFormat,
    { readonly extension: string; readonly mediaType: string; readonly label: string }
  >
> = {
  png: { extension: '.png', mediaType: 'image/png', label: 'PNG' },
  jpeg: { extension: '.jpg', mediaType: 'image/jpeg', label: 'JPEG' },
  tiff: { extension: '.tif', mediaType: 'image/tiff', label: 'TIFF' },
  bmp: { extension: '.bmp', mediaType: 'image/bmp', label: 'BMP' },
};

export interface ImageExportOptions {
  readonly format: ImageFormat;
  /** Dots per inch. 72 is "actual size"; 150 and 300 are the dialog's other presets. */
  readonly dpi: number;
  readonly colour: ColourMode;
  readonly mono?: MonoOptions;
  /** 0-based pages, in the order they should be written. */
  readonly pages: ReadonlyArray<number>;
  /** How many pages the document has, for `{page}`'s zero padding. */
  readonly pageCount: number;
  /** The document's name without its extension, for `{name}`. */
  readonly documentName: string;
  /** Page labels by 0-based index, for `{label}` (M40 owns them). */
  readonly labels?: ReadonlyArray<string>;
  readonly namePattern?: string;
  /** TIFF only: all pages in one file rather than one file per page. */
  readonly multiPage?: boolean;
  /** JPEG quality, 1–100. */
  readonly quality?: number;
  /** PNG / TIFF-deflate compression level, 0–9. */
  readonly level?: number;
  readonly tiffCompression?: TiffCompression;
  /** One timestamp for the whole run, so `{date}`/`{time}` do not drift between pages. */
  readonly when?: Date;
}

/** The largest picture we will ask an encoder for: 300 megapixels, about A0 at 600 dpi. */
const MAX_PIXELS = 300_000_000;

/** Pixel size of a page of `widthPt × heightPt` rendered at `dpi`. */
export function pixelSize(
  widthPt: number,
  heightPt: number,
  dpi: number,
): { readonly width: number; readonly height: number } {
  return {
    width: Math.max(1, Math.round((widthPt * dpi) / 72)),
    height: Math.max(1, Math.round((heightPt * dpi) / 72)),
  };
}

/** Encodes one already-reduced page in one format. */
export function encodeRaster(
  reduced: Reduced,
  options: {
    readonly format: ImageFormat;
    readonly dpi: number;
    readonly quality?: number;
    readonly level?: number;
    readonly tiffCompression?: TiffCompression;
  },
): Uint8Array {
  const dpi = { x: options.dpi, y: options.dpi };
  switch (options.format) {
    case 'png':
      if (reduced.mode === 'colour') {
        return encodePngRgb(reduced.rgba, reduced.width, reduced.height, {
          dpi,
          ...(options.level === undefined ? {} : { level: options.level }),
        });
      }
      return reduced.mode === 'grey'
        ? encodePngGrey(reduced.grey, {
            dpi,
            ...(options.level === undefined ? {} : { level: options.level }),
          })
        : encodePngMono(reduced.mono, {
            dpi,
            ...(options.level === undefined ? {} : { level: options.level }),
          });
    case 'jpeg': {
      // JPEG has no grey-only or bilevel form here; the pixels are still grey, in three channels.
      const rgba =
        reduced.mode === 'colour'
          ? reduced.rgba
          : reduced.mode === 'grey'
            ? greyToRgba(reduced.grey)
            : greyToRgba(monoToGrey(reduced.mono));
      const width =
        reduced.mode === 'colour'
          ? reduced.width
          : reduced.mode === 'grey'
            ? reduced.grey.width
            : reduced.mono.width;
      const height =
        reduced.mode === 'colour'
          ? reduced.height
          : reduced.mode === 'grey'
            ? reduced.grey.height
            : reduced.mono.height;
      return encodeJpeg(rgba, width, height, {
        dpi,
        ...(options.quality === undefined ? {} : { quality: options.quality }),
      });
    }
    case 'tiff':
      return encodeTiff([tiffFrame(reduced)], {
        dpi,
        ...(options.tiffCompression === undefined ? {} : { compression: options.tiffCompression }),
        ...(options.level === undefined ? {} : { level: options.level }),
      });
    case 'bmp':
      if (reduced.mode === 'colour') {
        return encodeBmpRgb(reduced.rgba, reduced.width, reduced.height, { dpi });
      }
      return reduced.mode === 'grey'
        ? encodeBmpGrey(reduced.grey, { dpi })
        : encodeBmpMono(reduced.mono, { dpi });
  }
}

function tiffFrame(reduced: Reduced): TiffFrame {
  if (reduced.mode === 'colour') {
    return { kind: 'rgb', rgba: reduced.rgba, width: reduced.width, height: reduced.height };
  }
  return reduced.mode === 'grey'
    ? { kind: 'grey', grey: reduced.grey }
    : { kind: 'mono', mono: reduced.mono };
}

/**
 * Exports pages as images.
 *
 * One file per page, unless the format is TIFF and `multiPage` is on, in which case every page is
 * a frame of one file. Progress moves per page; a cancel between pages throws and nothing is
 * returned, so a caller never writes half an export.
 */
export async function exportImages(
  render: RenderPage,
  options: ImageExportOptions,
  ctx: ExportContext = {},
): Promise<ExportResult> {
  const pages = options.pages;
  if (
    options.format === 'tiff' &&
    options.tiffCompression === 'group4' &&
    options.colour !== 'mono'
  ) {
    throw new ExportFailed('CCITT Group 4 requires black and white (1-bit) TIFF pages.');
  }
  if (pages.length === 0) throw new ExportFailed('No pages were chosen to export.');
  if (!(options.dpi > 0) || !Number.isFinite(options.dpi)) {
    throw new ExportFailed(`${String(options.dpi)} is not a resolution.`);
  }
  const warnings: string[] = [];
  const multiPage = options.multiPage === true && options.format === 'tiff';
  const typed = options.namePattern?.trim() ?? '';
  const pattern = typed === '' ? DEFAULT_IMAGE_PATTERN : typed;
  const format = IMAGE_FORMATS[options.format];
  const when = options.when ?? new Date();
  const frames: TiffFrame[] = [];
  const files: ExportedFile[] = [];
  const names: string[] = [];

  for (const [index, page] of pages.entries()) {
    checkCancelled(ctx.signal);
    ctx.progress?.(index / pages.length, `Rendering page ${String(page + 1)}`);
    const raster = await render(page, options.dpi);
    checkCancelled(ctx.signal);
    if (raster.width * raster.height > MAX_PIXELS) {
      throw new ExportFailed(
        `Page ${String(page + 1)} is ${String(raster.width)} × ${String(raster.height)} pixels at ${String(options.dpi)} dpi, which is too large to encode. Choose a lower resolution.`,
      );
    }
    ctx.progress?.((index + 0.5) / pages.length, `Encoding page ${String(page + 1)}`);
    const reduced = reduce(raster, options.colour, options.mono);
    if (multiPage) {
      frames.push(tiffFrame(reduced));
      continue;
    }
    const values: NameValues = {
      name: options.documentName,
      page,
      index,
      total: pages.length,
      pageCount: options.pageCount,
      dpi: options.dpi,
      when,
      ...(options.labels?.[page] === undefined ? {} : { label: options.labels[page] }),
    };
    names.push(fillImageName(pattern, format.extension, values));
    files.push({
      name: '',
      bytes: encodeRaster(reduced, {
        format: options.format,
        dpi: options.dpi,
        ...(options.tiffCompression === undefined
          ? {}
          : { tiffCompression: options.tiffCompression }),
        ...(options.quality === undefined ? {} : { quality: options.quality }),
        ...(options.level === undefined ? {} : { level: options.level }),
      }),
      mediaType: format.mediaType,
      pages: [page],
    });
  }

  if (multiPage) {
    checkCancelled(ctx.signal);
    ctx.progress?.(0.9, `Writing ${String(frames.length)} frames into one TIFF`);
    const name = fillImageName(stripPageTokens(pattern), format.extension, {
      name: options.documentName,
      page: pages[0] ?? 0,
      index: 0,
      total: 1,
      pageCount: options.pageCount,
      dpi: options.dpi,
      when,
    });
    ctx.progress?.(1, 'Done');
    return {
      files: [
        {
          name,
          bytes: encodeTiff(frames, {
            dpi: { x: options.dpi, y: options.dpi },
            ...(options.tiffCompression === undefined
              ? {}
              : { compression: options.tiffCompression }),
            ...(options.level === undefined ? {} : { level: options.level }),
          }),
          mediaType: format.mediaType,
          pages: [...pages],
        },
      ],
      warnings,
    };
  }

  if (options.colour === 'mono' && options.format === 'jpeg') {
    warnings.push(
      'JPEG cannot hold a black-and-white image: the pages were written as colour JPEGs of black and white pixels. PNG or TIFF keeps them one bit a pixel.',
    );
  }
  ctx.progress?.(1, 'Done');
  const unique = uniqueNames(names);
  return {
    files: files.map((file, i) => ({ ...file, name: unique[i] ?? `page-${String(i + 1)}` })),
    warnings,
  };
}

/**
 * The name for the one file a multi-page TIFF produces.
 *
 * A pattern that numbers pages says nothing useful about a file that holds all of them, so the
 * page tokens and whatever separator they were sitting behind come out — `{name}_page{page}`
 * becomes `{name}`, not `{name}_page`.
 */
export function stripPageTokens(pattern: string): string {
  const stripped = pattern
    .replace(/[-_ ]*(page|p)?\{(page|n|index|label)\}/gi, '')
    .replace(/[-_ ]+$/, '')
    .trim();
  return stripped === '' ? '{name}' : stripped;
}

/** A `RenderPage` over a fixed set of rasters, for tests and for a preview that already has one. */
export function rastersAsRenderer(rasters: ReadonlyMap<number, Raster>): RenderPage {
  return (page) => {
    const raster = rasters.get(page);
    if (!raster) return Promise.reject(new ExportFailed(`Page ${String(page + 1)} has no pixels`));
    return Promise.resolve(raster);
  };
}

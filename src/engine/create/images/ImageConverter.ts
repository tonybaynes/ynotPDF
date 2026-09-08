/**
 * Images → PDF (M91). One page per image (per TIFF directory); JPEG and PNG are embedded as
 * they are, everything else is decoded to RGBA first — by utif for TIFF, by the host's
 * `RasterDecoder` for the rest.
 */

import { PDFDocument } from 'pdf-lib';
import type { DecodedRaster } from '@shared/create';
import {
  checkCancelled,
  ConvertUnsupported,
  extensionOf,
  stemOf,
  type ConvertContext,
  type ConvertEnvironment,
  type ConvertInput,
  type ConvertResult,
  type Converter,
  type RoutingInput,
} from '../types';
import {
  IMAGE_EXTENSIONS,
  IMAGE_MIMES,
  mimeOf,
  orientationSwaps,
  readHeader,
  type ExifOrientation,
  type ImageHeader,
} from './headers';
import {
  DEFAULT_IMAGE_LAYOUT,
  layoutImage,
  type DisplayedImage,
  type ImageLayoutOptions,
} from './layout';
import { drawPlaceable, embedRaster, placeableOf, type Placeable } from './raster';
import { decodeTiffPages } from './tiff';

export interface ImageConvertOptions extends ImageLayoutOptions {
  /** Document title; the first image's name without its extension when absent. */
  readonly title?: string;
}

/** A picture ready for a page: the XObject, how it is displayed, and which way up it is. */
interface Picture {
  readonly placeable: Placeable;
  readonly displayed: DisplayedImage;
  readonly orientation: ExifOrientation;
}

export class ImageConverter implements Converter<ImageConvertOptions> {
  readonly id = 'image';
  readonly label = 'Images';
  readonly extensions = IMAGE_EXTENSIONS;
  readonly mimes = IMAGE_MIMES;
  readonly multi = true;

  accepts(input: RoutingInput): boolean {
    const mime = input.mime?.toLowerCase();
    if (mime && this.mimes.includes(mime)) return true;
    return this.extensions.includes(extensionOf(input.name));
  }

  defaults(): ImageConvertOptions {
    return { ...DEFAULT_IMAGE_LAYOUT };
  }

  async convert(
    inputs: ReadonlyArray<ConvertInput>,
    options: ImageConvertOptions,
    ctx: ConvertContext,
  ): Promise<ConvertResult> {
    if (inputs.length === 0) throw new ConvertUnsupported('empty', 'No images were given');
    const settings: ImageConvertOptions = { ...DEFAULT_IMAGE_LAYOUT, ...options };
    const warnings: string[] = [];
    const doc = await PDFDocument.create({ updateMetadata: false });
    let pages = 0;
    for (const [index, input] of inputs.entries()) {
      checkCancelled(ctx.signal);
      ctx.progress?.(
        index / inputs.length,
        `Adding ${input.name} (${index + 1} of ${inputs.length})`,
      );
      const pictures = await loadPictures(doc, input, ctx.env, warnings);
      for (const picture of pictures) {
        checkCancelled(ctx.signal);
        if (
          (settings.pageMode === 'image' || settings.fit === 'actual') &&
          !picture.displayed.dpiX
        ) {
          warnings.push(
            `${input.name} says nothing about its resolution; ${settings.defaultDpi} dpi was assumed`,
          );
        }
        const layout = layoutImage(picture.displayed, settings);
        const page = doc.addPage([layout.page.width, layout.page.height]);
        drawPlaceable(
          page,
          picture.placeable,
          layout.rect,
          picture.orientation,
          layout.clip ?? undefined,
        );
        pages++;
      }
    }
    const first = inputs[0];
    const title = settings.title ?? stemOf(first?.name ?? 'Images');
    doc.setTitle(title);
    doc.setProducer('ynotPDF');
    doc.setCreator('ynotPDF');
    ctx.progress?.(1, 'Writing the document');
    const bytes = await doc.save({ addDefaultPage: false, updateFieldAppearances: false });
    return { bytes, pageCount: pages, title, warnings };
  }
}

/** Turns one input file into one or more pictures, embedding or decoding as the format allows. */
async function loadPictures(
  doc: PDFDocument,
  input: ConvertInput,
  env: ConvertEnvironment,
  warnings: string[],
): Promise<Picture[]> {
  if (input.bytes.byteLength === 0) {
    throw new ConvertUnsupported('empty', `${input.name} is empty`);
  }
  const header = readHeader(input.bytes);
  switch (header.format) {
    case 'jpeg': {
      try {
        const image = await doc.embedJpg(input.bytes);
        return [pictureOf(await placeableOf(image), header)];
      } catch (error) {
        warnings.push(`${input.name} was decoded rather than embedded: ${message(error)}`);
        return [await decodeWithHost(doc, input, header, env)];
      }
    }
    case 'png': {
      try {
        const image = await doc.embedPng(input.bytes);
        return [pictureOf(await placeableOf(image), header)];
      } catch (error) {
        warnings.push(`${input.name} was decoded rather than embedded: ${message(error)}`);
        return [await decodeWithHost(doc, input, header, env)];
      }
    }
    case 'tiff': {
      const pages = decodeTiffPages(input.bytes, input.name);
      return pages.map((page) => {
        const placeable = embedRaster(doc, page);
        const swap = orientationSwaps(page.orientation);
        return {
          placeable,
          orientation: page.orientation,
          displayed: {
            widthPx: swap ? page.height : page.width,
            heightPx: swap ? page.width : page.height,
            ...(page.dpiX === undefined
              ? {}
              : { dpiX: swap ? (page.dpiY ?? page.dpiX) : page.dpiX }),
            ...(page.dpiY === undefined
              ? {}
              : { dpiY: swap ? (page.dpiX ?? page.dpiY) : page.dpiY }),
          },
        };
      });
    }
    default:
      return [await decodeWithHost(doc, input, header, env)];
  }
}

/** The host's decoder, for formats PDF has no filter for — and for a JPEG or PNG pdf-lib refused. */
async function decodeWithHost(
  doc: PDFDocument,
  input: ConvertInput,
  header: ImageHeader,
  env: ConvertEnvironment,
): Promise<Picture> {
  const kind = header.format === 'unknown' ? 'image' : header.format.toUpperCase();
  if (!env.rasterDecoder) {
    throw new ConvertUnsupported(
      'no-decoder',
      `${input.name} is a ${kind} file, which cannot be decoded here`,
    );
  }
  let raster: DecodedRaster | null;
  try {
    raster = await env.rasterDecoder(input.bytes, input.mime ?? mimeOf(header.format));
  } catch (error) {
    throw new ConvertUnsupported(
      'corrupt',
      `${input.name} could not be decoded: ${message(error)}`,
    );
  }
  if (!raster) {
    const reason: 'corrupt' | 'no-decoder' = header.format === 'unknown' ? 'corrupt' : 'no-decoder';
    throw new ConvertUnsupported(
      reason,
      reason === 'corrupt'
        ? `${input.name} is not an image ynotPDF recognises`
        : `${input.name} is a ${kind} file, which this system cannot decode`,
    );
  }
  return pictureOf(embedRaster(doc, raster), header);
}

function pictureOf(placeable: Placeable, header: ImageHeader): Picture {
  const swap = orientationSwaps(header.orientation);
  const dpiX = header.dpiX;
  const dpiY = header.dpiY;
  return {
    placeable,
    orientation: header.orientation,
    displayed: {
      widthPx: swap ? placeable.height : placeable.width,
      heightPx: swap ? placeable.width : placeable.height,
      ...(dpiX === undefined ? {} : { dpiX: swap ? (dpiY ?? dpiX) : dpiX }),
      ...(dpiY === undefined ? {} : { dpiY: swap ? (dpiX ?? dpiY) : dpiY }),
    },
  };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

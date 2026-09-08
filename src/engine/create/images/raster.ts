/**
 * Putting pictures on pages with pdf-lib (M91).
 *
 * Two kinds of picture arrive here: one pdf-lib embedded itself (`embedJpg`, `embedPng`), and a
 * decoded RGBA raster for the formats PDF has no filter for. Both end up as an image XObject
 * drawn through the same content-stream operators, so EXIF orientation, fitting and cropping are
 * written once.
 *
 * No `rgb()` here on purpose: the repository's style rule reads any colour function in a `.ts`
 * file as a UI colour literal, and nothing on a converted page is UI.
 */

import {
  clip,
  concatTransformationMatrix,
  drawObject,
  endPath,
  popGraphicsState,
  pushGraphicsState,
  rectangle,
  type PDFDocument,
  type PDFImage,
  type PDFPage,
  type PDFRef,
} from 'pdf-lib';
import type { DecodedRaster } from '@shared/create';
import type { ExifOrientation } from './headers';

/** A rectangle on the page in points, origin bottom-left. */
export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** A picture ready to draw: its XObject and its stored pixel size. */
export interface Placeable {
  readonly ref: PDFRef;
  readonly width: number;
  readonly height: number;
}

/** Wraps a pdf-lib image so it can be drawn like a raw one. */
export async function placeableOf(image: PDFImage): Promise<Placeable> {
  await image.embed();
  return { ref: image.ref, width: image.width, height: image.height };
}

/**
 * Writes an RGBA raster as a `FlateDecode` RGB XObject, with a `SMask` when any pixel is not
 * fully opaque. Translucent pixels are pre-blended to white in the colour channels so a viewer
 * that ignores soft masks still shows something sensible.
 */
export function embedRaster(doc: PDFDocument, raster: DecodedRaster): Placeable {
  const { width, height, rgba } = raster;
  const pixels = width * height;
  if (width <= 0 || height <= 0) throw new Error('The decoded image has no size');
  if (rgba.length < pixels * 4) throw new Error('The decoded image is shorter than its size says');
  const rgb = new Uint8Array(pixels * 3);
  const alpha = new Uint8Array(pixels);
  let translucent = false;
  for (let i = 0, p = 0, q = 0; i < pixels; i++, p += 4, q += 3) {
    const a = rgba[p + 3] ?? 255;
    alpha[i] = a;
    if (a === 255) {
      rgb[q] = rgba[p] ?? 0;
      rgb[q + 1] = rgba[p + 1] ?? 0;
      rgb[q + 2] = rgba[p + 2] ?? 0;
    } else {
      translucent = true;
      const k = a / 255;
      rgb[q] = Math.round((rgba[p] ?? 0) * k + 255 * (1 - k));
      rgb[q + 1] = Math.round((rgba[p + 1] ?? 0) * k + 255 * (1 - k));
      rgb[q + 2] = Math.round((rgba[p + 2] ?? 0) * k + 255 * (1 - k));
    }
  }
  const context = doc.context;
  let smask: PDFRef | undefined;
  if (translucent) {
    const mask = context.flateStream(alpha, {
      Type: 'XObject',
      Subtype: 'Image',
      Width: width,
      Height: height,
      ColorSpace: 'DeviceGray',
      BitsPerComponent: 8,
    });
    smask = context.register(mask);
  }
  const stream = context.flateStream(rgb, {
    Type: 'XObject',
    Subtype: 'Image',
    Width: width,
    Height: height,
    ColorSpace: 'DeviceRGB',
    BitsPerComponent: 8,
    ...(smask ? { SMask: smask } : {}),
  });
  return { ref: context.register(stream), width, height };
}

/** The six numbers of a PDF transformation matrix. */
export type Matrix = readonly [number, number, number, number, number, number];

/**
 * The matrix that turns the stored image's unit square into the displayed unit square for an
 * EXIF orientation, in PDF coordinates (y up). Orientation 6, for instance, moves the stored
 * top-left corner to the displayed top-right — a 90° clockwise turn.
 */
export function orientationMatrix(orientation: ExifOrientation): Matrix {
  switch (orientation) {
    case 2:
      return [-1, 0, 0, 1, 1, 0];
    case 3:
      return [-1, 0, 0, -1, 1, 1];
    case 4:
      return [1, 0, 0, -1, 0, 1];
    case 5:
      return [0, -1, -1, 0, 1, 1];
    case 6:
      return [0, -1, 1, 0, 0, 1];
    case 7:
      return [0, 1, 1, 0, 0, 0];
    case 8:
      return [0, 1, -1, 0, 1, 0];
    default:
      return [1, 0, 0, 1, 0, 0];
  }
}

/** Applies a matrix to a point. */
export function apply(m: Matrix, x: number, y: number): { readonly x: number; readonly y: number } {
  return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] };
}

/**
 * Draws a picture so that its *displayed* image (after orientation) fills `rect`, optionally
 * clipped to `clipTo` (the fill mode, where the image overflows the content box).
 */
export function drawPlaceable(
  page: PDFPage,
  picture: Placeable,
  rect: Rect,
  orientation: ExifOrientation,
  clipTo?: Rect,
): void {
  const name = page.node.newXObject('Im', picture.ref);
  const ops = [pushGraphicsState()];
  if (clipTo)
    ops.push(rectangle(clipTo.x, clipTo.y, clipTo.width, clipTo.height), clip(), endPath());
  ops.push(
    concatTransformationMatrix(rect.width, 0, 0, rect.height, rect.x, rect.y),
    concatTransformationMatrix(...orientationMatrix(orientation)),
    drawObject(name),
    popGraphicsState(),
  );
  page.pushOperators(...ops);
}

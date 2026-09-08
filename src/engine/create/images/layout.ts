/**
 * Page geometry for an image (M91): one pure function the converter and the dialog's preview
 * both call, so they cannot disagree.
 */

import type { MarginsMm, Orientation, PageSizeChoice } from '@shared/create';
import { marginsToPoints, resolvePageSize, type SizePt } from '@shared/pageSizes';
import type { Rect } from './raster';

/** How the page is sized around an image. */
export type ImagePageMode =
  /** The page is the image at its DPI, plus the margins. */
  | 'image'
  /** A chosen page size; the image is placed inside the margins. */
  | 'fixed';

/** How an image is placed on a fixed page. */
export type ImageFit =
  /** Scaled to fit inside the margins, keeping its aspect (up or down). */
  | 'fit'
  /** Scaled to cover the content box, keeping its aspect, cropped centrally. */
  | 'fill'
  /** 1:1 at its DPI, centred; reduced to fit only if it would not fit. */
  | 'actual';

export interface ImageLayoutOptions {
  readonly pageMode: ImagePageMode;
  readonly pageSize: PageSizeChoice;
  readonly orientation: Orientation;
  readonly margins: MarginsMm;
  readonly fit: ImageFit;
  /** Used when the image declares no DPI. */
  readonly defaultDpi: number;
}

export const DEFAULT_IMAGE_LAYOUT: ImageLayoutOptions = {
  pageMode: 'fixed',
  pageSize: { kind: 'preset', id: 'A4' },
  orientation: 'auto',
  margins: { top: 10, right: 10, bottom: 10, left: 10 },
  fit: 'fit',
  defaultDpi: 96,
};

/** The displayed image: pixels after orientation, and the DPI it claims. */
export interface DisplayedImage {
  readonly widthPx: number;
  readonly heightPx: number;
  readonly dpiX?: number;
  readonly dpiY?: number;
}

export interface ImageLayout {
  readonly page: SizePt;
  /** Where the displayed image goes, in points. */
  readonly rect: Rect;
  /** The content box, for clipping when the image overflows it (fill). */
  readonly clip: Rect | null;
  /** The DPI actually used for the natural size. */
  readonly dpi: { readonly x: number; readonly y: number };
}

/** The image's natural size in points at its DPI (or the default). */
export function naturalSize(
  image: DisplayedImage,
  defaultDpi: number,
): {
  readonly width: number;
  readonly height: number;
  readonly dpiX: number;
  readonly dpiY: number;
} {
  const fallback = defaultDpi > 0 ? defaultDpi : 96;
  const dpiX = image.dpiX && image.dpiX > 0 ? image.dpiX : fallback;
  const dpiY = image.dpiY && image.dpiY > 0 ? image.dpiY : dpiX;
  return {
    width: (image.widthPx / dpiX) * 72,
    height: (image.heightPx / dpiY) * 72,
    dpiX,
    dpiY,
  };
}

export function layoutImage(image: DisplayedImage, options: ImageLayoutOptions): ImageLayout {
  const natural = naturalSize(image, options.defaultDpi);
  const dpi = { x: natural.dpiX, y: natural.dpiY };
  const aspect = natural.width / Math.max(natural.height, 1e-6);

  if (options.pageMode === 'image') {
    // Margins on an image-sized page: clamp against the *image*, not a page we do not have yet.
    const m = marginsToPoints(options.margins, {
      width: natural.width * 2 + 2,
      height: natural.height * 2 + 2,
    });
    const page = {
      width: Math.max(1, natural.width + m.left + m.right),
      height: Math.max(1, natural.height + m.top + m.bottom),
    };
    return {
      page,
      rect: { x: m.left, y: m.bottom, width: natural.width, height: natural.height },
      clip: null,
      dpi,
    };
  }

  const page = resolvePageSize(options.pageSize, options.orientation, aspect);
  const m = marginsToPoints(options.margins, page);
  const box: Rect = {
    x: m.left,
    y: m.bottom,
    width: Math.max(1, page.width - m.left - m.right),
    height: Math.max(1, page.height - m.top - m.bottom),
  };
  const fitScale = Math.min(box.width / natural.width, box.height / natural.height);
  let scale: number;
  switch (options.fit) {
    case 'fill':
      scale = Math.max(box.width / natural.width, box.height / natural.height);
      break;
    case 'actual':
      scale = Math.min(1, fitScale);
      break;
    default:
      scale = fitScale;
  }
  const width = natural.width * scale;
  const height = natural.height * scale;
  const rect: Rect = {
    x: box.x + (box.width - width) / 2,
    y: box.y + (box.height - height) / 2,
    width,
    height,
  };
  const overflows = width > box.width + 0.01 || height > box.height + 0.01;
  return { page, rect, clip: overflows ? box : null, dpi };
}

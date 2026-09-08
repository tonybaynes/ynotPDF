/**
 * Turning a destination into a view (M12) — pure.
 *
 * A PDF destination says where to go in the language of the *page*: points from the bottom-left
 * corner, and a fit mode (PDF 12.3.2.2). A viewport wants a page index, a zoom and a scroll
 * offset in CSS pixels from the top of the page. This is the one place that conversion happens,
 * so bookmarks, the destinations panel and — later — links and form actions all land on the same
 * pixel.
 *
 * `null` for a zoom or an offset means "leave it as it is", which is exactly what `/XYZ` with a
 * zero or missing value asks for.
 */

import type { ModelDestination } from '@core/model';

/** The displayed size of a page, in points (rotation already applied). */
export interface PageBox {
  readonly width: number;
  readonly height: number;
}

/** The area a document is shown in, in CSS pixels. */
export interface ViewportBox {
  readonly width: number;
  readonly height: number;
}

/** What a viewport should do to honour a destination. */
export interface DestinationView {
  /** CSS pixels per point, or `null` to keep the current zoom. */
  readonly zoom: number | null;
  /** A fit mode to switch to, or `null` to leave the fit alone. */
  readonly fit: 'page' | 'width' | null;
  /** Distance from the top of the page in **points**, or `null` for "the top of the page". */
  readonly top: number | null;
  /** Distance from the left of the page in **points**, or `null` for "do not scroll sideways". */
  readonly left: number | null;
}

/** Padding the viewer leaves around a destination, so the target is not flush against the edge. */
const MARGIN_POINTS = 4;

/** Zoom bounds, matching the viewer's own (1 %–6400 %). */
const MIN_ZOOM = 0.01;
const MAX_ZOOM = 64;

function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom) || zoom <= 0) return 1;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

/**
 * What a destination asks the viewport for. `viewport` is only needed by the fitting modes; pass
 * a zero box and they degrade to "top of the page at the current zoom", which is what a viewport
 * that has not been laid out yet can honour.
 */
export function destinationView(
  dest: Pick<ModelDestination, 'fit' | 'left' | 'top' | 'zoom' | 'rect'>,
  page: PageBox,
  viewport: ViewportBox,
): DestinationView {
  const fromTop = (top: number | null): number | null =>
    top === null ? null : Math.max(0, page.height - top);
  switch (dest.fit) {
    case 'xyz':
      return {
        // `/XYZ` with a null or zero zoom means "keep the current magnification" (PDF 12.3.2.2).
        zoom: dest.zoom !== null && dest.zoom > 0 ? clampZoom(dest.zoom) : null,
        fit: null,
        top: fromTop(dest.top),
        left: dest.left,
      };
    case 'fit':
    case 'fitB':
      return { zoom: null, fit: 'page', top: 0, left: null };
    case 'fitH':
    case 'fitBH':
      return { zoom: null, fit: 'width', top: fromTop(dest.top), left: null };
    case 'fitV':
    case 'fitBV':
      return {
        zoom: viewport.width > 0 ? clampZoom(viewport.width / Math.max(1, page.width)) : null,
        fit: null,
        top: 0,
        left: dest.left,
      };
    case 'fitR': {
      const rect = dest.rect;
      if (!rect || viewport.width <= 0 || viewport.height <= 0) {
        return { zoom: null, fit: 'page', top: 0, left: null };
      }
      const width = Math.max(1, Math.abs(rect.x1 - rect.x0)) + 2 * MARGIN_POINTS;
      const height = Math.max(1, Math.abs(rect.y1 - rect.y0)) + 2 * MARGIN_POINTS;
      return {
        zoom: clampZoom(Math.min(viewport.width / width, viewport.height / height)),
        fit: null,
        top: fromTop(Math.max(rect.y0, rect.y1)),
        left: Math.min(rect.x0, rect.x1),
      };
    }
  }
}

/**
 * The scroll offset, in CSS pixels, that puts a destination at the top of the viewport.
 *
 * `pageTop` is where the page starts inside the scrolled content, which is what the viewer's
 * layout table reports; `zoom` is the zoom that will be in force *after* the jump.
 */
export function scrollTopFor(view: DestinationView, pageTop: number, zoom: number): number {
  const offset = view.top === null ? 0 : Math.max(0, view.top - MARGIN_POINTS) * zoom;
  return Math.max(0, Math.round(pageTop + offset));
}

/** The same for the horizontal axis; `null` when the destination does not ask to scroll across. */
export function scrollLeftFor(
  view: DestinationView,
  pageLeft: number,
  zoom: number,
): number | null {
  if (view.left === null) return null;
  return Math.max(0, Math.round(pageLeft + Math.max(0, view.left - MARGIN_POINTS) * zoom));
}

/**
 * A destination describing the current view, for "create from current view" and "set
 * destination to current view". `/XYZ` with the live zoom is what Foxit records, and it is the
 * only mode that survives a different window size unchanged.
 */
export function destinationFromView(options: {
  readonly page: PageBox;
  /** Distance from the top of the page, in points. */
  readonly topPoints: number;
  /** Distance from the left of the page, in points. */
  readonly leftPoints: number;
  /** CSS pixels per point. */
  readonly zoom: number;
}): {
  fit: 'xyz';
  left: number;
  top: number;
  zoom: number;
  rect: null;
} {
  return {
    fit: 'xyz',
    left: Math.max(0, Math.round(options.leftPoints * 100) / 100),
    top: Math.max(0, Math.round((options.page.height - options.topPoints) * 100) / 100),
    zoom: Math.round(clampZoom(options.zoom) * 10000) / 10000,
    rect: null,
  };
}

/** A short, readable description of a destination, for the panel and its tooltips. */
export function describeDestination(
  dest: Pick<ModelDestination, 'fit' | 'top' | 'zoom'>,
  pageLabel: string | null,
): string {
  const where = pageLabel === null ? 'no page' : `page ${pageLabel}`;
  switch (dest.fit) {
    case 'xyz':
      return dest.zoom !== null && dest.zoom > 0
        ? `${where} at ${String(Math.round(dest.zoom * 100))}%`
        : where;
    case 'fit':
    case 'fitB':
      return `${where}, fit page`;
    case 'fitH':
    case 'fitBH':
      return `${where}, fit width`;
    case 'fitV':
    case 'fitBV':
      return `${where}, fit height`;
    case 'fitR':
      return `${where}, fit rectangle`;
  }
}

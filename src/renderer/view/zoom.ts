/**
 * Zoom maths (M11). Pure functions: fit modes, the zoom step ladder, marquee zoom and the
 * scroll offsets that keep a point stationary while the zoom changes.
 *
 * Zoom is CSS pixels per PDF point everywhere in the view layer; the store and the status bar
 * speak percent (`zoom = percent / 100`), and `viewer.percent`/`viewer.factor` convert.
 */

import type { Rotation } from '@shared/pdf';
import { isFacing, pageBoxPx, type LayoutMode, type LayoutPageSize } from './layout';

/** Foxit's range: 1 % to 6400 %. */
export const MIN_PERCENT = 1;
export const MAX_PERCENT = 6400;

/** The zoom ladder Zoom In / Zoom Out walks, in percent. */
export const ZOOM_LADDER: ReadonlyArray<number> = [
  1, 5, 10, 25, 33, 50, 66, 75, 100, 125, 150, 200, 300, 400, 600, 800, 1200, 1600, 2400, 3200,
  6400,
];

/** Which fit mode the view is holding, if any. */
export type FitMode = 'page' | 'width' | 'visible' | null;

export function clampPercent(percent: number): number {
  if (!Number.isFinite(percent)) return 100;
  return Math.min(MAX_PERCENT, Math.max(MIN_PERCENT, percent));
}

/** Percent → CSS px per point. */
export function factor(percent: number): number {
  return clampPercent(percent) / 100;
}

/** CSS px per point → percent, rounded to whole percent for display. */
export function percent(zoomFactor: number): number {
  return clampPercent(Math.round(zoomFactor * 100));
}

/** The next ladder rung above or below `current` percent. */
export function stepPercent(current: number, direction: 1 | -1): number {
  if (direction > 0) {
    const next = ZOOM_LADDER.find((z) => z > current + 1e-6);
    return clampPercent(next ?? MAX_PERCENT);
  }
  for (let i = ZOOM_LADDER.length - 1; i >= 0; i--) {
    const z = ZOOM_LADDER[i];
    if (z !== undefined && z < current - 1e-6) return clampPercent(z);
  }
  return MIN_PERCENT;
}

/**
 * Zoom buckets. A pinch or a wheel produces a continuous stream of zooms; rendering every one
 * would thrash the cache, so tiles are rasterised at the nearest bucket (an eighth of a stop)
 * and the canvas scales the difference — at most 4 % off, which is invisible.
 */
export const BUCKETS_PER_OCTAVE = 8;

export function bucketZoom(zoomFactor: number): number {
  if (!(zoomFactor > 0)) return 1;
  const steps = Math.round(Math.log2(zoomFactor) * BUCKETS_PER_OCTAVE);
  return 2 ** (steps / BUCKETS_PER_OCTAVE);
}

/** A stable key for a bucketed zoom, used in tile ids. */
export function bucketKey(zoomFactor: number): number {
  if (!(zoomFactor > 0)) return 0;
  return Math.round(Math.log2(zoomFactor) * BUCKETS_PER_OCTAVE);
}

/** What a fit calculation needs to know about the viewport. */
export interface FitViewport {
  readonly width: number;
  readonly height: number;
  /** Gap between facing pages and padding around the content, CSS px. */
  readonly gap: number;
  readonly padding: number;
  /** Width the vertical scrollbar will take once the content is taller than the viewport. */
  readonly scrollbar?: number;
}

/**
 * The zoom factor that fits `sizes` (the pages of the current row) to the viewport.
 *
 * - `page` fits the whole row, width and height.
 * - `width` fits the row's width.
 * - `visible` fits the *inked* width of the row — the caller passes the visible box instead of
 *   the page box, which is what Foxit's "Fit Visible" does with the content bounding box.
 */
export function fitZoom(
  sizes: ReadonlyArray<LayoutPageSize>,
  mode: LayoutMode,
  fit: Exclude<FitMode, null>,
  viewport: FitViewport,
  rotation: Rotation = 0,
): number {
  if (sizes.length === 0) return 1;
  const boxes = sizes.map((s) => pageBoxPx(s, 1, rotation));
  const columns = isFacing(mode) ? Math.min(2, boxes.length) : 1;
  const gaps = viewport.gap * (columns - 1);
  const rowWidth = boxes.slice(0, columns).reduce((a, b) => a + b.width, 0);
  const rowHeight = boxes.slice(0, columns).reduce((a, b) => Math.max(a, b.height), 0);
  const padding = viewport.padding * 2;
  const scrollbar = viewport.scrollbar ?? 0;

  const available = Math.max(1, viewport.width - padding - scrollbar - gaps);
  const byWidth = rowWidth > 0 ? available / rowWidth : 1;
  if (fit === 'width' || fit === 'visible') return clampFactor(byWidth);

  const availableHeight = Math.max(1, viewport.height - padding);
  const byHeight = rowHeight > 0 ? availableHeight / rowHeight : 1;
  // Fit Page must not need a horizontal scrollbar either, so take the smaller of the two.
  return clampFactor(Math.min(byWidth, byHeight));
}

export function clampFactor(zoomFactor: number): number {
  return factor(percent(zoomFactor));
}

/** A scroll position. */
export interface ScrollPosition {
  readonly left: number;
  readonly top: number;
}

/**
 * Zoom about a fixed point. `anchor` is in viewport coordinates (CSS px from the viewport's
 * top-left); the returned scroll keeps whatever content sat under it exactly there.
 *
 * `contentX = (scroll.left + anchor.x - offset.x) / oldZoom` is the content point under the
 * cursor, where `offset` is the content's own offset inside the scroller (centring). The new
 * scroll puts that same content point back under the anchor.
 */
export function zoomAboutPoint(
  scroll: ScrollPosition,
  anchor: { readonly x: number; readonly y: number },
  oldZoom: number,
  newZoom: number,
  offset: { readonly x: number; readonly y: number } = { x: 0, y: 0 },
  newOffset: { readonly x: number; readonly y: number } = offset,
): ScrollPosition {
  const ratio = oldZoom > 0 ? newZoom / oldZoom : 1;
  const contentX = scroll.left + anchor.x - offset.x;
  const contentY = scroll.top + anchor.y - offset.y;
  return {
    left: contentX * ratio - anchor.x + newOffset.x,
    top: contentY * ratio - anchor.y + newOffset.y,
  };
}

/**
 * The zoom and scroll that bring a content rectangle (CSS px at `oldZoom`) into view filling
 * the viewport — the marquee-zoom gesture.
 */
export function zoomToRect(
  rect: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
  oldZoom: number,
  viewport: { readonly width: number; readonly height: number },
): { zoom: number; scroll: ScrollPosition } {
  const w = Math.max(1, rect.width);
  const h = Math.max(1, rect.height);
  const target = clampFactor(oldZoom * Math.min(viewport.width / w, viewport.height / h));
  const ratio = oldZoom > 0 ? target / oldZoom : 1;
  const centreX = (rect.x + rect.width / 2) * ratio;
  const centreY = (rect.y + rect.height / 2) * ratio;
  return {
    zoom: target,
    scroll: { left: centreX - viewport.width / 2, top: centreY - viewport.height / 2 },
  };
}

/**
 * A wheel delta turned into a zoom factor. Chromium reports `deltaY` in pixels for a mouse
 * wheel (±100 per notch) and in smaller steps for a trackpad; an exponential map treats both
 * the same and never inverts.
 */
export function wheelZoom(currentZoom: number, deltaY: number): number {
  const stops = -deltaY / 400;
  return clampFactor(currentZoom * 2 ** stops);
}

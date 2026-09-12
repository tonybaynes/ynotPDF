import type { PageObject } from '@engine/PdfEngine';
import { PageGeometry, type DeviceRect } from '@engine/geometry';
import type { PageSize, PdfRect, Rotation } from '@shared/pdf';
import { normalizeRect } from '@shared/pdf';
import { rectOfPage, type LayoutTable } from './layout';

/** Conservative content bounds in PDF space; blank pages use their displayed page box. */
export function contentBounds(
  objects: ReadonlyArray<PageObject>,
  size: PageSize,
  hiddenLayers: ReadonlySet<string> = new Set(),
): PdfRect {
  const box = new PageGeometry(size).box;
  let bounds: PdfRect | undefined;
  for (const object of objects) {
    if (object.layerId && hiddenLayers.has(object.layerId)) continue;
    if (object.fillAlpha === 0 && object.strokeAlpha === 0) continue;
    if (!Object.values(object.rect).every(Number.isFinite)) continue;
    const r = normalizeRect(object.rect);
    // A hairline can have a zero-width or zero-height geometric box and still paint ink.
    if (r.x0 === r.x1 && r.y0 === r.y1) continue;
    const padX = r.x0 === r.x1 ? 0.5 : 0;
    const padY = r.y0 === r.y1 ? 0.5 : 0;
    const clipped = {
      x0: Math.max(box.x0, r.x0 - padX),
      y0: Math.max(box.y0, r.y0 - padY),
      x1: Math.min(box.x1, r.x1 + padX),
      y1: Math.min(box.y1, r.y1 + padY),
    };
    if (clipped.x1 <= clipped.x0 || clipped.y1 <= clipped.y0) continue;
    bounds = bounds
      ? {
          x0: Math.min(bounds.x0, clipped.x0),
          y0: Math.min(bounds.y0, clipped.y0),
          x1: Math.max(bounds.x1, clipped.x1),
          y1: Math.max(bounds.y1, clipped.y1),
        }
      : clipped;
  }
  return bounds ?? box;
}

/** Union in layout coordinates, retaining the margins between facing pages. */
export function visibleRowBounds(
  table: LayoutTable,
  sizes: ReadonlyArray<PageSize>,
  bounds: ReadonlyMap<number, PdfRect>,
  rotation: Rotation,
): DeviceRect | null {
  let result: DeviceRect | null = null;
  for (const [page, box] of bounds) {
    const size = sizes[page];
    const rect = rectOfPage(table, page);
    if (!size || !rect) continue;
    const ink = new PageGeometry(size, rotation).rectToDevice(box, table.zoom);
    const next = { x: rect.x + ink.x, y: rect.y + ink.y, width: ink.width, height: ink.height };
    if (!result) result = next;
    else {
      const x = Math.min(result.x, next.x);
      const y = Math.min(result.y, next.y);
      result = {
        x,
        y,
        width: Math.max(result.x + result.width, next.x + next.width) - x,
        height: Math.max(result.y + result.height, next.y + next.height) - y,
      };
    }
  }
  return result;
}

/** Bounded LRU, including outstanding reads. Invalidated reads cannot populate a new entry. */
export class ContentBoundsCache {
  private readonly entries = new Map<string, Promise<PdfRect>>();
  private readonly capacity: number;

  constructor(capacity = 64) {
    if (!Number.isInteger(capacity) || capacity < 1)
      throw new Error('Invalid bounds cache capacity');
    this.capacity = capacity;
  }

  get(key: string, read: () => Promise<PdfRect>): Promise<PdfRect> {
    const existing = this.entries.get(key);
    if (existing) {
      this.entries.delete(key);
      this.entries.set(key, existing);
      return existing;
    }
    const pending = Promise.resolve()
      .then(read)
      .catch((error: unknown) => {
        if (this.entries.get(key) === pending) this.entries.delete(key);
        throw error;
      });
    this.entries.set(key, pending);
    while (this.entries.size > this.capacity) {
      const first = this.entries.keys().next().value;
      if (first !== undefined) this.entries.delete(first);
    }
    return pending;
  }

  clear(): void {
    this.entries.clear();
  }
}

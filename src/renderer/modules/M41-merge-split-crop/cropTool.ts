/**
 * The Crop tool (M41): drag a rectangle on the page, adjust it with eight handles, press Enter
 * to open the dialog with those numbers already in it, Escape to give up.
 *
 * Coordinates arrive in PDF user space (`ToolPointerEvent`), and that is the space the rectangle
 * is kept in — so a zoom, a scroll or a window resize repaints it in the right place without any
 * arithmetic beyond the one conversion the overlay needs. The rectangle can never leave the
 * page: `fitCropRatio` is applied on every change rather than only at the end, so a drag that runs
 * off the edge stops at the edge instead of snapping back when it is let go.
 *
 * Keyboard: arrow keys resize the displayed right/bottom edge by a point, `Shift` by ten;
 * `Mod+A` selects the whole page. Every one of those exists because a drag is not a
 * keyboard path, and the tool has to have one.
 */

import { el } from '@app/dom';
import type { PageGeometry } from '@engine/geometry';
import { fitCropRatio, pageCropRatio, usableCrop } from './cropRatio';
import { cropDrag } from './cropDrag';
import type { ToolPointerEvent, ToolSpec } from '@shared/module';
import type { PdfRect } from '@shared/pdf';

/** The eight handles, by which corner or edge they move. */
const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as const;
export type CropHandle = (typeof HANDLES)[number];

export interface CropToolHost {
  /** The page currently under the tool, and the box the rectangle lives inside. */
  pageBox(page: number): PdfRect | null;
  geometry(page: number): PageGeometry | null;
  /** Turns a page-space rectangle into the overlay's own pixels. */
  overlayFor(page: number): HTMLElement | null;
  /** Called when the reader finishes a rectangle and asks for it to be applied. */
  commit(page: number, rect: PdfRect): void;
  /** Width-to-height ratio the rectangle is held at, or `null` for free. */
  ratio(): number | null;
  /** Nudge step in points; the tool doubles it when Shift is held. */
  step(): number;
}

/** The smallest rectangle worth treating as a drag rather than a click. */
const MIN_DRAG = 3;

export function cropTool(host: CropToolHost): ToolSpec {
  let page: number | null = null;
  let rect: PdfRect | null = null;
  let dragging: {
    readonly from: { x: number; y: number };
    readonly handle: CropHandle | null;
    readonly pointerId: number;
    readonly initial: PdfRect | null;
  } | null = null;
  let overlay: HTMLElement | null = null;
  let frame: HTMLElement | null = null;

  const clear = (): void => {
    frame?.remove();
    frame = null;
    overlay = null;
    rect = null;
    page = null;
    dragging = null;
  };

  const ensureFrame = (onPage: number): HTMLElement | null => {
    const host_ = host.overlayFor(onPage);
    if (!host_) return null;
    if (overlay !== host_) {
      frame?.remove();
      frame = null;
      overlay = host_;
    }
    if (!frame) {
      frame = el('div.crop-frame', {
        role: 'group',
        'aria-label': 'Crop rectangle',
        tabindex: '0',
      });
      for (const handle of HANDLES) {
        const knob = el('span.crop-handle', { 'data-handle': handle, 'aria-hidden': 'true' });
        frame.append(knob);
      }
      overlay.append(frame);
    }
    return frame;
  };

  const paint = (): void => {
    if (page === null || !rect || !frame) return;
    const geometry = host.geometry(page);
    if (!geometry) return;
    const shown = geometry.rectToDevice(rect, 1);
    frame.style.left = `${String((shown.x / geometry.width) * 100)}%`;
    frame.style.width = `${String((shown.width / geometry.width) * 100)}%`;
    frame.style.top = `${String((shown.y / geometry.height) * 100)}%`;
    frame.style.height = `${String((shown.height / geometry.height) * 100)}%`;
  };

  const setRect = (next: PdfRect): void => {
    if (page === null) return;
    const geometry = host.geometry(page);
    if (!geometry) return;
    rect = fitCropRatio(next, geometry.box, pageCropRatio(host.ratio(), geometry.rotation));
    paint();
  };

  /** The rectangle a drag from `from` to `to` makes, given which handle (if any) is held. */
  const dragged = (
    from: { x: number; y: number },
    to: { x: number; y: number },
    handle: CropHandle | null,
    current: PdfRect | null,
  ): PdfRect => {
    const geometry = page === null ? null : host.geometry(page);
    if (!geometry) return { x0: 0, y0: 0, x1: 0, y1: 0 };
    const a = geometry.toDevice(from, 1);
    const b = geometry.toDevice(to, 1);
    const shown = current ? geometry.rectToDevice(current, 1) : null;
    return geometry.rectToPage(cropDrag(a, b, shown, handle, host.ratio(), geometry), 1);
  };

  const handleUnder = (event: ToolPointerEvent): CropHandle | null => {
    const target = event.original.target;
    if (!(target instanceof HTMLElement)) return null;
    const name = target.dataset['handle'];
    return HANDLES.includes(name as CropHandle) ? (name as CropHandle) : null;
  };

  return {
    id: 'tool.crop',
    label: 'Crop',
    icon: 'crop',
    cursor: 'crosshair',
    activateCommand: 'organize.cropTool',
    deactivate: clear,

    onPointerDown: (event) => {
      if (event.buttons !== 1) return undefined;
      const handle = handleUnder(event);
      if (page !== null && page !== event.page) clear();
      page = event.page;
      if (!ensureFrame(page)) return undefined;
      dragging = {
        from: { x: event.x, y: event.y },
        handle,
        pointerId: event.original.pointerId,
        initial: rect,
      };
      if (handle === null) rect = null;
      (event.original.target as Element | null)?.setPointerCapture?.(event.original.pointerId);
      return true;
    },

    onPointerMove: (event) => {
      if (!dragging || page === null || event.original.pointerId !== dragging.pointerId)
        return undefined;
      setRect(
        dragged(dragging.from, { x: event.x, y: event.y }, dragging.handle, dragging.initial),
      );
      return true;
    },

    onPointerUp: (event) => {
      if (!dragging || page === null || event.original.pointerId !== dragging.pointerId)
        return undefined;
      const wasHandle = dragging.handle !== null;
      setRect(
        dragged(dragging.from, { x: event.x, y: event.y }, dragging.handle, dragging.initial),
      );
      dragging = null;
      (event.original.target as Element | null)?.releasePointerCapture?.(event.original.pointerId);
      // A click rather than a drag means "the whole page", which is what a reader who taps the
      // page while holding the crop tool almost always wants.
      if (!wasHandle && rect && rect.x1 - rect.x0 < MIN_DRAG && rect.y1 - rect.y0 < MIN_DRAG) {
        const box = host.pageBox(page);
        if (box) setRect(box);
      }
      frame?.focus();
      return true;
    },

    onKeyDown: (event) => {
      if (page === null) return undefined;
      if (event.key === 'Escape') {
        clear();
        return true;
      }
      if (event.key === 'Enter' && rect && usableCrop(rect)) {
        const onPage = page;
        const chosen = rect;
        clear();
        host.commit(onPage, chosen);
        return true;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
        const box = host.pageBox(page);
        if (box) {
          ensureFrame(page);
          setRect(box);
        }
        return true;
      }
      const step = host.step() * (event.shiftKey ? 10 : 1);
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key) || !rect)
        return undefined;
      const geometry = host.geometry(page);
      if (!geometry) return undefined;
      const shown = geometry.rectToDevice(rect, 1);
      const horizontal = event.key === 'ArrowLeft' || event.key === 'ArrowRight';
      const delta = event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -step : step;
      const to = {
        x: shown.x + shown.width + (horizontal ? delta : 0),
        y: shown.y + shown.height + (horizontal ? 0 : delta),
      };
      setRect(
        geometry.rectToPage(
          cropDrag(to, to, shown, horizontal ? 'e' : 's', host.ratio(), geometry),
          1,
        ),
      );
      return true;
    },
  };
}

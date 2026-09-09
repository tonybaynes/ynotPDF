/**
 * The Crop tool (M41): drag a rectangle on the page, adjust it with eight handles, press Enter
 * to open the dialog with those numbers already in it, Escape to give up.
 *
 * Coordinates arrive in PDF user space (`ToolPointerEvent`), and that is the space the rectangle
 * is kept in — so a zoom, a scroll or a window resize repaints it in the right place without any
 * arithmetic beyond the one conversion the overlay needs. The rectangle can never leave the
 * page: `clampRect` is applied on every change rather than only at the end, so a drag that runs
 * off the edge stops at the edge instead of snapping back when it is let go.
 *
 * Keyboard: arrow keys nudge the nearest edge by a point, `Shift` by ten; `Tab` moves between
 * handles; `Mod+A` selects the whole page. Every one of those exists because a drag is not a
 * keyboard path, and the tool has to have one.
 */

import { el } from '@app/dom';
import { clampRect, constrainRatio } from '@engine/ops/crop';
import type { ToolPointerEvent, ToolSpec } from '@shared/module';
import type { PdfRect } from '@shared/pdf';

/** The eight handles, by which corner or edge they move. */
const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as const;
export type CropHandle = (typeof HANDLES)[number];

export interface CropToolHost {
  /** The page currently under the tool, and the box the rectangle lives inside. */
  pageBox(page: number): PdfRect | null;
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
    const box = host.pageBox(page);
    if (!box) return;
    const width = box.x1 - box.x0;
    const height = box.y1 - box.y0;
    frame.style.left = `${String(((rect.x0 - box.x0) / width) * 100)}%`;
    frame.style.width = `${String(((rect.x1 - rect.x0) / width) * 100)}%`;
    // The overlay counts down from the top; PDF space counts up from the bottom.
    frame.style.top = `${String(((box.y1 - rect.y1) / height) * 100)}%`;
    frame.style.height = `${String(((rect.y1 - rect.y0) / height) * 100)}%`;
  };

  const setRect = (next: PdfRect): void => {
    if (page === null) return;
    const box = host.pageBox(page);
    if (!box) return;
    const ratio = host.ratio();
    rect = ratio === null ? clampRect(next, box) : constrainRatio(clampRect(next, box), ratio, box);
    paint();
  };

  /** The rectangle a drag from `from` to `to` makes, given which handle (if any) is held. */
  const dragged = (
    from: { x: number; y: number },
    to: { x: number; y: number },
    handle: CropHandle | null,
    current: PdfRect | null,
  ): PdfRect => {
    if (handle === null || !current) {
      return {
        x0: Math.min(from.x, to.x),
        x1: Math.max(from.x, to.x),
        y0: Math.min(from.y, to.y),
        y1: Math.max(from.y, to.y),
      };
    }
    const next = { ...current };
    if (handle.includes('w')) next.x0 = to.x;
    if (handle.includes('e')) next.x1 = to.x;
    if (handle.includes('n')) next.y1 = to.y;
    if (handle.includes('s')) next.y0 = to.y;
    return {
      x0: Math.min(next.x0, next.x1),
      x1: Math.max(next.x0, next.x1),
      y0: Math.min(next.y0, next.y1),
      y1: Math.max(next.y0, next.y1),
    };
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
      dragging = { from: { x: event.x, y: event.y }, handle };
      if (handle === null) rect = null;
      (event.original.target as Element | null)?.setPointerCapture?.(event.original.pointerId);
      return true;
    },

    onPointerMove: (event) => {
      if (!dragging || page === null) return undefined;
      setRect(dragged(dragging.from, { x: event.x, y: event.y }, dragging.handle, rect));
      return true;
    },

    onPointerUp: (event) => {
      if (!dragging || page === null) return undefined;
      const wasHandle = dragging.handle !== null;
      setRect(dragged(dragging.from, { x: event.x, y: event.y }, dragging.handle, rect));
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
      if (event.key === 'Enter' && rect) {
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
      const nudge: Partial<Record<string, Partial<PdfRect>>> = {
        ArrowLeft: { x1: -step },
        ArrowRight: { x1: step },
        ArrowUp: { y0: step },
        ArrowDown: { y0: -step },
      };
      const delta = nudge[event.key];
      if (!delta || !rect) return undefined;
      setRect({
        x0: rect.x0 + (delta.x0 ?? 0),
        x1: rect.x1 + (delta.x1 ?? 0),
        y0: rect.y0 + (delta.y0 ?? 0),
        y1: rect.y1 + (delta.y1 ?? 0),
      });
      return true;
    },
  };
}

/**
 * The link tool (M53): drag a rectangle on the page, say where it goes.
 *
 * While it is active every link on the page is outlined, so a reader can see what is already
 * there and click one to change it — the outlines are the link layer's, and clicking an existing
 * link goes to the service rather than starting a new rectangle, because the layer's own boxes
 * sit above the tool surface.
 *
 * A drag smaller than a few points is a click, not a rectangle: it deselects instead of making a
 * link nobody could hit.
 */

import type { ToolPointerEvent, ToolSpec } from '@shared/module';
import type { PdfRect } from '@shared/pdf';
import type { LinkService } from './LinkService';
import { LINK_TOOL_ID } from './LinkService';

/** Smaller than this, in points, and the drag was a click. */
const MINIMUM = 4;

export interface LinkToolOptions {
  readonly service: () => LinkService | null;
  /** Opens the "what does this link do" dialog for a new rectangle. */
  create(page: number, rect: PdfRect): Promise<void>;
}

export function linkTool(options: LinkToolOptions): ToolSpec {
  let anchor: { page: number; x: number; y: number } | null = null;
  let current: PdfRect | null = null;

  const rectOf = (event: ToolPointerEvent): PdfRect | null => {
    if (anchor?.page !== event.page) return null;
    return {
      x0: Math.min(anchor.x, event.x),
      y0: Math.min(anchor.y, event.y),
      x1: Math.max(anchor.x, event.x),
      y1: Math.max(anchor.y, event.y),
    };
  };

  return {
    id: LINK_TOOL_ID,
    label: 'Link',
    icon: 'link',
    cursor: 'crosshair',
    activate: () => {
      const service = options.service();
      service?.setEditing(true);
      service?.setCursor('crosshair');
    },
    deactivate: () => {
      anchor = null;
      current = null;
      const service = options.service();
      service?.setDraft(null);
      service?.setCursor(null);
      service?.setEditing(false);
    },
    onPointerDown: (event) => {
      if (event.buttons !== 1) return undefined;
      anchor = { page: event.page, x: event.x, y: event.y };
      current = null;
      /*
       * Capture the pointer on the layer the event arrived at.
       *
       * Without it the tool only hears a move while the pointer is still over that page's tool
       * layer, and a drag that crosses a page edge — or that the platform delivers slightly
       * differently — loses its `pointerup` and makes no link at all. macOS CI found this; the
       * capture is what makes the gesture the same on all three.
       */
      const target = event.original.currentTarget ?? event.original.target;
      if (target instanceof Element) {
        try {
          target.setPointerCapture(event.original.pointerId);
        } catch {
          // A synthetic event with no real pointer id: the drag still works without capture.
        }
      }
      return true;
    },
    onPointerMove: (event) => {
      if (!anchor) return undefined;
      current = rectOf(event);
      options.service()?.setDraft(current ? { page: anchor.page, rect: current } : null);
      return true;
    },
    onPointerUp: (event) => {
      const target = event.original.currentTarget ?? event.original.target;
      if (target instanceof Element && target.hasPointerCapture(event.original.pointerId)) {
        target.releasePointerCapture(event.original.pointerId);
      }
      const start = anchor;
      anchor = null;
      const rect = current ?? (start ? rectOf(event) : null);
      current = null;
      const service = options.service();
      service?.setDraft(null);
      if (!start) return undefined;
      if (!rect || rect.x1 - rect.x0 < MINIMUM || rect.y1 - rect.y0 < MINIMUM) {
        service?.clearSelection();
        return true;
      }
      void options.create(start.page, rect);
      return true;
    },
    onKeyDown: (event) => {
      if (event.key !== 'Escape' || !anchor) return undefined;
      anchor = null;
      current = null;
      options.service()?.setDraft(null);
      return true;
    },
  };
}

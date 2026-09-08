/**
 * The viewer's tools (M11): Hand (the default), Marquee zoom, Loupe and the Select-text stub
 * that M13 finishes.
 *
 * A `ToolSpec` receives pointer events in PDF user space from the page's tool layer (see
 * `PageView.bindTool`). These tools mostly need *viewport* coordinates rather than page ones,
 * which is why each keeps the original event: `ToolPointerEvent.original` is the raw
 * `PointerEvent`, so a drag can be measured in screen pixels and still know which page it
 * started on.
 */

import { el } from '@app/dom';
import type { ToolPointerEvent, ToolSpec } from '@shared/module';
import { zoomToRect } from '@view/zoom';
import type { Viewer } from './Viewer';

/** How the tools reach the viewer of the active tab. */
export type ViewerLookup = () => Viewer | null;

/** Sets the cursor for the whole viewer while a tool is active. */
function setCursor(viewer: Viewer | null, cursor: string | null): void {
  if (!viewer) return;
  if (cursor) viewer.element.closest('.viewer-split')?.setAttribute('data-tool-cursor', cursor);
  for (const pane of viewer.allPanes) {
    if (cursor) pane.element.dataset['toolCursor'] = cursor;
    else delete pane.element.dataset['toolCursor'];
  }
}

/**
 * Hand — grab the page and drag it. The default tool, as in Foxit, so a click never does
 * anything surprising to the document.
 */
export function handTool(viewer: ViewerLookup): ToolSpec {
  let dragging: { x: number; y: number } | null = null;
  return {
    id: 'tool.hand',
    label: 'Hand',
    icon: 'hand',
    cursor: 'grab',
    activate: () => {
      setCursor(viewer(), 'grab');
    },
    deactivate: () => {
      dragging = null;
      setCursor(viewer(), null);
    },
    onPointerDown: (e) => {
      if (e.buttons !== 1) return undefined;
      dragging = { x: e.original.clientX, y: e.original.clientY };
      (e.original.target as Element | null)?.setPointerCapture?.(e.original.pointerId);
      setCursor(viewer(), 'grabbing');
      return true;
    },
    onPointerMove: (e) => {
      if (!dragging) return undefined;
      const v = viewer();
      if (!v) return undefined;
      v.pane.scrollBy(dragging.x - e.original.clientX, dragging.y - e.original.clientY);
      dragging = { x: e.original.clientX, y: e.original.clientY };
      return true;
    },
    onPointerUp: (e) => {
      if (!dragging) return undefined;
      dragging = null;
      (e.original.target as Element | null)?.releasePointerCapture?.(e.original.pointerId);
      setCursor(viewer(), 'grab');
      return true;
    },
  };
}

/**
 * Marquee zoom — drag a rectangle and the view zooms to it; a plain click zooms in one step
 * about the click, which is what Foxit's marquee tool does too.
 */
export function marqueeTool(viewer: ViewerLookup): ToolSpec {
  let start: { x: number; y: number } | null = null;
  let box: HTMLElement | null = null;

  const clear = (): void => {
    box?.remove();
    box = null;
    start = null;
  };

  return {
    id: 'tool.marqueeZoom',
    label: 'Marquee Zoom',
    icon: 'square-dashed',
    cursor: 'crosshair',
    activate: () => {
      setCursor(viewer(), 'crosshair');
    },
    deactivate: () => {
      clear();
      setCursor(viewer(), null);
    },
    onPointerDown: (e) => {
      if (e.buttons !== 1) return undefined;
      const v = viewer();
      if (!v) return undefined;
      start = v.pane.toContent(e.original.clientX, e.original.clientY);
      box = el('div.viewer-marquee');
      v.pane.content.append(box);
      (e.original.target as Element | null)?.setPointerCapture?.(e.original.pointerId);
      return true;
    },
    onPointerMove: (e) => {
      if (!start || !box) return undefined;
      const v = viewer();
      if (!v) return undefined;
      const now = v.pane.toContent(e.original.clientX, e.original.clientY);
      const rect = normalise(start, now);
      box.style.left = `${rect.x}px`;
      box.style.top = `${rect.y}px`;
      box.style.width = `${rect.width}px`;
      box.style.height = `${rect.height}px`;
      return true;
    },
    onPointerUp: (e) => {
      if (!start) return undefined;
      const v = viewer();
      const from = start;
      clear();
      if (!v) return undefined;
      (e.original.target as Element | null)?.releasePointerCapture?.(e.original.pointerId);
      const to = v.pane.toContent(e.original.clientX, e.original.clientY);
      const rect = normalise(from, to);
      const scroller = v.pane.scroller;
      if (rect.width < 8 || rect.height < 8) {
        // A click, not a drag: one step in, about the point clicked.
        const box2 = scroller.getBoundingClientRect();
        v.pane.zoomAt(
          v.pane.zoom * (e.original.altKey ? 0.5 : 2),
          e.original.clientX - box2.left,
          e.original.clientY - box2.top,
        );
        v.syncOverlays();
        return true;
      }
      const { zoom, scroll } = zoomToRect(rect, v.pane.zoom, {
        width: scroller.clientWidth,
        height: scroller.clientHeight,
      });
      v.pane.setZoom(zoom);
      v.pane.setScroll(scroll);
      v.syncOverlays();
      return true;
    },
    onKeyDown: (e) => {
      if (e.key !== 'Escape' || !start) return undefined;
      clear();
      return true;
    },
  };
}

/**
 * Loupe — the magnifier follows the pointer while this tool is active. The window itself is
 * `view/Loupe.ts`; the tool is what opens and closes it.
 */
export function loupeTool(viewer: ViewerLookup): ToolSpec {
  return {
    id: 'tool.loupe',
    label: 'Loupe',
    icon: 'search',
    cursor: 'crosshair',
    activate: () => {
      const v = viewer();
      setCursor(v, 'crosshair');
      if (v && !v.loupeOpen) v.toggleLoupe();
    },
    deactivate: () => {
      const v = viewer();
      if (v?.loupeOpen) v.toggleLoupe();
      setCursor(v, null);
    },
  };
}

/**
 * Select text — M11 ships the activation, the cursor and the tool layer that M13 will hang
 * selection on. It deliberately does nothing to the document; a stub that *looked* like it
 * selected would be worse than one that plainly does not yet.
 */
export function selectTextTool(viewer: ViewerLookup): ToolSpec {
  return {
    id: 'tool.selectText',
    label: 'Select Text',
    icon: 'text-cursor-input',
    cursor: 'text',
    activate: () => {
      const v = viewer();
      setCursor(v, 'text');
      // Let the browser's own selection work on the text layer M13 fills in.
      for (const pane of v?.allPanes ?? []) pane.element.dataset['selectText'] = 'on';
    },
    deactivate: () => {
      const v = viewer();
      setCursor(v, null);
      for (const pane of v?.allPanes ?? []) delete pane.element.dataset['selectText'];
    },
  };
}

/** Every tool this module contributes, in ribbon order. */
export function viewerTools(viewer: ViewerLookup): ToolSpec[] {
  return [handTool(viewer), selectTextTool(viewer), marqueeTool(viewer), loupeTool(viewer)];
}

function normalise(
  a: { readonly x: number; readonly y: number },
  b: { readonly x: number; readonly y: number },
): { x: number; y: number; width: number; height: number } {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(b.x - a.x),
    height: Math.abs(b.y - a.y),
  };
}

/** Re-exported so the manifest can name the default tool without a string literal. */
export const DEFAULT_TOOL_ID = 'tool.hand';

export type { ToolPointerEvent };

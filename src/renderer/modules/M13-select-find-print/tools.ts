/**
 * M13's tool: Snapshot — a marquee inside one page, which is exactly what a `ToolSpec` is for.
 *
 * **Select Text is not declared here on purpose.** M11 already owns `tool.selectText` (the
 * cursor, the ribbon toggle and the `V` shortcut), and two tools with one id would leave the
 * shell dispatching to whichever module happened to register first. M13 instead watches
 * `ui.activeTool` and turns its selection controller on while that tool is the active one — which
 * it has to do anyway, because a drag that crosses a page boundary has to keep producing
 * coordinates after it has left the page it started on, and a `ToolSpec` only ever hears about
 * the page the pointer went down on.
 */

import { el } from '@app/dom';
import type { ToolSpec } from '@shared/module';
import type { SelectFindService } from './SelectFindService';

/** How the tool reaches the live service. */
export type ServiceLookup = () => SelectFindService | null;

/** The tool id M11 registers and M13 gives meaning to. */
export const SELECT_TEXT_TOOL = 'tool.selectText';
export const SNAPSHOT_TOOL = 'tool.snapshot';

function setCursor(service: SelectFindService | null, cursor: string | null): void {
  const viewer = service?.activeViewer();
  if (!viewer) return;
  for (const pane of viewer.allPanes) {
    if (cursor) pane.element.dataset['toolCursor'] = cursor;
    else delete pane.element.dataset['toolCursor'];
  }
}

/** Snapshot — drag a rectangle; what is inside it becomes a bitmap. */
export function snapshotTool(lookup: ServiceLookup): ToolSpec {
  let start: { page: number; x: number; y: number; contentX: number; contentY: number } | null =
    null;
  let box: HTMLElement | null = null;

  const clear = (): void => {
    box?.remove();
    box = null;
    start = null;
  };

  return {
    id: SNAPSHOT_TOOL,
    label: 'Snapshot',
    icon: 'camera',
    cursor: 'crosshair',
    activate: () => {
      setCursor(lookup(), 'crosshair');
    },
    deactivate: () => {
      clear();
      setCursor(lookup(), null);
    },
    onPointerDown: (e) => {
      if (e.buttons !== 1) return undefined;
      const viewer = lookup()?.activeViewer();
      if (!viewer) return undefined;
      const point = viewer.pane.toContent(e.original.clientX, e.original.clientY);
      start = { page: e.page, x: e.x, y: e.y, contentX: point.x, contentY: point.y };
      box = el('div.viewer-marquee');
      viewer.pane.content.append(box);
      (e.original.target as Element | null)?.setPointerCapture?.(e.original.pointerId);
      return true;
    },
    onPointerMove: (e) => {
      if (!start || !box) return undefined;
      const viewer = lookup()?.activeViewer();
      if (!viewer) return undefined;
      const now = viewer.pane.toContent(e.original.clientX, e.original.clientY);
      box.style.left = `${Math.min(start.contentX, now.x)}px`;
      box.style.top = `${Math.min(start.contentY, now.y)}px`;
      box.style.width = `${Math.abs(now.x - start.contentX)}px`;
      box.style.height = `${Math.abs(now.y - start.contentY)}px`;
      return true;
    },
    onPointerUp: (e) => {
      if (!start) return undefined;
      const from = start;
      clear();
      (e.original.target as Element | null)?.releasePointerCapture?.(e.original.pointerId);
      const service = lookup();
      if (!service) return true;
      const rect = {
        x0: Math.min(from.x, e.x),
        y0: Math.min(from.y, e.y),
        x1: Math.max(from.x, e.x),
        y1: Math.max(from.y, e.y),
      };
      // A click rather than a drag: nothing to snapshot, and a zero-size PNG helps nobody.
      if (rect.x1 - rect.x0 < 2 || rect.y1 - rect.y0 < 2) return true;
      void service.takeSnapshot(from.page, rect);
      return true;
    },
    onKeyDown: (e) => {
      if (e.key !== 'Escape' || !start) return undefined;
      clear();
      return true;
    },
  };
}

/** Every tool this module contributes. */
export function selectFindTools(lookup: ServiceLookup): ToolSpec[] {
  return [snapshotTool(lookup)];
}

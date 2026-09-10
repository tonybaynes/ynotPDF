/**
 * Pointer and keyboard for the form designer (M60), active only while a form tool is.
 *
 * Like M30's and M50's controllers it listens on the viewer host rather than through a
 * `ToolSpec`, because a drag that leaves the page it began on must keep producing coordinates.
 *
 * Two tools press here. **Select Field** picks up a handle of the selection (resize), a widget
 * (select, then move) or nothing (a marquee). A **placement** tool — one per field type — drags
 * out the new field's rectangle, or clicks for the type's default size. Either way one command
 * lands on release, so a drag is one undo entry.
 *
 * In fill mode this controller is inert: the widget layer's own controls take the pointer, which
 * is what makes a form fill in like a form.
 */

import { isTypingTarget } from '@app/shortcuts';
import type { ShellServices } from '@app/services';
import type { FieldRole } from '@engine/forms/model';
import type { PdfPoint, PdfRect } from '@shared/pdf';
import type { BoxHandle } from '@view/AnnotationLayer';
import type { DocumentView } from '@view/DocumentView';
import { normaliseRect } from './model';
import { PLACE_TOOL_PREFIX, SELECT_TOOL_ID, roleOfTool } from './tools';
import type { FormService } from './FormService';

type Drag =
  | {
      readonly kind: 'move';
      readonly page: number;
      readonly from: PdfPoint;
      to: PdfPoint;
      moved: boolean;
    }
  | {
      readonly kind: 'resize';
      readonly page: number;
      readonly handle: BoxHandle;
      readonly bounds: PdfRect;
      to: PdfRect;
    }
  | {
      readonly kind: 'marquee';
      readonly page: number;
      readonly from: PdfPoint;
      readonly additive: boolean;
    }
  | {
      readonly kind: 'place';
      readonly page: number;
      readonly role: FieldRole;
      readonly from: PdfPoint;
      to: PdfPoint;
    };

export interface FormControllerOptions {
  readonly service: FormService;
  readonly shell: ShellServices;
  readonly host: HTMLElement;
}

const CURSOR_FOR: Readonly<Record<BoxHandle, string>> = {
  nw: 'nwse',
  se: 'nwse',
  ne: 'nesw',
  sw: 'nesw',
  n: 'ns',
  s: 'ns',
  e: 'ew',
  w: 'ew',
};

export class FormController {
  private readonly service: FormService;
  private readonly shell: ShellServices;
  private readonly host: HTMLElement;
  private readonly disposers: Array<() => void> = [];
  private drag: Drag | null = null;
  private hoverFrame = 0;

  constructor(options: FormControllerOptions) {
    this.service = options.service;
    this.shell = options.shell;
    this.host = options.host;
    const down = (e: PointerEvent): void => {
      this.onPointerDown(e);
    };
    const move = (e: PointerEvent): void => {
      this.onPointerMove(e);
    };
    const up = (e: PointerEvent): void => {
      void this.onPointerUp(e);
    };
    const key = (e: KeyboardEvent): void => {
      void this.onKeyDown(e);
    };
    this.host.addEventListener('pointerdown', down, { capture: true });
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('keydown', key, { capture: true });
    this.disposers.push(() => {
      this.host.removeEventListener('pointerdown', down, { capture: true });
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('keydown', key, { capture: true });
    });
  }

  dispose(): void {
    for (const d of this.disposers.splice(0)) d();
  }

  private activeTool(): string | null {
    return this.shell.ui.get().activeTool;
  }

  private designing(): boolean {
    const tool = this.activeTool();
    return tool === SELECT_TOOL_ID || tool?.startsWith(PLACE_TOOL_PREFIX) === true;
  }

  private locate(e: { readonly clientX: number; readonly clientY: number }): {
    pane: DocumentView;
    page: number;
    point: PdfPoint;
  } | null {
    const viewer = this.service.activeViewer();
    if (!viewer) return null;
    for (const pane of viewer.allPanes) {
      const hit = pane.hitTest(e.clientX, e.clientY);
      if (hit) return { pane, page: hit.page, point: { x: hit.x, y: hit.y } };
    }
    return null;
  }

  private setCursor(kind: string | null): void {
    const viewer = this.service.activeViewer();
    if (!viewer) return;
    if (kind) viewer.element.dataset['formDrag'] = kind;
    else delete viewer.element.dataset['formDrag'];
  }

  // ---- pointer ---------------------------------------------------------------------------------

  private onPointerDown(e: PointerEvent): void {
    if (e.button !== 0 || !this.designing()) return;
    const at = this.locate(e);
    if (!at) return;
    const { page, point, pane } = at;
    e.preventDefault();
    e.stopPropagation();

    const role = roleOfTool(this.activeTool());
    if (role) {
      this.drag = { kind: 'place', page, role, from: point, to: point };
      this.setCursor('crosshair');
      return;
    }

    const layer = this.layer();
    const handle = layer?.handleAt(page, point, pane.zoom) ?? null;
    const bounds = layer?.selectionBounds(page) ?? null;
    if (handle && bounds) {
      this.drag = { kind: 'resize', page, handle, bounds, to: bounds };
      this.setCursor(CURSOR_FOR[handle]);
      return;
    }

    const hit = layer?.widgetAt(page, point) ?? null;
    const additive = e.shiftKey || e.ctrlKey || e.metaKey;
    if (!hit) {
      if (!additive) this.service.deselect();
      this.drag = { kind: 'marquee', page, from: point, additive };
      return;
    }
    if (additive) this.service.toggleSelected(hit.key, page);
    else if (!this.service.selection.includes(hit.key)) this.service.select([hit.key], page);
    this.drag = { kind: 'move', page, from: point, to: point, moved: false };
    this.setCursor('move');
  }

  private onPointerMove(e: PointerEvent): void {
    if (!this.designing()) return;
    const at = this.locate(e);
    if (!this.drag) {
      if (!at) {
        this.service.setHover(null, null);
        return;
      }
      if (this.hoverFrame) return;
      this.hoverFrame = requestAnimationFrame(() => {
        this.hoverFrame = 0;
        const hit = this.layer()?.widgetAt(at.page, at.point) ?? null;
        this.service.setHover(at.page, hit?.key ?? null);
      });
      return;
    }
    if (at?.page !== this.drag.page) return;
    switch (this.drag.kind) {
      case 'move':
        this.drag.to = at.point;
        this.drag.moved = true;
        this.showStatus(
          `Move: ${Math.round(at.point.x - this.drag.from.x)}, ${Math.round(at.point.y - this.drag.from.y)} pt`,
        );
        return;
      case 'resize': {
        this.drag.to = resizeBounds(this.drag.bounds, this.drag.handle, at.point);
        const r = this.drag.to;
        this.showStatus(`Size: ${Math.round(r.x1 - r.x0)} × ${Math.round(r.y1 - r.y0)} pt`);
        return;
      }
      case 'place':
        this.drag.to = at.point;
        return;
      case 'marquee':
        this.showStatus('Select fields');
        return;
    }
  }

  private async onPointerUp(e: PointerEvent): Promise<void> {
    const drag = this.drag;
    this.drag = null;
    this.setCursor(null);
    if (!drag) return;
    const at = this.locate(e);
    const point = at?.page === drag.page ? at.point : null;
    switch (drag.kind) {
      case 'move': {
        if (!drag.moved || !point) return;
        const dx = point.x - drag.from.x;
        const dy = point.y - drag.from.y;
        if (dx === 0 && dy === 0) return;
        await this.service.moveSelection(dx, dy);
        return;
      }
      case 'resize': {
        const to = point ? resizeBounds(drag.bounds, drag.handle, point) : drag.to;
        if (to.x1 - to.x0 < 2 || to.y1 - to.y0 < 2) return;
        await this.service.resizeSelection(drag.bounds, to);
        return;
      }
      case 'marquee': {
        if (!point) return;
        const rect = normaliseRect({
          x0: drag.from.x,
          y0: drag.from.y,
          x1: point.x,
          y1: point.y,
        });
        const hits = this.layer()?.widgetsWithin(drag.page, rect) ?? [];
        const keys = hits.map((h) => h.key);
        this.service.select(
          drag.additive ? [...new Set([...this.service.selection, ...keys])] : keys,
          drag.page,
        );
        return;
      }
      case 'place': {
        const end = point ?? drag.to;
        await this.service.createField(
          drag.role,
          drag.page,
          normaliseRect({ x0: drag.from.x, y0: drag.from.y, x1: end.x, y1: end.y }),
        );
        if (!this.service.settings.keepToolSelected) {
          void this.shell.run(`${SELECT_TOOL_ID}.activate`);
        }
        return;
      }
    }
  }

  // ---- keyboard --------------------------------------------------------------------------------

  private async onKeyDown(e: KeyboardEvent): Promise<void> {
    if (!this.designing() || isTypingTarget(e.target)) return;
    if (this.service.selection.length === 0) return;
    const step = e.shiftKey ? this.service.settings.nudge * 10 : this.service.settings.nudge;
    switch (e.key) {
      case 'ArrowLeft':
      case 'ArrowRight':
      case 'ArrowUp':
      case 'ArrowDown': {
        e.preventDefault();
        const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
        const dy = e.key === 'ArrowDown' ? -step : e.key === 'ArrowUp' ? step : 0;
        await this.service.moveSelection(dx, dy);
        return;
      }
      case 'Delete':
      case 'Backspace':
        e.preventDefault();
        await this.service.deleteSelection();
        return;
      case 'Escape':
        e.preventDefault();
        this.service.deselect();
        return;
      default:
        return;
    }
  }

  private layer(): ReturnType<FormService['layerFor']> {
    const tabId = this.service.activeTabId();
    return tabId ? this.service.layerFor(tabId) : null;
  }

  private showStatus(text: string): void {
    const viewer = this.service.activeViewer();
    if (viewer) viewer.element.dataset['formStatus'] = text;
  }
}

/** The bounding box a handle drag produces. Never inverts: the box stays at least 2 pt each way. */
export function resizeBounds(bounds: PdfRect, handle: BoxHandle, to: PdfPoint): PdfRect {
  const west = handle.includes('w');
  const east = handle.includes('e');
  const north = handle.startsWith('n');
  const south = handle.startsWith('s');
  const next = {
    x0: west ? to.x : bounds.x0,
    x1: east ? to.x : bounds.x1,
    y0: south ? to.y : bounds.y0,
    y1: north ? to.y : bounds.y1,
  };
  const r = normaliseRect(next);
  return {
    x0: r.x0,
    y0: r.y0,
    x1: Math.max(r.x1, r.x0 + 2),
    y1: Math.max(r.y1, r.y0 + 2),
  };
}

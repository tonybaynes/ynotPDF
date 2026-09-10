/**
 * Pointer and keyboard for page objects (M50), active only while an Edit Object tool is.
 *
 * Like M30's controller it listens on the viewer host rather than through a `ToolSpec`, because
 * a drag that leaves the page it began on must keep producing coordinates. A press picks up a
 * handle of the selection (resize or rotate), an object (select, then move), or nothing (a
 * marquee). During a drag only the overlay moves — a dashed ghost of the selection's bounds,
 * plus the smart guides a snap found — and one command lands on release, so a drag is one undo
 * entry and the raster is re-rendered once.
 */

import { isTypingTarget } from '@app/shortcuts';
import type { ShellServices } from '@app/services';
import { multiply, rotation, translation } from '@engine/content/matrix';
import type { PdfMatrix, PdfPoint, PdfRect } from '@shared/pdf';
import type { BoxHandle } from '@view/AnnotationLayer';
import type { DocumentView } from '@view/DocumentView';
import { applyToRect } from '@engine/content/matrix';
import { isObjectTool, type ObjectService } from './ObjectService';
import { resizeMatrix } from './geometry';

type Drag =
  | {
      readonly kind: 'move';
      readonly page: number;
      readonly from: PdfPoint;
      readonly bounds: PdfRect;
      matrix: PdfMatrix;
      moved: boolean;
    }
  | {
      readonly kind: 'resize';
      readonly page: number;
      readonly handle: BoxHandle;
      readonly bounds: PdfRect;
      matrix: PdfMatrix;
    }
  | {
      readonly kind: 'rotate';
      readonly page: number;
      readonly bounds: PdfRect;
      readonly centre: PdfPoint;
      readonly start: number;
      matrix: PdfMatrix;
      degrees: number;
    }
  | {
      readonly kind: 'marquee';
      readonly page: number;
      readonly from: PdfPoint;
      readonly additive: boolean;
    };

export interface ObjectControllerOptions {
  readonly service: ObjectService;
  readonly shell: ShellServices;
  readonly host: HTMLElement;
}

const CURSOR_FOR: Record<BoxHandle, string> = {
  nw: 'nwse',
  se: 'nwse',
  ne: 'nesw',
  sw: 'nesw',
  n: 'ns',
  s: 'ns',
  e: 'ew',
  w: 'ew',
};

export class ObjectController {
  private readonly service: ObjectService;
  private readonly shell: ShellServices;
  private readonly host: HTMLElement;
  private readonly disposers: Array<() => void> = [];
  private drag: Drag | null = null;
  private hoverFrame = 0;

  constructor(options: ObjectControllerOptions) {
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
      this.onPointerUp(e);
    };
    const key = (e: KeyboardEvent): void => {
      this.onKeyDown(e);
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

  private active(): boolean {
    return isObjectTool(this.shell.ui.get().activeTool);
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
    if (kind) viewer.element.dataset['objectDrag'] = kind;
    else delete viewer.element.dataset['objectDrag'];
  }

  // ---- pointer ----------------------------------------------------------------------------------

  private onPointerDown(e: PointerEvent): void {
    if (e.button !== 0 || !this.active()) return;
    const at = this.locate(e);
    if (!at) return;
    const { page, point, pane } = at;
    void this.service.ensurePage(page);
    e.preventDefault();
    e.stopPropagation();
    this.service.clearHover();

    const handle =
      this.service.selectionPage === page ? this.service.handleAt(page, point, pane.zoom) : null;
    const bounds = this.service.selectionBounds();
    if (handle && bounds) {
      if (handle === 'rotate') {
        const centre = { x: (bounds.x0 + bounds.x1) / 2, y: (bounds.y0 + bounds.y1) / 2 };
        this.drag = {
          kind: 'rotate',
          page,
          bounds,
          centre,
          start: Math.atan2(point.y - centre.y, point.x - centre.x),
          matrix: [1, 0, 0, 1, 0, 0],
          degrees: 0,
        };
        this.setCursor('rotate');
      } else {
        this.drag = { kind: 'resize', page, handle, bounds, matrix: [1, 0, 0, 1, 0, 0] };
        this.setCursor(CURSOR_FOR[handle]);
      }
      return;
    }

    const additive = e.shiftKey || e.ctrlKey || e.metaKey;
    void this.service.selectAt(page, point, additive).then((hit) => {
      if (!hit) {
        this.drag = { kind: 'marquee', page, from: point, additive };
        return;
      }
      const b = this.service.selectionBounds();
      if (!b || this.service.selectionPage !== page) return;
      this.drag = {
        kind: 'move',
        page,
        from: point,
        bounds: b,
        matrix: [1, 0, 0, 1, 0, 0],
        moved: false,
      };
      this.setCursor('move');
    });
  }

  private onPointerMove(e: PointerEvent): void {
    if (!this.active()) return;
    const at = this.locate(e);
    if (!this.drag) {
      if (!at) {
        this.service.clearHover();
        return;
      }
      if (this.hoverFrame) return;
      this.hoverFrame = requestAnimationFrame(() => {
        this.hoverFrame = 0;
        void this.service.hover(at.page, at.point);
      });
      return;
    }
    if (at?.page !== this.drag.page) return;
    const point = at.point;
    switch (this.drag.kind) {
      case 'move': {
        const raw = translation(point.x - this.drag.from.x, point.y - this.drag.from.y);
        const moved = applyToRect(raw, this.drag.bounds);
        const snap = e.altKey
          ? { dx: 0, dy: 0, guides: [] }
          : this.service.snapFor(this.drag.page, moved);
        this.drag.matrix = translation(raw[4] + snap.dx, raw[5] + snap.dy);
        this.drag.moved = true;
        this.service.setPreview(this.drag.page, this.drag.matrix);
        this.service.setGuides(this.drag.page, snap.guides);
        this.service.showStatus(
          snap.guides.length > 0
            ? `Snapped to: ${[...new Set(snap.guides.map((g) => g.label))].join(', ')}`
            : `Move: ${Math.round(this.drag.matrix[4])}, ${Math.round(this.drag.matrix[5])} pt`,
        );
        return;
      }
      case 'resize': {
        this.drag.matrix = resizeMatrix(this.drag.bounds, this.drag.handle, point, e.shiftKey);
        this.service.setPreview(this.drag.page, this.drag.matrix);
        const r = applyToRect(this.drag.matrix, this.drag.bounds);
        this.service.showStatus(`Size: ${Math.round(r.x1 - r.x0)} × ${Math.round(r.y1 - r.y0)} pt`);
        return;
      }
      case 'rotate': {
        const angle = Math.atan2(point.y - this.drag.centre.y, point.x - this.drag.centre.x);
        let degrees = ((angle - this.drag.start) * 180) / Math.PI;
        if (e.shiftKey) degrees = Math.round(degrees / 15) * 15;
        this.drag.degrees = degrees;
        this.drag.matrix = rotation(degrees, this.drag.centre);
        this.service.setPreview(this.drag.page, this.drag.matrix);
        this.service.showStatus(`Rotate: ${Math.round(degrees)}°`);
        return;
      }
      case 'marquee': {
        this.service.setMarquee({
          page: this.drag.page,
          rect: {
            x0: Math.min(this.drag.from.x, point.x),
            y0: Math.min(this.drag.from.y, point.y),
            x1: Math.max(this.drag.from.x, point.x),
            y1: Math.max(this.drag.from.y, point.y),
          },
        });
        return;
      }
    }
  }

  private onPointerUp(e: PointerEvent): void {
    const drag = this.drag;
    if (!drag) return;
    this.drag = null;
    this.setCursor(null);
    this.service.setPreview(drag.page, null);
    this.service.clearGuides();
    this.service.showStatus(null);
    switch (drag.kind) {
      case 'move':
        if (drag.moved && (drag.matrix[4] !== 0 || drag.matrix[5] !== 0)) {
          void this.service.transform(drag.matrix, 'Move object');
        }
        return;
      case 'resize':
        if (!isIdentityish(drag.matrix)) void this.service.transform(drag.matrix, 'Resize object');
        return;
      case 'rotate':
        if (Math.abs(drag.degrees) > 0.01)
          void this.service.transform(drag.matrix, 'Rotate object');
        return;
      case 'marquee': {
        this.service.setMarquee(null);
        const at = this.locate(e);
        const to = at?.page === drag.page ? at.point : drag.from;
        const rect: PdfRect = {
          x0: Math.min(drag.from.x, to.x),
          y0: Math.min(drag.from.y, to.y),
          x1: Math.max(drag.from.x, to.x),
          y1: Math.max(drag.from.y, to.y),
        };
        if (rect.x1 - rect.x0 < 2 && rect.y1 - rect.y0 < 2) {
          if (!drag.additive) this.service.deselect();
          return;
        }
        this.service.selectWithin(drag.page, rect, drag.additive);
        return;
      }
    }
  }

  // ---- keyboard ----------------------------------------------------------------------------------

  private onKeyDown(e: KeyboardEvent): void {
    if (!this.active() || isTypingTarget(e.target)) return;
    if (this.service.selection.length === 0) return;
    const step = this.service.settings.nudge * (e.shiftKey ? 10 : 1);
    switch (e.key) {
      case 'ArrowLeft':
        void this.service.nudge(-step, 0);
        break;
      case 'ArrowRight':
        void this.service.nudge(step, 0);
        break;
      case 'ArrowUp':
        void this.service.nudge(0, step);
        break;
      case 'ArrowDown':
        void this.service.nudge(0, -step);
        break;
      case 'Delete':
      case 'Backspace':
        void this.service.remove();
        break;
      case 'Escape':
        this.service.deselect();
        break;
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation();
  }
}

function isIdentityish(m: PdfMatrix): boolean {
  const id: PdfMatrix = [1, 0, 0, 1, 0, 0];
  return m.every((v, i) => Math.abs(v - (id[i] ?? 0)) < 1e-9);
}

export { multiply as composeMatrices };

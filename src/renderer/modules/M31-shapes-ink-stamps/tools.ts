/**
 * M31's tools (`ToolSpec`s): the shapes, the pencil, the eraser, the stamp and the attachment.
 *
 * Each owns the pointer while it is active — M30's controller stands aside for a creation tool
 * — and turns a gesture into one call on `DrawingService`. Three kinds of gesture:
 *
 * - **drag a box**: rectangle, ellipse, area highlight, and a stamp sized by hand;
 * - **drag a line**: line and arrow;
 * - **click the corners**: polygon, polyline and cloud, finished with a double-click, Enter or a
 *   click on the first corner, abandoned with Escape;
 * - **draw**: the pencil, one stroke per press; the eraser, rubbing.
 *
 * Every point goes through `Viewer.snap()` first (M11's grid flag) and then, with Shift held,
 * through the constraint the tool has — a square, a round ellipse, a 45° line, an axis-aligned
 * polygon edge. The preview while the gesture is in flight is SVG in the page's annotation layer,
 * themed like the selection marquee, and gone the moment the gesture ends.
 */

import type { PdfPoint } from '@shared/pdf';
import type { ToolPointerEvent, ToolSpec } from '@shared/module';
import type { PageView } from '@view/PageView';
import type { DrawingService, ShapeToolId } from './DrawingService';
import { constrainAngle, constrainBox, rectBetween, samePoint } from './geometry';

/** How a tool reaches the live service (the shell hands tools to the Registry before it exists). */
export type ServiceLookup = () => DrawingService | null;

export const TOOL_ID = {
  rectangle: 'tool.rectangle',
  ellipse: 'tool.ellipse',
  line: 'tool.line',
  arrow: 'tool.arrow',
  polygon: 'tool.polygon',
  polyline: 'tool.polyline',
  cloud: 'tool.cloud',
  areaHighlight: 'tool.areaHighlight',
  pencil: 'tool.pencil',
  eraser: 'tool.eraser',
  stamp: 'tool.stamp',
  attachFile: 'tool.attachFile',
} as const;

/** Every tool here creates something (or, for the eraser, changes it), so the controller keeps out. */
export const DRAWING_TOOL_IDS: ReadonlySet<string> = new Set(Object.values(TOOL_ID));

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Minimum drag, in points, before a press is a shape rather than a click. */
const DRAG_THRESHOLD = 3;

function setCursor(service: DrawingService | null, cursor: string | null): void {
  const viewer = service?.annotationService.activeViewer();
  if (!viewer) return;
  for (const pane of viewer.allPanes) {
    if (cursor) pane.element.dataset['toolCursor'] = cursor;
    else delete pane.element.dataset['toolCursor'];
  }
}

/** The page view of the active viewer for a page, when it is mounted. */
function pageViewOf(service: DrawingService | null, page: number): PageView | null {
  const viewer = service?.annotationService.activeViewer();
  if (!viewer) return null;
  for (const pane of viewer.allPanes) {
    const view = pane.pageView(page);
    if (view) return view;
  }
  return null;
}

/** A page point, snapped to the grid and the guides when M11 says so. */
function snapped(service: DrawingService | null, e: ToolPointerEvent): PdfPoint {
  const viewer = service?.annotationService.activeViewer();
  const point = { x: e.x, y: e.y };
  return viewer ? viewer.snap(e.page, point) : point;
}

// ---- the preview ---------------------------------------------------------------------------------

/** An SVG element in a page's annotation layer, kept until the gesture ends. */
class Preview {
  private element: SVGElement | null = null;
  private view: PageView | null = null;

  show(view: PageView, tag: 'path' | 'circle', className: string): SVGElement {
    if (!this.element || this.view !== view || this.element.tagName !== tag) {
      this.clear();
      this.element = document.createElementNS(SVG_NS, tag);
      this.element.setAttribute('class', className);
      this.view = view;
    }
    // The layer repaints by replacing its children; a preview that fell out goes back in.
    if (!this.element.isConnected) view.layers.annot.append(this.element);
    return this.element;
  }

  clear(): void {
    this.element?.remove();
    this.element = null;
    this.view = null;
  }
}

/** An SVG path `d` for page points, through the page's transform. */
function pathData(view: PageView, points: ReadonlyArray<PdfPoint>, close = false): string {
  const parts = points.map((p, i) => {
    const d = view.transform.toDevice(p);
    return `${i === 0 ? 'M' : 'L'}${d.x.toFixed(2)} ${d.y.toFixed(2)}`;
  });
  return parts.join(' ') + (close ? ' Z' : '');
}

function rectPath(view: PageView, a: PdfPoint, b: PdfPoint): string {
  const r = rectBetween(a, b);
  return pathData(
    view,
    [
      { x: r.x0, y: r.y0 },
      { x: r.x1, y: r.y0 },
      { x: r.x1, y: r.y1 },
      { x: r.x0, y: r.y1 },
    ],
    true,
  );
}

function ellipsePath(view: PageView, a: PdfPoint, b: PdfPoint): string {
  const r = rectBetween(a, b);
  const cx = (r.x0 + r.x1) / 2;
  const cy = (r.y0 + r.y1) / 2;
  const rx = (r.x1 - r.x0) / 2;
  const ry = (r.y1 - r.y0) / 2;
  const points: PdfPoint[] = [];
  for (let i = 0; i < 48; i++) {
    const t = (i / 48) * Math.PI * 2;
    points.push({ x: cx + rx * Math.cos(t), y: cy + ry * Math.sin(t) });
  }
  return pathData(view, points, true);
}

// ---- drag-a-box and drag-a-line tools -------------------------------------------------------------

interface DragState {
  page: number;
  from: PdfPoint;
  to: PdfPoint;
}

/** Rectangle, ellipse, area highlight, line, arrow: press, drag, release. */
function dragTool(
  lookup: ServiceLookup,
  spec: {
    readonly id: string;
    readonly tool: ShapeToolId;
    readonly label: string;
    readonly icon: string;
    readonly kind: 'box' | 'ellipse' | 'line';
  },
): ToolSpec {
  let drag: DragState | null = null;
  const preview = new Preview();
  const clear = (): void => {
    preview.clear();
    drag = null;
  };
  const pointOf = (e: ToolPointerEvent, from: PdfPoint): PdfPoint => {
    const raw = snapped(lookup(), e);
    if (!e.shiftKey) return raw;
    return spec.kind === 'line' ? constrainAngle(from, raw) : constrainBox(from, raw);
  };
  const paint = (): void => {
    const view = drag ? pageViewOf(lookup(), drag.page) : null;
    if (!drag || !view) return;
    const el = preview.show(
      view,
      'path',
      spec.tool === 'areaHighlight' ? 'draw-preview-fill' : 'draw-preview',
    );
    const d =
      spec.kind === 'line'
        ? pathData(view, [drag.from, drag.to])
        : spec.kind === 'ellipse'
          ? ellipsePath(view, drag.from, drag.to)
          : rectPath(view, drag.from, drag.to);
    el.setAttribute('d', d);
  };
  return {
    id: spec.id,
    label: spec.label,
    icon: spec.icon,
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
      const from = snapped(lookup(), e);
      drag = { page: e.page, from, to: from };
      (e.original.target as Element | null)?.setPointerCapture?.(e.original.pointerId);
      return true;
    },
    onPointerMove: (e) => {
      if (!drag) return undefined;
      drag.to = pointOf(e, drag.from);
      paint();
      return true;
    },
    onPointerUp: (e) => {
      const started = drag;
      if (!started) return undefined;
      (e.original.target as Element | null)?.releasePointerCapture?.(e.original.pointerId);
      const to = pointOf(e, started.from);
      clear();
      const service = lookup();
      if (!service) return true;
      const moved =
        Math.abs(to.x - started.from.x) >= DRAG_THRESHOLD ||
        Math.abs(to.y - started.from.y) >= DRAG_THRESHOLD;
      if (spec.kind === 'line') {
        if (!moved) return true;
        void service.createShape(spec.tool, started.page, { vertices: [started.from, to] });
        return true;
      }
      // A click makes a default-sized shape, as Foxit does, so nothing is lost on a slip.
      const rect = moved
        ? rectBetween(started.from, to)
        : {
            x0: started.from.x,
            y0: started.from.y - 60,
            x1: started.from.x + 100,
            y1: started.from.y,
          };
      void service.createShape(spec.tool, started.page, { rect });
      return true;
    },
    onKeyDown: (e) => {
      if (e.key !== 'Escape' || !drag) return undefined;
      clear();
      return true;
    },
  };
}

// ---- click-the-corners tools --------------------------------------------------------------------

interface CornersState {
  page: number;
  points: PdfPoint[];
  hover: PdfPoint | null;
  lastClickAt: number;
}

/** Polygon, polyline, cloud: a click per corner; double-click, Enter or the first corner finish. */
function cornersTool(
  lookup: ServiceLookup,
  spec: {
    readonly id: string;
    readonly tool: ShapeToolId;
    readonly label: string;
    readonly icon: string;
    readonly closed: boolean;
  },
): ToolSpec {
  let state: CornersState | null = null;
  const preview = new Preview();
  const dots = new Preview();
  const clear = (): void => {
    preview.clear();
    dots.clear();
    state = null;
  };
  const paint = (): void => {
    const view = state ? pageViewOf(lookup(), state.page) : null;
    if (!state || !view) return;
    const points = state.hover ? [...state.points, state.hover] : state.points;
    preview
      .show(view, 'path', 'draw-preview')
      .setAttribute('d', pathData(view, points, spec.closed));
    const first = state.points[0];
    if (first) {
      const d = view.transform.toDevice(first);
      const dot = dots.show(view, 'circle', 'draw-vertex-dot');
      dot.setAttribute('cx', d.x.toFixed(2));
      dot.setAttribute('cy', d.y.toFixed(2));
      dot.setAttribute('r', '4');
    }
  };
  const finish = (): void => {
    const done = state;
    clear();
    const service = lookup();
    if (!done || !service) return;
    const minimum = spec.closed ? 3 : 2;
    if (done.points.length < minimum) return;
    void service.createShape(spec.tool, done.page, { vertices: done.points });
  };
  const constrained = (e: ToolPointerEvent): PdfPoint => {
    const raw = snapped(lookup(), e);
    const last = state?.points[state.points.length - 1];
    return e.shiftKey && last ? constrainAngle(last, raw) : raw;
  };
  return {
    id: spec.id,
    label: spec.label,
    icon: spec.icon,
    cursor: 'crosshair',
    activate: () => {
      setCursor(lookup(), 'crosshair');
    },
    deactivate: () => {
      finish();
      setCursor(lookup(), null);
    },
    onPointerDown: (e) => {
      if (e.buttons !== 1) return undefined;
      const now = performance.now();
      const point = constrained(e);
      if (state && state.page !== e.page) finish();
      if (!state) {
        state = { page: e.page, points: [point], hover: null, lastClickAt: now };
        paint();
        return true;
      }
      const first = state.points[0];
      const last = state.points[state.points.length - 1];
      const scale = pageViewOf(lookup(), e.page)?.transform.scale ?? 1;
      const tolerance = 6 / Math.max(scale, 1e-6);
      // Clicking the first corner closes a polygon; a double-click ends either kind.
      if (first && spec.closed && state.points.length >= 3 && samePoint(point, first, tolerance)) {
        finish();
        return true;
      }
      if (last && (samePoint(point, last, tolerance) || now - state.lastClickAt < 350)) {
        finish();
        return true;
      }
      state.points.push(point);
      state.lastClickAt = now;
      paint();
      return true;
    },
    onPointerMove: (e) => {
      if (state?.page !== e.page) return undefined;
      state.hover = constrained(e);
      paint();
      return true;
    },
    onKeyDown: (e) => {
      if (!state) return undefined;
      if (e.key === 'Escape') {
        clear();
        return true;
      }
      if (e.key === 'Enter') {
        finish();
        return true;
      }
      if (e.key === 'Backspace' && state.points.length > 1) {
        state.points.pop();
        paint();
        return true;
      }
      return undefined;
    },
  };
}

// ---- the pencil and the eraser ------------------------------------------------------------------

interface StrokeState {
  page: number;
  points: PdfPoint[];
  pressures: number[];
  pen: boolean;
}

/** The pencil: one stroke per press, smoothed by the service; a pen's pressure is kept. */
function pencilTool(lookup: ServiceLookup): ToolSpec {
  let stroke: StrokeState | null = null;
  let groupTimer: ReturnType<typeof setTimeout> | null = null;
  const preview = new Preview();
  const armGroupEnd = (): void => {
    if (groupTimer) clearTimeout(groupTimer);
    const service = lookup();
    groupTimer = setTimeout(
      () => {
        groupTimer = null;
        lookup()?.endInkGroup();
      },
      service ? service.settings.inkGroupMs : 1500,
    );
  };
  const paint = (): void => {
    const view = stroke ? pageViewOf(lookup(), stroke.page) : null;
    if (!stroke || !view) return;
    preview.show(view, 'path', 'draw-preview').setAttribute('d', pathData(view, stroke.points));
  };
  return {
    id: TOOL_ID.pencil,
    label: 'Pencil',
    icon: 'pencil',
    cursor: 'crosshair',
    activate: () => {
      setCursor(lookup(), 'crosshair');
    },
    deactivate: () => {
      preview.clear();
      stroke = null;
      if (groupTimer) clearTimeout(groupTimer);
      groupTimer = null;
      lookup()?.endInkGroup();
      setCursor(lookup(), null);
    },
    onPointerDown: (e) => {
      if (e.buttons !== 1) return undefined;
      if (groupTimer) clearTimeout(groupTimer);
      groupTimer = null;
      const pen = e.original.pointerType === 'pen';
      stroke = {
        page: e.page,
        points: [{ x: e.x, y: e.y }],
        pressures: [pen ? e.original.pressure : 0.5],
        pen,
      };
      (e.original.target as Element | null)?.setPointerCapture?.(e.original.pointerId);
      return true;
    },
    onPointerMove: (e) => {
      if (!stroke) return undefined;
      const last = stroke.points[stroke.points.length - 1];
      // Dense enough to be faithful, sparse enough that a stroke is hundreds of points, not
      // thousands: a new point every half a point of travel.
      if (last && Math.hypot(e.x - last.x, e.y - last.y) < 0.5) return true;
      stroke.points.push({ x: e.x, y: e.y });
      stroke.pressures.push(stroke.pen ? e.original.pressure : 0.5);
      paint();
      return true;
    },
    onPointerUp: (e) => {
      const done = stroke;
      if (!done) return undefined;
      (e.original.target as Element | null)?.releasePointerCapture?.(e.original.pointerId);
      preview.clear();
      stroke = null;
      const service = lookup();
      if (!service) return true;
      void service.addInkStroke(done.page, done.points, done.pen ? done.pressures : null);
      armGroupEnd();
      return true;
    },
  };
}

/** The eraser: rubbing over strokes cuts or removes them, as the setting says. */
function eraserTool(lookup: ServiceLookup): ToolSpec {
  let rubbing: { page: number; last: PdfPoint } | null = null;
  const cursor = new Preview();
  const paintCursor = (page: number, at: PdfPoint): void => {
    const service = lookup();
    const view = pageViewOf(service, page);
    if (!service || !view) return;
    const d = view.transform.toDevice(at);
    const el = cursor.show(view, 'circle', 'draw-eraser');
    el.setAttribute('cx', d.x.toFixed(2));
    el.setAttribute('cy', d.y.toFixed(2));
    el.setAttribute('r', (service.settings.eraserRadius * view.transform.scale).toFixed(2));
  };
  return {
    id: TOOL_ID.eraser,
    label: 'Eraser',
    icon: 'eraser',
    cursor: 'crosshair',
    activate: () => {
      setCursor(lookup(), 'crosshair');
    },
    deactivate: () => {
      cursor.clear();
      rubbing = null;
      setCursor(lookup(), null);
    },
    onPointerDown: (e) => {
      if (e.buttons !== 1) return undefined;
      const at = { x: e.x, y: e.y };
      rubbing = { page: e.page, last: at };
      paintCursor(e.page, at);
      void lookup()?.erase(e.page, at);
      (e.original.target as Element | null)?.setPointerCapture?.(e.original.pointerId);
      return true;
    },
    onPointerMove: (e) => {
      const at = { x: e.x, y: e.y };
      paintCursor(e.page, at);
      if (rubbing?.page !== e.page) return true;
      const service = lookup();
      if (!service) return true;
      // One pass per half-radius of travel: enough to cut every stroke the rub crosses.
      if (
        Math.hypot(at.x - rubbing.last.x, at.y - rubbing.last.y) <
        service.settings.eraserRadius / 2
      ) {
        return true;
      }
      rubbing.last = at;
      void service.erase(e.page, at);
      return true;
    },
    onPointerUp: (e) => {
      if (!rubbing) return undefined;
      (e.original.target as Element | null)?.releasePointerCapture?.(e.original.pointerId);
      rubbing = null;
      lookup()?.annotationService.activeDocument()?.breakMerge();
      return true;
    },
  };
}

// ---- stamps and attachments ------------------------------------------------------------------

/** The stamp tool: a click places the current stamp; a drag places it fitted into the box. */
function stampTool(lookup: ServiceLookup): ToolSpec {
  let drag: DragState | null = null;
  const preview = new Preview();
  const clear = (): void => {
    preview.clear();
    drag = null;
  };
  return {
    id: TOOL_ID.stamp,
    label: 'Stamp',
    icon: 'stamp',
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
      const from = snapped(lookup(), e);
      drag = { page: e.page, from, to: from };
      (e.original.target as Element | null)?.setPointerCapture?.(e.original.pointerId);
      return true;
    },
    onPointerMove: (e) => {
      if (!drag) return undefined;
      drag.to = snapped(lookup(), e);
      const view = pageViewOf(lookup(), drag.page);
      if (view) {
        preview
          .show(view, 'path', 'draw-preview')
          .setAttribute('d', rectPath(view, drag.from, drag.to));
      }
      return true;
    },
    onPointerUp: (e) => {
      const started = drag;
      if (!started) return undefined;
      (e.original.target as Element | null)?.releasePointerCapture?.(e.original.pointerId);
      const to = snapped(lookup(), e);
      clear();
      const service = lookup();
      if (!service) return true;
      const stampId = service.defaults('stamp').stampId;
      const moved =
        Math.abs(to.x - started.from.x) >= DRAG_THRESHOLD * 3 &&
        Math.abs(to.y - started.from.y) >= DRAG_THRESHOLD * 3;
      void service.placeStamp(
        stampId,
        started.page,
        moved ? rectBetween(started.from, to) : started.from,
      );
      return true;
    },
    onKeyDown: (e) => {
      if (e.key !== 'Escape' || !drag) return undefined;
      clear();
      return true;
    },
  };
}

/** Attach File: a click asks for a file and pins it where the page was clicked. */
function attachFileTool(lookup: ServiceLookup): ToolSpec {
  return {
    id: TOOL_ID.attachFile,
    label: 'Attach File',
    icon: 'paperclip',
    cursor: 'crosshair',
    activate: () => {
      setCursor(lookup(), 'crosshair');
    },
    deactivate: () => {
      setCursor(lookup(), null);
    },
    onPointerDown: (e) => {
      if (e.buttons !== 1) return undefined;
      const service = lookup();
      if (!service) return undefined;
      void service.attachFile(e.page, snapped(service, e));
      return true;
    },
  };
}

/** Every tool this module contributes. */
export function drawingTools(lookup: ServiceLookup): ToolSpec[] {
  return [
    dragTool(lookup, {
      id: TOOL_ID.rectangle,
      tool: 'rectangle',
      label: 'Rectangle',
      icon: 'square',
      kind: 'box',
    }),
    dragTool(lookup, {
      id: TOOL_ID.ellipse,
      tool: 'ellipse',
      label: 'Oval',
      icon: 'circle',
      kind: 'ellipse',
    }),
    dragTool(lookup, {
      id: TOOL_ID.line,
      tool: 'line',
      label: 'Line',
      icon: 'minus',
      kind: 'line',
    }),
    dragTool(lookup, {
      id: TOOL_ID.arrow,
      tool: 'arrow',
      label: 'Arrow',
      icon: 'move-up-right',
      kind: 'line',
    }),
    cornersTool(lookup, {
      id: TOOL_ID.polygon,
      tool: 'polygon',
      label: 'Polygon',
      icon: 'pentagon',
      closed: true,
    }),
    cornersTool(lookup, {
      id: TOOL_ID.polyline,
      tool: 'polyline',
      label: 'Polyline',
      icon: 'spline',
      closed: false,
    }),
    cornersTool(lookup, {
      id: TOOL_ID.cloud,
      tool: 'cloud',
      label: 'Cloud',
      icon: 'cloud',
      closed: true,
    }),
    dragTool(lookup, {
      id: TOOL_ID.areaHighlight,
      tool: 'areaHighlight',
      label: 'Area Highlight',
      icon: 'square-dashed',
      kind: 'box',
    }),
    pencilTool(lookup),
    eraserTool(lookup),
    stampTool(lookup),
    attachFileTool(lookup),
  ];
}

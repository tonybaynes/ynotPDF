/**
 * M33's tools: Distance, Perimeter, Area and Calibrate.
 *
 * Each owns the pointer while it is active — M30's controller stands aside for a creation tool —
 * and turns a gesture into one call on `MeasureService`. Two gestures:
 *
 * - **drag a line**: distance and calibrate. Press, drag, release; Shift keeps it to 45°.
 * - **click the corners**: perimeter and area. A click per corner, finished with a double-click,
 *   Enter or (for an area) a click on the first corner; Backspace takes one back, Escape
 *   abandons.
 *
 * Every point goes through the snapper first, and the point that comes back is marked on the page
 * with an opaque indicator whose shape says what kind of point it is — and whose accessible name
 * says so in words, because four shapes are not something the operator can tell apart.
 *
 * The preview while a gesture is in flight is SVG in the page's annotation layer, themed like the
 * selection marquee, and gone the moment the gesture ends. It carries the live value as text, so
 * the number is where the reader is looking rather than only in the panel.
 */

import type { PdfPoint } from '@shared/pdf';
import type { ToolPointerEvent, ToolSpec } from '@shared/module';
import type { PageView } from '@view/PageView';
import { constrainAngle, samePoint } from './geometry';
import type { MeasureService, MeasuringToolId } from './MeasureService';

/** How a tool reaches the live service (the shell hands tools to the Registry before it exists). */
export type ServiceLookup = () => MeasureService | null;

export const TOOL_ID = {
  distance: 'tool.measureDistance',
  perimeter: 'tool.measurePerimeter',
  area: 'tool.measureArea',
  calibrate: 'tool.calibrate',
} as const;

/** Every tool here creates or calibrates, so M30's controller keeps out while one is active. */
export const MEASURE_TOOL_IDS: ReadonlySet<string> = new Set(Object.values(TOOL_ID));

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Minimum drag, in points, before a press is a measurement rather than a click. */
const DRAG_THRESHOLD = 3;

function setCursor(service: MeasureService | null, cursor: string | null): void {
  const viewer = service?.annotationService.activeViewer();
  if (!viewer) return;
  for (const pane of viewer.allPanes) {
    if (cursor) pane.element.dataset['toolCursor'] = cursor;
    else delete pane.element.dataset['toolCursor'];
  }
}

/**
 * Gives the page area the keyboard focus a gesture would otherwise have taken from it — the same
 * reason M31's tools do it: a prevented `pointerdown` never moves the focus, and the scroller is
 * where a tool's keys are heard.
 */
function focusPage(service: MeasureService | null): void {
  const viewer = service?.annotationService.activeViewer();
  viewer?.pane.scroller.focus({ preventScroll: true });
}

/** The page view of the active viewer for a page, when it is mounted. */
function pageViewOf(service: MeasureService | null, page: number): PageView | null {
  const viewer = service?.annotationService.activeViewer();
  if (!viewer) return null;
  for (const pane of viewer.allPanes) {
    const view = pane.pageView(page);
    if (view) return view;
  }
  return null;
}

/** A page point: through M11's grid snap, then through M33's own snap to what is drawn. */
function snapped(service: MeasureService | null, e: ToolPointerEvent): PdfPoint {
  const viewer = service?.annotationService.activeViewer();
  const raw = { x: e.x, y: e.y };
  const gridded = viewer ? viewer.snap(e.page, raw) : raw;
  if (!service) return gridded;
  const scale = pageViewOf(service, e.page)?.transform.scale ?? 1;
  return service.snap(e.page, gridded, scale);
}

// ---- the preview ---------------------------------------------------------------------------------

/** A group of SVG elements in a page's annotation layer, kept until the gesture ends. */
class Preview {
  private group: SVGGElement | null = null;
  private view: PageView | null = null;

  /** The group, mounted in `view`'s annotation layer and emptied ready to be filled. */
  open(view: PageView): SVGGElement {
    if (!this.group || this.view !== view) {
      this.clear();
      this.group = document.createElementNS(SVG_NS, 'g');
      this.group.setAttribute('class', 'measure-preview');
      this.view = view;
    }
    // The layer repaints by replacing its children; a preview that fell out goes back in.
    if (!this.group.isConnected) view.layers.annot.append(this.group);
    this.group.replaceChildren();
    return this.group;
  }

  clear(): void {
    this.group?.remove();
    this.group = null;
    this.view = null;
  }
}

function pathElement(view: PageView, points: ReadonlyArray<PdfPoint>, close: boolean): SVGElement {
  const parts = points.map((p, i) => {
    const d = view.transform.toDevice(p);
    return `${i === 0 ? 'M' : 'L'}${d.x.toFixed(2)} ${d.y.toFixed(2)}`;
  });
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('class', 'measure-preview-path');
  path.setAttribute('d', parts.join(' ') + (close ? ' Z' : ''));
  return path;
}

/** The value, drawn beside the gesture so it is where the reader is looking. */
function labelElement(view: PageView, at: PdfPoint, text: string): SVGElement {
  const d = view.transform.toDevice(at);
  const label = document.createElementNS(SVG_NS, 'text');
  label.setAttribute('class', 'measure-preview-label');
  label.setAttribute('x', (d.x + 10).toFixed(2));
  label.setAttribute('y', (d.y - 10).toFixed(2));
  label.textContent = text;
  return label;
}

/**
 * The snap marker: a shape per kind, and the kind in words as its accessible name.
 *
 * Fully opaque, as every overlay in this app is; the shapes differ in outline as well as in
 * lightness, so which one it is does not rest on colour.
 */
function snapMarker(view: PageView, service: MeasureService): SVGElement | null {
  const found = service.snapIndicator;
  if (!found) return null;
  const d = view.transform.toDevice(found.point);
  const size = 5;
  const marker = document.createElementNS(SVG_NS, 'g');
  marker.setAttribute('class', 'measure-snap');
  const title = document.createElementNS(SVG_NS, 'title');
  title.textContent = `Snapped to: ${found.label}`;
  marker.append(title);
  const shape = document.createElementNS(
    SVG_NS,
    found.kind === 'endpoints' ? 'rect' : found.kind === 'paths' ? 'circle' : 'path',
  );
  if (found.kind === 'endpoints') {
    shape.setAttribute('x', (d.x - size).toFixed(2));
    shape.setAttribute('y', (d.y - size).toFixed(2));
    shape.setAttribute('width', String(size * 2));
    shape.setAttribute('height', String(size * 2));
  } else if (found.kind === 'paths') {
    shape.setAttribute('cx', d.x.toFixed(2));
    shape.setAttribute('cy', d.y.toFixed(2));
    shape.setAttribute('r', String(size));
  } else if (found.kind === 'midpoints') {
    shape.setAttribute(
      'd',
      `M${(d.x - size).toFixed(2)} ${(d.y + size).toFixed(2)} L${d.x.toFixed(2)} ${(d.y - size).toFixed(2)} L${(d.x + size).toFixed(2)} ${(d.y + size).toFixed(2)} Z`,
    );
  } else {
    const long = size + 2;
    shape.setAttribute(
      'd',
      `M${(d.x - long).toFixed(2)} ${(d.y - long).toFixed(2)} L${(d.x + long).toFixed(2)} ${(d.y + long).toFixed(2)} M${(d.x - long).toFixed(2)} ${(d.y + long).toFixed(2)} L${(d.x + long).toFixed(2)} ${(d.y - long).toFixed(2)}`,
    );
  }
  shape.setAttribute('class', `measure-snap-shape measure-snap-${found.kind}`);
  marker.append(shape);
  return marker;
}

/** Paints a gesture: the path so far, the live value, and the snap marker. */
function paint(
  preview: Preview,
  service: MeasureService | null,
  page: number,
  points: ReadonlyArray<PdfPoint>,
  close: boolean,
  live: string | null,
): void {
  const view = pageViewOf(service, page);
  if (!service || !view) return;
  const group = preview.open(view);
  if (points.length >= 2) group.append(pathElement(view, points, close));
  const last = points[points.length - 1];
  if (live !== null && last) group.append(labelElement(view, last, live));
  const marker = snapMarker(view, service);
  if (marker) group.append(marker);
}

// ---- drag-a-line: distance and calibrate ------------------------------------------------------------

interface DragState {
  page: number;
  from: PdfPoint;
  to: PdfPoint;
}

/** Distance and Calibrate: press, drag, release. Shift keeps the line to 45°. */
function lineTool(
  lookup: ServiceLookup,
  spec: {
    readonly id: string;
    readonly label: string;
    readonly icon: string;
    readonly kind: 'distance' | 'calibrate';
  },
): ToolSpec {
  let drag: DragState | null = null;
  const preview = new Preview();
  const clear = (): void => {
    preview.clear();
    drag = null;
    const service = lookup();
    service?.clearSnap();
    service?.setLive(null);
  };
  const pointOf = (e: ToolPointerEvent, from: PdfPoint): PdfPoint => {
    const raw = snapped(lookup(), e);
    return e.shiftKey ? constrainAngle(from, raw) : raw;
  };
  const show = (): void => {
    const service = lookup();
    if (!drag || !service) return;
    const live = service.liveFor(spec.kind === 'calibrate' ? 'calibrate' : 'distance', drag.page, [
      drag.from,
      drag.to,
    ]);
    service.setLive(live);
    paint(preview, service, drag.page, [drag.from, drag.to], false, live?.text ?? null);
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
      focusPage(lookup());
      const from = snapped(lookup(), e);
      drag = { page: e.page, from, to: from };
      (e.original.target as Element | null)?.setPointerCapture?.(e.original.pointerId);
      return true;
    },
    onPointerMove: (e) => {
      if (!drag) {
        // Not dragging yet: still show what the pointer would snap to, so a reader can see the
        // marker before committing to the press.
        const service = lookup();
        if (service) {
          snapped(service, e);
          paint(preview, service, e.page, [], false, null);
        }
        return undefined;
      }
      drag.to = pointOf(e, drag.from);
      show();
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
      const moved = Math.hypot(to.x - started.from.x, to.y - started.from.y) >= DRAG_THRESHOLD;
      if (!moved) return true;
      if (spec.kind === 'calibrate') {
        void service.shellServices.run('measure.calibrate', {
          page: started.page,
          from: { x: started.from.x, y: started.from.y },
          to: { x: to.x, y: to.y },
        });
      } else {
        void service.createMeasurement('distance', started.page, [started.from, to]);
      }
      return true;
    },
    onKeyDown: (e) => {
      if (e.key !== 'Escape' || !drag) return undefined;
      clear();
      return true;
    },
  };
}

// ---- click-the-corners: perimeter and area -----------------------------------------------------

interface CornersState {
  page: number;
  points: PdfPoint[];
  hover: PdfPoint | null;
  lastClickAt: number;
}

/** Perimeter and Area: a click per corner; a double-click, Enter or the first corner finish. */
function cornersTool(
  lookup: ServiceLookup,
  spec: {
    readonly id: string;
    readonly label: string;
    readonly icon: string;
    readonly tool: MeasuringToolId;
    readonly closed: boolean;
  },
): ToolSpec {
  let state: CornersState | null = null;
  const preview = new Preview();
  const clear = (): void => {
    preview.clear();
    state = null;
    const service = lookup();
    service?.clearSnap();
    service?.setLive(null);
  };
  const show = (): void => {
    const service = lookup();
    if (!state || !service) return;
    const points = state.hover ? [...state.points, state.hover] : state.points;
    const live = service.liveFor(spec.tool, state.page, points);
    service.setLive(live);
    paint(preview, service, state.page, points, spec.closed, live?.text ?? null);
  };
  const finish = (): void => {
    const done = state;
    const service = lookup();
    clear();
    if (!done || !service) return;
    const minimum = spec.closed ? 3 : 2;
    if (done.points.length < minimum) return;
    void service.createMeasurement(spec.tool, done.page, done.points);
  };
  const pointOf = (e: ToolPointerEvent): PdfPoint => {
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
      focusPage(lookup());
      const now = performance.now();
      const point = pointOf(e);
      if (state && state.page !== e.page) finish();
      if (!state) {
        state = { page: e.page, points: [point], hover: null, lastClickAt: now };
        show();
        return true;
      }
      const first = state.points[0];
      const last = state.points[state.points.length - 1];
      const scale = pageViewOf(lookup(), e.page)?.transform.scale ?? 1;
      const tolerance = 6 / Math.max(scale, 1e-6);
      // Clicking the first corner closes an area; a double-click ends either kind.
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
      show();
      return true;
    },
    onPointerMove: (e) => {
      if (state?.page !== e.page) {
        const service = lookup();
        if (service && !state) {
          snapped(service, e);
          paint(preview, service, e.page, [], false, null);
        }
        return undefined;
      }
      state.hover = pointOf(e);
      show();
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
        show();
        return true;
      }
      return undefined;
    },
  };
}

/** Every tool this module contributes. */
export function measuringTools(lookup: ServiceLookup): ToolSpec[] {
  return [
    lineTool(lookup, {
      id: TOOL_ID.distance,
      label: 'Distance',
      icon: 'ruler',
      kind: 'distance',
    }),
    cornersTool(lookup, {
      id: TOOL_ID.perimeter,
      label: 'Perimeter',
      icon: 'spline',
      tool: 'perimeter',
      closed: false,
    }),
    cornersTool(lookup, {
      id: TOOL_ID.area,
      label: 'Area',
      icon: 'square-dashed',
      tool: 'area',
      closed: true,
    }),
    lineTool(lookup, {
      id: TOOL_ID.calibrate,
      label: 'Calibrate',
      icon: 'ruler-dimension-line',
      kind: 'calibrate',
    }),
  ];
}

/**
 * `ObjectLayer` — the SVG overlay M00 reserved for page objects, filled in by M50.
 *
 * It draws the chrome of object editing and nothing of the objects themselves — those are in
 * the raster, and a moved one is re-rendered there. What it draws: the outline of the object
 * under the pointer, the outline of each selected object, the selection's bounding box with its
 * eight resize handles and the rotate handle above it, a dashed ghost of where a drag would put
 * the selection, the smart guides a snap found, and the marquee.
 *
 * Colours are theme tokens in the stylesheet; nothing here is translucent. Handles are a fixed
 * number of CSS pixels whatever the zoom, as `AnnotationLayer` does, so they can be grabbed at
 * 25 %.
 */

import type { PdfMatrix, PdfPoint, PdfRect } from '@shared/pdf';
import { applyToRect } from '@engine/content/matrix';
import { BOX_HANDLES, HANDLE_SIZE, type BoxHandle } from './AnnotationLayer';
import type { DocumentView } from './DocumentView';
import type { PageView } from './PageView';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** One object as the layer sees it. */
export interface LayerObject {
  readonly id: string;
  readonly rect: PdfRect;
  readonly kind: string;
}

/** A smart guide to draw across the page. */
export interface LayerGuide {
  readonly axis: 'vertical' | 'horizontal';
  readonly at: number;
}

export type ObjectHandle = BoxHandle | 'rotate';

/** How far above the top-centre handle the rotate handle sits, in CSS pixels. */
export const ROTATE_HANDLE_OFFSET = 24;

interface PaneBinding {
  readonly view: DocumentView;
  readonly dispose: () => void;
}

interface PageState {
  objects: ReadonlyArray<LayerObject>;
  selected: ReadonlySet<string>;
  hover: string | null;
  guides: ReadonlyArray<LayerGuide>;
  preview: PdfMatrix | null;
}

function unionRect(rects: ReadonlyArray<PdfRect>): PdfRect | null {
  let out: PdfRect | null = null;
  for (const r of rects) {
    out = out
      ? {
          x0: Math.min(out.x0, r.x0),
          y0: Math.min(out.y0, r.y0),
          x1: Math.max(out.x1, r.x1),
          y1: Math.max(out.y1, r.y1),
        }
      : r;
  }
  return out;
}

/** The eight box handles of a rect, in page space. */
export function boxHandlePoints(r: PdfRect): Array<{ id: BoxHandle; point: PdfPoint }> {
  const midX = (r.x0 + r.x1) / 2;
  const midY = (r.y0 + r.y1) / 2;
  const at: Record<BoxHandle, PdfPoint> = {
    nw: { x: r.x0, y: r.y1 },
    n: { x: midX, y: r.y1 },
    ne: { x: r.x1, y: r.y1 },
    e: { x: r.x1, y: midY },
    se: { x: r.x1, y: r.y0 },
    s: { x: midX, y: r.y0 },
    sw: { x: r.x0, y: r.y0 },
    w: { x: r.x0, y: midY },
  };
  return BOX_HANDLES.map((id) => ({ id, point: at[id] }));
}

export class ObjectLayer {
  private readonly panes: PaneBinding[] = [];
  private readonly pages = new Map<number, PageState>();
  private marqueeRect: { page: number; rect: PdfRect } | null = null;
  private frame = 0;
  private disposed = false;

  attach(view: DocumentView): void {
    const onScroll = (): void => {
      this.schedule();
    };
    view.scroller.addEventListener('scroll', onScroll, { passive: true });
    const observer = new ResizeObserver(() => {
      this.schedule();
    });
    observer.observe(view.scroller);
    this.panes.push({
      view,
      dispose: () => {
        view.scroller.removeEventListener('scroll', onScroll);
        observer.disconnect();
      },
    });
    this.schedule();
  }

  private page(page: number): PageState {
    let s = this.pages.get(page);
    if (!s) {
      s = { objects: [], selected: new Set(), hover: null, guides: [], preview: null };
      this.pages.set(page, s);
    }
    return s;
  }

  setObjects(page: number, objects: ReadonlyArray<LayerObject>): void {
    this.page(page).objects = objects;
    this.schedule();
  }

  objectsOf(page: number): ReadonlyArray<LayerObject> {
    return this.pages.get(page)?.objects ?? [];
  }

  clear(): void {
    this.pages.clear();
    this.marqueeRect = null;
    this.schedule();
  }

  setSelection(page: number, ids: Iterable<string>): void {
    for (const [p, s] of this.pages) if (p !== page) s.selected = new Set();
    this.page(page).selected = new Set(ids);
    this.schedule();
  }

  clearSelection(): void {
    for (const s of this.pages.values()) s.selected = new Set();
    this.schedule();
  }

  setHover(page: number | null, id: string | null): void {
    for (const [p, s] of this.pages) s.hover = p === page ? id : null;
    this.schedule();
  }

  setGuides(page: number, guides: ReadonlyArray<LayerGuide>): void {
    this.page(page).guides = guides;
    this.schedule();
  }

  clearGuides(): void {
    for (const s of this.pages.values()) s.guides = [];
    this.schedule();
  }

  /** A ghost of the selection's bounds under `matrix`, while a drag is in progress. */
  setPreview(page: number, matrix: PdfMatrix | null): void {
    this.page(page).preview = matrix;
    this.schedule();
  }

  setMarquee(marquee: { page: number; rect: PdfRect } | null): void {
    this.marqueeRect = marquee;
    this.schedule();
  }

  /** The union of the selected objects' rects on a page. */
  selectionBounds(page: number): PdfRect | null {
    const s = this.pages.get(page);
    if (!s) return null;
    return unionRect(s.objects.filter((o) => s.selected.has(o.id)).map((o) => o.rect));
  }

  /** The topmost object whose bounds contain a point — last in z-order wins. */
  objectAt(page: number, point: PdfPoint, slack = 0): LayerObject | null {
    const s = this.pages.get(page);
    if (!s) return null;
    for (let i = s.objects.length - 1; i >= 0; i--) {
      const o = s.objects[i];
      if (!o) continue;
      const r = o.rect;
      if (
        point.x >= r.x0 - slack &&
        point.x <= r.x1 + slack &&
        point.y >= r.y0 - slack &&
        point.y <= r.y1 + slack
      ) {
        return o;
      }
    }
    return null;
  }

  /** Every object whose bounds meet a rect. */
  objectsWithin(page: number, rect: PdfRect): LayerObject[] {
    const s = this.pages.get(page);
    if (!s) return [];
    return s.objects.filter(
      (o) =>
        o.rect.x1 >= rect.x0 &&
        o.rect.x0 <= rect.x1 &&
        o.rect.y1 >= rect.y0 &&
        o.rect.y0 <= rect.y1,
    );
  }

  /**
   * The handle of the selection under a page point, with a grab area of a fixed number of CSS
   * pixels. The rotate handle sits `ROTATE_HANDLE_OFFSET` px above the top-centre one.
   */
  handleAt(page: number, point: PdfPoint, scale: number): ObjectHandle | null {
    const bounds = this.selectionBounds(page);
    if (!bounds) return null;
    const slack = HANDLE_SIZE / Math.max(scale, 1e-6);
    const rotate = {
      x: (bounds.x0 + bounds.x1) / 2,
      y: bounds.y1 + ROTATE_HANDLE_OFFSET / Math.max(scale, 1e-6),
    };
    if (Math.abs(rotate.x - point.x) <= slack && Math.abs(rotate.y - point.y) <= slack) {
      return 'rotate';
    }
    for (const h of boxHandlePoints(bounds)) {
      if (Math.abs(h.point.x - point.x) <= slack && Math.abs(h.point.y - point.y) <= slack) {
        return h.id;
      }
    }
    return null;
  }

  schedule(): void {
    if (this.frame || this.disposed) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.paint();
    });
  }

  paint(): void {
    if (this.disposed) return;
    for (const { view } of this.panes) {
      for (const rect of view.layoutTable.rects) {
        const pageView = view.pageView(rect.page);
        if (!pageView) continue;
        this.paintPage(pageView, this.pages.get(rect.page) ?? null);
      }
    }
  }

  private paintPage(pageView: PageView, state: PageState | null): void {
    const layer = pageView.layers.object;
    const marquee = this.marqueeRect?.page === pageView.index ? this.marqueeRect.rect : null;
    const key = signature(state, marquee, pageView);
    if (layer.dataset['objects'] === key) return;
    layer.dataset['objects'] = key;
    layer.replaceChildren();
    if (!state) return;
    const scale = pageView.transform.scale;
    const box = (r: PdfRect): { left: number; top: number; width: number; height: number } =>
      pageView.transform.rectToDevice(r);
    const rectEl = (r: PdfRect, className: string): SVGRectElement => {
      const b = box(r);
      const el = document.createElementNS(SVG_NS, 'rect');
      el.setAttribute('class', className);
      el.setAttribute('x', String(b.left));
      el.setAttribute('y', String(b.top));
      el.setAttribute('width', String(Math.max(1, b.width)));
      el.setAttribute('height', String(Math.max(1, b.height)));
      return el;
    };

    if (state.hover && !state.selected.has(state.hover)) {
      const o = state.objects.find((x) => x.id === state.hover);
      if (o) layer.append(rectEl(o.rect, 'obj-hover'));
    }

    const selected = state.objects.filter((o) => state.selected.has(o.id));
    for (const o of selected) layer.append(rectEl(o.rect, 'obj-outline'));
    const bounds = unionRect(selected.map((o) => o.rect));
    if (bounds) {
      layer.append(rectEl(bounds, 'obj-bounds'));
      const half = HANDLE_SIZE / 2;
      for (const h of boxHandlePoints(bounds)) {
        const p = pageView.transform.toDevice(h.point);
        const el = document.createElementNS(SVG_NS, 'rect');
        el.setAttribute('class', 'obj-handle');
        el.dataset['handle'] = h.id;
        el.setAttribute('x', String(p.x - half));
        el.setAttribute('y', String(p.y - half));
        el.setAttribute('width', String(HANDLE_SIZE));
        el.setAttribute('height', String(HANDLE_SIZE));
        layer.append(el);
      }
      const top = pageView.transform.toDevice({ x: (bounds.x0 + bounds.x1) / 2, y: bounds.y1 });
      const rotate = pageView.transform.toDevice({
        x: (bounds.x0 + bounds.x1) / 2,
        y: bounds.y1 + ROTATE_HANDLE_OFFSET / Math.max(scale, 1e-6),
      });
      const stem = document.createElementNS(SVG_NS, 'line');
      stem.setAttribute('class', 'obj-rotate-stem');
      stem.setAttribute('x1', String(top.x));
      stem.setAttribute('y1', String(top.y));
      stem.setAttribute('x2', String(rotate.x));
      stem.setAttribute('y2', String(rotate.y));
      layer.append(stem);
      const knob = document.createElementNS(SVG_NS, 'circle');
      knob.setAttribute('class', 'obj-handle obj-handle-rotate');
      knob.dataset['handle'] = 'rotate';
      knob.setAttribute('cx', String(rotate.x));
      knob.setAttribute('cy', String(rotate.y));
      knob.setAttribute('r', String(half + 1));
      layer.append(knob);

      if (state.preview) layer.append(rectEl(applyToRect(state.preview, bounds), 'obj-preview'));
    }

    for (const g of state.guides) {
      const line = document.createElementNS(SVG_NS, 'line');
      line.setAttribute('class', 'obj-guide');
      const pb = pageView.transform.box;
      const a =
        g.axis === 'vertical'
          ? pageView.transform.toDevice({ x: g.at, y: pb.y0 })
          : pageView.transform.toDevice({ x: pb.x0, y: g.at });
      const b =
        g.axis === 'vertical'
          ? pageView.transform.toDevice({ x: g.at, y: pb.y1 })
          : pageView.transform.toDevice({ x: pb.x1, y: g.at });
      line.setAttribute('x1', String(a.x));
      line.setAttribute('y1', String(a.y));
      line.setAttribute('x2', String(b.x));
      line.setAttribute('y2', String(b.y));
      layer.append(line);
    }

    if (marquee) layer.append(rectEl(marquee, 'obj-marquee'));
  }

  dispose(): void {
    this.disposed = true;
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
    for (const pane of this.panes.splice(0)) {
      pane.dispose();
      for (const rect of pane.view.layoutTable.rects) {
        const layer = pane.view.pageView(rect.page)?.layers.object;
        if (!layer) continue;
        layer.replaceChildren();
        delete layer.dataset['objects'];
      }
    }
    this.pages.clear();
  }
}

/** A cheap fingerprint of what a page would draw, so an unchanged frame is skipped. */
function signature(state: PageState | null, marquee: PdfRect | null, pageView: PageView): string {
  const parts: string[] = [String(pageView.transform.scale), String(pageView.transform.rotation)];
  if (state) {
    parts.push(String(state.objects.length));
    for (const o of state.objects) {
      if (state.selected.has(o.id) || o.id === state.hover) {
        parts.push(`${o.id}:${o.rect.x0},${o.rect.y0},${o.rect.x1},${o.rect.y1}`);
      }
    }
    parts.push([...state.selected].join(','), state.hover ?? '');
    parts.push(state.guides.map((g) => `${g.axis}${g.at}`).join(','));
    parts.push(state.preview ? state.preview.join(',') : '');
  }
  if (marquee) parts.push(`m${marquee.x0},${marquee.y0},${marquee.x1},${marquee.y1}`);
  return parts.join('|');
}

/**
 * Rulers, grid and guides (M11) — the drawing aids that sit over the page view.
 *
 * The ruler origin is the **top-left of the current page**, which is where Foxit puts it and
 * what makes a measurement mean something. Guides belong to a page in page coordinates
 * (points, origin bottom-left), so they stay on the same piece of paper through zoom, view
 * rotation and a window resize; `GuideSet` is the model, this file is the DOM.
 *
 * Colours are existing theme tokens only — the ruler is panel-coloured with muted text, grid
 * lines use `--border` and guides use `--accent`, so M01's contrast tests already cover them.
 */

import { el } from '@app/dom';
import type { PdfRect } from '@shared/pdf';
import type { DocumentView } from './DocumentView';
import { GuideSet, gridLines, type Guide, type GuideAxis } from './guides';
import { rectOfPage } from './layout';
import { formatLength, rulerTicks, type Unit } from './units';

export interface OverlayOptions {
  readonly view: DocumentView;
  readonly guides: GuideSet;
  /** Page boxes in points, for the grid extent. */
  readonly pageBox: (page: number) => PdfRect | undefined;
  readonly onGuidesChanged?: () => void;
  readonly onUnitsChanged?: (unit: Unit) => void;
}

export interface OverlayState {
  readonly rulers: boolean;
  readonly grid: boolean;
  readonly guides: boolean;
  readonly unit: Unit;
  /** Grid spacing in points. */
  readonly gridSpacing: number;
}

export const DEFAULT_OVERLAY_STATE: OverlayState = {
  rulers: false,
  grid: false,
  guides: true,
  unit: 'mm',
  gridSpacing: 36,
};

export class Overlays {
  private readonly view: DocumentView;
  private readonly guides: GuideSet;
  private readonly pageBox: (page: number) => PdfRect | undefined;
  private readonly onGuidesChanged: (() => void) | undefined;
  private readonly onUnitsChanged: ((unit: Unit) => void) | undefined;

  private readonly hRuler = el('div.viewer-ruler.viewer-ruler-h', {
    'aria-hidden': 'true',
    'data-draggable': 'true',
  });
  private readonly vRuler = el('div.viewer-ruler.viewer-ruler-v', {
    'aria-hidden': 'true',
    'data-draggable': 'true',
  });
  private readonly corner = el('button.viewer-ruler-corner', {
    type: 'button',
    title: 'Ruler units',
  });
  private readonly gridLayer = el('div.viewer-grid', { 'aria-hidden': 'true' });
  private readonly guideLayer = el('div.viewer-guides');
  private readonly disposers: Array<() => void> = [];

  private state: OverlayState = DEFAULT_OVERLAY_STATE;
  private dragging: { guide: Guide; axis: GuideAxis; page: number } | null = null;

  constructor(options: OverlayOptions) {
    this.view = options.view;
    this.guides = options.guides;
    this.pageBox = options.pageBox;
    this.onGuidesChanged = options.onGuidesChanged;
    this.onUnitsChanged = options.onUnitsChanged;

    this.view.overlay.append(this.hRuler, this.vRuler, this.corner);
    this.view.content.append(this.gridLayer, this.guideLayer);

    this.corner.addEventListener('click', () => {
      this.cycleUnit();
    });
    this.installGuideDrag(this.hRuler, 'horizontal');
    this.installGuideDrag(this.vRuler, 'vertical');
    this.apply();
  }

  get options(): OverlayState {
    return this.state;
  }

  set(patch: Partial<OverlayState>): void {
    this.state = { ...this.state, ...patch };
    this.apply();
    this.sync();
  }

  /** Redraws everything for the current scroll, zoom and page. Called once per frame. */
  sync(): void {
    if (this.state.rulers) this.drawRulers();
    this.drawGrid();
    this.drawGuides();
  }

  dispose(): void {
    for (const d of this.disposers.splice(0)) d();
    this.hRuler.remove();
    this.vRuler.remove();
    this.corner.remove();
    this.gridLayer.remove();
    this.guideLayer.remove();
  }

  // ---- internals -----------------------------------------------------------------------------

  private apply(): void {
    const root = this.view.element;
    root.dataset['rulers'] = this.state.rulers ? 'on' : 'off';
    this.hRuler.hidden = !this.state.rulers;
    this.vRuler.hidden = !this.state.rulers;
    this.corner.hidden = !this.state.rulers;
    this.corner.textContent = this.state.unit;
    this.corner.setAttribute('aria-label', `Ruler units: ${this.state.unit}. Click to change.`);
    this.gridLayer.hidden = !this.state.grid;
    this.guideLayer.hidden = !this.state.guides;
  }

  private cycleUnit(): void {
    const order: Unit[] = ['pt', 'mm', 'cm', 'in'];
    const next = order[(order.indexOf(this.state.unit) + 1) % order.length] ?? 'mm';
    this.set({ unit: next });
    this.onUnitsChanged?.(next);
  }

  /** The current page's rect in content coordinates — the ruler origin. */
  private originRect(): { x: number; y: number; width: number; height: number } | null {
    const state = this.view.state;
    const rect = rectOfPage(this.view.layoutTable, state.page);
    if (!rect) return null;
    const view = this.view.pageView(state.page);
    if (!view) return null;
    const box = view.element.getBoundingClientRect();
    const scroll = this.view.scroller.getBoundingClientRect();
    return {
      x: box.left - scroll.left,
      y: box.top - scroll.top,
      width: rect.width,
      height: rect.height,
    };
  }

  private drawRulers(): void {
    const origin = this.originRect();
    if (!origin) {
      this.hRuler.replaceChildren();
      this.vRuler.replaceChildren();
      return;
    }
    const zoom = this.view.zoom;
    const width = this.view.scroller.clientWidth;
    const height = this.view.scroller.clientHeight;

    const hFrom = -origin.x / zoom;
    const hTo = (width - origin.x) / zoom;
    this.hRuler.replaceChildren(
      ...rulerTicks(hFrom, hTo, this.state.unit, zoom).flatMap((tick) => {
        const mark = el(`div.viewer-tick${tick.major ? '.viewer-tick-major' : ''}`);
        mark.style.left = `${origin.x + tick.px}px`;
        if (!tick.major) return [mark];
        const label = el('span.viewer-tick-label', null, tick.label);
        label.style.left = `${origin.x + tick.px}px`;
        return [mark, label];
      }),
    );

    const vFrom = -origin.y / zoom;
    const vTo = (height - origin.y) / zoom;
    this.vRuler.replaceChildren(
      ...rulerTicks(vFrom, vTo, this.state.unit, zoom).flatMap((tick) => {
        const mark = el(`div.viewer-tick${tick.major ? '.viewer-tick-major' : ''}`);
        mark.style.top = `${origin.y + tick.px}px`;
        if (!tick.major) return [mark];
        const label = el('span.viewer-tick-label', null, tick.label);
        label.style.top = `${origin.y + tick.px}px`;
        return [mark, label];
      }),
    );
  }

  private drawGrid(): void {
    if (!this.state.grid) {
      this.gridLayer.replaceChildren();
      return;
    }
    const nodes: HTMLElement[] = [];
    for (const rect of this.view.layoutTable.rects) {
      const view = this.view.pageView(rect.page);
      const box = this.pageBox(rect.page);
      if (!view || !box) continue;
      const lines = gridLines(box, this.state.gridSpacing);
      const left = view.element.offsetLeft;
      const top = view.element.offsetTop;
      for (const x of lines.vertical) {
        const p = view.transform.toDevice({ x, y: box.y1 });
        const line = el('div.viewer-grid-line');
        line.style.left = `${left + p.x}px`;
        line.style.top = `${top}px`;
        line.style.width = '1px';
        line.style.height = `${rect.height}px`;
        nodes.push(line);
      }
      for (const y of lines.horizontal) {
        const p = view.transform.toDevice({ x: box.x0, y });
        const line = el('div.viewer-grid-line');
        line.style.left = `${left}px`;
        line.style.top = `${top + p.y}px`;
        line.style.width = `${rect.width}px`;
        line.style.height = '1px';
        nodes.push(line);
      }
    }
    this.gridLayer.replaceChildren(...nodes);
  }

  private drawGuides(): void {
    if (!this.state.guides) {
      this.guideLayer.replaceChildren();
      return;
    }
    const nodes: HTMLElement[] = [];
    for (const guide of this.guides.all) {
      const view = this.view.pageView(guide.page);
      const rect = rectOfPage(this.view.layoutTable, guide.page);
      const box = this.pageBox(guide.page);
      if (!view || !rect || !box) continue;
      const left = view.element.offsetLeft;
      const top = view.element.offsetTop;
      const isVertical = guide.axis === 'vertical';
      const point = isVertical
        ? view.transform.toDevice({ x: guide.at, y: box.y1 })
        : view.transform.toDevice({ x: box.x0, y: guide.at });
      const node = el(`div.viewer-guide.viewer-guide-${isVertical ? 'v' : 'h'}`, {
        tabindex: 0,
        role: 'separator',
        'data-guide': guide.id,
        'aria-label': `${isVertical ? 'Vertical' : 'Horizontal'} guide at ${formatLength(
          guide.at,
          this.state.unit,
        )} on page ${guide.page + 1}. Delete removes it.`,
      });
      if (isVertical) {
        node.style.left = `${left + point.x}px`;
        node.style.top = `${top}px`;
        node.style.height = `${rect.height}px`;
      } else {
        node.style.left = `${left}px`;
        node.style.top = `${top + point.y}px`;
        node.style.width = `${rect.width}px`;
      }
      node.addEventListener('keydown', (e) => {
        if (e.key !== 'Delete' && e.key !== 'Backspace') return;
        e.preventDefault();
        this.guides.remove(guide.id);
        this.onGuidesChanged?.();
        this.sync();
      });
      node.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        node.setPointerCapture(e.pointerId);
        this.dragging = { guide, axis: guide.axis, page: guide.page };
      });
      node.addEventListener('pointermove', (e) => {
        if (this.dragging?.guide.id !== guide.id) return;
        this.moveGuideTo(guide, e.clientX, e.clientY);
      });
      const end = (e: PointerEvent): void => {
        if (this.dragging?.guide.id !== guide.id) return;
        node.releasePointerCapture?.(e.pointerId);
        this.dragging = null;
        this.onGuidesChanged?.();
      };
      node.addEventListener('pointerup', end);
      node.addEventListener('pointercancel', end);
      nodes.push(node);
    }
    this.guideLayer.replaceChildren(...nodes);
  }

  private moveGuideTo(guide: Guide, clientX: number, clientY: number): void {
    const hit = this.view.hitTest(clientX, clientY);
    if (!hit || hit.page !== guide.page) return;
    this.guides.move(guide.id, guide.axis === 'vertical' ? hit.x : hit.y);
    this.sync();
  }

  /** Dragging out of a ruler creates a guide on whichever page the pointer lands on. */
  private installGuideDrag(ruler: HTMLElement, axis: GuideAxis): void {
    const down = (event: PointerEvent): void => {
      event.preventDefault();
      const created: { guide: Guide | null } = { guide: null };
      const move = (e: PointerEvent): void => {
        const hit = this.view.hitTest(e.clientX, e.clientY);
        if (!hit) return;
        const at = axis === 'vertical' ? hit.x : hit.y;
        if (!created.guide) {
          created.guide = this.guides.add(hit.page, axis, at);
          this.set({ guides: true });
        } else if (created.guide.page === hit.page) {
          this.guides.move(created.guide.id, at);
        }
        this.sync();
      };
      const up = (): void => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        if (created.guide) this.onGuidesChanged?.();
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    };
    ruler.addEventListener('pointerdown', down);
    this.disposers.push(() => ruler.removeEventListener('pointerdown', down));
  }
}

/**
 * Pointer and keyboard for annotations (M30).
 *
 * It listens on the viewer host rather than through a `ToolSpec`, for two reasons. A drag that
 * starts on page 3 and ends on page 5 has to keep producing coordinates after it has left the
 * page it began on, and a `ToolSpec` only ever hears about the page the pointer went down on.
 * And clicking an annotation has to select it whatever tool is active — that is what a reader
 * expects from Foxit, and from every other editor — so it cannot belong to one tool.
 *
 * The creation tools (`tools.ts`) *are* real `ToolSpec`s, because each of them does own the
 * pointer while it is active; this controller stands aside while one of them is.
 */

import { isTypingTarget } from '@app/shortcuts';
import type { ShellServices } from '@app/services';
import type { ModelId } from '@core/Ids';
import type { PdfPoint } from '@shared/pdf';
import type { BoxHandle, HandleId } from '@view/AnnotationLayer';
import type { DocumentView } from '@view/DocumentView';
import type { AnnotationService } from './AnnotationService';
import { CREATION_TOOL_IDS, SELECT_ANNOTATION_TOOL } from './tools';

/** What a drag in progress is doing. */
type Drag =
  | { readonly kind: 'move'; from: PdfPoint; last: PdfPoint; moved: boolean }
  | { readonly kind: 'resize'; id: ModelId; handle: BoxHandle }
  | { readonly kind: 'callout'; id: ModelId; which: 'tip' | 'knee' }
  | { readonly kind: 'marquee'; page: number; from: PdfPoint };

export interface AnnotationControllerOptions {
  readonly service: AnnotationService;
  readonly shell: ShellServices;
  readonly host: HTMLElement;
}

export class AnnotationController {
  private readonly service: AnnotationService;
  private readonly shell: ShellServices;
  private readonly host: HTMLElement;
  private readonly disposers: Array<() => void> = [];
  private drag: Drag | null = null;

  constructor(options: AnnotationControllerOptions) {
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
    const dbl = (e: MouseEvent): void => {
      this.onDoubleClick(e);
    };
    const key = (e: KeyboardEvent): void => {
      this.onKeyDown(e);
    };
    this.host.addEventListener('pointerdown', down, { capture: true });
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    this.host.addEventListener('dblclick', dbl, { capture: true });
    window.addEventListener('keydown', key, { capture: true });
    this.disposers.push(() => {
      this.host.removeEventListener('pointerdown', down, { capture: true });
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      this.host.removeEventListener('dblclick', dbl, { capture: true });
      window.removeEventListener('keydown', key, { capture: true });
    });
  }

  dispose(): void {
    for (const d of this.disposers.splice(0)) d();
  }

  // ---- pointer ----------------------------------------------------------------------------------

  /** The pane under a pointer event, and where in the document it points. */
  private locate(e: {
    readonly clientX: number;
    readonly clientY: number;
  }): { pane: DocumentView; page: number; point: PdfPoint } | null {
    const viewer = this.service.activeViewer();
    if (!viewer) return null;
    for (const pane of viewer.allPanes) {
      const hit = pane.hitTest(e.clientX, e.clientY);
      if (hit) return { pane, page: hit.page, point: { x: hit.x, y: hit.y } };
    }
    return null;
  }

  private activeTool(): string | null {
    return this.shell.ui.get().activeTool;
  }

  private onPointerDown(e: PointerEvent): void {
    if (e.button !== 0) return;
    const tool = this.activeTool();
    /*
     * Two kinds of tool own the pointer and hear nothing from here.
     *
     * A **creation** tool is placing something, and only its own `ToolSpec` should see the press.
     * A **dragging** tool — Select Text, Snapshot, Marquee Zoom — is drawing a rectangle or a text
     * range, and taking its press because an annotation happens to be under the pointer would make
     * a second highlight over the first one impossible. Foxit behaves the same way: comments are
     * picked up with the Hand or the Select Annotation tool, not with the text cursor.
     */
    if (tool !== null && (CREATION_TOOL_IDS.has(tool) || DRAGGING_TOOL_IDS.has(tool))) return;
    const layer = this.service.layer();
    const where = this.locate(e);
    if (!layer || !where) return;
    const scale = where.pane.pageView(where.page)?.transform.scale ?? 1;

    const handle = layer.handleAt(where.page, where.point, scale);
    if (handle) {
      this.beginHandleDrag(handle, e);
      return;
    }
    const hit = layer.hitTest(where.page, where.point, 2 / Math.max(scale, 1e-6));
    if (hit) {
      const additive = e.shiftKey || e.ctrlKey || e.metaKey;
      const id = hit.id as ModelId;
      if (additive) this.service.toggle(id);
      else if (!this.service.selection.includes(id)) this.service.select([id]);
      this.drag = { kind: 'move', from: where.point, last: where.point, moved: false };
      this.capture(e);
      return;
    }
    if (tool === SELECT_ANNOTATION_TOOL) {
      this.service.clearSelection();
      this.drag = { kind: 'marquee', page: where.page, from: where.point };
      this.capture(e);
      return;
    }
    if (this.service.selection.length > 0) this.service.clearSelection();
  }

  private beginHandleDrag(handle: { id: HandleId; on: string }, e: PointerEvent): void {
    const id = handle.on as ModelId;
    if (handle.id === 'tip' || handle.id === 'knee') {
      this.drag = { kind: 'callout', id, which: handle.id };
    } else {
      this.drag = { kind: 'resize', id, handle: handle.id };
    }
    this.capture(e);
  }

  private capture(e: PointerEvent): void {
    e.preventDefault();
    e.stopPropagation();
    const target = e.target;
    if (target instanceof Element) target.setPointerCapture?.(e.pointerId);
  }

  private onPointerMove(e: PointerEvent): void {
    const drag = this.drag;
    if (!drag) return;
    const where = this.locate(e);
    if (!where) return;
    switch (drag.kind) {
      case 'move': {
        const dx = where.point.x - drag.last.x;
        const dy = where.point.y - drag.last.y;
        if (dx === 0 && dy === 0) return;
        drag.last = where.point;
        drag.moved = true;
        void this.service.moveSelection(dx, dy);
        return;
      }
      case 'resize':
        void this.service.resize(drag.id, drag.handle, where.point);
        return;
      case 'callout':
        void this.service.moveCalloutPoint(drag.id, drag.which, where.point);
        return;
      case 'marquee': {
        const rect = {
          x0: Math.min(drag.from.x, where.point.x),
          y0: Math.min(drag.from.y, where.point.y),
          x1: Math.max(drag.from.x, where.point.x),
          y1: Math.max(drag.from.y, where.point.y),
        };
        this.service.layer()?.setMarquee({ page: drag.page, rect });
        return;
      }
    }
  }

  private onPointerUp(e: PointerEvent): void {
    const drag = this.drag;
    if (!drag) return;
    this.drag = null;
    const layer = this.service.layer();
    if (drag.kind === 'marquee') {
      const where = this.locate(e);
      layer?.setMarquee(null);
      if (where && layer) {
        const rect = {
          x0: Math.min(drag.from.x, where.point.x),
          y0: Math.min(drag.from.y, where.point.y),
          x1: Math.max(drag.from.x, where.point.x),
          y1: Math.max(drag.from.y, where.point.y),
        };
        this.service.select(layer.within(drag.page, rect).map((a) => a.id as ModelId));
      }
    }
    // The drag was a stream of merged updates; the next change must not merge into it.
    this.service.activeDocument()?.breakMerge();
  }

  private onDoubleClick(e: MouseEvent): void {
    const layer = this.service.layer();
    const where = this.locate(e);
    if (!layer || !where) return;
    const hit = layer.hitTest(where.page, where.point);
    if (!hit) return;
    e.preventDefault();
    e.stopPropagation();
    const id = hit.id as ModelId;
    const annotation = this.service.activeDocument()?.annotation(id);
    if (!annotation) return;
    this.service.select([id]);
    if (annotation.family === 'freeText') this.service.openEditor(id);
    else this.service.openPopup(id);
  }

  // ---- keyboard ---------------------------------------------------------------------------------

  private onKeyDown(e: KeyboardEvent): void {
    if (isTypingTarget(e.target)) return;
    const selected = this.service.selection.length > 0;
    const mod = e.ctrlKey || e.metaKey;

    if (e.key === 'Escape' && selected) {
      this.stop(e);
      this.service.clearSelection();
      return;
    }
    /*
     * "Esc returns to Hand", as the brief has it. With something selected, Escape clears the
     * selection first — one press per thing to undo, which is what every editor does — and the
     * second press puts the tool away.
     */
    if (e.key === 'Escape') {
      const tool = this.activeTool();
      if (tool !== null && (CREATION_TOOL_IDS.has(tool) || tool === SELECT_ANNOTATION_TOOL)) {
        this.stop(e);
        this.shell.registry.service<{ activate(id: string): void }>('tools').activate('tool.hand');
      }
      return;
    }
    if (!selected) {
      // Paste is the one thing that works with nothing selected, and only in the page area.
      if (mod && !e.altKey && e.key.toLowerCase() === 'v' && this.inDocument(e.target)) {
        void this.service.clipboardHasAnnotations().then((yes) => {
          if (yes) void this.service.paste();
        });
      }
      return;
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      this.stop(e);
      void this.service.deleteSelection();
      return;
    }
    if (mod && !e.altKey) {
      const k = e.key.toLowerCase();
      if (k === 'c') {
        this.stop(e);
        void this.service.copySelection();
        return;
      }
      if (k === 'x') {
        this.stop(e);
        void this.service.cutSelection();
        return;
      }
      if (k === 'v') {
        this.stop(e);
        void this.service.paste();
        return;
      }
      return;
    }
    const nudge = NUDGE[e.key];
    if (nudge) {
      this.stop(e);
      // Shift moves ten times as far, which is the convention every drawing program shares.
      const step = this.service.settings.nudgePoints * (e.shiftKey ? 10 : 1);
      void this.service.moveSelection(nudge[0] * step, nudge[1] * step, 'Nudge annotation');
      return;
    }
    if (e.key === 'Enter' || e.key === 'F2') {
      const id = this.service.selection[0];
      const annotation = id ? this.service.activeDocument()?.annotation(id) : null;
      if (!id || !annotation) return;
      this.stop(e);
      if (annotation.family === 'freeText') this.service.openEditor(id);
      else this.service.openPopup(id);
    }
  }

  private inDocument(target: EventTarget | null): boolean {
    return target instanceof Node && this.host.contains(target);
  }

  private stop(e: KeyboardEvent): void {
    e.preventDefault();
    e.stopImmediatePropagation();
  }
}

/** Tools whose own drag must not be interrupted by picking up an annotation. */
const DRAGGING_TOOL_IDS: ReadonlySet<string> = new Set([
  'tool.selectText',
  'tool.snapshot',
  'tool.marqueeZoom',
]);

/** Arrow keys, as a page-space direction. PDF y grows upwards, so Up is +y. */
const NUDGE: Readonly<Record<string, readonly [number, number] | undefined>> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, 1],
  ArrowDown: [0, -1],
};

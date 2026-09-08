/**
 * M30's tools (`ToolSpec`s).
 *
 * Two kinds. **Select Annotation** is the arrow: it selects, drags and marquees, and everything
 * it does lives in `AnnotationController` because a drag has to keep working after it leaves the
 * page it started on. The **creation** tools each own the pointer while they are active — a click
 * places a note, a drag lays out a text box, two clicks draw a callout — so each is a real
 * `ToolSpec` and the controller stands aside for them.
 *
 * The text-markup tools are not here. They act on the *text selection*, which M13 already owns
 * through `tool.selectText`; a second tool with its own dragging would be a second, disagreeing
 * implementation of selecting words. Markup is a command instead, enabled while text is selected,
 * and the ribbon buttons switch to Select Text first so a reader can just pick Highlight and
 * drag — which is what Foxit does.
 */

import { el } from '@app/dom';
import type { ModelId } from '@core/Ids';
import type { PdfPoint } from '@shared/pdf';
import type { ToolSpec } from '@shared/module';
import type { AnnotationService } from './AnnotationService';

/** How a tool reaches the live service (the shell hands tools to the Registry before it exists). */
export type ServiceLookup = () => AnnotationService | null;

export const SELECT_ANNOTATION_TOOL = 'tool.selectAnnotation';
export const NOTE_TOOL = 'tool.note';
export const TYPEWRITER_TOOL = 'tool.typewriter';
export const TEXTBOX_TOOL = 'tool.textbox';
export const CALLOUT_TOOL = 'tool.callout';

/** The tools that create something, so the controller knows to keep out of their way. */
export const CREATION_TOOL_IDS: ReadonlySet<string> = new Set([
  NOTE_TOOL,
  TYPEWRITER_TOOL,
  TEXTBOX_TOOL,
  CALLOUT_TOOL,
]);

function setCursor(service: AnnotationService | null, cursor: string | null): void {
  const viewer = service?.activeViewer();
  if (!viewer) return;
  for (const pane of viewer.allPanes) {
    if (cursor) pane.element.dataset['toolCursor'] = cursor;
    else delete pane.element.dataset['toolCursor'];
  }
}

/** Select Annotation — the arrow. Selection and dragging are the controller's. */
function selectAnnotationTool(lookup: ServiceLookup): ToolSpec {
  return {
    id: SELECT_ANNOTATION_TOOL,
    label: 'Select Annotation',
    icon: 'mouse-pointer-2',
    cursor: 'default',
    activate: () => {
      setCursor(lookup(), null);
    },
    deactivate: () => {
      lookup()?.clearSelection();
    },
  };
}

/** Note — a click drops a sticky note where the pointer is. */
function noteTool(lookup: ServiceLookup): ToolSpec {
  return {
    id: NOTE_TOOL,
    label: 'Note',
    icon: 'message-square',
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
      void service.createNote(e.page, { x: e.x, y: e.y });
      return true;
    },
  };
}

/** Where a free-text drag started, and the preview box that follows it. */
interface BoxDrag {
  page: number;
  from: PdfPoint;
  box: HTMLElement | null;
  contentFrom: { x: number; y: number };
}

/**
 * Typewriter, Text Box and Callout: click for a default-sized box, or drag one out.
 *
 * A callout is two gestures in one: the point where the pointer went down is the **tip** of the
 * leader line, and the box lands away from it, with the knee halfway. Dragging then sets where
 * the box goes rather than how big it is, which is how a callout is drawn everywhere.
 */
function freeTextTool(
  lookup: ServiceLookup,
  spec: {
    readonly id: string;
    readonly tool: 'typewriter' | 'textbox' | 'callout';
    readonly label: string;
    readonly icon: string;
  },
): ToolSpec {
  let drag: BoxDrag | null = null;

  const clear = (): void => {
    drag?.box?.remove();
    drag = null;
  };

  return {
    id: spec.id,
    label: spec.label,
    icon: spec.icon,
    cursor: spec.tool === 'typewriter' ? 'text' : 'crosshair',
    activate: () => {
      setCursor(lookup(), spec.tool === 'typewriter' ? 'text' : 'crosshair');
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
      drag = {
        page: e.page,
        from: { x: e.x, y: e.y },
        box: el('div.viewer-marquee.annot-draft'),
        contentFrom: point,
      };
      if (drag.box) viewer.pane.content.append(drag.box);
      (e.original.target as Element | null)?.setPointerCapture?.(e.original.pointerId);
      return true;
    },
    onPointerMove: (e) => {
      if (!drag?.box) return undefined;
      const viewer = lookup()?.activeViewer();
      if (!viewer) return undefined;
      const now = viewer.pane.toContent(e.original.clientX, e.original.clientY);
      drag.box.style.left = `${Math.min(drag.contentFrom.x, now.x)}px`;
      drag.box.style.top = `${Math.min(drag.contentFrom.y, now.y)}px`;
      drag.box.style.width = `${Math.abs(now.x - drag.contentFrom.x)}px`;
      drag.box.style.height = `${Math.abs(now.y - drag.contentFrom.y)}px`;
      return true;
    },
    onPointerUp: (e) => {
      const started = drag;
      if (!started) return undefined;
      clear();
      (e.original.target as Element | null)?.releasePointerCapture?.(e.original.pointerId);
      const service = lookup();
      if (!service) return true;
      const to: PdfPoint = { x: e.x, y: e.y };
      void placeFreeText(service, spec.tool, started.page, started.from, to);
      return true;
    },
    onKeyDown: (e) => {
      if (e.key !== 'Escape' || !drag) return undefined;
      clear();
      return true;
    },
  };
}

/** Turns a click or a drag into a rectangle (and, for a callout, a leader line). */
async function placeFreeText(
  service: AnnotationService,
  tool: 'typewriter' | 'textbox' | 'callout',
  page: number,
  from: PdfPoint,
  to: PdfPoint,
): Promise<ModelId | null> {
  const dragged = Math.abs(to.x - from.x) > 6 && Math.abs(to.y - from.y) > 6;
  if (tool === 'callout') {
    // The tip is where the pointer went down; the box goes where it was let go, or a default
    // step away from the tip for a plain click.
    const anchor = dragged ? to : { x: from.x + 72, y: from.y + 48 };
    const rect = service.defaultFreeTextRect(tool, anchor);
    const knee = { x: (from.x + rect.x0) / 2, y: rect.y0 + (rect.y1 - rect.y0) / 2 };
    const shoulder = { x: rect.x0, y: knee.y };
    return await service.createFreeText(tool, page, rect, [from, knee, shoulder]);
  }
  const rect = dragged
    ? {
        x0: Math.min(from.x, to.x),
        y0: Math.min(from.y, to.y),
        x1: Math.max(from.x, to.x),
        y1: Math.max(from.y, to.y),
      }
    : service.defaultFreeTextRect(tool, from);
  const id = await service.createFreeText(tool, page, rect);
  // A free-text box is worthless until it has words in it, so typing starts straight away.
  if (id) service.openEditor(id);
  return id;
}

/** Every tool this module contributes. */
export function annotationTools(lookup: ServiceLookup): ToolSpec[] {
  return [
    selectAnnotationTool(lookup),
    noteTool(lookup),
    freeTextTool(lookup, {
      id: TYPEWRITER_TOOL,
      tool: 'typewriter',
      label: 'Typewriter',
      icon: 'type',
    }),
    freeTextTool(lookup, {
      id: TEXTBOX_TOOL,
      tool: 'textbox',
      label: 'Text Box',
      icon: 'square-pen',
    }),
    freeTextTool(lookup, {
      id: CALLOUT_TOOL,
      tool: 'callout',
      label: 'Callout',
      icon: 'message-square-quote',
    }),
  ];
}

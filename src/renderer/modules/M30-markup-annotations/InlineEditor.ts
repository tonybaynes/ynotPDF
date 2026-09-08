/**
 * In-place editing of a free-text annotation (M30).
 *
 * A `contenteditable` box is placed exactly over the annotation's text box, at the page's own
 * scale, with the same family, size, alignment and line height the appearance stream will use —
 * so what is typed is where it lands. The layer hides the annotation while the editor is open, or
 * the text would be drawn twice.
 *
 * The box grows downwards as the text outgrows it and the annotation's `/Rect` grows with it,
 * because a typewriter note that silently clipped what you typed would be worse than one that
 * moves. Committing writes `/Contents` in one command; a note left empty is removed again, which
 * is what cancelling out of a box you never filled in should do.
 */

import { el } from '@app/dom';
import type { ModelId } from '@core/Ids';
import type { PdfRect } from '@shared/pdf';
import {
  FREE_TEXT_PADDING,
  intentOf,
  logicalBox,
  measureFreeText,
  rotateOf,
  styleOf,
  textBoxOf,
} from '@engine/appearance';
import type { AnnotationService } from './AnnotationService';
import { cssFamily } from './shapes';

const ALIGN_CSS = ['left', 'center', 'right'] as const;

export interface InlineEditorHandle {
  readonly element: HTMLElement;
  close(commit: boolean): void;
  readonly id: ModelId;
}

/**
 * Opens the editor over an annotation. Returns null when the annotation is gone, is not free
 * text, or its page is not on screen.
 */
export function openInlineEditor(
  service: AnnotationService,
  id: ModelId,
  options: { readonly deleteIfEmpty?: boolean } = {},
): InlineEditorHandle | null {
  const document_ = service.activeDocument();
  const viewer = service.activeViewer();
  const annotation = document_?.annotation(id);
  if (!document_ || !viewer || annotation?.family !== 'freeText') return null;
  if (annotation.flags.locked || annotation.flags.readOnly) return null;
  const page = document_.pageIndex(annotation.pageId);
  const pane = viewer.allPanes.find((p) => p.pageView(page) !== undefined);
  const pageView = pane?.pageView(page);
  if (!pane || !pageView) return null;

  const style = styleOf(annotation.extra);
  const scale = pageView.transform.scale;
  const rotate = rotateOf(annotation.extra);
  const box = textBoxOf(annotation.rect, annotation.extra);

  const editor = el('div.annot-editor', {
    contenteditable: 'plaintext-only',
    role: 'textbox',
    'aria-multiline': 'true',
    'aria-label': `Edit ${intentOf(annotation.extra) === 'FreeTextTypewriter' ? 'typewriter' : 'text box'} contents`,
    spellcheck: 'false',
    'data-annot': id,
  });
  editor.textContent = annotation.contents ?? '';
  editor.style.fontFamily = cssFamily(style.family);
  editor.style.fontSize = `${style.size * scale}px`;
  editor.style.lineHeight = String(style.lineSpacing);
  editor.style.textAlign = ALIGN_CSS[style.align] ?? 'left';
  editor.style.fontWeight = style.bold ? 'bold' : 'normal';
  editor.style.fontStyle = style.italic ? 'italic' : 'normal';
  editor.style.padding = `${FREE_TEXT_PADDING * scale}px`;
  editor.style.color = hex(style.color);
  /*
   * The editor turns with the text, about the box's own centre. A rotated `contenteditable` is a
   * little awkward — the caret is drawn by the browser and follows the transform — but typing into
   * a box that shows the words the right way up and then draws them sideways would be worse.
   */
  if (rotate !== 0) {
    editor.style.transformOrigin = 'center';
    editor.style.transform = `rotate(${-rotate}deg)`;
  }
  place(editor, pageView, logicalBox(box, rotate));

  pageView.element.append(editor);
  service.setEditing(id);

  let closed = false;
  const close = (commit: boolean): void => {
    if (closed) return;
    closed = true;
    const text = editor.textContent ?? '';
    editor.remove();
    service.setEditing(null);
    if (!commit) {
      if (options.deleteIfEmpty && (annotation.contents ?? '') === '') {
        service.select([id]);
        void service.deleteSelection();
      }
      return;
    }
    if (text === (annotation.contents ?? '')) {
      if (options.deleteIfEmpty && text.trim() === '') {
        service.select([id]);
        void service.deleteSelection();
      }
      return;
    }
    if (text.trim() === '' && options.deleteIfEmpty) {
      service.select([id]);
      void service.deleteSelection();
      return;
    }
    void service.patch(id, { contents: text, rect: grownRect(annotation.rect, text, style) });
  };

  editor.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      close(false);
      return;
    }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      close(true);
    }
  });
  editor.addEventListener('input', () => {
    const text = editor.textContent ?? '';
    const grown = grownRect(annotation.rect, text, style);
    place(editor, pageView, logicalBox(textBoxOf(grown, annotation.extra), rotate));
  });
  editor.addEventListener('blur', () => {
    close(true);
  });
  editor.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
  });

  // Focus after the current task so the click that opened the editor does not blur it again.
  setTimeout(() => {
    editor.focus();
    selectAll(editor);
  }, 0);

  return { element: editor, close, id };
}

/** The rect a box needs for its text: never smaller than it was, never past the page. */
function grownRect(
  rect: PdfRect,
  text: string,
  style: Parameters<typeof measureFreeText>[1],
): PdfRect {
  const needed = measureFreeText(text, style, rect.x1 - rect.x0);
  const height = Math.max(rect.y1 - rect.y0, needed.height);
  return { ...rect, y0: rect.y1 - height };
}

function place(
  editor: HTMLElement,
  pageView: {
    transform: {
      rectToDevice(r: PdfRect): { left: number; top: number; width: number; height: number };
    };
  },
  box: PdfRect,
): void {
  const device = pageView.transform.rectToDevice(box);
  editor.style.left = `${device.left}px`;
  editor.style.top = `${device.top}px`;
  editor.style.width = `${Math.max(24, device.width)}px`;
  editor.style.minHeight = `${Math.max(16, device.height)}px`;
}

function selectAll(editor: HTMLElement): void {
  const selection = window.getSelection();
  if (!selection) return;
  const range = document.createRange();
  range.selectNodeContents(editor);
  selection.removeAllRanges();
  selection.addRange(range);
}

/** The annotation's own text colour as CSS. */
function hex(color: number): string {
  // ynot-allow-color: the digits come from the annotation, never from this file.
  return `#${(color & 0xffffff).toString(16).padStart(6, '0')}`;
}

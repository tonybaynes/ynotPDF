/**
 * The popup note (M30) — the panel that opens beside a sticky note, a caret or any markup
 * annotation and holds its `/Contents`.
 *
 * **Fully opaque, always** (CLAUDE.md): it is an overlay, so no `rgba()` under 1, no `opacity`,
 * no `backdrop-filter`. It is anchored to the annotation but positioned inside the viewport so it
 * cannot open off-screen, and it is keyboard-reachable — Escape closes it, Ctrl+Enter commits,
 * and it takes focus when it opens so the reader can simply type.
 *
 * "Rich-ish text" is what the brief asks for: bold, italic, underline and a colour, applied to
 * the selection. That is stored as `/RC` (an XHTML fragment, which is what the PDF spec wants)
 * beside the plain `/Contents` every other viewer reads, so a reader without rich text still sees
 * the words.
 */

import { button, el } from '@app/dom';
import { icon } from '@app/icons';
import type { ModelId } from '@core/Ids';
import type { AnnotationService } from './AnnotationService';
import { INK_PRESETS, hexOf, parseHexColour } from './presets';

/** The non-breaking space `contenteditable` inserts for every typed space. */
const NBSP = new RegExp(String.fromCharCode(0xa0), 'g');

export interface NotePopupHandle {
  readonly element: HTMLElement;
  readonly id: ModelId;
  close(commit: boolean): void;
}

/** Opens the popup for an annotation, replacing whichever one was open. */
export function openNotePopup(
  service: AnnotationService,
  id: ModelId,
  host: HTMLElement,
): NotePopupHandle | null {
  const document_ = service.activeDocument();
  const viewer = service.activeViewer();
  const annotation = document_?.annotation(id);
  if (!document_ || !viewer || !annotation) return null;

  const root = el('div.annot-popup', {
    id: 'annot-popup',
    role: 'dialog',
    'aria-label': `Note by ${annotation.author ?? 'an unnamed author'}`,
    'data-annot': id,
  });

  const header = el('div.annot-popup-header');
  const who = el('div.annot-popup-who');
  who.append(
    el('strong.annot-popup-author', null, annotation.author ?? 'Unnamed'),
    el('span.annot-popup-date', null, formatDate(annotation.modified ?? annotation.created)),
  );
  const closeBtn = button(
    'icon-btn annot-popup-close',
    { 'aria-label': 'Close note', title: 'Close note' },
    icon('x'),
  );
  header.append(who, closeBtn);

  const body = el('div.annot-popup-body.annot-popup-readable-colours', {
    contenteditable: 'true',
    role: 'textbox',
    'aria-multiline': 'true',
    'aria-label': 'Note text',
  });
  const rich = annotation.extra['richContents'];
  if (typeof rich === 'string' && rich !== '') body.innerHTML = sanitiseRich(rich);
  else body.textContent = annotation.contents ?? '';

  const toolbar = el('div.annot-popup-toolbar', {
    role: 'toolbar',
    'aria-label': 'Note formatting',
  });
  const styleButton = (
    label: string,
    iconName: string,
    command: 'bold' | 'italic' | 'underline',
  ): HTMLButtonElement => {
    const b = button('icon-btn', { 'aria-label': label, title: label }, icon(iconName));
    b.addEventListener('mousedown', (e) => {
      e.preventDefault();
    });
    b.addEventListener('click', () => {
      body.focus();
      /*
       * `execCommand` is deprecated but not replaced: there is no other way to bold the current
       * selection inside a `contenteditable` without shipping a rich-text editor, and this module
       * adds no libraries. Chromium implements it, and Chromium is the only engine we run on.
       */
      // eslint-disable-next-line @typescript-eslint/no-deprecated -- see the note above.
      document.execCommand(command);
    });
    return b;
  };
  const colour = el('select.annot-popup-colour', { 'aria-label': 'Text colour' });
  for (const preset of INK_PRESETS) {
    if (preset.value === null) continue;
    const option = el('option', { value: hexOf(preset.value) }, preset.name);
    colour.append(option);
  }
  colour.addEventListener('change', () => {
    body.focus();
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- see the note on the style buttons.
    document.execCommand('foreColor', false, colour.value);
  });
  toolbar.append(
    styleButton('Bold', 'bold', 'bold'),
    styleButton('Italic', 'italic', 'italic'),
    styleButton('Underline', 'underline', 'underline'),
    colour,
  );

  // Author colours can disappear on a dark editor surface. This changes only the
  // presentation: innerHTML retains the original colours for the document.
  const readable = el('input', { type: 'checkbox', checked: true });
  const viewOptions = el(
    'label.annot-popup-readable',
    {
      title: 'Display note text using theme colours. Original text colours are kept when saving.',
    },
    readable,
    'Use readable text colours',
  );
  readable.addEventListener('change', () => {
    body.classList.toggle('annot-popup-readable-colours', readable.checked);
  });

  const footer = el('div.annot-popup-footer');
  const save = button('btn btn-primary', { type: 'button' }, 'Save');
  const cancel = button('btn', { type: 'button' }, 'Cancel');
  footer.append(cancel, save);

  root.append(header, toolbar, viewOptions, body, footer);
  host.append(root);
  position(root, service, id, host);

  let closed = false;
  const close = (commit: boolean): void => {
    if (closed) return;
    closed = true;
    // `innerText` renders a non-breaking space for every space `contenteditable` inserted; the
    // file wants the ordinary character.
    const text = body.innerText.replace(NBSP, ' ').trimEnd();
    const html = body.innerHTML;
    root.remove();
    if (!commit) return;
    const wasRich = typeof rich === 'string' ? rich : '';
    const richNow = isPlain(html) ? '' : toRichContents(html);
    if (text === (annotation.contents ?? '') && richNow === wasRich) return;
    void service.patch(id, {
      contents: text,
      extra: { ...annotation.extra, richContents: richNow === '' ? null : richNow },
    });
  };

  closeBtn.addEventListener('click', () => {
    close(true);
  });
  save.addEventListener('click', () => {
    close(true);
  });
  cancel.addEventListener('click', () => {
    close(false);
  });
  root.addEventListener('keydown', (e) => {
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
  root.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
  });
  setTimeout(() => {
    body.focus();
  }, 0);

  return { element: root, id, close };
}

/** Anchors the popup beside its annotation, kept inside the viewport. */
function position(
  root: HTMLElement,
  service: AnnotationService,
  id: ModelId,
  host: HTMLElement,
): void {
  const document_ = service.activeDocument();
  const viewer = service.activeViewer();
  const annotation = document_?.annotation(id);
  if (!document_ || !viewer || !annotation) return;
  const page = document_.pageIndex(annotation.pageId);
  const pane = viewer.allPanes.find((p) => p.pageView(page) !== undefined);
  const pageView = pane?.pageView(page);
  if (!pane || !pageView) return;
  const box = pageView.transform.rectToDevice(annotation.rect);
  const pageBox = pageView.element.getBoundingClientRect();
  const hostBox = host.getBoundingClientRect();
  const width = 300;
  const left = pageBox.left - hostBox.left + box.left + box.width + 8;
  const top = pageBox.top - hostBox.top + box.top;
  root.style.width = `${width}px`;
  root.style.left = `${Math.max(4, Math.min(left, host.clientWidth - width - 4))}px`;
  root.style.top = `${Math.max(4, Math.min(top, host.clientHeight - 200))}px`;
}

function formatDate(iso: string | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

/** True when the markup carries no formatting worth storing as `/RC`. */
function isPlain(html: string): boolean {
  return !/<(b|strong|i|em|u|font|span)\b/i.test(html);
}

/**
 * The `/RC` fragment for a popup's markup: the XHTML body the PDF spec asks for, built from the
 * tags `execCommand` produces. Only the tags this popup can create survive; anything else is
 * dropped rather than passed through, because `/RC` ends up in a file other applications parse.
 */
export function toRichContents(html: string): string {
  return (
    '<?xml version="1.0"?><body xmlns="http://www.w3.org/1999/xhtml">' +
    normaliseFragment(html) +
    '</body>'
  );
}

function normaliseFragment(html: string): string {
  return html.replace(/<!--[\s\S]*?-->|<[^>]*>|</g, (tag) =>
    tag === '<' ? '&lt;' : normaliseTag(tag),
  );
}

function normaliseTag(tag: string): string {
  const match = /^<\s*(\/?)\s*(b|strong|i|em|u|br|p|span|font)\b/i.exec(tag);
  if (!match) return '';
  const closing = match[1] === '/';
  const name = (match[2] ?? '').toLowerCase();
  const canonical = name === 'strong' ? 'b' : name === 'em' ? 'i' : name === 'font' ? 'span' : name;
  if (closing) return canonical === 'br' ? '' : '</' + canonical + '>';
  const lower = tag.toLowerCase();
  if (lower.startsWith('<strong')) return '<b>';
  if (lower.startsWith('</strong')) return '</b>';
  if (lower.startsWith('<em')) return '<i>';
  if (lower.startsWith('</em')) return '</i>';
  if (lower.startsWith('<br')) return '<br/>';
  // A `<font color>` or a `<span style>` keeps only its colour, and only as a hex value.
  const colour = /(?:color\s*=\s*"|color\s*:\s*)(#?[0-9a-z(),.\s]+)/i.exec(tag)?.[1];
  const parsed = colour ? parseHexColour(colour.trim()) : null;
  if (lower.startsWith('<span') || lower.startsWith('<font')) {
    return parsed === null ? '<span>' : `<span style="color:${hexOf(parsed)}">`;
  }
  if (lower.startsWith('</span') || lower.startsWith('</font')) return '</span>';
  return `<${canonical}>`;
}

/** The inverse, for showing a stored `/RC` in the popup. Tags outside the allow-list go. */
export function sanitiseRich(rc: string): string {
  const inner = /<body[^>]*>([\s\S]*)<\/body>/i.exec(rc)?.[1] ?? rc;
  return normaliseFragment(inner);
}

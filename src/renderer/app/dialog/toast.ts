/**
 * Toasts / notifications (M02). An opaque stack in the bottom-right of the document area
 * (`role="status"` so screen readers announce it). Each toast shows an icon *and* the kind
 * word, optional action buttons, and a close button; it auto-dismisses unless it has actions
 * or the pointer/focus is on it.
 */

import { button, el } from '../dom';
import { icon } from '../icons';
import type { MessageKind } from './Dialogs';

const WORD: Record<MessageKind, string> = {
  info: 'Information',
  warning: 'Warning',
  error: 'Error',
  success: 'Done',
  question: 'Question',
};
const ICON: Record<MessageKind, string> = {
  info: 'info',
  warning: 'triangle-alert',
  error: 'octagon-x',
  success: 'circle-check',
  question: 'circle-help',
};

export interface ToastAction {
  readonly label: string;
  readonly run: () => void | Promise<void>;
}

export interface ToastOptions {
  readonly kind?: MessageKind;
  readonly text: string;
  readonly title?: string;
  readonly actions?: ReadonlyArray<ToastAction>;
  /** Auto-dismiss after ms (default 6000; `0` = sticky). Sticky when there are actions. */
  readonly timeout?: number;
  readonly id?: string;
}

export interface ToastHandle {
  readonly element: HTMLElement;
  close(): void;
}

export class Toasts {
  private host: HTMLElement | null = null;

  /** Mounts the toast area into `parent` (the document area). */
  mount(parent: HTMLElement): void {
    this.host = el('div.toast-area', { id: 'toast-area', role: 'status', 'aria-live': 'polite' });
    parent.append(this.host);
  }

  show(options: ToastOptions): ToastHandle {
    const host = this.host ?? document.body;
    const kind = options.kind ?? 'info';
    if (options.id) document.getElementById(options.id)?.remove();
    const toast = el('div.toast', { id: options.id, 'data-kind': kind });
    const head = el(
      'div.toast-head',
      null,
      icon(ICON[kind]),
      el('span.toast-kind', null, WORD[kind]),
    );
    if (options.title) head.append(el('span.toast-title', null, options.title));
    const closeBtn = button(
      'icon-btn toast-close',
      { 'aria-label': 'Dismiss notification' },
      icon('x'),
    );
    head.append(closeBtn);
    toast.append(head, el('p.toast-text', null, options.text));
    if (options.actions?.length) {
      const row = el('div.toast-actions');
      for (const a of options.actions) {
        const b = button('btn btn-small', null, a.label);
        b.addEventListener('click', () => {
          void a.run();
          close();
        });
        row.append(b);
      }
      toast.append(row);
    }
    let timer: ReturnType<typeof setTimeout> | null = null;
    const close = (): void => {
      if (timer) clearTimeout(timer);
      toast.remove();
    };
    closeBtn.addEventListener('click', close);
    const timeout = options.timeout ?? (options.actions?.length ? 0 : 6000);
    const arm = (): void => {
      if (timeout <= 0) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(close, timeout);
    };
    const disarm = (): void => {
      if (timer) clearTimeout(timer);
      timer = null;
    };
    toast.addEventListener('pointerenter', disarm);
    toast.addEventListener('pointerleave', arm);
    toast.addEventListener('focusin', disarm);
    toast.addEventListener('focusout', arm);
    host.append(toast);
    arm();
    return { element: toast, close };
  }

  clear(): void {
    this.host?.replaceChildren();
  }
}

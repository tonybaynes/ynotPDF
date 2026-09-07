/**
 * Dialog service (M02). Native `<dialog>` elements: `showModal()` gives the browser's own focus
 * trap and inert background; `show()` gives a non-modal window. Both are fully opaque — the
 * surface is `--bg-modal`, the backdrop is painted solid `--shadow` — and both answer Escape
 * (cancel) and Enter (the primary button, unless focus is in a multi-line control).
 *
 * The service also offers the standard shapes every module needs: message boxes with an icon
 * *and* the word (Information / Warning / Error), confirmations, prompts, a cancellable progress
 * dialog, and form helpers (label above input, hint below, aligned grid) in `forms.ts`.
 */

import { append, button, el, focusables } from '../dom';
import { icon } from '../icons';

export type MessageKind = 'info' | 'warning' | 'error' | 'success' | 'question';

const KIND_WORD: Record<MessageKind, string> = {
  info: 'Information',
  warning: 'Warning',
  error: 'Error',
  success: 'Done',
  question: 'Question',
};
const KIND_ICON: Record<MessageKind, string> = {
  info: 'info',
  warning: 'triangle-alert',
  error: 'octagon-x',
  success: 'circle-check',
  question: 'circle-help',
};

export interface DialogButton {
  /** Value the dialog resolves with when pressed. */
  readonly id: string;
  readonly label: string;
  /** The primary action (Enter); styled with the accent. */
  readonly primary?: boolean;
  /** Styled as destructive (word + icon, never colour alone). */
  readonly danger?: boolean;
  /** Runs when pressed; return `false` to keep the dialog open (validation). */
  readonly onPress?: (dialog: DialogHandle) => boolean | void | Promise<boolean | void>;
}

export interface DialogOptions {
  readonly title: string;
  /** DOM id of the dialog (tests); also used to de-duplicate: reopening focuses the existing one. */
  readonly id?: string;
  /** Body content: an element, or a builder given the body element. */
  readonly content?: HTMLElement | ((body: HTMLElement, dialog: DialogHandle) => void);
  readonly buttons?: ReadonlyArray<DialogButton>;
  /** Modal (default true). */
  readonly modal?: boolean;
  /** Width in px (rem-scaled via CSS max-width). */
  readonly width?: number;
  /** Kind shows the matching icon + word in the header. */
  readonly kind?: MessageKind;
  /** Element to focus initially (default: primary button, else first focusable). */
  readonly initialFocus?: HTMLElement | 'first';
  /** Escape closes with this result (default `'cancel'`); `null` disables Escape. */
  readonly escapeResult?: string | null;
  readonly className?: string;
}

export interface DialogHandle {
  readonly element: HTMLDialogElement;
  readonly body: HTMLElement;
  /** Resolves with the id of the button pressed, or the escape result. */
  readonly result: Promise<string>;
  close(result?: string): void;
  /** Enables/disables a footer button (validation). */
  setEnabled(buttonId: string, enabled: boolean): void;
  readonly isOpen: boolean;
}

export interface ProgressHandle {
  readonly element: HTMLDialogElement;
  /** `fraction` in 0–1, or `null` for indeterminate. */
  set(fraction: number | null, text?: string): void;
  close(): void;
  readonly cancelled: boolean;
  readonly signal: AbortSignal;
  /** Resolves once the user pressed Cancel. */
  readonly onCancel: Promise<void>;
}

const openDialogs = new Set<HTMLDialogElement>();

/** All open dialog elements (tests, opacity walks). */
export function openDialogElements(): HTMLDialogElement[] {
  return Array.from(openDialogs);
}

export class Dialogs {
  /** Opens a dialog. See {@link DialogOptions}. */
  open(options: DialogOptions): DialogHandle {
    if (options.id) {
      const existing = document.getElementById(options.id);
      if (existing instanceof HTMLDialogElement && existing.open) {
        (focusables(existing)[0] ?? existing).focus();
        const handle = (existing as HTMLDialogElement & { __handle?: DialogHandle }).__handle;
        if (handle) return handle;
      }
      // A closed dialog whose `close` event has not run yet must not share the id.
      existing?.remove();
    }
    const modal = options.modal !== false;
    const dialog = el('dialog.dlg', {
      id: options.id,
      'aria-labelledby': `${options.id ?? 'dlg'}-title-${String(++seq)}`,
      'data-modal': modal ? 'true' : 'false',
    });
    if (options.className) dialog.classList.add(...options.className.split(' '));
    if (options.width) dialog.style.width = `${options.width}px`;

    const titleId = dialog.getAttribute('aria-labelledby') ?? '';
    const header = el('header.dlg-header');
    if (options.kind) {
      header.append(
        el(
          'span.dlg-kind',
          { 'data-kind': options.kind },
          icon(KIND_ICON[options.kind], { size: 'lg' }),
          el('span.dlg-kind-word', null, KIND_WORD[options.kind]),
        ),
      );
    }
    const h2 = el('h2.dlg-title', { id: titleId }, options.title);
    header.append(h2);
    if (!modal) {
      const closeBtn = button('dlg-close icon-btn', { 'aria-label': 'Close dialog' }, icon('x'));
      closeBtn.addEventListener('click', () => {
        close(options.escapeResult ?? 'cancel');
      });
      header.append(closeBtn);
    }
    const body = el('div.dlg-body');
    const footer = el('footer.dlg-footer');
    dialog.append(header, body, footer);

    let resolveResult: (r: string) => void = () => undefined;
    const result = new Promise<string>((resolve) => {
      resolveResult = resolve;
    });
    let isOpen = true;
    const buttonEls = new Map<string, HTMLButtonElement>();

    const finish = (): void => {
      openDialogs.delete(dialog);
      dialog.remove();
      resolveResult(dialog.returnValue || 'cancel');
    };
    const close = (r = 'cancel'): void => {
      if (!isOpen) return;
      isOpen = false;
      dialog.returnValue = r;
      dialog.close();
      // Do not wait for the asynchronous `close` event: the caller may open another dialog at once.
      finish();
    };

    const handle: DialogHandle = {
      element: dialog,
      body,
      result,
      close,
      setEnabled: (id, enabled) => {
        const b = buttonEls.get(id);
        if (b) b.disabled = !enabled;
      },
      get isOpen() {
        return isOpen;
      },
    };
    (dialog as HTMLDialogElement & { __handle?: DialogHandle }).__handle = handle;

    const buttons = options.buttons ?? [{ id: 'ok', label: 'OK', primary: true }];
    let primaryButton: HTMLButtonElement | null = null;
    for (const spec of buttons) {
      const b = button(
        `btn${spec.primary ? ' btn-primary' : ''}${spec.danger ? ' btn-danger' : ''}`,
        {
          'data-result': spec.id,
        },
      );
      if (spec.danger) b.append(icon('triangle-alert'));
      b.append(spec.label);
      b.addEventListener('click', () => {
        void (async () => {
          const keep = await spec.onPress?.(handle);
          if (keep === false) return;
          close(spec.id);
        })();
      });
      buttonEls.set(spec.id, b);
      if (spec.primary) primaryButton = b;
      footer.append(b);
    }

    if (options.content instanceof HTMLElement) body.append(options.content);
    else if (options.content) options.content(body, handle);

    // Escape → cancel (the browser fires `cancel` on Escape for modal dialogs; handle both).
    dialog.addEventListener('cancel', (e) => {
      e.preventDefault();
      if (options.escapeResult === null) return;
      close(options.escapeResult ?? 'cancel');
    });
    dialog.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        if (options.escapeResult !== null) close(options.escapeResult ?? 'cancel');
      } else if (e.key === 'Enter' && primaryButton && !primaryButton.disabled) {
        const t = e.target as HTMLElement | null;
        if (
          t instanceof HTMLTextAreaElement ||
          t instanceof HTMLButtonElement ||
          t?.isContentEditable
        )
          return;
        if (t instanceof HTMLSelectElement) return;
        e.preventDefault();
        primaryButton.click();
      }
    });
    dialog.addEventListener('close', () => {
      // Native close paths (e.g. the browser closing a modal itself); `close()` already finished.
      if (!isOpen) return;
      isOpen = false;
      finish();
    });

    document.body.append(dialog);
    openDialogs.add(dialog);
    if (modal) dialog.showModal();
    else dialog.show();
    const focusTarget =
      options.initialFocus instanceof HTMLElement
        ? options.initialFocus
        : options.initialFocus === 'first'
          ? focusables(body)[0]
          : (primaryButton ?? focusables(body)[0] ?? focusables(footer)[0]);
    (focusTarget ?? dialog).focus();
    return handle;
  }

  /** Message box: icon + word + text. Resolves with the button id. */
  message(options: {
    kind: MessageKind;
    title: string;
    text: string;
    detail?: string;
    buttons?: ReadonlyArray<DialogButton>;
    id?: string;
  }): Promise<string> {
    const content = el('div.dlg-message');
    content.append(el('p.dlg-text', null, options.text));
    if (options.detail) content.append(el('pre.dlg-detail', null, options.detail));
    return this.open({
      ...(options.id !== undefined ? { id: options.id } : {}),
      title: options.title,
      kind: options.kind,
      content,
      buttons: options.buttons ?? [{ id: 'ok', label: 'OK', primary: true }],
      className: 'dlg-messagebox',
    }).result;
  }

  info(title: string, text: string): Promise<string> {
    return this.message({ kind: 'info', title, text });
  }

  warn(title: string, text: string): Promise<string> {
    return this.message({ kind: 'warning', title, text });
  }

  error(title: string, text: string, detail?: string): Promise<string> {
    return this.message({
      kind: 'error',
      title,
      text,
      ...(detail !== undefined ? { detail } : {}),
    });
  }

  /** Yes/No style confirmation with word buttons; resolves `true` for the confirm button. */
  async confirm(options: {
    title: string;
    text: string;
    confirmLabel?: string;
    cancelLabel?: string;
    danger?: boolean;
    kind?: MessageKind;
    id?: string;
  }): Promise<boolean> {
    const r = await this.message({
      kind: options.kind ?? 'question',
      title: options.title,
      text: options.text,
      ...(options.id !== undefined ? { id: options.id } : {}),
      buttons: [
        {
          id: 'confirm',
          label: options.confirmLabel ?? 'OK',
          primary: true,
          ...(options.danger ? { danger: true } : {}),
        },
        { id: 'cancel', label: options.cancelLabel ?? 'Cancel' },
      ],
    });
    return r === 'confirm';
  }

  /** Single-line prompt. Resolves with the text, or `null` on cancel. */
  async prompt(options: {
    title: string;
    label: string;
    hint?: string;
    value?: string;
    okLabel?: string;
    validate?: (value: string) => string | null;
    id?: string;
  }): Promise<string | null> {
    const input = el('input', { type: 'text', value: options.value ?? '' });
    const error = el('p.field-error', { role: 'alert' });
    error.hidden = true;
    const handle = this.open({
      ...(options.id !== undefined ? { id: options.id } : {}),
      title: options.title,
      content: (body) => {
        body.append(
          field({
            label: options.label,
            input,
            ...(options.hint !== undefined ? { hint: options.hint } : {}),
          }),
          error,
        );
      },
      initialFocus: input,
      buttons: [
        {
          id: 'ok',
          label: options.okLabel ?? 'OK',
          primary: true,
          onPress: () => {
            const msg = options.validate?.(input.value) ?? null;
            if (msg) {
              error.textContent = msg;
              error.hidden = false;
              input.setAttribute('aria-invalid', 'true');
              input.focus();
              return false;
            }
            return true;
          },
        },
        { id: 'cancel', label: 'Cancel' },
      ],
    });
    input.select();
    const r = await handle.result;
    return r === 'ok' ? input.value : null;
  }

  /** Progress dialog with a Cancel button. */
  progress(options: {
    title: string;
    text?: string;
    cancellable?: boolean;
    id?: string;
  }): ProgressHandle {
    const controller = new AbortController();
    let cancelled = false;
    let resolveCancel: () => void = () => undefined;
    const onCancel = new Promise<void>((resolve) => {
      resolveCancel = resolve;
    });
    const bar = el('progress.dlg-progress', { max: 1, 'aria-label': options.title });
    const text = el('p.dlg-progress-text', { 'aria-live': 'polite' }, options.text ?? '');
    const percent = el('span.dlg-progress-percent', null, '');
    const handle = this.open({
      ...(options.id !== undefined ? { id: options.id } : {}),
      title: options.title,
      content: (body) => {
        body.append(text, el('div.dlg-progress-row', null, bar, percent));
      },
      escapeResult: options.cancellable === false ? null : 'cancel',
      buttons:
        options.cancellable === false
          ? []
          : [
              {
                id: 'cancel',
                label: 'Cancel',
                onPress: () => {
                  cancelled = true;
                  controller.abort();
                  resolveCancel();
                  return false; // stays open until the caller closes it
                },
              },
            ],
      className: 'dlg-progress-dialog',
    });
    return {
      element: handle.element,
      set: (fraction, t) => {
        if (fraction === null) {
          bar.removeAttribute('value');
          percent.textContent = '';
        } else {
          bar.value = Math.max(0, Math.min(1, fraction));
          percent.textContent = `${Math.round(bar.value * 100)}%`;
        }
        if (t !== undefined) text.textContent = t;
      },
      close: () => {
        handle.close('done');
      },
      get cancelled() {
        return cancelled;
      },
      signal: controller.signal,
      onCancel,
    };
  }
}

let seq = 0;

/** A labelled field: label above the input, optional hint below. */
export function field(options: {
  label: string;
  input: HTMLElement;
  hint?: string;
  required?: boolean;
}): HTMLElement {
  const id = options.input.id || `field-${String(++seq)}`;
  options.input.id = id;
  const wrapper = el('div.field');
  const label = el('label.field-label', { for: id }, options.label);
  if (options.required) label.append(el('span.field-required', { 'aria-hidden': 'true' }, ' *'));
  wrapper.append(label, options.input);
  if (options.hint) {
    const hintId = `${id}-hint`;
    wrapper.append(el('p.field-hint', { id: hintId }, options.hint));
    options.input.setAttribute('aria-describedby', hintId);
  }
  if (options.required) options.input.setAttribute('aria-required', 'true');
  return wrapper;
}

/** Aligned grid of fields (two columns on wide dialogs, one on narrow). */
export function formGrid(...fields: ReadonlyArray<HTMLElement>): HTMLElement {
  const grid = el('div.form-grid');
  append(grid, ...fields);
  return grid;
}

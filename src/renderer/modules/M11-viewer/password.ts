/**
 * The password prompt for encrypted documents (M11).
 *
 * Fully opaque, like every dialog in this app. The field has a show/hide toggle because a long
 * password typed blind is the sort of thing that goes wrong for someone with low vision, and a
 * wrong password re-prompts **with words** — "That password did not open the file" — rather than
 * turning the box red, since red and black read the same to the operator.
 *
 * `askForPassword` loops until the file opens or the reader cancels; cancelling leaves no tab
 * behind and no error toast, because cancelling is not a failure.
 */

import { field, type Dialogs } from '@app/dialog/Dialogs';
import { button, el } from '@app/dom';
import { icon } from '@app/icons';
import { EngineError, type OpenFailure } from '@engine/PdfEngine';

export interface PasswordPromptOptions {
  readonly dialogs: Dialogs;
  /** File name, shown so the reader knows which document is asking. */
  readonly name: string;
  /** True on the second and later attempts. */
  readonly retry?: boolean;
  /** Set when the file needs the *owner* password for what the reader asked to do. */
  readonly reason?: string;
}

/** Asks once. Resolves with the password, or `null` when the reader cancelled. */
export async function promptForPassword(options: PasswordPromptOptions): Promise<string | null> {
  const input = el('input', {
    type: 'password',
    id: 'password-input',
    autocomplete: 'off',
    spellcheck: 'false',
  });
  const reveal = button('icon-btn', {
    'aria-label': 'Show password',
    'aria-pressed': 'false',
    title: 'Show password',
  });
  reveal.append(icon('eye'));
  reveal.addEventListener('click', () => {
    const shown = input.type === 'text';
    input.type = shown ? 'password' : 'text';
    reveal.setAttribute('aria-pressed', shown ? 'false' : 'true');
    reveal.setAttribute('aria-label', shown ? 'Show password' : 'Hide password');
    reveal.title = shown ? 'Show password' : 'Hide password';
    reveal.replaceChildren(icon(shown ? 'eye' : 'eye-off'));
    input.focus();
  });

  const handle = options.dialogs.open({
    id: 'password-dialog',
    title: options.retry ? 'Password not accepted' : 'Password required',
    initialFocus: input,
    content: (body) => {
      const row = el('div.password-row', null, input, reveal);
      body.append(
        field({
          label: 'Password',
          input: row,
          hint: options.retry
            ? 'That password did not open the file. Check the capitals and try again.'
            : (options.reason ?? `"${options.name}" is encrypted. Enter its password to open it.`),
        }),
      );
      // `field` labels its `input` element; point the label at the real input inside the row.
      body.querySelector('label')?.setAttribute('for', 'password-input');
    },
    buttons: [
      { id: 'ok', label: 'Open', primary: true },
      { id: 'cancel', label: 'Cancel' },
    ],
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handle.close('ok');
    }
  });
  const result = await handle.result;
  return result === 'ok' ? input.value : null;
}

/** Whether an engine error means "this file wants a password". */
export function isPasswordError(error: unknown): error is EngineError & { code: OpenFailure } {
  return (
    error instanceof EngineError &&
    (error.code === 'password-required' || error.code === 'wrong-password')
  );
}

/**
 * Runs `open` and, whenever it asks for a password, prompts and retries. Resolves with whatever
 * `open` returns, or `null` when the reader cancelled. Any other error is rethrown — a corrupt
 * file is not something a password fixes.
 */
export async function openWithPassword<T>(
  open: (password?: string) => Promise<T>,
  options: Omit<PasswordPromptOptions, 'retry'>,
): Promise<T | null> {
  try {
    return await open();
  } catch (error) {
    if (!isPasswordError(error)) throw error;
  }
  for (let attempt = 0; ; attempt++) {
    const password = await promptForPassword({ ...options, retry: attempt > 0 });
    if (password === null) return null;
    try {
      return await open(password);
    } catch (error) {
      if (!isPasswordError(error)) throw error;
    }
  }
}

/**
 * Who the annotations are by (M30).
 *
 * Every annotation this app writes carries `/T` (author), `/CreationDate` and `/M`, and Foxit
 * asks for the name the first time you comment on anything. So does this: one opaque dialog,
 * once, before the first annotation exists — after that the answer is a setting and the dialog
 * never reappears unless the reader asks for it from the palette.
 *
 * Answering is optional. "Not now" leaves the identity empty and marks it asked, so an operator
 * who does not want their name in the file is not asked again on every note.
 */

import { el } from '@app/dom';
import { field, formGrid, type Dialogs } from '@app/dialog/Dialogs';
import { initialsOf, type Identity } from './settings';

/**
 * Asks for a name, initials and email. Resolves with the answer, or with the identity as it was
 * (marked asked) when the reader declines.
 */
export async function askIdentity(dialogs: Dialogs, current: Identity): Promise<Identity> {
  const name = el('input', { type: 'text', value: current.name, autocomplete: 'name' });
  const initials = el('input', { type: 'text', value: current.initials, maxlength: '6' });
  const email = el('input', { type: 'email', value: current.email, autocomplete: 'email' });
  let initialsEdited = current.initials !== '';
  initials.addEventListener('input', () => {
    initialsEdited = true;
  });
  name.addEventListener('input', () => {
    if (!initialsEdited) initials.value = initialsOf(name.value);
  });

  const handle = dialogs.open({
    id: 'annot-identity',
    title: 'Who are these comments by?',
    width: 460,
    content: (body) => {
      body.append(
        el(
          'p.dlg-text',
          null,
          'Comments carry an author name and the date they were made. This is asked once and ' +
            'kept in your preferences; you can change or clear it later in Preferences.',
        ),
        formGrid(
          field({ label: 'Name', input: name }),
          field({
            label: 'Initials',
            input: initials,
            hint: 'Used for stamps and signatures later on.',
          }),
          field({ label: 'Email (optional)', input: email }),
        ),
      );
    },
    initialFocus: name,
    buttons: [
      { id: 'ok', label: 'Use this name', primary: true },
      { id: 'skip', label: 'Leave it out' },
    ],
    escapeResult: 'skip',
  });
  const answer = await handle.result;
  if (answer !== 'ok') return { ...current, asked: true };
  const chosen = name.value.trim();
  return {
    name: chosen,
    initials: initials.value.trim() === '' ? initialsOf(chosen) : initials.value.trim(),
    email: email.value.trim(),
    asked: true,
  };
}

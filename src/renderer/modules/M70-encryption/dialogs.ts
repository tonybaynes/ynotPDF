/**
 * Every question M70 asks, in one file so they read consistently (M70).
 *
 * Foxit's Password Protect dialog is the model: open password, permissions password, what
 * printing and changing are allowed, what gets encrypted, and which algorithm. What is different
 * here is the operator's requirements, and they change more than the colours:
 *
 * - **The strength meter is a word and a sentence**, not a coloured bar. "Weak — longer is the
 *   single biggest improvement" is useful; a bar that is green rather than red is not, to someone
 *   for whom red and black are the same colour.
 * - **Every caution is stated in words before it happens**, not as a colour afterwards: that a
 *   permissions password with no open password is only a request, that RC4 is broken, that
 *   removing security cannot be undone once the file is written.
 * - **Nothing is transparent.** The shell's `Dialogs` is already opaque; nothing here adds alpha.
 * - **Passwords are never disabled-by-default or hidden behind a checkbox.** Both fields are
 *   always there, always reachable by Tab, and each has a show/hide toggle, because a long
 *   password typed blind is exactly what goes wrong for someone with low vision.
 */

import { field, formGrid, type DialogHandle, type Dialogs } from '@app/dialog/Dialogs';
import { append, button, el } from '@app/dom';
import { icon } from '@app/icons';
import {
  ALGORITHM_LABELS,
  ALL_ALLOWED,
  SCOPE_LABELS,
  isWeakAlgorithm,
  type EncryptionAlgorithm,
  type EncryptionScope,
  type ModifyPermission,
  type PermissionFlags,
  type PrintPermission,
  type RecipientSummary,
  type SecurityInfo,
  type SecurityIntent,
  type Secrets,
} from '@engine/security/types';
import { describePermissions } from '@engine/security/permissions';
import { passwordProblem, permissionsCaution, strengthOf } from './strength';

// ---- shared pieces ------------------------------------------------------------------------------

/** A password input with a show/hide toggle beside it. */
function passwordInput(id: string): { row: HTMLElement; input: HTMLInputElement } {
  const input = el('input', {
    type: 'password',
    id,
    autocomplete: 'new-password',
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
  return { row: el('div.password-row', null, input, reveal), input };
}

/** A labelled `<select>`. */
function select<T extends string>(
  id: string,
  options: ReadonlyArray<readonly [T, string]>,
  value: T,
): HTMLSelectElement {
  const s = el('select', { id });
  for (const [v, label] of options) {
    const option = el('option', { value: v }, label);
    if (v === value) option.selected = true;
    s.append(option);
  }
  return s;
}

/** A checkbox with its label to the right, which is where a checkbox's label belongs. */
function checkbox(
  id: string,
  label: string,
  checked: boolean,
): {
  row: HTMLElement;
  input: HTMLInputElement;
} {
  const input = el('input', { type: 'checkbox', id });
  input.checked = checked;
  const row = el('div.check-row', null, input, el('label', { for: id }, label));
  return { row, input };
}

/** A worded note. `kind` picks the icon and the token; the word is always in the text. */
function note(kind: 'info' | 'caution', text: string): HTMLElement {
  return el(
    'p.security-note',
    { 'data-kind': kind },
    el(
      'span.security-note-icon',
      { 'aria-hidden': 'true' },
      icon(kind === 'info' ? 'info' : 'triangle-alert'),
    ),
    el('span', null, `${kind === 'info' ? 'Note' : 'Caution'}: ${text}`),
  );
}

// ---- the Protect dialog -------------------------------------------------------------------------

export interface SecurityDialogResult {
  readonly intent: SecurityIntent;
  readonly secrets: Secrets;
}

export interface SecurityDialogOptions {
  readonly dialogs: Dialogs;
  readonly title: string;
  /** What the document already asks for, so reopening the dialog shows it. */
  readonly intent: SecurityIntent;
  /** Passwords already in memory, so the reader does not retype them to change one permission. */
  readonly secrets: Secrets;
  /** Adds a recipient by opening a certificate file. Returns what was added, or null. */
  addRecipients(): Promise<ReadonlyArray<RecipientSummary>>;
}

/**
 * The Password Protect / Certificate Protect dialog.
 *
 * One dialog with two modes rather than Foxit's two commands, because everything below the mode
 * switch — permissions, scope, the cautions — is the same in both, and two dialogs would be two
 * places to keep that right.
 */
export async function askAboutSecurity(
  options: SecurityDialogOptions,
): Promise<SecurityDialogResult | null> {
  let kind: 'password' | 'certificate' =
    options.intent.kind === 'certificate' ? 'certificate' : 'password';
  // A certificate intent has no document-wide permissions — each recipient carries their own —
  // so the dialog starts from the first recipient's, which is what it will edit.
  let permissions: PermissionFlags =
    options.intent.kind === 'password'
      ? options.intent.permissions
      : options.intent.kind === 'certificate'
        ? (options.intent.recipients[0]?.permissions ?? ALL_ALLOWED)
        : ALL_ALLOWED;
  let recipients: RecipientSummary[] =
    options.intent.kind === 'certificate' ? [...options.intent.recipients] : [];

  const user = passwordInput('security-user-password');
  const userConfirm = passwordInput('security-user-confirm');
  const owner = passwordInput('security-owner-password');
  const ownerConfirm = passwordInput('security-owner-confirm');
  if (options.secrets.user) {
    user.input.value = options.secrets.user;
    userConfirm.input.value = options.secrets.user;
  }
  if (options.secrets.owner) {
    owner.input.value = options.secrets.owner;
    ownerConfirm.input.value = options.secrets.owner;
  }

  const algorithm = select<EncryptionAlgorithm>(
    'security-algorithm',
    (Object.entries(ALGORITHM_LABELS) as Array<[EncryptionAlgorithm, string]>).map(([v, l]) => [
      v,
      l,
    ]),
    options.intent.kind === 'none' ? 'aes-256' : options.intent.algorithm,
  );
  const scope = select<EncryptionScope>(
    'security-scope',
    (Object.entries(SCOPE_LABELS) as Array<[EncryptionScope, string]>).map(([v, l]) => [v, l]),
    options.intent.kind === 'none' ? 'all' : options.intent.scope,
  );
  const print = select<PrintPermission>(
    'security-print',
    [
      ['high', 'Allowed, at full resolution'],
      ['low', 'Allowed, low resolution only'],
      ['none', 'Not allowed'],
    ],
    permissions.print,
  );
  const modify = select<ModifyPermission>(
    'security-modify',
    [
      ['all', 'Any changes'],
      ['comment-fill-and-sign', 'Commenting, form filling and signing'],
      ['fill-and-sign', 'Form filling and signing'],
      ['assemble', 'Inserting, deleting and rotating pages'],
      ['none', 'No changes'],
    ],
    permissions.modify,
  );
  const copy = checkbox('security-copy', 'Allow copying text and images', permissions.copy);
  const accessibility = checkbox(
    'security-accessibility',
    'Allow screen readers to extract text',
    permissions.accessibility,
  );

  const strength = el('p.security-strength', { 'aria-live': 'polite' });
  const cautions = el('div.security-cautions', { 'aria-live': 'polite' });
  const problem = el('p.field-error', { role: 'alert' });
  const recipientList = el('ul.security-recipients');
  const passwordFields = el('div.security-section');
  const certificateFields = el('div.security-section');

  let handle: DialogHandle | null = null;

  const readPermissions = (): PermissionFlags => ({
    print: print.value as PrintPermission,
    modify: modify.value as ModifyPermission,
    copy: copy.input.checked,
    accessibility: accessibility.input.checked,
  });

  const renderRecipients = (): void => {
    recipientList.replaceChildren();
    if (recipients.length === 0) {
      recipientList.append(
        el(
          'li.security-recipient-empty',
          null,
          'No recipients yet. Add the certificate of everyone who should be able to open this document.',
        ),
      );
      return;
    }
    for (const recipient of recipients) {
      const remove = button('btn', { 'aria-label': `Remove ${recipient.name}` }, 'Remove');
      remove.addEventListener('click', () => {
        recipients = recipients.filter((r) => r.id !== recipient.id);
        renderRecipients();
        refresh();
      });
      recipientList.append(
        el(
          'li.security-recipient',
          null,
          el('span.security-recipient-name', null, recipient.name),
          el(
            'span.security-recipient-detail',
            null,
            `Issued by ${recipient.issuer} · ${describePermissions(recipient.permissions)}`,
          ),
          remove,
        ),
      );
    }
  };

  const refresh = (): void => {
    permissions = readPermissions();
    passwordFields.hidden = kind !== 'password';
    certificateFields.hidden = kind !== 'certificate';
    // The algorithm is not a choice for certificate protection: AES-256 is the only public-key
    // mode worth writing today, and the dialog says so rather than offering three it will ignore.
    algorithm.disabled = kind === 'certificate';

    const s = strengthOf(user.input.value || owner.input.value);
    strength.replaceChildren(
      el('span.security-strength-icon', { 'aria-hidden': 'true' }, icon(s.icon)),
      el('span.security-strength-word', null, s.word),
      el('span.security-strength-advice', null, ` — ${s.advice}`),
    );
    strength.dataset['band'] = s.word;
    strength.hidden = kind !== 'password';

    cautions.replaceChildren();
    if (kind === 'password') {
      const caution = permissionsCaution(user.input.value, owner.input.value);
      if (caution) cautions.append(note('caution', caution));
      if (isWeakAlgorithm(algorithm.value as EncryptionAlgorithm)) {
        cautions.append(
          note(
            'caution',
            `${ALGORITHM_LABELS[algorithm.value as EncryptionAlgorithm]} is broken and can be removed by anyone who wants to. Choose it only when the document has to open in software older than about 2008.`,
          ),
        );
      }
    } else {
      cautions.append(
        note(
          'info',
          'Certificate protection always uses 256-bit AES. Only the people whose certificates are listed can open the document, and each of them gets the permissions set against their name.',
        ),
      );
    }
    if (scope.value === 'attachments-only') {
      cautions.append(
        note(
          'info',
          'The document itself will open without a password; only its file attachments are protected.',
        ),
      );
    }

    const message = validate();
    problem.textContent = message ?? '';
    problem.hidden = message === null;
    handle?.setEnabled('ok', message === null);
  };

  const validate = (): string | null => {
    if (kind === 'certificate') {
      return recipients.length === 0
        ? 'Add at least one recipient, or switch to password protection.'
        : null;
    }
    return passwordProblem({
      user: user.input.value,
      userConfirm: userConfirm.input.value,
      owner: owner.input.value,
      ownerConfirm: ownerConfirm.input.value,
    });
  };

  const modeButtons = el('div.security-modes', {
    role: 'radiogroup',
    'aria-label': 'Protect with',
  });
  const makeMode = (value: 'password' | 'certificate', label: string): HTMLButtonElement => {
    const b = button('security-mode', {
      role: 'radio',
      'aria-checked': kind === value ? 'true' : 'false',
    });
    b.append(icon(value === 'password' ? 'lock' : 'shield-check'), el('span', null, label));
    b.addEventListener('click', () => {
      kind = value;
      for (const other of modeButtons.querySelectorAll('[role="radio"]')) {
        other.setAttribute('aria-checked', other === b ? 'true' : 'false');
      }
      refresh();
    });
    return b;
  };
  modeButtons.append(
    makeMode('password', 'A password'),
    makeMode('certificate', 'Certificates (specific people)'),
  );

  append(
    passwordFields,
    el('h3.security-heading', null, 'Passwords'),
    formGrid(
      field({
        label: 'Open password',
        input: user.row,
        hint: 'Needed to open the document at all. Leave empty to let anyone open it.',
      }),
      field({ label: 'Confirm open password', input: userConfirm.row }),
      field({
        label: 'Permissions password',
        input: owner.row,
        hint: 'Needed to change what the document allows, and to remove protection.',
      }),
      field({ label: 'Confirm permissions password', input: ownerConfirm.row }),
    ),
    strength,
  );
  // `field` points its label at the element it was given; the real input is inside the row.
  for (const [id, row] of [
    ['security-user-password', user.row],
    ['security-user-confirm', userConfirm.row],
    ['security-owner-password', owner.row],
    ['security-owner-confirm', ownerConfirm.row],
  ] as const) {
    row.parentElement?.querySelector('label')?.setAttribute('for', id);
  }

  const addButton = button('btn', null, icon('file-plus'), el('span', null, 'Add recipient…'));
  addButton.addEventListener('click', () => {
    void options.addRecipients().then((added) => {
      const known = new Set(recipients.map((r) => r.certificateBase64));
      recipients = [...recipients, ...added.filter((a) => !known.has(a.certificateBase64))];
      renderRecipients();
      refresh();
    });
  });
  append(
    certificateFields,
    el('h3.security-heading', null, 'Recipients'),
    recipientList,
    addButton,
  );
  renderRecipients();

  handle = options.dialogs.open({
    id: 'security-dialog',
    title: `Protect "${options.title}"`,
    width: 640,
    kind: 'question',
    initialFocus: user.input,
    content: (body) => {
      append(
        body,
        el(
          'p.security-lead',
          null,
          'Protection is applied when the document is next saved, so nothing changes on disk until then.',
        ),
        modeButtons,
        passwordFields,
        certificateFields,
        el('h3.security-heading', null, 'What is allowed'),
        formGrid(
          field({ label: 'Printing', input: print }),
          field({ label: 'Changes', input: modify }),
        ),
        copy.row,
        accessibility.row,
        el('h3.security-heading', null, 'Encryption'),
        formGrid(
          field({
            label: 'Algorithm',
            input: algorithm,
            hint: 'AES-256 unless the document has to open in very old software.',
          }),
          field({ label: 'What to encrypt', input: scope }),
        ),
        cautions,
        problem,
      );
    },
    buttons: [
      { id: 'ok', label: 'Apply', primary: true },
      { id: 'cancel', label: 'Cancel' },
    ],
  });

  for (const input of [user.input, userConfirm.input, owner.input, ownerConfirm.input]) {
    input.addEventListener('input', refresh);
  }
  for (const control of [algorithm, scope, print, modify]) {
    control.addEventListener('change', refresh);
  }
  for (const box of [copy.input, accessibility.input]) box.addEventListener('change', refresh);
  refresh();

  const result = await handle.result;
  if (result !== 'ok') return null;

  permissions = readPermissions();
  if (kind === 'certificate') {
    return {
      intent: {
        kind: 'certificate',
        algorithm: 'aes-256',
        scope: scope.value as EncryptionScope,
        // A recipient added through this dialog gets the permissions on screen. Per-recipient
        // differences are edited in the recipient dialog; this is the default they start from.
        recipients: recipients.map((r) => ({ ...r, permissions })),
      },
      secrets: {},
    };
  }
  return {
    intent: {
      kind: 'password',
      algorithm: algorithm.value as EncryptionAlgorithm,
      scope: scope.value as EncryptionScope,
      permissions,
      hasUserPassword: user.input.value !== '',
      hasOwnerPassword: owner.input.value !== '',
    },
    secrets: {
      ...(user.input.value === '' ? {} : { user: user.input.value }),
      ...(owner.input.value === '' ? {} : { owner: owner.input.value }),
    },
  };
}

// ---- the smaller questions ----------------------------------------------------------------------

/**
 * Asks for a password that is needed now — before a save that has to re-protect a document, or
 * to remove protection.
 */
export async function askForPassword(
  dialogs: Dialogs,
  options: { readonly title: string; readonly reason: string; readonly retry?: boolean },
): Promise<string | null> {
  const { row, input } = passwordInput('security-password-input');
  const handle = dialogs.open({
    id: 'security-password-dialog',
    title: options.retry ? 'Password not accepted' : `Password needed for "${options.title}"`,
    kind: 'question',
    initialFocus: input,
    content: (body) => {
      body.append(
        field({
          label: 'Permissions password',
          input: row,
          hint: options.retry
            ? 'That password was not accepted. Check the capitals and try again.'
            : options.reason,
        }),
      );
      body.querySelector('label')?.setAttribute('for', 'security-password-input');
    },
    buttons: [
      { id: 'ok', label: 'Continue', primary: true },
      { id: 'cancel', label: 'Cancel' },
    ],
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handle.close('ok');
    }
  });
  return (await handle.result) === 'ok' ? input.value : null;
}

/** Asks for the `.p12` password once the reader has chosen the file. */
export async function askForDigitalIdPassword(
  dialogs: Dialogs,
  options: { readonly fileName: string; readonly retry?: boolean },
): Promise<string | null> {
  const { row, input } = passwordInput('digital-id-password');
  const handle = dialogs.open({
    id: 'digital-id-dialog',
    title: options.retry ? 'Digital ID not opened' : 'Open your digital ID',
    kind: 'question',
    initialFocus: input,
    content: (body) => {
      body.append(
        field({
          label: 'Digital ID password',
          input: row,
          hint: options.retry
            ? `"${options.fileName}" was not opened. Check the password and that this is the right file.`
            : `The password that protects "${options.fileName}". It is used here and not stored.`,
        }),
      );
      body.querySelector('label')?.setAttribute('for', 'digital-id-password');
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
  return (await handle.result) === 'ok' ? input.value : null;
}

/** Confirms removing protection, saying plainly what it costs. */
export async function confirmRemoveSecurity(
  dialogs: Dialogs,
  options: { readonly title: string; readonly info: SecurityInfo },
): Promise<boolean> {
  const handle = dialogs.open({
    id: 'security-remove-dialog',
    title: `Remove protection from "${options.title}"`,
    kind: 'question',
    content: (body) => {
      append(
        body,
        el(
          'p',
          null,
          `"${options.title}" is protected with ${
            options.info.handler === 'public-key' ? 'certificates' : 'a password'
          }. Removing that means anyone who has the file can open it, print it and copy from it.`,
        ),
        el('p', null, 'Nothing changes on disk until the document is saved.'),
      );
    },
    buttons: [
      { id: 'ok', label: 'Remove protection', primary: true, danger: true },
      { id: 'cancel', label: 'Keep it protected' },
    ],
  });
  return (await handle.result) === 'ok';
}

/** The Security tab's content, as a standalone dialog until M72 exists to host it. */
export function showSecurityProperties(
  dialogs: Dialogs,
  options: {
    readonly title: string;
    readonly info: SecurityInfo;
    readonly intent: SecurityIntent;
    readonly openedAs: string | null;
    readonly pending: boolean;
  },
): DialogHandle {
  return dialogs.open({
    id: 'security-properties-dialog',
    title: `Security of "${options.title}"`,
    width: 560,
    content: (body) => {
      body.append(securityPropertiesPanel(options));
    },
    buttons: [{ id: 'ok', label: 'Close', primary: true }],
  });
}

/**
 * The Security panel itself, as an element.
 *
 * Exported so M72 can drop it straight into its Properties dialog as the Security tab when it
 * lands — which is what this module's brief asks for, and one element rather than a contract.
 */
export function securityPropertiesPanel(options: {
  readonly info: SecurityInfo;
  readonly intent: SecurityIntent;
  readonly openedAs: string | null;
  readonly pending: boolean;
}): HTMLElement {
  const panel = el('div.security-properties');
  const row = (label: string, value: string): HTMLElement =>
    el(
      'div.security-property',
      null,
      el('span.security-property-label', null, label),
      el('span.security-property-value', null, value),
    );

  const info = options.info;
  panel.append(
    row(
      'Security method',
      !info.encrypted
        ? 'None'
        : info.handler === 'public-key'
          ? 'Certificate security'
          : 'Password security',
    ),
  );
  if (info.encrypted) {
    panel.append(
      row('Algorithm', info.algorithm ? ALGORITHM_LABELS[info.algorithm] : 'Unknown'),
      row('Handler revision', info.revision === null ? 'Unknown' : String(info.revision)),
      row('Opens without a password', info.opensWithoutPassword ? 'Yes' : 'No'),
      row('Metadata', info.metadataEncrypted ? 'Encrypted' : 'Readable without the password'),
      row('Permissions', describePermissions(info.permissions)),
    );
    if (info.handler === 'public-key') {
      panel.append(row('Recipients', String(info.recipients.length)));
    }
  }
  if (options.openedAs) {
    panel.append(row('Opened with', options.openedAs));
  }
  if (options.pending) {
    panel.append(
      note(
        'info',
        'The security settings below have been changed but not yet saved. The file on disk still has the protection shown above.',
      ),
    );
  }
  return panel;
}

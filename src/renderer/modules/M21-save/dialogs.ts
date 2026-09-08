/**
 * The dialogs M21 puts in front of the reader (M21).
 *
 * All of them follow the shell's rules and the operator's: fully opaque, word buttons rather
 * than colour or an icon alone, every control reachable by keyboard, and a title that says what
 * is happening rather than what went wrong. `Dialogs.message` already gives the icon-plus-word
 * layout and the focus handling, so these are the wording and the button sets, kept in one file
 * so they read consistently.
 *
 * Escape always means the safe answer: Cancel where there is one, Keep mine where there is not.
 */

import { el } from '@app/dom';
import type { Dialogs } from '@app/dialog/Dialogs';
import type { RecoveryRecord } from './recovery';

/** What the reader chose when asked about a document with unsaved changes. */
export type CloseAnswer = 'save' | 'discard' | 'cancel';

/**
 * Save / Don't save / Cancel. The same question for one tab, for all tabs and for quitting, so
 * the wording is the same in all three and the reader learns it once.
 */
export async function askAboutUnsaved(
  dialogs: Dialogs,
  options: { title: string; scope?: string },
): Promise<CloseAnswer> {
  const what = options.scope ?? `"${options.title}"`;
  const answer = await dialogs.message({
    id: 'save-unsaved-dialog',
    kind: 'question',
    title: 'Save changes?',
    text: `${what} has changes that have not been saved. Save them before closing?`,
    buttons: [
      { id: 'save', label: 'Save', primary: true },
      { id: 'discard', label: "Don't save" },
      { id: 'cancel', label: 'Cancel' },
    ],
  });
  return answer === 'save' || answer === 'discard' ? answer : 'cancel';
}

/** What to do about a document that changed on disk while it was open. */
export type DiskChangeAnswer = 'reload' | 'keep';

export async function askAboutDiskChange(
  dialogs: Dialogs,
  options: { title: string; dirty: boolean },
): Promise<DiskChangeAnswer> {
  const consequence = options.dirty
    ? 'Reloading will throw away the changes you have made here.'
    : 'Reloading will show the new version.';
  const answer = await dialogs.message({
    id: 'save-disk-change-dialog',
    kind: 'warning',
    title: 'Changed on disk',
    text: `"${options.title}" has been changed by another program. ${consequence}`,
    buttons: [
      { id: 'keep', label: 'Keep mine', primary: true },
      { id: 'reload', label: 'Reload from disk' },
    ],
  });
  return answer === 'reload' ? 'reload' : 'keep';
}

/** Whether to go ahead with a save that will invalidate the file's signatures. */
export async function askAboutSignatures(
  dialogs: Dialogs,
  options: { title: string; count: number },
): Promise<'saveAs' | 'save' | 'cancel'> {
  const many = options.count === 1 ? 'a digital signature' : `${options.count} digital signatures`;
  const answer = await dialogs.message({
    id: 'save-signatures-dialog',
    kind: 'warning',
    title: 'Saving will invalidate signatures',
    text:
      `"${options.title}" carries ${many}. This version of ynotPDF rewrites the whole file when ` +
      'it saves, which breaks them. Saving as a copy keeps the signed original intact.',
    buttons: [
      { id: 'saveAs', label: 'Save as a copy', primary: true },
      { id: 'save', label: 'Save anyway' },
      { id: 'cancel', label: 'Cancel' },
    ],
  });
  return answer === 'save' || answer === 'saveAs' ? answer : 'cancel';
}

/** Whether to go ahead with a save that cannot keep the file's password protection. */
export async function askAboutEncryption(
  dialogs: Dialogs,
  options: { title: string },
): Promise<'save' | 'cancel'> {
  const answer = await dialogs.message({
    id: 'save-encryption-dialog',
    kind: 'warning',
    title: 'Saving will remove the password',
    text:
      `"${options.title}" is password-protected, and the changes you have made need the whole ` +
      'file to be rewritten. This version cannot put the protection back, so the saved file ' +
      'would open without a password. Re-protecting a saved file arrives with encryption support.',
    buttons: [
      { id: 'cancel', label: 'Cancel', primary: true },
      { id: 'save', label: 'Save without protection' },
    ],
  });
  return answer === 'save' ? 'save' : 'cancel';
}

/** Says that a file cannot be written where it is, and offers Save As. */
export async function askAboutReadOnly(
  dialogs: Dialogs,
  options: { title: string; reason: string },
): Promise<'saveAs' | 'cancel'> {
  const answer = await dialogs.message({
    id: 'save-readonly-dialog',
    kind: 'warning',
    title: 'Read-only',
    text: `"${options.title}" cannot be saved where it is: ${options.reason} Save it somewhere else instead?`,
    buttons: [
      { id: 'saveAs', label: 'Save As…', primary: true },
      { id: 'cancel', label: 'Cancel' },
    ],
  });
  return answer === 'saveAs' ? 'saveAs' : 'cancel';
}

/** What the reader chose to do with the documents a crash left behind. */
export type RecoveryChoice = 'recover' | 'discard' | 'later';

/**
 * The recovery dialog: what was lost, when, and three plain answers. Every row is a real
 * sentence rather than a filename and a timestamp, because a reader who has just lost work
 * needs to know what is on offer, not what it is called on disk.
 */
export async function askAboutRecovery(
  dialogs: Dialogs,
  records: ReadonlyArray<RecoveryRecord>,
): Promise<RecoveryChoice> {
  // Built inside the callback rather than before the call: `Dialogs.open` invokes it when the
  // dialog is actually mounted, which keeps this function usable where there is no DOM.
  const build = (body: HTMLElement): void => {
    const list = el('ul.save-recovery-list');
    for (const record of records) {
      const name = record.path ?? record.title;
      const changes = record.changes === 1 ? '1 change' : `${record.changes} changes`;
      const item = el('li.save-recovery-item');
      item.append(el('span.save-recovery-title', null, record.title));
      item.append(
        el(
          'span.save-recovery-detail',
          null,
          `${changes}, kept ${relativeTime(record.savedAt, Date.now())} — ${name}`,
        ),
      );
      list.append(item);
    }
    const many = records.length === 1 ? 'One document' : `${records.length} documents`;
    body.append(
      el(
        'p.dlg-text',
        null,
        `${many} had unsaved changes when ynotPDF last stopped. They can be put back now.`,
      ),
      list,
    );
  };
  const answer = await dialogs.open({
    id: 'save-recovery-dialog',
    title: 'Recover unsaved work',
    kind: 'question',
    content: build,
    width: 560,
    escapeResult: 'later',
    buttons: [
      { id: 'recover', label: 'Recover', primary: true },
      { id: 'discard', label: 'Discard' },
      { id: 'later', label: 'Not now' },
    ],
  }).result;
  return answer === 'recover' || answer === 'discard' ? answer : 'later';
}

/** "4 minutes ago", "yesterday" — en-GB, through `Intl`, as the conventions require. */
export function relativeTime(at: number, now: number): string {
  const seconds = Math.round((at - now) / 1000);
  const format = new Intl.RelativeTimeFormat('en-GB', { numeric: 'auto' });
  const units: ReadonlyArray<[Intl.RelativeTimeFormatUnit, number]> = [
    ['second', 60],
    ['minute', 60],
    ['hour', 24],
    ['day', 7],
    ['week', 4.35],
    ['month', 12],
  ];
  let value = seconds;
  for (const [unit, per] of units) {
    if (Math.abs(value) < per) return format.format(Math.round(value), unit);
    value /= per;
  }
  return format.format(Math.round(value), 'year');
}

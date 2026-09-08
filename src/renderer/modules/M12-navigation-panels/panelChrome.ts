/**
 * The bits of chrome every navigation panel shares (M12): a toolbar, an empty state that says
 * what is missing in words, a row-based keyboard list, and the "is anything open?" guard.
 *
 * Kept here rather than in each panel so the five panels look and behave alike — same focus
 * ring, same Home/End, same tooltip wording — and so a change to any of that is one edit.
 */

import { button, el } from '@app/dom';
import { icon } from '@app/icons';

/** A toolbar button: icon plus a worded tooltip and accessible name (never an icon alone). */
export function toolButton(options: {
  readonly label: string;
  readonly icon: string;
  readonly onPress: () => void;
  readonly id?: string;
  readonly pressed?: boolean;
}): HTMLButtonElement {
  const b = button(
    'icon-btn nav-tool',
    {
      title: options.label,
      'aria-label': options.label,
      ...(options.id === undefined ? {} : { 'data-action': options.id }),
      ...(options.pressed === undefined ? {} : { 'aria-pressed': String(options.pressed) }),
    },
    icon(options.icon, { fallbackText: options.label }),
  );
  b.addEventListener('click', () => {
    options.onPress();
  });
  return b;
}

/** The panel's toolbar strip. */
export function toolbar(label: string, ...children: ReadonlyArray<Node>): HTMLElement {
  const bar = el('div.nav-toolbar', { role: 'toolbar', 'aria-label': label });
  for (const child of children) bar.append(child);
  return bar;
}

/**
 * What a panel shows when it has nothing to list. A word and an icon, never a blank box: "no
 * bookmarks" and "no document open" are different states and the reader has to be able to tell.
 */
export function emptyMessage(text: string, iconName = 'circle-dashed'): HTMLElement {
  return el(
    'p.nav-empty',
    { role: 'status' },
    icon(iconName, { fallbackText: '' }),
    el('span', null, text),
  );
}

/** A separator with a word, for the header of a group inside a panel. */
export function sectionHeading(text: string): HTMLElement {
  return el('h3.nav-heading', null, text);
}

/** Formats a byte count for a person: "12 KB", "1.4 MB". */
export function formatBytes(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${String(bytes)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  const rounded = value >= 10 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${String(rounded)} ${units[unit] ?? 'KB'}`;
}

/** Formats an ISO date the way the rest of the app does (en-GB, `Intl`). */
export function formatDate(iso: string | null): string {
  if (iso === null || iso === '') return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('en-GB', {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

/**
 * Keyboard behaviour shared by the list-shaped panels: arrows move the active row, Home and End
 * jump to the ends, Enter and Space activate. The caller says what the rows are and what moving
 * to one means, so this never has to know whether it is looking at a tree or a list.
 */
export interface ListKeys {
  readonly rows: () => ReadonlyArray<HTMLElement>;
  readonly activate: (row: HTMLElement) => void;
  /** Called with the row that focus moved to. */
  readonly focus?: (row: HTMLElement) => void;
  /** Left / right on a tree row; return true when the key was used. */
  readonly collapse?: (row: HTMLElement) => boolean;
  readonly expand?: (row: HTMLElement) => boolean;
}

export function installListKeys(container: HTMLElement, keys: ListKeys): () => void {
  const focusRow = (row: HTMLElement | undefined): void => {
    if (!row) return;
    for (const other of keys.rows()) other.tabIndex = other === row ? 0 : -1;
    row.focus();
    keys.focus?.(row);
  };
  const handler = (event: KeyboardEvent): void => {
    const rows = keys.rows();
    if (rows.length === 0) return;
    const target = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-row]');
    const at = target ? rows.indexOf(target) : -1;
    switch (event.key) {
      case 'ArrowDown':
        focusRow(rows[Math.min(rows.length - 1, at + 1)]);
        break;
      case 'ArrowUp':
        focusRow(rows[Math.max(0, at - 1)]);
        break;
      case 'Home':
        focusRow(rows[0]);
        break;
      case 'End':
        focusRow(rows[rows.length - 1]);
        break;
      case 'ArrowLeft':
        if (!target || keys.collapse?.(target) !== true) return;
        break;
      case 'ArrowRight':
        if (!target || keys.expand?.(target) !== true) return;
        break;
      case 'Enter':
      case ' ':
        if (!target) return;
        keys.activate(target);
        break;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
  };
  container.addEventListener('keydown', handler);
  return () => {
    container.removeEventListener('keydown', handler);
  };
}

/** Makes exactly one row tabbable, so the panel is a single tab stop. */
export function setRovingRows(rows: ReadonlyArray<HTMLElement>, active: HTMLElement | null): void {
  const chosen = active ?? rows[0] ?? null;
  for (const row of rows) row.tabIndex = row === chosen ? 0 : -1;
}

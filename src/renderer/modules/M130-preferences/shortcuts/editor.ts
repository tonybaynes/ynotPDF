/**
 * The keyboard-shortcut editor (M130) — every command, what it is bound to, and a way to change
 * it. It mounts inside Preferences as a page rather than opening a dialog of its own.
 *
 * **Recording.** "Change" turns one row into a listening state: the next chord is captured with
 * `keyFromEvent`, so what is stored is exactly what the dispatcher will later match, including
 * `Mod` standing for Ctrl or Cmd. While a row is listening, every key belongs to it — Escape
 * cancels rather than closing the dialog, and Tab is captured rather than moving focus, because
 * Tab is a key someone may legitimately want to bind.
 *
 * **Conflicts are words.** If the chord is taken, the row says which command has it and offers
 * "Use it here anyway", which unbinds the other command and says so. Nothing is signalled by a
 * colour, and no chord is ever quietly shared between two commands.
 */

import type { Dialogs } from '@app/dialog/Dialogs';
import { button, el, srOnly } from '@app/dom';
import { icon } from '@app/icons';
import { formatShortcut, keyFromEvent } from '@core/Registry';
import { t } from '../i18n';
import {
  bind,
  buildRows,
  changedRows,
  conflictFor,
  filterRows,
  keyProblem,
  keyWarning,
  resetOne,
  unbind,
  type BindableCommand,
  type BindingRow,
  type ShortcutOverrides,
} from './model';

export interface ShortcutEditorOptions {
  readonly dialogs: Dialogs;
  readonly isMac: boolean;
  /** Every bindable command, with the key its module declares. */
  commands(): ReadonlyArray<BindableCommand>;
  overrides(): ShortcutOverrides;
  /** Persists and applies the new overrides. */
  save(overrides: ShortcutOverrides): Promise<void>;
  /** Builds and opens the printable sheet. */
  cheatSheet(): Promise<void>;
  exportBindings(): Promise<void>;
  importBindings(): Promise<void>;
  /**
   * Tells the editor when the bindings changed somewhere else — the palette's Reset command,
   * an import, another window. Returns a disposer.
   */
  subscribe?: (redraw: () => void) => () => void;
}

/** Mounts the editor into `host`. Returns a disposer. */
export function mountShortcutEditor(host: HTMLElement, options: ShortcutEditorOptions): () => void {
  const { dialogs, isMac } = options;
  let query = '';
  let recording: string | null = null;
  let rows: ReadonlyArray<BindingRow> = [];

  const search = el('input.shortcut-search', {
    type: 'search',
    id: 'shortcut-search',
    placeholder: t('shortcuts.searchPlaceholder', 'Search commands and keys'),
    autocomplete: 'off',
    spellcheck: 'false',
  });
  const status = el('p.shortcut-status', { role: 'status', 'aria-live': 'polite' });
  const table = el('div.shortcut-rows', { role: 'list' });

  const commit = async (next: ShortcutOverrides): Promise<void> => {
    await options.save(next);
    draw();
  };

  const say = (text: string): void => {
    status.textContent = text;
  };

  // ---- one row ------------------------------------------------------------------------------

  const drawRow = (row: BindingRow): HTMLElement => {
    const item = el('div.shortcut-row', { role: 'listitem', 'data-command': row.commandId });
    const name = el('div.shortcut-name');
    name.append(el('span.shortcut-label', null, row.label));
    name.append(el('span.shortcut-id', null, row.commandId));
    if (row.changed) {
      name.append(
        el(
          'span.shortcut-changed',
          null,
          icon('circle-alert'),
          ' ',
          t('shortcuts.changed', 'changed'),
        ),
      );
    }
    item.append(name);

    const keyCell = el('div.shortcut-key');
    if (recording === row.commandId) {
      keyCell.append(
        el(
          'kbd.shortcut-recording',
          { tabindex: 0, 'data-recording': 'true' },
          t('shortcuts.listening', 'Press the keys…'),
        ),
      );
    } else if (row.key === undefined) {
      keyCell.append(el('span.shortcut-none', null, t('shortcuts.none', 'No key')));
    } else {
      keyCell.append(el('kbd', null, formatShortcut(row.key, isMac)));
    }
    item.append(keyCell);

    const actions = el('div.shortcut-actions');
    const change = button('btn btn-small');
    change.append(
      icon('keyboard'),
      el(
        'span',
        null,
        recording === row.commandId
          ? t('shortcuts.cancel', 'Cancel')
          : t('shortcuts.change', 'Change'),
      ),
    );
    change.addEventListener('click', () => {
      recording = recording === row.commandId ? null : row.commandId;
      draw();
      if (recording) {
        table
          .querySelector<HTMLElement>(
            `[data-command="${cssEscape(row.commandId)}"] [data-recording]`,
          )
          ?.focus();
        say(
          t('shortcuts.listeningHelp', 'Press the keys you want for “{label}”. Escape cancels.', {
            label: row.label,
          }),
        );
      }
    });
    actions.append(change);

    const clear = button('icon-btn', { title: t('shortcuts.unbind', 'Remove the key') });
    clear.append(icon('x'), srOnly(`${t('shortcuts.unbind', 'Remove the key')}: ${row.label}`));
    clear.disabled = row.key === undefined;
    clear.addEventListener('click', () => {
      void commit(unbind(rows, options.overrides(), row.commandId)).then(() => {
        say(t('shortcuts.unbound', '“{label}” now has no key.', { label: row.label }));
      });
    });
    actions.append(clear);

    const reset = button('icon-btn', { title: t('shortcuts.reset', 'Back to the default') });
    reset.append(
      icon('refresh-cw'),
      srOnly(`${t('shortcuts.reset', 'Back to the default')}: ${row.label}`),
    );
    reset.disabled = !row.changed;
    reset.addEventListener('click', () => {
      void commit(resetOne(options.overrides(), row.commandId)).then(() => {
        say(
          row.defaultKey === undefined
            ? t('shortcuts.resetNone', '“{label}” is back to having no key.', { label: row.label })
            : t('shortcuts.resetOne', '“{label}” is back to {key}.', {
                label: row.label,
                key: formatShortcut(row.defaultKey, isMac),
              }),
        );
      });
    });
    actions.append(reset);
    item.append(actions);
    return item;
  };

  // ---- recording ----------------------------------------------------------------------------

  const onKeyDown = (e: KeyboardEvent): void => {
    if (recording === null) return;
    // Everything belongs to the row while it is listening — including Tab and Escape.
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape') {
      recording = null;
      draw();
      say(t('shortcuts.cancelled', 'Nothing changed.'));
      return;
    }
    const key = keyFromEvent(e, isMac);
    if (key === null) return; // a bare modifier: wait for the rest of the chord
    const problem = keyProblem(key);
    if (problem !== null) {
      say(problem);
      return;
    }
    const commandId = recording;
    const row = rows.find((r) => r.commandId === commandId);
    if (!row) return;
    const clash = conflictFor(rows, key, commandId);
    recording = null;
    if (clash) {
      void resolveConflict(row, key, clash);
      draw();
      return;
    }
    void commit(bind(rows, options.overrides(), commandId, key)).then(() => {
      const warning = keyWarning(key);
      say(
        t('shortcuts.bound', '“{label}” is now {key}.', {
          label: row.label,
          key: formatShortcut(key, isMac),
        }) + (warning ? ` ${warning}` : ''),
      );
    });
  };

  const resolveConflict = async (
    row: BindingRow,
    key: string,
    clash: BindingRow,
  ): Promise<void> => {
    const pretty = formatShortcut(key, isMac);
    const ok = await dialogs.confirm({
      title: t('shortcuts.conflictTitle', '{key} is already taken', { key: pretty }),
      text: t(
        'shortcuts.conflictText',
        '{key} runs “{other}” at the moment. Give it to “{label}” instead? “{other}” will then have no key until you give it one.',
        { key: pretty, other: clash.label, label: row.label },
      ),
      kind: 'warning',
      confirmLabel: t('shortcuts.conflictConfirm', 'Use it here'),
      cancelLabel: t('shortcuts.conflictCancel', 'Leave it alone'),
    });
    if (!ok) {
      say(
        t('shortcuts.conflictKept', '{key} still runs “{other}”.', {
          key: pretty,
          other: clash.label,
        }),
      );
      return;
    }
    await commit(bind(rows, options.overrides(), row.commandId, key));
    say(
      t('shortcuts.conflictMoved', '{key} now runs “{label}”. “{other}” has no key.', {
        key: pretty,
        label: row.label,
        other: clash.label,
      }),
    );
  };

  // ---- the page -----------------------------------------------------------------------------

  const resetCount = el('span.shortcut-reset-count');
  const resetAll = button('btn');
  resetAll.append(icon('refresh-cw'), resetCount);

  const draw = (): void => {
    rows = buildRows(options.commands(), options.overrides());
    const shown = filterRows(rows, query);
    table.replaceChildren();
    if (shown.length === 0) {
      table.append(
        el(
          'p.shortcut-empty',
          { role: 'listitem' },
          icon('info'),
          ' ',
          t('shortcuts.noMatches', 'No command matches what you typed.'),
        ),
      );
    }
    let category = '';
    for (const row of shown) {
      if (row.category !== category) {
        category = row.category;
        table.append(el('h3.shortcut-category', { role: 'listitem' }, category));
      }
      table.append(drawRow(row));
    }
    const changed = changedRows(rows).length;
    resetAll.disabled = changed === 0;
    resetCount.textContent = t('shortcuts.resetAllCount', 'Reset all ({n} changed)', {
      n: changed,
    });
  };

  resetAll.addEventListener('click', () => {
    void (async () => {
      const changed = changedRows(rows);
      const ok = await dialogs.confirm({
        title: t('shortcuts.resetAllTitle', 'Reset every shortcut?'),
        text: t(
          'shortcuts.resetAllText',
          '{n} shortcuts you changed go back to what the application ships with.',
          { n: changed.length },
        ),
        kind: 'question',
        confirmLabel: t('shortcuts.resetAllConfirm', 'Reset them'),
      });
      if (!ok) return;
      await commit({});
      say(t('shortcuts.resetAllDone', 'Every shortcut is back to its default.'));
    })();
  });

  const sheet = button('btn');
  sheet.append(icon('printer'), el('span', null, t('shortcuts.cheatSheet', 'Printable list…')));
  sheet.addEventListener('click', () => {
    void options.cheatSheet();
  });

  const exportBtn = button('btn');
  exportBtn.append(icon('download'), el('span', null, t('shortcuts.export', 'Export…')));
  exportBtn.addEventListener('click', () => {
    void options.exportBindings();
  });

  const importBtn = button('btn');
  importBtn.append(icon('upload'), el('span', null, t('shortcuts.import', 'Import…')));
  importBtn.addEventListener('click', () => {
    void options.importBindings().then(draw);
  });

  const top = el('div.shortcut-top');
  const searchField = el('div.shortcut-search-field');
  searchField.append(
    el('label.sr-only', { for: 'shortcut-search' }, t('shortcuts.search', 'Search commands')),
    icon('search'),
    search,
  );
  top.append(searchField);
  search.addEventListener('input', () => {
    query = search.value;
    draw();
  });

  host.append(
    top,
    status,
    table,
    el('div.shortcut-actions-bar', null, resetAll, sheet, exportBtn, importBtn),
  );
  // Capture phase: the shell's own dispatcher must not run the command the reader is recording.
  window.addEventListener('keydown', onKeyDown, true);
  const unsubscribe = options.subscribe?.(draw);
  draw();

  return () => {
    window.removeEventListener('keydown', onKeyDown, true);
    unsubscribe?.();
  };
}

/** `CSS.escape` where it exists; a conservative fallback where it does not. */
function cssEscape(value: string): string {
  return typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
    ? CSS.escape(value)
    : value.replace(/[^\w-]/g, (c) => `\\${c}`);
}

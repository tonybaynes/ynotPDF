/**
 * Command palette (M00 minimal → M02 fuzzy). Lists every enabled, non-hidden command from the
 * Registry with its category and shortcut; fuzzy-filters as you type (`fuzzy.ts`), highlights
 * the matched letters, Enter runs, Escape closes. Recently run commands sort first for an empty
 * query. A native `<dialog>` — fully opaque, focus-trapped.
 */

import { formatShortcut, type PaletteEntry, type Registry } from '@core/Registry';
import { el } from './dom';
import { rank } from './fuzzy';

let current: HTMLDialogElement | null = null;
const recent: string[] = [];
const MAX_RESULTS = 60;

/** Records a command as recently used (the shell calls this from `run`). */
export function notePaletteUse(id: string): void {
  const i = recent.indexOf(id);
  if (i >= 0) recent.splice(i, 1);
  recent.unshift(id);
  if (recent.length > 20) recent.pop();
}

function haystack(e: PaletteEntry): string {
  return `${e.category}: ${e.label} ${e.id}`;
}

/** Highlights matched positions of `text` (offset by `offset` in the haystack). */
function highlighted(text: string, positions: ReadonlyArray<number>, offset: number): HTMLElement {
  const span = el('span.pal-label');
  const set = new Set(positions.map((p) => p - offset));
  let run = '';
  let inMatch = false;
  const flush = (): void => {
    if (!run) return;
    span.append(inMatch ? el('mark', null, run) : run);
    run = '';
  };
  for (let i = 0; i < text.length; i++) {
    const m = set.has(i);
    if (m !== inMatch) {
      flush();
      inMatch = m;
    }
    run += text[i] ?? '';
  }
  flush();
  return span;
}

export function openPalette(registry: Registry): HTMLDialogElement {
  if (current?.open) {
    current.querySelector('input')?.focus();
    return current;
  }
  const dialog = el('dialog.palette', { id: 'command-palette', 'aria-label': 'Command palette' });
  const input = el('input', {
    type: 'text',
    placeholder: 'Type a command…',
    'aria-label': 'Search commands',
    role: 'combobox',
    'aria-expanded': 'true',
    'aria-controls': 'palette-list',
    'aria-autocomplete': 'list',
    autocomplete: 'off',
    spellcheck: 'false',
  });
  const list = el('ul', { id: 'palette-list', role: 'listbox', 'aria-label': 'Matching commands' });
  const hint = el(
    'div.pal-hint',
    null,
    el('kbd', null, '↑↓'),
    ' choose  ',
    el('kbd', null, 'Enter'),
    ' run  ',
    el('kbd', null, 'Esc'),
    ' close',
  );
  const isMac = registry.hasService('platform')
    ? registry.service<{ isMac: boolean }>('platform').isMac
    : false;

  let rows: { entry: PaletteEntry; positions: ReadonlyArray<number> }[] = [];
  let selected = 0;

  const render = (): void => {
    const q = input.value.trim();
    const entries = registry.paletteEntries();
    if (q) {
      rows = rank(q, entries, haystack)
        .slice(0, MAX_RESULTS)
        .map((r) => ({ entry: r.item, positions: r.positions }));
    } else {
      const byRecent = (e: PaletteEntry): number => {
        const i = recent.indexOf(e.id);
        return i < 0 ? 1000 : i;
      };
      rows = [...entries]
        .sort((a, b) => byRecent(a) - byRecent(b))
        .slice(0, MAX_RESULTS)
        .map((e) => ({ entry: e, positions: [] }));
    }
    selected = Math.min(selected, Math.max(0, rows.length - 1));
    list.replaceChildren(
      ...rows.map(({ entry: e, positions }, i) => {
        const li = el('li', {
          role: 'option',
          id: `pal-opt-${String(i)}`,
          'aria-selected': i === selected ? 'true' : 'false',
          'data-command': e.id,
        });
        const prefix = `${e.category}: `;
        const left = el('span.pal-main');
        left.append(
          el('span.cat', null, e.category),
          highlighted(e.label, positions, prefix.length),
        );
        if (e.description) left.append(el('span.pal-desc', null, e.description));
        const key = el('span.key', null, e.shortcut ? formatShortcut(e.shortcut, isMac) : '');
        li.append(left, key);
        li.addEventListener('click', () => {
          void run(e.id);
        });
        li.addEventListener('pointermove', () => {
          if (selected !== i) {
            selected = i;
            for (const o of list.children)
              o.setAttribute('aria-selected', o === li ? 'true' : 'false');
          }
        });
        return li;
      }),
    );
    if (rows.length === 0)
      list.append(
        el('li.pal-empty', { role: 'option', 'aria-selected': 'false' }, 'No matching commands'),
      );
    input.setAttribute('aria-activedescendant', rows.length ? `pal-opt-${String(selected)}` : '');
    list.children[selected]?.scrollIntoView({ block: 'nearest' });
  };

  const run = async (id: string): Promise<void> => {
    dialog.close();
    notePaletteUse(id);
    try {
      await registry.run(id);
    } catch (error) {
      console.error(`command ${id} failed`, error);
    }
  };

  input.addEventListener('input', () => {
    selected = 0;
    render();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      selected = Math.min(selected + 1, rows.length - 1);
    } else if (e.key === 'ArrowUp') {
      selected = Math.max(selected - 1, 0);
    } else if (e.key === 'PageDown') {
      selected = Math.min(selected + 10, rows.length - 1);
    } else if (e.key === 'PageUp') {
      selected = Math.max(selected - 10, 0);
    } else if (e.key === 'Home' && e.ctrlKey) {
      selected = 0;
    } else if (e.key === 'End' && e.ctrlKey) {
      selected = rows.length - 1;
    } else if (e.key === 'Enter') {
      const row = rows[selected];
      if (row) void run(row.entry.id);
      e.preventDefault();
      return;
    } else return;
    e.preventDefault();
    render();
  });
  dialog.addEventListener('close', () => {
    dialog.remove();
    if (current === dialog) current = null;
  });

  dialog.append(input, list, hint);
  document.body.append(dialog);
  render();
  dialog.showModal();
  input.focus();
  current = dialog;
  return dialog;
}

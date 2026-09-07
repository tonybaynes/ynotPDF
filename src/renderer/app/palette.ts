/**
 * Command palette (M00 minimal version; M02 restyles it). Lists every enabled, non-hidden
 * command from the Registry, filters as you type, Enter runs, Escape closes. Fully opaque.
 */

import { formatShortcut, type PaletteEntry, type Registry } from '@core/Registry';

let current: HTMLDialogElement | null = null;

export function openPalette(registry: Registry): HTMLDialogElement {
  if (current?.open) {
    current.querySelector('input')?.focus();
    return current;
  }
  const dialog = document.createElement('dialog');
  dialog.id = 'command-palette';
  dialog.className = 'palette';
  dialog.setAttribute('aria-label', 'Command palette');

  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = 'Type a command…';
  input.setAttribute('aria-label', 'Search commands');
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-expanded', 'true');
  input.setAttribute('aria-controls', 'palette-list');

  const list = document.createElement('ul');
  list.id = 'palette-list';
  list.setAttribute('role', 'listbox');

  const isMac = registry.hasService('platform')
    ? registry.service<{ isMac: boolean }>('platform').isMac
    : false;
  let entries: PaletteEntry[] = registry.paletteEntries();
  let selected = 0;

  const render = (): void => {
    const q = input.value.trim().toLowerCase();
    entries = registry
      .paletteEntries()
      .filter((e) => !q || `${e.category} ${e.label} ${e.id}`.toLowerCase().includes(q));
    selected = Math.min(selected, Math.max(0, entries.length - 1));
    list.replaceChildren(
      ...entries.map((e, i) => {
        const li = document.createElement('li');
        li.setAttribute('role', 'option');
        li.setAttribute('aria-selected', i === selected ? 'true' : 'false');
        li.dataset['command'] = e.id;
        const left = document.createElement('span');
        const cat = document.createElement('span');
        cat.className = 'cat';
        cat.textContent = e.category;
        left.append(cat, e.label);
        const key = document.createElement('span');
        key.className = 'key';
        key.textContent = e.shortcut ? formatShortcut(e.shortcut, isMac) : '';
        li.append(left, key);
        li.addEventListener('click', () => {
          void run(e.id);
        });
        return li;
      }),
    );
    if (entries.length === 0) {
      const li = document.createElement('li');
      li.textContent = 'No matching commands';
      list.append(li);
    }
  };

  const run = async (id: string): Promise<void> => {
    dialog.close();
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
      selected = Math.min(selected + 1, entries.length - 1);
      render();
      e.preventDefault();
    } else if (e.key === 'ArrowUp') {
      selected = Math.max(selected - 1, 0);
      render();
      e.preventDefault();
    } else if (e.key === 'Enter') {
      const entry = entries[selected];
      if (entry) void run(entry.id);
      e.preventDefault();
    }
  });
  dialog.addEventListener('close', () => {
    dialog.remove();
    if (current === dialog) current = null;
  });

  dialog.append(input, list);
  document.body.append(dialog);
  render();
  dialog.showModal();
  input.focus();
  current = dialog;
  return dialog;
}

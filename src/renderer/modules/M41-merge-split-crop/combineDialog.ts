/**
 * The Combine Files dialog (M41).
 *
 * A list the reader builds: add files, drop them in from Explorer or Finder, reorder them, say
 * which pages of each one to take, and see the first page of each as a thumbnail so a list of
 * twenty files named `scan_0001.pdf` is still a list of twenty *different* files.
 *
 * Reordering is done with buttons as well as by dragging, because a drag is not a keyboard path
 * and every control in this app has to have one. The list is a real listbox: arrow keys move the
 * focus, `Alt+Up` / `Alt+Down` move the file.
 *
 * Nothing here touches a document. The dialog answers with a plain description of what to do and
 * `MergeService` does it.
 */

import { field, formGrid, type DialogHandle, type Dialogs } from '@app/dialog/Dialogs';
import { append, button, el } from '@app/dom';
import { icon } from '@app/icons';
import type { PageSizeRule } from '@engine/ops/combine';
import type { PdfEngine } from '@engine/PdfEngine';
import { formatRange, parseRange } from '@modules/M40-organise-pages/range';
import { PAGE_SIZE_PRESETS, choiceToPortraitPoints, findPreset } from '@shared/pageSizes';
import { checkbox, select } from './fields';
import type { CombineAddResult, CombineReadHooks } from './combineInputs';

/** One row of the list, as the dialog holds it. */
export interface CombineEntry {
  readonly name: string;
  readonly bytes: Uint8Array;
  /** Absolute path when it came from disk; only used for the tooltip. */
  readonly path?: string;
  /** 0-based pages to take, or `null` for all of them. */
  pages: ReadonlyArray<number> | null;
  /** What the reader typed in the range box, kept so a bad range is not silently forgotten. */
  rangeText: string;
  /** Filled in once the file has been opened; `null` while it has not. */
  pageCount: number | null;
}

export interface CombineChoice {
  readonly entries: ReadonlyArray<CombineEntry>;
  readonly bookmarkPerFile: boolean;
  readonly keepBookmarks: boolean;
  readonly pageSize: PageSizeRule;
  readonly toNewTab: boolean;
}

export interface CombineDialogOptions {
  readonly dialogs: Dialogs;
  readonly engine: PdfEngine;
  readonly entries: ReadonlyArray<CombineEntry>;
  readonly bookmarkPerFile: boolean;
  readonly keepBookmarks: boolean;
  readonly toNewTab: boolean;
  /** Opens the OS file picker and answers with what it read. */
  readonly addFiles: (hooks: CombineReadHooks) => Promise<CombineAddResult>;
  readonly addFolder: (recursive: boolean, hooks: CombineReadHooks) => Promise<CombineAddResult>;
  readonly addDropped: (
    files: ReadonlyArray<File>,
    hooks: CombineReadHooks,
  ) => Promise<CombineAddResult>;
  /** Whether an output file can be written at all (a browser run cannot). */
  readonly canSaveToFile: boolean;
}

/** Page-size choices, in the words Foxit uses for the same three ideas. */
const SIZE_CHOICES = [
  { value: 'keep', label: 'Leave every page as it is' },
  { value: 'first', label: 'Make every page the size of the first' },
  { value: 'largest', label: 'Make every page the size of the largest' },
] as const;

/**
 * What the picker offers: one of the three rules, or `preset:<id>` for a paper size from
 * `resources/page-sizes.json`. A plain string rather than a union, because the presets are data.
 */
type SizeChoice = string;

export async function askCombine(options: CombineDialogOptions): Promise<CombineChoice | null> {
  const entries: CombineEntry[] = options.entries.map((e) => ({ ...e }));
  let focused = 0;
  let sizeChoice: SizeChoice = 'keep';
  let handle: DialogHandle | null = null;
  const controller = new AbortController();
  let pending = 0;
  let queue = Promise.resolve();

  const list = el('div.ops-files', {
    role: 'listbox',
    'aria-label': 'Files to combine',
    tabindex: '0',
  });
  const empty = el('p.ops-empty', null, 'No files yet. Add files or a folder, or drop files here.');
  const totalLine = el('p.field-hint.ops-summary', { role: 'status' });
  const reading = el('p.ops-summary', { role: 'status' });
  const problems = el('div.ops-input-problems', { role: 'alert' });
  const includeSubfolders = checkbox({ label: 'Include subfolders', checked: true });

  const validate = (): void => {
    handle?.setEnabled(
      'ok',
      pending === 0 &&
        entries.length > 0 &&
        entries.every(
          (entry) =>
            (entry.pageCount ?? 0) > 0 && (entry.rangeText.trim() === '' || entry.pages !== null),
        ),
    );
  };

  const bookmarkPerFile = checkbox({
    label: 'Add a bookmark for each file, named after the file',
    checked: options.bookmarkPerFile,
  });
  const keepBookmarks = checkbox({
    label: 'Keep each file’s own bookmarks',
    checked: options.keepBookmarks,
    hint: 'They are nested under that file’s own bookmark.',
  });
  const pageSize = select<SizeChoice>({
    label: 'Page size',
    value: 'keep',
    choices: [
      ...SIZE_CHOICES.map((c) => ({ value: c.value, label: c.label })),
      ...PAGE_SIZE_PRESETS.map((p) => ({
        value: `preset:${p.id}`,
        label: `Make every page ${p.label}`,
      })),
    ],
    hint: 'Pages are re-boxed and centred, never scaled, so nothing changes size on the page.',
    onChange: (value) => {
      sizeChoice = value;
    },
  });
  const toNewTab = checkbox({
    label: 'Open the result in a new tab',
    checked: options.toNewTab && options.canSaveToFile ? options.toNewTab : true,
    hint: options.canSaveToFile
      ? 'Off saves it straight to a file you choose.'
      : 'Saving straight to a file needs the desktop app.',
  });
  if (!options.canSaveToFile) {
    toNewTab.input.checked = true;
    toNewTab.input.disabled = true;
  }

  const refresh = (): void => {
    list.replaceChildren();
    if (entries.length === 0) {
      list.append(empty);
    } else {
      entries.forEach((entry, index) => {
        list.append(rowFor(entry, index));
      });
    }
    const pages = entries.reduce((n, e) => n + (e.pages ? e.pages.length : (e.pageCount ?? 0)), 0);
    totalLine.textContent =
      entries.length === 0
        ? ''
        : `${String(entries.length)} ${entries.length === 1 ? 'file' : 'files'}, ${String(pages)} ${pages === 1 ? 'page' : 'pages'}`;
    validate();
  };

  const move = (from: number, to: number): void => {
    if (to < 0 || to >= entries.length) return;
    const [entry] = entries.splice(from, 1);
    if (!entry) return;
    entries.splice(to, 0, entry);
    focused = to;
    refresh();
    focusRow(to);
  };

  const focusRow = (index: number): void => {
    const row = list.querySelectorAll<HTMLElement>('[role="option"]')[index];
    row?.focus();
  };

  function rowFor(entry: CombineEntry, index: number): HTMLElement {
    const row = el('div.ops-file', {
      role: 'option',
      tabindex: index === focused ? '0' : '-1',
      'aria-selected': index === focused ? 'true' : 'false',
      draggable: 'true',
      title: entry.path ?? entry.name,
    });
    const thumb = el('div.ops-file-thumb', { 'aria-hidden': 'true' });
    void paintThumbnail(options.engine, entry, thumb);

    const rangeInput = el('input.input.ops-file-range', {
      type: 'text',
      value: entry.rangeText,
      spellcheck: 'false',
      'aria-label': `Pages of ${entry.name}`,
      placeholder: 'All pages',
    });
    const rangeNote = el('span.ops-file-note', { role: 'status' });
    const readRange = (): void => {
      const text = rangeInput.value.trim();
      entry.rangeText = text;
      if (text === '') {
        entry.pages = null;
        rangeNote.textContent = entry.pageCount === null ? '' : `${String(entry.pageCount)} pages`;
        rangeInput.removeAttribute('aria-invalid');
        refreshTotal();
        return;
      }
      const parsed = parseRange(text, {
        pageCount: entry.pageCount ?? 0,
        currentPage: 0,
        selectedPages: [],
        pageSizes: [],
      });
      if (parsed.error !== null) {
        rangeInput.setAttribute('aria-invalid', 'true');
        rangeNote.textContent = parsed.error;
        entry.pages = null;
        validate();
        return;
      }
      rangeInput.removeAttribute('aria-invalid');
      entry.pages = parsed.pages;
      rangeNote.textContent = `${String(parsed.pages.length)} of ${String(entry.pageCount ?? 0)}`;
      refreshTotal();
    };
    rangeInput.addEventListener('input', readRange);

    const up = button('btn btn-icon', { title: 'Move up' }, icon('chevron-up'));
    up.addEventListener('click', () => {
      move(index, index - 1);
    });
    const down = button('btn btn-icon', { title: 'Move down' }, icon('chevron-down'));
    down.addEventListener('click', () => {
      move(index, index + 1);
    });
    const remove = button('btn btn-icon', { title: `Remove ${entry.name}` }, icon('x'));
    remove.addEventListener('click', () => {
      entries.splice(index, 1);
      focused = Math.max(0, Math.min(focused, entries.length - 1));
      refresh();
    });

    row.addEventListener('focus', () => {
      focused = index;
    });
    row.addEventListener('keydown', (event) => {
      if (event.target !== row) return;
      if (event.key === 'ArrowDown' && !event.altKey) {
        event.preventDefault();
        focusRow(Math.min(entries.length - 1, index + 1));
      } else if (event.key === 'ArrowUp' && !event.altKey) {
        event.preventDefault();
        focusRow(Math.max(0, index - 1));
      } else if (event.altKey && event.key === 'ArrowUp') {
        event.preventDefault();
        move(index, index - 1);
      } else if (event.altKey && event.key === 'ArrowDown') {
        event.preventDefault();
        move(index, index + 1);
      } else if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault();
        entries.splice(index, 1);
        focused = Math.max(0, Math.min(focused, entries.length - 1));
        refresh();
      }
    });

    row.addEventListener('dragstart', (event) => {
      event.dataTransfer?.setData('application/x-ynot-combine-row', String(index));
      if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
    });
    row.addEventListener('dragover', (event) => {
      if (!event.dataTransfer?.types.includes('application/x-ynot-combine-row')) return;
      event.preventDefault();
      row.dataset['dropTarget'] = 'true';
    });
    row.addEventListener('dragleave', () => {
      delete row.dataset['dropTarget'];
    });
    row.addEventListener('drop', (event) => {
      const raw = event.dataTransfer?.getData('application/x-ynot-combine-row');
      delete row.dataset['dropTarget'];
      if (raw === undefined || raw === '') return;
      event.preventDefault();
      event.stopPropagation();
      const from = Number(raw);
      if (Number.isInteger(from) && from >= 0 && from < entries.length) move(from, index);
    });

    const meta = el('div.ops-file-meta');
    meta.append(
      el('span.ops-file-name', null, entry.name),
      el(
        'span.ops-file-count',
        null,
        entry.pageCount === null
          ? 'Reading…'
          : entry.pageCount === 0
            ? 'Cannot read this PDF'
            : `${String(entry.pageCount)} pages`,
      ),
    );
    const controls = el('div.ops-file-controls');
    controls.append(rangeInput, rangeNote, up, down, remove);
    row.append(thumb, meta, controls);
    readRange();
    return row;
  }

  const refreshTotal = (): void => {
    const pages = entries.reduce((n, e) => n + (e.pages ? e.pages.length : (e.pageCount ?? 0)), 0);
    totalLine.textContent =
      entries.length === 0
        ? ''
        : `${String(entries.length)} ${entries.length === 1 ? 'file' : 'files'}, ${String(pages)} ${pages === 1 ? 'page' : 'pages'}`;
    validate();
  };

  /** Fills in every entry's page count; one at a time, so a big list does not open the file
   * handles all at once. */
  const countEvery = async (): Promise<void> => {
    for (const entry of entries) {
      if (controller.signal.aborted) return;
      await countPagesOf(options.engine, entry);
    }
  };

  const add = button('btn', null, icon('file-plus'), ' Add files…');
  const addFolder = button('btn', null, icon('folder-open'), ' Add folder…');
  const clearAll = button('btn', null, 'Remove all');
  const enqueue = (read: (hooks: CombineReadHooks) => Promise<CombineAddResult>): void => {
    pending++;
    add.disabled = addFolder.disabled = clearAll.disabled = true;
    validate();
    queue = queue.then(async () => {
      try {
        if (controller.signal.aborted) return;
        const added = await read({
          signal: controller.signal,
          progress: (message) => {
            if (!controller.signal.aborted) reading.textContent = message;
          },
        });
        if (controller.signal.aborted) return;
        entries.push(...added.entries.map((entry) => ({ ...entry })));
        await countEvery();
        if (controller.signal.aborted) return;
        for (const problem of added.problems) problems.append(el('p', null, problem));
        refresh();
      } catch (error) {
        if (!controller.signal.aborted)
          problems.append(el('p', null, error instanceof Error ? error.message : String(error)));
      } finally {
        pending--;
        if (!controller.signal.aborted) {
          add.disabled = addFolder.disabled = clearAll.disabled = pending > 0;
          if (pending === 0) reading.textContent = '';
          validate();
        }
      }
    });
  };
  add.addEventListener('click', () => {
    enqueue(options.addFiles);
  });
  addFolder.addEventListener('click', () => {
    const recursive = includeSubfolders.input.checked;
    enqueue((hooks) => options.addFolder(recursive, hooks));
  });
  clearAll.addEventListener('click', () => {
    entries.length = 0;
    problems.replaceChildren();
    refresh();
  });

  const body = el('div.ops-dialog');
  const toolbar = el('div.ops-toolbar');
  toolbar.append(add, addFolder, clearAll);
  body.append(
    toolbar,
    includeSubfolders.element,
    reading,
    list,
    problems,
    totalLine,
    formGrid(
      field({ label: 'Bookmarks', input: bookmarkPerFile.element }),
      field({ label: ' ', input: keepBookmarks.element }),
      pageSize.element,
      field({ label: 'Where the result goes', input: toNewTab.element }),
    ),
  );

  // Files dropped from the desktop onto the dialog are the same thing as pressing Add.
  const dragover = (event: DragEvent): void => {
    if (!event.dataTransfer?.types.includes('Files')) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'copy';
  };
  const drop = (event: DragEvent): void => {
    if (!event.dataTransfer?.types.includes('Files')) return;
    event.preventDefault();
    event.stopPropagation();
    const files = Array.from(event.dataTransfer.files);
    if (files.length > 0) enqueue((hooks) => options.addDropped(files, hooks));
  };

  await countEvery();

  handle = options.dialogs.open({
    title: 'Combine files',
    id: 'ops-combine',
    width: 720,
    className: 'ops-wide',
    content: body,
    buttons: [
      { id: 'cancel', label: 'Cancel' },
      { id: 'ok', label: 'Combine', primary: true },
    ],
  });
  handle.element.addEventListener('dragover', dragover);
  handle.element.addEventListener('drop', drop);
  refresh();

  const result = await handle.result;
  controller.abort();
  if (result !== 'ok' || entries.length === 0) return null;
  return {
    entries: entries.map((e) => ({ ...e })),
    bookmarkPerFile: bookmarkPerFile.input.checked,
    keepBookmarks: keepBookmarks.input.checked,
    pageSize: ruleFor(sizeChoice),
    toNewTab: toNewTab.input.checked,
  };
}

/** The page-size rule a choice means. */
export function ruleFor(choice: SizeChoice): PageSizeRule {
  if (choice === 'first') return { kind: 'first' };
  if (choice === 'largest') return { kind: 'largest' };
  if (choice.startsWith('preset:')) {
    const id = choice.slice('preset:'.length);
    if (findPreset(id)) {
      const size = choiceToPortraitPoints({ kind: 'preset', id });
      return { kind: 'fixed', width: size.width, height: size.height };
    }
  }
  return { kind: 'keep' };
}

/** Fills in a file's page count by opening it, and never throws — a bad file shows "cannot read". */
async function countPagesOf(engine: PdfEngine, entry: CombineEntry): Promise<void> {
  if (entry.pageCount !== null) return;
  try {
    const handle = await engine.open(new Uint8Array(entry.bytes), { name: entry.name });
    try {
      entry.pageCount = await engine.pageCount(handle);
    } finally {
      await engine.close(handle).catch(() => undefined);
    }
  } catch {
    entry.pageCount = 0;
  }
}

/**
 * Draws the first page of a file into its row.
 *
 * Failure is silent on purpose: a file whose first page will not render still combines perfectly
 * well, and a red box where a picture should be would say otherwise.
 */
async function paintThumbnail(
  engine: PdfEngine,
  entry: CombineEntry,
  host: HTMLElement,
): Promise<void> {
  try {
    const handle = await engine.open(new Uint8Array(entry.bytes), { name: entry.name });
    try {
      if ((await engine.pageCount(handle)) === 0) return;
      const size = await engine.pageSize(handle, 0);
      const scale = Math.min(64 / size.width, 84 / size.height);
      const { bitmap } = await engine.render(handle, 0, scale, undefined, { background: 0xffffff });
      const canvas = el('canvas.ops-file-canvas');
      canvas.width = Math.max(1, Math.round(size.width * scale));
      canvas.height = Math.max(1, Math.round(size.height * scale));
      const context = canvas.getContext('2d');
      if (!context) return;
      context.drawImage(bitmap, 0, 0);
      bitmap.close?.();
      host.replaceChildren(canvas);
    } finally {
      await engine.close(handle).catch(() => undefined);
    }
  } catch {
    // No picture; the row still shows the name and the page count.
  }
}

/** Re-exported for the tests, which build entries without a file picker. */
export function entryFor(name: string, bytes: Uint8Array, path?: string): CombineEntry {
  return {
    name,
    bytes,
    ...(path === undefined ? {} : { path }),
    pages: null,
    rangeText: '',
    pageCount: null,
  };
}

/** The range text a list of pages would produce, for a test or a preset. */
export function rangeTextFor(pages: ReadonlyArray<number>): string {
  return formatRange(pages);
}

/** Appends nodes; kept so the dialog reads top-down. */
export { append };

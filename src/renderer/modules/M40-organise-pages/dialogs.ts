/**
 * The Organize dialogs (M40).
 *
 * Every one of them is built out of M02's dialog service, so they are opaque, keyboard-reachable
 * and themed by tokens without this file choosing a single colour. Two things recur and are
 * therefore written once: {@link rangeField}, the page-range input with its live summary and its
 * error line, and {@link pagePicker}, the thumbnail strip the brief asks Insert-from-file for.
 *
 * The dialogs return plain data or `null` for "the reader cancelled". None of them touches a
 * document — the service does that — so each can be read on its own and none can half-apply
 * something.
 */

import { field, formGrid, type DialogHandle, type Dialogs } from '@app/dialog/Dialogs';
import { el } from '@app/dom';
import { icon } from '@app/icons';
import type { DocHandle, PdfEngine } from '@engine/PdfEngine';
import type { PageSizeChoice, Orientation } from '@shared/create';
import { PAGE_SIZE_PRESETS } from '@shared/pageSizes';
import { LABEL_STYLES, formatLabel, type LabelSpec, type LabelStyle } from './labels';
import { countPages, formatRange, parseRange, type RangeContext } from './range';
import { INSERT_POSITIONS, type InsertPosition, type OrganiseSettings } from './settings';

/** A live page-range input: the field, its summary line, and what it currently means. */
interface RangeField {
  readonly element: HTMLElement;
  readonly input: HTMLInputElement;
  /** The pages the text names right now, or `null` while it does not parse. */
  pages(): ReadonlyArray<number> | null;
  /** Re-reads the text and repaints the summary. */
  refresh(): void;
  /** Called whenever what it means changes. */
  onChange(listener: () => void): void;
}

/**
 * The page-range field.
 *
 * The summary under it is the whole point: a reader who types `2-4, even` should be able to see
 * that it means one page before they act on it, and a reader who types `9` in a five-page
 * document should be told so in words rather than have three pages quietly deleted.
 */
function rangeField(options: {
  readonly label: string;
  readonly value: string;
  readonly context: RangeContext;
  readonly hint?: string;
}): RangeField {
  const input = el('input.input', { type: 'text', value: options.value, spellcheck: 'false' });
  const summary = el('p.field-hint.organise-summary', { role: 'status' });
  const error = el('p.field-error', { role: 'alert' });
  error.hidden = true;
  const listeners: Array<() => void> = [];
  let current: ReadonlyArray<number> | null = null;

  const refresh = (): void => {
    const parsed = parseRange(input.value, options.context);
    if (parsed.error !== null) {
      current = null;
      error.textContent = parsed.error;
      error.hidden = false;
      input.setAttribute('aria-invalid', 'true');
      summary.textContent = '';
    } else {
      current = parsed.pages;
      error.hidden = true;
      input.removeAttribute('aria-invalid');
      summary.textContent =
        parsed.pages.length === 0
          ? 'No pages'
          : `${countPages(parsed.pages.length)}: ${formatRange(parsed.pages)}`;
    }
    for (const listener of listeners) listener();
  };

  input.addEventListener('input', refresh);
  const wrapper = el('div.organise-range');
  wrapper.append(
    field({
      label: options.label,
      input,
      ...(options.hint === undefined ? {} : { hint: options.hint }),
    }),
    summary,
    error,
  );
  refresh();
  return {
    element: wrapper,
    input,
    pages: () => current,
    refresh,
    onChange: (listener) => listeners.push(listener),
  };
}

const RANGE_HINT =
  'Pages like 1-3, 5, 8- . You can also write odd, even, landscape, portrait, current or selected.';

/**
 * A strip of page thumbnails with a checkbox on each, kept in step with a range field: ticking a
 * page rewrites the text, and typing in the text re-ticks the pages.
 *
 * Thumbnails are rendered one at a time and the strip works before any of them arrive, so a
 * five-hundred-page file does not hold the dialog shut. A page whose render fails keeps its
 * number and its checkbox and simply shows no picture, which is a page the reader can still
 * choose.
 */
async function pagePicker(options: {
  readonly engine: PdfEngine;
  readonly doc: DocHandle;
  readonly pageCount: number;
  readonly range: RangeField;
  readonly host: HTMLElement;
  readonly signal: { cancelled: boolean };
}): Promise<void> {
  const { engine, doc, pageCount, range, host } = options;
  const strip = el('div.organise-strip', {
    role: 'group',
    'aria-label': 'Pages in the file',
  });
  const cells: HTMLInputElement[] = [];

  for (let page = 0; page < pageCount; page++) {
    const box = el('input', { type: 'checkbox' });
    box.checked = true;
    box.dataset['page'] = String(page);
    const frame = el('div.organise-thumb');
    const label = el('span.organise-thumb-label', null, String(page + 1));
    const cell = el(
      'label.organise-cell',
      { title: `Page ${String(page + 1)}` },
      frame,
      el('span.organise-cell-foot', null, box, label),
    );
    box.addEventListener('change', () => {
      const chosen = cells.filter((c) => c.checked).map((c) => Number(c.dataset['page'] ?? '0'));
      range.input.value = chosen.length === pageCount ? '' : formatRange(chosen);
      range.refresh();
    });
    cells.push(box);
    strip.append(cell);
  }
  host.append(strip);

  // Typing in the field re-ticks the boxes, so the two are never telling different stories.
  range.onChange(() => {
    const pages = range.pages();
    if (!pages) return;
    const wanted = new Set(pages);
    for (const box of cells) box.checked = wanted.has(Number(box.dataset['page'] ?? '0'));
  });

  for (let page = 0; page < pageCount; page++) {
    if (options.signal.cancelled) return;
    const cell = strip.children[page]?.querySelector<HTMLElement>('.organise-thumb');
    if (!cell) continue;
    try {
      const size = await engine.pageSize(doc, page);
      const scale = Math.min(1, 96 / Math.max(1, size.width));
      const render = await engine.render(doc, page, scale);
      if (options.signal.cancelled) return;
      const canvas = el('canvas', { 'aria-hidden': 'true' });
      canvas.width = render.bitmap.width;
      canvas.height = render.bitmap.height;
      canvas.style.width = `${String(Math.round(size.width * scale))}px`;
      canvas.style.height = `${String(Math.round(size.height * scale))}px`;
      canvas.getContext('2d')?.drawImage(render.bitmap, 0, 0);
      cell.replaceChildren(canvas);
    } catch {
      // A page that will not render is still a page that can be chosen; leave the frame empty.
    }
  }
}

/** Common footer buttons. */
const OK_CANCEL = (
  okLabel: string,
): ReadonlyArray<{ id: string; label: string; primary?: boolean }> => [
  { id: 'ok', label: okLabel, primary: true },
  { id: 'cancel', label: 'Cancel' },
];

/** A `<select>` built from options, with one pre-chosen. */
function select(
  choices: ReadonlyArray<{ readonly value: string; readonly label: string }>,
  chosen: string,
): HTMLSelectElement {
  const element = el('select.input');
  for (const choice of choices) {
    const option = el('option', { value: choice.value }, choice.label);
    if (choice.value === chosen) option.setAttribute('selected', '');
    element.append(option);
  }
  element.value = chosen;
  return element;
}

function numberInput(value: number, min: number, max: number): HTMLInputElement {
  return el('input.input', {
    type: 'number',
    value: String(value),
    min: String(min),
    max: String(max),
    step: '1',
  });
}

// ---- insert blank ------------------------------------------------------------------------------

export interface BlankPagesAnswer {
  readonly count: number;
  readonly size: PageSizeChoice;
  readonly orientation: Orientation;
  readonly position: InsertPosition;
  /** True when the reader chose "same as the current page"; the service supplies the size. */
  readonly matchCurrent: boolean;
}

export async function askBlankPages(
  dialogs: Dialogs,
  options: { readonly settings: OrganiseSettings; readonly matchSize: string | null },
): Promise<BlankPagesAnswer | null> {
  const count = numberInput(1, 1, 999);
  const sizes = select(
    [
      ...(options.matchSize === null
        ? []
        : [{ value: 'match', label: `Same as the current page (${options.matchSize})` }]),
      ...PAGE_SIZE_PRESETS.map((p) => ({ value: p.id, label: `${p.label} (${p.group})` })),
    ],
    options.matchSize === null ? options.settings.blankPageSize : 'match',
  );
  const orientation = select(
    [
      { value: 'portrait', label: 'Portrait' },
      { value: 'landscape', label: 'Landscape' },
    ],
    'portrait',
  );
  const position = select([...INSERT_POSITIONS], options.settings.insertPosition);

  const result = await dialogs.open({
    title: 'Insert blank pages',
    id: 'organise-insert-blank',
    width: 460,
    content: (body) => {
      body.append(
        formGrid(
          field({ label: 'How many pages', input: count }),
          field({ label: 'Page size', input: sizes }),
          field({ label: 'Orientation', input: orientation }),
          field({ label: 'Where', input: position }),
        ),
      );
    },
    initialFocus: count,
    buttons: OK_CANCEL('Insert'),
  }).result;
  if (result !== 'ok') return null;
  const matchCurrent = sizes.value === 'match';
  return {
    count: Math.max(1, Math.min(999, Number(count.value) || 1)),
    size: {
      kind: 'preset',
      id: matchCurrent ? options.settings.blankPageSize : sizes.value,
    },
    orientation: orientation.value === 'landscape' ? 'landscape' : 'portrait',
    position: position.value as InsertPosition,
    matchCurrent,
  };
}

// ---- insert from a file ------------------------------------------------------------------------

export interface InsertFileAnswer {
  readonly pages: ReadonlyArray<number>;
  readonly position: InsertPosition;
  readonly keepBookmarks: boolean;
}

export async function askInsertFromFile(
  dialogs: Dialogs,
  options: {
    readonly name: string;
    readonly engine: PdfEngine;
    readonly doc: DocHandle;
    readonly pageCount: number;
    readonly settings: OrganiseSettings;
  },
): Promise<InsertFileAnswer | null> {
  const context: RangeContext = {
    pageCount: options.pageCount,
    currentPage: 0,
    selectedPages: [],
  };
  const range = rangeField({
    label: `Pages of ${options.name}`,
    value: '',
    context,
    hint: RANGE_HINT,
  });
  const position = select([...INSERT_POSITIONS], options.settings.insertPosition);
  const keep = el('input', { type: 'checkbox' });
  keep.checked = options.settings.keepBookmarksOnInsert;

  const signal = { cancelled: false };
  let handle: DialogHandle | null = null;
  handle = dialogs.open({
    title: 'Insert pages from a file',
    id: 'organise-insert-file',
    width: 620,
    content: (body) => {
      body.append(range.element);
      void pagePicker({
        engine: options.engine,
        doc: options.doc,
        pageCount: options.pageCount,
        range,
        host: body,
        signal,
      });
      body.append(
        formGrid(
          field({ label: 'Where', input: position }),
          field({ label: 'Bring the bookmarks too', input: keep }),
        ),
      );
    },
    initialFocus: range.input,
    buttons: OK_CANCEL('Insert'),
  });
  // A field that does not parse must not be actionable — the reader would not know what happened.
  range.onChange(() => {
    handle?.setEnabled('ok', (range.pages()?.length ?? 0) > 0);
  });
  const result = await handle.result;
  signal.cancelled = true;
  if (result !== 'ok') return null;
  const pages = range.pages();
  if (!pages || pages.length === 0) return null;
  return { pages, position: position.value as InsertPosition, keepBookmarks: keep.checked };
}

// ---- extract -----------------------------------------------------------------------------------

export type ExtractDestination = 'tab' | 'file' | 'perPage';

export interface ExtractAnswer {
  readonly pages: ReadonlyArray<number>;
  readonly destination: ExtractDestination;
  readonly withComments: boolean;
  readonly deleteAfter: boolean;
}

export async function askExtract(
  dialogs: Dialogs,
  options: {
    readonly context: RangeContext;
    readonly value: string;
    readonly settings: OrganiseSettings;
  },
): Promise<ExtractAnswer | null> {
  const range = rangeField({
    label: 'Pages to extract',
    value: options.value,
    context: options.context,
    hint: RANGE_HINT,
  });
  const destination = select(
    [
      { value: 'tab', label: 'Open in a new tab' },
      { value: 'file', label: 'Save as one PDF file' },
      { value: 'perPage', label: 'Save as one PDF file per page' },
    ],
    'tab',
  );
  const comments = el('input', { type: 'checkbox' });
  comments.checked = options.settings.extractWithComments;
  const deleteAfter = el('input', { type: 'checkbox' });

  let handle: DialogHandle | null = null;
  handle = dialogs.open({
    title: 'Extract pages',
    id: 'organise-extract',
    width: 480,
    content: (body) => {
      body.append(
        range.element,
        formGrid(
          field({ label: 'What to do with them', input: destination }),
          field({ label: 'Keep the comments', input: comments }),
          field({
            label: 'Delete them from this document afterwards',
            input: deleteAfter,
          }),
        ),
      );
    },
    initialFocus: range.input,
    buttons: OK_CANCEL('Extract'),
  });
  range.onChange(() => {
    handle?.setEnabled('ok', (range.pages()?.length ?? 0) > 0);
  });
  const result = await handle.result;
  if (result !== 'ok') return null;
  const pages = range.pages();
  if (!pages || pages.length === 0) return null;
  return {
    pages,
    destination: destination.value as ExtractDestination,
    withComments: comments.checked,
    deleteAfter: deleteAfter.checked,
  };
}

// ---- replace -----------------------------------------------------------------------------------

export interface ReplaceAnswer {
  readonly target: ReadonlyArray<number>;
  readonly source: ReadonlyArray<number>;
}

export async function askReplace(
  dialogs: Dialogs,
  options: {
    readonly context: RangeContext;
    readonly value: string;
    readonly sourceName: string;
    readonly sourcePageCount: number;
  },
): Promise<ReplaceAnswer | null> {
  const target = rangeField({
    label: 'Pages in this document to replace',
    value: options.value,
    context: options.context,
    hint: RANGE_HINT,
  });
  const source = rangeField({
    label: `Pages of ${options.sourceName} to put there`,
    value: '',
    context: { pageCount: options.sourcePageCount, currentPage: 0, selectedPages: [] },
    hint: RANGE_HINT,
  });

  let handle: DialogHandle | null = null;
  const update = (): void => {
    const ok = (target.pages()?.length ?? 0) > 0 && (source.pages()?.length ?? 0) > 0;
    handle?.setEnabled('ok', ok);
  };
  handle = dialogs.open({
    title: 'Replace pages',
    id: 'organise-replace',
    width: 520,
    content: (body) => {
      body.append(
        target.element,
        source.element,
        el(
          'p.field-hint',
          null,
          'The replacement pages go in where the first replaced page was. The numbers do not have to match.',
        ),
      );
    },
    initialFocus: target.input,
    buttons: OK_CANCEL('Replace'),
  });
  target.onChange(update);
  source.onChange(update);
  update();
  const result = await handle.result;
  if (result !== 'ok') return null;
  const t = target.pages();
  const s = source.pages();
  if (!t || !s || t.length === 0 || s.length === 0) return null;
  return { target: t, source: s };
}

// ---- move --------------------------------------------------------------------------------------

export interface MoveAnswer {
  readonly pages: ReadonlyArray<number>;
  /** 0-based visual index to insert before. */
  readonly to: number;
}

export async function askMove(
  dialogs: Dialogs,
  options: { readonly context: RangeContext; readonly value: string },
): Promise<MoveAnswer | null> {
  const range = rangeField({
    label: 'Pages to move',
    value: options.value,
    context: options.context,
    hint: RANGE_HINT,
  });
  const where = select(
    [
      { value: 'first', label: 'To the start of the document' },
      { value: 'last', label: 'To the end of the document' },
      { value: 'before', label: 'Before page…' },
      { value: 'after', label: 'After page…' },
    ],
    'first',
  );
  const anchor = numberInput(1, 1, Math.max(1, options.context.pageCount));
  const anchorField = field({ label: 'Page number', input: anchor });
  const sync = (): void => {
    anchorField.hidden = where.value === 'first' || where.value === 'last';
  };
  where.addEventListener('change', sync);

  let handle: DialogHandle | null = null;
  handle = dialogs.open({
    title: 'Move pages',
    id: 'organise-move',
    width: 460,
    content: (body) => {
      body.append(range.element, formGrid(field({ label: 'Where', input: where }), anchorField));
      sync();
    },
    initialFocus: range.input,
    buttons: OK_CANCEL('Move'),
  });
  range.onChange(() => {
    handle?.setEnabled('ok', (range.pages()?.length ?? 0) > 0);
  });
  const result = await handle.result;
  if (result !== 'ok') return null;
  const pages = range.pages();
  if (!pages || pages.length === 0) return null;
  const at = Math.max(1, Math.min(options.context.pageCount, Number(anchor.value) || 1)) - 1;
  const to =
    where.value === 'first'
      ? 0
      : where.value === 'last'
        ? options.context.pageCount
        : where.value === 'before'
          ? at
          : at + 1;
  return { pages, to };
}

// ---- swap --------------------------------------------------------------------------------------

export async function askSwap(
  dialogs: Dialogs,
  options: { readonly pageCount: number; readonly first: number },
): Promise<{ readonly a: number; readonly b: number } | null> {
  const a = numberInput(options.first + 1, 1, options.pageCount);
  const b = numberInput(Math.min(options.first + 2, options.pageCount), 1, options.pageCount);
  const result = await dialogs.open({
    title: 'Swap two pages',
    id: 'organise-swap',
    width: 420,
    content: (body) => {
      body.append(
        formGrid(field({ label: 'Page', input: a }), field({ label: 'and page', input: b })),
      );
    },
    initialFocus: a,
    buttons: OK_CANCEL('Swap'),
  }).result;
  if (result !== 'ok') return null;
  const first = Math.max(1, Math.min(options.pageCount, Number(a.value) || 1)) - 1;
  const second = Math.max(1, Math.min(options.pageCount, Number(b.value) || 1)) - 1;
  return first === second ? null : { a: first, b: second };
}

// ---- rotate ------------------------------------------------------------------------------------

export interface RotateAnswer {
  readonly pages: ReadonlyArray<number>;
  readonly degrees: 90 | 180 | 270;
}

export async function askRotate(
  dialogs: Dialogs,
  options: { readonly context: RangeContext; readonly value: string },
): Promise<RotateAnswer | null> {
  const range = rangeField({
    label: 'Pages to rotate',
    value: options.value,
    context: options.context,
    hint: RANGE_HINT,
  });
  const degrees = select(
    [
      { value: '90', label: '90° clockwise' },
      { value: '180', label: '180°' },
      { value: '270', label: '90° anticlockwise' },
    ],
    '90',
  );
  let handle: DialogHandle | null = null;
  handle = dialogs.open({
    title: 'Rotate pages',
    id: 'organise-rotate',
    width: 460,
    content: (body) => {
      body.append(range.element, formGrid(field({ label: 'Turn them', input: degrees })));
    },
    initialFocus: range.input,
    buttons: OK_CANCEL('Rotate'),
  });
  range.onChange(() => {
    handle?.setEnabled('ok', (range.pages()?.length ?? 0) > 0);
  });
  const result = await handle.result;
  if (result !== 'ok') return null;
  const pages = range.pages();
  if (!pages || pages.length === 0) return null;
  return { pages, degrees: Number(degrees.value) as 90 | 180 | 270 };
}

// ---- page labels -------------------------------------------------------------------------------

export interface LabelAnswer extends LabelSpec {
  readonly pages: ReadonlyArray<number>;
}

/**
 * The Page Labels dialog. It shows what the first three pages would be called as the reader
 * types, because "prefix A-, roman, start 3" is not something anyone can picture from the fields
 * alone.
 */
export async function askPageLabels(
  dialogs: Dialogs,
  options: { readonly context: RangeContext; readonly value: string; readonly spec: LabelSpec },
): Promise<LabelAnswer | null> {
  const range = rangeField({
    label: 'Pages to renumber',
    value: options.value,
    context: options.context,
    hint: RANGE_HINT,
  });
  const style = select([...LABEL_STYLES], options.spec.style);
  const prefix = el('input.input', { type: 'text', value: options.spec.prefix });
  const start = numberInput(options.spec.start, 1, 100000);
  const preview = el('p.field-hint.organise-preview', { role: 'status' });

  const spec = (): LabelSpec => ({
    style: style.value as LabelStyle,
    prefix: prefix.value,
    start: Math.max(1, Number(start.value) || 1),
  });
  const refresh = (): void => {
    const pages = range.pages() ?? [];
    const current = spec();
    const shown = pages.slice(0, 3).map((_, i) => formatLabel(current, i));
    preview.textContent =
      shown.length === 0
        ? ''
        : `They will be called ${shown.join(', ')}${pages.length > 3 ? ', …' : ''}`;
  };
  for (const control of [style, prefix, start]) {
    control.addEventListener('input', refresh);
    control.addEventListener('change', refresh);
  }
  range.onChange(refresh);

  let handle: DialogHandle | null = null;
  handle = dialogs.open({
    title: 'Page numbering',
    id: 'organise-labels',
    width: 480,
    content: (body) => {
      body.append(
        range.element,
        formGrid(
          field({ label: 'Numbering', input: style }),
          field({
            label: 'Text before the number',
            input: prefix,
            hint: 'For example A- gives A-1, A-2.',
          }),
          field({ label: 'Start numbering at', input: start }),
        ),
        preview,
      );
      refresh();
    },
    initialFocus: range.input,
    buttons: OK_CANCEL('Renumber'),
  });
  range.onChange(() => {
    handle?.setEnabled('ok', (range.pages()?.length ?? 0) > 0);
  });
  const result = await handle.result;
  if (result !== 'ok') return null;
  const pages = range.pages();
  if (!pages || pages.length === 0) return null;
  return { pages, ...spec() };
}

// ---- choosing another open document --------------------------------------------------------------

export async function askDocument(
  dialogs: Dialogs,
  options: {
    readonly title: string;
    readonly tabs: ReadonlyArray<{ readonly id: string; readonly title: string }>;
  },
): Promise<string | null> {
  if (options.tabs.length === 0) {
    await dialogs.info(options.title, 'No other document is open. Open one first, then try again.');
    return null;
  }
  const chooser = select(
    options.tabs.map((t) => ({ value: t.id, label: t.title })),
    options.tabs[0]?.id ?? '',
  );
  const result = await dialogs.open({
    title: options.title,
    id: 'organise-choose-document',
    width: 440,
    content: (body) => {
      body.append(formGrid(field({ label: 'Document', input: chooser })));
    },
    initialFocus: chooser,
    buttons: OK_CANCEL('Copy'),
  }).result;
  return result === 'ok' ? chooser.value : null;
}

/** A short confirmation with the pages named in words, for Delete. */
export async function confirmDelete(
  dialogs: Dialogs,
  options: { readonly pages: ReadonlyArray<number>; readonly bookmarks: number },
): Promise<boolean> {
  const what = `${countPages(options.pages.length)} (${formatRange(options.pages)})`;
  const extra =
    options.bookmarks === 0
      ? ''
      : ` ${options.bookmarks === 1 ? 'One bookmark points' : `${String(options.bookmarks)} bookmarks point`} at ${options.pages.length === 1 ? 'it' : 'them'} and will go too.`;
  return await dialogs.confirm({
    title: 'Delete pages',
    text: `Delete ${what}?${extra} You can undo this.`,
    confirmLabel: 'Delete',
    danger: true,
    id: 'organise-confirm-delete',
  });
}

/** The empty-strip placeholder, exported so the CSS and the tests agree on the class name. */
export function stripPlaceholder(text: string): HTMLElement {
  return el(
    'p.nav-empty',
    { role: 'status' },
    icon('circle-dashed', { fallbackText: '' }),
    el('span', null, text),
  );
}

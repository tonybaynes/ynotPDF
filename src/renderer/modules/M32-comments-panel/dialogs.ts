/**
 * M32's dialogs: import options, export options, and the summarise options (M32).
 *
 * All three are the shell's own `<dialog>` — fully opaque, focus-trapped, Escape cancels — with
 * the form helpers M02 provides, so they look and behave like every other dialog in the app. No
 * colour, no icon-only control, and every choice has a word.
 */

import { el } from '@app/dom';
import type { Dialogs } from '@app/dialog/Dialogs';
import { field, formGrid } from '@app/dialog/Dialogs';
import type { CommentFormat } from '@engine/xfdf';
import {
  MAX_SUMMARY_FONT_SIZE,
  MIN_SUMMARY_FONT_SIZE,
  type SummaryLayout,
  type SummarySort,
} from '@engine/summary';
import type { ImportPolicy } from './settings';

function select(
  options: ReadonlyArray<{ readonly value: string; readonly label: string }>,
  value: string,
): HTMLSelectElement {
  const s = el('select.dlg-select');
  for (const option of options) {
    const item = el('option', { value: option.value }, option.label);
    if (option.value === value) item.selected = true;
    s.append(item);
  }
  return s;
}

function checkbox(label: string, checked: boolean): { row: HTMLElement; input: HTMLInputElement } {
  const input = el('input', { type: 'checkbox' });
  input.checked = checked;
  const row = el('label.dlg-check', null, input, el('span', null, label));
  return { row, input };
}

// ---- import ---------------------------------------------------------------------------------

export interface ImportChoice {
  readonly policy: ImportPolicy;
}

/**
 * Asks how incoming comments should meet the ones already there, saying in words what each
 * choice does — "replace" and "add" are only obvious once you have been caught by the wrong one.
 */
export async function askImportOptions(
  dialogs: Dialogs,
  options: { readonly fileName: string; readonly count: number; readonly policy: ImportPolicy },
): Promise<ImportChoice | null> {
  let policy = options.policy;
  const handle = dialogs.open({
    id: 'comments-import-dialog',
    title: 'Import comments',
    width: 460,
    content: (body) => {
      body.append(
        el(
          'p.dlg-text',
          null,
          `${String(options.count)} ${options.count === 1 ? 'comment' : 'comments'} in ${options.fileName}.`,
        ),
      );
      const chooser = select(
        [
          { value: 'replace', label: 'Replace a comment that is already there' },
          { value: 'add', label: 'Add every comment as a new one' },
        ],
        policy,
      );
      chooser.addEventListener('change', () => {
        policy = chooser.value === 'add' ? 'add' : 'replace';
      });
      body.append(
        field({
          label: 'When a comment is already in this document',
          input: chooser,
          hint: 'Comments are matched by the identifier the file gives them, not by their text.',
        }),
      );
    },
    buttons: [
      { id: 'cancel', label: 'Cancel' },
      { id: 'import', label: 'Import', primary: true },
    ],
  });
  const result = await handle.result;
  return result === 'import' ? { policy } : null;
}

// ---- export ---------------------------------------------------------------------------------

export interface ExportChoice {
  readonly format: CommentFormat;
  readonly formData: boolean;
}

export async function askExportOptions(
  dialogs: Dialogs,
  options: {
    readonly count: number;
    readonly format: CommentFormat;
    readonly formData: boolean;
    readonly hasFields: boolean;
  },
): Promise<ExportChoice | null> {
  let format = options.format;
  let formData = options.formData;
  const handle = dialogs.open({
    id: 'comments-export-dialog',
    title: 'Export comments',
    width: 460,
    content: (body) => {
      body.append(
        el(
          'p.dlg-text',
          null,
          `${String(options.count)} ${options.count === 1 ? 'comment' : 'comments'} will be exported.`,
        ),
      );
      const chooser = select(
        [
          { value: 'xfdf', label: 'XFDF — the current format, XML' },
          { value: 'fdf', label: 'FDF — the older format Acrobat also writes' },
        ],
        format,
      );
      chooser.addEventListener('change', () => {
        format = chooser.value === 'fdf' ? 'fdf' : 'xfdf';
      });
      body.append(field({ label: 'File format', input: chooser }));
      if (options.hasFields) {
        const check = checkbox('Include the form field values as well', formData);
        check.input.addEventListener('change', () => {
          formData = check.input.checked;
        });
        body.append(check.row);
      }
    },
    buttons: [
      { id: 'cancel', label: 'Cancel' },
      { id: 'export', label: 'Export', primary: true },
    ],
  });
  const result = await handle.result;
  return result === 'export' ? { format, formData } : null;
}

// ---- summarise ------------------------------------------------------------------------------

export interface SummaryChoice {
  readonly layout: SummaryLayout;
  readonly sort: SummarySort;
  readonly fontSize: number;
  readonly sequenceNumbers: boolean;
  readonly includeEmptyPages: boolean;
  /** Page range text, `""` for every page. */
  readonly range: string;
}

const LAYOUTS: ReadonlyArray<{ value: SummaryLayout; label: string }> = [
  {
    value: 'separate-connectors',
    label: 'Document and comments, connector lines, on separate pages',
  },
  { value: 'single-connectors', label: 'Document and comments, connector lines, on one page' },
  { value: 'comments-only', label: 'Comments only' },
  { value: 'separate-sequence', label: 'Document and comments, numbered, on separate pages' },
];

export async function askSummaryOptions(
  dialogs: Dialogs,
  options: SummaryChoice & { readonly pageCount: number; readonly commentCount: number },
): Promise<SummaryChoice | null> {
  let layout = options.layout;
  let sort = options.sort;
  let fontSize = options.fontSize;
  let sequenceNumbers = options.sequenceNumbers;
  let includeEmptyPages = options.includeEmptyPages;
  let range = options.range;

  const handle = dialogs.open({
    id: 'comments-summary-dialog',
    title: 'Summarise comments',
    width: 560,
    content: (body, dialog) => {
      body.append(
        el(
          'p.dlg-text',
          null,
          `${String(options.commentCount)} ${options.commentCount === 1 ? 'comment' : 'comments'} across ${String(options.pageCount)} pages.`,
        ),
      );
      const layoutChooser = select(
        LAYOUTS.map((l) => ({ value: l.value, label: l.label })),
        layout,
      );
      layoutChooser.addEventListener('change', () => {
        layout = (layoutChooser.value as SummaryLayout) ?? 'separate-connectors';
      });
      const sortChooser = select(
        [
          { value: 'page', label: 'Page' },
          { value: 'author', label: 'Author' },
          { value: 'date', label: 'Date' },
          { value: 'type', label: 'Type' },
        ],
        sort,
      );
      sortChooser.addEventListener('change', () => {
        sort = (sortChooser.value as SummarySort) ?? 'page';
      });
      const size = el('input.dlg-input', {
        type: 'number',
        min: MIN_SUMMARY_FONT_SIZE,
        max: MAX_SUMMARY_FONT_SIZE,
        step: 1,
        value: String(fontSize),
      });
      size.addEventListener('change', () => {
        fontSize = Number(size.value) || fontSize;
      });
      const rangeInput = el('input.dlg-input', {
        type: 'text',
        value: range,
        placeholder: `1-${String(options.pageCount)}`,
      });
      rangeInput.addEventListener('input', () => {
        range = rangeInput.value;
        dialog.setEnabled(
          'summarise',
          rangeInput.value.trim() === '' ||
            parseRange(rangeInput.value, options.pageCount).length > 0,
        );
      });

      body.append(
        formGrid(
          field({ label: 'Layout', input: layoutChooser }),
          field({ label: 'Sort comments by', input: sortChooser }),
          field({ label: 'Text size (points)', input: size }),
          field({
            label: 'Pages',
            input: rangeInput,
            hint: 'Empty means every page. Use 1-4, 7, 9-12.',
          }),
        ),
      );
      const numbers = checkbox('Number the comments and mark them on the page', sequenceNumbers);
      numbers.input.addEventListener('change', () => {
        sequenceNumbers = numbers.input.checked;
      });
      const empties = checkbox('Include pages that have no comments', includeEmptyPages);
      empties.input.addEventListener('change', () => {
        includeEmptyPages = empties.input.checked;
      });
      body.append(numbers.row, empties.row);
    },
    buttons: [
      { id: 'cancel', label: 'Cancel' },
      { id: 'summarise', label: 'Summarise', primary: true },
    ],
  });
  const result = await handle.result;
  return result === 'summarise'
    ? { layout, sort, fontSize, sequenceNumbers, includeEmptyPages, range }
    : null;
}

/**
 * `"1-4, 7, 9-12"` → 0-based page indexes, in order, without duplicates. An empty string means
 * every page. Anything unparsable contributes nothing rather than failing the whole range, which
 * is what makes the dialog's live validation say "that range is empty" rather than "syntax error".
 */
export function parseRange(text: string, pageCount: number): number[] {
  const trimmed = text.trim();
  if (trimmed === '') return Array.from({ length: pageCount }, (_, i) => i);
  const seen = new Set<number>();
  for (const part of trimmed.split(',')) {
    const match = /^\s*(\d+)\s*(?:[-–]\s*(\d+)\s*)?$/.exec(part);
    if (!match) continue;
    const from = Number(match[1]);
    const to = match[2] === undefined ? from : Number(match[2]);
    const low = Math.min(from, to);
    const high = Math.max(from, to);
    for (let page = low; page <= high; page++) {
      if (page >= 1 && page <= pageCount) seen.add(page - 1);
    }
  }
  return [...seen].sort((a, b) => a - b);
}

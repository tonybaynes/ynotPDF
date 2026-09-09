/**
 * The Split Document dialog (M41).
 *
 * Four ways to cut, one at a time, with the extra control each needs sitting beside its own
 * radio button rather than in a separate row — so the reader never has to work out which number
 * box belongs to which choice.
 *
 * Under it, a live summary: how many files this will make and what the first two will be called.
 * Splitting writes files to disk, which is not undoable, so the reader should be able to see
 * what they are about to get before they get it. The one case the summary cannot answer is
 * "by file size", because that is measured rather than calculated; it says so instead of
 * guessing.
 */

import { field, formGrid, type DialogHandle, type Dialogs } from '@app/dialog/Dialogs';
import { el } from '@app/dom';
import {
  DEFAULT_NAME_PATTERN,
  fillNamePattern,
  formatBytes,
  planGroups,
  type SplitRule,
} from '@engine/ops/split';
import { checkbox, numberField, radioGroup } from './fields';
import { parseRange, type RangeContext } from '@modules/M40-organise-pages/range';

export type SplitKind = 'count' | 'size' | 'bookmarks' | 'ranges';

export interface SplitChoice {
  readonly rule: SplitRule;
  readonly namePattern: string;
  readonly keepBookmarks: boolean;
  readonly keepComments: boolean;
  readonly keepForms: boolean;
  /** Where the parts go. `null` means the reader has no file system (a browser run). */
  readonly folder: string | null;
}

export interface SplitDialogOptions {
  readonly dialogs: Dialogs;
  readonly pageCount: number;
  readonly baseName: string;
  readonly namePattern: string;
  readonly keepBookmarks: boolean;
  readonly keepComments: boolean;
  readonly keepForms: boolean;
  readonly rangeContext: RangeContext;
  readonly topLevelBookmarks: ReadonlyArray<{ readonly title: string; readonly page: number }>;
  /** Opens the OS folder picker. `null` when the reader cancelled or there is no bridge. */
  readonly chooseFolder: () => Promise<string | null>;
  readonly canWriteFiles: boolean;
}

const MB = 1024 * 1024;

export async function askSplit(options: SplitDialogOptions): Promise<SplitChoice | null> {
  let kind: SplitKind = 'count';
  let everyPages = Math.max(1, Math.min(10, Math.ceil(options.pageCount / 2)));
  let sizeMb = 1;
  let folder: string | null = null;
  let handle: DialogHandle | null = null;

  const countInput = numberField({
    label: 'Pages in each file',
    value: everyPages,
    min: 1,
    max: Math.max(1, options.pageCount),
    onChange: (value) => {
      everyPages = Math.max(1, Math.round(value));
      kind = 'count';
      refresh();
    },
  });
  const sizeInput = numberField({
    label: 'Largest file size, MB',
    value: sizeMb,
    min: 0.05,
    step: 0.05,
    onChange: (value) => {
      sizeMb = value;
      kind = 'size';
      refresh();
    },
  });
  const rangeLines = el('textarea.input.ops-ranges', {
    rows: '4',
    spellcheck: 'false',
    'aria-label': 'One range per line',
    placeholder: '1-4\n5-9\n10-',
  });
  rangeLines.addEventListener('input', () => {
    kind = 'ranges';
    refresh();
  });

  const bookmarkNote = el(
    'p.field-hint',
    null,
    options.topLevelBookmarks.length === 0
      ? 'This document has no top-level bookmarks, so this would leave it whole.'
      : `${String(options.topLevelBookmarks.length)} top-level bookmarks.`,
  );

  const radios = radioGroup<SplitKind>({
    legend: 'Split',
    name: 'ops-split-kind',
    value: 'count',
    choices: [
      { value: 'count', label: 'Every so many pages', extra: countInput.element },
      { value: 'size', label: 'Into files no bigger than', extra: sizeInput.element },
      { value: 'bookmarks', label: 'At every top-level bookmark', extra: bookmarkNote },
      { value: 'ranges', label: 'By page ranges, one file per line', extra: rangeLines },
    ],
    onChange: (value) => {
      kind = value;
      refresh();
    },
  });

  const pattern = el('input.input', {
    type: 'text',
    value: options.namePattern || DEFAULT_NAME_PATTERN,
    spellcheck: 'false',
  });
  pattern.addEventListener('input', refresh);
  const keepBookmarks = checkbox({ label: 'Keep bookmarks', checked: options.keepBookmarks });
  const keepComments = checkbox({ label: 'Keep comments', checked: options.keepComments });
  const keepForms = checkbox({ label: 'Keep form fields', checked: options.keepForms });

  const folderLine = el('p.field-hint.ops-folder', { role: 'status' });
  const chooseFolder = el('button.btn', { type: 'button' }, 'Choose folder…');
  chooseFolder.addEventListener('click', () => {
    void (async () => {
      const chosen = await options.chooseFolder();
      if (chosen !== null) folder = chosen;
      refresh();
    })();
  });
  if (!options.canWriteFiles) chooseFolder.disabled = true;

  const summary = el('p.ops-summary', { role: 'status' });
  const examples = el('ul.ops-examples');

  function ruleNow(): SplitRule {
    switch (kind) {
      case 'count':
        return { kind: 'count', pages: everyPages };
      case 'size':
        return { kind: 'size', bytes: Math.max(1, Math.round(sizeMb * MB)) };
      case 'bookmarks':
        return { kind: 'bookmarks' };
      case 'ranges':
        return { kind: 'ranges', groups: parseLines(rangeLines.value, options.rangeContext) };
    }
  }

  function refresh(): void {
    const rule = ruleNow();
    folderLine.textContent = options.canWriteFiles
      ? folder === null
        ? 'No folder chosen yet — the parts are written where you say.'
        : `Parts go into ${folder}`
      : 'Saving files needs the desktop app.';

    if (rule.kind === 'size') {
      summary.textContent = `Each file will be at most ${formatBytes(rule.bytes)}. How many there are depends on the pages, so it is measured as it goes.`;
      examples.replaceChildren();
      handle?.setEnabled('ok', options.canWriteFiles && folder !== null && sizeMb > 0);
      return;
    }
    const groups = planGroups(rule, options.pageCount, options.topLevelBookmarks);
    summary.textContent =
      groups.length === 0
        ? 'Those settings would produce no files.'
        : `${String(groups.length)} ${groups.length === 1 ? 'file' : 'files'}.`;
    examples.replaceChildren();
    for (const [i, group] of groups.slice(0, 3).entries()) {
      const name = fillNamePattern(pattern.value || DEFAULT_NAME_PATTERN, {
        name: options.baseName,
        index: i,
        total: groups.length,
        pages: group.pages,
        ...(group.title === undefined ? {} : { title: group.title }),
      });
      examples.append(el('li', null, name));
    }
    if (groups.length > 3) examples.append(el('li.ops-more', null, '…'));
    handle?.setEnabled('ok', options.canWriteFiles && folder !== null && groups.length > 0);
  }

  const body = el('div.ops-dialog');
  body.append(
    radios.element,
    formGrid(
      field({
        label: 'Name each file',
        input: pattern,
        hint: 'Use {name}, {index}, {range}, {start}, {end}, {count}, {label} and {title}.',
      }),
      field({
        label: 'Keep',
        input: stack(keepBookmarks.element, keepComments.element, keepForms.element),
      }),
    ),
    field({ label: 'Folder', input: chooseFolder }),
    folderLine,
    summary,
    examples,
  );
  handle = options.dialogs.open({
    title: 'Split document',
    id: 'ops-split',
    width: 620,
    content: body,
    buttons: [
      { id: 'cancel', label: 'Cancel' },
      { id: 'ok', label: 'Split', primary: true },
    ],
  });
  refresh();

  const result = await handle.result;
  if (result !== 'ok') return null;
  return {
    rule: ruleNow(),
    namePattern: pattern.value || DEFAULT_NAME_PATTERN,
    keepBookmarks: keepBookmarks.input.checked,
    keepComments: keepComments.input.checked,
    keepForms: keepForms.input.checked,
    folder,
  };
}

/** Stacks controls in one grid cell. */
function stack(...children: HTMLElement[]): HTMLElement {
  const box = el('div.ops-stack');
  box.append(...children);
  return box;
}

/**
 * One group per non-empty line, using M40's range dialect so `odd` and `5-` mean the same thing
 * here as everywhere else. A line that does not parse is skipped rather than failing the lot:
 * the summary under the box shows how many files there will be, which is the feedback that
 * matters.
 */
export function parseLines(text: string, context: RangeContext): number[][] {
  const out: number[][] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    const parsed = parseRangeSafe(trimmed, context);
    if (parsed.length > 0) out.push(parsed);
  }
  return out;
}

function parseRangeSafe(text: string, context: RangeContext): number[] {
  const parsed = parseRange(text, context);
  return parsed.error === null ? [...parsed.pages] : [];
}

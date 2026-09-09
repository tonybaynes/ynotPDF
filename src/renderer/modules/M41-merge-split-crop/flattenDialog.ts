/**
 * The Flatten dialog (M41).
 *
 * Small, because the decision is small: what to bake, over which pages, and whether to *remove*
 * the marks instead of drawing them. The one thing it has to be clear about is that last choice,
 * because "flatten" and "remove" look the same in a file list and are opposites — so it is a
 * pair of radio buttons with the consequence spelt out under each, not a checkbox called
 * "remove".
 */

import { field, type DialogHandle, type Dialogs } from '@app/dialog/Dialogs';
import { el } from '@app/dom';
import type { RangeContext } from '@modules/M40-organise-pages/range';
import { checkbox, radioGroup, rangeField } from './fields';

export type FlattenAction = 'bake' | 'remove';

export interface FlattenChoice {
  readonly action: FlattenAction;
  readonly annotations: boolean;
  readonly forms: boolean;
  readonly pages: ReadonlyArray<number>;
}

export interface FlattenDialogOptions {
  readonly dialogs: Dialogs;
  readonly annotations: boolean;
  readonly forms: boolean;
  readonly rangeContext: RangeContext;
  /** The range the dialog opens with, e.g. `"1-12"` for the whole document. */
  readonly range: string;
  /** How many comments and fields there are, so the dialog can say what it is about to do. */
  readonly counts: { readonly annotations: number; readonly fields: number };
}

export async function askFlatten(options: FlattenDialogOptions): Promise<FlattenChoice | null> {
  let action: FlattenAction = 'bake';
  let handle: DialogHandle | null = null;

  const annotations = checkbox({ label: 'Comments', checked: options.annotations });
  const forms = checkbox({ label: 'Form fields', checked: options.forms });
  for (const box of [annotations.input, forms.input]) {
    box.addEventListener('change', refresh);
  }

  const radios = radioGroup<FlattenAction>({
    legend: 'What to do with them',
    name: 'ops-flatten-action',
    value: 'bake',
    choices: [
      {
        value: 'bake',
        label: 'Draw them into the page',
        extra: el(
          'p.field-hint',
          null,
          'The page looks exactly the same afterwards, but nothing can be edited, replied to or filled in.',
        ),
      },
      {
        value: 'remove',
        label: 'Take them off the page',
        extra: el('p.field-hint', null, 'The marks are gone. Undo brings them back.'),
      },
    ],
    onChange: (value) => {
      action = value;
      refresh();
    },
  });

  const range = rangeField({
    label: 'Pages',
    value: options.range,
    context: options.rangeContext,
  });
  range.onChange(refresh);

  const summary = el('p.ops-summary', { role: 'status' });

  function refresh(): void {
    const pages = range.pages();
    const parts: string[] = [];
    if (annotations.input.checked) {
      parts.push(
        `${String(options.counts.annotations)} ${options.counts.annotations === 1 ? 'comment' : 'comments'}`,
      );
    }
    if (forms.input.checked) {
      parts.push(
        `${String(options.counts.fields)} ${options.counts.fields === 1 ? 'field' : 'fields'}`,
      );
    }
    const what = parts.length === 0 ? 'nothing' : parts.join(' and ');
    const verb = action === 'remove' ? 'Removes' : 'Draws in';
    summary.textContent =
      pages === null || pages.length === 0
        ? 'Choose some pages.'
        : `${verb} ${what}, over ${String(pages.length)} ${pages.length === 1 ? 'page' : 'pages'}.`;
    handle?.setEnabled(
      'ok',
      (pages?.length ?? 0) > 0 && (annotations.input.checked || forms.input.checked),
    );
  }

  const body = el('div.ops-dialog');
  const stack = el('div.ops-stack');
  stack.append(annotations.element, forms.element);
  body.append(field({ label: 'Include', input: stack }), radios.element, range.element, summary);

  handle = options.dialogs.open({
    title: 'Flatten',
    id: 'ops-flatten',
    width: 520,
    content: body,
    buttons: [
      { id: 'cancel', label: 'Cancel' },
      { id: 'ok', label: 'Apply', primary: true },
    ],
  });
  refresh();

  const result = await handle.result;
  if (result !== 'ok') return null;
  const pages = range.pages();
  if (!pages || pages.length === 0) return null;
  return {
    action,
    annotations: annotations.input.checked,
    forms: forms.input.checked,
    pages,
  };
}

/**
 * The link dialogs (M53): what one link does, and the review of the ones found in the text.
 *
 * The review dialog is the point of the second one. Foxit offers "create links from URLs" as a
 * single action; running it unattended over a document turns a version number into a link and a
 * footnote marker into an e-mail address. Here every candidate is listed with its page and its
 * text, each with a tick, and nothing is written until the reader presses Create.
 */

import { field } from '@app/dialog/Dialogs';
import type { ShellServices } from '@app/services';
import { el } from '@app/dom';
import type { Document } from '@core/Document';
import type { ModelId } from '@core/Ids';
import type { LinkCandidate } from '@engine/decorations/links';
import { checkbox, select } from '@modules/M41-merge-split-crop/fields';
import type { LinkAction, LinkBorder } from './links';

export interface LinkDialogResult {
  readonly action: LinkAction;
  readonly border: LinkBorder;
}

/**
 * The properties of one link: where it goes, and whether a reader can see it is there.
 *
 * "Invisible rectangle" is a border width of nothing, which is what every viewer agrees on and
 * what Foxit's own default is; the alternative — a `/Border` a viewer may ignore — would make a
 * link that looks different in every reader.
 */
export async function openLinkDialog(
  shell: ShellServices,
  doc: Document,
  options: {
    readonly action: LinkAction;
    readonly border: LinkBorder;
    readonly title: string;
    readonly canDelete: boolean;
  },
): Promise<LinkDialogResult | 'delete' | null> {
  const action = options.action;
  let border = options.border;

  const uriInput = el('input.input', {
    type: 'text',
    value: action.kind === 'uri' ? action.uri : '',
    spellcheck: 'false',
    placeholder: 'https://',
    'data-testid': 'link-uri',
  });
  const pageSelect = el('select.input', { 'data-testid': 'link-page' });
  doc.state.pages.forEach((page, index) => {
    const option = el(
      'option',
      { value: String(page.id) },
      `Page ${String(index + 1)}${page.label && page.label !== String(index + 1) ? ` (${page.label})` : ''}`,
    );
    if (action.kind === 'page' && action.page === page.id) option.selected = true;
    pageSelect.append(option);
  });
  const pathInput = el('input.input', {
    type: 'text',
    value: action.kind === 'file' || action.kind === 'open' ? action.path : '',
    spellcheck: 'false',
  });
  const filePageInput = el('input.input', {
    type: 'number',
    min: '1',
    step: '1',
    value: String(action.kind === 'file' ? action.page + 1 : 1),
  });
  const openPathInput = el('input.input', {
    type: 'text',
    value: action.kind === 'open' ? action.path : '',
    spellcheck: 'false',
  });
  /** Reads the form. Assigned while the body is built; the result is read after it closes. */
  let readAction: () => LinkAction = () => action;

  const rows = new Map<string, HTMLElement>();
  const show = (kind: string): void => {
    for (const [key, row] of rows) row.hidden = key !== kind;
  };

  const handle = shell.dialogs.open({
    id: 'link-dialog',
    title: options.title,
    width: 560,
    content: (body) => {
      const kindSelect = select({
        label: 'When the link is clicked',
        value: action.kind,
        choices: [
          { value: 'uri', label: 'Open a web address' },
          { value: 'page', label: 'Go to a page in this document' },
          { value: 'file', label: 'Open a page of another PDF' },
          { value: 'open', label: 'Open a file' },
          { value: 'none', label: 'Do nothing' },
        ],
        onChange: (value) => {
          show(value);
        },
      });
      body.append(kindSelect.element);

      const uriRow = field({ label: 'Address', input: uriInput });
      const pageRow = field({ label: 'Page', input: pageSelect });
      const fileRow = el(
        'div',
        null,
        field({ label: 'File', input: pathInput, hint: 'A path, relative to this document.' }),
        field({ label: 'Page in that file', input: filePageInput }),
      );
      const openRow = field({
        label: 'File',
        input: openPathInput,
        hint: 'ynotPDF will not open it for you; it is written into the file for other readers.',
      });
      const noneRow = el('p.field-hint', null, 'The rectangle is drawn but nothing happens.');
      rows.set('uri', uriRow);
      rows.set('page', pageRow);
      rows.set('file', fileRow);
      rows.set('open', openRow);
      rows.set('none', noneRow);
      body.append(uriRow, pageRow, fileRow, openRow, noneRow);
      show(action.kind);

      body.append(el('h4.decoration-subheading', null, 'How it looks'));
      const widthSelect = select({
        label: 'Border',
        value: border.width > 0 ? 'visible' : 'invisible',
        choices: [
          { value: 'invisible', label: 'Invisible rectangle' },
          { value: 'visible', label: 'A visible border' },
        ],
        onChange: (value) => {
          border = { ...border, width: value === 'visible' ? 1 : 0 };
          styleSelect.element.hidden = value !== 'visible';
        },
      });
      const styleSelect = select({
        label: 'Border style',
        value: border.style,
        choices: [
          { value: 'solid', label: 'Solid' },
          { value: 'dashed', label: 'Dashed' },
          { value: 'underline', label: 'Underline' },
        ],
        onChange: (value) => {
          border = { ...border, style: value };
        },
      });
      styleSelect.element.hidden = border.width === 0;
      const highlight = select({
        label: 'While it is pressed',
        value: border.highlight,
        choices: [
          { value: 'invert', label: 'Invert the colours' },
          { value: 'outline', label: 'Outline it' },
          { value: 'push', label: 'Push it in' },
          { value: 'none', label: 'Nothing' },
        ],
        onChange: (value) => {
          border = { ...border, highlight: value };
        },
      });
      body.append(widthSelect.element, styleSelect.element, highlight.element);

      readAction = (): LinkAction => {
        switch (kindSelect.input.value) {
          case 'uri':
            return { kind: 'uri', uri: uriInput.value.trim() };
          case 'page':
            return { kind: 'page', page: pageSelect.value as ModelId, fit: 'fit' };
          case 'file':
            return {
              kind: 'file',
              path: pathInput.value.trim(),
              page: Math.max(0, Number(filePageInput.value) - 1),
            };
          case 'open':
            return { kind: 'open', path: openPathInput.value.trim() };
          default:
            return { kind: 'none' };
        }
      };
    },
    buttons: [
      { id: 'ok', label: 'OK', primary: true },
      ...(options.canDelete ? [{ id: 'delete', label: 'Delete', danger: true }] : []),
      { id: 'cancel', label: 'Cancel' },
    ],
  });

  const result = await handle.result;
  if (result === 'delete') return 'delete';
  if (result !== 'ok') return null;
  return { action: readAction(), border };
}

/**
 * The review of the addresses found in the text. Returns the ones the reader kept.
 */
export async function openDetectedLinksDialog(
  shell: ShellServices,
  candidates: ReadonlyArray<LinkCandidate>,
): Promise<ReadonlyArray<LinkCandidate>> {
  if (candidates.length === 0) {
    await shell.dialogs.info(
      'No addresses found',
      'There are no web or e-mail addresses in the text of those pages that are not already links.',
    );
    return [];
  }
  const boxes: HTMLInputElement[] = [];
  const handle = shell.dialogs.open({
    id: 'detected-links-dialog',
    title: 'Create links from the text',
    width: 680,
    content: (body) => {
      body.append(
        el(
          'p',
          null,
          `${String(candidates.length)} ${candidates.length === 1 ? 'address was' : 'addresses were'} found. Untick anything that should not become a link.`,
        ),
      );
      const all = checkbox({
        label: 'All of them',
        checked: true,
        onChange: (checked) => {
          for (const box of boxes) box.checked = checked;
        },
      });
      body.append(all.element);

      const list = el('ul.link-candidates', { 'data-testid': 'link-candidates' });
      for (const candidate of candidates) {
        const row = el('li.link-candidate');
        const box = checkbox({ label: candidate.text, checked: true });
        boxes.push(box.input);
        row.append(
          box.element,
          el('span.link-candidate-page', null, `page ${String(candidate.page + 1)}`),
          el('span.link-candidate-uri', null, candidate.uri),
        );
        list.append(row);
      }
      body.append(list);
    },
    buttons: [
      { id: 'create', label: 'Create links', primary: true },
      { id: 'cancel', label: 'Cancel' },
    ],
  });
  const result = await handle.result;
  if (result !== 'create') return [];
  return candidates.filter((_c, index) => boxes[index]?.checked !== false);
}

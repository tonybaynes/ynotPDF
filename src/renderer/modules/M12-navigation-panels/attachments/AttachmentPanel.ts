/**
 * The Attachments panel (M12) — embedded files, and a PDF Portfolio's own list.
 *
 * An ordinary document gets four columns: name, description, size and modified. A **portfolio**
 * — a file whose catalogue has `/Collection` — gets the columns *its* schema declares, in its
 * own order, which is what makes one open "properly" rather than as a blank cover sheet.
 *
 * Double-click (or Open) on an embedded PDF opens it **in a new tab**, unsaved until it is saved
 * somewhere; anything else goes to the OS default application. Adding, deleting and describing
 * are all `Command`s. File-attachment *annotations* are listed too, read-only — M31 creates them.
 */

import { el } from '@app/dom';
import { icon } from '@app/icons';
import type { ModelId } from '@core/Ids';
import type { ModelAttachment } from '@core/model';
import type { CollectionField, PdfCollection } from '@engine/PdfEngine';
import type { ServiceContext } from '@shared/module';
import {
  emptyMessage,
  formatBytes,
  formatDate,
  installListKeys,
  sectionHeading,
  toolButton,
  toolbar,
} from '../panelChrome';
import { isPdf, type NavigationService } from '../NavigationService';

/** One column of the list. */
interface Column {
  readonly key: string;
  readonly label: string;
  readonly value: (attachment: ModelAttachment) => string;
}

/** The four columns an ordinary document gets. */
export function defaultColumns(): Column[] {
  return [
    { key: 'name', label: 'Name', value: (a) => a.name },
    { key: 'description', label: 'Description', value: (a) => a.description ?? '' },
    { key: 'size', label: 'Size', value: (a) => formatBytes(a.size) },
    { key: 'modified', label: 'Modified', value: (a) => formatDate(a.modified) },
  ];
}

/**
 * The columns a portfolio's `/Collection /Schema` declares, in its order. The five standard
 * field kinds read a property of the file itself; a custom one reads the value the file
 * specification carries in `/CI` (ADR 0011).
 */
export function collectionColumns(collection: PdfCollection): Column[] {
  const columns = collection.fields
    .filter((f) => f.visible)
    .map((field) => ({
      key: field.key,
      label: field.label,
      value: (a: ModelAttachment) => collectionValue(field, a),
    }));
  return columns.length > 0 ? columns : defaultColumns();
}

function collectionValue(field: CollectionField, attachment: ModelAttachment): string {
  switch (field.kind) {
    case 'F':
      return attachment.name;
    case 'Desc':
      return attachment.description ?? '';
    case 'ModDate':
      return formatDate(attachment.modified);
    case 'CreationDate':
      return formatDate(attachment.created ?? null);
    case 'Size':
    case 'CompressedSize':
      return formatBytes(attachment.size);
    default:
      return attachment.collectionFields?.[field.key] ?? '';
  }
}

export function mountAttachmentPanel(
  host: HTMLElement,
  _ctx: ServiceContext,
  nav: NavigationService,
): () => void {
  const disposers: Array<() => void> = [];
  let selected: ModelId | null = null;

  const bar = toolbar(
    'Attachments',
    toolButton({
      label: 'Open the selected attachment',
      icon: 'external-link',
      id: 'attachment-open',
      onPress: () => void nav.run('attachments.open'),
    }),
    toolButton({
      label: 'Save the selected attachment to disk',
      icon: 'save',
      id: 'attachment-save',
      onPress: () => void nav.run('attachments.saveAs'),
    }),
    toolButton({
      label: 'Attach files to this document',
      icon: 'plus',
      id: 'attachment-add',
      onPress: () => void nav.run('attachments.add'),
    }),
    toolButton({
      label: 'Delete the selected attachment',
      icon: 'trash-2',
      id: 'attachment-delete',
      onPress: () => void nav.run('attachments.delete'),
    }),
    toolButton({
      label: 'Edit the description of the selected attachment',
      icon: 'square-pen',
      id: 'attachment-describe',
      onPress: () => void nav.run('attachments.describe'),
    }),
  );
  const portfolioNote = el('p.nav-note', { role: 'status' });
  const scroller = el('div.nav-scroll', { 'data-panel-scroll': 'attachments' });
  const table = el('div.nav-table', { role: 'table', 'aria-label': 'Attachments' });
  scroller.append(table);
  const empty = emptyMessage('This document has no attachments.', 'paperclip');
  host.append(bar, portfolioNote, scroller, empty);

  const render = (): void => {
    const context = nav.context;
    const all = context?.document.state.attachments ?? [];
    const collection = nav.collection;
    const embedded = all.filter((a) => a.pageId === null);
    const onPages = all.filter((a) => a.pageId !== null);

    empty.hidden = all.length > 0;
    scroller.hidden = all.length === 0;
    bar.hidden = context === null;
    portfolioNote.hidden = collection === null;
    if (collection !== null) {
      const files = embedded.length === 1 ? '1 file' : `${String(embedded.length)} files`;
      portfolioNote.replaceChildren(
        icon('files'),
        el(
          'span',
          null,
          `PDF Portfolio — ${files}. The page behind this panel is the portfolio's cover sheet.`,
        ),
      );
    }

    const columns = collection === null ? defaultColumns() : collectionColumns(collection);
    table.replaceChildren();
    table.style.setProperty('--nav-columns', String(columns.length));

    const header = el('div.nav-tr.nav-th', { role: 'row' });
    for (const column of columns) {
      header.append(el('span.nav-td', { role: 'columnheader' }, column.label));
    }
    table.append(header);

    const addRows = (list: ReadonlyArray<ModelAttachment>, readOnly: boolean): void => {
      for (const attachment of list) {
        const row = el('div.nav-tr', {
          role: 'row',
          'data-row': '',
          'data-id': attachment.id,
          tabindex: '-1',
        });
        for (const [i, column] of columns.entries()) {
          const cell = el('span.nav-td', { role: 'cell' }, column.value(attachment));
          if (i === 0) {
            cell.prepend(
              icon(isPdf(attachment.name, attachment.mimeType) ? 'file-text' : 'file', {
                fallbackText: '',
              }),
            );
          }
          row.append(cell);
        }
        if (readOnly) {
          const page =
            attachment.pageId === null
              ? null
              : (nav.context?.document.pageById(attachment.pageId)?.label ?? null);
          row.append(
            el(
              'span.nav-badge',
              { title: 'An attachment placed on a page; edit it with the annotation tools' },
              page === null ? 'On a page' : `On page ${page}`,
            ),
          );
          row.classList.add('is-readonly');
        }
        row.classList.toggle('is-selected', attachment.id === selected);
        row.setAttribute('aria-selected', String(attachment.id === selected));
        row.title = describe(attachment, readOnly);
        row.addEventListener('click', () => {
          select(attachment.id);
        });
        row.addEventListener('dblclick', () => {
          select(attachment.id);
          void nav.openAttachment(attachment.id);
        });
        table.append(row);
      }
    };

    addRows(embedded, false);
    if (onPages.length > 0) {
      table.append(sectionHeading('Attached to a page'));
      addRows(onPages, true);
    }

    const rows = [...table.querySelectorAll<HTMLElement>('[data-row]')];
    const active = rows.find((r) => r.dataset['id'] === selected) ?? rows[0] ?? null;
    for (const row of rows) row.tabIndex = row === active ? 0 : -1;
    if (selected !== null && !rows.some((r) => r.dataset['id'] === selected)) select(null);
  };

  const describe = (attachment: ModelAttachment, readOnly: boolean): string => {
    const parts = [attachment.name];
    if (attachment.description !== null && attachment.description !== '') {
      parts.push(attachment.description);
    }
    if (attachment.size !== null) parts.push(formatBytes(attachment.size));
    if (readOnly) parts.push('attached to a page');
    else if (isPdf(attachment.name, attachment.mimeType)) parts.push('opens in a new tab');
    else parts.push('opens in the default application');
    return parts.join(' — ');
  };

  const select = (id: ModelId | null): void => {
    selected = id;
    nav.selectedAttachment = id;
    for (const row of table.querySelectorAll<HTMLElement>('[data-row]')) {
      const on = row.dataset['id'] === id;
      row.classList.toggle('is-selected', on);
      row.setAttribute('aria-selected', String(on));
    }
  };

  disposers.push(
    installListKeys(table, {
      rows: () => [...table.querySelectorAll<HTMLElement>('[data-row]')],
      focus: (row) => {
        select((row.dataset['id'] ?? null) as ModelId | null);
      },
      activate: (row) => {
        const id = (row.dataset['id'] ?? null) as ModelId | null;
        if (id === null) return;
        select(id);
        void nav.openAttachment(id);
      },
    }),
    nav.watch(() => {
      render();
    }),
  );

  render();
  return () => {
    for (const d of disposers.splice(0)) d();
    host.replaceChildren();
  };
}

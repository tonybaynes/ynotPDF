/**
 * The Links panel (M53): every link in the document, what it does, and where it is.
 *
 * The list is the answer to "what did that auto-detect actually make?" and to "there is a link
 * somewhere on this page and I cannot find it". Choosing a row goes to the page and selects the
 * link; the buttons edit and delete it.
 */

import { el } from '@app/dom';
import type { ServiceContext } from '@shared/module';
import type { Registry } from '@core/Registry';
import { VIEWER_SERVICE, type ViewerService } from '@modules/M11-viewer/ViewerService';
import { describeAction } from './links';
import { LINK_SERVICE, type LinkService } from './LinkService';

export const LINKS_PANEL_ID = 'nav.links';

export function mountLinksPanel(host: HTMLElement, ctx: ServiceContext): () => void {
  const registry = ctx.service<Registry>('registry');
  if (!registry.hasService(LINK_SERVICE)) {
    host.append(el('p.panel-empty', null, 'The link tools are not available in this build.'));
    return () => undefined;
  }
  const links = registry.service<LinkService>(LINK_SERVICE);

  const root = el('div.links-panel', { 'data-testid': 'links-panel' });
  const summary = el('p.links-summary', { role: 'status' });
  const list = el('ul.links-list');
  const actions = el('div.links-actions');
  const editButton = el('button.btn', { type: 'button' }, 'Edit…');
  const deleteButton = el('button.btn.btn-danger', { type: 'button' }, 'Delete');
  const detectButton = el('button.btn', { type: 'button' }, 'Create from text…');
  actions.append(editButton, deleteButton, detectButton);
  root.append(summary, list, actions);
  host.append(root);

  const goTo = (page: number): void => {
    if (!registry.hasService(VIEWER_SERVICE)) return;
    registry.service<ViewerService>(VIEWER_SERVICE).active?.goToPage(page);
  };

  const paint = (): void => {
    const all = links.all();
    const selected = new Set(links.selection);
    const doc = links.activeDocument();
    summary.textContent =
      all.length === 0
        ? 'No links on the pages that have been read yet.'
        : `${String(all.length)} ${all.length === 1 ? 'link' : 'links'}`;
    list.replaceChildren();
    for (const link of all) {
      const row = el('li.links-row');
      const button = el('button.links-item', {
        type: 'button',
        'data-link-id': String(link.id),
        ...(selected.has(link.id) ? { 'aria-current': 'true' } : {}),
      });
      button.append(
        el('span.links-page', null, `Page ${String(link.page + 1)}`),
        el(
          'span.links-what',
          null,
          describeAction(link.action, (id) => {
            const index = doc?.state.pages.findIndex((p) => p.id === id) ?? -1;
            return index < 0 ? null : index + 1;
          }),
        ),
      );
      button.addEventListener('click', () => {
        goTo(link.page);
        links.select(link.id);
      });
      button.addEventListener('dblclick', () => {
        void links.editLink(link.id);
      });
      row.append(button);
      list.append(row);
    }
    const one = links.selection.length === 1 ? links.selection[0] : null;
    editButton.disabled = one === null;
    deleteButton.disabled = links.selection.length === 0;
  };

  editButton.addEventListener('click', () => {
    const one = links.selection[0];
    if (one !== undefined) void links.editLink(one);
  });
  deleteButton.addEventListener('click', () => {
    void (async () => {
      const doc = links.activeDocument();
      if (doc) await links.remove(doc, links.selection);
    })();
  });
  detectButton.addEventListener('click', () => {
    void ctx.run('link.detect');
  });

  const unsubscribe = links.onChange(paint);
  paint();
  return () => {
    unsubscribe();
    root.remove();
  };
}

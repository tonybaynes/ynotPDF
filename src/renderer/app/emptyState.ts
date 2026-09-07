/**
 * Empty state (M02): shown in the document area when nothing is open — three large tiles
 * (Open, Recent, Create) so the first action is one click or one key away. Recent lists the
 * last few files inline; Create lists the registered creators.
 */

import { formatShortcut } from '@core/Registry';
import { button, el } from './dom';
import { icon } from './icons';
import { creatorTiles } from './backstage/Backstage';
import { createRecentList } from './backstage/recent';
import type { ShellServices } from './services';

export interface EmptyStateHandle {
  readonly element: HTMLElement;
  dispose(): void;
}

export function mountEmptyState(host: HTMLElement, services: ShellServices): EmptyStateHandle {
  const { registry, isMac, documents } = services;
  const root = el('div.empty-state', { id: 'empty-state' });
  const heading = el('h2.empty-title', null, 'No document open');
  const openKey = formatShortcut(registry.shortcutFor('file.open') ?? 'Mod+O', isMac);
  const paletteKey = formatShortcut(
    registry.shortcutFor('app.commandPalette') ?? 'Mod+Shift+P',
    isMac,
  );
  const sub = el(
    'p.empty-sub',
    null,
    'Open a PDF with ',
    el('kbd', null, openKey),
    ' or find any command with ',
    el('kbd', null, paletteKey),
    '.',
  );

  const tiles = el('div.empty-tiles');

  const openTile = el('section.empty-tile', { 'aria-labelledby': 'empty-open-title' });
  const openBtn = button('btn btn-primary btn-big', { id: 'empty-open' });
  openBtn.append(icon('folder-open', { size: 'lg' }), el('span', null, 'Open'));
  openBtn.addEventListener('click', () => {
    void services.run('file.open');
  });
  openTile.append(
    el('h3.empty-tile-title', { id: 'empty-open-title' }, 'Open'),
    openBtn,
    el('p.empty-tile-hint', null, 'Browse for a PDF, or drop one onto this window.'),
  );

  const recentTile = el('section.empty-tile', { 'aria-labelledby': 'empty-recent-title' });
  const recent = createRecentList(services, {
    limit: 5,
    controls: false,
    emptyText: 'Files you open will appear here.',
  });
  const allRecent = button('btn btn-link', { id: 'empty-recent-all' }, 'All recent files…');
  allRecent.addEventListener('click', () => {
    void services.run('app.ribbon.tab.file');
  });
  recentTile.append(
    el('h3.empty-tile-title', { id: 'empty-recent-title' }, 'Recent'),
    recent.element,
    allRecent,
  );

  const createTile = el('section.empty-tile', { 'aria-labelledby': 'empty-create-title' });
  const creatorHost = el('div');
  creatorHost.append(creatorTiles(services, 'creator-tile creator-tile-small'));
  createTile.append(el('h3.empty-tile-title', { id: 'empty-create-title' }, 'Create'), creatorHost);

  tiles.append(openTile, recentTile, createTile);
  root.append(heading, sub, tiles);
  host.append(root);

  const refreshCreators = (): void => {
    creatorHost.replaceChildren(creatorTiles(services, 'creator-tile creator-tile-small'));
  };
  const unsubs = [
    registry.subscribe(refreshCreators),
    documents.subscribe((s) => {
      root.hidden = s.tabs.length > 0;
    }),
  ];
  root.hidden = documents.tabs.length > 0;
  return {
    element: root,
    dispose: () => {
      for (const u of unsubs) u();
      recent.dispose();
      root.remove();
    },
  };
}

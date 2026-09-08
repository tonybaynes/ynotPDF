/**
 * The advanced search panel (M13) — the left-pane counterpart to the find bar: a scope (this
 * document, every open document, a folder on disk), the full option set, a proximity box and a
 * results tree grouped document → page with a line of context, plus Export to CSV.
 *
 * The panel is a view over `SearchPanelState`; it never searches anything itself. That keeps the
 * folder search — which lives in a main-process worker — and the in-document search behind one
 * shape, so the tree does not know or care which one produced a row.
 */

import { button, el } from '@app/dom';
import { icon } from '@app/icons';
import type { SearchScope, SelectFindSettings } from '../settings';
import type { FindOptions } from './search';
import type { SearchHit } from './search';

export interface SearchPanelState {
  readonly query: string;
  readonly scope: SearchScope;
  readonly folder: string | null;
  readonly running: boolean;
  readonly scanned: number;
  readonly total: number;
  readonly file: string;
  readonly hits: ReadonlyArray<SearchHit>;
  readonly error: string | null;
  /** The hit limit was reached and the search stopped early. */
  readonly truncated: boolean;
}

export const EMPTY_PANEL_STATE: SearchPanelState = {
  query: '',
  scope: 'document',
  folder: null,
  running: false,
  scanned: 0,
  total: 0,
  file: '',
  hits: [],
  error: null,
  truncated: false,
};

/** What the panel asks the service to do. */
export interface SearchPanelHost {
  readonly state: SearchPanelState;
  settings(): SelectFindSettings;
  findOptions(): FindOptions;
  setOption(name: keyof FindOptions, value: boolean): void;
  setProximity(words: number): void;
  setScope(scope: SearchScope): void;
  setQuery(query: string): void;
  pickFolder(): Promise<string | null>;
  search(): Promise<void>;
  cancel(): void;
  openHit(hit: SearchHit): Promise<void>;
  exportCsv(): Promise<void>;
  subscribe(listener: (state: SearchPanelState) => void): () => void;
}

const OPTION_ROWS: ReadonlyArray<{ name: keyof FindOptions; label: string }> = [
  { name: 'matchCase', label: 'Match case' },
  { name: 'wholeWord', label: 'Whole words only' },
  { name: 'regex', label: 'Regular expression' },
  { name: 'ignoreDiacritics', label: 'Ignore accents' },
  { name: 'includeBookmarks', label: 'Include bookmarks' },
  { name: 'includeComments', label: 'Include comments' },
  { name: 'includeFormFields', label: 'Include form values' },
];

const SCOPES: ReadonlyArray<{ value: SearchScope; label: string }> = [
  { value: 'document', label: 'This document' },
  { value: 'open', label: 'All open documents' },
  { value: 'folder', label: 'A folder' },
];

/** Mounts the panel. Returns a disposer, as `PanelSpec.mount` requires. */
export function mountSearchPanel(host: HTMLElement, service: SearchPanelHost): () => void {
  const query = el('input.search-query', {
    type: 'search',
    'aria-label': 'What to search for',
    placeholder: 'Search',
    autocomplete: 'off',
    spellcheck: false,
  });
  const searchButton = button('btn btn-primary search-go', { type: 'submit' }, 'Search');
  const cancelButton = button('btn search-cancel', null, 'Stop');
  cancelButton.hidden = true;
  const exportButton = button(
    'btn search-export',
    { title: 'Export the results as CSV' },
    icon('download'),
    ' Export',
  );

  const scopeFieldset = el('fieldset.search-scope');
  scopeFieldset.append(el('legend', null, 'Look in'));
  const scopeInputs = new Map<SearchScope, HTMLInputElement>();
  for (const scope of SCOPES) {
    const input = el('input', { type: 'radio', name: 'search-scope', value: scope.value });
    input.addEventListener('change', () => {
      if (input.checked) service.setScope(scope.value);
    });
    scopeInputs.set(scope.value, input);
    scopeFieldset.append(el('label.search-radio', null, input, el('span', null, scope.label)));
  }
  const folderRow = el('div.search-folder');
  const folderLabel = el('span.search-folder-path', { 'aria-live': 'polite' });
  const browse = button('btn search-browse', null, icon('folder-open'), ' Choose…');
  browse.addEventListener('click', () => {
    void service.pickFolder();
  });
  folderRow.append(browse, folderLabel);
  scopeFieldset.append(folderRow);

  const optionsFieldset = el('fieldset.search-options');
  optionsFieldset.append(el('legend', null, 'Options'));
  const optionInputs = new Map<keyof FindOptions, HTMLInputElement>();
  for (const row of OPTION_ROWS) {
    const input = el('input', { type: 'checkbox' });
    input.addEventListener('change', () => {
      service.setOption(row.name, input.checked);
    });
    optionInputs.set(row.name, input);
    optionsFieldset.append(el('label.search-check', null, input, el('span', null, row.label)));
  }
  const proximity = el('input.search-proximity', {
    type: 'number',
    min: 0,
    max: 50,
    step: 1,
    'aria-label': 'Words apart for a proximity match, 0 for off',
  });
  proximity.addEventListener('change', () => {
    service.setProximity(Number(proximity.value) || 0);
  });
  optionsFieldset.append(
    el(
      'label.search-check',
      null,
      el('span', null, 'Within'),
      proximity,
      el('span', null, 'words'),
    ),
  );

  const progress = el('div.search-progress', { role: 'status' });
  const summary = el('p.search-summary', { role: 'status' });
  const results = el('div.search-results', { role: 'tree', 'aria-label': 'Search results' });

  const form = el(
    'form.search-form',
    null,
    query,
    el('div.search-buttons', null, searchButton, cancelButton, exportButton),
  );
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    service.setQuery(query.value);
    void service.search();
  });
  query.addEventListener('input', () => {
    service.setQuery(query.value);
  });
  cancelButton.addEventListener('click', () => {
    service.cancel();
  });
  exportButton.addEventListener('click', () => {
    void service.exportCsv();
  });

  host.append(form, scopeFieldset, optionsFieldset, progress, summary, results);

  const render = (state: SearchPanelState): void => {
    if (document.activeElement !== query) query.value = state.query;
    for (const [scope, input] of scopeInputs) input.checked = state.scope === scope;
    folderRow.hidden = state.scope !== 'folder';
    folderLabel.textContent = state.folder ?? 'No folder chosen';
    const options = service.findOptions();
    for (const [name, input] of optionInputs) input.checked = Boolean(options[name]);
    if (document.activeElement !== proximity) proximity.value = String(options.proximity);

    searchButton.hidden = state.running;
    cancelButton.hidden = !state.running;
    exportButton.disabled = state.hits.length === 0;

    if (state.running) {
      const where = state.file ? ` — ${shortPath(state.file)}` : '';
      progress.textContent = state.total
        ? `Searching ${state.scanned} of ${state.total}${where}`
        : `Searching${where}`;
    } else {
      progress.textContent = '';
    }
    summary.textContent = summaryText(state);
    renderResults(results, state, service);
  };

  render(service.state);
  const unsubscribe = service.subscribe(render);
  return () => {
    unsubscribe();
    host.replaceChildren();
  };
}

function summaryText(state: SearchPanelState): string {
  if (state.error) return `Error: ${state.error}`;
  if (state.running) return '';
  if (state.query.length === 0) return '';
  if (state.hits.length === 0) return 'No matches';
  const documents = new Set(state.hits.map((h) => h.documentId)).size;
  const plural = state.hits.length === 1 ? 'match' : 'matches';
  const where = documents === 1 ? '' : ` in ${documents} documents`;
  return `${state.hits.length} ${plural}${where}${state.truncated ? ' (stopped at the limit)' : ''}`;
}

function shortPath(path: string): string {
  const parts = path.split(/[\\/]/u);
  return parts[parts.length - 1] ?? path;
}

/** Rebuilds the results tree: a group per document, a sub-group per page, a row per hit. */
function renderResults(
  container: HTMLElement,
  state: SearchPanelState,
  service: SearchPanelHost,
): void {
  container.replaceChildren();
  const byDocument = new Map<string, SearchHit[]>();
  for (const hit of state.hits) {
    const list = byDocument.get(hit.documentId);
    if (list) list.push(hit);
    else byDocument.set(hit.documentId, [hit]);
  }
  for (const [documentId, hits] of byDocument) {
    const name = hits[0]?.documentName ?? documentId;
    const group = el('details.search-doc', { open: true, role: 'group' });
    const label = el(
      'summary.search-doc-name',
      { title: documentId },
      icon('file-text'),
      ` ${name} `,
      el('span.search-doc-count', null, `${hits.length}`),
    );
    group.append(label);
    const byPage = new Map<number, SearchHit[]>();
    for (const hit of hits) {
      const list = byPage.get(hit.page);
      if (list) list.push(hit);
      else byPage.set(hit.page, [hit]);
    }
    for (const [page, pageHits] of byPage) {
      const pageBox = el('div.search-page', { role: 'group' });
      pageBox.append(el('p.search-page-label', null, page >= 0 ? `Page ${page + 1}` : 'Document'));
      for (const hit of pageHits) {
        const row = button('search-hit', { role: 'treeitem', title: hit.snippet });
        if (hit.source !== 'page') {
          row.append(el('span.search-hit-where', null, whereLabel(hit)));
        }
        row.append(el('span.search-hit-text', null, hit.snippet));
        row.addEventListener('click', () => {
          void service.openHit(hit);
        });
        pageBox.append(row);
      }
      group.append(pageBox);
    }
    container.append(group);
  }
}

function whereLabel(hit: SearchHit): string {
  switch (hit.source) {
    case 'bookmark':
      return 'Bookmark';
    case 'comment':
      return hit.label ? `Comment by ${hit.label}` : 'Comment';
    case 'field':
      return hit.label ? `Field ${hit.label}` : 'Form field';
    default:
      return 'Page';
  }
}

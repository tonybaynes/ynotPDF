/**
 * The Preferences dialog (M130) — one opaque window, a list of pages down the left, the chosen
 * page on the right, and a search across every setting in the application.
 *
 * Nothing here is written per module. The pages come from the modules' own `SettingsSchema`s
 * (see `model.ts`), so a module merged next week appears with no change to this file, and a
 * setting whose title changes is retitled here the moment its module says so.
 *
 * Shape of it, and why:
 *
 * - **Search is the front door.** With twenty-odd pages, "which page is the thumbnail size on"
 *   is a worse question than "type thumbnail". The field takes focus when the dialog opens, and
 *   the results are grouped by page so the answer also teaches where the setting lives.
 * - **Changes save as you make them** — there is no OK button. A preferences dialog that can be
 *   cancelled means every module has to hold two versions of its settings; applying immediately
 *   means the reader sees the effect while the dialog is still open, which is the whole point of
 *   a UI-scale slider.
 * - **A changed setting says the word "changed"** beside it and offers a Reset, because a
 *   different shade of anything is not a signal this operator can use.
 * - **The pages that are not settings** — keyboard shortcuts, ribbon and toolbar, and the file
 *   itself — sit under a heading of their own at the bottom of the list rather than in separate
 *   dialogs the reader has to go and find.
 */

import type { Dialogs, DialogHandle } from '@app/dialog/Dialogs';
import { button, el } from '@app/dom';
import { makeRoving } from '@app/focus';
import { icon } from '@app/icons';
import { renderControl, type Control } from './controls';
import { t } from './i18n';
import {
  allRows,
  buildPages,
  coerce,
  isChanged,
  searchPages,
  sectionsOf,
  type PreferencesPage,
  type SettingRow,
} from './model';
import type { SettingsService } from './SettingsService';
import type { ModuleManifest, SettingSpec } from '@shared/module';

/** A page in the list that is not generated from a schema. */
export interface ExtraPage {
  readonly id: string;
  readonly label: string;
  readonly icon: string;
  /** A sentence under the page title. */
  readonly description?: string;
  mount(host: HTMLElement): () => void;
}

export interface PreferencesDialogOptions {
  readonly dialogs: Dialogs;
  readonly settings: SettingsService;
  readonly manifests: ReadonlyArray<ModuleManifest>;
  readonly extraPages?: ReadonlyArray<ExtraPage>;
  /** Page to open on: a module id, or an extra page's id. */
  readonly page?: string;
  /** Text to put in the search box (the palette command passes the reader's words straight in). */
  readonly search?: string;
  /** Opens a native picker for a `path` setting. */
  browse?: (spec: Extract<SettingSpec, { type: 'path' }>) => Promise<string | null>;
}

export interface PreferencesDialogHandle {
  readonly dialog: DialogHandle;
  /** Shows a page by id. */
  show(pageId: string): void;
  /** Puts text in the search field and shows the results. */
  find(query: string): void;
  readonly currentPage: string;
  close(): void;
}

const DIALOG_ID = 'preferences-dialog';

export function openPreferences(options: PreferencesDialogOptions): PreferencesDialogHandle {
  const { dialogs, settings } = options;
  const pages = buildPages(options.manifests);
  const extras = options.extraPages ?? [];
  const rowsByKey = new Map(allRows(pages).map((row) => [row.key, row]));

  let currentPage = options.page ?? pages[0]?.id ?? extras[0]?.id ?? '';
  let advanced = false;
  let query = options.search ?? '';
  const controls = new Map<string, Control>();
  let disposeExtra: (() => void) | null = null;

  const list = el('nav.prefs-cats', { 'aria-label': t('prefs.categories', 'Preference pages') });
  const pageHost = el('section.prefs-page', { id: 'prefs-page', tabindex: -1 });
  const search = el('input.prefs-search', {
    type: 'search',
    id: 'prefs-search',
    placeholder: t('prefs.searchPlaceholder', 'Search every setting'),
    autocomplete: 'off',
    spellcheck: 'false',
  });
  const summary = el('p.prefs-search-summary', { role: 'status', 'aria-live': 'polite' });
  const advancedBox = el('input', { type: 'checkbox', id: 'prefs-advanced' });
  const roving = makeRoving(list, { selector: '.prefs-cat', orientation: 'vertical' });

  // ---- drawing ------------------------------------------------------------------------------

  const label = (page: PreferencesPage | ExtraPage): string => page.label;

  const drawList = (): void => {
    list.replaceChildren();
    const section = (title: string, entries: ReadonlyArray<PreferencesPage | ExtraPage>): void => {
      if (entries.length === 0) return;
      const heading = el('h3.prefs-cats-heading', null, title);
      list.append(heading);
      for (const entry of entries) {
        const item = button('prefs-cat', {
          'data-page': entry.id,
          'aria-current': entry.id === currentPage ? 'page' : undefined,
        });
        item.append(icon(entry.icon), el('span', null, label(entry)));
        item.addEventListener('click', () => {
          query = '';
          search.value = '';
          show(entry.id);
        });
        list.append(item);
      }
    };
    section(t('prefs.settingsHeading', 'Settings'), pages);
    section(t('prefs.moreHeading', 'Customisation and files'), extras);
    roving.refresh();
  };

  const settingId = (row: SettingRow): string => `pref-${row.key.replace(/\./g, '-')}`;

  const drawRow = (row: SettingRow, host: HTMLElement): void => {
    const stored = settings.peek(row.key);
    const value = coerce(row.spec, stored);
    const control = renderControl({
      spec: row.spec,
      value,
      id: settingId(row),
      ...(options.browse ? { browse: options.browse } : {}),
      onChange: (next) => {
        void settings.write(row.key, next).then(() => {
          markChanged(row, control.element);
        });
      },
    });
    controls.set(row.key, control);
    markChanged(row, control.element);
    host.append(control.element);
  };

  /** The "changed" badge and its Reset button — words, never a colour. */
  const markChanged = (row: SettingRow, element: HTMLElement): void => {
    element.querySelector('.pref-changed')?.remove();
    const value = coerce(row.spec, settings.peek(row.key));
    if (!isChanged(row.spec, value)) return;
    const badge = el('p.pref-changed');
    badge.append(
      icon('circle-alert'),
      el('span', null, t('prefs.changed', 'Changed from the default.')),
    );
    const reset = button('btn-link');
    reset.textContent = t('prefs.resetOne', 'Put it back');
    reset.addEventListener('click', () => {
      void settings.write(row.key, undefined).then(() => {
        controls.get(row.key)?.set(row.spec.default);
        markChanged(row, element);
      });
    });
    badge.append(reset);
    element.append(badge);
  };

  const visibleRows = (page: PreferencesPage): ReadonlyArray<SettingRow> =>
    page.rows.filter((row) => advanced || row.spec.advanced !== true);

  const drawSettingsPage = (page: PreferencesPage): void => {
    pageHost.append(el('h2.prefs-title', null, page.label));
    const rows = visibleRows(page);
    const hiddenCount = page.rows.length - rows.length;
    if (rows.length === 0) {
      pageHost.append(
        el(
          'p.prefs-empty',
          null,
          icon('info'),
          ' ',
          t('prefs.pageEmpty', 'Everything on this page is an advanced setting.'),
        ),
      );
    }
    for (const section of sectionsOf(rows)) {
      if (section.rows.length === 0) continue;
      if (section.title !== null) {
        pageHost.append(el('h3.prefs-section', null, section.title));
      }
      const body = el('div.prefs-rows');
      for (const row of section.rows) drawRow(row, body);
      pageHost.append(body);
    }
    if (hiddenCount > 0) {
      pageHost.append(
        el(
          'p.prefs-hidden-note',
          null,
          t('prefs.advancedHidden', '{n} advanced settings are hidden on this page.', {
            n: hiddenCount,
          }),
        ),
      );
    }
    const changed = page.rows.filter((row) =>
      isChanged(row.spec, coerce(row.spec, settings.peek(row.key))),
    );
    const resetPage = button('btn');
    resetPage.append(
      icon('refresh-cw'),
      el(
        'span',
        null,
        t('prefs.resetPage', 'Reset this page ({n} changed)', { n: changed.length }),
      ),
    );
    resetPage.disabled = changed.length === 0;
    resetPage.addEventListener('click', () => {
      void (async () => {
        const ok = await dialogs.confirm({
          title: t('prefs.resetPageTitle', 'Reset this page?'),
          text: t(
            'prefs.resetPageMessage',
            '{n} settings on {page} go back to what the application ships with. Nothing else changes.',
            { n: changed.length, page: page.label },
          ),
          confirmLabel: t('prefs.resetPageConfirm', 'Reset the page'),
          kind: 'question',
        });
        if (!ok) return;
        await settings.writeMany(Object.fromEntries(changed.map((row) => [row.key, undefined])));
        render();
      })();
    });
    pageHost.append(el('div.prefs-page-actions', null, resetPage));
  };

  const drawSearch = (): void => {
    const results = searchPages(pages, query);
    const total = results.reduce((sum, r) => sum + r.rows.length, 0);
    summary.textContent =
      total === 0
        ? t('prefs.noMatches', 'No setting matches “{query}”.', { query })
        : t('prefs.matches', '{n} settings match “{query}”.', { n: total, query });
    pageHost.append(el('h2.prefs-title', null, t('prefs.searchResults', 'Search results')));
    if (total === 0) {
      pageHost.append(
        el(
          'p.prefs-empty',
          null,
          icon('info'),
          ' ',
          t(
            'prefs.noMatchesHint',
            'Try a word from the setting itself — "cache", "units", "thumbnail" — or open a page on the left.',
          ),
        ),
      );
      return;
    }
    for (const result of results) {
      const group = el('section.prefs-result-group');
      const heading = button('prefs-result-heading');
      heading.append(icon(result.page.icon), el('span', null, result.page.label));
      heading.addEventListener('click', () => {
        query = '';
        search.value = '';
        show(result.page.id);
      });
      group.append(heading);
      const body = el('div.prefs-rows');
      for (const row of result.rows) {
        if (!advanced && row.spec.advanced === true) continue;
        drawRow(row, body);
      }
      group.append(body);
      pageHost.append(group);
    }
  };

  const render = (): void => {
    disposeExtra?.();
    disposeExtra = null;
    controls.clear();
    pageHost.replaceChildren();
    for (const item of list.querySelectorAll<HTMLElement>('.prefs-cat')) {
      if (item.dataset['page'] === currentPage && query === '') {
        item.setAttribute('aria-current', 'page');
      } else item.removeAttribute('aria-current');
    }
    if (query.trim() !== '') {
      drawSearch();
      return;
    }
    summary.textContent = '';
    const page = pages.find((p) => p.id === currentPage);
    if (page) {
      drawSettingsPage(page);
      return;
    }
    const extra = extras.find((p) => p.id === currentPage);
    if (extra) {
      pageHost.append(el('h2.prefs-title', null, extra.label));
      if (extra.description) pageHost.append(el('p.prefs-lede', null, extra.description));
      const host = el('div.prefs-extra');
      pageHost.append(host);
      disposeExtra = extra.mount(host);
      return;
    }
    pageHost.append(
      el('p.prefs-empty', null, icon('info'), ' ', t('prefs.noPage', 'Choose a page on the left.')),
    );
  };

  const show = (pageId: string): void => {
    currentPage = pageId;
    render();
    pageHost.focus();
  };

  // ---- the dialog ---------------------------------------------------------------------------

  const handle = dialogs.open({
    id: DIALOG_ID,
    title: t('prefs.title', 'Preferences'),
    width: 940,
    className: 'preferences-dialog',
    escapeResult: 'close',
    content: (body) => {
      const top = el('div.prefs-top');
      const searchField = el('div.prefs-search-field');
      searchField.append(
        el('label.sr-only', { for: 'prefs-search' }, t('prefs.search', 'Search settings')),
        icon('search'),
        search,
      );
      const advancedLabel = el('label.prefs-advanced', { for: 'prefs-advanced' });
      advancedLabel.append(
        advancedBox,
        el('span', null, t('prefs.showAdvanced', 'Show advanced settings')),
      );
      top.append(searchField, advancedLabel);
      body.append(top, summary, el('div.prefs-body', null, list, pageHost));
    },
    initialFocus: search,
    buttons: [{ id: 'close', label: t('prefs.close', 'Close'), primary: true }],
  });

  search.value = query;
  search.addEventListener('input', () => {
    query = search.value;
    render();
  });
  search.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || search.value === '') return;
    // Escape clears the search before it closes the dialog: losing a page you found by typing,
    // because you wanted the typing gone, is the wrong order.
    e.stopPropagation();
    e.preventDefault();
    search.value = '';
    query = '';
    render();
  });
  advancedBox.addEventListener('change', () => {
    advanced = advancedBox.checked;
    render();
  });

  // Another window, an import or a reset changed something: redraw what is on screen.
  const unsubscribe = settings.subscribe((keys) => {
    if (!handle.isOpen) return;
    let structural = false;
    for (const key of keys) {
      const control = controls.get(key);
      const row = rowsByKey.get(key);
      if (!control || !row) {
        structural = structural || rowsByKey.has(key);
        continue;
      }
      // Never over the reader's fingers. This fires for *our own* writes as well as another
      // window's, and a write settles asynchronously — so the notification for "150" could land
      // 23 ms after the reader had already typed "100" over it, put the 150 back, and leave the
      // field reading what it read at focus. The browser only raises `change` when the value at
      // blur differs from the value at focus, so the second edit then vanished without a trace:
      // no event, no write, no complaint. Tony would set the interface scale and watch it snap
      // back. It surfaced as an intermittent macOS CI failure because the race needs the settle
      // to be slower than the reader (2026-09-11).
      const editing =
        document.activeElement === control.focusTarget ||
        control.element.contains(document.activeElement);
      if (!editing) control.set(coerce(row.spec, settings.peek(key)));
      markChanged(row, control.element);
    }
    if (structural) render();
  });
  void handle.result.then(() => {
    unsubscribe();
    disposeExtra?.();
    roving.dispose();
  });

  drawList();
  render();
  if (query.trim() !== '') search.select();

  return {
    dialog: handle,
    show,
    find: (text) => {
      query = text;
      search.value = text;
      render();
    },
    get currentPage() {
      return currentPage;
    },
    close: () => {
      handle.close('close');
    },
  };
}

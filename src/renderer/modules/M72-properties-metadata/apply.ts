/**
 * Doing what the document asked for when it is opened (M72, ADR 0017).
 *
 * The brief puts this in M11, and it belongs there in spirit: the viewer is what opens at a page
 * and a magnification. It lives here instead because M72 owns the setting that governs it and
 * because a module writes inside its own folder — so this file translates `ViewSettings` into
 * calls on M11's viewer and M02's panel service, and the manifest hangs it off the tab-attached
 * signal M21 already uses.
 *
 * Nothing here is a document change: opening a file the way it asks is not an edit, so no
 * `Command` is involved and the document is not dirty afterwards.
 */

import type { LayoutMode } from '@view/layout';
import type { ViewSettings } from '@core/model';
import type { PropertiesSettings } from './settings';

/** The part of M11's viewer this needs. Kept structural so the tests can pass a recorder. */
export interface ViewTarget {
  setLayout(mode: LayoutMode): void;
  setZoom(zoomPercent: number, fit?: 'page' | 'width' | 'visible' | null): void;
  setFit(fit: 'page' | 'width' | 'visible' | null): void;
  goToPage(page: number, options?: { readonly record?: boolean }): void;
}

/** The part of M02's panel service this needs. */
export interface PanelTarget {
  show(panelId: string): void;
  collapse(): void;
}

/** What applying the initial view did, in words, for the tests and the developer command. */
export interface AppliedView {
  readonly layout: LayoutMode | null;
  /**
   * Always null: the navigation panel is `ui.leftPaneOnOpen`'s to decide (M12, the operator's
   * requirement). Kept in the shape so a report can say plainly that nothing opened a panel.
   */
  readonly panel: string | null;
  readonly page: number | null;
  readonly fit: 'page' | 'width' | 'visible' | null;
  readonly zoom: number | null;
  /** Things the file asked for that this application does not do, said plainly. */
  readonly ignored: ReadonlyArray<string>;
}

/**
 * Which navigation panel a `/PageMode` asks for — recorded, and deliberately not acted on.
 *
 * The operator's requirement, written into M12: the left pane opens on whatever
 * `ui.leftPaneOnOpen` says, and "bookmarks-on-open never overrides it, even for documents whose
 * `/PageMode` is `/UseOutlines` — the user's choice wins". So the page mode is read, shown,
 * written back and reported here in words; the pane is left to the reader's own setting. This
 * map exists so the sentence can name the panel the document wanted.
 */
const PANEL_NAMES: Readonly<Record<ViewSettings['pageMode'], string | null>> = {
  none: null,
  outlines: 'the bookmarks panel',
  thumbnails: 'the page thumbnails',
  attachments: 'the attachments panel',
  ocg: 'the layers panel',
  fullscreen: null,
};

/** `/PageLayout` → the viewer's layout mode. `null` means the file did not say. */
export function layoutFor(pageLayout: ViewSettings['pageLayout']): LayoutMode | null {
  switch (pageLayout) {
    case 'single':
      return 'single';
    case 'one-column':
      return 'continuous';
    case 'two-column-left':
    case 'two-column-right':
      return 'facingContinuous';
    case 'two-page-left':
      return 'facing';
    case 'two-page-right':
      // Odd pages on the right is what "book" means in this viewer, and it is the closest
      // honest answer to TwoPageRight (M11's layouts do not have a fifth two-up variant).
      return 'book';
    default:
      return null;
  }
}

/** The magnification a destination asks for, as a percentage, or null for "leave it". */
export function zoomFor(view: ViewSettings): number | null {
  if (view.initialFit !== 'xyz') return null;
  const zoom = view.initialZoom;
  // A zoom of 0 or 1 in a `/XYZ` destination means "keep the current magnification"
  // (ISO 32000-1 12.3.2.2), not "1 %"; both arrive here as a number, so both are refused.
  if (zoom === null || zoom <= 0.02) return null;
  return Math.round(zoom * 100);
}

/** The fit mode a destination asks for, in the viewer's vocabulary. */
export function fitFor(view: ViewSettings): 'page' | 'width' | 'visible' | null {
  switch (view.initialFit) {
    case 'fit':
      return 'page';
    case 'fitH':
    case 'fitV':
      return 'width';
    case 'fitB':
    case 'fitBH':
    case 'fitBV':
      return 'visible';
    default:
      return null;
  }
}

/**
 * Applies a document's initial view to a viewer and the navigation pane.
 *
 * Order matters: the layout and the magnification are set before the page, because changing
 * either moves the scroll position — so going to the page last is what leaves the reader looking
 * at the page the document named.
 */
export function applyInitialView(options: {
  readonly view: ViewSettings;
  readonly settings: PropertiesSettings;
  readonly viewer: ViewTarget;
  /** Kept for the window options; the navigation panel itself is the reader's own setting. */
  readonly panels: PanelTarget | null;
  /** Index of the page the file's open action names, or null when it names none. */
  readonly page: number | null;
}): AppliedView {
  const { view, settings, viewer } = options;
  const ignored: string[] = [];
  const result: {
    layout: LayoutMode | null;
    panel: string | null;
    page: number | null;
    fit: 'page' | 'width' | 'visible' | null;
    zoom: number | null;
  } = { layout: null, panel: null, page: null, fit: null, zoom: null };

  if (!settings.applyInitialView) {
    return { ...result, ignored: ['The application is set to keep your own view of a document.'] };
  }

  const layout = layoutFor(view.pageLayout);
  if (layout) {
    viewer.setLayout(layout);
    result.layout = layout;
  }

  const fit = fitFor(view);
  if (fit) {
    viewer.setFit(fit);
    result.fit = fit;
  } else {
    const zoom = zoomFor(view);
    if (zoom !== null) {
      viewer.setZoom(zoom, null);
      result.zoom = zoom;
    }
  }

  if (options.page !== null && options.page >= 0) {
    viewer.goToPage(options.page, { record: false });
    result.page = options.page;
  }

  const wanted = PANEL_NAMES[view.pageMode];
  if (wanted !== null) {
    ignored.push(
      `The document asks to open with ${wanted}; which panel opens is your own setting (View, then Navigation).`,
    );
  }
  if (view.pageMode === 'fullscreen') {
    ignored.push('The document asks to open in full screen; press F11 if you want that.');
  }

  if (settings.applyWindowOptions) {
    // The window options are applied by the manifest, which has the shell's UI store; what is
    // said here is what this function did not do.
  } else if (view.hideToolbar || view.hideMenubar || view.hideWindowUi) {
    ignored.push(
      'The document asks to hide parts of the application; the setting for that is off.',
    );
  }
  if (view.fitWindow || view.centreWindow) {
    ignored.push(
      'The document asks to resize or centre the window, which a window with tabs in it cannot do for one document.',
    );
  }

  return { ...result, ignored };
}

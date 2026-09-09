/**
 * Doing what a document asks for when it is opened (M72, ADR 0017).
 *
 * The viewer and the panel service are recorders rather than the real things: what is under test
 * is the translation from `/PageMode` and `/OpenAction` into calls, and every claim worth making
 * about it is a claim about which call was made with what.
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_VIEW_SETTINGS, type ViewSettings } from '@core/model';
import {
  applyInitialView,
  fitFor,
  layoutFor,
  zoomFor,
  type PanelTarget,
  type ViewTarget,
} from '@modules/M72-properties-metadata/apply';
import { DEFAULT_PROPERTIES_SETTINGS } from '@modules/M72-properties-metadata/settings';

function recorder(): ViewTarget & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    setLayout: (mode) => calls.push(`layout:${mode}`),
    setZoom: (percent) => calls.push(`zoom:${String(percent)}`),
    setFit: (fit) => calls.push(`fit:${String(fit)}`),
    goToPage: (page) => calls.push(`page:${String(page)}`),
  };
}

function panels(): PanelTarget & { shown: string[] } {
  const shown: string[] = [];
  return { shown, show: (id) => shown.push(id), collapse: () => shown.push('collapse') };
}

function view(patch: Partial<ViewSettings> = {}): ViewSettings {
  return { ...DEFAULT_VIEW_SETTINGS, ...patch };
}

describe('layoutFor', () => {
  it('maps every PDF layout to one the viewer has', () => {
    expect(layoutFor('default')).toBeNull();
    expect(layoutFor('single')).toBe('single');
    expect(layoutFor('one-column')).toBe('continuous');
    expect(layoutFor('two-column-left')).toBe('facingContinuous');
    expect(layoutFor('two-page-left')).toBe('facing');
    expect(layoutFor('two-page-right')).toBe('book');
  });
});

describe('zoomFor and fitFor', () => {
  it('reads a percentage only from an /XYZ destination', () => {
    expect(zoomFor(view({ initialFit: 'xyz', initialZoom: 1.5 }))).toBe(150);
    expect(zoomFor(view({ initialFit: 'fit', initialZoom: 1.5 }))).toBeNull();
  });

  it('treats "keep the current magnification" as no magnification at all', () => {
    // A `/XYZ` destination writes 0 (or null) for "leave the zoom as it is" — ISO 32000-1 12.3.2.2.
    expect(zoomFor(view({ initialFit: 'xyz', initialZoom: 0 }))).toBeNull();
    expect(zoomFor(view({ initialFit: 'xyz', initialZoom: null }))).toBeNull();
  });

  it('maps the fit modes the viewer understands', () => {
    expect(fitFor(view({ initialFit: 'fit' }))).toBe('page');
    expect(fitFor(view({ initialFit: 'fitH' }))).toBe('width');
    expect(fitFor(view({ initialFit: 'fitBV' }))).toBe('visible');
    expect(fitFor(view({ initialFit: 'xyz' }))).toBeNull();
  });
});

describe('applyInitialView', () => {
  it('sets the layout and the fit, then goes to the page', () => {
    const viewer = recorder();
    const panel = panels();
    const result = applyInitialView({
      view: view({ pageLayout: 'single', initialFit: 'fit', pageMode: 'outlines' }),
      settings: DEFAULT_PROPERTIES_SETTINGS,
      viewer,
      panels: panel,
      page: 2,
    });
    // The order matters: a layout or a zoom change moves the scroll, so the page goes last.
    expect(viewer.calls).toEqual(['layout:single', 'fit:page', 'page:2']);
    expect(result).toMatchObject({ layout: 'single', fit: 'page', page: 2, panel: null });
  });

  it('leaves the navigation panel to the reader, and says which one the file wanted', () => {
    // M12's rule, the operator's: `ui.leftPaneOnOpen` decides which panel opens, and a
    // `/PageMode /UseOutlines` does not override it.
    const panel = panels();
    const result = applyInitialView({
      view: view({ pageMode: 'outlines' }),
      settings: DEFAULT_PROPERTIES_SETTINGS,
      viewer: recorder(),
      panels: panel,
      page: null,
    });
    expect(panel.shown).toEqual([]);
    expect(result.panel).toBeNull();
    expect(result.ignored.join(' ')).toContain('the bookmarks panel');
    expect(result.ignored.join(' ')).toContain('your own setting');
  });

  it('does nothing at all when the reader has turned it off', () => {
    const viewer = recorder();
    const panel = panels();
    const result = applyInitialView({
      view: view({ pageLayout: 'single', pageMode: 'thumbnails' }),
      settings: { ...DEFAULT_PROPERTIES_SETTINGS, applyInitialView: false },
      viewer,
      panels: panel,
      page: 1,
    });
    expect(viewer.calls).toEqual([]);
    expect(panel.shown).toEqual([]);
    expect(result.ignored[0]).toContain('keep your own view');
  });

  it('applies a percentage when the destination is /XYZ', () => {
    const viewer = recorder();
    applyInitialView({
      view: view({ initialFit: 'xyz', initialZoom: 0.75 }),
      settings: DEFAULT_PROPERTIES_SETTINGS,
      viewer,
      panels: null,
      page: null,
    });
    expect(viewer.calls).toEqual(['zoom:75']);
  });

  it('says in words what it will not do', () => {
    const result = applyInitialView({
      view: view({ pageMode: 'fullscreen', hideToolbar: true, fitWindow: true }),
      settings: DEFAULT_PROPERTIES_SETTINGS,
      viewer: recorder(),
      panels: panels(),
      page: null,
    });
    expect(result.ignored.join(' ')).toContain('full screen');
    expect(result.ignored.join(' ')).toContain('hide parts of the application');
    expect(result.ignored.join(' ')).toContain('resize or centre the window');
  });

  it('leaves the pane alone for a document that asks for nothing', () => {
    const viewer = recorder();
    const panel = panels();
    const result = applyInitialView({
      view: view(),
      settings: DEFAULT_PROPERTIES_SETTINGS,
      viewer,
      panels: panel,
      page: null,
    });
    expect(viewer.calls).toEqual([]);
    expect(panel.shown).toEqual([]);
    expect(result.ignored).toEqual([]);
  });
});

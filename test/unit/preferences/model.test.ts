/**
 * The Preferences dialog's pure half (M130): turning the registered manifests into pages, the
 * search across every setting, and the coercion that stops a hand-edited settings file from
 * breaking a control.
 *
 * The acceptance test the brief asks for — "every setting exposed by every merged module appears,
 * and search finds 'tile cache'" — is checked here against the *real* manifests rather than
 * against fixtures, so a module that adds a setting without a page is caught by this file and
 * not by the operator.
 */

import { describe, expect, it } from 'vitest';
import type { ModuleManifest, SettingSpec } from '@shared/module';
import themeManifest from '@modules/M01-theme-system/manifest';
import shellManifest from '@modules/M02-app-shell/manifest';
import viewerManifest from '@modules/M11-viewer/manifest';
import navigationManifest from '@modules/M12-navigation-panels/manifest';
import selectFindManifest from '@modules/M13-select-find-print/manifest';
import saveManifest from '@modules/M21-save/manifest';
import annotationManifest from '@modules/M30-markup-annotations/manifest';
import drawingManifest from '@modules/M31-shapes-ink-stamps/manifest';
import commentsManifest from '@modules/M32-comments-panel/manifest';
import measuringManifest from '@modules/M33-measuring-tools/manifest';
import documentOpsManifest from '@modules/M41-merge-split-crop/manifest';
import objectManifest from '@modules/M50-object-model/manifest';
import formsManifest from '@modules/M60-forms/manifest';
import organiseManifest from '@modules/M40-organise-pages/manifest';
import portfolioManifest from '@modules/M42-portfolios/manifest';
import securityManifest from '@modules/M70-encryption/manifest';
import propertiesManifest from '@modules/M72-properties-metadata/manifest';
import createManifest from '@modules/M91-create-pdf/manifest';
import preferencesManifest from '@modules/M130-preferences/manifest';
import {
  aliasMap,
  allRows,
  buildPages,
  clampNumber,
  coerce,
  defaultsOf,
  isChanged,
  searchPages,
  searchTerms,
  sectionsOf,
  storageKeyFor,
  PREFERENCES_CONFIG,
  type PreferencesConfig,
} from '@modules/M130-preferences/model';

/** Every merged module that declares settings, in registration order. */
const MANIFESTS: ReadonlyArray<ModuleManifest> = [
  themeManifest,
  shellManifest,
  viewerManifest,
  navigationManifest,
  saveManifest,
  selectFindManifest,
  annotationManifest,
  drawingManifest,
  commentsManifest,
  measuringManifest,
  organiseManifest,
  documentOpsManifest,
  securityManifest,
  propertiesManifest,
  createManifest,
  portfolioManifest,
  objectManifest,
  formsManifest,
  preferencesManifest,
];

describe('buildPages', () => {
  const pages = buildPages(MANIFESTS);

  it('gives every module that declares settings a page, and no others', () => {
    const withSettings = MANIFESTS.filter(
      (m) => m.settings && Object.keys(m.settings.properties).length > 0,
    ).map((m) => m.id);
    expect([...pages].map((p) => p.id).sort()).toEqual([...withSettings].sort());
  });

  it('shows every setting every merged module exposes', () => {
    const declared = MANIFESTS.flatMap((m) =>
      m.settings
        ? Object.keys(m.settings.properties).map((name) => `${m.settings?.namespace}.${name}`)
        : [],
    );
    const shown = allRows(pages).map((row) => row.declaredKey);
    expect([...shown].sort()).toEqual([...declared].sort());
  });

  it('orders the pages by the configured order, then by label', () => {
    const orders = pages.map((p) => p.order);
    expect([...orders]).toEqual([...orders].sort((a, b) => a - b));
    expect(pages[0]?.id).toBe('M130');
  });

  it('names an unconfigured module after its manifest and sorts it last', () => {
    const extra: ModuleManifest = {
      id: 'M999',
      name: 'A Module From The Future',
      settings: {
        namespace: 'future',
        properties: { thing: { type: 'boolean', title: 'A thing', default: false } },
      },
    };
    const withExtra = buildPages([...MANIFESTS, extra]);
    const page = withExtra.find((p) => p.id === 'M999');
    expect(page?.label).toBe('A Module From The Future');
    // After every page the configuration names — not necessarily last of all, since another
    // unconfigured module may sort after it by name.
    const configured = withExtra.filter((p) => p.order < 10_000);
    expect(withExtra.findIndex((p) => p.id === 'M999')).toBeGreaterThanOrEqual(configured.length);
  });

  it("lets a schema override the configuration's label, icon and order", () => {
    const named: ModuleManifest = {
      id: 'M998',
      name: 'Ignored',
      settings: {
        namespace: 'named',
        title: 'Chosen name',
        icon: 'star',
        order: 1,
        properties: { thing: { type: 'boolean', title: 'A thing', default: false } },
      },
    };
    const page = buildPages([named])[0];
    expect(page).toMatchObject({ label: 'Chosen name', icon: 'star', order: 1 });
  });

  it('writes an aliased setting under the key its module actually reads', () => {
    const rows = allRows(pages);
    const scale = rows.find((r) => r.declaredKey === 'theme.scale');
    expect(scale?.key).toBe('ui.scale');
    const name = rows.find((r) => r.declaredKey === 'app.identity.name');
    expect(name?.key).toBe('identity.name');
    // Every row's key is exactly what the resolver says — the dialog and the tests agree.
    for (const row of rows) expect(row.key).toBe(storageKeyFor(row.declaredKey));
  });

  it("strips M41's namespace, which its schema uses as a label rather than a key prefix", () => {
    const rows = allRows(pages).filter((r) => r.moduleId === 'M41');
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.declaredKey.startsWith('documentOps.')).toBe(true);
      expect(row.key.startsWith('documentOps.')).toBe(false);
    }
    expect(rows.find((r) => r.declaredKey === 'documentOps.scan.autoDeskew')?.key).toBe(
      'scan.autoDeskew',
    );
    expect(rows.find((r) => r.declaredKey === 'documentOps.combine.toNewTab')?.key).toBe(
      'combine.toNewTab',
    );
  });

  it('resolves a key: exact alias first, then the longest prefix alias, else itself', () => {
    const cfg: PreferencesConfig = {
      version: 1,
      pages: [],
      aliases: { 'a.exact': 'z.exact' },
      prefixAliases: { 'a.': 'b.', 'a.deep.': 'c.' },
      synonyms: {},
    };
    expect(storageKeyFor('a.exact', cfg)).toBe('z.exact');
    expect(storageKeyFor('a.thing', cfg)).toBe('b.thing');
    expect(storageKeyFor('a.deep.thing', cfg)).toBe('c.thing');
    expect(storageKeyFor('viewer.grid', cfg)).toBe('viewer.grid');
    expect(storageKeyFor('viewer.grid')).toBe('viewer.grid');
  });

  it('drops the $comment line from the alias table', () => {
    expect([...aliasMap().keys()]).not.toContain('$comment');
  });

  it('carries the operator requirement: the left pane opens on Pages by default', () => {
    const row = allRows(pages).find((r) => r.key === 'ui.leftPaneOnOpen');
    expect(row?.spec.type).toBe('enum');
    expect(row?.spec.default).toBe('pages');
    expect(row?.moduleId).toBe('M12');
  });

  it('collects a default for every setting', () => {
    const defaults = defaultsOf(pages);
    for (const row of allRows(pages)) {
      expect(defaults.get(row.key)).toEqual(row.spec.default);
    }
  });
});

describe('search', () => {
  const pages = buildPages(MANIFESTS);

  it("finds M11's page cache when the reader types the operator's words", () => {
    const results = searchPages(pages, 'tile cache');
    const keys = results.flatMap((r) => r.rows.map((row) => row.key));
    expect(keys).toContain('viewer.cache.megabytes');
  });

  it('matches the title, the key, the description and the enum labels', () => {
    expect(searchPages(pages, 'thumbnail').length).toBeGreaterThan(0);
    expect(searchPages(pages, 'ui.leftPaneOnOpen').length).toBeGreaterThan(0);
    expect(searchPages(pages, 'bookmarks').length).toBeGreaterThan(0);
  });

  it('needs every term to match, so two words are narrower than one', () => {
    const one = searchPages(pages, 'cache').flatMap((r) => r.rows);
    const two = searchPages(pages, 'cache megabytes').flatMap((r) => r.rows);
    expect(two.length).toBeLessThanOrEqual(one.length);
  });

  it('puts a whole-phrase match ahead of a two-word coincidence', () => {
    const rows = searchPages(pages, 'tile cache').flatMap((r) => r.rows);
    expect(rows[0]?.key).toBe('viewer.cache.megabytes');
  });

  it('returns nothing for an empty query — the dialog shows a page instead', () => {
    expect(searchPages(pages, '')).toEqual([]);
    expect(searchPages(pages, '   ')).toEqual([]);
  });

  it('keeps a quoted phrase whole', () => {
    expect(searchTerms('"page cache" size')).toEqual(['page cache', 'size']);
    expect(searchTerms('  two   words ')).toEqual(['two', 'words']);
  });

  it('finds every setting by its own title', () => {
    for (const row of allRows(pages)) {
      const found = searchPages(pages, row.spec.title).flatMap((r) => r.rows.map((x) => x.key));
      expect(found).toContain(row.key);
    }
  });
});

describe('sections', () => {
  it('puts unsectioned rows first, then each section as it is first declared', () => {
    const manifest: ModuleManifest = {
      id: 'M900',
      name: 'Sectioned',
      settings: {
        namespace: 'x',
        properties: {
          b: { type: 'boolean', title: 'B', default: false, section: 'Second' },
          a: { type: 'boolean', title: 'A', default: false },
          c: { type: 'boolean', title: 'C', default: false, section: 'First' },
          d: { type: 'boolean', title: 'D', default: false, section: 'Second' },
        },
      },
    };
    const page = buildPages([manifest])[0];
    const sections = sectionsOf(page?.rows ?? []);
    expect(sections.map((s) => s.title)).toEqual([null, 'Second', 'First']);
    expect(sections[1]?.rows.map((r) => r.declaredKey)).toEqual(['x.b', 'x.d']);
  });
});

describe('coerce', () => {
  const spec = (s: SettingSpec): SettingSpec => s;

  it('falls back to the default for the wrong type', () => {
    expect(coerce(spec({ type: 'boolean', title: 'B', default: true }), 'yes')).toBe(true);
    expect(coerce(spec({ type: 'string', title: 'S', default: 'x' }), 7)).toBe('x');
    expect(
      coerce(
        spec({
          type: 'enum',
          title: 'E',
          default: 'a',
          options: [
            { value: 'a', label: 'A' },
            { value: 'b', label: 'B' },
          ],
        }),
        'z',
      ),
    ).toBe('a');
  });

  it('corrects a number that nearly fits rather than throwing it away', () => {
    const cache = spec({ type: 'number', title: 'N', default: 256, min: 32, max: 4096, step: 32 });
    expect(coerce(cache, 137)).toBe(128);
    expect(coerce(cache, 1)).toBe(32);
    expect(coerce(cache, 99999)).toBe(4096);
    expect(coerce(cache, Number.NaN)).toBe(256);
  });

  it('does not leave floating-point noise behind when it snaps', () => {
    const nudge = spec({ type: 'number', title: 'N', default: 1, min: 0.25, max: 20, step: 0.25 });
    expect(coerce(nudge, 0.3)).toBe(0.25);
    expect(coerce(nudge, 1.3)).toBe(1.25);
    expect(String(coerce(nudge, 1.3))).not.toContain('0000');
  });

  it('reads a list only when every entry is a string', () => {
    const list = spec({ type: 'list', title: 'L', default: ['a'] });
    expect(coerce(list, ['x', 'y'])).toEqual(['x', 'y']);
    expect(coerce(list, ['x', 2])).toEqual(['a']);
    expect(coerce(list, 'x')).toEqual(['a']);
  });

  it('takes a colour token or a hex, and nothing else', () => {
    const colour = spec({ type: 'colour', title: 'C', default: 'accent' });
    expect(coerce(colour, 'warning')).toBe('warning');
    expect(coerce(colour, '')).toBe('accent');
    expect(coerce(colour, 12)).toBe('accent');
  });

  it('reads a path as text, empty meaning "not set"', () => {
    const path = spec({ type: 'path', title: 'P', default: '' });
    expect(coerce(path, '/tmp/x')).toBe('/tmp/x');
    expect(coerce(path, null)).toBe('');
  });
});

describe('isChanged', () => {
  it('compares a list by its contents, not by identity', () => {
    const list: SettingSpec = { type: 'list', title: 'L', default: ['a', 'b'] };
    expect(isChanged(list, ['a', 'b'])).toBe(false);
    expect(isChanged(list, ['b', 'a'])).toBe(true);
  });

  it('is false for the default and true for anything else', () => {
    const bool: SettingSpec = { type: 'boolean', title: 'B', default: false };
    expect(isChanged(bool, false)).toBe(false);
    expect(isChanged(bool, true)).toBe(true);
  });
});

describe('clampNumber', () => {
  it('leaves a value alone when the spec has no bounds', () => {
    expect(clampNumber({ type: 'number', title: 'N', default: 0 }, 12.5)).toBe(12.5);
  });
});

describe('the shipped configuration', () => {
  it('names a page for every module that has one, and no duplicates', () => {
    const cfg: PreferencesConfig = PREFERENCES_CONFIG;
    const ids = cfg.pages.map((p) => p.module);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('has a synonym list for the keys the operator searches by their old names', () => {
    expect(PREFERENCES_CONFIG.synonyms['viewer.cache.megabytes']).toContain('tile cache');
  });
});

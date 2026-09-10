/**
 * Turning module manifests into the Preferences dialog (M130). Pure — no DOM, no IPC — so the
 * aggregation, the ordering and the search are unit-tested directly and the dialog only draws
 * what this returns.
 *
 * One page per **module**, not per namespace: M02 and M12 both write `ui.*`, and a reader
 * looking for "which panel opens with a document" wants it under Panels, not mixed in with the
 * ribbon. `resources/preferences.json` supplies the page order, icon and label; a module with no
 * entry there still gets a page, named after its manifest and sorted after the named ones, so a
 * module merged tomorrow needs no change here.
 */

import type { ModuleManifest, SettingSpec } from '@shared/module';
import config from '../../../../resources/preferences.json';

/** `resources/preferences.json`, typed. */
export interface PreferencesConfig {
  readonly version: number;
  readonly pages: ReadonlyArray<{
    readonly module: string;
    readonly label?: string;
    readonly icon?: string;
    readonly order?: number;
  }>;
  /** Declared key → the key the owning module's code actually reads. */
  readonly aliases: Readonly<Record<string, string>>;
  /** Extra search words per key. */
  readonly synonyms: Readonly<Record<string, ReadonlyArray<string>>>;
}

/** The shipped configuration. Exported so a test can vary it without touching the file. */
export const PREFERENCES_CONFIG = config as unknown as PreferencesConfig;

/** Aliases with the `$comment` line the JSON carries for the reader stripped out. */
export function aliasMap(cfg: PreferencesConfig = PREFERENCES_CONFIG): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  for (const [from, to] of Object.entries(cfg.aliases)) {
    if (from.startsWith('$') || typeof to !== 'string') continue;
    out.set(from, to);
  }
  return out;
}

/** One setting, as the dialog needs it. */
export interface SettingRow {
  /** The key the schema declares: `namespace` + `.` + the property name. */
  readonly declaredKey: string;
  /**
   * The key that is read and written. Usually the declared key; different only where a module's
   * schema and its code disagree and `resources/preferences.json` says so.
   */
  readonly key: string;
  readonly moduleId: string;
  readonly spec: SettingSpec;
  /** Lower-cased haystack the search matches against. */
  readonly haystack: string;
}

/** One page in the categories list. */
export interface PreferencesPage {
  /** The module id — also the DOM id suffix and the value of `?page=`. */
  readonly id: string;
  readonly label: string;
  readonly icon: string;
  readonly order: number;
  readonly rows: ReadonlyArray<SettingRow>;
}

/** Fallback icon for a module with no entry in the configuration. */
const DEFAULT_ICON = 'settings-2';
/** Modules with no configured order sort after every configured one, alphabetically by label. */
const UNCONFIGURED_ORDER = 10_000;

function haystackFor(key: string, spec: SettingSpec, synonyms: ReadonlyArray<string>): string {
  const parts: string[] = [key, key.replaceAll('.', ' '), spec.title];
  if (spec.description) parts.push(spec.description);
  if (spec.keywords) parts.push(...spec.keywords);
  parts.push(...synonyms);
  if (spec.type === 'enum') for (const option of spec.options) parts.push(option.label);
  return parts.join(' ').toLowerCase();
}

/**
 * Builds the pages. Modules with no `settings` schema, or with an empty one, get no page — an
 * empty category is a dead end for the reader, and the module registry is full of them (M00,
 * M10, M20 hold no settings at all).
 */
export function buildPages(
  manifests: ReadonlyArray<ModuleManifest>,
  cfg: PreferencesConfig = PREFERENCES_CONFIG,
): ReadonlyArray<PreferencesPage> {
  const aliases = aliasMap(cfg);
  const configured = new Map(cfg.pages.map((p) => [p.module, p]));
  const pages: PreferencesPage[] = [];
  for (const manifest of manifests) {
    const schema = manifest.settings;
    if (!schema) continue;
    const rows: SettingRow[] = [];
    for (const [name, spec] of Object.entries(schema.properties)) {
      const declaredKey = `${schema.namespace}.${name}`;
      const key = aliases.get(declaredKey) ?? declaredKey;
      rows.push({
        declaredKey,
        key,
        moduleId: manifest.id,
        spec,
        haystack: haystackFor(
          declaredKey,
          spec,
          cfg.synonyms[declaredKey] ?? cfg.synonyms[key] ?? [],
        ),
      });
    }
    if (rows.length === 0) continue;
    const entry = configured.get(manifest.id);
    pages.push({
      id: manifest.id,
      label: schema.title ?? entry?.label ?? manifest.name,
      icon: schema.icon ?? entry?.icon ?? DEFAULT_ICON,
      order: schema.order ?? entry?.order ?? UNCONFIGURED_ORDER,
      rows,
    });
  }
  return pages.sort((a, b) => a.order - b.order || a.label.localeCompare(b.label));
}

/** Every row on every page, in page order. */
export function allRows(pages: ReadonlyArray<PreferencesPage>): ReadonlyArray<SettingRow> {
  return pages.flatMap((p) => p.rows);
}

/** The default value of every setting, by the key it is written under. */
export function defaultsOf(pages: ReadonlyArray<PreferencesPage>): ReadonlyMap<string, unknown> {
  const out = new Map<string, unknown>();
  for (const row of allRows(pages)) out.set(row.key, row.spec.default);
  return out;
}

/**
 * Search terms from what the reader typed. Quoted phrases stay whole; everything else splits on
 * whitespace. Every term has to match somewhere in the row, so "tile cache" is narrower than
 * "tile", not a synonym for it.
 */
export function searchTerms(query: string): ReadonlyArray<string> {
  const terms: string[] = [];
  const re = /"([^"]+)"|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(query)) !== null) {
    const term = (match[1] ?? match[2] ?? '').trim().toLowerCase();
    if (term.length > 0) terms.push(term);
  }
  return terms;
}

/**
 * Rows matching every term, page by page. An empty query matches nothing here — the dialog shows
 * the selected page instead, which is a different thing from "everything matched".
 *
 * A whole multi-word phrase is tried first, so typing "tile cache" finds the setting whose
 * synonym list says exactly that, ahead of a row that happens to contain both words apart.
 */
export function searchPages(
  pages: ReadonlyArray<PreferencesPage>,
  query: string,
): ReadonlyArray<{ readonly page: PreferencesPage; readonly rows: ReadonlyArray<SettingRow> }> {
  const terms = searchTerms(query);
  if (terms.length === 0) return [];
  const phrase = query.trim().toLowerCase();
  const results: { page: PreferencesPage; rows: SettingRow[] }[] = [];
  for (const page of pages) {
    const exact: SettingRow[] = [];
    const partial: SettingRow[] = [];
    for (const row of page.rows) {
      if (terms.length > 1 && row.haystack.includes(phrase)) exact.push(row);
      else if (terms.every((t) => row.haystack.includes(t))) partial.push(row);
    }
    const rows = [...exact, ...partial];
    if (rows.length > 0) results.push({ page, rows });
  }
  return results;
}

/**
 * Coerces a stored value to the setting's type, falling back to the default.
 *
 * A settings file can be hand-edited, can come from an older build, or can carry a key another
 * module once owned. None of those may crash a control, so anything that does not fit reads as
 * the default — and, for numbers and enums, a value that nearly fits is corrected rather than
 * thrown away: 137 on a 32-step slider becomes 128, not the default.
 */
export function coerce(spec: SettingSpec, value: unknown): unknown {
  switch (spec.type) {
    case 'boolean':
      return typeof value === 'boolean' ? value : spec.default;
    case 'number': {
      const n = typeof value === 'number' ? value : Number(value);
      if (!Number.isFinite(n)) return spec.default;
      return clampNumber(spec, n);
    }
    case 'enum':
      return spec.options.some((o) => o.value === value) ? value : spec.default;
    case 'string':
    case 'path':
      return typeof value === 'string' ? value : spec.default;
    case 'colour':
      return typeof value === 'string' && value.trim() !== '' ? value : spec.default;
    case 'list':
      return Array.isArray(value) && value.every((v) => typeof v === 'string')
        ? value
        : [...spec.default];
  }
}

/** Clamps to `min`/`max` and snaps to `step` from `min` (or from zero when there is no min). */
export function clampNumber(spec: Extract<SettingSpec, { type: 'number' }>, value: number): number {
  let n = value;
  if (spec.step !== undefined && spec.step > 0) {
    const base = spec.min ?? 0;
    n = base + Math.round((n - base) / spec.step) * spec.step;
    // Snapping in floating point leaves 0.30000000000000004 behind; the step decides the places.
    const places = decimalPlaces(spec.step);
    n = Number(n.toFixed(places));
  }
  if (spec.min !== undefined) n = Math.max(spec.min, n);
  if (spec.max !== undefined) n = Math.min(spec.max, n);
  return n;
}

function decimalPlaces(step: number): number {
  const text = String(step);
  const dot = text.indexOf('.');
  return dot < 0 ? 0 : Math.min(6, text.length - dot - 1);
}

/**
 * A page's rows split into the sections their schemas name, in declaration order: unsectioned
 * rows first (under no heading), then each section the first time it is mentioned.
 */
export function sectionsOf(
  rows: ReadonlyArray<SettingRow>,
): ReadonlyArray<{ readonly title: string | null; readonly rows: ReadonlyArray<SettingRow> }> {
  const order: (string | null)[] = [];
  const byTitle = new Map<string | null, SettingRow[]>();
  for (const row of rows) {
    const title = row.spec.section ?? null;
    if (!byTitle.has(title)) {
      byTitle.set(title, []);
      order.push(title);
    }
    byTitle.get(title)?.push(row);
  }
  // Unsectioned rows lead, whatever order they were declared in.
  order.sort((a, b) => (a === null ? -1 : 0) - (b === null ? -1 : 0));
  return order.map((title) => ({ title, rows: byTitle.get(title) ?? [] }));
}

/** True when the stored value differs from the schema default. Drives "Reset" being enabled. */
export function isChanged(spec: SettingSpec, value: unknown): boolean {
  if (spec.type === 'list') {
    const list = Array.isArray(value) ? value : spec.default;
    return JSON.stringify(list) !== JSON.stringify(spec.default);
  }
  return value !== spec.default;
}

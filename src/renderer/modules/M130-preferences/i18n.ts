/**
 * Localisation (M130). A framework and a proof, not a translation.
 *
 * ```ts
 * t('prefs.title', 'Preferences')                     // → "Preferences"
 * t('prefs.found', '{n} settings match', { n: 4 })    // → "4 settings match"
 * ```
 *
 * **Keys and fallbacks.** Every call site carries its own English, so the app reads correctly
 * with no catalogue at all — a missing key is never a blank label or a raw `prefs.title` on
 * screen. `scripts/extract-i18n.ts` walks the source for those call sites and writes
 * `resources/i18n/en-GB.json` from them, so the catalogue can never drift from the code without
 * the script saying so.
 *
 * **Languages.** en-GB is the source language. en-US is generated from it by applying the
 * spelling table in `resources/i18n/spelling-en-US.json`, which makes it a real catalogue the
 * script can regenerate rather than a special case in the lookup — and proves the switch works
 * with words the operator can actually see change (Colour → Color, Customise → Customize).
 *
 * Lookup order: the chosen language, then en-GB, then the fallback at the call site.
 */

import languagesJson from '../../../../resources/i18n/languages.json';

/** One shipped language. */
export interface LanguageInfo {
  readonly id: string;
  readonly label: string;
  /** A sentence for the picker — what is different about it. */
  readonly note?: string;
}

interface LanguagesFile {
  readonly version: number;
  readonly languages: ReadonlyArray<LanguageInfo>;
}

interface CatalogueFile {
  readonly language: string;
  readonly strings: Readonly<Record<string, string>>;
}

/** The source language: what every fallback in the code is written in. */
export const SOURCE_LANGUAGE = 'en-GB';

const LANGUAGES = languagesJson as unknown as LanguagesFile;

/**
 * Catalogues, loaded as their own chunks. `eager` because there are two of them and they are a
 * few kilobytes: a language switch that has to wait for a network-shaped import would flicker.
 */
const catalogueModules = import.meta.glob<{ default: CatalogueFile }>(
  '../../../../resources/i18n/*.json',
  { eager: true },
);

function loadCatalogues(): ReadonlyMap<string, Readonly<Record<string, string>>> {
  const out = new Map<string, Readonly<Record<string, string>>>();
  for (const [path, module] of Object.entries(catalogueModules)) {
    const name = path.split('/').pop() ?? '';
    // `languages.json` and `spelling-*.json` live in the same folder and are not catalogues.
    if (!/^[a-z]{2}-[A-Z]{2}\.json$/.test(name)) continue;
    const file = module.default;
    if (!file || typeof file.strings !== 'object') continue;
    out.set(file.language ?? name.replace('.json', ''), file.strings);
  }
  return out;
}

const CATALOGUES = loadCatalogues();

/** Languages that actually have a catalogue, in the order `languages.json` lists them. */
export function availableLanguages(): ReadonlyArray<LanguageInfo> {
  const declared = LANGUAGES.languages;
  const usable = declared.filter((l) => CATALOGUES.has(l.id));
  // A build with no catalogues at all still has to offer the source language.
  return usable.length > 0 ? usable : [{ id: SOURCE_LANGUAGE, label: 'English (United Kingdom)' }];
}

export function isLanguage(value: unknown): value is string {
  return typeof value === 'string' && availableLanguages().some((l) => l.id === value);
}

let current = SOURCE_LANGUAGE;
const listeners = new Set<(language: string) => void>();

/** The active language id. */
export function language(): string {
  return current;
}

/**
 * Switches language. Sets `<html lang>` so the browser hyphenates and a screen reader
 * pronounces correctly, and notifies subscribers so open dialogs redraw. Unknown ids fall back
 * to the source language rather than leaving the app in a state with no catalogue.
 */
export function setLanguage(id: string): string {
  const next = isLanguage(id) ? id : SOURCE_LANGUAGE;
  if (next === current) return current;
  current = next;
  if (typeof document !== 'undefined') document.documentElement.lang = next;
  for (const listener of Array.from(listeners)) {
    try {
      listener(next);
    } catch (error) {
      console.warn('i18n: a language listener threw', error);
    }
  }
  return current;
}

export function onLanguageChange(listener: (language: string) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Looks a string up. `fallback` is the English at the call site and is what the extractor reads,
 * so it must be a plain literal — never a template or a concatenation.
 *
 * `vars` fills `{name}` placeholders. A placeholder with no matching variable is left as it is:
 * showing `{count}` is a bug the reader can report, where showing nothing is one they cannot.
 */
export function t(
  key: string,
  fallback: string,
  vars?: Readonly<Record<string, string | number>>,
): string {
  return lookup(key, fallback, vars);
}

/** The lookup itself. Separate from {@link t} so helpers can use it without looking like a call site to the extractor. */
function lookup(
  key: string,
  fallback: string,
  vars?: Readonly<Record<string, string | number>>,
): string {
  const chosen = CATALOGUES.get(current)?.[key];
  const source = chosen ?? CATALOGUES.get(SOURCE_LANGUAGE)?.[key] ?? fallback;
  return vars ? interpolate(source, vars) : source;
}

/** Replaces `{name}` with `vars.name`. Exported for the tests. */
export function interpolate(text: string, vars: Readonly<Record<string, string | number>>): string {
  return text.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in vars ? String(vars[name]) : whole,
  );
}

/**
 * Plural helper. English needs two forms; a language that needs more gets its own rule here
 * rather than at every call site.
 */
export function plural(
  count: number,
  keyOne: string,
  one: string,
  keyMany: string,
  many: string,
): string {
  return count === 1 ? lookup(keyOne, one, { n: count }) : lookup(keyMany, many, { n: count });
}

/** Catalogue contents, for the tests and for the extract script's coverage report. */
export function catalogue(id: string): Readonly<Record<string, string>> | undefined {
  return CATALOGUES.get(id);
}

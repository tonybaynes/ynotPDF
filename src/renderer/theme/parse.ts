/**
 * Tiny parser for theme CSS files (M01). A theme file is one rule block,
 * `[data-theme='name'] { color-scheme: dark; --token: #hex; ... }`, so a regex is enough — no
 * CSS parser dependency. Used by the contrast tests, the gallery page and the ThemeManager
 * (for reporting values without `getComputedStyle`).
 */

export interface ParsedTheme {
  /** Theme name taken from the `[data-theme='…']` selector. */
  readonly name: string;
  /** `dark` or `light` from the `color-scheme` declaration. */
  readonly colorScheme: string | undefined;
  /** Every `--token` → raw value (trimmed, without the trailing `;`). */
  readonly tokens: ReadonlyMap<string, string>;
}

const BLOCK_RE = /\[data-theme=['"]([a-z0-9-]+)['"]\]\s*\{([\s\S]*?)\}/g;
const DECL_RE = /(--[a-z0-9-]+|color-scheme)\s*:\s*([^;]+);/g;

/** Strips `/* … *\/` comments. */
export function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** Parses one theme file. Throws if it has no `[data-theme]` block. */
export function parseThemeCss(css: string): ParsedTheme {
  const clean = stripCssComments(css);
  const tokens = new Map<string, string>();
  let name: string | undefined;
  let colorScheme: string | undefined;
  for (const block of clean.matchAll(BLOCK_RE)) {
    name ??= block[1];
    const body = block[2] ?? '';
    for (const decl of body.matchAll(DECL_RE)) {
      const key = decl[1];
      const value = (decl[2] ?? '').trim();
      if (!key) continue;
      if (key === 'color-scheme') colorScheme = value;
      else tokens.set(key, value);
    }
  }
  if (!name) throw new Error('theme css has no [data-theme] block');
  return { name, colorScheme, tokens };
}

/** Names of every `--token` declared in `tokens.css` documentation order. */
export function tokenNamesFromDocs(tokensCss: string): string[] {
  const names: string[] = [];
  for (const m of tokensCss.matchAll(/^\s*\*\s+(--[a-z0-9-]+)\b/gm)) {
    const n = m[1];
    if (n && !names.includes(n)) names.push(n);
  }
  return names;
}

/** True when the raw value is a plain hex colour (`#rgb`/`#rrggbb`). */
export function isHexColor(value: string): boolean {
  return /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(value.trim());
}

/**
 * The pure half of `scripts/extract-i18n.ts` (M130): finding `t()` call sites in a source file
 * and re-spelling a string through a whole-word table. No file system, so it is unit-tested
 * directly — same split as `style-rules.ts` and `check-styles.ts`.
 */

/** One `t('key', 'English text')` call site. */
export interface ExtractedString {
  readonly key: string;
  readonly text: string;
  /** Repo-relative path of the file it was found in. */
  readonly where: string;
}

export interface ExtractResult {
  readonly found: ReadonlyArray<ExtractedString>;
  /** `t(` calls whose key is not a plain string literal, so nothing can be extracted from them. */
  readonly suspects: number;
}

/**
 * `t('key', 'text')` with either quote style, a line break allowed between the arguments and an
 * optional third argument for the interpolation variables. Escaped quotes inside a literal are
 * handled.
 */
const CALL = /\bt\(\s*(['"])((?:\\.|(?!\1)[^\\])*)\1\s*,\s*(['"])((?:\\.|(?!\3)[^\\])*)\3\s*[,)]/g;

/** A `t(` whose first argument is not a plain string literal — a template, a variable, a call. */
/** The helper's own declaration, which is not a call site. */
const DECLARATION = new RegExp('\\bfunction\\s+t\\s*\\(', 'g');

const SUSPECT = /\bt\(\s*(?!['"])[^)\s]/g;

/** Turns a source literal back into the string it denotes. */
export function unescapeLiteral(literal: string): string {
  return literal
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\'/g, "'")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\');
}

/** Every `t()` call site in one file. */
export function extractStrings(source: string, where: string): ExtractResult {
  const found: ExtractedString[] = [];
  for (const match of source.matchAll(CALL)) {
    found.push({
      key: unescapeLiteral(match[2] ?? ''),
      text: unescapeLiteral(match[4] ?? ''),
      where,
    });
  }
  // A `function t(...)` declaration is not a call site; without this every file that defines or
  // re-exports the helper reports itself as untranslatable.
  const scanned = source.replace(DECLARATION, 'function tDeclaration(');
  return { found, suspects: [...scanned.matchAll(SUSPECT)].length };
}

/**
 * Applies a whole-word replacement table, keeping the original word's capitalisation: one entry
 * `colour → color` covers "colour", "Colour" and "COLOUR". Only runs of ASCII letters are
 * candidates, so "millimetres (mm)" changes the word and leaves the abbreviation alone.
 */
export function respell(text: string, words: Readonly<Record<string, string>>): string {
  return text.replace(/[A-Za-z]+/g, (word) => {
    const replacement = words[word.toLowerCase()];
    if (replacement === undefined) return word;
    if (word.length > 1 && word === word.toUpperCase()) return replacement.toUpperCase();
    const initial = word.charAt(0);
    if (initial === initial.toUpperCase()) {
      return replacement.charAt(0).toUpperCase() + replacement.slice(1);
    }
    return replacement;
  });
}

/** The catalogue file's text, keys sorted so a regenerated file has a stable diff. */
export function catalogueJson(
  language: string,
  strings: Readonly<Record<string, string>>,
  note: string,
): string {
  const sorted: Record<string, string> = {};
  for (const key of Object.keys(strings).sort()) sorted[key] = strings[key] ?? '';
  return `${JSON.stringify({ $comment: note, language, strings: sorted }, null, 2)}\n`;
}

/** Only the strings a spelling table actually changes — the variant catalogue's contents. */
export function spellingVariant(
  strings: Readonly<Record<string, string>>,
  words: Readonly<Record<string, string>>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, text] of Object.entries(strings)) {
    const respelt = respell(text, words);
    if (respelt !== text) out[key] = respelt;
  }
  return out;
}

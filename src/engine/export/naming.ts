/**
 * File names for a per-page export (M92).
 *
 * The same idea as M41's split pattern (`engine/ops/split.ts`), and it borrows that module's
 * `safeFileName` so a name is cleaned the same way wherever it came from — but the tokens are
 * different, because "page 7 of a document at 150 dpi" is not "part 3 of a split".
 *
 * Tokens: `{name}` the document's own name, `{page}` the 1-based page number zero-padded to the
 * width of the last page, `{n}` the same number unpadded, `{label}` the page's own label when the
 * document numbers its pages itself (i, ii, A-5), `{index}` the 1-based position within *this*
 * export rather than within the document, `{dpi}`, `{total}`, `{date}` and `{time}`.
 *
 * An unknown `{token}` is left exactly as it was typed, so a typo shows up in the file name
 * instead of silently disappearing — M41's rule, for M41's reason.
 */

import { safeFileName } from '../ops/split';

export const DEFAULT_IMAGE_PATTERN = '{name}_page{page}';

export interface NameValues {
  /** The document's name, without its extension. */
  readonly name: string;
  /** 0-based page index in the document. */
  readonly page: number;
  /** 0-based position within this export. */
  readonly index: number;
  /** How many files this export is producing. */
  readonly total: number;
  /** The last page number in the document, which sets the zero padding. */
  readonly pageCount: number;
  readonly dpi?: number;
  /** The page's own label, when the document numbers its pages itself. */
  readonly label?: string;
  /** For `{date}` / `{time}`; the caller passes one for the whole export so a run is consistent. */
  readonly when?: Date;
}

function two(n: number): string {
  return String(n).padStart(2, '0');
}

/** Fills a name pattern and appends `extension` (with its dot). */
export function fillImageName(pattern: string, extension: string, values: NameValues): string {
  const when = values.when ?? new Date();
  const width = String(Math.max(1, values.pageCount)).length;
  const table: Readonly<Record<string, string>> = {
    name: values.name,
    page: String(values.page + 1).padStart(width, '0'),
    n: String(values.page + 1),
    index: String(values.index + 1).padStart(String(Math.max(1, values.total)).length, '0'),
    total: String(values.total),
    label: values.label ?? String(values.page + 1),
    dpi: String(values.dpi ?? 0),
    date: `${String(when.getFullYear())}-${two(when.getMonth() + 1)}-${two(when.getDate())}`,
    time: `${two(when.getHours())}${two(when.getMinutes())}${two(when.getSeconds())}`,
  };
  const filled = pattern.replace(/\{(\w+)\}/g, (whole, key: string) => table[key] ?? whole);
  return `${safeFileName(filled)}${extension}`;
}

/**
 * Makes every name in a list unique by appending ` (2)`, ` (3)` … to repeats.
 *
 * A pattern with no page token — a reader who typed `{name}` and nothing else — would otherwise
 * write every page over the top of the last one, which is the worst way to find out. Comparison
 * is case-insensitive because Windows and macOS treat `Page1.png` and `page1.png` as one file.
 */
export function uniqueNames(names: ReadonlyArray<string>): string[] {
  const seen = new Map<string, number>();
  return names.map((name) => {
    const key = name.toLowerCase();
    const count = seen.get(key) ?? 0;
    seen.set(key, count + 1);
    if (count === 0) return name;
    const dot = name.lastIndexOf('.');
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const extension = dot > 0 ? name.slice(dot) : '';
    return `${stem} (${String(count + 1)})${extension}`;
  });
}

/** `"Report.pdf"` → `"Report"`. Used for `{name}` and for the default output file. */
export function documentStem(fileName: string): string {
  const base = fileName.replace(/^.*[\\/]/, '');
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  return safeFileName(stem === '' ? 'Document' : stem);
}

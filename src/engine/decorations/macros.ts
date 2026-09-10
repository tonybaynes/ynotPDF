/**
 * Macro expansion for headers, footers and Bates numbers (M53).
 *
 * The catalogue — which tokens exist, what they are called and what they mean — is data in
 * `resources/presets/macros.json`; this file is the expander. A token the catalogue names but
 * this build has no `type` for is **left on the page exactly as written**, so a macro added to
 * the data file without the code behind it is visible rather than silently blank.
 *
 * Dates are formatted here rather than through `Intl`, on purpose. A header written on the
 * operator's Windows machine and re-rendered on a Linux CI runner has to say the same words, and
 * `Intl`'s output for a locale is a property of the platform's ICU build, not of the input.
 *
 * Pure: no clock, no engine, no DOM. The moment a decoration was applied arrives in
 * `DocumentContext.now`.
 */

import catalogue from '../../../resources/presets/macros.json';
import type { DocumentContext, PageContext } from './types';

/** What the expander can do with a token. */
export type MacroType =
  | 'page-number'
  | 'page-of-total'
  | 'page-total'
  | 'page-label'
  | 'bates'
  | 'file-name'
  | 'full-path'
  | 'title'
  | 'author'
  | 'subject'
  | 'date'
  | 'time'
  | 'date-pattern';

/** One entry of the catalogue, for the dialog's insert menu. */
export interface MacroEntry {
  readonly token: string;
  readonly type: string;
  readonly label: string;
  readonly description: string;
  readonly example: string;
}

function readCatalogue(value: unknown): ReadonlyArray<MacroEntry> {
  const macros = (value as { macros?: unknown }).macros;
  if (!Array.isArray(macros)) return [];
  const out: MacroEntry[] = [];
  for (const raw of macros) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const text = (key: string): string => (typeof r[key] === 'string' ? r[key] : '');
    if (text('token') === '' || text('type') === '') continue;
    out.push({
      token: text('token'),
      type: text('type'),
      label: text('label') || text('token'),
      description: text('description'),
      example: text('example'),
    });
  }
  return out;
}

/** The macros the dialogs offer, in the order the data file lists them. */
export const MACROS: ReadonlyArray<MacroEntry> = readCatalogue(catalogue);

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function two(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * Formats a date by an explicit pattern. Recognised: `yyyy yy MMMM MMM MM M dddd ddd dd d
 * HH mm ss`. Anything else is copied through, and text inside single quotes is literal.
 */
export function formatDate(date: Date, pattern: string): string {
  let out = '';
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i] ?? '';
    if (ch === "'") {
      const end = pattern.indexOf("'", i + 1);
      if (end < 0) {
        out += pattern.slice(i + 1);
        break;
      }
      out += end === i + 1 ? "'" : pattern.slice(i + 1, end);
      i = end + 1;
      continue;
    }
    let run = 0;
    while (pattern[i + run] === ch) run++;
    const token = ch.repeat(run);
    switch (token) {
      case 'yyyy':
        out += String(date.getFullYear()).padStart(4, '0');
        break;
      case 'yy':
        out += two(date.getFullYear() % 100);
        break;
      case 'MMMM':
        out += MONTHS[date.getMonth()] ?? '';
        break;
      case 'MMM':
        out += (MONTHS[date.getMonth()] ?? '').slice(0, 3);
        break;
      case 'MM':
        out += two(date.getMonth() + 1);
        break;
      case 'M':
        out += String(date.getMonth() + 1);
        break;
      case 'dddd':
        out += DAYS[date.getDay()] ?? '';
        break;
      case 'ddd':
        out += (DAYS[date.getDay()] ?? '').slice(0, 3);
        break;
      case 'dd':
        out += two(date.getDate());
        break;
      case 'd':
        out += String(date.getDate());
        break;
      case 'HH':
        out += two(date.getHours());
        break;
      case 'H':
        out += String(date.getHours());
        break;
      case 'mm':
        out += two(date.getMinutes());
        break;
      case 'm':
        out += String(date.getMinutes());
        break;
      case 'ss':
        out += two(date.getSeconds());
        break;
      case 's':
        out += String(date.getSeconds());
        break;
      default:
        out += token;
    }
    i += run;
  }
  return out;
}

/** A Bates number: prefix, the value zero-padded to `digits`, suffix. */
export function batesNumber(options: {
  readonly prefix: string;
  readonly suffix: string;
  readonly digits: number;
  readonly value: number;
}): string {
  const digits = Math.max(1, Math.min(15, Math.round(options.digits)));
  const value = Math.max(0, Math.round(options.value));
  return `${options.prefix}${String(value).padStart(digits, '0')}${options.suffix}`;
}

/**
 * A macro occurrence: `<<...>>` with anything but `>` inside. Greedy would swallow two macros
 * written next to each other, so the body is "not a `>`" rather than "anything".
 */
const MACRO = /<<([^>]*)>>/g;

/** The date a page context describes, defaulting to the epoch when `now` is not a date. */
function dateOf(document: DocumentContext): Date {
  const parsed = new Date(document.now);
  return Number.isNaN(parsed.getTime()) ? new Date(0) : parsed;
}

/**
 * Expands the macros in one zone's text.
 *
 * `<<1>>` and `<<1 of n>>` count within the decoration's own range, which is what a reader who
 * put a header on pages 5–20 means by "page 1": the first page they decorated. `startNumber`
 * moves that; `totalOverride` replaces the `n`.
 */
export function expandMacros(
  text: string,
  page: PageContext,
  options: { readonly startNumber?: number; readonly totalOverride?: number } = {},
): string {
  if (text === '') return '';
  const start = options.startNumber ?? 1;
  const number = start + page.ordinal - 1;
  const total = options.totalOverride && options.totalOverride > 0
    ? options.totalOverride
    : page.rangeCount;
  const doc = page.document;
  return text.replace(MACRO, (whole, body: string) => {
    const trimmed = body.trim();
    if (trimmed.toLowerCase().startsWith('d:')) return formatDate(dateOf(doc), body.trim().slice(2));
    const entry = MACROS.find((m) => m.token === `<<${body}>>` || m.token === `<<${trimmed}>>`);
    const type = entry?.type ?? impliedType(trimmed);
    switch (type) {
      case 'page-number':
        return String(number);
      case 'page-of-total':
        return `${String(number)} of ${String(total)}`;
      case 'page-total':
        return String(total);
      case 'page-label':
        return doc.labels[page.index] ?? String(page.index + 1);
      case 'bates':
        return doc.bates ?? '';
      case 'file-name':
        return doc.fileName;
      case 'full-path':
        return doc.fullPath;
      case 'title':
        return doc.title;
      case 'author':
        return doc.author;
      case 'subject':
        return doc.subject;
      case 'date':
        return formatDate(dateOf(doc), 'dd/MM/yyyy');
      case 'time':
        return formatDate(dateOf(doc), 'HH:mm');
      default:
        // A token this build does not know stays on the page as the reader wrote it.
        return whole;
    }
  });
}

/**
 * The three tokens whose *shape* is their meaning, so a reader can type `<<3>>` to start the
 * numbering at 3 without going near the catalogue. `<<1>>` and `<<1 of n>>` are in the data file
 * as well, because they are what the insert menu offers.
 */
function impliedType(body: string): MacroType | null {
  if (/^\d+$/.test(body)) return 'page-number';
  if (/^\d+\s+of\s+n$/i.test(body)) return 'page-of-total';
  if (/^n$/i.test(body)) return 'page-total';
  return null;
}

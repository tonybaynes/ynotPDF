/**
 * CSV export of a search result set (M13). RFC 4180 quoting, CRLF line endings, and a UTF-8
 * byte-order mark so a spreadsheet opens it as Unicode rather than guessing at the code page.
 */

import type { SearchHit } from './search';

const HEADER = ['Document', 'Path', 'Page', 'Where', 'Label', 'Context'] as const;

/** UTF-8 byte-order mark, written as an escape so it is visible in review. */
export const BOM = '\uFEFF';

const CRLF = '\r\n';

function quote(value: string): string {
  return `"${value.replace(/"/gu, '""')}"`;
}

/** One CSV row per hit, in the order the results tree shows them. */
export function hitsToCsv(hits: ReadonlyArray<SearchHit>): string {
  const rows = [HEADER.map(quote).join(',')];
  for (const hit of hits) {
    rows.push(
      [
        quote(hit.documentName),
        quote(hit.documentId),
        quote(hit.page >= 0 ? String(hit.page + 1) : ''),
        quote(hit.source),
        quote(hit.label ?? ''),
        quote(hit.snippet),
      ].join(','),
    );
  }
  return BOM + rows.join(CRLF) + CRLF;
}

/** The CSV as bytes, ready for `file:write`. */
export function csvBytes(hits: ReadonlyArray<SearchHit>): Uint8Array {
  return new TextEncoder().encode(hitsToCsv(hits));
}

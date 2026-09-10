/**
 * Plain-text export (M92).
 *
 * The reading order is M13's, unchanged: `view/TextLayer.ts` sorted the runs into lines and this
 * writes those lines out. That is the point — a reader who searched for a phrase in the find bar
 * and then exported the text must get the same words in the same order, and there is only one
 * piece of code that decides what that order is.
 *
 * What is added on top: a page separator (nothing, a blank line, a rule, or a form feed — which
 * is what a printer and most editors understand by "new page"), line endings, and the encoding.
 *
 * **UTF-16 is written little-endian with a byte-order mark**, because that is what Windows means
 * by "Unicode" in a Save-As box and what Notepad, Word and PowerShell read without being told.
 * UTF-8's BOM is optional and off by default: it helps Excel and older Windows tools and hurts
 * almost everything else, so it is a checkbox rather than a decision made for the reader.
 */

import { checkCancelled, type ExportContext, type ExportResult } from './types';
import type { ExportPage } from './textModel';

export type TextEncoding = 'utf-8' | 'utf-16le' | 'utf-16be';
export type LineEnding = 'lf' | 'crlf';
export type PageSeparator = 'none' | 'blank-line' | 'rule' | 'form-feed' | 'numbered';

export interface TextExportOptions {
  readonly encoding?: TextEncoding;
  readonly lineEnding?: LineEnding;
  readonly pageSeparator?: PageSeparator;
  /** UTF-8 only; UTF-16 always gets one (see the file header). */
  readonly bom?: boolean;
  /** Drop lines that are empty or only whitespace. */
  readonly skipBlankLines?: boolean;
  readonly documentName: string;
}

const RULE = '────────────────────────────────────────';

/** The text of one page, lines joined by `\n` and no trailing separator. */
export function pageToText(page: ExportPage, skipBlank = false): string {
  const lines: string[] = [];
  for (const line of page.text.lines) {
    const text = page.text.text.slice(line.start, line.end);
    if (skipBlank && text.trim() === '') continue;
    lines.push(text);
  }
  // A page with no line grouping at all (an image-only page) still has its raw text, if any.
  if (lines.length === 0 && page.text.text.trim() !== '') {
    return page.text.text.replace(/\n+$/, '');
  }
  return lines.join('\n');
}

/** The separator written *between* two pages, in `\n` terms. */
function separatorFor(kind: PageSeparator, nextPage: ExportPage): string {
  switch (kind) {
    case 'none':
      return '\n';
    case 'blank-line':
      return '\n\n';
    case 'rule':
      return `\n\n${RULE}\n\n`;
    case 'form-feed':
      return '\n\f';
    case 'numbered':
      return `\n\n[Page ${nextPage.label ?? String(nextPage.index + 1)}]\n\n`;
  }
}

/** The whole document as one string, before the line endings and the encoding are applied. */
export function documentToText(
  pages: ReadonlyArray<ExportPage>,
  options: Pick<TextExportOptions, 'pageSeparator' | 'skipBlankLines'> = {},
): string {
  const separator = options.pageSeparator ?? 'blank-line';
  let out = '';
  for (const [i, page] of pages.entries()) {
    if (i > 0) out += separatorFor(separator, page);
    out += pageToText(page, options.skipBlankLines === true);
  }
  return out;
}

/** Encodes a string in one of the three encodings, with a BOM where one is called for. */
export function encodeText(text: string, encoding: TextEncoding, bom: boolean): Uint8Array {
  if (encoding === 'utf-8') {
    const body = new TextEncoder().encode(text);
    if (!bom) return body;
    const out = new Uint8Array(body.length + 3);
    out.set([0xef, 0xbb, 0xbf]);
    out.set(body, 3);
    return out;
  }
  const little = encoding === 'utf-16le';
  const out = new Uint8Array(2 + text.length * 2);
  const view = new DataView(out.buffer);
  view.setUint16(0, 0xfeff, little);
  for (let i = 0; i < text.length; i++) view.setUint16(2 + i * 2, text.charCodeAt(i), little);
  return out;
}

/** The document as one text file. */
export function exportText(
  pages: ReadonlyArray<ExportPage>,
  options: TextExportOptions,
  ctx: ExportContext = {},
): ExportResult {
  checkCancelled(ctx.signal);
  ctx.progress?.(0.2, 'Reading the text');
  const body = documentToText(pages, {
    ...(options.pageSeparator === undefined ? {} : { pageSeparator: options.pageSeparator }),
    ...(options.skipBlankLines === undefined ? {} : { skipBlankLines: options.skipBlankLines }),
  });
  checkCancelled(ctx.signal);
  ctx.progress?.(0.7, 'Writing the file');
  const withEndings = (options.lineEnding ?? 'lf') === 'crlf' ? body.replace(/\n/g, '\r\n') : body;
  const encoding = options.encoding ?? 'utf-8';
  const bytes = encodeText(withEndings, encoding, options.bom === true);
  ctx.progress?.(1, 'Done');
  const empty = body.trim() === '';
  return {
    files: [
      {
        name: `${options.documentName}.txt`,
        bytes,
        mediaType: 'text/plain',
        pages: pages.map((p) => p.index),
      },
    ],
    warnings: empty
      ? [
          'This document has no text layer — it is probably a scan. Run OCR over it first and the text will be there to export.',
        ]
      : [],
  };
}

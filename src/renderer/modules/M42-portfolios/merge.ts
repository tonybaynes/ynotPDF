/**
 * "Convert to single PDF" (M42) — the portfolio's embedded PDFs, in the reader's own order, as
 * one ordinary document.
 *
 * A plain pdf-lib copy, which is what the brief asks for until M41's merge lands; when it does,
 * this becomes the call into it and the page-level options (bookmarks per file, page numbering)
 * come with it. Non-PDF files are left out — there is nothing to copy pages from — and the
 * caller is told which, because silently dropping four spreadsheets would be worse than saying
 * so.
 */

import { PDFDocument } from 'pdf-lib';
import { sortedFiles, type Portfolio, type PortfolioFile } from '@shared/portfolio';

export interface MergeResult {
  readonly bytes: Uint8Array;
  /** Files that contributed pages, in order. */
  readonly merged: ReadonlyArray<string>;
  /** Files that could not: not a PDF, or damaged. */
  readonly skipped: ReadonlyArray<string>;
}

/**
 * Merges every embedded PDF into one document. `bytesOf` reads a file — the service's own
 * reader, so this stays free of the engine and can be unit-tested with a map.
 */
export async function convertToSinglePdf(
  portfolio: Portfolio,
  bytesOf: (file: PortfolioFile) => Promise<Uint8Array | null>,
  options: { readonly title?: string } = {},
): Promise<MergeResult> {
  const out = await PDFDocument.create();
  const merged: string[] = [];
  const skipped: string[] = [];
  for (const file of sortedFiles(portfolio)) {
    const bytes = await bytesOf(file);
    if (!bytes || bytes.length < 5 || !looksLikePdf(bytes)) {
      skipped.push(file.name);
      continue;
    }
    try {
      const source = await PDFDocument.load(bytes, {
        ignoreEncryption: true,
        updateMetadata: false,
        throwOnInvalidObject: false,
      });
      const pages = await out.copyPages(source, source.getPageIndices());
      for (const page of pages) out.addPage(page);
      merged.push(file.name);
    } catch {
      skipped.push(file.name);
    }
  }
  if (out.getPageCount() === 0) {
    // A document with no pages is not a PDF. One blank page, and the caller's warning, is the
    // honest answer to "none of these could be merged".
    out.addPage();
  }
  if (options.title !== undefined) out.setTitle(options.title);
  out.setProducer('ynotPDF');
  return { bytes: await out.save(), merged, skipped };
}

function looksLikePdf(bytes: Uint8Array): boolean {
  return String.fromCharCode(...bytes.subarray(0, 5)) === '%PDF-';
}

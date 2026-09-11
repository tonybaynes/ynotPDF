/**
 * `src/engine/decorations/` — headers, footers, Bates numbers, watermarks, backgrounds and the
 * addresses hidden in a page's text (M53, ADR 0020).
 *
 * Everything here is pure and library-neutral: it turns settings into content-stream text and
 * geometry, and knows nothing about PDFium or pdf-lib. `pdfium/decorations.ts` puts the result on
 * a live page and `writers/decorations.ts` puts it in the file.
 */

export * from './types';
export * from './macros';
export * from './layout';
export * from './draw';
export * from './links';
export * from './text';

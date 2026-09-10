/**
 * HTML export (M92).
 *
 * Two modes, because a reader asking for HTML is asking one of two different questions:
 *
 * - **Positioned** — every line in its own absolutely-placed box inside a page-sized `<div>`, at
 *   the coordinates the PDF gives it. This is *what the page looked like*: columns stay in
 *   columns, a table stays a table, and it prints as the page did. It does not reflow.
 * - **Flowing** — M13's paragraph grouping, and nothing else. This is *what the page said*: it
 *   reflows, it reads on a phone, a screen reader gets it in order, and the geometry is gone.
 *
 * "One file or one file per page" is a third, independent axis (Foxit's "single page /
 * paginated"), and either mode can be either.
 *
 * **The stylesheet is token-based, and they are the export's tokens, not the app's.** A file that
 * has left the application has no ynotPDF theme behind it, so it declares its own `--page-bg`,
 * `--ink` and the rest on `:root` and every rule uses `var()`; a reader who wants it to look
 * different edits five lines at the top. The app's colour rules govern the app's chrome — the
 * colours *inside* a document are the document's own, and are written out as the PDF stored them.
 *
 * Pictures are embedded as `data:` URIs rather than written beside the file, because a single
 * `.html` that opens anywhere is worth more than a folder that has to travel with it. There is a
 * ceiling on how much of that a file will carry, and a warning when it is reached.
 */

import { checkCancelled, type ExportContext, type ExportedFile, type ExportResult } from './types';
import { lineText, styleAt, type ExportPage, type PageTextLike, type TextRect } from './textModel';

export type HtmlLayout = 'positioned' | 'flowing';

export interface HtmlExportOptions {
  readonly documentName: string;
  readonly layout?: HtmlLayout;
  /** One file per page rather than one file for the document. */
  readonly perPage?: boolean;
  readonly embedImages?: boolean;
  /** Total budget for embedded pictures, in bytes. */
  readonly imageBudget?: number;
  /** Keep the PDF's text colours and fonts; off leaves the stylesheet's own. */
  readonly keepStyles?: boolean;
  /** Page number headings between pages in a single flowing file. */
  readonly pageHeadings?: boolean;
  readonly title?: string;
}

/** 24 MB of pictures in one HTML file; past that a browser starts to feel it. */
export const DEFAULT_IMAGE_BUDGET = 24 * 1024 * 1024;

/** Everything that must not appear raw in HTML text or in an attribute. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** `0x1a2b3c` → `#1a2b3c`. PDF content colour, not interface colour. */
export function hexColour(rgb: number): string {
  // ynot-allow-color: this is a colour from inside the PDF, written into an exported document.
  return `#${(rgb & 0xffffff).toString(16).padStart(6, '0')}`;
}

/** A CSS font stack from a PDF base font name, with a generic family to fall back on. */
export function fontStack(fontName: string): string {
  const base = fontName.replace(/^[A-Z]{6}\+/, '').replace(/[-,].*$/, '');
  const lower = base.toLowerCase();
  const generic = /courier|mono/.test(lower)
    ? 'monospace'
    : /helvetica|arial|sans|verdana|tahoma|calibri|segoe/.test(lower)
      ? 'sans-serif'
      : 'serif';
  return base === '' ? generic : `"${base}", ${generic}`;
}

const STYLESHEET = `:root {
  --page-bg: #ffffff;
  --page-edge: #b0b0b8;
  --paper-ground: #6e6e78;
  --ink: #101014;
  --muted: #4a4a52;
  --page-gap: 24px;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--paper-ground);
  color: var(--ink);
  font-family: Georgia, "Times New Roman", serif;
  line-height: 1.4;
}
.doc { padding: var(--page-gap) 0; }
.page {
  position: relative;
  margin: 0 auto var(--page-gap);
  background: var(--page-bg);
  border: 1px solid var(--page-edge);
  overflow: hidden;
}
.page-flow {
  max-width: 46rem;
  padding: 3rem 3.5rem;
  border: 1px solid var(--page-edge);
}
.line { position: absolute; white-space: pre; transform-origin: 0 0; }
.pic { position: absolute; }
.pic img { width: 100%; height: 100%; display: block; }
.page-label {
  max-width: 46rem;
  margin: 0 auto 0.5rem;
  color: var(--muted);
  font: 600 0.8rem/1.4 system-ui, sans-serif;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
p { margin: 0 0 0.8em; }
@media print {
  body { background: var(--page-bg); }
  .page { border: 0; margin: 0; page-break-after: always; }
  .page-label { display: none; }
}
`;

/** The `<style>` block an exported file carries. Exported so a test can assert on it. */
export function stylesheet(): string {
  return STYLESHEET;
}

interface Budget {
  left: number;
  skipped: number;
}

function base64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  // `btoa` is in every browser and in Node 16+; there is no third environment here.
  return btoa(binary);
}

/** The pictures of a page as absolutely-placed `<img>` elements. */
function picturesHtml(page: ExportPage, budget: Budget): string {
  let out = '';
  for (const image of page.images ?? []) {
    if (image.bytes.length > budget.left) {
      budget.skipped++;
      continue;
    }
    budget.left -= image.bytes.length;
    const box = cssBox(image.rect, page.height);
    const alt = image.alt === undefined ? '' : escapeHtml(image.alt);
    out += `      <div class="pic" style="${box}"><img alt="${alt}" src="data:${image.mediaType};base64,${base64(image.bytes)}" /></div>\n`;
  }
  return out;
}

/** A page-space rectangle as `left/top/width/height` in points, y flipped to the top-left origin. */
export function cssBox(rect: TextRect, pageHeight: number): string {
  const left = Math.round(rect.x0 * 100) / 100;
  const top = Math.round((pageHeight - rect.y1) * 100) / 100;
  const width = Math.round((rect.x1 - rect.x0) * 100) / 100;
  const height = Math.round((rect.y1 - rect.y0) * 100) / 100;
  return `left:${String(left)}pt;top:${String(top)}pt;width:${String(width)}pt;height:${String(height)}pt`;
}

/** One line as a positioned box. */
function lineHtml(page: ExportPage, lineIndex: number, keepStyles: boolean): string {
  const line = page.text.lines[lineIndex];
  if (!line) return '';
  const text = lineText(page.text, line);
  if (text.trim() === '') return '';
  const style = styleAt(page.text, line.start);
  const left = Math.round(line.rect.x0 * 100) / 100;
  // Text sits on its baseline; the box's top is where the tallest glyph starts.
  const top = Math.round((page.height - line.rect.y1) * 100) / 100;
  const parts = [`left:${String(left)}pt`, `top:${String(top)}pt`];
  if (keepStyles) {
    parts.push(`font-size:${String(Math.round(line.fontSize * 100) / 100)}pt`);
    parts.push(`font-family:${fontStack(style.fontName)}`);
    if (style.bold) parts.push('font-weight:700');
    if (style.italic) parts.push('font-style:italic');
    if (style.color !== 0) parts.push(`color:${hexColour(style.color)}`);
  }
  if (Math.abs(line.angle) > 0.01) {
    parts.push(`transform:rotate(${String(Math.round((-line.angle * 180) / Math.PI))}deg)`);
  }
  return `      <div class="line" style="${parts.join(';')}">${escapeHtml(text)}</div>\n`;
}

/** A page's paragraphs as flowing `<p>` elements. */
function flowHtml(text: PageTextLike, keepStyles: boolean): string {
  const paragraphs =
    text.paragraphs.length > 0
      ? text.paragraphs
      : text.lines.map((line) => ({
          start: line.start,
          end: line.end,
          rect: line.rect,
          lines: [],
        }));
  let out = '';
  for (const paragraph of paragraphs) {
    // A PDF line break is where the typesetter ran out of measure, not where the author stopped.
    const body = text.text.slice(paragraph.start, paragraph.end).replace(/\n/g, ' ').trim();
    if (body === '') continue;
    const style = styleAt(text, paragraph.start);
    const css = keepStyles
      ? ` style="font-family:${fontStack(style.fontName)}${style.bold ? ';font-weight:700' : ''}${
          style.italic ? ';font-style:italic' : ''
        }${style.color === 0 ? '' : `;color:${hexColour(style.color)}`}"`
      : '';
    out += `      <p${css}>${escapeHtml(body)}</p>\n`;
  }
  return out;
}

function pageHtml(
  page: ExportPage,
  options: HtmlExportOptions,
  budget: Budget,
  showLabel: boolean,
): string {
  const keepStyles = options.keepStyles !== false;
  const label = page.label ?? String(page.index + 1);
  const heading = showLabel ? `    <div class="page-label">Page ${escapeHtml(label)}</div>\n` : '';
  if ((options.layout ?? 'positioned') === 'flowing') {
    return `${heading}    <section class="page page-flow" aria-label="Page ${escapeHtml(label)}">\n${flowHtml(page.text, keepStyles)}    </section>\n`;
  }
  const size = `width:${String(Math.round(page.width * 100) / 100)}pt;height:${String(Math.round(page.height * 100) / 100)}pt`;
  let body = '';
  if (options.embedImages !== false) body += picturesHtml(page, budget);
  for (let i = 0; i < page.text.lines.length; i++) body += lineHtml(page, i, keepStyles);
  return `${heading}    <section class="page" style="${size}" aria-label="Page ${escapeHtml(label)}">\n${body}    </section>\n`;
}

/** Wraps page sections in a complete document. */
export function htmlDocument(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="generator" content="ynotPDF" />
    <title>${escapeHtml(title)}</title>
    <style>
${STYLESHEET}    </style>
  </head>
  <body>
    <div class="doc">
${body}    </div>
  </body>
</html>
`;
}

/** The document as HTML — one file, or one per page. */
export function exportHtml(
  pages: ReadonlyArray<ExportPage>,
  options: HtmlExportOptions,
  ctx: ExportContext = {},
): ExportResult {
  const budget: Budget = { left: options.imageBudget ?? DEFAULT_IMAGE_BUDGET, skipped: 0 };
  const title = options.title ?? options.documentName;
  const encoder = new TextEncoder();
  const warnings: string[] = [];
  const files: ExportedFile[] = [];

  if (options.perPage === true) {
    for (const [i, page] of pages.entries()) {
      checkCancelled(ctx.signal);
      ctx.progress?.(i / Math.max(1, pages.length), `Page ${String(page.index + 1)}`);
      const label = page.label ?? String(page.index + 1);
      const html = htmlDocument(`${title} — page ${label}`, pageHtml(page, options, budget, false));
      files.push({
        name: `${options.documentName}_page${String(page.index + 1).padStart(String(pages.length).length, '0')}.html`,
        bytes: encoder.encode(html),
        mediaType: 'text/html',
        pages: [page.index],
      });
    }
  } else {
    let body = '';
    for (const [i, page] of pages.entries()) {
      checkCancelled(ctx.signal);
      ctx.progress?.(i / Math.max(1, pages.length), `Page ${String(page.index + 1)}`);
      body += pageHtml(page, options, budget, options.pageHeadings !== false && pages.length > 1);
    }
    files.push({
      name: `${options.documentName}.html`,
      bytes: encoder.encode(htmlDocument(title, body)),
      mediaType: 'text/html',
      pages: pages.map((p) => p.index),
    });
  }

  if (budget.skipped > 0) {
    warnings.push(
      `${String(budget.skipped)} ${budget.skipped === 1 ? 'picture was' : 'pictures were'} left out: embedding ${budget.skipped === 1 ? 'it' : 'them'} would have taken the file past ${String(Math.round((options.imageBudget ?? DEFAULT_IMAGE_BUDGET) / (1024 * 1024)))} MB.`,
    );
  }
  if (pages.every((page) => page.text.text.trim() === '')) {
    warnings.push(
      'This document has no text layer — the HTML holds its pictures and nothing to read or search. Run OCR over it first.',
    );
  }
  ctx.progress?.(1, 'Done');
  return { files, warnings };
}

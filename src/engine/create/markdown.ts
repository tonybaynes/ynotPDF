/**
 * Markdown → HTML (M91). `marked` (MIT) does the parsing, GitHub-flavoured; this file wraps
 * the result in a document with the stylesheet the caller supplies (the data file
 * `resources/create/markdown.css`) and a `<base>` so relative images resolve next to the
 * source file. What the page then looks like on paper is Chromium's job, through the HTML path.
 */

import { Marked } from 'marked';

export interface MarkdownHtmlOptions {
  readonly title: string;
  /** CSS placed in a `<style>`; none means the browser's defaults. */
  readonly stylesheet?: string;
  /** Absolute URL of the folder the Markdown came from, for relative images and links. */
  readonly baseHref?: string | null;
}

const parser = new Marked({ gfm: true, breaks: false });

/** Renders the body only. */
export function renderMarkdown(markdown: string): string {
  const html = parser.parse(markdown, { async: false });
  return typeof html === 'string' ? html : '';
}

/** A complete HTML document ready to print. */
export function markdownToHtml(markdown: string, options: MarkdownHtmlOptions): string {
  const body = renderMarkdown(markdown);
  const base = options.baseHref ? `<base href="${escapeAttribute(options.baseHref)}">` : '';
  const style = options.stylesheet ? `<style>\n${options.stylesheet}\n</style>` : '';
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    `<title>${escapeText(options.title)}</title>`,
    base,
    style,
    '</head>',
    '<body class="ynot-markdown">',
    '<main class="ynot-markdown-body">',
    body,
    '</main>',
    '</body>',
    '</html>',
  ]
    .filter((line) => line !== '')
    .join('\n');
}

export function escapeText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function escapeAttribute(s: string): string {
  return escapeText(s).replace(/"/g, '&quot;');
}

/** The `file:` URL of a path, for `<base>` and for loading HTML files. */
export function fileUrl(path: string): string {
  const forward = path.replace(/\\/g, '/');
  const stripped = forward.replace(/^\/+/, '');
  const encoded = encodeURI(stripped).replace(/#/g, '%23').replace(/\?/g, '%3F');
  return `file:///${encoded}`;
}

/** The `file:` URL of the folder a path is in, with a trailing slash. */
export function folderUrl(path: string): string {
  const forward = path.replace(/\\/g, '/');
  const slash = forward.lastIndexOf('/');
  const folder = slash < 0 ? '' : forward.slice(0, slash);
  const url = fileUrl(folder);
  return url.endsWith('/') ? url : `${url}/`;
}

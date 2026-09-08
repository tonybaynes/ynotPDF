/**
 * URL rules for the web crawl (M91): what counts as the same page, and what counts as the same
 * site. Pure string work over the WHATWG `URL`.
 */

/** Absolute, fragment-free, host lower-cased — the key two links to one page share. */
export function normalizeUrl(href: string, base?: string): string | null {
  let url: URL;
  try {
    url = base ? new URL(href, base) : new URL(href);
  } catch {
    return null;
  }
  if (!isCrawlable(url)) return null;
  url.hash = '';
  if (url.protocol === 'http:' || url.protocol === 'https:') {
    url.hostname = url.hostname.toLowerCase();
    if (
      (url.protocol === 'http:' && url.port === '80') ||
      (url.protocol === 'https:' && url.port === '443')
    ) {
      url.port = '';
    }
  }
  return url.href;
}

/** Only web pages and local files are followed — never `mailto:`, `javascript:`, `data:`. */
export function isCrawlable(url: URL): boolean {
  return url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'file:';
}

/**
 * Whether `candidate` is on the same site as `start`: the same origin for web pages, the same
 * folder or below for local files.
 */
export function sameSite(start: string, candidate: string): boolean {
  let a: URL;
  let b: URL;
  try {
    a = new URL(start);
    b = new URL(candidate);
  } catch {
    return false;
  }
  if (a.protocol !== b.protocol) return false;
  if (a.protocol === 'file:') {
    const folder = a.pathname.slice(0, a.pathname.lastIndexOf('/') + 1);
    return b.pathname.startsWith(folder);
  }
  return a.origin === b.origin;
}

/** A readable label for a URL: the file name for local files, the URL otherwise. */
export function labelOf(url: string): string {
  try {
    const u = new URL(url);
    if (u.protocol === 'file:') {
      const name = decodeURIComponent(u.pathname.slice(u.pathname.lastIndexOf('/') + 1));
      return name === '' ? url : name;
    }
    return u.href;
  } catch {
    return url;
  }
}

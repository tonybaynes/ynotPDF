/**
 * The web crawl (M91): breadth-first over a `render(url)` function, so the rules — same site,
 * depth, de-duplication, the page cap, progress and cancellation — are tested against a fake
 * printer and never against the network.
 *
 * Depth counts pages, not links: depth 1 is the start page alone, depth 2 adds the pages it
 * links to, and so on. A page that fails to load is a warning and the crawl goes on; only the
 * start page failing is an error, because then there is nothing to make a document from.
 */

import type { WebPrintSettings, WebRenderResult } from '@shared/create';
import { checkCancelled, ConvertUnsupported, type ConvertProgress } from '../types';
import { labelOf, normalizeUrl, sameSite } from './urls';

export interface CrawledPage {
  /** The normalised URL the page was reached by. */
  readonly url: string;
  /** Other normalised URLs that reach the same page (the final URL after redirects). */
  readonly aliases: ReadonlyArray<string>;
  readonly title: string;
  readonly pdf: Uint8Array;
  readonly links: ReadonlyArray<string>;
  /** 1 for the start page. */
  readonly depth: number;
}

export interface CrawlOptions {
  readonly url: string;
  /** 1 – 10. */
  readonly depth: number;
  /** Follow only links on the same site. Off means every link, which is rarely wanted. */
  readonly sameSiteOnly: boolean;
  readonly settings: WebPrintSettings;
  /** A hard cap on pages, whatever the depth says. */
  readonly maxPages?: number;
  readonly render: (
    url: string,
    settings: WebPrintSettings,
    signal?: AbortSignal,
  ) => Promise<WebRenderResult>;
  readonly signal?: AbortSignal;
  readonly progress?: ConvertProgress;
}

export interface CrawlResult {
  readonly pages: ReadonlyArray<CrawledPage>;
  readonly warnings: ReadonlyArray<string>;
}

export const DEFAULT_MAX_PAGES = 200;
export const MAX_DEPTH = 10;

export async function crawl(options: CrawlOptions): Promise<CrawlResult> {
  const start = normalizeUrl(options.url);
  if (!start) {
    throw new ConvertUnsupported(
      'unknown-format',
      `${options.url} is not a web address ynotPDF can load`,
    );
  }
  const maxDepth = Math.min(MAX_DEPTH, Math.max(1, Math.floor(options.depth) || 1));
  const maxPages = Math.max(1, options.maxPages ?? DEFAULT_MAX_PAGES);
  const seen = new Set<string>([start]);
  const queue: { url: string; depth: number }[] = [{ url: start, depth: 1 }];
  const pages: CrawledPage[] = [];
  const warnings: string[] = [];
  let capped = false;

  while (queue.length > 0) {
    const next = queue.shift();
    if (!next) break;
    checkCancelled(options.signal);
    const total = pages.length + queue.length + 1;
    options.progress?.(
      pages.length / Math.max(total, 1),
      `Loading page ${pages.length + 1} of ${queue.length > 0 ? `about ${total}` : total}: ${labelOf(next.url)}`,
    );
    let rendered: WebRenderResult;
    try {
      rendered = await options.render(next.url, options.settings, options.signal);
    } catch (error) {
      checkCancelled(options.signal);
      const why = error instanceof Error ? error.message : String(error);
      if (pages.length === 0) {
        const reason = /timed out/i.test(why) ? 'timeout' : 'corrupt';
        throw new ConvertUnsupported(reason, `${labelOf(next.url)} could not be loaded: ${why}`);
      }
      warnings.push(`${labelOf(next.url)} was skipped: ${why}`);
      continue;
    }
    const aliases: string[] = [];
    const finalUrl = normalizeUrl(rendered.url);
    if (finalUrl && finalUrl !== next.url) {
      aliases.push(finalUrl);
      seen.add(finalUrl);
    }
    pages.push({
      url: next.url,
      aliases,
      title: rendered.title.trim() === '' ? labelOf(next.url) : rendered.title.trim(),
      pdf: rendered.pdf,
      links: rendered.links,
      depth: next.depth,
    });
    warnings.push(...rendered.warnings.map((w) => `${labelOf(next.url)}: ${w}`));
    if (next.depth >= maxDepth) continue;
    for (const href of rendered.links) {
      const link = normalizeUrl(href, rendered.url);
      if (!link || seen.has(link)) continue;
      if (options.sameSiteOnly && !sameSite(start, link)) continue;
      if (pages.length + queue.length >= maxPages) {
        capped = true;
        break;
      }
      seen.add(link);
      queue.push({ url: link, depth: next.depth + 1 });
    }
  }
  if (capped) warnings.push(`Stopped at ${maxPages} pages; the site has more`);
  return { pages, warnings };
}

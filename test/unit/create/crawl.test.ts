/**
 * The web crawl (M91): URL rules and the breadth-first walk over a fake renderer and an
 * in-memory site — never the network.
 */

import { PDFDocument, PDFName } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WEB_PRINT_SETTINGS,
  type WebPrintSettings,
  type WebRenderResult,
  type WebRenderSource,
} from '@shared/create';
import { crawl, DEFAULT_MAX_PAGES, MAX_DEPTH, type CrawlOptions } from '@engine/create/web/crawl';
import { isCrawlable, labelOf, normalizeUrl, sameSite } from '@engine/create/web/urls';
import {
  DEFAULT_WEB_OPTIONS,
  WebConverter,
  type WebConvertOptions,
} from '@engine/create/web/WebConverter';
import { ConvertCancelled, ConvertUnsupported, type HtmlPrinter } from '@engine/create/types';

describe('normalizeUrl', () => {
  it('strips the fragment, lower-cases the host and drops default ports', () => {
    expect(normalizeUrl('HTTP://Example.COM:80/a/b#top')).toBe('http://example.com/a/b');
    expect(normalizeUrl('https://Example.com:443/x?y=1#z')).toBe('https://example.com/x?y=1');
    expect(normalizeUrl('https://example.com:8443/x')).toBe('https://example.com:8443/x');
    expect(normalizeUrl('http://example.com:8080/x')).toBe('http://example.com:8080/x');
    expect(normalizeUrl('file:///D:/site/index.html#top')).toBe('file:///D:/site/index.html');
  });

  it('resolves a relative reference against the base', () => {
    expect(normalizeUrl('about.html', 'http://example.com/site/index.html')).toBe(
      'http://example.com/site/about.html',
    );
    expect(normalizeUrl('../up.html#x', 'file:///D:/site/sub/index.html')).toBe(
      'file:///D:/site/up.html',
    );
    expect(normalizeUrl('?q=1', 'http://example.com/site/index.html')).toBe(
      'http://example.com/site/index.html?q=1',
    );
  });

  it('returns null for what cannot be crawled', () => {
    expect(normalizeUrl('mailto:someone@example.com')).toBeNull();
    expect(normalizeUrl('javascript:void(0)', 'http://example.com/')).toBeNull();
    expect(normalizeUrl('data:text/plain,hello')).toBeNull();
    expect(normalizeUrl('not a url')).toBeNull();
    expect(normalizeUrl('')).toBeNull();
    expect(normalizeUrl('about.html')).toBeNull();
  });
});

describe('isCrawlable', () => {
  it('follows only http, https and file', () => {
    expect(isCrawlable(new URL('http://a/'))).toBe(true);
    expect(isCrawlable(new URL('https://a/'))).toBe(true);
    expect(isCrawlable(new URL('file:///a'))).toBe(true);
    expect(isCrawlable(new URL('ftp://a/'))).toBe(false);
    expect(isCrawlable(new URL('mailto:a@b'))).toBe(false);
  });
});

describe('sameSite', () => {
  it('is the same origin for web pages', () => {
    expect(sameSite('http://example.com/a', 'http://example.com/b/c')).toBe(true);
    expect(sameSite('http://example.com/a', 'http://EXAMPLE.com/b')).toBe(true);
    expect(sameSite('http://example.com/a', 'http://example.com:8080/b')).toBe(false);
    expect(sameSite('http://example.com/a', 'https://example.com/a')).toBe(false);
    expect(sameSite('http://example.com/a', 'http://other.com/a')).toBe(false);
  });

  it('is the same folder or below for local files', () => {
    expect(sameSite('file:///D:/site/index.html', 'file:///D:/site/about.html')).toBe(true);
    expect(sameSite('file:///D:/site/index.html', 'file:///D:/site/sub/deep.html')).toBe(true);
    expect(sameSite('file:///D:/site/index.html', 'file:///D:/other.html')).toBe(false);
    expect(sameSite('file:///D:/site/index.html', 'file:///D:/site-2/index.html')).toBe(false);
  });

  it('is false across protocols and for garbage', () => {
    expect(sameSite('file:///D:/site/index.html', 'http://example.com/')).toBe(false);
    expect(sameSite('nope', 'http://example.com/')).toBe(false);
    expect(sameSite('http://example.com/', '')).toBe(false);
  });
});

describe('labelOf', () => {
  it('gives the file name for local files and the href for the web', () => {
    expect(labelOf('file:///D:/site/my%20page.html')).toBe('my page.html');
    expect(labelOf('file:///D:/site/')).toBe('file:///D:/site/');
    expect(labelOf('http://example.com/a?b=1')).toBe('http://example.com/a?b=1');
    expect(labelOf('garbage')).toBe('garbage');
  });
});

/** An in-memory site: what each URL renders to, or `null` for a page that fails to load. */
interface FakePage {
  readonly title?: string;
  readonly links?: ReadonlyArray<string>;
  /** The URL the page was "redirected" to. */
  readonly finalUrl?: string;
  readonly warnings?: ReadonlyArray<string>;
  readonly error?: string;
}

type Site = Readonly<Record<string, FakePage>>;

interface RenderCall {
  readonly url: string;
  readonly settings: WebPrintSettings;
  readonly signal: AbortSignal | undefined;
}

function fakeSite(site: Site, calls: RenderCall[] = []): CrawlOptions['render'] {
  return (url, settings, signal) => {
    calls.push({ url, settings, signal });
    const page = site[url];
    if (!page) return Promise.reject(new Error(`404 ${url}`));
    if (page.error !== undefined) return Promise.reject(new Error(page.error));
    const result: WebRenderResult = {
      url: page.finalUrl ?? url,
      title: page.title ?? '',
      pdf: new Uint8Array([1]),
      links: page.links ?? [],
      warnings: page.warnings ?? [],
    };
    return Promise.resolve(result);
  };
}

const SITE: Site = {
  'http://site.test/': {
    title: 'Home',
    links: ['about.html', 'contact.html#team', 'https://other.test/x'],
  },
  'http://site.test/about.html': { title: 'About', links: ['/', 'contact.html', 'deep.html'] },
  'http://site.test/contact.html': { title: 'Contact', links: ['mailto:a@b.test', '/'] },
  'http://site.test/deep.html': { title: 'Deep', links: [] },
  'https://other.test/x': { title: 'Other', links: [] },
};

function options(overrides: Partial<CrawlOptions> = {}): CrawlOptions {
  return {
    url: 'http://site.test/',
    depth: 1,
    sameSiteOnly: true,
    settings: DEFAULT_WEB_PRINT_SETTINGS,
    render: fakeSite(SITE),
    ...overrides,
  };
}

describe('crawl', () => {
  it('depth 1 is the start page alone', async () => {
    const result = await crawl(options({ depth: 1 }));
    expect(result.pages.map((p) => p.url)).toEqual(['http://site.test/']);
    expect(result.pages[0]).toMatchObject({ title: 'Home', depth: 1, aliases: [] });
    expect(result.pages[0]?.links).toEqual(SITE['http://site.test/']?.links);
    expect(result.warnings).toEqual([]);
  });

  it('depth 2 adds the pages the start links to, on the same site', async () => {
    const result = await crawl(options({ depth: 2 }));
    expect(result.pages.map((p) => p.url)).toEqual([
      'http://site.test/',
      'http://site.test/about.html',
      'http://site.test/contact.html',
    ]);
    expect(result.pages.map((p) => p.depth)).toEqual([1, 2, 2]);
  });

  it('depth 3 reaches a page two hops away and visits nothing twice', async () => {
    const calls: RenderCall[] = [];
    const result = await crawl(options({ depth: 3, render: fakeSite(SITE, calls) }));
    expect(result.pages.map((p) => p.title)).toEqual(['Home', 'About', 'Contact', 'Deep']);
    expect(result.pages[3]?.depth).toBe(3);
    expect(calls.map((c) => c.url)).toEqual(result.pages.map((p) => p.url));
  });

  it('skips other sites when sameSiteOnly and follows them otherwise', async () => {
    const same = await crawl(options({ depth: 2, sameSiteOnly: true }));
    expect(same.pages.map((p) => p.url)).not.toContain('https://other.test/x');
    const all = await crawl(options({ depth: 2, sameSiteOnly: false }));
    expect(all.pages.map((p) => p.url)).toContain('https://other.test/x');
  });

  it('visits fragment variants of one page once', async () => {
    const site: Site = {
      'http://site.test/': {
        title: 'Home',
        links: ['/a#x', '/a#y', '/a', 'http://SITE.test:80/a'],
      },
      'http://site.test/a': { title: 'A', links: ['/#top'] },
    };
    const calls: RenderCall[] = [];
    const result = await crawl(options({ depth: 5, render: fakeSite(site, calls) }));
    expect(calls.map((c) => c.url)).toEqual(['http://site.test/', 'http://site.test/a']);
    expect(result.pages).toHaveLength(2);
  });

  it('fails when the start page fails, naming a timeout as one', async () => {
    const timeout: Site = { 'http://site.test/': { error: 'Timed out after 30 s' } };
    await expect(crawl(options({ render: fakeSite(timeout) }))).rejects.toMatchObject({
      name: 'ConvertUnsupported',
      reason: 'timeout',
      message: expect.stringContaining('could not be loaded') as string,
    });
    const broken: Site = { 'http://site.test/': { error: 'net::ERR_CONNECTION_REFUSED' } };
    await expect(crawl(options({ render: fakeSite(broken) }))).rejects.toMatchObject({
      reason: 'corrupt',
    });
    await expect(crawl(options({ render: fakeSite({}) }))).rejects.toBeInstanceOf(
      ConvertUnsupported,
    );
  });

  it('warns and goes on when a child page fails', async () => {
    const site: Site = {
      'http://site.test/': { title: 'Home', links: ['bad.html', 'good.html'] },
      'http://site.test/bad.html': { error: 'Timed out' },
      'http://site.test/good.html': { title: 'Good' },
    };
    const result = await crawl(options({ depth: 2, render: fakeSite(site) }));
    expect(result.pages.map((p) => p.title)).toEqual(['Home', 'Good']);
    expect(result.warnings).toEqual(['http://site.test/bad.html was skipped: Timed out']);
  });

  it('records a redirect as an alias and does not visit the target again', async () => {
    const site: Site = {
      'http://site.test/': { title: 'Home', links: ['old.html'] },
      'http://site.test/old.html': {
        title: 'Moved',
        finalUrl: 'http://site.test/new.html#frag',
        links: ['sub/x.html', 'new.html', 'http://site.test/new.html'],
      },
      'http://site.test/new.html': { title: 'New' },
      'http://site.test/sub/x.html': { title: 'X', links: ['../new.html'] },
    };
    const calls: RenderCall[] = [];
    const result = await crawl(options({ depth: 4, render: fakeSite(site, calls) }));
    expect(calls.map((c) => c.url)).toEqual([
      'http://site.test/',
      'http://site.test/old.html',
      'http://site.test/sub/x.html',
    ]);
    expect(result.pages).toHaveLength(3);
    expect(result.pages[1]).toMatchObject({
      url: 'http://site.test/old.html',
      aliases: ['http://site.test/new.html'],
    });
    expect(result.pages[0]?.aliases).toEqual([]);
    // Relative links on a redirected page resolve against the final URL.
    expect(result.pages[2]?.url).toBe('http://site.test/sub/x.html');
  });

  it('stops at maxPages and says so', async () => {
    const site: Site = {
      'http://site.test/': { title: 'Home', links: ['a.html', 'b.html', 'c.html', 'd.html'] },
      'http://site.test/a.html': { title: 'A' },
      'http://site.test/b.html': { title: 'B' },
      'http://site.test/c.html': { title: 'C' },
      'http://site.test/d.html': { title: 'D' },
    };
    const result = await crawl(options({ depth: 2, maxPages: 3, render: fakeSite(site) }));
    expect(result.pages).toHaveLength(3);
    expect(result.warnings).toEqual(['Stopped at 3 pages; the site has more']);
    const one = await crawl(options({ depth: 2, maxPages: 0, render: fakeSite(site) }));
    expect(one.pages).toHaveLength(1);
    expect(DEFAULT_MAX_PAGES).toBeGreaterThan(3);
  });

  it('reports progress with the page label', async () => {
    const messages: string[] = [];
    const fractions: (number | null)[] = [];
    await crawl(
      options({
        depth: 2,
        progress: (fraction, message) => {
          fractions.push(fraction);
          messages.push(message);
        },
      }),
    );
    expect(messages[0]).toBe('Loading page 1 of 1: http://site.test/');
    expect(messages[1]).toBe('Loading page 2 of about 3: http://site.test/about.html');
    expect(messages[2]).toBe('Loading page 3 of 3: http://site.test/contact.html');
    expect(fractions[0]).toBe(0);
    expect(fractions[2]).toBeCloseTo(2 / 3, 5);
  });

  it('passes page warnings through with the page label', async () => {
    const site: Site = {
      'file:///D:/site/index.html': { title: '   ', warnings: ['An image did not load'] },
    };
    const result = await crawl(
      options({ url: 'file:///D:/site/index.html', render: fakeSite(site) }),
    );
    expect(result.warnings).toEqual(['index.html: An image did not load']);
    // A blank title falls back to the label.
    expect(result.pages[0]?.title).toBe('index.html');
  });

  it('stops when cancelled, before and during a render', async () => {
    const aborted = new AbortController();
    aborted.abort();
    await expect(crawl(options({ signal: aborted.signal }))).rejects.toBeInstanceOf(
      ConvertCancelled,
    );

    const during = new AbortController();
    const render: CrawlOptions['render'] = () => {
      during.abort();
      return Promise.reject(new Error('Aborted'));
    };
    await expect(crawl(options({ render, signal: during.signal }))).rejects.toBeInstanceOf(
      ConvertCancelled,
    );
  });

  it('refuses an address it cannot load', async () => {
    await expect(crawl(options({ url: 'mailto:a@b.test' }))).rejects.toMatchObject({
      name: 'ConvertUnsupported',
      reason: 'unknown-format',
    });
    await expect(crawl(options({ url: 'not a url' }))).rejects.toMatchObject({
      reason: 'unknown-format',
    });
  });

  it('clamps the depth to MAX_DEPTH and up to 1', async () => {
    const chain: Record<string, FakePage> = {};
    for (let i = 0; i < MAX_DEPTH + 3; i++) {
      chain[`http://site.test/p${i}`] = { title: `P${i}`, links: [`p${i + 1}`] };
    }
    const deep = await crawl(
      options({ url: 'http://site.test/p0', depth: 100, render: fakeSite(chain) }),
    );
    expect(deep.pages).toHaveLength(MAX_DEPTH);
    expect(deep.pages[MAX_DEPTH - 1]?.depth).toBe(MAX_DEPTH);
    const shallow = await crawl(
      options({ url: 'http://site.test/p0', depth: 0, render: fakeSite(chain) }),
    );
    expect(shallow.pages).toHaveLength(1);
    const nan = await crawl(
      options({ url: 'http://site.test/p0', depth: Number.NaN, render: fakeSite(chain) }),
    );
    expect(nan.pages).toHaveLength(1);
  });

  it('hands the settings and the signal to the renderer', async () => {
    const calls: RenderCall[] = [];
    const settings: WebPrintSettings = { ...DEFAULT_WEB_PRINT_SETTINGS, scale: 0.8 };
    const controller = new AbortController();
    await crawl(options({ settings, signal: controller.signal, render: fakeSite(SITE, calls) }));
    expect(calls[0]?.settings).toBe(settings);
    expect(calls[0]?.signal).toBe(controller.signal);
  });
});

describe('WebConverter', () => {
  const converter = new WebConverter();

  async function onePage(): Promise<Uint8Array> {
    const doc = await PDFDocument.create();
    doc.addPage([100, 100]);
    return doc.save();
  }

  /** A printer over the in-memory site: every page prints as one PDF page. */
  function printer(site: Site, sources: WebRenderSource[] = []): HtmlPrinter {
    const render = fakeSite(site);
    return {
      async render(source, settings, signal) {
        sources.push(source);
        if (source.kind !== 'url') throw new Error('The web converter renders URLs only');
        const page = await render(source.url, settings, signal);
        return { ...page, pdf: await onePage() };
      },
    };
  }

  it('takes no file and has defaults that are a copy', () => {
    expect(converter.accepts()).toBe(false);
    expect(converter.extensions).toEqual([]);
    expect(converter.mimes).toEqual([]);
    expect(converter.id).toBe('web');
    expect(converter.defaults()).toEqual(DEFAULT_WEB_OPTIONS);
    expect(converter.defaults()).not.toBe(DEFAULT_WEB_OPTIONS);
  });

  it('needs a printer and an address', async () => {
    await expect(
      converter.convert([], { ...converter.defaults(), url: 'http://site.test/' }, { env: {} }),
    ).rejects.toMatchObject({
      name: 'ConvertUnsupported',
      reason: 'no-printer',
    });
    await expect(
      converter.convert(
        [],
        { ...converter.defaults(), url: '   ' },
        { env: { printer: printer(SITE) } },
      ),
    ).rejects.toMatchObject({ reason: 'empty' });
  });

  it('crawls with the printer, stitches the pages and merges the warnings', async () => {
    const sources: WebRenderSource[] = [];
    const site: Site = {
      ...SITE,
      'http://site.test/about.html': { title: 'About', links: ['deep.html'], warnings: ['slow'] },
    };
    const progress: string[] = [];
    const result = await converter.convert(
      [],
      {
        ...converter.defaults(),
        url: ' http://site.test/ ',
        depth: 2,
        settings: { ...DEFAULT_WEB_PRINT_SETTINGS, scale: 0.9 },
      },
      { env: { printer: printer(site, sources) }, progress: (_f, m) => progress.push(m) },
    );
    expect(sources.map((s) => (s.kind === 'url' ? s.url : s.kind))).toEqual([
      'http://site.test/',
      'http://site.test/about.html',
      'http://site.test/contact.html',
    ]);
    expect(result.pageCount).toBe(3);
    expect(result.title).toBe('Home');
    expect(result.warnings).toEqual(['http://site.test/about.html: slow']);
    expect(progress.some((m) => m.startsWith('Loading page'))).toBe(true);
    expect(progress.some((m) => m.startsWith('Adding '))).toBe(true);
    const doc = await PDFDocument.load(result.bytes, { updateMetadata: false });
    expect(doc.getPageCount()).toBe(3);
    expect(doc.getTitle()).toBe('Home');
    expect(doc.catalog.has(PDFName.of('Outlines'))).toBe(true);
  });

  it('honours the title, the page cap and bookmarks off, with no signal or progress', async () => {
    const result = await converter.convert(
      [],
      {
        ...converter.defaults(),
        url: 'http://site.test/',
        depth: 2,
        maxPages: 2,
        bookmarks: false,
        title: 'Site',
      },
      { env: { printer: printer(SITE) } },
    );
    expect(result.pageCount).toBe(2);
    expect(result.title).toBe('Site');
    expect(result.warnings).toEqual(['Stopped at 2 pages; the site has more']);
    const doc = await PDFDocument.load(result.bytes, { updateMetadata: false });
    expect(doc.catalog.has(PDFName.of('Outlines'))).toBe(false);
  });

  it('fills in defaults for options left out', async () => {
    const partial = { url: 'http://site.test/', settings: { scale: 2 } } as WebConvertOptions;
    const result = await converter.convert([], partial, { env: { printer: printer(SITE) } });
    expect(result.pageCount).toBe(1);
  });

  it('stops when cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      converter.convert(
        [],
        { ...converter.defaults(), url: 'http://site.test/' },
        {
          env: { printer: printer(SITE) },
          signal: controller.signal,
        },
      ),
    ).rejects.toBeInstanceOf(ConvertCancelled);
  });
});

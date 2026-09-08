/**
 * HTML and Markdown → PDF (M91). The printer is the host's (Chromium, in main), so a fake one
 * stands in here and records what it was asked to render; the stamping of the result is real.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_HTML_OPTIONS,
  HtmlConverter,
  isMarkdown,
  stamp,
  type HtmlConvertOptions,
} from '@engine/create/html/HtmlConverter';
import { fileUrl, folderUrl } from '@engine/create/markdown';
import { ConvertCancelled, type ConvertInput, type HtmlPrinter } from '@engine/create/types';
import {
  DEFAULT_WEB_PRINT_SETTINGS,
  type WebPrintSettings,
  type WebRenderResult,
  type WebRenderSource,
} from '@shared/create';
import { FIXTURES } from '../engine/helpers';

const CREATE = join(FIXTURES, 'create');

function input(name: string, path = true): ConvertInput {
  const full = join(CREATE, name);
  const base = { name, bytes: new Uint8Array(readFileSync(full)) };
  return path ? { ...base, path: full } : base;
}

async function smallPdf(pages = 2, title = 'Printed'): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage([200, 100]);
  doc.setTitle(title);
  return doc.save();
}

interface RenderCall {
  readonly source: WebRenderSource;
  readonly settings: WebPrintSettings;
  readonly signal: AbortSignal | undefined;
}

interface FakePrinter extends HtmlPrinter {
  readonly calls: RenderCall[];
}

function fakePrinter(
  overrides: Partial<Omit<WebRenderResult, 'pdf'>> & {
    pdf?: Uint8Array | (() => Promise<Uint8Array>);
  } = {},
  onRender?: () => void,
): FakePrinter {
  const calls: RenderCall[] = [];
  return {
    calls,
    async render(source, settings, signal) {
      calls.push({ source, settings, signal });
      onRender?.();
      const pdf =
        typeof overrides.pdf === 'function'
          ? await overrides.pdf()
          : (overrides.pdf ?? (await smallPdf()));
      return {
        url: overrides.url ?? 'file:///tmp/x.html',
        title: overrides.title ?? 'Printed',
        pdf,
        links: overrides.links ?? [],
        warnings: overrides.warnings ?? [],
      };
    },
  };
}

const converter = new HtmlConverter();

describe('HtmlConverter routing', () => {
  it('tells Markdown from HTML by extension or MIME type', () => {
    expect(isMarkdown({ name: 'notes.md' })).toBe(true);
    expect(isMarkdown({ name: 'NOTES.MARKDOWN' })).toBe(true);
    expect(isMarkdown({ name: 'x.txt', mime: 'text/markdown' })).toBe(true);
    expect(isMarkdown({ name: 'page.html' })).toBe(false);
    expect(isMarkdown({ mime: 'text/html' })).toBe(false);
    expect(isMarkdown({})).toBe(false);
  });

  it('accepts HTML and Markdown by extension or MIME type', () => {
    expect(converter.accepts({ name: 'a.html' })).toBe(true);
    expect(converter.accepts({ name: 'a.HTM' })).toBe(true);
    expect(converter.accepts({ name: 'a.mkd' })).toBe(true);
    expect(converter.accepts({ mime: 'application/xhtml+xml' })).toBe(true);
    expect(converter.accepts({ mime: 'Text/Markdown' })).toBe(true);
    expect(converter.accepts({ name: 'a.txt' })).toBe(false);
    expect(converter.accepts({})).toBe(false);
    expect(converter.id).toBe('html');
    expect(converter.multi).toBe(false);
  });

  it('has defaults that are a copy', () => {
    expect(converter.defaults()).toEqual(DEFAULT_HTML_OPTIONS);
    expect(converter.defaults()).not.toBe(DEFAULT_HTML_OPTIONS);
    expect(converter.defaults().settings).toEqual(DEFAULT_WEB_PRINT_SETTINGS);
  });
});

describe('HtmlConverter.convert', () => {
  it('renders Markdown to HTML with a <base> next to the file and the stylesheet', async () => {
    const printer = fakePrinter();
    const md = input('notes.md');
    const options: HtmlConvertOptions = {
      ...converter.defaults(),
      markdownStylesheet: 'h1 { color: teal }',
    };
    const progress: string[] = [];
    const result = await converter.convert([md], options, {
      env: { printer },
      progress: (_f, m) => progress.push(m),
    });
    expect(printer.calls).toHaveLength(1);
    const call = printer.calls[0];
    expect(call?.settings).toEqual(DEFAULT_WEB_PRINT_SETTINGS);
    expect(call?.source.kind).toBe('html');
    if (call?.source.kind === 'html') {
      const folder = folderUrl(md.path ?? '');
      expect(call.source.baseUrl).toBe(folder);
      expect(call.source.html).toContain(`<base href="${folder}">`);
      expect(call.source.html).toContain('<title>notes</title>');
      expect(call.source.html).toContain('<h1');
      expect(call.source.html).toContain('<h2');
      expect(call.source.html).toContain('<table');
      expect(call.source.html).toContain('h1 { color: teal }');
    }
    expect(result.title).toBe('notes');
    expect(result.pageCount).toBe(2);
    expect(result.warnings).toEqual([]);
    expect(progress).toEqual(['Rendering notes.md', 'Finishing the document']);
    const doc = await PDFDocument.load(result.bytes, { updateMetadata: false });
    expect(doc.getTitle()).toBe('notes');
    expect(doc.getProducer()).toBe('ynotPDF');
  });

  it('renders Markdown without a path with no <base> and no stylesheet', async () => {
    const printer = fakePrinter();
    await converter.convert([input('notes.md', false)], converter.defaults(), { env: { printer } });
    const source = printer.calls[0]?.source;
    expect(source?.kind).toBe('html');
    if (source?.kind === 'html') {
      expect(source.baseUrl).toBeNull();
      expect(source.html).not.toContain('<base');
      expect(source.html).not.toContain('<style');
    }
  });

  it('loads an HTML file by its file URL when it has a path', async () => {
    const printer = fakePrinter({ title: 'Home page' });
    const html = input('site/index.html');
    const result = await converter.convert([html], converter.defaults(), { env: { printer } });
    expect(printer.calls[0]?.source).toEqual({ kind: 'url', url: fileUrl(html.path ?? '') });
    expect(result.title).toBe('Home page');
  });

  it('hands over the decoded HTML when there is no path', async () => {
    const printer = fakePrinter({ title: '   ' });
    const html = input('site/index.html', false);
    const result = await converter.convert([html], converter.defaults(), { env: { printer } });
    expect(printer.calls[0]?.source).toEqual({
      kind: 'html',
      html: new TextDecoder().decode(html.bytes),
      baseUrl: null,
    });
    // A blank printer title falls back to the stem.
    expect(result.title).toBe('index');
  });

  it('lets the title option win and passes warnings through', async () => {
    const printer = fakePrinter({ title: 'Home page', warnings: ['An image did not load'] });
    const result = await converter.convert(
      [input('site/index.html')],
      { ...converter.defaults(), title: 'Chosen' },
      { env: { printer } },
    );
    expect(result.title).toBe('Chosen');
    expect(result.warnings).toEqual(['An image did not load']);
    expect((await PDFDocument.load(result.bytes)).getTitle()).toBe('Chosen');
    const md = await converter.convert(
      [input('notes.md')],
      { ...converter.defaults(), title: 'Chosen' },
      {
        env: { printer },
      },
    );
    expect(md.title).toBe('Chosen');
  });

  it('merges partial settings over the defaults and forwards the signal', async () => {
    const printer = fakePrinter();
    const controller = new AbortController();
    const settings = { scale: 0.5 } as WebPrintSettings;
    await converter.convert(
      [input('notes.md')],
      { settings },
      { env: { printer }, signal: controller.signal },
    );
    expect(printer.calls[0]?.settings).toEqual({ ...DEFAULT_WEB_PRINT_SETTINGS, scale: 0.5 });
    expect(printer.calls[0]?.signal).toBe(controller.signal);
  });

  it('says when there is no printer, no input or a broken result', async () => {
    await expect(
      converter.convert([input('notes.md')], converter.defaults(), { env: {} }),
    ).rejects.toMatchObject({
      name: 'ConvertUnsupported',
      reason: 'no-printer',
      message: expect.stringContaining('notes.md') as string,
    });
    await expect(
      converter.convert([], converter.defaults(), { env: { printer: fakePrinter() } }),
    ).rejects.toMatchObject({
      reason: 'empty',
    });
    const garbage = fakePrinter({ pdf: new Uint8Array([1, 2, 3, 4]) });
    await expect(
      converter.convert([input('notes.md')], converter.defaults(), { env: { printer: garbage } }),
    ).rejects.toMatchObject({
      name: 'ConvertUnsupported',
      reason: 'corrupt',
    });
  });

  it('stops when cancelled before or during the render', async () => {
    const before = new AbortController();
    before.abort();
    const printer = fakePrinter();
    await expect(
      converter.convert([input('notes.md')], converter.defaults(), {
        env: { printer },
        signal: before.signal,
      }),
    ).rejects.toBeInstanceOf(ConvertCancelled);
    expect(printer.calls).toHaveLength(0);

    const during = new AbortController();
    const aborting = fakePrinter({}, () => {
      during.abort();
    });
    await expect(
      converter.convert([input('notes.md')], converter.defaults(), {
        env: { printer: aborting },
        signal: during.signal,
      }),
    ).rejects.toBeInstanceOf(ConvertCancelled);
    expect(aborting.calls).toHaveLength(1);
  });
});

describe('stamp', () => {
  it('sets the title and counts the pages', async () => {
    const { bytes, pageCount } = await stamp(await smallPdf(3, 'Old'), 'New title');
    expect(pageCount).toBe(3);
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    expect(doc.getTitle()).toBe('New title');
    expect(doc.getProducer()).toBe('ynotPDF');
    expect(doc.getCreator()).toBe('ynotPDF');
    expect(doc.getPageCount()).toBe(3);
  });

  it('refuses bytes that are not a PDF', async () => {
    await expect(stamp(new TextEncoder().encode('not a pdf'), 't')).rejects.toMatchObject({
      name: 'ConvertUnsupported',
      reason: 'corrupt',
      message: expect.stringContaining('could not be read') as string,
    });
  });
});

/**
 * M13's acceptance tests that need a real document: the find count against the engine's own
 * text, the search of two open documents at once, the folder walk, and "Print to PDF" of pages
 * 2-3 two-up and as a booklet — checked by *reopening the result in the engine* and reading the
 * text back off each sheet, which is the only way to be sure the imposition put the pages where
 * it said it would.
 *
 * The DOM half of the module is proved by Playwright (`test/e2e/select-find-print.spec.ts`);
 * everything here runs in Node against PDFium and pdf-lib.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { DocHandle, PdfEngine } from '@engine/PdfEngine';
import { buildPageText } from '@view/TextLayer';
import { listPdfs } from '../../../src/main/search/worker';
import {
  contextSnippet,
  DEFAULT_FIND_OPTIONS,
  findMatches,
} from '@modules/M13-select-find-print/find/search';
import { FindController } from '@modules/M13-select-find-print/find/FindController';
import { TextService } from '@modules/M13-select-find-print/TextService';
import { imposePages, sheetOrder } from '@modules/M13-select-find-print/print/imposition';
import { buildPrintPlan } from '@modules/M13-select-find-print/print/plan';
import { printToPdf } from '@modules/M13-select-find-print/print/printToPdf';
import { DEFAULT_PRINT_SETTINGS } from '@modules/M13-select-find-print/settings';
import { engine, fixture, FIXTURES } from '../engine/helpers';
import { must } from './helpers';

let pdfium: PdfEngine;

beforeAll(async () => {
  pdfium = await engine();
});

async function open(name: string): Promise<DocHandle> {
  return await pdfium.open(fixture(name));
}

/** The engine's own text for a page, with nothing of ours in it. */
async function rawText(doc: DocHandle, page: number): Promise<string> {
  return (await pdfium.textRuns(doc, page)).map((r) => r.text).join('');
}

describe('find, against the engine', () => {
  it('reports the same number of "the"s as the engine\'s raw text', async () => {
    const doc = await open('text.pdf');
    const raw = await rawText(doc, 0);
    const expected = (raw.match(/the/giu) ?? []).length;
    const model = buildPageText(0, await pdfium.textRuns(doc, 0));
    const matches = findMatches(model.text, 'the', DEFAULT_FIND_OPTIONS);
    expect(expected).toBeGreaterThan(0);
    expect(matches).toHaveLength(expected);
    await pdfium.close(doc);
  });

  it('whole-word mode drops the ones inside longer words', async () => {
    const doc = await open('text.pdf');
    const model = buildPageText(0, await pdfium.textRuns(doc, 0));
    // Every "the" in this fixture stands alone, so whole-word finds them all …
    const loose = findMatches(model.text, 'the', DEFAULT_FIND_OPTIONS);
    const strict = findMatches(model.text, 'the', { ...DEFAULT_FIND_OPTIONS, wholeWord: true });
    expect(strict).toHaveLength(loose.length);
    for (const match of strict) {
      expect(model.text.slice(match.start, match.end).toLowerCase()).toBe('the');
    }
    // … while "he", which only ever appears inside other words here, finds nothing.
    const inside = findMatches(model.text, 'he', DEFAULT_FIND_OPTIONS);
    const alone = findMatches(model.text, 'he', { ...DEFAULT_FIND_OPTIONS, wholeWord: true });
    expect(inside.length).toBeGreaterThan(0);
    expect(alone).toHaveLength(0);
    await pdfium.close(doc);
  });

  it('match case narrows it', async () => {
    const doc = await open('text.pdf');
    const model = buildPageText(0, await pdfium.textRuns(doc, 0));
    const insensitive = findMatches(model.text, 'The', DEFAULT_FIND_OPTIONS);
    const sensitive = findMatches(model.text, 'The', { ...DEFAULT_FIND_OPTIONS, matchCase: true });
    expect(insensitive.length).toBeGreaterThan(0);
    expect(sensitive.length).toBeLessThan(insensitive.length);
    for (const match of sensitive) {
      expect(model.text.slice(match.start, match.end)).toBe('The');
    }
    await pdfium.close(doc);
  });

  it('a regular expression finds what a literal cannot', async () => {
    const doc = await open('text.pdf');
    const model = buildPageText(0, await pdfium.textRuns(doc, 0));
    const words = findMatches(model.text, String.raw`\bqu\w+`, {
      ...DEFAULT_FIND_OPTIONS,
      regex: true,
    });
    expect(words.length).toBeGreaterThan(0);
    for (const match of words) {
      expect(model.text.slice(match.start, match.end).toLowerCase().startsWith('qu')).toBe(true);
    }
    await pdfium.close(doc);
  });

  it('the snippet round a hit contains the hit', async () => {
    const doc = await open('text.pdf');
    const model = buildPageText(0, await pdfium.textRuns(doc, 0));
    const first = must(findMatches(model.text, 'quartz', DEFAULT_FIND_OPTIONS)[0], 'match');
    expect(contextSnippet(model.text, first)).toContain('quartz');
    await pdfium.close(doc);
  });
});

describe('FindController', () => {
  it('scans a whole document and reports "n of m"', async () => {
    const doc = await open('multipage.pdf');
    const text = new TextService(pdfium);
    const controller = new FindController({ engine: pdfium, text, onUpdate: () => undefined });
    const progress = await controller.run(
      { key: 'multi', handle: doc, pageCount: await pdfium.pageCount(doc) },
      'Page',
      DEFAULT_FIND_OPTIONS,
    );
    expect(progress.scanning).toBe(false);
    expect(progress.hits.length).toBe(5); // "Page n of 5" on each of the five pages
    expect(progress.current).toBe(0);
    expect(controller.hitsOnPage(2)).toHaveLength(1);
    await pdfium.close(doc);
  });

  it('starts from the page the reader is on, and wraps at both ends', async () => {
    const doc = await open('multipage.pdf');
    const text = new TextService(pdfium);
    const controller = new FindController({ engine: pdfium, text, onUpdate: () => undefined });
    const source = { key: 'multi2', handle: doc, pageCount: await pdfium.pageCount(doc) };
    await controller.run(source, 'Page', DEFAULT_FIND_OPTIONS, 3);
    expect(controller.currentHit?.page).toBe(3);
    expect(controller.next()?.page).toBe(4);
    expect(controller.next()?.page).toBe(0);
    expect(controller.previous()?.page).toBe(4);
    await pdfium.close(doc);
  });

  it('an empty query clears the hits without scanning', async () => {
    const doc = await open('text.pdf');
    const text = new TextService(pdfium);
    const controller = new FindController({ engine: pdfium, text, onUpdate: () => undefined });
    const progress = await controller.run(
      { key: 'empty', handle: doc, pageCount: 1 },
      '',
      DEFAULT_FIND_OPTIONS,
    );
    expect(progress.hits).toEqual([]);
    expect(progress.scanning).toBe(false);
    expect(controller.next()).toBeNull();
    await pdfium.close(doc);
  });

  it('finds a bookmark title when bookmarks are included, and not otherwise', async () => {
    const doc = await open('outline.pdf');
    const text = new TextService(pdfium);
    const outline = await pdfium.outline(doc);
    const title = outline[0]?.title ?? '';
    expect(title.length).toBeGreaterThan(0);
    const source = { key: 'outline', handle: doc, pageCount: await pdfium.pageCount(doc) };
    const without = new FindController({ engine: pdfium, text, onUpdate: () => undefined });
    const withBookmarks = new FindController({ engine: pdfium, text, onUpdate: () => undefined });
    const a = await without.run(source, title, DEFAULT_FIND_OPTIONS);
    const b = await withBookmarks.run(source, title, {
      ...DEFAULT_FIND_OPTIONS,
      includeBookmarks: true,
    });
    expect(b.hits.filter((h) => h.source === 'bookmark').length).toBeGreaterThan(0);
    expect(a.hits.filter((h) => h.source === 'bookmark')).toHaveLength(0);
    await pdfium.close(doc);
  });

  it('searches two open documents and reports which is which', async () => {
    const text = new TextService(pdfium);
    const one = await open('text.pdf');
    const two = await open('multipage.pdf');
    const results: Array<{ document: string; hits: number }> = [];
    for (const [key, handle] of [
      ['text.pdf', one],
      ['multipage.pdf', two],
    ] as const) {
      const controller = new FindController({ engine: pdfium, text, onUpdate: () => undefined });
      const progress = await controller.run(
        { key, handle, pageCount: await pdfium.pageCount(handle) },
        'o',
        DEFAULT_FIND_OPTIONS,
      );
      results.push({ document: key, hits: progress.hits.length });
    }
    expect(results).toHaveLength(2);
    for (const result of results) expect(result.hits).toBeGreaterThan(0);
    await pdfium.close(one);
    await pdfium.close(two);
  });
});

describe('TextService', () => {
  it('reads a page once and caches it', async () => {
    const doc = await open('text.pdf');
    const text = new TextService(pdfium);
    const source = { key: 'cache', handle: doc, pageCount: 1 };
    expect(text.peek('cache', 0)).toBeUndefined();
    const first = await text.page(source, 0);
    expect(text.peek('cache', 0)).toBe(first);
    expect(await text.page(source, 0)).toBe(first);
    expect(text.isComplete(source)).toBe(true);
    text.forget('cache');
    expect(text.peek('cache', 0)).toBeUndefined();
    await pdfium.close(doc);
  });

  it('two callers asking at once get the same model, read once', async () => {
    const doc = await open('multipage.pdf');
    const text = new TextService(pdfium);
    const source = { key: 'race', handle: doc, pageCount: 5 };
    const [a, b] = await Promise.all([text.page(source, 1), text.page(source, 1)]);
    expect(a).toBe(b);
    await pdfium.close(doc);
  });

  it('a page whose text cannot be read is empty, not fatal', async () => {
    const broken = {
      ...pdfium,
      textRuns: () => Promise.reject(new Error('no')),
    } as unknown as PdfEngine;
    const text = new TextService(broken);
    const model = await text.page({ key: 'broken', handle: 1 as DocHandle, pageCount: 1 }, 0);
    expect(model.text).toBe('');
  });
});

describe('the folder walk', () => {
  it('lists the PDFs of a folder, sorted, and can stay out of sub-folders', () => {
    const all = listPdfs(FIXTURES, true);
    const shallow = listPdfs(FIXTURES, false);
    expect(all.length).toBeGreaterThan(10);
    expect(all.every((p) => p.toLowerCase().endsWith('.pdf'))).toBe(true);
    expect([...all].sort()).toEqual(all.length === shallow.length ? all : all);
    expect(shallow.length).toBeLessThanOrEqual(all.length);
    expect(shallow.some((p) => p.endsWith('text.pdf'))).toBe(true);
  });

  it('an unreadable root is empty rather than an exception', () => {
    expect(listPdfs(join(FIXTURES, 'does-not-exist'), true)).toEqual([]);
  });

  it('finds a known string in a known fixture, the way the worker does', async () => {
    const path = join(FIXTURES, 'text.pdf');
    expect(existsSync(path)).toBe(true);
    const doc = await open('text.pdf');
    const model = buildPageText(0, await pdfium.textRuns(doc, 0));
    const matches = findMatches(model.text, 'Sphinx', DEFAULT_FIND_OPTIONS);
    expect(matches.length).toBeGreaterThan(0);
    await pdfium.close(doc);
  });
});

// ---- Print to PDF ------------------------------------------------------------------------------

/** The pages of an imposed PDF, as the text found on each sheet. */
async function sheetTexts(bytes: Uint8Array): Promise<string[]> {
  const doc = await pdfium.open(bytes);
  const count = await pdfium.pageCount(doc);
  const out: string[] = [];
  for (let page = 0; page < count; page++) out.push(await rawText(doc, page));
  await pdfium.close(doc);
  return out;
}

describe('Print to PDF', () => {
  it('pages 2-3, two-up: one sheet carrying both, in order', async () => {
    const doc = await open('multipage.pdf');
    const sizes = [];
    for (let page = 0; page < 5; page++) {
      const size = await pdfium.pageSize(doc, page);
      sizes.push({ width: size.width, height: size.height });
    }
    const plan = buildPrintPlan({
      settings: {
        ...DEFAULT_PRINT_SETTINGS,
        rangeMode: 'custom',
        rangeText: '2-3',
        mode: 'nup',
        nUpColumns: 2,
        nUpRows: 1,
      },
      pageSizes: sizes,
      currentPage: 0,
      selectedPages: [],
    });
    expect(sheetOrder(plan.sheets)).toEqual([[1, 2]]);

    const bytes = await printToPdf({
      engine: pdfium,
      doc,
      sheets: plan.sheets,
      asImage: false,
      render: { dpi: 96, annotations: true, forms: true, grayscale: false },
    });
    const texts = await sheetTexts(bytes);
    expect(texts).toHaveLength(1);
    // Both source pages are on the one sheet, and page 2 is drawn before page 3.
    expect(texts[0]).toContain('Page 2 of 5');
    expect(texts[0]).toContain('Page 3 of 5');
    const sheet = must(texts[0], 'sheet');
    expect(sheet.indexOf('Page 2 of 5')).toBeLessThan(sheet.indexOf('Page 3 of 5'));
    await pdfium.close(doc);
  });

  it('a booklet of four pages: two sheets, folded 4-1 then 2-3', async () => {
    const doc = await open('multipage.pdf');
    const sizes = [];
    for (let page = 0; page < 4; page++) {
      const size = await pdfium.pageSize(doc, page);
      sizes.push({ width: size.width, height: size.height });
    }
    const plan = buildPrintPlan({
      settings: {
        ...DEFAULT_PRINT_SETTINGS,
        rangeMode: 'custom',
        rangeText: '1-4',
        mode: 'booklet',
      },
      pageSizes: sizes,
      currentPage: 0,
      selectedPages: [],
    });
    expect(sheetOrder(plan.sheets)).toEqual([
      [3, 0],
      [1, 2],
    ]);

    const bytes = await printToPdf({
      engine: pdfium,
      doc,
      sheets: plan.sheets,
      asImage: false,
      render: { dpi: 96, annotations: true, forms: true, grayscale: false },
    });
    const texts = await sheetTexts(bytes);
    expect(texts).toHaveLength(2);
    expect(texts[0]).toContain('Page 4 of 5');
    expect(texts[0]).toContain('Page 1 of 5');
    expect(texts[1]).toContain('Page 2 of 5');
    expect(texts[1]).toContain('Page 3 of 5');
    await pdfium.close(doc);
  });

  it('every sheet is the paper size the plan asked for', async () => {
    const doc = await open('multipage.pdf');
    const plan = buildPrintPlan({
      settings: { ...DEFAULT_PRINT_SETTINGS, rangeMode: 'custom', rangeText: '1-2' },
      pageSizes: [
        { width: 595.28, height: 841.89 },
        { width: 595.28, height: 841.89 },
      ],
      currentPage: 0,
      selectedPages: [],
    });
    const bytes = await printToPdf({
      engine: pdfium,
      doc,
      sheets: plan.sheets,
      asImage: false,
      render: { dpi: 96, annotations: true, forms: true, grayscale: false },
    });
    const out = await pdfium.open(bytes);
    expect(await pdfium.pageCount(out)).toBe(2);
    const size = await pdfium.pageSize(out, 0);
    expect(size.width).toBeCloseTo(plan.paper.width, 1);
    expect(size.height).toBeCloseTo(plan.paper.height, 1);
    await pdfium.close(out);
    await pdfium.close(doc);
  });

  it('reports progress once per sheet and can be cancelled', async () => {
    const doc = await open('multipage.pdf');
    const sizes = Array.from({ length: 5 }, () => ({ width: 595.28, height: 841.89 }));
    const sheets = imposePages(
      sizes.map((size, index) => ({ index, ...size })),
      {
        paper: { width: 595.28, height: 841.89 },
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        scaling: 'shrink',
        customScale: 100,
        autoRotate: true,
        autoCentre: true,
        nUp: null,
        booklet: null,
        tile: null,
      },
    );
    const seen: number[] = [];
    await printToPdf({
      engine: pdfium,
      doc,
      sheets,
      asImage: false,
      render: { dpi: 96, annotations: true, forms: true, grayscale: false },
      onProgress: (done) => seen.push(done),
    });
    expect(seen).toEqual([1, 2, 3, 4, 5]);

    const controller = new AbortController();
    controller.abort();
    await expect(
      printToPdf({
        engine: pdfium,
        doc,
        sheets,
        asImage: false,
        render: { dpi: 96, annotations: true, forms: true, grayscale: false },
        signal: controller.signal,
      }),
    ).rejects.toThrow();
    await pdfium.close(doc);
  });
});

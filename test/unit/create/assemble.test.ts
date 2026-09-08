/**
 * Stitching a crawl into one document (M91). Three small PDFs made here stand in for what
 * Chromium printed; the merged result is opened with the real engine so the outline and the
 * rewritten links asserted are what PDFium reads back.
 */

import { PDFDocument, PDFName, PDFString, type PDFRef } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import {
  assembleWebPdf,
  rewriteLinks,
  writeOutline,
  type AssemblePage,
} from '@engine/create/web/assemble';
import { ConvertCancelled } from '@engine/create/types';
import { engine } from '../engine/helpers';

interface LinkSpec {
  readonly uri: string;
  readonly y: number;
}

/** A PDF of `pages` pages; the first carries a URI link annotation per spec. */
async function linkedPdf(
  pages: number,
  links: ReadonlyArray<LinkSpec> = [],
  title = '',
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage([300, 300]);
  const first = doc.getPage(0);
  const refs: PDFRef[] = links.map((link) =>
    doc.context.register(
      doc.context.obj({
        Type: 'Annot',
        Subtype: 'Link',
        Rect: [10, link.y, 200, link.y + 20],
        Border: [0, 0, 0],
        A: { S: 'URI', URI: PDFString.of(link.uri) },
      }),
    ),
  );
  if (refs.length > 0) first.node.set(PDFName.of('Annots'), doc.context.obj(refs));
  if (title !== '') doc.setTitle(title);
  return doc.save();
}

/** A well-formed PDF with no pages at all. */
async function emptyPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  return doc.save({ addDefaultPage: false });
}

const INDEX = 'file:///site/index.html';
const ABOUT = 'file:///site/about.html';
const CONTACT = 'file:///site/contact.html';
const CONTACT_ALIAS = 'file:///site/contact-us.html';
const OUTSIDE = 'https://example.com/outside';
const MAILTO = 'mailto:someone@example.com';

async function site(): Promise<AssemblePage[]> {
  return [
    {
      url: INDEX,
      title: 'Home',
      pdf: await linkedPdf(1, [
        { uri: ABOUT, y: 250 },
        { uri: `${CONTACT}#team`, y: 200 },
        { uri: CONTACT_ALIAS, y: 150 },
        { uri: OUTSIDE, y: 100 },
        { uri: MAILTO, y: 50 },
      ]),
    },
    { url: ABOUT, title: 'About', pdf: await linkedPdf(2, [{ uri: `${INDEX}#top`, y: 100 }]) },
    { url: CONTACT, aliases: [CONTACT_ALIAS], title: 'Contact', pdf: await linkedPdf(3) },
  ];
}

describe('assembleWebPdf', () => {
  it('merges the pages, bookmarks each crawled page and turns crawl links into GoTos', async () => {
    const progress: string[] = [];
    const result = await assembleWebPdf(await site(), {
      bookmarks: true,
      progress: (_f, m) => progress.push(m),
    });
    expect(result.pageCount).toBe(6);
    expect(result.title).toBe('Home');
    expect(result.warnings).toEqual([]);
    expect(result.internalLinks).toBe(4);
    expect(result.outline).toEqual([
      { title: 'Home', page: 0 },
      { title: 'About', page: 1 },
      { title: 'Contact', page: 3 },
    ]);
    expect(progress).toEqual([
      'Adding Home (1 of 3)',
      'Adding About (2 of 3)',
      'Adding Contact (3 of 3)',
      'Writing the document',
    ]);

    const pdf = await engine();
    const doc = await pdf.open(result.bytes);
    try {
      expect(await pdf.pageCount(doc)).toBe(6);
      expect((await pdf.metadata(doc)).title).toBe('Home');
      const outline = await pdf.outline(doc);
      expect(outline.map((o) => [o.title, o.dest?.page])).toEqual([
        ['Home', 0],
        ['About', 1],
        ['Contact', 3],
      ]);
      expect(outline.every((o) => o.children.length === 0)).toBe(true);

      const links = await pdf.links(doc, 0);
      expect(links).toHaveLength(5);
      const byTop = [...links].sort((a, b) => b.rect.y1 - a.rect.y1);
      expect(byTop[0]?.dest?.page).toBe(1);
      expect(byTop[0]?.uri).toBeUndefined();
      expect(byTop[1]?.dest?.page).toBe(3);
      expect(byTop[2]?.dest?.page).toBe(3);
      expect(byTop[3]?.uri).toBe(OUTSIDE);
      expect(byTop[3]?.dest).toBeUndefined();
      expect(byTop[4]?.uri).toBe(MAILTO);

      const back = await pdf.links(doc, 1);
      expect(back).toHaveLength(1);
      expect(back[0]?.dest?.page).toBe(0);
    } finally {
      await pdf.close(doc);
    }
  });

  it('writes no outline when bookmarks are off', async () => {
    const result = await assembleWebPdf(await site(), { bookmarks: false });
    expect(result.outline).toHaveLength(3);
    const pdf = await engine();
    const doc = await pdf.open(result.bytes);
    try {
      expect(await pdf.outline(doc)).toEqual([]);
    } finally {
      await pdf.close(doc);
    }
  });

  it('takes the title from the option', async () => {
    const result = await assembleWebPdf(await site(), { bookmarks: true, title: 'My site' });
    expect(result.title).toBe('My site');
    expect((await PDFDocument.load(result.bytes)).getTitle()).toBe('My site');
  });

  it('skips a page whose PDF cannot be read and one that printed as nothing', async () => {
    const pages: AssemblePage[] = [
      { url: INDEX, title: 'Home', pdf: await linkedPdf(1, [{ uri: ABOUT, y: 100 }]) },
      { url: 'file:///site/broken.html', title: 'Broken', pdf: new Uint8Array([1, 2, 3]) },
      { url: 'file:///site/empty.html', title: 'Empty', pdf: await emptyPdf() },
      { url: ABOUT, title: 'About', pdf: await linkedPdf(1) },
    ];
    const result = await assembleWebPdf(pages, { bookmarks: true });
    expect(result.pageCount).toBe(2);
    expect(result.outline).toEqual([
      { title: 'Home', page: 0 },
      { title: 'About', page: 1 },
    ]);
    expect(result.internalLinks).toBe(1);
    expect(result.warnings).toHaveLength(2);
    expect(result.warnings[0]).toMatch(/^Broken was skipped: /);
    expect(result.warnings[1]).toBe('Empty printed as no pages');
  });

  it('fails when nothing could be read, or nothing was given', async () => {
    await expect(
      assembleWebPdf([{ url: INDEX, title: 'Home', pdf: new Uint8Array([1, 2, 3]) }], {
        bookmarks: true,
      }),
    ).rejects.toMatchObject({ name: 'ConvertUnsupported', reason: 'corrupt' });
    await expect(assembleWebPdf([], { bookmarks: true })).rejects.toMatchObject({
      name: 'ConvertUnsupported',
      reason: 'empty',
    });
  });

  it('stops when cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      assembleWebPdf(await site(), { bookmarks: true, signal: controller.signal }),
    ).rejects.toBeInstanceOf(ConvertCancelled);
  });
});

describe('writeOutline', () => {
  it('writes nothing for no items', async () => {
    const doc = await PDFDocument.create();
    doc.addPage();
    writeOutline(doc, []);
    expect(doc.catalog.get(PDFName.of('Outlines'))).toBeUndefined();
  });

  it('points an item past the end at the first page', async () => {
    const doc = await PDFDocument.create();
    doc.addPage();
    doc.addPage();
    writeOutline(doc, [
      { title: 'One', page: 1 },
      { title: 'Beyond', page: 7 },
    ]);
    const bytes = await doc.save();
    const pdf = await engine();
    const handle = await pdf.open(bytes);
    try {
      const outline = await pdf.outline(handle);
      expect(outline.map((o) => [o.title, o.dest?.page])).toEqual([
        ['One', 1],
        ['Beyond', 0],
      ]);
    } finally {
      await pdf.close(handle);
    }
  });
});

describe('rewriteLinks', () => {
  it('leaves links alone that are not URIs to crawled pages', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([100, 100]);
    const ctx = doc.context;
    const annots = [
      // Not a URL at all.
      ctx.obj({
        Type: 'Annot',
        Subtype: 'Link',
        Rect: [0, 0, 10, 10],
        A: { S: 'URI', URI: PDFString.of('not a url') },
      }),
      // A URL nobody crawled.
      ctx.obj({
        Type: 'Annot',
        Subtype: 'Link',
        Rect: [0, 0, 10, 10],
        A: { S: 'URI', URI: PDFString.of('https://x.test/') },
      }),
      // Already a GoTo.
      ctx.obj({
        Type: 'Annot',
        Subtype: 'Link',
        Rect: [0, 0, 10, 10],
        A: { S: 'GoTo', D: [page.ref, 'Fit'] },
      }),
      // A link with no action.
      ctx.obj({ Type: 'Annot', Subtype: 'Link', Rect: [0, 0, 10, 10] }),
      // A URI that is not a string.
      ctx.obj({ Type: 'Annot', Subtype: 'Link', Rect: [0, 0, 10, 10], A: { S: 'URI', URI: 42 } }),
      // Not a link.
      ctx.obj({ Type: 'Annot', Subtype: 'Square', Rect: [0, 0, 10, 10] }),
      // A crawled page whose index is out of range.
      ctx.obj({
        Type: 'Annot',
        Subtype: 'Link',
        Rect: [0, 0, 10, 10],
        A: { S: 'URI', URI: PDFString.of('https://gone.test/') },
      }),
    ];
    page.node.set(PDFName.of('Annots'), ctx.obj(annots.map((a) => ctx.register(a))));
    const map = new Map<string, number>([['https://gone.test/', 9]]);
    expect(rewriteLinks(doc, map)).toBe(0);
    expect(String(page.node.Annots()?.lookup(0))).toContain('not a url');

    // A page with no annotations is skipped.
    doc.addPage();
    expect(rewriteLinks(doc, map)).toBe(0);
  });

  it('rewrites a hex-string URI and removes any /Dest', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([100, 100]);
    const target = doc.addPage([100, 100]);
    const ctx = doc.context;
    const annot = ctx.obj({
      Type: 'Annot',
      Subtype: 'Link',
      Rect: [0, 0, 10, 10],
      Dest: [page.ref, 'Fit'],
      A: { S: 'URI', URI: PDFString.of('HTTP://Site.test:80/a#frag') },
    });
    page.node.set(PDFName.of('Annots'), ctx.obj([ctx.register(annot)]));
    expect(rewriteLinks(doc, new Map([['http://site.test/a', 1]]))).toBe(1);
    expect(annot.get(PDFName.of('Dest'))).toBeUndefined();
    const bytes = await doc.save();
    const pdf = await engine();
    const handle = await pdf.open(bytes);
    try {
      const links = await pdf.links(handle, 0);
      expect(links[0]?.dest?.page).toBe(1);
      expect(target.ref).toBeDefined();
    } finally {
      await pdf.close(handle);
    }
  });
});

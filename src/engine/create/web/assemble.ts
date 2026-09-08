/**
 * Stitching a crawl into one document (M91): the per-page PDFs Chromium printed are merged,
 * one bookmark is added per crawled page, and every link that points at a crawled page is turned
 * from a URL into a `GoTo` to that page's first page, so it works inside the PDF. Links to pages
 * outside the crawl stay URLs. Pure over bytes.
 */

import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFString,
  type PDFRef,
} from 'pdf-lib';
import { checkCancelled, ConvertUnsupported, type ConvertProgress } from '../types';
import { normalizeUrl } from './urls';

export interface AssemblePage {
  readonly url: string;
  readonly aliases?: ReadonlyArray<string>;
  readonly title: string;
  readonly pdf: Uint8Array;
}

export interface AssembleOptions {
  readonly bookmarks: boolean;
  readonly title?: string;
  readonly signal?: AbortSignal;
  readonly progress?: ConvertProgress;
}

export interface AssembleResult {
  readonly bytes: Uint8Array;
  readonly pageCount: number;
  readonly title: string;
  /** One entry per crawled page: its bookmark title and first page index. */
  readonly outline: ReadonlyArray<{ readonly title: string; readonly page: number }>;
  /** How many links were turned into `GoTo`s. */
  readonly internalLinks: number;
  readonly warnings: ReadonlyArray<string>;
}

export async function assembleWebPdf(
  pages: ReadonlyArray<AssemblePage>,
  options: AssembleOptions,
): Promise<AssembleResult> {
  if (pages.length === 0) throw new ConvertUnsupported('empty', 'No pages were rendered');
  const out = await PDFDocument.create({ updateMetadata: false });
  const warnings: string[] = [];
  const firstPageOf = new Map<string, number>();
  const outline: { title: string; page: number }[] = [];

  for (const [index, page] of pages.entries()) {
    checkCancelled(options.signal);
    options.progress?.(
      index / pages.length,
      `Adding ${page.title} (${index + 1} of ${pages.length})`,
    );
    let source: PDFDocument;
    try {
      source = await PDFDocument.load(page.pdf, { ignoreEncryption: true, updateMetadata: false });
    } catch (error) {
      warnings.push(
        `${page.title} was skipped: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }
    const indices = source.getPageIndices();
    if (indices.length === 0) {
      warnings.push(`${page.title} printed as no pages`);
      continue;
    }
    const first = out.getPageCount();
    const copied = await out.copyPages(source, indices);
    for (const p of copied) out.addPage(p);
    for (const key of [page.url, ...(page.aliases ?? [])]) {
      const normalised = normalizeUrl(key) ?? key;
      if (!firstPageOf.has(normalised)) firstPageOf.set(normalised, first);
    }
    outline.push({ title: page.title, page: first });
  }
  if (out.getPageCount() === 0)
    throw new ConvertUnsupported('corrupt', 'None of the rendered pages could be read');

  const internalLinks = rewriteLinks(out, firstPageOf);
  if (options.bookmarks) writeOutline(out, outline);
  const title = options.title ?? pages[0]?.title ?? 'Web page';
  out.setTitle(title);
  out.setProducer('ynotPDF');
  out.setCreator('ynotPDF');
  options.progress?.(1, 'Writing the document');
  const bytes = await out.save({ addDefaultPage: false, updateFieldAppearances: false });
  return { bytes, pageCount: out.getPageCount(), title, outline, internalLinks, warnings };
}

/** Turns URI link annotations that point at a crawled page into `GoTo` actions. */
export function rewriteLinks(doc: PDFDocument, firstPageOf: ReadonlyMap<string, number>): number {
  const context = doc.context;
  const pages = doc.getPages();
  let rewritten = 0;
  for (const page of pages) {
    const annots = page.node.Annots();
    if (!annots) continue;
    for (let i = 0; i < annots.size(); i++) {
      // `lookupMaybe` throws rather than returning undefined when the entry is not a dictionary
      // at all, which a malformed `/Annots` can be. A link we cannot read is a link left alone.
      let annot: PDFDict | undefined;
      try {
        annot = annots.lookupMaybe(i, PDFDict);
      } catch {
        continue;
      }
      if (!annot) continue;
      const subtype = annot.get(PDFName.of('Subtype'));
      if (!(subtype instanceof PDFName) || subtype.decodeText() !== 'Link') continue;
      const action = annot.lookupMaybe(PDFName.of('A'), PDFDict);
      if (!action) continue;
      const kind = action.get(PDFName.of('S'));
      if (!(kind instanceof PDFName) || kind.decodeText() !== 'URI') continue;
      const uriObject = action.lookup(PDFName.of('URI'));
      const uri =
        uriObject instanceof PDFString || uriObject instanceof PDFHexString
          ? uriObject.decodeText()
          : null;
      if (!uri) continue;
      const key = normalizeUrl(uri);
      if (!key) continue;
      const target = firstPageOf.get(key);
      if (target === undefined) continue;
      const targetRef = pages[target]?.ref;
      if (!targetRef) continue;
      const dest = context.obj([targetRef, 'Fit']);
      annot.set(PDFName.of('A'), context.obj({ S: 'GoTo', D: dest }));
      annot.delete(PDFName.of('Dest'));
      rewritten++;
    }
  }
  return rewritten;
}

/** A flat outline: one item per crawled page, in order. */
export function writeOutline(
  doc: PDFDocument,
  items: ReadonlyArray<{ readonly title: string; readonly page: number }>,
): void {
  if (items.length === 0) return;
  const context = doc.context;
  const pages = doc.getPages();
  const outlinesRef = context.nextRef();
  const refs: PDFRef[] = items.map(() => context.nextRef());
  items.forEach((item, i) => {
    const pageRef = pages[item.page]?.ref ?? pages[0]?.ref;
    const dict: Record<string, unknown> = {
      Title: PDFHexString.fromText(item.title),
      Parent: outlinesRef,
      ...(pageRef ? { Dest: context.obj([pageRef, 'Fit']) } : {}),
    };
    const prev = refs[i - 1];
    const next = refs[i + 1];
    if (prev) dict['Prev'] = prev;
    if (next) dict['Next'] = next;
    const ref = refs[i];
    if (ref) context.assign(ref, context.obj(dict as Parameters<typeof context.obj>[0]));
  });
  const first = refs[0];
  const last = refs[refs.length - 1];
  if (!first || !last) return;
  context.assign(
    outlinesRef,
    context.obj({ Type: 'Outlines', First: first, Last: last, Count: items.length }),
  );
  doc.catalog.set(PDFName.of('Outlines'), outlinesRef);
}

export { PDFArray };

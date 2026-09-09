/**
 * Combine — several documents into one (M41). Pure over bytes.
 *
 * What makes this more than "copy every page" is the three things a reader expects afterwards:
 *
 * 1. **A bookmark per source file**, named from the file, so a 400-page combination of forty
 *    files is navigable. Each file's own bookmarks nest underneath it when they are kept.
 * 2. **Page ranges per source**, so "pages 2–4 of that one" does not need a separate extract.
 * 3. **Page-size normalisation**, because a stack of A4 with two Letter pages in it prints badly.
 *    Normalising *scales* nothing: it re-boxes the page onto the target paper and centres the
 *    existing content, which is what Foxit's "same page size" does and what keeps text crisp.
 *
 * A source that cannot be read is a warning, not a failure — a combine of forty files must not
 * be lost because the thirty-first is damaged — unless nothing at all could be read.
 */

import type { PDFDocument } from 'pdf-lib';
import { PDFName, type PDFPage } from 'pdf-lib';
import type { PdfRect } from '@shared/pdf';
import { writeOutlineTree, type OutlineEntry } from './outline';
import {
  createPdf,
  effectiveBox,
  loadPdf,
  readOutline,
  readRotation,
  savePdf,
  writeBoxes,
} from './pdfdoc';
import { OpFailed, checkCancelled, type OpContext, type OpResult, type OpSource } from './types';

/** How the combined document's pages should be sized. */
export type PageSizeRule =
  /** Leave every page exactly as it came. */
  | { readonly kind: 'keep' }
  /** Re-box every page onto the first page's size. */
  | { readonly kind: 'first' }
  /** Re-box every page onto the largest page in the combination. */
  | { readonly kind: 'largest' }
  /** Re-box every page onto a fixed size in points. */
  | { readonly kind: 'fixed'; readonly width: number; readonly height: number };

export interface CombineOptions {
  /** Add one top-level bookmark per source file, named from the file. Default true. */
  readonly bookmarkPerFile?: boolean;
  /** Keep each source's own bookmarks, nested under its file bookmark. Default true. */
  readonly keepBookmarks?: boolean;
  readonly pageSize?: PageSizeRule;
  /** `/Title` for the result. Defaults to the first source's name. */
  readonly title?: string;
}

export const DEFAULT_COMBINE_OPTIONS: Required<Omit<CombineOptions, 'title'>> = {
  bookmarkPerFile: true,
  keepBookmarks: true,
  pageSize: { kind: 'keep' },
};

export interface CombineResult extends OpResult {
  readonly title: string;
  /** Where each source's pages start in the result; `-1` for a source that contributed none. */
  readonly startPages: ReadonlyArray<number>;
}

/** A source document's name without its directory or its extension — the bookmark's title. */
export function bookmarkTitle(name: string): string {
  const slash = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'));
  const base = slash >= 0 ? name.slice(slash + 1) : name;
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  return stem.trim() === '' ? base : stem;
}

export async function combine(
  sources: ReadonlyArray<OpSource>,
  options: CombineOptions = {},
  ctx: OpContext = {},
): Promise<CombineResult> {
  if (sources.length === 0) throw new OpFailed('There are no files to combine');
  const opts = { ...DEFAULT_COMBINE_OPTIONS, ...options };
  const warnings: string[] = [];
  const out = await createPdf();

  interface Loaded {
    readonly source: OpSource;
    readonly doc: PDFDocument;
    readonly pages: ReadonlyArray<number>;
  }

  // Read every source first: the page-size rule may need to know the largest page before the
  // first one is copied, and a source that fails should be reported before anything is written.
  const loaded: Loaded[] = [];
  for (const [i, source] of sources.entries()) {
    checkCancelled(ctx.signal);
    ctx.progress?.((i / sources.length) * 0.3, `Reading ${source.name}`);
    let doc: PDFDocument;
    let count: number;
    try {
      doc = await loadPdf(source.bytes, source.name);
      // A damaged file can load and only fall over when its page tree is walked — pdf-lib is
      // lazy about the catalogue — so counting the pages is part of "can this be read".
      count = doc.getPageCount();
    } catch (error) {
      warnings.push(
        error instanceof OpFailed
          ? error.message
          : `${source.name} could not be read: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }
    const wanted =
      source.pages && source.pages.length > 0
        ? source.pages.filter((p) => Number.isInteger(p) && p >= 0 && p < count)
        : Array.from({ length: count }, (_, p) => p);
    if (wanted.length === 0) {
      warnings.push(`${source.name} contributed no pages`);
      continue;
    }
    loaded.push({ source, doc, pages: wanted });
  }
  if (loaded.length === 0) {
    throw new OpFailed(
      warnings[0] ?? 'None of the chosen files could be read, so there is nothing to combine',
    );
  }

  const target = targetSize(opts.pageSize, loaded);
  const outline: OutlineEntry[] = [];
  const startPages: number[] = sources.map(() => -1);
  const sourceIndex = new Map<OpSource, number>();
  sources.forEach((s, i) => sourceIndex.set(s, i));

  for (const [i, entry] of loaded.entries()) {
    checkCancelled(ctx.signal);
    ctx.progress?.(0.3 + (i / loaded.length) * 0.6, `Adding ${entry.source.name}`);
    const first = out.getPageCount();
    let copied: PDFPage[];
    try {
      copied = await out.copyPages(entry.doc, [...entry.pages]);
    } catch (error) {
      warnings.push(
        `${entry.source.name} could not be copied: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      continue;
    }
    for (const page of copied) {
      out.addPage(page);
      if (target) reboxPage(page, target);
    }
    startPages[sourceIndex.get(entry.source) ?? i] = first;

    if (opts.bookmarkPerFile) {
      outline.push({ title: bookmarkTitle(entry.source.name), page: first, parent: null });
    }
    if (opts.keepBookmarks) {
      const parent = opts.bookmarkPerFile ? outline.length - 1 : null;
      // Where each source page landed, so a bookmark aimed at a page that was not taken is kept
      // as a heading rather than pointed at somebody else's page.
      const landing = new Map<number, number>();
      entry.pages.forEach((page, at) => {
        if (!landing.has(page)) landing.set(page, first + at);
      });
      const base = outline.length;
      for (const item of readOutline(entry.doc)) {
        outline.push({
          title: item.title,
          page: item.page === null ? null : (landing.get(item.page) ?? null),
          parent: item.parent === null ? parent : base + item.parent,
          bold: item.bold,
          italic: item.italic,
          color: item.color,
          open: item.open,
        });
      }
    }
  }

  if (out.getPageCount() === 0) throw new OpFailed('Nothing could be copied out of those files');
  if (outline.length > 0) writeOutlineTree(out, outline);

  const title = options.title ?? bookmarkTitle(loaded[0]?.source.name ?? 'Combined');
  out.setTitle(title);
  ctx.progress?.(0.95, 'Writing the combined document');
  const bytes = await savePdf(out);
  ctx.progress?.(1, 'Done');
  return { bytes, pageCount: out.getPageCount(), title, warnings, startPages };
}

/** The paper every page is re-boxed onto, or `null` when pages keep their own size. */
function targetSize(
  rule: PageSizeRule,
  loaded: ReadonlyArray<{ readonly doc: PDFDocument; readonly pages: ReadonlyArray<number> }>,
): { width: number; height: number } | null {
  if (rule.kind === 'keep') return null;
  if (rule.kind === 'fixed') {
    if (!(rule.width > 0) || !(rule.height > 0)) {
      throw new OpFailed('The page size to normalise to must be bigger than nothing');
    }
    return { width: rule.width, height: rule.height };
  }
  const sizes: Array<{ width: number; height: number }> = [];
  for (const entry of loaded) {
    const pages = entry.doc.getPages();
    for (const index of entry.pages) {
      const page = pages[index];
      if (!page) continue;
      const box = effectiveBox(page.node, 'crop');
      // The *displayed* size: a page with /Rotate 90 is landscape however its box reads.
      const swap = readRotation(page.node) % 180 !== 0;
      const width = box.x1 - box.x0;
      const height = box.y1 - box.y0;
      sizes.push(swap ? { width: height, height: width } : { width, height });
      if (rule.kind === 'first') return sizes[0] ?? null;
    }
  }
  if (sizes.length === 0) return null;
  if (rule.kind === 'first') return sizes[0] ?? null;
  // "Largest" is the largest *area*, not the widest: a tall page and a wide page of the same
  // area are equally awkward, and area is the one that keeps a poster page a poster page.
  return sizes.reduce((best, s) => (s.width * s.height > best.width * best.height ? s : best));
}

/**
 * Puts a page on paper of a given size without scaling it: the boxes become the target size and
 * the existing content is centred inside them.
 *
 * Scaling is deliberately not offered. Re-boxing keeps text at the size its author chose and
 * every glyph exactly where the font put it; scaling would resample nothing but would change
 * every measurement in the document, which is wrong for a drawing and wrong for a form.
 */
function reboxPage(page: PDFPage, target: { width: number; height: number }): void {
  const leaf = page.node;
  const crop = effectiveBox(leaf, 'crop');
  const swap = readRotation(leaf) % 180 !== 0;
  // The target is a *displayed* size; the boxes are unrotated, so a rotated page swaps them back.
  const width = swap ? target.height : target.width;
  const height = swap ? target.width : target.height;
  const dx = (width - (crop.x1 - crop.x0)) / 2;
  const dy = (height - (crop.y1 - crop.y0)) / 2;
  const box: PdfRect = {
    x0: crop.x0 - dx,
    y0: crop.y0 - dy,
    x1: crop.x0 - dx + width,
    y1: crop.y0 - dy + height,
  };
  // The three optional boxes came from a page of another size; leaving them would clip.
  writeBoxes(leaf, { media: box, crop: box, bleed: null, trim: null, art: null });
  leaf.delete(PDFName.of('UserUnit'));
}

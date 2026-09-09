/**
 * Split — one document into several (M41). Pure over bytes.
 *
 * Four ways to decide where the cuts go, which is what Foxit's Split dialog offers:
 *
 * - **by page count** — every N pages;
 * - **by top-level bookmark** — each chapter its own file, which is the one people actually want;
 * - **by explicit ranges** — the caller has already worked out the groups;
 * - **by file size** — every part under a budget.
 *
 * The last one cannot be answered by arithmetic. Pages share fonts, images and colour spaces, so
 * ten pages together are much smaller than ten pages apart, and there is no way to know a part's
 * size without writing it. So it is measured: take pages greedily, write, and when the result is
 * over budget give pages back and write again, remembering bytes-per-page so the second guess is
 * close rather than one page shorter. A single page over budget on its own goes out alone with a
 * warning — the honest answer, because the alternative is a file that cannot be produced at all.
 *
 * Naming is a pattern, not a rule buried in code: `{name}`, `{index}`, `{range}`, `{start}`,
 * `{end}`, `{label}` and `{count}`, so a reader can have `Report_03_11-15.pdf` or
 * `Report - Chapter 2.pdf` without asking for a feature.
 */

import type { PDFDocument } from 'pdf-lib';
import { PDFDict, PDFName } from 'pdf-lib';
import { writeOutlineTree, type OutlineEntry } from './outline';
import { createPdf, loadPdf, readOutline, savePdf } from './pdfdoc';
import { OpFailed, checkCancelled, type OpContext } from './types';

export type SplitRule =
  /** Every `pages` pages. */
  | { readonly kind: 'count'; readonly pages: number }
  /** Parts no larger than `bytes`, measured. */
  | { readonly kind: 'size'; readonly bytes: number }
  /** One part per top-level bookmark; anything before the first bookmark is its own part. */
  | { readonly kind: 'bookmarks' }
  /** Groups the caller has already chosen, 0-based page indexes. */
  | { readonly kind: 'ranges'; readonly groups: ReadonlyArray<ReadonlyArray<number>> };

export interface SplitOptions {
  readonly rule: SplitRule;
  /** File-name pattern; see the module comment. Default `"{name}_{index}_{range}"`. */
  readonly namePattern?: string;
  /** Keep each part's bookmarks. Default true. */
  readonly keepBookmarks?: boolean;
  /** Keep markup annotations. Default true. */
  readonly keepComments?: boolean;
  /** Keep form fields. Default true. */
  readonly keepForms?: boolean;
  /** Base name for `{name}`; defaults to the source's name without its extension. */
  readonly baseName?: string;
  /** Page labels of the source, one per page, for `{label}`. */
  readonly pageLabels?: ReadonlyArray<string>;
}

export const DEFAULT_NAME_PATTERN = '{name}_{index}_{range}';

export interface SplitPart {
  /** File name including `.pdf`. */
  readonly name: string;
  readonly bytes: Uint8Array;
  /** 0-based source pages in this part, in order. */
  readonly pages: ReadonlyArray<number>;
  /** `"1-5"`, for the name and for a summary line. */
  readonly range: string;
  /** The bookmark this part was cut at, when it was cut at one. */
  readonly title?: string;
}

export interface SplitResult {
  readonly parts: ReadonlyArray<SplitPart>;
  readonly warnings: ReadonlyArray<string>;
}

/** `[0,1,2,4]` → `"1-3, 5"`. 1-based, because that is what a file name should say. */
export function formatPageRange(pages: ReadonlyArray<number>): string {
  const sorted = [...new Set(pages)].sort((a, b) => a - b);
  const parts: string[] = [];
  let i = 0;
  while (i < sorted.length) {
    const start = sorted[i] ?? 0;
    let end = start;
    while (i + 1 < sorted.length && sorted[i + 1] === end + 1) {
      i++;
      end = sorted[i] ?? end;
    }
    parts.push(start === end ? String(start + 1) : `${String(start + 1)}-${String(end + 1)}`);
    i++;
  }
  return parts.join(', ');
}

/** `{ label }` for a page that has one, and nothing at all for a page that does not. */
function labelOf(
  labels: ReadonlyArray<string> | undefined,
  page: number,
): { readonly label?: string } {
  const label = labels?.[page];
  return label === undefined ? {} : { label };
}

/** Everything a file name may not contain on Windows, macOS or Linux, plus the trailing dot. */
export function safeFileName(name: string): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|]/g, '-')
    // eslint-disable-next-line no-control-regex -- control characters are illegal in file names
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '');
  return cleaned === '' ? 'part' : cleaned.slice(0, 120);
}

/** Fills a name pattern. Unknown `{tokens}` are left alone so a typo is visible, not silent. */
export function fillNamePattern(
  pattern: string,
  values: {
    readonly name: string;
    readonly index: number;
    readonly total: number;
    readonly pages: ReadonlyArray<number>;
    readonly title?: string;
    readonly label?: string;
  },
): string {
  const pages = [...values.pages].sort((a, b) => a - b);
  const start = (pages[0] ?? 0) + 1;
  const end = (pages[pages.length - 1] ?? 0) + 1;
  // Zero-padded to the width of the largest index, so ten parts sort as 01..10 in a file list.
  const width = String(values.total).length;
  const table: Readonly<Record<string, string>> = {
    name: values.name,
    index: String(values.index + 1).padStart(width, '0'),
    range: formatPageRange(pages),
    start: String(start),
    end: String(end),
    count: String(pages.length),
    label: values.label ?? String(start),
    title: values.title ?? '',
  };
  const filled = pattern.replace(/\{(\w+)\}/g, (whole, key: string) => table[key] ?? whole);
  return `${safeFileName(filled)}.pdf`;
}

/** The page groups a rule asks for, without writing anything. Exported for the dialog's preview. */
export function planGroups(
  rule: SplitRule,
  pageCount: number,
  topLevelBookmarks: ReadonlyArray<{ readonly title: string; readonly page: number }> = [],
): Array<{ pages: number[]; title?: string }> {
  const all = Array.from({ length: pageCount }, (_, i) => i);
  switch (rule.kind) {
    case 'count': {
      const size = Math.max(1, Math.floor(rule.pages));
      const groups: Array<{ pages: number[] }> = [];
      for (let i = 0; i < all.length; i += size) groups.push({ pages: all.slice(i, i + size) });
      return groups;
    }
    case 'ranges': {
      return rule.groups
        .map((g) => ({
          pages: [...new Set(g)].filter((p) => p >= 0 && p < pageCount).sort((a, b) => a - b),
        }))
        .filter((g) => g.pages.length > 0);
    }
    case 'bookmarks': {
      const marks = [...topLevelBookmarks]
        .filter((b) => b.page >= 0 && b.page < pageCount)
        .sort((a, b) => a.page - b.page);
      if (marks.length === 0) return [{ pages: all }];
      const groups: Array<{ pages: number[]; title?: string }> = [];
      // Pages before the first bookmark are a part of their own — a cover and a contents page
      // belong somewhere, and silently gluing them to chapter one is a guess.
      const firstPage = marks[0]?.page ?? 0;
      if (firstPage > 0) groups.push({ pages: all.slice(0, firstPage) });
      marks.forEach((mark, i) => {
        const next = marks[i + 1]?.page ?? pageCount;
        if (next <= mark.page) return;
        groups.push({ pages: all.slice(mark.page, next), title: mark.title });
      });
      return groups.filter((g) => g.pages.length > 0);
    }
    case 'size':
      // Size is measured, not planned; the caller runs `split`.
      return [{ pages: all }];
  }
}

export async function split(
  bytes: Uint8Array,
  options: SplitOptions,
  ctx: OpContext = {},
): Promise<SplitResult> {
  const source = await loadPdf(bytes, options.baseName ?? 'The document');
  const pageCount = source.getPageCount();
  if (pageCount === 0) throw new OpFailed('The document has no pages to split');
  const name = options.baseName ?? 'Document';
  const pattern = options.namePattern ?? DEFAULT_NAME_PATTERN;
  const warnings: string[] = [];

  const outline = readOutline(source);
  const topLevel = outline
    .filter((item) => item.parent === null && item.page !== null)
    .flatMap((item) => (item.page === null ? [] : [{ title: item.title, page: item.page }]));
  if (options.rule.kind === 'bookmarks' && topLevel.length === 0) {
    warnings.push('The document has no top-level bookmarks, so it was left whole');
  }

  const groups =
    options.rule.kind === 'size'
      ? await groupsBySize(source, options, options.rule.bytes, warnings, ctx)
      : planGroups(options.rule, pageCount, topLevel);
  if (groups.length === 0) throw new OpFailed('Those settings produce no files');

  const parts: SplitPart[] = [];
  for (const [i, group] of groups.entries()) {
    checkCancelled(ctx.signal);
    ctx.progress?.((i / groups.length) * 0.95, `Writing part ${String(i + 1)} of ${groups.length}`);
    const built = await buildPart(source, group.pages, options, outline);
    parts.push({
      name: fillNamePattern(pattern, {
        name,
        index: i,
        total: groups.length,
        pages: group.pages,
        ...(group.title === undefined ? {} : { title: group.title }),
        ...labelOf(options.pageLabels, group.pages[0] ?? 0),
      }),
      bytes: built,
      pages: group.pages,
      range: formatPageRange(group.pages),
      ...(group.title === undefined ? {} : { title: group.title }),
    });
  }
  ctx.progress?.(1, 'Done');
  return { parts, warnings };
}

/** One part's bytes: the pages copied out, with whatever the options say to keep. */
async function buildPart(
  source: PDFDocument,
  pages: ReadonlyArray<number>,
  options: SplitOptions,
  outline: ReadonlyArray<ReturnType<typeof readOutline>[number]>,
): Promise<Uint8Array> {
  const out = await createPdf();
  const copied = await out.copyPages(source, [...pages]);
  for (const page of copied) out.addPage(page);

  if (options.keepComments === false || options.keepForms === false) {
    stripAnnotations(out, {
      comments: options.keepComments !== false,
      forms: options.keepForms !== false,
    });
  }
  if (options.keepForms === false) out.catalog.delete(PDFName.of('AcroForm'));

  if (options.keepBookmarks !== false) {
    const landing = new Map<number, number>();
    pages.forEach((page, at) => {
      if (!landing.has(page)) landing.set(page, at);
    });
    // Only the branches that reach into this part, and only with their own ancestry, so a
    // chapter heading arrives above its sections rather than the whole book's tree arriving four
    // times.
    const kept = keepRelevant(outline, landing);
    writeOutlineTree(out, kept);
  } else {
    writeOutlineTree(out, []);
  }
  return await savePdf(out);
}

/** Outline entries that land in this part, reindexed, with ancestors kept as bare headings. */
function keepRelevant(
  outline: ReadonlyArray<ReturnType<typeof readOutline>[number]>,
  landing: ReadonlyMap<number, number>,
): OutlineEntry[] {
  const childrenOf = new Map<number, number[]>();
  outline.forEach((item, i) => {
    if (item.parent === null) return;
    childrenOf.set(item.parent, [...(childrenOf.get(item.parent) ?? []), i]);
  });
  const wanted = new Set<number>();
  const relevant = (i: number): boolean => {
    const item = outline[i];
    if (!item) return false;
    let ok = item.page !== null && landing.has(item.page);
    for (const kid of childrenOf.get(i) ?? []) if (relevant(kid)) ok = true;
    if (ok) wanted.add(i);
    return ok;
  };
  outline.forEach((item, i) => {
    if (item.parent === null) relevant(i);
  });

  const at = new Map<number, number>();
  const out: OutlineEntry[] = [];
  outline.forEach((item, i) => {
    if (!wanted.has(i)) return;
    at.set(i, out.length);
    const parent = item.parent;
    out.push({
      title: item.title,
      page: item.page !== null ? (landing.get(item.page) ?? null) : null,
      parent: parent === null ? null : (at.get(parent) ?? null),
      bold: item.bold,
      italic: item.italic,
      color: item.color,
      open: item.open,
    });
  });
  return out;
}

/** Removes annotations the options say not to keep. Widgets are forms; everything else is markup. */
function stripAnnotations(doc: PDFDocument, keep: { comments: boolean; forms: boolean }): void {
  const ctx = doc.context;
  const annotsKey = PDFName.of('Annots');
  for (const page of doc.getPages()) {
    const annots = page.node.Annots();
    if (!annots) continue;
    const survivors = [];
    for (let i = 0; i < annots.size(); i++) {
      const raw = annots.get(i);
      const dict = ctx.lookupMaybe(raw, PDFDict);
      const subtype = dict ? ctx.lookupMaybe(dict.get(PDFName.of('Subtype')), PDFName) : undefined;
      const isWidget = subtype?.asString() === '/Widget';
      if (isWidget ? keep.forms : keep.comments) survivors.push(raw);
    }
    if (survivors.length === annots.size()) continue;
    if (survivors.length === 0) page.node.delete(annotsKey);
    else page.node.set(annotsKey, ctx.obj(survivors));
  }
}

/**
 * Greedy grouping measured against a byte budget.
 *
 * The estimate that makes it cheap: after the first part is written we know roughly how many
 * bytes a page of this document costs, so the next guess starts at the right length instead of
 * growing one page at a time. Each guess that comes in over budget is shortened in proportion to
 * how far over it was, which converges in two or three writes even for a document whose pages
 * differ wildly.
 */
async function groupsBySize(
  source: PDFDocument,
  options: SplitOptions,
  budget: number,
  warnings: string[],
  ctx: OpContext,
): Promise<Array<{ pages: number[]; title?: string }>> {
  if (!(budget > 0)) throw new OpFailed('The maximum file size must be bigger than nothing');
  const pageCount = source.getPageCount();
  const groups: Array<{ pages: number[] }> = [];
  const outline = readOutline(source);
  let start = 0;
  /** Bytes per page seen so far, used only to pick the first guess. */
  let perPage = 0;

  while (start < pageCount) {
    checkCancelled(ctx.signal);
    const remaining = pageCount - start;
    let take =
      perPage > 0 ? Math.max(1, Math.min(remaining, Math.floor(budget / perPage))) : remaining;
    let bytes: Uint8Array | null = null;
    // At most a handful of attempts: each over-budget guess is cut in proportion, so this
    // converges quickly, and the cap stops a pathological document looping.
    for (let attempt = 0; attempt < 12; attempt++) {
      const pages = Array.from({ length: take }, (_, i) => start + i);
      ctx.progress?.(
        start / pageCount,
        `Measuring pages ${String(start + 1)}–${String(start + take)}`,
      );
      const written = await buildPart(source, pages, options, outline);
      if (written.byteLength <= budget || take === 1) {
        bytes = written;
        break;
      }
      const ratio = budget / written.byteLength;
      const next = Math.max(1, Math.min(take - 1, Math.floor(take * ratio)));
      take = next;
    }
    if (bytes !== null && bytes.byteLength > budget) {
      warnings.push(
        `Page ${String(start + 1)} is ${formatBytes(bytes.byteLength)} on its own, which is over the limit, so it was written anyway`,
      );
    }
    groups.push({ pages: Array.from({ length: take }, (_, i) => start + i) });
    if (bytes !== null && take > 0) perPage = Math.max(1, bytes.byteLength / take);
    start += take;
  }
  return groups;
}

/** Bytes in the words a reader uses. `Intl` handles the decimal separator. */
export function formatBytes(bytes: number): string {
  const units = ['bytes', 'kB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  const places = unit === 0 ? 0 : value < 10 ? 1 : 0;
  return `${new Intl.NumberFormat('en-GB', { maximumFractionDigits: places }).format(value)} ${units[unit] ?? 'bytes'}`;
}

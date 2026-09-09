/**
 * Writing an `/Outlines` tree from a flat list (M41).
 *
 * Combine has to graft one bookmark per source file, with that file's own bookmarks nested
 * underneath, and the shape a reader hands in is naturally flat: an array where each entry names
 * its parent by index. M21's writer does the same job, but from a `PlannedOutlineItem` and a
 * page-ref lookup that only exists inside a write plan, so it cannot be called from here.
 *
 * The tree PDF 12.3.3 asks for: every item has `/Parent`, siblings are a doubly linked list of
 * `/Prev` and `/Next`, a parent carries `/First`, `/Last` and a `/Count` that is positive and
 * counts *visible* descendants when the item is open, negative and counts immediate children
 * when it is closed.
 */

import type { PDFDocument } from 'pdf-lib';
import { PDFHexString, PDFName, PDFNumber, type PDFRef } from 'pdf-lib';

/** The ref at an index that may be absent — the ends of a sibling list, mostly. */
function refAt(refs: ReadonlyArray<PDFRef>, index: number | undefined): PDFRef | undefined {
  return index === undefined ? undefined : refs[index];
}

/** One bookmark to write. `parent` indexes this same array and must come before it. */
export interface OutlineEntry {
  readonly title: string;
  /** 0-based page in the document being written, or `null` for a heading that points nowhere. */
  readonly page: number | null;
  readonly parent: number | null;
  readonly bold?: boolean;
  readonly italic?: boolean;
  /** `0xRRGGBB`, or `null` for the reader's default. */
  readonly color?: number | null;
  /** Whether the item shows its children when the file opens. Default true. */
  readonly open?: boolean;
}

/**
 * Replaces the document's outline with `entries`. An empty list removes `/Outlines` entirely,
 * which is what "do not keep bookmarks" has to mean.
 */
export function writeOutlineTree(doc: PDFDocument, entries: ReadonlyArray<OutlineEntry>): void {
  const ctx = doc.context;
  const key = PDFName.of('Outlines');
  if (entries.length === 0) {
    doc.catalog.delete(key);
    return;
  }

  const pages = doc.getPages();
  const rootRef = ctx.nextRef();
  const refs = entries.map(() => ctx.nextRef());
  const dicts = entries.map(() => ctx.obj({}));

  const childrenOf = new Map<number, number[]>();
  const roots: number[] = [];
  entries.forEach((entry, i) => {
    const parent = entry.parent;
    // A parent that is absent, out of range or later than the child would make a cycle; such an
    // item becomes a top-level bookmark rather than being dropped.
    if (parent === null || parent < 0 || parent >= i) roots.push(i);
    else childrenOf.set(parent, [...(childrenOf.get(parent) ?? []), i]);
  });

  const isOpen = (i: number): boolean => entries[i]?.open !== false;

  /** Children, plus their descendants when the child is open — what `/Count` counts. */
  const visibleCount = (i: number): number => {
    const kids = childrenOf.get(i) ?? [];
    let n = kids.length;
    for (const kid of kids) if (isOpen(kid)) n += visibleCount(kid);
    return n;
  };

  entries.forEach((entry, i) => {
    const dict = dicts[i];
    const ref = refs[i];
    if (!dict || !ref) return;
    dict.set(PDFName.of('Title'), PDFHexString.fromText(entry.title));
    const parent = entry.parent;
    const parentRef =
      parent === null || parent < 0 || parent >= i ? rootRef : (refs[parent] ?? rootRef);
    dict.set(PDFName.of('Parent'), parentRef);

    if (entry.page !== null) {
      const pageRef = pages[entry.page]?.ref;
      // `Fit` rather than `XYZ null null null`: a combined document's bookmark should show the
      // whole page, and no source position survives being copied into a different file anyway.
      if (pageRef) dict.set(PDFName.of('Dest'), ctx.obj([pageRef, 'Fit']));
    }

    const flags = (entry.italic === true ? 1 : 0) | (entry.bold === true ? 2 : 0);
    if (flags !== 0) dict.set(PDFName.of('F'), PDFNumber.of(flags));
    if (entry.color !== null && entry.color !== undefined) {
      dict.set(
        PDFName.of('C'),
        ctx.obj([
          ((entry.color >> 16) & 0xff) / 255,
          ((entry.color >> 8) & 0xff) / 255,
          (entry.color & 0xff) / 255,
        ]),
      );
    }

    const kids = childrenOf.get(i) ?? [];
    if (kids.length > 0) {
      const first = refAt(refs, kids[0]);
      const last = refAt(refs, kids[kids.length - 1]);
      if (first) dict.set(PDFName.of('First'), first);
      if (last) dict.set(PDFName.of('Last'), last);
      dict.set(PDFName.of('Count'), PDFNumber.of(isOpen(i) ? visibleCount(i) : -kids.length));
    }
    ctx.assign(ref, dict);
  });

  const link = (siblings: ReadonlyArray<number>): void => {
    siblings.forEach((index, at) => {
      const dict = dicts[index];
      if (!dict) return;
      const prev = refAt(refs, siblings[at - 1]);
      const next = refAt(refs, siblings[at + 1]);
      if (prev) dict.set(PDFName.of('Prev'), prev);
      if (next) dict.set(PDFName.of('Next'), next);
    });
  };
  link(roots);
  for (const kids of childrenOf.values()) link(kids);

  const rootDict = ctx.obj({});
  rootDict.set(PDFName.of('Type'), PDFName.of('Outlines'));
  const firstRoot = refAt(refs, roots[0]);
  const lastRoot = refAt(refs, roots[roots.length - 1]);
  if (firstRoot) rootDict.set(PDFName.of('First'), firstRoot);
  if (lastRoot) rootDict.set(PDFName.of('Last'), lastRoot);
  rootDict.set(
    PDFName.of('Count'),
    PDFNumber.of(roots.length + roots.reduce((n, i) => n + (isOpen(i) ? visibleCount(i) : 0), 0)),
  );
  ctx.assign(rootRef, rootDict);
  doc.catalog.set(key, rootRef);
}

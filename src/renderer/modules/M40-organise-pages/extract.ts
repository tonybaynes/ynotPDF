/**
 * Building a document out of some other document's pages (M40).
 *
 * One helper does the work for four features, because they are the same operation with different
 * destinations: **Extract** (to a file or a new tab), **Duplicate** (a slice of this document,
 * inserted back into it), **Copy to another document** (a slice, inserted into that one) and
 * **Insert from file** (a slice of the chosen file, so the journal records three pages rather
 * than the five hundred they came out of).
 *
 * It is engine work throughout: `createDocument` (ADR 0015) makes the target, `importPages`
 * copies the pages with their resources and their annotations, and `save` serialises. There is
 * no second PDF implementation here and no pdf-lib — ADR 0010's reasoning applies just as much
 * to copying a page as it does to writing one.
 *
 * Everything takes **engine** page indexes, never model ones. The two are not the same order and
 * the caller converts through `Document.enginePage` before calling in.
 */

import type { AnnotationSubtype, DocHandle, PdfEngine } from '@engine/PdfEngine';
import type { ImportedBookmark } from './commands';

/**
 * The annotation subtypes "with comments" means.
 *
 * Widget and Link are deliberately absent: a form field and a link are part of the page, not a
 * remark about it, and a reader who extracts "without comments" wants their highlights gone, not
 * their form broken. Popup goes because it is the window belonging to a note, and a popup with
 * no parent is an artefact no viewer draws.
 */
export const COMMENT_SUBTYPES: ReadonlySet<AnnotationSubtype> = new Set<AnnotationSubtype>([
  'Text',
  'FreeText',
  'Line',
  'Square',
  'Circle',
  'Polygon',
  'PolyLine',
  'Highlight',
  'Underline',
  'Squiggly',
  'StrikeOut',
  'Stamp',
  'Caret',
  'Ink',
  'Popup',
  'FileAttachment',
]);

export interface SliceOptions {
  /** Keep markup annotations. Default true — PDFium's import brings them anyway. */
  readonly withComments?: boolean;
  /** Called with 0..1 as the slice is built, so a 500-page extract can show progress. */
  readonly onProgress?: (fraction: number) => void;
  readonly signal?: AbortSignal;
}

export class SliceCancelled extends Error {
  constructor() {
    super('The operation was cancelled');
    this.name = 'SliceCancelled';
  }
}

function checkCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new SliceCancelled();
}

/**
 * Awaits a call that may fail, and answers `null` either way.
 *
 * `promise.catch(...)` is not enough: an engine may reject *or* throw synchronously before it
 * ever returns a promise (the in-memory engine validates its arguments first, and so does the
 * PDFium adapter for a bad handle). A `.catch()` never sees the second kind, so a cleanup call
 * in a `finally` could throw and mask the failure that got us there.
 */
async function quietly<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch {
    return null;
  }
}

/**
 * A new document holding just `pages` of `source`, as bytes.
 *
 * The target handle never escapes: it is closed in a `finally`, so a cancelled or failed slice
 * cannot leak a document into the engine's worker.
 */
export async function slicePages(
  engine: PdfEngine,
  source: DocHandle,
  pages: ReadonlyArray<number>,
  options: SliceOptions = {},
): Promise<Uint8Array> {
  if (pages.length === 0) throw new Error('No pages to copy');
  checkCancelled(options.signal);
  const target = await engine.createDocument();
  try {
    await engine.importPages(target, source, pages, 0);
    options.onProgress?.(0.5);
    checkCancelled(options.signal);
    if (options.withComments === false) {
      await stripComments(engine, target, pages.length, options);
    }
    options.onProgress?.(0.9);
    checkCancelled(options.signal);
    const bytes = await engine.save(target);
    options.onProgress?.(1);
    return bytes;
  } finally {
    await quietly(() => engine.close(target));
  }
}

/**
 * Removes the markup annotations from every page of a freshly built document.
 *
 * Highest index first on each page: PDFium closes the gap after a delete, so removing from the
 * front would renumber everything still to come — the same hazard M20 met and the same answer.
 */
async function stripComments(
  engine: PdfEngine,
  doc: DocHandle,
  pageCount: number,
  options: SliceOptions,
): Promise<void> {
  for (let page = 0; page < pageCount; page++) {
    checkCancelled(options.signal);
    const annotations = await engine.annotations(doc, page);
    const doomed = annotations.filter((a) => COMMENT_SUBTYPES.has(a.subtype));
    for (const annotation of [...doomed].reverse()) {
      await quietly(() => engine.deleteAnnotation(doc, annotation.id));
    }
    options.onProgress?.(0.5 + (0.4 * (page + 1)) / Math.max(1, pageCount));
  }
}

/** Displayed sizes of some pages, in the order asked for. */
export async function pageSizesOf(
  engine: PdfEngine,
  doc: DocHandle,
  pages: ReadonlyArray<number>,
): Promise<Array<{ width: number; height: number }>> {
  const out: Array<{ width: number; height: number }> = [];
  for (const page of pages) {
    const size = await quietly(() => engine.pageSize(doc, page));
    out.push(
      size ? { width: size.width, height: size.height } : { width: 595.276, height: 841.89 },
    );
  }
  return out;
}

/**
 * The source document's bookmarks that point into the pages being brought across, flattened into
 * the shape `ImportPagesCommand` grafts.
 *
 * A bookmark whose page is *not* coming is kept only when something under it is — losing a
 * chapter heading because the reader took its second section is worse than keeping a heading
 * with no destination, which is exactly what a heading is anyway. `page: null` says so.
 */
export function bookmarksForPages(
  outline: ReadonlyArray<{
    readonly title: string;
    readonly dest?: { readonly page: number };
    readonly children: ReadonlyArray<unknown>;
    readonly bold?: boolean;
    readonly italic?: boolean;
    readonly color?: number;
  }>,
  pages: ReadonlyArray<number>,
): ImportedBookmark[] {
  /** Where each source page ended up in the imported run; absent means it did not come. */
  const position = new Map<number, number>();
  pages.forEach((page, i) => {
    if (!position.has(page)) position.set(page, i);
  });

  const out: ImportedBookmark[] = [];
  interface Node {
    title: string;
    dest?: { page: number };
    children: ReadonlyArray<unknown>;
    bold?: boolean;
    italic?: boolean;
    color?: number;
  }

  /** Whether this node, or anything under it, aims at a page that is coming across. */
  const relevant = (node: Node): boolean => {
    if (node.dest && position.has(node.dest.page)) return true;
    return (node.children as ReadonlyArray<Node>).some(relevant);
  };

  const walk = (nodes: ReadonlyArray<Node>, parent: number | null): void => {
    for (const node of nodes) {
      if (!relevant(node)) continue;
      const index = out.length;
      const target = node.dest ? position.get(node.dest.page) : undefined;
      out.push({
        title: node.title,
        page: target ?? null,
        parent,
        bold: node.bold ?? false,
        italic: node.italic ?? false,
        color: node.color ?? null,
      });
      walk(node.children as ReadonlyArray<Node>, index);
    }
  };

  walk(outline, null);
  return out;
}

/**
 * Closes a handle and never throws, whichever way the engine reports the failure.
 *
 * Cleanup runs in a `finally`, where a throw would replace the error that brought us there
 * with a much less useful one about a handle.
 */
export async function closeQuietly(engine: PdfEngine, doc: DocHandle): Promise<void> {
  await quietly(() => engine.close(doc));
}

/**
 * Throwing things away (M100).
 *
 * Everything here removes something a document carries that a smaller copy may do without, and
 * every one of them is a decision the reader makes explicitly in the dialog — nothing in this
 * file is on by default in a preset that calls itself lossless, because none of it is lossless in
 * the sense that matters: the pixels are the same and the document is not.
 *
 * Objects are unlinked rather than deleted. Removing an indirect object outright would break
 * anything else that shares it — a form's `/DR` resources and a page's are the same dictionary
 * more often than not — so what happens here is that the *reference* goes, and qpdf's
 * `--remove-unreferenced-resources` sweeps up whatever is then unreachable. That is also what
 * makes the counts honest: this file reports what it unlinked, and the saving is measured on the
 * finished file rather than guessed at here.
 */

import {
  PDFArray,
  PDFDict,
  PDFName,
  PDFStream,
  type PDFContext,
  type PDFDocument,
  type PDFObject,
} from 'pdf-lib';
import { pick } from '../ops/pdfdoc';
import type { DiscardOptions } from './types';

export interface DiscardOutcome {
  /** What was removed, by kind, for the report. Zero entries are left out by the caller. */
  readonly removed: Readonly<Record<string, number>>;
  readonly warnings: ReadonlyArray<string>;
}

export function discard(doc: PDFDocument, options: DiscardOptions): DiscardOutcome {
  const ctx = doc.context;
  const removed: Record<string, number> = {};
  const warnings: string[] = [];
  const count = (key: string, n = 1): void => {
    removed[key] = (removed[key] ?? 0) + n;
  };

  for (const page of doc.getPages()) {
    const leaf = page.node;
    if (options.thumbnails && leaf.get(PDFName.of('Thumb')) !== undefined) {
      leaf.delete(PDFName.of('Thumb'));
      count('thumbnails');
    }
    if (options.privateData && leaf.get(PDFName.of('PieceInfo')) !== undefined) {
      leaf.delete(PDFName.of('PieceInfo'));
      count('privateData');
    }
    filterAnnots(ctx, leaf, options, count);
  }

  if (options.alternateImages) {
    for (const [, object] of ctx.enumerateIndirectObjects()) {
      if (!(object instanceof PDFStream)) continue;
      if (object.dict.get(PDFName.of('Alternates')) === undefined) continue;
      object.dict.delete(PDFName.of('Alternates'));
      count('alternateImages');
    }
  }

  const catalog = doc.catalog;
  if (options.bookmarks && catalog.get(PDFName.of('Outlines')) !== undefined) {
    catalog.delete(PDFName.of('Outlines'));
    // `/PageMode /UseOutlines` on a document with no outlines opens an empty panel.
    if (pick(ctx, catalog.get(PDFName.of('PageMode')), PDFName)?.asString() === '/UseOutlines') {
      catalog.delete(PDFName.of('PageMode'));
    }
    count('bookmarks');
  }

  if (options.forms && catalog.get(PDFName.of('AcroForm')) !== undefined) {
    catalog.delete(PDFName.of('AcroForm'));
    count('forms');
    warnings.push(
      'The form fields were removed. Anything already typed into them is gone with them; what was ' +
        'drawn on the page stays.',
    );
  }

  if (options.metadata) {
    if (catalog.get(PDFName.of('Metadata')) !== undefined) {
      catalog.delete(PDFName.of('Metadata'));
      count('metadata');
    }
    if (ctx.trailerInfo.Info !== undefined) {
      // `exactOptionalPropertyTypes` will not let the property be set to `undefined`, and pdf-lib
      // types it as always present; deleting the key is what "there is no /Info" means anyway.
      delete (ctx.trailerInfo as { Info?: PDFObject }).Info;
      count('metadata');
    }
  }

  if (options.javascript) {
    if (catalog.get(PDFName.of('OpenAction')) !== undefined) {
      const action = pick(ctx, catalog.get(PDFName.of('OpenAction')), PDFDict);
      if (action && pick(ctx, action.get(PDFName.of('S')), PDFName)?.asString() === '/JavaScript') {
        catalog.delete(PDFName.of('OpenAction'));
        count('javascript');
      }
    }
    if (removeFromNames(ctx, catalog, 'JavaScript')) count('javascript');
  }

  if (options.embeddedFiles) {
    if (removeFromNames(ctx, catalog, 'EmbeddedFiles')) count('embeddedFiles');
    if (catalog.get(PDFName.of('Collection')) !== undefined) {
      catalog.delete(PDFName.of('Collection'));
      count('embeddedFiles');
      warnings.push(
        'This was a PDF Portfolio. Removing the attached files leaves the cover sheet and nothing else.',
      );
    }
  }

  if (options.privateData && catalog.get(PDFName.of('PieceInfo')) !== undefined) {
    catalog.delete(PDFName.of('PieceInfo'));
    count('privateData');
  }

  return { removed, warnings };
}

/** Rewrites a page's `/Annots`, keeping only what the options said to keep. */
function filterAnnots(
  ctx: PDFContext,
  leaf: PDFDict,
  options: DiscardOptions,
  count: (key: string, n?: number) => void,
): void {
  if (!options.links && !options.comments && !options.forms && !options.embeddedFiles) return;
  const annots = pick(ctx, leaf.get(PDFName.of('Annots')), PDFArray);
  if (!annots) return;

  const keep: PDFObject[] = [];
  let links = 0;
  let comments = 0;
  let widgets = 0;
  let attachments = 0;

  for (const item of annots.asArray()) {
    const dict = pick(ctx, item, PDFDict);
    const subtype = dict ? pick(ctx, dict.get(PDFName.of('Subtype')), PDFName)?.asString() : null;
    if (subtype === '/Link') {
      if (options.links) links++;
      else keep.push(item);
      continue;
    }
    if (subtype === '/Widget') {
      if (options.forms) widgets++;
      else keep.push(item);
      continue;
    }
    if (subtype === '/FileAttachment' && options.embeddedFiles) {
      attachments++;
      continue;
    }
    // Everything else on a page is a remark of some kind, a Popup included: a Popup is the window
    // a note opens into and is meaningless without the note.
    if (options.comments) {
      comments++;
      continue;
    }
    keep.push(item);
  }

  if (links + comments + widgets + attachments === 0) return;
  if (keep.length === 0) {
    leaf.delete(PDFName.of('Annots'));
  } else {
    const array = PDFArray.withContext(ctx);
    for (const item of keep) array.push(item);
    leaf.set(PDFName.of('Annots'), array);
  }
  if (links > 0) count('links', links);
  if (comments > 0) count('comments', comments);
  if (widgets > 0) count('formWidgets', widgets);
  if (attachments > 0) count('embeddedFiles', attachments);
}

/** Removes one branch of the catalogue's `/Names` tree. True when there was something there. */
function removeFromNames(ctx: PDFContext, catalog: PDFDict, key: string): boolean {
  const names = pick(ctx, catalog.get(PDFName.of('Names')), PDFDict);
  if (names?.get(PDFName.of(key)) === undefined) return false;
  names.delete(PDFName.of(key));
  // An empty `/Names` is legal but pointless, and leaving it invites the next reader to wonder.
  if ([...names.entries()].length === 0) catalog.delete(PDFName.of('Names'));
  return true;
}

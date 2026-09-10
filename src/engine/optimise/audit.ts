/**
 * The space audit (M100): where a PDF's bytes actually went.
 *
 * **Measured, not estimated.** Every indirect object is asked how long it is, and its length is
 * charged to whoever refers to it; an object several categories share is split between them; and
 * whatever is left over — the header, the cross-reference table, the trailer, and every object
 * nothing claimed — is "document structure". The slices therefore add up to the file's own
 * length, which is the one property a space audit has to have. Summing stream `/Length` values,
 * which is the cheap way, misses object headers and the xref entirely and adds up to something
 * smaller than the file, leaving the reader to wonder where the rest went.
 *
 * Two honest imprecisions, both bounded:
 *
 * - **Object streams.** Objects packed into one compressed stream have no individual length in
 *   the file; what is measured is their uncompressed size, which is larger. When the measured
 *   total overshoots the file, every slice is scaled down to fit rather than one being singled
 *   out — the shares stay right even though the absolute numbers are then upper bounds.
 * - **Sharing.** A font used by two pages, or an image used as its own soft mask, is charged
 *   evenly to the categories that reach it. There is no way to do better without deciding which
 *   of two equal owners is the real one.
 */

import {
  PDFArray,
  PDFDict,
  PDFName,
  PDFRef,
  PDFStream,
  type PDFContext,
  type PDFDocument,
  type PDFObject,
} from 'pdf-lib';
import { pick } from '../ops/pdfdoc';
import { AUDIT_ORDER, type AuditCategory, type AuditSlice, type SpaceAudit } from './types';

/** Keys never followed: they point back at a parent, which is not something this object owns. */
const BACK_REFERENCES = new Set(['P', 'Parent', 'Prev', 'ParentTree']);

/**
 * Walks a loaded document and charges every object to a category.
 *
 * `totalBytes` is the file's own length. It is passed in rather than measured because the caller
 * has the bytes and this function has only pdf-lib's view of them, and the two must agree.
 */
export function auditDocument(doc: PDFDocument, totalBytes: number): SpaceAudit {
  const ctx = doc.context;
  const owners = new Map<string, Set<AuditCategory>>();
  // The page tree and the catalogue are structure by definition, and they must not be entered
  // from anywhere else: an annotation's `/P` is excluded above, but a destination array names a
  // page directly and following it would charge the whole page to the bookmarks.
  const blocked = new Set<string>();
  blocked.add(refKey(doc.catalog));
  for (const page of doc.getPages()) blocked.add(page.ref.toString());
  collectPageTree(ctx, doc.catalog, blocked);

  const charge = (value: PDFObject | undefined, category: AuditCategory): void => {
    walk(ctx, value, category, owners, blocked);
  };

  // ---- per page ------------------------------------------------------------------------------
  for (const page of doc.getPages()) {
    const leaf = page.node;
    charge(leaf.get(PDFName.of('Contents')), 'content');
    charge(leaf.get(PDFName.of('Thumb')), 'thumbnails');
    chargeResources(ctx, leaf.getInheritableAttribute(PDFName.of('Resources')), charge, blocked);
    const annots = pick(ctx, leaf.get(PDFName.of('Annots')), PDFArray);
    if (annots) {
      for (const item of annots.asArray()) charge(item, annotationCategory(ctx, item));
    }
  }

  // ---- document level ------------------------------------------------------------------------
  const cat = doc.catalog;
  charge(cat.get(PDFName.of('Outlines')), 'bookmarks');
  charge(cat.get(PDFName.of('Dests')), 'bookmarks');
  charge(cat.get(PDFName.of('Metadata')), 'metadata');
  charge(cat.get(PDFName.of('Collection')), 'attachments');
  const acroForm = cat.get(PDFName.of('AcroForm'));
  charge(acroForm, 'forms');
  const names = pick(ctx, cat.get(PDFName.of('Names')), PDFDict);
  if (names) {
    charge(names.get(PDFName.of('EmbeddedFiles')), 'attachments');
    charge(names.get(PDFName.of('Dests')), 'bookmarks');
  }
  const info = ctx.trailerInfo.Info;
  if (info) charge(info, 'metadata');

  // ---- add it up -----------------------------------------------------------------------------
  const measured = new Map<AuditCategory, { bytes: number; objects: number }>();
  for (const c of AUDIT_ORDER) measured.set(c, { bytes: 0, objects: 0 });
  for (const [ref, object] of ctx.enumerateIndirectObjects()) {
    const key = ref.toString();
    const size = sizeOf(object);
    const claimed = owners.get(key);
    const categories: AuditCategory[] =
      claimed && claimed.size > 0 ? [...claimed] : (['structure'] as AuditCategory[]);
    const share = size / categories.length;
    for (const c of categories) {
      const slot = measured.get(c);
      if (!slot) continue;
      slot.bytes += share;
      slot.objects += 1 / categories.length;
    }
  }

  return finish(measured, totalBytes);
}

/** Turns the measured tallies into slices that add up to `total`. */
function finish(
  measured: Map<AuditCategory, { bytes: number; objects: number }>,
  total: number,
): SpaceAudit {
  const sum = [...measured.values()].reduce((n, v) => n + v.bytes, 0);
  const scale = sum > total && sum > 0 ? total / sum : 1;
  const structure = measured.get('structure');
  // What the objects do not account for is the header, the cross-reference table and the
  // trailer — structure, all of it.
  if (structure && sum < total) structure.bytes += total - sum;

  const slices: AuditSlice[] = AUDIT_ORDER.map((category) => {
    const slot = measured.get(category) ?? { bytes: 0, objects: 0 };
    const bytes = Math.round(slot.bytes * scale);
    return {
      category,
      bytes,
      share: total > 0 ? bytes / total : 0,
      objects: Math.round(slot.objects),
    };
  });
  return { total, slices };
}

/** Which category an annotation belongs to. Links are navigation; widgets are the form. */
function annotationCategory(ctx: PDFContext, value: PDFObject | undefined): AuditCategory {
  const dict = pick(ctx, value, PDFDict);
  const subtype = dict ? pick(ctx, dict.get(PDFName.of('Subtype')), PDFName)?.asString() : null;
  if (subtype === '/Link') return 'bookmarks';
  if (subtype === '/Widget') return 'forms';
  if (subtype === '/FileAttachment') return 'attachments';
  return 'comments';
}

/**
 * A resources dictionary is shared ground: the dictionary itself is structure, and what it names
 * belongs to whichever category the entry is. So it is taken apart by key rather than walked.
 */
function chargeResources(
  ctx: PDFContext,
  value: PDFObject | undefined,
  charge: (value: PDFObject | undefined, category: AuditCategory) => void,
  blocked: Set<string>,
): void {
  const resources = pick(ctx, value, PDFDict);
  if (!resources) return;
  charge(resources.get(PDFName.of('Font')), 'fonts');
  charge(resources.get(PDFName.of('Pattern')), 'content');
  charge(resources.get(PDFName.of('Shading')), 'content');
  const xobjects = pick(ctx, resources.get(PDFName.of('XObject')), PDFDict);
  if (!xobjects) return;
  for (const [, entry] of xobjects.entries()) {
    const stream = pick(ctx, entry, PDFStream);
    const subtype = stream
      ? pick(ctx, stream.dict.get(PDFName.of('Subtype')), PDFName)?.asString()
      : null;
    if (subtype === '/Image') {
      charge(entry, 'images');
      continue;
    }
    // A form XObject is page content; what it *draws with* is charged the same way a page's own
    // resources are, so a font used only inside a stamp still counts as a font.
    charge(entry, 'content');
    if (stream) chargeResources(ctx, stream.dict.get(PDFName.of('Resources')), charge, blocked);
  }
}

/** Marks `value` and everything under it as belonging to `category`. */
function walk(
  ctx: PDFContext,
  value: PDFObject | undefined,
  category: AuditCategory,
  owners: Map<string, Set<AuditCategory>>,
  blocked: Set<string>,
): void {
  if (value === undefined) return;
  const stack: PDFObject[] = [value];
  const seen = new Set<string>();
  let steps = 0;
  // A damaged file can contain a cycle pdf-lib will happily follow for ever. `seen` stops the
  // ordinary ones; the step budget stops the pathological ones without an opinion about why.
  const budget = 200_000;

  while (stack.length > 0 && steps++ < budget) {
    const current = stack.pop();
    if (current === undefined) continue;

    if (current instanceof PDFRef) {
      const key = current.toString();
      if (blocked.has(key) || seen.has(key)) continue;
      seen.add(key);
      let set = owners.get(key);
      if (!set) {
        set = new Set();
        owners.set(key, set);
      }
      set.add(category);
      // `lookup` rather than `lookupMaybe(_, PDFDict)`: an indirect object is as likely to be a
      // stream or an array as a dictionary, and pdf-lib's typed lookup throws on the others.
      const resolved: PDFObject | undefined = ctx.lookup(current);
      if (resolved) stack.push(resolved);
      continue;
    }

    if (current instanceof PDFStream) {
      stack.push(current.dict);
      continue;
    }
    if (current instanceof PDFArray) {
      for (const item of current.asArray()) stack.push(item);
      continue;
    }
    if (current instanceof PDFDict) {
      for (const [key, entry] of current.entries()) {
        if (BACK_REFERENCES.has(key.asString().slice(1))) continue;
        stack.push(entry);
      }
    }
  }
}

/** Every node of the page tree, so nothing can charge a page to itself through a destination. */
function collectPageTree(ctx: PDFContext, catalog: PDFDict, blocked: Set<string>): void {
  const root = catalog.get(PDFName.of('Pages'));
  const stack: PDFObject[] = root === undefined ? [] : [root];
  let steps = 0;
  while (stack.length > 0 && steps++ < 100_000) {
    const current = stack.pop();
    if (current === undefined) continue;
    if (current instanceof PDFRef) {
      const key = current.toString();
      if (blocked.has(key)) continue;
      blocked.add(key);
      const resolved = ctx.lookupMaybe(current, PDFDict);
      if (resolved) stack.push(resolved);
      continue;
    }
    if (current instanceof PDFDict) {
      const kids = current.get(PDFName.of('Kids'));
      if (kids instanceof PDFArray) for (const kid of kids.asArray()) stack.push(kid);
      else if (kids instanceof PDFRef) stack.push(kids);
    }
  }
}

/** How long this object is when written out. Never throws: an odd object counts as nothing. */
function sizeOf(object: PDFObject): number {
  try {
    // The object header (`12 0 obj\n`) and footer (`\nendobj\n`) are part of what the object
    // costs the file, and pdf-lib's `sizeInBytes` does not include them.
    return object.sizeInBytes() + 20;
  } catch {
    return 0;
  }
}

function refKey(dict: PDFDict): string {
  for (const [ref, object] of dict.context.enumerateIndirectObjects()) {
    if (object === dict) return ref.toString();
  }
  return '';
}

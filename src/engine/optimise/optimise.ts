/**
 * The optimise pipeline (M100): the order the four in-process passes run in, and the report they
 * add up to.
 *
 * **Order, and why.**
 *
 * 1. **Discard** first, so that nothing after it spends time on an image inside a comment that is
 *    about to go, or subsets a font only the form fields used.
 * 2. **Images**, because that is where the bytes are, and because recompressing before the next
 *    step is what makes the next step work.
 * 3. **Fonts**, which need the content streams intact — so after discard, and before anything
 *    starts merging objects underneath them.
 * 4. **Duplicates** last of the four, *after* recompression: two copies of one photograph that
 *    arrived in different encodings are not duplicates until both have been re-encoded the same
 *    way, and then they are byte-identical.
 *
 * The structural pass — object streams, flate recompression, unreferenced objects, linearisation —
 * is qpdf's and happens outside this file, because qpdf lives in the main process (ADR 0011). The
 * caller supplies it as {@link OptimiseHooks.structure}; without one, the four passes above still
 * run and the file is simply not repacked.
 */

import { loadPdf, savePdf } from '../ops/pdfdoc';
import { discard } from './discard';
import { dedupe } from './dedupe';
import { optimiseFonts } from './fonts/pipeline';
import { optimiseImages } from './images/pipeline';
import { auditDocument } from './audit';
import {
  checkCancelled,
  type BytesAndWarnings,
  type OptimiseChange,
  type OptimiseContext,
  type OptimiseOptions,
  type OptimiseResult,
  type SpaceAudit,
  type StructureOptions,
} from './types';

export interface OptimiseHooks {
  /**
   * The qpdf pass. Given the document as the in-process passes left it, returns it repacked.
   *
   * Optional so that everything above can be tested — and used by M120 and M121 — without a qpdf
   * anywhere near it. When it is absent the result simply says so through its size.
   */
  readonly structure?: (
    bytes: Uint8Array,
    options: StructureOptions,
  ) => Promise<BytesAndWarnings> | BytesAndWarnings;
}

/**
 * Optimises a document. Bytes in, bytes out, plus a report of what was done.
 *
 * Never throws for a file it merely could not improve: an image in a codec we cannot read, a font
 * we dare not cut and a preset that asks for nothing all produce a result whose `after` happens to
 * equal its `before`. It throws only when the document could not be *read*, which is the one thing
 * the caller has to be told about rather than shown.
 */
export async function optimise(
  bytes: Uint8Array,
  options: OptimiseOptions,
  hooks: OptimiseHooks = {},
  ctx: OptimiseContext = {},
): Promise<OptimiseResult> {
  const before = bytes.length;
  ctx.progress?.(0, 'Reading the document');
  const doc = await loadPdf(bytes, 'This document');
  checkCancelled(ctx.signal);

  const changes: OptimiseChange[] = [];
  const warnings: string[] = [];

  // 1 — discard
  ctx.progress?.(0.1, 'Removing what was not wanted');
  const discarded = discard(doc, options.discard);
  warnings.push(...discarded.warnings);
  for (const [key, count] of Object.entries(discarded.removed)) {
    if (count > 0) changes.push({ what: discardWording(key, count), count, saved: 0 });
  }
  checkCancelled(ctx.signal);

  // 2 — images
  ctx.progress?.(0.2, 'Optimising images');
  const images = await optimiseImages(doc, options.images, ctx);
  warnings.push(...images.warnings);
  if (images.downsampled > 0) {
    changes.push({
      what: plural(images.downsampled, 'image was', 'images were') + ' made smaller',
      count: images.downsampled,
      saved: 0,
    });
  }
  if (images.recompressed > 0) {
    changes.push({
      what: plural(images.recompressed, 'image was', 'images were') + ' re-compressed',
      count: images.recompressed,
      saved: 0,
    });
  }

  // 3 — fonts
  ctx.progress?.(0.55, 'Optimising fonts');
  const fonts = await optimiseFonts(doc, options.fonts, ctx);
  warnings.push(...fonts.warnings);
  if (fonts.subsetted > 0) {
    changes.push({
      what: plural(fonts.subsetted, 'font was', 'fonts were') + ' cut down to the letters in use',
      count: fonts.subsetted,
      saved: fonts.saved,
    });
  }
  if (fonts.unembedded > 0) {
    changes.push({
      what: plural(fonts.unembedded, 'font is', 'fonts are') + ' no longer embedded',
      count: fonts.unembedded,
      saved: 0,
    });
  }

  // 4 — duplicates
  ctx.progress?.(0.7, 'Merging duplicates');
  const merged = dedupe(doc, options.dedupe);
  const duplicates = merged.images + merged.fonts + merged.xobjects;
  if (duplicates > 0) {
    changes.push({
      what: plural(duplicates, 'duplicate was', 'duplicates were') + ' merged',
      count: duplicates,
      saved: merged.saved,
    });
  }
  checkCancelled(ctx.signal);

  // 5 — qpdf
  ctx.progress?.(0.8, 'Repacking the file');
  let out = await savePdf(doc);
  let linearised = false;
  if (hooks.structure) {
    const packed = await hooks.structure(out, options.structure);
    out = packed.bytes;
    warnings.push(...packed.warnings);
    linearised = options.structure.linearise;
    if (options.structure.objectStreams || options.structure.recompressStreams) {
      changes.push({ what: 'The file was repacked', count: 1, saved: 0 });
    }
  }

  ctx.progress?.(1, 'Finished');
  return {
    bytes: out,
    before,
    after: out.length,
    changes: attributeSaving(changes, before, out.length),
    warnings: [...new Set(warnings)],
    linearised,
  };
}

/**
 * The space audit of a document, without changing anything.
 *
 * A separate entry point rather than a by-product of {@link optimise}, because the dialog shows
 * the audit of the file **as it is** and the reader has not chosen any options yet.
 */
export async function auditBytes(bytes: Uint8Array): Promise<SpaceAudit> {
  const doc = await loadPdf(bytes, 'This document');
  return auditDocument(doc, bytes.length);
}

/**
 * Shares the *actual* saving out across the changes that claimed one.
 *
 * Each pass can say how many bytes it freed from the objects it rewrote, but what the file
 * eventually loses is decided by qpdf's repacking on top of that, and the two are never equal. So
 * the per-change figures are scaled to add up to the saving the file really made — which is the
 * number the reader can check by looking at the two files. A change that claimed nothing (a
 * discard, whose saving only appears once the unreferenced objects are swept) stays at nothing
 * rather than being credited with someone else's bytes.
 */
function attributeSaving(
  changes: ReadonlyArray<OptimiseChange>,
  before: number,
  after: number,
): OptimiseChange[] {
  const total = Math.max(0, before - after);
  const claimed = changes.reduce((n, c) => n + c.saved, 0);
  if (claimed === 0 || total === 0) return [...changes];
  const scale = total / claimed;
  return changes.map((c) => ({ ...c, saved: Math.round(c.saved * scale) }));
}

function plural(n: number, one: string, many: string): string {
  return `${String(n)} ${n === 1 ? one : many}`;
}

/** The words for one kind of discarded thing. Keyed by what `discard.ts` counted. */
function discardWording(key: string, count: number): string {
  switch (key) {
    case 'thumbnails':
      return `${plural(count, 'page thumbnail was', 'page thumbnails were')} removed`;
    case 'alternateImages':
      return `${plural(count, 'alternative image was', 'alternative images were')} removed`;
    case 'metadata':
      return 'The document information was removed';
    case 'bookmarks':
      return 'The bookmarks were removed';
    case 'links':
      return `${plural(count, 'link was', 'links were')} removed`;
    case 'comments':
      return `${plural(count, 'comment was', 'comments were')} removed`;
    case 'forms':
      return 'The form was removed';
    case 'formWidgets':
      return `${plural(count, 'form field was', 'form fields were')} removed`;
    case 'embeddedFiles':
      return `${plural(count, 'attached file was', 'attached files were')} removed`;
    case 'javascript':
      return 'The document JavaScript was removed';
    case 'privateData':
      return `${plural(count, 'block of private application data was', 'blocks of private application data were')} removed`;
    default:
      return `${plural(count, 'item was', 'items were')} removed`;
  }
}

/**
 * Folds a qpdf pass that happened *after* {@link optimise} into its report.
 *
 * The app cannot use {@link OptimiseHooks.structure}: the in-process passes run in a renderer
 * Worker, and qpdf runs in the main process, which a Worker cannot reach. So the Worker optimises
 * without a hook and the renderer does the qpdf pass afterwards — and this is what makes the two
 * arrangements produce the same report rather than two that differ in small ways nobody would
 * notice until they disagreed.
 */
export function withStructure(
  result: OptimiseResult,
  packed: BytesAndWarnings,
  options: StructureOptions,
): OptimiseResult {
  const changes = [...result.changes];
  if (options.objectStreams || options.recompressStreams) {
    changes.push({ what: 'The file was repacked', count: 1, saved: 0 });
  }
  return {
    bytes: packed.bytes,
    before: result.before,
    after: packed.bytes.length,
    changes: attributeSaving(changes, result.before, packed.bytes.length),
    warnings: [...new Set([...result.warnings, ...packed.warnings])],
    linearised: options.linearise,
  };
}

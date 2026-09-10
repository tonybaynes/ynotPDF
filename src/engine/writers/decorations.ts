/**
 * Page decorations in the writer (M53, ADR 0020 §3).
 *
 * A decoration is never written into a stream that already exists. `/Contents` is an array, so
 * the applier appends a new element beside the page's own bytes and leaves them alone — which is
 * what "never bake into existing streams" means when it is taken literally.
 *
 * Three steps, in this order, and the order is the whole design:
 *
 * 1. **restore** the page's original content and `/Resources`, when the plan carries them and the
 *    page-object applier (M50) has not already put them back. That undoes PDFium's regeneration
 *    of a page it drew a decoration on;
 * 2. **strip** every `/YNOTDec … BDC … EMC` span the page carries, whoever wrote it, and drop any
 *    `/Contents` element that is one of ours. This is what makes the order of M50's edits and
 *    M53's decorations irrelevant: a baked copy is removed before a fresh one is written;
 * 3. **append** one new stream holding the planned decorations, each in its marked-content
 *    sequence, preceded by a `q` and followed by the `Q`s the streams before it left owing.
 */

import {
  PDFArray,
  PDFDict,
  PDFName,
  PDFNumber,
  PDFObjectParser,
  PDFPageLeaf,
  PDFRawStream,
  PDFRef,
  PDFStream,
  decodePDFRawStream,
  type PDFContext,
  type PDFDocument,
  type PDFObject,
} from 'pdf-lib';
import type { PdfMatrix } from '@shared/pdf';
import { num } from '../appearance/content';
import { parse, scanObjects, serialise } from '../content';
import type { ContentOp } from '../content/parser';
import { DECORATION_MARK, MARK_ID, MARK_KIND, MARK_SPEC } from '../decorations/types';
import type { PlannedDecoration, PlannedDecorations } from '../Writer';
import {
  formXObject,
  fromBase64,
  type EmbeddedXObjects,
} from './resources';

export interface DecorationWriteContext {
  warn(message: string): void;
}

/** Our own marker on a `/Contents` element, so a re-save finds the stream it wrote last time. */
const CONTENTS_MARKER = 'YNOTDecoration';

/** The page's own `/Resources`, cloned from an inherited one so nothing else is touched. */
function ownResources(doc: PDFDocument, leaf: PDFPageLeaf): PDFDict {
  const ctx = doc.context;
  const own = leaf.get(PDFName.of('Resources'));
  const resolved = own instanceof PDFRef ? ctx.lookup(own) : own;
  if (resolved instanceof PDFDict && !(own instanceof PDFRef)) return resolved;
  const inherited = leaf.Resources();
  const fresh = ctx.obj({});
  if (inherited) for (const [k, v] of inherited.entries()) fresh.set(k, v);
  leaf.set(PDFName.of('Resources'), fresh);
  return fresh;
}

/** Registers `ref` under a fresh `/XObject` name on the page and returns that name. */
function addXObject(doc: PDFDocument, leaf: PDFPageLeaf, ref: PDFRef): string {
  const ctx = doc.context;
  const resources = ownResources(doc, leaf);
  const existing = resources.get(PDFName.of('XObject'));
  const resolved = existing instanceof PDFRef ? ctx.lookup(existing) : existing;
  let dict: PDFDict;
  if (resolved instanceof PDFDict) {
    dict = resolved;
  } else {
    dict = ctx.obj({});
    resources.set(PDFName.of('XObject'), dict);
  }
  let n = 1;
  while (dict.has(PDFName.of(`YnDec${n}`))) n++;
  const name = `YnDec${n}`;
  dict.set(PDFName.of(name), ref);
  return name;
}

/** Every `/Contents` element of a page, as refs or streams, in order. */
function contentElements(ctx: PDFContext, leaf: PDFPageLeaf): PDFObject[] {
  const contents = leaf.get(PDFName.of('Contents'));
  const resolved = contents instanceof PDFRef ? ctx.lookup(contents) : contents;
  if (resolved instanceof PDFArray) return [...resolved.asArray()];
  return contents === undefined ? [] : [contents];
}

/** Whether this `/Contents` element is a decoration stream this application wrote. */
function isOurContentStream(ctx: PDFContext, element: PDFObject): boolean {
  const stream = element instanceof PDFRef ? ctx.lookup(element) : element;
  return stream instanceof PDFStream && stream.dict.has(PDFName.of(CONTENTS_MARKER));
}

function decodeStream(stream: PDFStream): Uint8Array | null {
  try {
    if (stream instanceof PDFRawStream) return decodePDFRawStream(stream).decode();
    return stream.getContents();
  } catch {
    return null;
  }
}

/**
 * Removes every `/YNOTDec … BDC … EMC` span from a content stream.
 *
 * Marked content nests, so the matching `EMC` is found by counting the `BDC`/`BMC` opened inside
 * — the naive "next EMC" would cut a sequence in half if a decoration ever wrapped one. Returns
 * null when nothing was ours, so an untouched stream is left exactly as it is rather than
 * re-serialised.
 */
export function stripDecorations(source: Uint8Array): Uint8Array | null {
  const stream = parse(source);
  const ops = stream.ops;
  const keep: ContentOp[] = [];
  let removed = 0;
  let i = 0;
  while (i < ops.length) {
    const op = ops[i];
    if (op === undefined) break;
    if (op.operator === 'BDC' && markTag(op) === DECORATION_MARK) {
      let depth = 1;
      let j = i + 1;
      while (j < ops.length && depth > 0) {
        const inner = ops[j]?.operator;
        if (inner === 'BDC' || inner === 'BMC') depth++;
        else if (inner === 'EMC') depth--;
        j++;
      }
      // An unterminated sequence would swallow the rest of the page; leave it alone and say so
      // by keeping the ops, which at worst means one duplicate decoration rather than a page
      // with no content.
      if (depth !== 0) {
        keep.push(op);
        i++;
        continue;
      }
      removed++;
      i = j;
      continue;
    }
    keep.push(op);
    i++;
  }
  if (removed === 0) return null;
  return serialise(stream, keep);
}

/** The tag name of a `BDC`/`BMC` op, or null. */
function markTag(op: ContentOp): string | null {
  const first = op.operands[0];
  return first && first.kind === 'name' ? first.value : null;
}

/**
 * How many `q`s a set of content streams leaves open, so the decoration stream can start from
 * the page's own frame however unbalanced the producer was.
 */
function openDepth(streams: ReadonlyArray<Uint8Array>): number {
  let depth = 0;
  for (const bytes of streams) {
    const parsed = parse(bytes);
    depth += scanObjects(parsed.ops).openDepth;
  }
  return Math.max(0, Math.min(64, depth));
}

/** `PDFRawStream` we can write with our own marker key on it. */
function markedStream(ctx: PDFContext, content: string): PDFRef {
  const stream = ctx.flateStream(content);
  stream.dict.set(PDFName.of(CONTENTS_MARKER), PDFNumber.of(1));
  return ctx.register(stream);
}

function matrixOps(m: PdfMatrix): string {
  return `${num(m[0])} ${num(m[1])} ${num(m[2])} ${num(m[3])} ${num(m[4])} ${num(m[5])} cm`;
}

/** A PDF literal string with the three characters that need escaping escaped. */
function literal(value: string): string {
  return `(${value.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')})`;
}

/**
 * The marked-content sequence one decoration is drawn inside.
 *
 * The tag is `/YNOTDec` and its properties are written inline, so nothing has to be added to the
 * page's `/Properties` dictionary and PDFium reads them straight back as the object's mark.
 */
function decorationOps(item: PlannedDecoration, name: string): string {
  const params = [
    `/${MARK_ID} ${literal(item.id)}`,
    `/${MARK_KIND} ${literal(item.kind)}`,
    `/${MARK_SPEC} ${literal(item.spec)}`,
  ].join(' ');
  return [
    `/${DECORATION_MARK} <<${params}>> BDC`,
    'q',
    matrixOps(item.matrix),
    `/${name} Do`,
    'Q',
    'EMC',
  ].join('\n');
}

/**
 * Applies the planned decorations to one page. Returns whether anything was written.
 *
 * `objectsApplied` says the page-object applier has already put the original content back, so
 * this one must not do it a second time — it would throw away M50's replayed edits.
 */
export async function writePageDecorations(
  doc: PDFDocument,
  pageRef: PDFRef,
  planned: PlannedDecorations,
  pageNumber: number,
  options: {
    readonly objectsApplied: boolean;
    readonly xobjects: EmbeddedXObjects;
    readonly context: DecorationWriteContext;
  },
): Promise<boolean> {
  const ctx = doc.context;
  const leaf = ctx.lookup(pageRef);
  if (!(leaf instanceof PDFPageLeaf)) {
    options.context.warn(`Page ${String(pageNumber)}: not a page, so its decorations were left off`);
    return false;
  }

  if (!options.objectsApplied && planned.original) {
    restoreOriginal(doc, leaf, planned.original, pageNumber, options.context);
  }

  // Step 2: drop the `/Contents` elements we wrote last time, and strip any span baked into the
  // ones we did not.
  const kept: PDFObject[] = [];
  const bodies: Uint8Array[] = [];
  let changed = false;
  for (const element of contentElements(ctx, leaf)) {
    if (isOurContentStream(ctx, element)) {
      changed = true;
      continue;
    }
    const stream = element instanceof PDFRef ? ctx.lookup(element) : element;
    if (!(stream instanceof PDFStream)) continue;
    const decoded = decodeStream(stream);
    if (decoded === null) {
      kept.push(element);
      continue;
    }
    const stripped = stripDecorations(decoded);
    if (stripped) {
      changed = true;
      bodies.push(stripped);
      kept.push(ctx.register(ctx.flateStream(stripped)));
    } else {
      bodies.push(decoded);
      kept.push(element);
    }
  }

  // Step 3: the guard and the decoration stream.
  const items = planned.items;
  const scale = planned.shrink;
  const shrinks = typeof scale === 'number' && scale > 0 && scale < 1;
  const elements: PDFObject[] = [];
  if (shrinks) {
    const box = leaf.CropBox() ?? leaf.MediaBox();
    const rect = boxNumbers(ctx, box);
    const m = shrinkFor(rect, scale ?? 1);
    elements.push(markedStream(ctx, `q\n${matrixOps(m)}`));
    changed = true;
  } else if (items.length > 0) {
    elements.push(markedStream(ctx, 'q'));
  }
  elements.push(...kept);
  if (items.length > 0 || shrinks) {
    const closing = 'Q'.repeat(openDepth(bodies) + 1);
    const drawn: string[] = [closing];
    for (const item of items) {
      let ref: PDFRef;
      try {
        ref = formXObject(ctx, {
          content: item.content,
          bbox: item.bbox,
          resources: item.resources,
          xobjects: options.xobjects,
        });
      } catch (error) {
        options.context.warn(
          `Page ${String(pageNumber)}: a decoration could not be written (${
            error instanceof Error ? error.message : String(error)
          })`,
        );
        continue;
      }
      drawn.push(decorationOps(item, addXObject(doc, leaf, ref)));
    }
    elements.push(markedStream(ctx, drawn.join('\n')));
    changed = true;
  }

  if (!changed) return false;
  const array = ctx.obj([]);
  for (const e of elements) array.push(e);
  leaf.set(PDFName.of('Contents'), ctx.register(array));
  return true;
}

/** The four numbers of a page box, defaulting to US Letter when the file has none. */
function boxNumbers(
  ctx: PDFContext,
  box: PDFArray | undefined,
): readonly [number, number, number, number] {
  const values = (box?.asArray() ?? []).map((v) => {
    const resolved = v instanceof PDFRef ? ctx.lookup(v) : v;
    return resolved instanceof PDFNumber ? resolved.asNumber() : 0;
  });
  if (values.length < 4) return [0, 0, 612, 792];
  const [a = 0, b = 0, c = 0, d = 0] = values;
  return [Math.min(a, c), Math.min(b, d), Math.max(a, c), Math.max(b, d)];
}

/** The centred shrink matrix for a page box. */
function shrinkFor(box: readonly [number, number, number, number], fraction: number): PdfMatrix {
  const cx = (box[0] + box[2]) / 2;
  const cy = (box[1] + box[3]) / 2;
  return [fraction, 0, 0, fraction, cx - fraction * cx, cy - fraction * cy];
}

/**
 * Puts the page's content and `/Resources` back as they were before the first decoration.
 *
 * A reference in the restored resources that no longer resolves means the file was rewritten
 * underneath us; the page is left as the engine wrote it, with a warning, rather than pointed at
 * objects that are not there.
 */
function restoreOriginal(
  doc: PDFDocument,
  leaf: PDFPageLeaf,
  original: { readonly content: string; readonly resources: string },
  pageNumber: number,
  context: DecorationWriteContext,
): void {
  const ctx = doc.context;
  if (original.resources !== '') {
    const parsed = parseResources(doc, original.resources);
    if (parsed === null) {
      context.warn(
        `Page ${String(pageNumber)}: its original resources no longer resolve, so the page was left as the engine wrote it`,
      );
      return;
    }
    leaf.set(PDFName.of('Resources'), parsed);
  }
  const bytes = fromBase64(original.content);
  leaf.set(PDFName.of('Contents'), ctx.register(ctx.flateStream(bytes)));
}

function parseResources(doc: PDFDocument, serialised: string): PDFDict | null {
  let parsed: PDFObject;
  try {
    parsed = PDFObjectParser.forBytes(
      new TextEncoder().encode(serialised),
      doc.context,
    ).parseObject();
  } catch {
    return null;
  }
  if (!(parsed instanceof PDFDict)) return null;
  for (const ref of refsIn(parsed)) {
    if (doc.context.lookup(ref) === undefined) return null;
  }
  return parsed;
}

/** Every indirect reference inside an object, for checking they still resolve. */
function refsIn(value: PDFObject, into: PDFRef[] = []): PDFRef[] {
  if (value instanceof PDFRef) into.push(value);
  else if (value instanceof PDFDict) for (const [, v] of value.entries()) refsIn(v, into);
  else if (value instanceof PDFArray) for (const v of value.asArray()) refsIn(v, into);
  return into;
}

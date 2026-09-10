/**
 * Which character codes each font is actually asked to draw (M100).
 *
 * Every content stream in the document is walked with M50's parser: `Tf` says which font is
 * current, and `Tj`, `TJ`, `'` and `"` carry the bytes it is asked to show. A simple font's codes
 * are one byte each; a composite font's are as many as its CMap says, which for `Identity-H` —
 * and for every other CMap a PDF writer emits in practice — is two.
 *
 * The streams walked are the pages', the form XObjects' they draw, and the annotation appearance
 * streams. Between them that is everything that puts a glyph on paper. Anything missed here shows
 * up as a glyph that gets subsetted out and comes back blank, so the rule when in doubt is to
 * keep: an unparseable stream marks its fonts as **used in full**, not as unused.
 */

import {
  PDFArray,
  PDFDict,
  PDFName,
  PDFRawStream,
  PDFRef,
  PDFStream,
  decodePDFRawStream,
} from 'pdf-lib';
import type { PDFContext, PDFDocument } from 'pdf-lib';
import { parse, type ContentOp } from '../../content/parser';
import { isShowTextOperator } from '../../content/objects';
import { pageContentOf } from '../../content/pdf';
import { pick } from '../../ops/pdfdoc';

export interface FontUsage {
  /** Character codes the document shows with this font, as they appear in the strings. */
  readonly codes: Set<number>;
  /** True when something could not be read, so nothing may be removed from this font. */
  keepEverything: boolean;
}

export type UsageMap = ReadonlyMap<string, FontUsage>;

/** Codes used per font, keyed by the font dictionary's `PDFRef.toString()`. */
export function collectFontUsage(doc: PDFDocument): UsageMap {
  const out = new Map<string, FontUsage>();
  const usageOf = (key: string): FontUsage => {
    let entry = out.get(key);
    if (!entry) {
      entry = { codes: new Set<number>(), keepEverything: false };
      out.set(key, entry);
    }
    return entry;
  };

  for (const page of doc.getPages()) {
    const resources = pick(
      doc.context,
      page.node.getInheritableAttribute(PDFName.of('Resources')),
      PDFDict,
    );
    let content: Uint8Array | null;
    try {
      content = pageContentOf(doc, page);
    } catch {
      content = null;
    }
    if (content === null) {
      markAll(doc.context, resources, usageOf);
      continue;
    }
    walk(doc, content, resources, usageOf, new Set(), 0);

    // Annotation appearances draw with their own resources and their own text.
    const annots = pick(doc.context, page.node.get(PDFName.of('Annots')), PDFArray);
    if (annots) {
      for (const item of annots.asArray()) {
        const annot = pick(doc.context, item, PDFDict);
        if (annot) walkAppearance(doc, annot, usageOf);
      }
    }
  }
  return out;
}

/** The appearance streams under an annotation's `/AP`, however deeply the states are nested. */
function walkAppearance(
  doc: PDFDocument,
  annot: PDFDict,
  usageOf: (key: string) => FontUsage,
): void {
  const ap = pick(doc.context, annot.get(PDFName.of('AP')), PDFDict);
  if (!ap) return;
  const streams: PDFStream[] = [];
  for (const [, entry] of ap.entries()) {
    const stream = pick(doc.context, entry, PDFStream);
    if (stream) {
      streams.push(stream);
      continue;
    }
    const states = pick(doc.context, entry, PDFDict);
    if (!states) continue;
    for (const [, state] of states.entries()) {
      const inner = pick(doc.context, state, PDFStream);
      if (inner) streams.push(inner);
    }
  }
  for (const stream of streams) {
    const content = contentsOf(stream);
    const resources = pick(doc.context, stream.dict.get(PDFName.of('Resources')), PDFDict);
    if (content) walk(doc, content, resources, usageOf, new Set(), 0);
    else markAll(doc.context, resources, usageOf);
  }
}

function walk(
  doc: PDFDocument,
  content: Uint8Array,
  resources: PDFDict | null,
  usageOf: (key: string) => FontUsage,
  visiting: Set<string>,
  depth: number,
): void {
  if (depth > 10) return;
  const fonts = resources ? pick(doc.context, resources.get(PDFName.of('Font')), PDFDict) : null;
  const xobjects = resources
    ? pick(doc.context, resources.get(PDFName.of('XObject')), PDFDict)
    : null;

  let ops: ReadonlyArray<ContentOp>;
  try {
    ops = parse(content).ops;
  } catch {
    markAll(doc.context, resources, usageOf);
    return;
  }

  let current: { usage: FontUsage; bytes: 1 | 2 } | null = null;
  for (const op of ops) {
    if (op.operator === 'Tf') {
      const name = op.operands[0];
      current = null;
      if (name?.kind === 'name' && fonts) {
        const entry = fonts.get(PDFName.of(name.value));
        if (entry instanceof PDFRef) {
          const dict = pick(doc.context, entry, PDFDict);
          current = {
            usage: usageOf(entry.toString()),
            bytes: dict && isComposite(doc.context, dict) ? 2 : 1,
          };
        }
      }
      continue;
    }

    if (op.operator === 'Do') {
      const name = op.operands[0];
      if (name?.kind !== 'name' || !xobjects) continue;
      const entry = xobjects.get(PDFName.of(name.value));
      const stream = pick(doc.context, entry, PDFStream);
      if (!stream) continue;
      if (
        pick(doc.context, stream.dict.get(PDFName.of('Subtype')), PDFName)?.asString() !== '/Form'
      )
        continue;
      const key = entry instanceof PDFRef ? entry.toString() : `${name.value}@${String(depth)}`;
      if (visiting.has(key)) continue;
      visiting.add(key);
      const inner = contentsOf(stream);
      const innerResources =
        pick(doc.context, stream.dict.get(PDFName.of('Resources')), PDFDict) ?? resources;
      if (inner) walk(doc, inner, innerResources, usageOf, visiting, depth + 1);
      else markAll(doc.context, innerResources, usageOf);
      visiting.delete(key);
      continue;
    }

    if (!isShowTextOperator(op.operator) || !current) continue;
    for (const operand of op.operands) {
      if (operand.kind === 'string') addCodes(current.usage.codes, operand.value, current.bytes);
      else if (operand.kind === 'array') {
        for (const item of operand.items) {
          if (item.kind === 'string') addCodes(current.usage.codes, item.value, current.bytes);
        }
      }
    }
  }
}

function addCodes(codes: Set<number>, bytes: Uint8Array, width: 1 | 2): void {
  if (width === 1) {
    for (const b of bytes) codes.add(b);
    return;
  }
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    codes.add(((bytes[i] ?? 0) << 8) | (bytes[i + 1] ?? 0));
  }
  // An odd trailing byte is a malformed string; the last code is padded rather than dropped, so
  // whatever glyph it might have meant is kept.
  if (bytes.length % 2 === 1) codes.add(((bytes[bytes.length - 1] ?? 0) << 8) | 0);
}

/** Every font a resources dictionary names is kept in full. Used when a stream would not parse. */
function markAll(
  ctx: PDFContext,
  resources: PDFDict | null,
  usageOf: (key: string) => FontUsage,
): void {
  const fonts = resources ? pick(ctx, resources.get(PDFName.of('Font')), PDFDict) : null;
  if (!fonts) return;
  for (const [, entry] of fonts.entries()) {
    if (entry instanceof PDFRef) usageOf(entry.toString()).keepEverything = true;
  }
}

/** `/Type0` — the composite fonts, whose codes are multi-byte. */
function isComposite(ctx: PDFContext, dict: PDFDict): boolean {
  return pick(ctx, dict.get(PDFName.of('Subtype')), PDFName)?.asString() === '/Type0';
}

function contentsOf(stream: PDFStream): Uint8Array | null {
  try {
    return stream instanceof PDFRawStream
      ? decodePDFRawStream(stream).decode()
      : stream.getContents();
  } catch {
    return null;
  }
}

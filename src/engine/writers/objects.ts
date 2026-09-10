/**
 * Page-object edits in the writer (M50, ADR 0018): the original content stream, with the
 * session's edits replayed onto it by `src/engine/content/`, put back in place of the stream
 * PDFium regenerated — so every operator PDFium does not model survives the save.
 *
 * Trust is earned before anything is written. The applier scans the original stream and
 * compares its object kinds with the ones PDFium reported when the edit was made; a mismatch
 * means the indexes cannot be relied on, and the page is left as the engine wrote it (which is
 * correct, just not byte-preserving) with a warning that says so. The same happens when any
 * single edit is refused: half a set of edits would put the file out of step with what the
 * reader saw on screen, and that is worse than a regenerated stream.
 */

import {
  PDFArray,
  PDFDict,
  PDFName,
  PDFObjectParser,
  PDFPageLeaf,
  PDFRef,
  type PDFDocument,
  type PDFObject,
} from 'pdf-lib';
import type { PdfMatrix } from '@shared/pdf';
import {
  applyEdits,
  drawXObjectOps,
  objectKindsAgree,
  parse,
  scanObjects,
  serialise,
  type ContentEdit,
} from '../content';
import type { PlannedObjects } from '../Writer';

export interface ObjectWriteContext {
  warn(message: string): void;
}

function fromBase64(data: string): Uint8Array {
  const bin = atob(data);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

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
  const xobjects = resources.get(PDFName.of('XObject'));
  const existing = xobjects instanceof PDFRef ? ctx.lookup(xobjects) : xobjects;
  let dict: PDFDict;
  if (existing instanceof PDFDict) {
    dict = existing;
  } else {
    dict = ctx.obj({});
    resources.set(PDFName.of('XObject'), dict);
  }
  let n = 1;
  while (dict.has(PDFName.of(`YnObj${n}`))) n++;
  const name = `YnObj${n}`;
  dict.set(PDFName.of(name), ref);
  return name;
}

/** Every indirect reference inside an object, for checking they still resolve. */
function refsIn(value: PDFObject, into: PDFRef[] = []): PDFRef[] {
  if (value instanceof PDFRef) into.push(value);
  else if (value instanceof PDFDict) for (const [, v] of value.entries()) refsIn(v, into);
  else if (value instanceof PDFArray) for (const v of value.asArray()) refsIn(v, into);
  return into;
}

/**
 * Puts the page's original `/Resources` back, parsed from the serialisation the renderer
 * captured. The indirect references in it name objects that PDFium's save and pdf-lib's both
 * keep under their original numbers — but that is checked, not assumed: a reference that
 * resolves to nothing means the file was rewritten in between, and the page is left alone.
 */
function restoreResources(doc: PDFDocument, leaf: PDFPageLeaf, serialised: string): boolean {
  let parsed: PDFObject;
  try {
    parsed = PDFObjectParser.forBytes(
      new TextEncoder().encode(serialised),
      doc.context,
    ).parseObject();
  } catch {
    return false;
  }
  if (!(parsed instanceof PDFDict)) return false;
  for (const ref of refsIn(parsed)) {
    if (doc.context.lookup(ref) === undefined) return false;
  }
  leaf.set(PDFName.of('Resources'), parsed);
  return true;
}

/**
 * Replays the planned edits onto the page's original content and installs the result as the
 * page's only content stream. Returns whether the page was written.
 */
export async function writePageObjects(
  doc: PDFDocument,
  pageRef: PDFRef,
  planned: PlannedObjects,
  pageNumber: number,
  context: ObjectWriteContext,
): Promise<boolean> {
  const leaf = doc.context.lookup(pageRef);
  if (!(leaf instanceof PDFPageLeaf)) {
    context.warn(
      `Page ${pageNumber}: not a page, so its object edits were left as the engine wrote them`,
    );
    return false;
  }
  const original = fromBase64(planned.original);
  const stream = parse(original);
  const scan = scanObjects(stream.ops);
  if (!objectKindsAgree(scan.objects, planned.kinds)) {
    context.warn(
      `Page ${pageNumber}: its objects no longer match the recorded list, so the edits were left as the engine wrote them`,
    );
    return false;
  }

  if (planned.resources && !restoreResources(doc, leaf, planned.resources)) {
    context.warn(
      `Page ${pageNumber}: its original resources no longer resolve, so the edits were left as the engine wrote them`,
    );
    return false;
  }

  const edits: ContentEdit[] = [];
  for (const e of planned.edits) {
    if (e.kind === 'transform') edits.push({ kind: 'transform', index: e.index, matrix: e.matrix });
    else if (e.kind === 'remove') edits.push({ kind: 'remove', index: e.index });
    else if (e.kind === 'style') edits.push({ kind: 'style', index: e.index, style: e.style });
    else {
      let embedded: PDFRef;
      try {
        const [page] = await doc.embedPdf(fromBase64(e.pdf), [0]);
        if (!page) throw new Error('no page');
        embedded = page.ref;
      } catch (error) {
        context.warn(
          `Page ${pageNumber}: a pasted object could not be embedded (${error instanceof Error ? error.message : String(error)}); the page was left as the engine wrote it`,
        );
        return false;
      }
      edits.push({
        kind: 'insert',
        ops: drawXObjectOps(addXObject(doc, leaf, embedded), e.matrix),
      });
    }
  }

  const textMatrices = new Map<number, PdfMatrix>();
  for (const [index, m] of Object.entries(planned.textMatrices)) textMatrices.set(Number(index), m);
  const result = applyEdits(stream, edits, { textMatrices });
  if (result.refused.length > 0) {
    for (const r of result.refused) context.warn(`Page ${pageNumber}: ${r}`);
    context.warn(`Page ${pageNumber}: the page was left as the engine wrote it`);
    return false;
  }

  const bytes = serialise(stream, result.ops);
  const contents = doc.context.flateStream(bytes);
  leaf.set(PDFName.of('Contents'), doc.context.register(contents));
  return true;
}

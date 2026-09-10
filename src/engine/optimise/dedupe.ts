/**
 * Merging duplicate resources (M100).
 *
 * The same logo embedded once per page, the same font embedded once per section, the same scanned
 * letterhead pasted into forty documents that were then combined: a duplicate is not a rare
 * pathology, it is what happens when files are assembled by machines. Merging them is the single
 * most reliable saving in this module and the only one that is exactly lossless.
 *
 * **How two objects are decided to be the same.** Their content is hashed — for a stream, the
 * dictionary as it serialises plus the raw bytes; for a dictionary, its serialisation — and equal
 * hashes are then *checked byte for byte* before anything is merged. A hash collision would swap
 * one picture for another with no way to notice, so the hash is only ever used to avoid comparing
 * everything with everything.
 *
 * `/Length` is left in the hashed dictionary rather than excluded: two streams with the same bytes
 * have the same length anyway, and dropping a key from the comparison is how "these two are the
 * same except for the one thing that mattered" happens.
 *
 * The merge itself has two halves, and the second is the one that actually saves anything:
 * every reference to the duplicate is **repointed** at the winner, and the duplicate's object
 * number is then deleted. Assigning the winner's content to the duplicate's number would leave
 * the file with two identical objects and no saving at all — a mistake worth naming, because it
 * looks like it works right up until you weigh the result.
 */

import {
  PDFArray,
  PDFDict,
  PDFName,
  PDFRawStream,
  PDFRef,
  PDFStream,
  type PDFContext,
  type PDFDocument,
  type PDFObject,
} from 'pdf-lib';
import { pick } from '../ops/pdfdoc';
import type { DedupeOptions } from './types';

export interface DedupeOutcome {
  readonly images: number;
  readonly fonts: number;
  readonly xobjects: number;
  /** Bytes the merged copies were taking up. */
  readonly saved: number;
}

type Kind = 'images' | 'fonts' | 'xobjects';

export function dedupe(doc: PDFDocument, options: DedupeOptions): DedupeOutcome {
  const ctx = doc.context;
  const buckets = new Map<string, Array<{ ref: PDFRef; object: PDFObject; size: number }>>();
  const kinds = new Map<string, Kind>();

  for (const [ref, object] of ctx.enumerateIndirectObjects()) {
    const kind = kindOf(ctx, object);
    if (!kind || !options[kind]) continue;
    const signature = signatureOf(object);
    if (signature === null) continue;
    const key = `${kind}:${signature}`;
    kinds.set(key, kind);
    const bucket = buckets.get(key);
    const entry = { ref, object, size: sizeOf(object) };
    if (bucket) bucket.push(entry);
    else buckets.set(key, [entry]);
  }

  const merged: Record<Kind, number> = { images: 0, fonts: 0, xobjects: 0 };
  const replacements = new Map<string, PDFRef>();
  let saved = 0;

  for (const [key, bucket] of buckets) {
    if (bucket.length < 2) continue;
    const kind = kinds.get(key);
    if (!kind) continue;
    // The lowest object number wins, so the result does not depend on the order pdf-lib happened
    // to enumerate in — the same document optimised twice merges the same way round.
    const sorted = [...bucket].sort((a, b) => a.ref.objectNumber - b.ref.objectNumber);
    const winner = sorted[0];
    if (!winner) continue;
    for (const loser of sorted.slice(1)) {
      if (!identical(winner.object, loser.object)) continue;
      replacements.set(loser.ref.toString(), winner.ref);
      merged[kind]++;
      saved += loser.size;
    }
  }

  if (replacements.size > 0) {
    repoint(ctx, replacements);
    for (const key of replacements.keys()) {
      const ref = refFrom(ctx, key);
      if (ref) ctx.delete(ref);
    }
  }

  return { ...merged, saved };
}

/**
 * Rewrites every reference in the document that names a merged-away object.
 *
 * Nothing is skipped: page dictionaries, resources, annotations, the outline, the name trees and
 * the trailer are all just dictionaries and arrays, and a reference that were left behind would
 * point at an object number that is about to stop existing.
 */
function repoint(ctx: PDFContext, replacements: ReadonlyMap<string, PDFRef>): void {
  const seen = new Set<PDFObject>();
  const visit = (object: PDFObject): void => {
    if (seen.has(object)) return;
    seen.add(object);
    if (object instanceof PDFStream) {
      visit(object.dict);
      return;
    }
    if (object instanceof PDFArray) {
      for (let i = 0; i < object.size(); i++) {
        const item = object.get(i);
        if (item === undefined) continue;
        const to = item instanceof PDFRef ? replacements.get(item.toString()) : undefined;
        if (to) object.set(i, to);
        else if (!(item instanceof PDFRef)) visit(item);
      }
      return;
    }
    if (object instanceof PDFDict) {
      for (const [key, value] of object.entries()) {
        const to = value instanceof PDFRef ? replacements.get(value.toString()) : undefined;
        if (to) object.set(key, to);
        else if (!(value instanceof PDFRef)) visit(value);
      }
    }
  };

  for (const [ref, object] of ctx.enumerateIndirectObjects()) {
    if (replacements.has(ref.toString())) continue;
    visit(object);
  }
  for (const key of ['Root', 'Info', 'Encrypt'] as const) {
    const value = ctx.trailerInfo[key];
    const to = value instanceof PDFRef ? replacements.get(value.toString()) : undefined;
    if (to) ctx.trailerInfo[key] = to;
  }
}

/** The `PDFRef` for a `"12 0 R"` key, found among the objects the context still holds. */
function refFrom(ctx: PDFContext, key: string): PDFRef | null {
  for (const [ref] of ctx.enumerateIndirectObjects()) if (ref.toString() === key) return ref;
  return null;
}

/** Which of the three kinds this object is, or `null` when it is none of them. */
function kindOf(ctx: PDFContext, object: PDFObject): Kind | null {
  if (object instanceof PDFStream) {
    const subtype = pick(ctx, object.dict.get(PDFName.of('Subtype')), PDFName)?.asString();
    if (subtype === '/Image') return 'images';
    if (subtype === '/Form') return 'xobjects';
    // A font program: a stream hanging off a descriptor, which has no `/Subtype` of its own but
    // does carry `/Length1` (TrueType) or `/Subtype /Type1C` (CFF, caught above).
    if (object.dict.get(PDFName.of('Length1')) !== undefined) return 'fonts';
    return null;
  }
  if (object instanceof PDFDict) {
    const type = pick(ctx, object.get(PDFName.of('Type')), PDFName)?.asString();
    if (type === '/Font' || type === '/FontDescriptor') return 'fonts';
  }
  return null;
}

/**
 * A cheap content hash. FNV-1a over the object's own serialisation — 32 bits, which is plenty for
 * bucketing a few thousand objects, because the byte comparison below is what actually decides.
 */
function signatureOf(object: PDFObject): string | null {
  const bytes = serialise(object);
  if (!bytes) return null;
  let hash = 0x811c9dc5;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${hash.toString(16)}:${String(bytes.length)}`;
}

function identical(a: PDFObject, b: PDFObject): boolean {
  const left = serialise(a);
  const right = serialise(b);
  if (!left || left.length !== right?.length) return false;
  for (let i = 0; i < left.length; i++) if (left[i] !== right[i]) return false;
  return true;
}

/** The object exactly as it would be written, dictionary and raw stream bytes together. */
function serialise(object: PDFObject): Uint8Array | null {
  try {
    const buffer = new Uint8Array(object.sizeInBytes());
    object.copyBytesInto(buffer, 0);
    return buffer;
  } catch {
    return null;
  }
}

function sizeOf(object: PDFObject): number {
  try {
    return object instanceof PDFRawStream
      ? object.contents.length + object.dict.sizeInBytes()
      : object.sizeInBytes();
  } catch {
    return 0;
  }
}

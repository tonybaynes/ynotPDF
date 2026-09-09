/**
 * The writer's PDF Portfolio section (M42, ADR 0014).
 *
 * Rebuilds the catalogue's `/Collection` dictionary, the `/Folders` tree and the whole
 * `/EmbeddedFiles` name tree from one plan, which is what lets a single save express a rename,
 * a move between folders, a new schema column and a reorder at once.
 *
 * **The rule the module exists for:** a file the reader did not replace arrives as
 * `source.kind === 'keep'`, and its embedded stream object is reused by reference. It is never
 * decoded, never re-encoded, never even read — its `/Filter` and its `/Params` (size, dates,
 * checksum) are the ones the file was opened with. That is what keeps a digitally signed PDF
 * inside a portfolio valid across a save, and it is what the writer test asserts first.
 *
 * A file this session brought in is the only thing that makes a stream: once, Flate-compressed,
 * with the `/Params` PDF 7.11.4 asks for.
 */

import {
  PDFArray,
  PDFBool,
  PDFDict,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRef,
  PDFString,
  type PDFContext,
  type PDFDocument,
} from 'pdf-lib';
import forge from 'node-forge';
import { treeKey } from '@shared/portfolio';
import type { PlannedPortfolio, PlannedPortfolioFile } from '../Writer';

/** `/View` names, PDF 12.3.5 table 77. */
const VIEW_NAMES: Readonly<Record<PlannedPortfolio['view'], string>> = {
  details: 'D',
  tile: 'T',
  hidden: 'H',
};

/** One entry of the `/EmbeddedFiles` name tree as the base document holds it. */
export interface EmbeddedEntry {
  readonly key: string;
  readonly ref: PDFRef;
  readonly spec: PDFDict;
}

/**
 * Every `/EmbeddedFiles` entry in the base, in tree order. A specification stored directly
 * rather than by reference is registered, because the rebuilt tree holds references only.
 */
export function collectEmbeddedFiles(doc: PDFDocument): EmbeddedEntry[] {
  const ctx = doc.context;
  const out: EmbeddedEntry[] = [];
  const walk = (node: PDFDict | undefined, depth: number): void => {
    if (!node || depth > 32) return;
    const kids = node.lookupMaybe(PDFName.of('Kids'), PDFArray);
    if (kids) {
      for (const kid of kids.asArray()) walk(ctx.lookupMaybe(kid, PDFDict), depth + 1);
      return;
    }
    const names = node.lookupMaybe(PDFName.of('Names'), PDFArray)?.asArray() ?? [];
    for (let i = 1; i < names.length; i += 2) {
      const rawKey = names[i - 1];
      const value = names[i];
      if (value === undefined) continue;
      const spec = ctx.lookupMaybe(value, PDFDict);
      const key = textValue(rawKey);
      if (key === undefined || !spec) continue;
      out.push({ key, spec, ref: value instanceof PDFRef ? value : ctx.register(spec) });
    }
  };
  const names = doc.catalog.lookupMaybe(PDFName.of('Names'), PDFDict);
  walk(names?.lookupMaybe(PDFName.of('EmbeddedFiles'), PDFDict), 0);
  return out;
}

/** A text string entry, whichever of the two string forms the file used. */
function textValue(value: unknown): string | undefined {
  if (value instanceof PDFString || value instanceof PDFHexString) return value.decodeText();
  return undefined;
}

export interface PortfolioWriteContext {
  /** Something the reader should be told; never a reason to fail the save. */
  warn(message: string): void;
}

/**
 * Writes the portfolio. Returns false when the plan named no file the base could satisfy, which
 * means the catalogue is left exactly as it was rather than being emptied.
 */
export function writePortfolio(
  doc: PDFDocument,
  planned: PlannedPortfolio,
  ctxOut: PortfolioWriteContext,
): boolean {
  const ctx = doc.context;
  const existing = collectEmbeddedFiles(doc);
  const byKey = new Map(existing.map((e) => [e.key, e]));
  // A file whose key changed — renamed, or moved to another folder — is still the same object.
  // `/F` finds it when the key no longer does.
  const byName = new Map<string, EmbeddedEntry>();
  for (const entry of existing) {
    const name =
      textValue(entry.spec.lookup(PDFName.of('UF'))) ??
      textValue(entry.spec.lookup(PDFName.of('F')));
    if (name !== undefined && !byName.has(name)) byName.set(name, entry);
  }

  const kept = new Set<PDFRef>();
  const pairs: Array<{ key: string; ref: PDFRef }> = [];

  for (const file of planned.files) {
    const built = buildSpec(ctx, file, byKey, byName, ctxOut);
    if (!built) continue;
    kept.add(built);
    pairs.push({ key: treeKey(file.name, file.folderId), ref: built });
  }

  if (pairs.length === 0 && planned.files.length > 0) {
    ctxOut.warn(
      'None of the portfolio’s files could be found, so its contents were left as they were',
    );
    return false;
  }

  // Entries the plan dropped: the file was removed, or extracted and taken out. Their objects go,
  // or a "remove" would leave the bytes in the file and shrink nothing.
  for (const entry of existing) {
    if (kept.has(entry.ref)) continue;
    deleteSpec(ctx, entry, kept);
  }

  writeNameTree(doc, pairs);
  writeCollection(doc, planned, ctxOut);
  return true;
}

/** Puts the rebuilt entries into `/Names /EmbeddedFiles`, sorted by key as PDF 7.9.6 requires. */
function writeNameTree(doc: PDFDocument, pairs: Array<{ key: string; ref: PDFRef }>): void {
  const ctx = doc.context;
  const sorted = [...pairs].sort((a, b) => compareKeys(a.key, b.key));
  const array = PDFArray.withContext(ctx);
  for (const pair of sorted) {
    array.push(PDFHexString.fromText(pair.key));
    array.push(pair.ref);
  }
  let names = doc.catalog.lookupMaybe(PDFName.of('Names'), PDFDict);
  if (!names) {
    names = ctx.obj({});
    doc.catalog.set(PDFName.of('Names'), ctx.register(names));
  }
  let node = names.lookupMaybe(PDFName.of('EmbeddedFiles'), PDFDict);
  if (!node) {
    node = ctx.obj({});
    names.set(PDFName.of('EmbeddedFiles'), ctx.register(node));
  }
  // A tree that used to have intermediate nodes becomes one flat node; a portfolio holds tens of
  // files, not thousands, and a single sorted array is what every reader handles best.
  node.delete(PDFName.of('Kids'));
  node.delete(PDFName.of('Limits'));
  node.set(PDFName.of('Names'), array);
}

/** Orders two name-tree keys by their code units, which is the order a reader binary-searches in. */
export function compareKeys(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = a.charCodeAt(i) - b.charCodeAt(i);
    if (d !== 0) return d;
  }
  return a.length - b.length;
}

/**
 * The file specification for one planned file, as a reference.
 *
 * For a kept file this **mutates the specification the base already has** and leaves `/EF`
 * pointing at the same stream: entries we do not manage — `/RF`, `/Thumb`, whatever a producer
 * put there — survive, and the bytes are untouched. For a new one it makes the stream and the
 * specification from scratch.
 */
function buildSpec(
  ctx: PDFContext,
  file: PlannedPortfolioFile,
  byKey: ReadonlyMap<string, EmbeddedEntry>,
  byName: ReadonlyMap<string, EmbeddedEntry>,
  out: PortfolioWriteContext,
): PDFRef | null {
  let ref: PDFRef;
  let spec: PDFDict;
  if (file.source.kind === 'keep') {
    const entry = byKey.get(file.source.treeKey) ?? byName.get(file.name);
    if (!entry) {
      out.warn(`The embedded file "${file.name}" is not in the document, so it was not saved`);
      return null;
    }
    ref = entry.ref;
    spec = entry.spec;
  } else {
    const stream = embeddedFileStream(
      ctx,
      file.source.bytes,
      file.source.created,
      file.source.modified,
    );
    spec = ctx.obj({});
    const ef = ctx.obj({});
    ef.set(PDFName.of('F'), stream);
    ef.set(PDFName.of('UF'), stream);
    spec.set(PDFName.of('EF'), ctx.register(ef));
    ref = ctx.register(spec);
  }

  spec.set(PDFName.of('Type'), PDFName.of('Filespec'));
  spec.set(PDFName.of('F'), PDFHexString.fromText(file.name));
  spec.set(PDFName.of('UF'), PDFHexString.fromText(file.name));
  if (file.description === null || file.description === '') spec.delete(PDFName.of('Desc'));
  else spec.set(PDFName.of('Desc'), PDFHexString.fromText(file.description));

  const keys = Object.keys(file.fields);
  if (keys.length === 0) {
    spec.delete(PDFName.of('CI'));
  } else {
    const ci = ctx.obj({});
    for (const key of keys) {
      const value = file.fields[key];
      if (value !== undefined) ci.set(PDFName.of(key), PDFHexString.fromText(value));
    }
    spec.set(PDFName.of('CI'), ctx.register(ci));
  }

  if (file.mimeType !== null && file.mimeType !== '') {
    const stream = embeddedStreamOf(ctx, spec);
    // A MIME type is a name, and `/` has to be escaped inside one (PDF 7.3.5); `PDFName.of`
    // does that. Only a new file's stream is touched here — a kept one already has its own.
    if (stream && file.source.kind === 'bytes') {
      stream.dict.set(PDFName.of('Subtype'), PDFName.of(file.mimeType));
    }
  }
  return ref;
}

/** The embedded stream a file specification points at. */
function embeddedStreamOf(ctx: PDFContext, spec: PDFDict): { dict: PDFDict } | null {
  const ef = spec.lookupMaybe(PDFName.of('EF'), PDFDict);
  const value = ef?.get(PDFName.of('F')) ?? ef?.get(PDFName.of('UF'));
  if (!value) return null;
  const stream = ctx.lookup(value);
  return stream && typeof stream === 'object' && 'dict' in stream
    ? (stream as { dict: PDFDict })
    : null;
}

/**
 * A new embedded file stream: Flate once, with the `/Params` PDF 7.11.4 defines — the
 * uncompressed size, the two dates and an MD5 checksum of the plaintext, which is what lets a
 * reader tell that an extracted copy is unchanged.
 */
function embeddedFileStream(
  ctx: PDFContext,
  bytes: Uint8Array,
  created: string | null,
  modified: string | null,
): PDFRef {
  const params = ctx.obj({});
  params.set(PDFName.of('Size'), PDFNumber.of(bytes.length));
  const createdDate = toPdfDate(created);
  const modifiedDate = toPdfDate(modified);
  if (createdDate !== null) params.set(PDFName.of('CreationDate'), PDFString.of(createdDate));
  if (modifiedDate !== null) params.set(PDFName.of('ModDate'), PDFString.of(modifiedDate));
  params.set(PDFName.of('CheckSum'), PDFHexString.of(md5Hex(bytes)));
  const stream = ctx.flateStream(bytes, {
    Type: 'EmbeddedFile',
  });
  stream.dict.set(PDFName.of('Params'), ctx.register(params));
  return ctx.register(stream);
}

/** MD5 of the plaintext, uppercase hex, for `/Params /CheckSum`. */
function md5Hex(bytes: Uint8Array): string {
  const md = forge.md.md5.create();
  const CHUNK = 8192;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    md.update(String.fromCharCode(...bytes.subarray(i, i + CHUNK)));
  }
  return md.digest().toHex().toUpperCase();
}

/** ISO 8601 as a PDF date string, or null when there is nothing usable to write. */
export function toPdfDate(iso: string | null): string | null {
  if (iso === null || iso === '') return null;
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return null;
  const d = new Date(time);
  const p = (n: number, width = 2): string => String(n).padStart(width, '0');
  return (
    `D:${p(d.getUTCFullYear(), 4)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`
  );
}

/** Removes a dropped entry's specification and the stream only it referenced. */
function deleteSpec(ctx: PDFContext, entry: EmbeddedEntry, kept: ReadonlySet<PDFRef>): void {
  const ef = entry.spec.lookupMaybe(PDFName.of('EF'), PDFDict);
  const streams = new Set<PDFRef>();
  if (ef) {
    for (const key of ['F', 'UF'] as const) {
      const value = ef.get(PDFName.of(key));
      if (value instanceof PDFRef) streams.add(value);
    }
    const efRef = entry.spec.get(PDFName.of('EF'));
    if (efRef instanceof PDFRef) ctx.delete(efRef);
  }
  for (const stream of streams) ctx.delete(stream);
  const ci = entry.spec.get(PDFName.of('CI'));
  if (ci instanceof PDFRef) ctx.delete(ci);
  if (!kept.has(entry.ref)) ctx.delete(entry.ref);
}

// ---- /Collection --------------------------------------------------------------------------------

/** Writes the collection dictionary, keeping any entry of it this module does not manage. */
function writeCollection(
  doc: PDFDocument,
  planned: PlannedPortfolio,
  out: PortfolioWriteContext,
): void {
  const ctx = doc.context;
  let collection = doc.catalog.lookupMaybe(PDFName.of('Collection'), PDFDict);
  if (!collection) {
    collection = ctx.obj({});
    doc.catalog.set(PDFName.of('Collection'), ctx.register(collection));
  }
  collection.set(PDFName.of('Type'), PDFName.of('Collection'));
  collection.set(PDFName.of('View'), PDFName.of(VIEW_NAMES[planned.view]));

  const schema = ctx.obj({});
  for (const column of planned.schema) {
    const field = ctx.obj({});
    field.set(PDFName.of('Type'), PDFName.of('CollectionField'));
    field.set(PDFName.of('Subtype'), PDFName.of(column.subtype));
    field.set(PDFName.of('N'), PDFHexString.fromText(column.label));
    field.set(PDFName.of('O'), PDFNumber.of(column.order));
    field.set(PDFName.of('V'), column.visible ? PDFBool.True : PDFBool.False);
    schema.set(PDFName.of(column.key), ctx.register(field));
  }
  collection.set(PDFName.of('Schema'), ctx.register(schema));

  if (planned.sort === null) {
    collection.delete(PDFName.of('Sort'));
  } else {
    const sort = ctx.obj({});
    sort.set(PDFName.of('S'), PDFName.of(planned.sort.key));
    sort.set(PDFName.of('A'), planned.sort.ascending ? PDFBool.True : PDFBool.False);
    collection.set(PDFName.of('Sort'), ctx.register(sort));
  }

  if (planned.reorderKey === null) collection.delete(PDFName.of('Reorder'));
  else collection.set(PDFName.of('Reorder'), PDFName.of(planned.reorderKey));

  if (planned.initialFile === null) collection.delete(PDFName.of('D'));
  else collection.set(PDFName.of('D'), PDFHexString.fromText(planned.initialFile));

  writeFolders(doc, collection, planned, out);
}

/**
 * The `/Folders` tree: `/Child` is a node's first subfolder and `/Next` its next sibling. A
 * folder dictionary the base already had is reused by id, so anything a producer put in it that
 * we do not model survives the save.
 */
function writeFolders(
  doc: PDFDocument,
  collection: PDFDict,
  planned: PlannedPortfolio,
  out: PortfolioWriteContext,
): void {
  const ctx = doc.context;
  const root = planned.folders.find((f) => f.parentId === null);
  if (!root) {
    out.warn('The portfolio has no root folder, so its folder structure was not saved');
    collection.delete(PDFName.of('Folders'));
    return;
  }

  // Only a folder reached through a reference is reused: registering a dictionary that is
  // already stored directly would make a second copy of it rather than find the first.
  const existing = new Map<number, { dict: PDFDict; ref: PDFRef }>();
  const foldersValue = collection.get(PDFName.of('Folders'));
  if (foldersValue instanceof PDFRef) {
    const rootDict = ctx.lookupMaybe(foldersValue, PDFDict);
    if (rootDict) {
      const id = rootDict.lookupMaybe(PDFName.of('ID'), PDFNumber)?.asNumber() ?? 0;
      existing.set(id, { dict: rootDict, ref: foldersValue });
      collectByRef(ctx, rootDict, existing, 0);
    }
  }

  const nodes = new Map<number, { dict: PDFDict; ref: PDFRef }>();
  for (const folder of planned.folders) {
    const found = existing.get(folder.id);
    if (found) {
      nodes.set(folder.id, found);
      continue;
    }
    const dict = ctx.obj({});
    nodes.set(folder.id, { dict, ref: ctx.register(dict) });
  }

  for (const folder of planned.folders) {
    const node = nodes.get(folder.id);
    if (!node) continue;
    const { dict } = node;
    dict.set(PDFName.of('Type'), PDFName.of('Folder'));
    dict.set(PDFName.of('ID'), PDFNumber.of(folder.id));
    dict.set(PDFName.of('Name'), PDFHexString.fromText(folder.name));
    const created = toPdfDate(folder.created);
    const modified = toPdfDate(folder.modified);
    if (created === null) dict.delete(PDFName.of('CreationDate'));
    else dict.set(PDFName.of('CreationDate'), PDFString.of(created));
    if (modified === null) dict.delete(PDFName.of('ModDate'));
    else dict.set(PDFName.of('ModDate'), PDFString.of(modified));
    if (folder.description === null || folder.description === '') dict.delete(PDFName.of('Desc'));
    else dict.set(PDFName.of('Desc'), PDFHexString.fromText(folder.description));

    const parent = folder.parentId === null ? null : nodes.get(folder.parentId);
    if (parent) dict.set(PDFName.of('Parent'), parent.ref);
    else dict.delete(PDFName.of('Parent'));

    const children = planned.folders.filter((f) => f.parentId === folder.id);
    const first = children[0] ? nodes.get(children[0].id) : undefined;
    if (first) dict.set(PDFName.of('Child'), first.ref);
    else dict.delete(PDFName.of('Child'));

    const siblings =
      folder.parentId === null ? [] : planned.folders.filter((f) => f.parentId === folder.parentId);
    const at = siblings.findIndex((f) => f.id === folder.id);
    const nextFolder = at >= 0 ? siblings[at + 1] : undefined;
    const next = nextFolder ? nodes.get(nextFolder.id) : undefined;
    if (next) dict.set(PDFName.of('Next'), next.ref);
    else dict.delete(PDFName.of('Next'));
  }

  const rootNode = nodes.get(root.id);
  if (rootNode) collection.set(PDFName.of('Folders'), rootNode.ref);
}

/** Walks `/Child` and `/Next` links that are references, remembering each folder by its `/ID`. */
function collectByRef(
  ctx: PDFContext,
  node: PDFDict,
  found: Map<number, { dict: PDFDict; ref: PDFRef }>,
  depth: number,
): void {
  if (depth > 64) return;
  for (const key of ['Child', 'Next'] as const) {
    const value = node.get(PDFName.of(key));
    if (!(value instanceof PDFRef)) continue;
    const dict = ctx.lookupMaybe(value, PDFDict);
    if (!dict) continue;
    const id = dict.lookupMaybe(PDFName.of('ID'), PDFNumber)?.asNumber();
    if (id !== undefined && !found.has(id)) found.set(id, { dict, ref: value });
    collectByRef(ctx, dict, found, depth + 1);
  }
}

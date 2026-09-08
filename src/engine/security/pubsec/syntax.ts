/**
 * Just enough PDF syntax to read an `/Encrypt` dictionary and append one (M70).
 *
 * This is not a PDF parser and must never grow into one. It exists because opening a
 * certificate-encrypted file needs three facts out of a document *before* anything can decrypt
 * it — the trailer, the `/Encrypt` dictionary and the recipients' sealed blobs — and every one of
 * those is stored in the clear precisely so that a reader can get at them first. Everything
 * beyond that point is qpdf's job (ADR 0012).
 *
 * So the rules here are narrow on purpose:
 *
 * - It reads dictionaries and the values inside them. It does not resolve references, decode
 *   streams, or walk a cross-reference table.
 * - It finds the `/Encrypt` dictionary by scanning for its filter name, because that dictionary
 *   is always a top-level object in the file's bytes — it cannot live in an object stream, since
 *   an object stream is itself encrypted.
 * - It writes an incremental update, which is append-only and cannot damage what is already
 *   there.
 */

import { fromHex, toBinary } from './crypto';

/** A parsed PDF value. Deliberately shallow: enough for an `/Encrypt` dictionary and no more. */
export type PdfValue =
  | { readonly kind: 'name'; readonly value: string }
  | { readonly kind: 'number'; readonly value: number }
  | { readonly kind: 'bool'; readonly value: boolean }
  | { readonly kind: 'null' }
  | { readonly kind: 'string'; readonly value: Uint8Array }
  | { readonly kind: 'ref'; readonly number: number; readonly generation: number }
  | { readonly kind: 'array'; readonly items: ReadonlyArray<PdfValue> }
  | { readonly kind: 'dict'; readonly entries: ReadonlyMap<string, PdfValue> };

const WHITESPACE = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
const DELIMITER = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25]);

class Reader {
  readonly bytes: Uint8Array;
  at: number;

  constructor(bytes: Uint8Array, at = 0) {
    this.bytes = bytes;
    this.at = at;
  }

  peek(): number {
    return this.bytes[this.at] ?? -1;
  }

  skipSpace(): void {
    for (;;) {
      const c = this.peek();
      if (WHITESPACE.has(c)) {
        this.at++;
        continue;
      }
      if (c === 0x25) {
        // A comment runs to the end of the line.
        while (this.at < this.bytes.length && this.peek() !== 0x0a && this.peek() !== 0x0d) {
          this.at++;
        }
        continue;
      }
      return;
    }
  }
}

/** Parses one value at `offset`. Returns `null` when there is nothing parsable there. */
export function parseValue(bytes: Uint8Array, offset: number): PdfValue | null {
  const reader = new Reader(bytes, offset);
  return readValue(reader, 0);
}

/** Parses the dictionary starting at `offset`, which must point at its `<<`. */
export function parseDict(bytes: Uint8Array, offset: number): ReadonlyMap<string, PdfValue> | null {
  const value = parseValue(bytes, offset);
  return value?.kind === 'dict' ? value.entries : null;
}

function readValue(r: Reader, depth: number): PdfValue | null {
  if (depth > 32) return null;
  r.skipSpace();
  const c = r.peek();
  if (c < 0) return null;
  if (c === 0x2f) return readName(r);
  if (c === 0x28) return readLiteralString(r);
  if (c === 0x5b) return readArray(r, depth);
  if (c === 0x3c) {
    return r.bytes[r.at + 1] === 0x3c ? readDict(r, depth) : readHexString(r);
  }
  return readKeywordOrNumber(r);
}

function readName(r: Reader): PdfValue {
  r.at++; // the slash
  let out = '';
  for (;;) {
    const c = r.peek();
    if (c < 0 || WHITESPACE.has(c) || DELIMITER.has(c)) break;
    r.at++;
    if (c === 0x23) {
      // `#xx` escape.
      const hex = String.fromCharCode(r.bytes[r.at] ?? 0, r.bytes[r.at + 1] ?? 0);
      const code = Number.parseInt(hex, 16);
      if (!Number.isNaN(code)) {
        out += String.fromCharCode(code);
        r.at += 2;
        continue;
      }
    }
    out += String.fromCharCode(c);
  }
  return { kind: 'name', value: out };
}

function readArray(r: Reader, depth: number): PdfValue {
  r.at++; // '['
  const items: PdfValue[] = [];
  for (;;) {
    r.skipSpace();
    if (r.peek() === 0x5d) {
      r.at++;
      break;
    }
    const before = r.at;
    const value = readValue(r, depth + 1);
    if (!value || r.at === before) break;
    items.push(value);
  }
  return { kind: 'array', items };
}

function readDict(r: Reader, depth: number): PdfValue {
  r.at += 2; // '<<'
  const entries = new Map<string, PdfValue>();
  for (;;) {
    r.skipSpace();
    if (r.peek() === 0x3e && r.bytes[r.at + 1] === 0x3e) {
      r.at += 2;
      break;
    }
    if (r.peek() !== 0x2f) {
      // Not a key. Either the dictionary is malformed or we ran off the end; either way, stop.
      const before = r.at;
      if (!readValue(r, depth + 1) || r.at === before) break;
      continue;
    }
    const key = readName(r);
    const value = readValue(r, depth + 1);
    if (!value) break;
    if (key.kind === 'name') entries.set(key.value, value);
  }
  return { kind: 'dict', entries };
}

function readHexString(r: Reader): PdfValue {
  r.at++; // '<'
  let hex = '';
  for (;;) {
    const c = r.peek();
    if (c < 0 || c === 0x3e) {
      r.at++;
      break;
    }
    r.at++;
    hex += String.fromCharCode(c);
  }
  return { kind: 'string', value: fromHex(hex) };
}

function readLiteralString(r: Reader): PdfValue {
  r.at++; // '('
  const out: number[] = [];
  let nesting = 0;
  for (;;) {
    const c = r.peek();
    if (c < 0) break;
    r.at++;
    if (c === 0x5c) {
      const next = r.peek();
      r.at++;
      switch (next) {
        case 0x6e:
          out.push(0x0a);
          break;
        case 0x72:
          out.push(0x0d);
          break;
        case 0x74:
          out.push(0x09);
          break;
        case 0x62:
          out.push(0x08);
          break;
        case 0x66:
          out.push(0x0c);
          break;
        case 0x0a:
        case 0x0d:
          break;
        default:
          if (next >= 0x30 && next <= 0x37) {
            let octal = String.fromCharCode(next);
            while (octal.length < 3) {
              const digit = r.peek();
              if (digit < 0x30 || digit > 0x37) break;
              octal += String.fromCharCode(digit);
              r.at++;
            }
            out.push(Number.parseInt(octal, 8) & 0xff);
          } else {
            out.push(next);
          }
      }
      continue;
    }
    if (c === 0x28) nesting++;
    if (c === 0x29) {
      if (nesting === 0) break;
      nesting--;
    }
    out.push(c);
  }
  return { kind: 'string', value: Uint8Array.from(out) };
}

const KEYWORD = /^[+\-.0-9A-Za-z]+/;

function readKeywordOrNumber(r: Reader): PdfValue | null {
  let text = '';
  const start = r.at;
  while (r.at < r.bytes.length) {
    const c = r.peek();
    if (WHITESPACE.has(c) || DELIMITER.has(c)) break;
    text += String.fromCharCode(c);
    r.at++;
  }
  if (text === '') {
    r.at = start + 1;
    return null;
  }
  if (text === 'true') return { kind: 'bool', value: true };
  if (text === 'false') return { kind: 'bool', value: false };
  if (text === 'null') return { kind: 'null' };
  if (!KEYWORD.test(text)) return null;
  const value = Number(text);
  if (Number.isNaN(value)) return null;

  // `12 0 R` is a reference; `12 0` is two numbers. Look ahead without committing.
  if (Number.isInteger(value) && value >= 0) {
    const save = r.at;
    r.skipSpace();
    let second = '';
    while (r.at < r.bytes.length) {
      const c = r.peek();
      if (WHITESPACE.has(c) || DELIMITER.has(c)) break;
      second += String.fromCharCode(c);
      r.at++;
    }
    if (/^\d+$/.test(second)) {
      r.skipSpace();
      if (r.peek() === 0x52 /* R */) {
        r.at++;
        return { kind: 'ref', number: value, generation: Number(second) };
      }
    }
    r.at = save;
  }
  return { kind: 'number', value };
}

// ---- finding things in a file -------------------------------------------------------------------

const decoder = new TextDecoder('latin1');

/** The offset the file's last `startxref` points at, or `null`. */
export function lastStartXref(bytes: Uint8Array): number | null {
  // Look in the last 2 kB, which is where the spec puts it and where every real file has it.
  const from = Math.max(0, bytes.length - 2048);
  const tail = decoder.decode(bytes.subarray(from));
  const match = /startxref\s+(\d+)/g;
  let offset: number | null = null;
  for (let m = match.exec(tail); m; m = match.exec(tail)) {
    offset = Number(m[1]);
  }
  return offset !== null && offset >= 0 && offset < bytes.length ? offset : null;
}

/** What the trailer says, whether it is a classic `trailer` or a cross-reference stream. */
export interface TrailerInfo {
  readonly entries: ReadonlyMap<string, PdfValue>;
  /** How the section at `startxref` is written, which decides how we append to it. */
  readonly kind: 'table' | 'stream';
}

/**
 * Reads the trailer at `offset`.
 *
 * A classic section is `xref … trailer << … >>`; a cross-reference stream is an indirect object
 * whose own dictionary *is* the trailer. Both are plaintext even in an encrypted document,
 * because a reader has to get at `/Encrypt` before it can decrypt anything.
 */
export function readTrailer(bytes: Uint8Array, offset: number): TrailerInfo | null {
  const head = decoder.decode(bytes.subarray(offset, Math.min(bytes.length, offset + 32)));
  if (/^\s*xref/.test(head)) {
    // Find the `trailer` keyword that follows the table. Tables are small; scan forward.
    const window = decoder.decode(
      bytes.subarray(offset, Math.min(bytes.length, offset + 4_000_000)),
    );
    const at = window.indexOf('trailer');
    if (at < 0) return null;
    const dictAt = window.indexOf('<<', at);
    if (dictAt < 0) return null;
    const entries = parseDict(bytes, offset + dictAt);
    return entries ? { entries, kind: 'table' } : null;
  }
  // `N G obj << … >> stream`
  const window = decoder.decode(bytes.subarray(offset, Math.min(bytes.length, offset + 65_536)));
  if (!/^\s*\d+\s+\d+\s+obj/.test(window)) return null;
  const dictAt = window.indexOf('<<');
  if (dictAt < 0) return null;
  const entries = parseDict(bytes, offset + dictAt);
  return entries ? { entries, kind: 'stream' } : null;
}

/** Where an `/Encrypt` dictionary was found, and what it says. */
export interface FoundEncryptDict {
  readonly entries: ReadonlyMap<string, PdfValue>;
  /** The object number it is stored under, so an update can replace it. */
  readonly objectNumber: number;
  readonly generation: number;
}

const OBJ_HEADER = /(\d+)\s+(\d+)\s+obj\b/g;

/**
 * Finds the `/Encrypt` dictionary by scanning for the security handler's filter name.
 *
 * Scanning rather than following the trailer's reference through a cross-reference table is the
 * right trade here: the dictionary is always a top-level plaintext object, the filter names are
 * distinctive, and the alternative is a cross-reference walk — including inflating cross-reference
 * streams — for one lookup. When the trailer's reference is available it is used to pick between
 * candidates, so a document that merely *mentions* `/Standard` somewhere cannot mislead us.
 */
export function findEncryptDict(bytes: Uint8Array, trailer?: TrailerInfo): FoundEncryptDict | null {
  const wanted = trailer?.entries.get('Encrypt');
  const wantedNumber = wanted?.kind === 'ref' ? wanted.number : null;
  const text = decoder.decode(bytes);

  const candidates: FoundEncryptDict[] = [];
  for (const filter of ['/Adobe.PubSec', '/Standard']) {
    let from = text.indexOf(filter);
    while (from >= 0) {
      const found = enclosingObject(bytes, text, from);
      if (found?.entries.has('Filter')) candidates.push(found);
      from = text.indexOf(filter, from + 1);
    }
  }
  if (candidates.length === 0) return null;
  if (wantedNumber !== null) {
    const exact = candidates.find((c) => c.objectNumber === wantedNumber);
    if (exact) return exact;
  }
  // The last one wins: an incrementally updated file carries its newest objects at the end.
  return candidates[candidates.length - 1] ?? null;
}

/** The `N G obj << … >>` that contains `position`. */
function enclosingObject(
  bytes: Uint8Array,
  text: string,
  position: number,
): FoundEncryptDict | null {
  // Search backwards for the nearest object header before `position`.
  const from = Math.max(0, position - 4096);
  const slice = text.slice(from, position);
  OBJ_HEADER.lastIndex = 0;
  let last: RegExpExecArray | null = null;
  for (let m = OBJ_HEADER.exec(slice); m; m = OBJ_HEADER.exec(slice)) last = m;
  if (!last) return null;
  const headerEnd = from + last.index + last[0].length;
  const dictAt = text.indexOf('<<', headerEnd);
  if (dictAt < 0 || dictAt > position) return null;
  const entries = parseDict(bytes, dictAt);
  if (!entries) return null;
  return { entries, objectNumber: Number(last[1]), generation: Number(last[2]) };
}

/** A dictionary entry as a number, when it is one. */
export function numberOf(entries: ReadonlyMap<string, PdfValue>, key: string): number | null {
  const value = entries.get(key);
  return value?.kind === 'number' ? value.value : null;
}

/** A dictionary entry as a name, without its slash. */
export function nameOf(entries: ReadonlyMap<string, PdfValue>, key: string): string | null {
  const value = entries.get(key);
  return value?.kind === 'name' ? value.value : null;
}

/** A dictionary entry as a boolean, with a default. */
export function boolOf(
  entries: ReadonlyMap<string, PdfValue>,
  key: string,
  fallback: boolean,
): boolean {
  const value = entries.get(key);
  return value?.kind === 'bool' ? value.value : fallback;
}

/** A dictionary entry as a nested dictionary. */
export function dictOf(
  entries: ReadonlyMap<string, PdfValue>,
  key: string,
): ReadonlyMap<string, PdfValue> | null {
  const value = entries.get(key);
  return value?.kind === 'dict' ? value.entries : null;
}

/**
 * The sealed recipient blobs, wherever the file keeps them.
 *
 * For `/V 1` and `/V 2` public-key files `/Recipients` sits at the top of the `/Encrypt`
 * dictionary; from `/V 4` onwards it moves inside the crypt filter named by `/StmF`. Files in the
 * wild do both, so both are looked at.
 */
export function recipientBlobs(entries: ReadonlyMap<string, PdfValue>): Uint8Array[] {
  const direct = arrayOfStrings(entries.get('Recipients'));
  if (direct.length > 0) return direct;
  const cf = dictOf(entries, 'CF');
  if (!cf) return [];
  const preferred = nameOf(entries, 'StmF');
  const names = preferred ? [preferred, ...cf.keys()] : [...cf.keys()];
  for (const name of names) {
    const filter = dictOf(cf, name);
    if (!filter) continue;
    const blobs = arrayOfStrings(filter.get('Recipients'));
    if (blobs.length > 0) return blobs;
  }
  return [];
}

function arrayOfStrings(value: PdfValue | undefined): Uint8Array[] {
  if (value?.kind !== 'array') return [];
  return value.items.filter((i) => i.kind === 'string').map((i) => i.value);
}

// ---- writing ------------------------------------------------------------------------------------

/** Serialises a value back to PDF syntax. Only the shapes an `/Encrypt` dictionary needs. */
export function writeValue(value: PdfValue): string {
  switch (value.kind) {
    case 'name':
      return `/${value.value.replace(/[^\w.\-+]/g, (c) => `#${c.charCodeAt(0).toString(16).padStart(2, '0')}`)}`;
    case 'number':
      return Number.isInteger(value.value) ? String(value.value) : value.value.toFixed(6);
    case 'bool':
      return value.value ? 'true' : 'false';
    case 'null':
      return 'null';
    case 'string':
      return `<${hexOf(value.value)}>`;
    case 'ref':
      return `${String(value.number)} ${String(value.generation)} R`;
    case 'array':
      return `[${value.items.map(writeValue).join(' ')}]`;
    case 'dict':
      return `<<${[...value.entries].map(([k, v]) => `/${k} ${writeValue(v)}`).join(' ')}>>`;
    default:
      return 'null';
  }
}

function hexOf(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

/** The literal bytes of a value that must be copied through untouched, such as `/ID`. */
export function rawOf(value: PdfValue | undefined): string {
  return value ? writeValue(value) : '';
}

/** Encodes a string as latin-1 bytes, which is what PDF syntax is. */
export function encodeLatin1(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

export { toBinary };

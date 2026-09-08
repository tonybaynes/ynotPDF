/**
 * Opening a certificate-encrypted document (M70, ADR 0012).
 *
 * The trick, and it is the whole file: we never parse the document. From the recipient's private
 * key we open one of the sealed blobs, recover the seed, derive the file encryption key — and then
 * **append twelve lines** giving the file a standard-handler `/Encrypt` dictionary that wraps that
 * same key under a password we invent. Every encrypted byte in the document is left exactly where
 * it was, because AESV3 content encryption is identical under both handlers; only the dictionary
 * saying how to find the key has changed.
 *
 * qpdf then does the rest. It parses the cross-reference streams, the object streams, the damage
 * and the oddities — all the things a second PDF parser inside this module would have had to learn
 * — and hands back plaintext for PDFium to open.
 *
 * The appended bytes are an incremental update, which is append-only: if anything here were
 * wrong, the original file is still intact in front of it. And the file this produces never
 * touches the disk, so its slightly unusual shape is nobody's problem but qpdf's.
 */

import type forge from 'node-forge';
import { SecurityError } from '../types';
import { concat, randomBytes, toHex } from './crypto';
import { deriveFileKey, openEnvelopes } from './envelope';
import { buildStandardR6 } from './standard';
import {
  boolOf,
  encodeLatin1,
  findEncryptDict,
  lastStartXref,
  nameOf,
  numberOf,
  rawOf,
  readTrailer,
  recipientBlobs,
  type TrailerInfo,
} from './syntax';

/** What a certificate-encrypted file says about itself, before anything is opened. */
export interface PubSecHeader {
  readonly blobs: ReadonlyArray<Uint8Array>;
  readonly encryptMetadata: boolean;
  readonly permissions: number;
  /** `/V`; 4 and 5 use AES, 1 and 2 use RC4. */
  readonly version: number;
  readonly objectNumber: number;
  readonly trailer: TrailerInfo;
  readonly startXref: number;
}

/** Reads the public-key header out of a file, or `null` when it is not one. */
export function readPubSecHeader(bytes: Uint8Array): PubSecHeader | null {
  const startXref = lastStartXref(bytes);
  if (startXref === null) return null;
  const trailer = readTrailer(bytes, startXref);
  if (!trailer) return null;
  const found = findEncryptDict(bytes, trailer);
  if (!found) return null;
  if (nameOf(found.entries, 'Filter') !== 'Adobe.PubSec') return null;
  const blobs = recipientBlobs(found.entries);
  if (blobs.length === 0) return null;
  return {
    blobs,
    encryptMetadata: boolOf(found.entries, 'EncryptMetadata', true),
    permissions: numberOf(found.entries, 'P') ?? -1,
    version: numberOf(found.entries, 'V') ?? 5,
    objectNumber: found.objectNumber,
    trailer,
    startXref,
  };
}

/** True when these bytes are a certificate-encrypted PDF. */
export function isCertificateEncrypted(bytes: Uint8Array): boolean {
  return readPubSecHeader(bytes) !== null;
}

export interface UnlockedForQpdf {
  /** The same document with a standard-handler `/Encrypt` dictionary appended. */
  readonly bytes: Uint8Array;
  /** The password that dictionary was built for. Random, and thrown away after the qpdf call. */
  readonly password: string;
  /** `/P` as the recipient's own envelope stated it, which may differ per recipient. */
  readonly permissions: number;
}

/**
 * Makes a certificate-encrypted file readable by qpdf, using one recipient's private key.
 *
 * Throws `not-a-recipient` when the key opens none of the envelopes — which is the honest answer
 * to "this is not your document" and the one the acceptance test checks for.
 */
export function unlockWithPrivateKey(
  bytes: Uint8Array,
  privateKey: forge.pki.PrivateKey,
): UnlockedForQpdf {
  const header = readPubSecHeader(bytes);
  if (!header) {
    throw new SecurityError(
      'bad-key-file',
      'That document is not protected with certificates, so a digital ID cannot open it.',
    );
  }
  if (header.version < 4) {
    throw new SecurityError(
      'failed',
      'That document uses an obsolete certificate encryption format (RC4) that this app cannot open.',
    );
  }
  const opened = openEnvelopes(header.blobs, privateKey);
  if (!opened) {
    throw new SecurityError(
      'not-a-recipient',
      'That digital ID is not one of this document’s recipients, so it cannot open it.',
    );
  }
  const fileKey = deriveFileKey(opened.seed, header.blobs, {
    encryptMetadata: header.encryptMetadata,
  });
  const password = toHex(randomBytes(16));
  return {
    bytes: appendStandardEncrypt(bytes, header, fileKey, password),
    password,
    permissions: opened.permissions,
  };
}

/**
 * Appends the incremental update.
 *
 * The new `/Encrypt` object takes a fresh number rather than replacing the old one, so the
 * original dictionary stays in the file untouched and nothing that referred to it breaks. The
 * cross-reference section is written in the same style the file already uses — a table after a
 * table, a stream after a stream — because mixing the two is the sort of thing a reader is
 * entitled to refuse.
 */
function appendStandardEncrypt(
  bytes: Uint8Array,
  header: PubSecHeader,
  fileKey: Uint8Array,
  password: string,
): Uint8Array {
  const strings = buildStandardR6({
    fileKey,
    password,
    permissions: header.permissions,
    encryptMetadata: header.encryptMetadata,
  });
  const size = numberOf(header.trailer.entries, 'Size') ?? header.objectNumber + 1;
  const encryptNumber = size;
  const xrefNumber = size + 1;

  const dict =
    `<< /Filter /Standard /V 5 /R 6 /Length 256 /P ${String(header.permissions)} ` +
    `/CF << /StdCF << /CFM /AESV3 /Length 32 >> >> /StmF /StdCF /StrF /StdCF ` +
    `/U <${toHex(strings.u)}> /UE <${toHex(strings.ue)}> ` +
    `/O <${toHex(strings.o)}> /OE <${toHex(strings.oe)}> ` +
    `/Perms <${toHex(strings.perms)}> ` +
    `/EncryptMetadata ${header.encryptMetadata ? 'true' : 'false'} >>`;

  const root = rawOf(header.trailer.entries.get('Root'));
  const info = header.trailer.entries.has('Info')
    ? ` /Info ${rawOf(header.trailer.entries.get('Info'))}`
    : '';
  const id = header.trailer.entries.has('ID')
    ? ` /ID ${rawOf(header.trailer.entries.get('ID'))}`
    : '';

  // A file that does not end in a newline would otherwise run `%%EOF` into our first object.
  const separator = endsWithNewline(bytes) ? '' : '\n';
  const objectStart = bytes.length + separator.length;
  const objectText = `${String(encryptNumber)} 0 obj\n${dict}\nendobj\n`;

  if (header.trailer.kind === 'table') {
    const xrefStart = objectStart + objectText.length;
    const table =
      `xref\n${String(encryptNumber)} 1\n${offset10(objectStart)} 00000 n \n` +
      `trailer\n<< /Size ${String(encryptNumber + 1)} /Root ${root}${info}${id} ` +
      `/Encrypt ${String(encryptNumber)} 0 R /Prev ${String(header.startXref)} >>\n` +
      `startxref\n${String(xrefStart)}\n%%EOF\n`;
    return concat(bytes, encodeLatin1(separator + objectText + table));
  }

  // A cross-reference stream update. Two entries, both in use: the new `/Encrypt` object and the
  // stream itself. `/W [1 4 2]` and no filter, because this file is read once and discarded.
  const xrefStart = objectStart + objectText.length;
  const entries = new Uint8Array(14);
  writeEntry(entries, 0, objectStart);
  writeEntry(entries, 7, xrefStart);
  const streamDict =
    `<< /Type /XRef /Size ${String(xrefNumber + 1)} /Index [${String(encryptNumber)} 2] ` +
    `/W [1 4 2] /Root ${root}${info}${id} /Encrypt ${String(encryptNumber)} 0 R ` +
    `/Prev ${String(header.startXref)} /Length ${String(entries.length)} >>`;
  const streamText = `${String(xrefNumber)} 0 obj\n${streamDict}\nstream\n`;
  return concat(
    bytes,
    encodeLatin1(separator + objectText + streamText),
    entries,
    encodeLatin1(`\nendstream\nendobj\nstartxref\n${String(xrefStart)}\n%%EOF\n`),
  );
}

/** One `/W [1 4 2]` cross-reference entry: type 1 (in use), a 4-byte offset, generation 0. */
function writeEntry(into: Uint8Array, at: number, offset: number): void {
  into[at] = 1;
  new DataView(into.buffer, into.byteOffset + at + 1, 4).setUint32(0, offset, false);
  into[at + 5] = 0;
  into[at + 6] = 0;
}

function offset10(offset: number): string {
  return String(offset).padStart(10, '0');
}

function endsWithNewline(bytes: Uint8Array): boolean {
  const last = bytes[bytes.length - 1];
  return last === 0x0a || last === 0x0d;
}

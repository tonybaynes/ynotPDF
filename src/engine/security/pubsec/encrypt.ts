/**
 * Encrypting a PDF's object graph ourselves (M70, ADR 0012).
 *
 * qpdf writes every password-protected file this app produces, and this module exists for the two
 * things qpdf will not do:
 *
 * - **Certificate protection.** qpdf has no public-key security handler at all.
 * - **Encrypting only the file attachments.** qpdf has no `/EFF` option, and the arrangement is
 *   otherwise a normal standard-handler file — so it is a key we choose plus a walk over the
 *   embedded-file streams.
 *
 * Both are the same walk, and it is smaller than it sounds: under AESV3 the object key *is* the
 * file key, so encrypting a document means turning strings and stream bodies into AES-256-CBC
 * ciphertext with a random IV in front. What separates the resulting file from one qpdf wrote is
 * its `/Encrypt` dictionary and nothing else — which is exactly why the result can be handed back
 * to qpdf to be checked (`toStandardHandler`, and `test/unit/security/pubsec.test.ts`).
 *
 * Four things are never encrypted, and each of them would break the file if it were:
 *
 * - the `/Encrypt` dictionary itself, which is added after this pass;
 * - the `/ID` strings in the trailer, which pdf-lib writes and we do not touch;
 * - cross-reference streams, which a reader must parse before it knows there is encryption;
 * - the metadata stream, when the reader asked to leave metadata in the clear.
 *
 * **No object streams.** pdf-lib builds those when it saves, which is after this pass has run —
 * and a string inside an object stream must not be encrypted separately from the stream holding
 * it, so a file written both ways would have its strings encrypted twice.
 */

import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  PDFString,
  type PDFContext,
  type PDFObject,
} from 'pdf-lib';
import { permissionsToP } from '../permissions';
import {
  ALL_ALLOWED,
  SecurityError,
  type EncryptionScope,
  type PermissionFlags,
  type Recipient,
} from '../types';
import { aesEncryptContent, randomBytes, toHex } from './crypto';
import { sealRecipients } from './envelope';
import { buildStandardR6 } from './standard';

/** What one pass over the object graph should touch. */
interface WalkOptions {
  /** Whether to encrypt strings. False for the attachments-only arrangement. */
  readonly strings: boolean;
  /** Which streams to encrypt. */
  readonly stream: (dict: PDFDict, ref: PDFRef) => boolean;
}

export interface EncryptResult {
  readonly bytes: Uint8Array;
  /**
   * The file key. Returned so a caller can prove the file is right by swapping in a standard
   * handler — see {@link toStandardHandler}. Nothing stores it; drop it when finished.
   */
  readonly fileKey: Uint8Array;
  /** The `/P` written into the document's dictionary. */
  readonly permissions: number;
  readonly warnings: ReadonlyArray<string>;
}

export interface PubSecOptions {
  readonly recipients: ReadonlyArray<Recipient>;
  readonly scope: EncryptionScope;
  /** Injected by the tests so a sealed document is reproducible. */
  readonly seed?: Uint8Array;
}

/** Encrypts `bytes` to `recipients`. The input must be an unencrypted PDF. */
export async function encryptToRecipients(
  bytes: Uint8Array,
  options: PubSecOptions,
): Promise<EncryptResult> {
  const encryptMetadata = options.scope !== 'except-metadata';
  const attachmentsOnly = options.scope === 'attachments-only';
  const sealed = sealRecipients({
    recipients: options.recipients,
    encryptMetadata,
    ...(options.seed ? { seed: options.seed } : {}),
  });
  const permissions = permissionsToP(options.recipients[0]?.permissions ?? ALL_ALLOWED);

  const { doc, context, warnings } = await walk(bytes, sealed.fileKey, {
    strings: !attachmentsOnly,
    stream: attachmentsOnly ? isEmbeddedFile : everythingBut(encryptMetadata),
  });

  const dict = buildPubSecDict(context, {
    blobs: sealed.blobs,
    encryptMetadata,
    permissions,
    attachmentsOnly,
  });
  ensureFileId(context);
  context.trailerInfo.Encrypt = context.register(dict);
  return {
    bytes: await save(doc),
    fileKey: sealed.fileKey,
    permissions,
    warnings,
  };
}

/**
 * The `/EFF` arrangement: the document reads without a password and only its embedded files are
 * encrypted, so a covering note can be read by anyone and the attachment cannot.
 *
 * qpdf has no option for this, and it is not a variation on one — `/StmF` and `/StrF` are
 * `/Identity`, which means the *only* encrypted objects in the file are the embedded file
 * streams. So the key is ours to choose and the walk is a two-line predicate.
 */
export async function encryptAttachmentsOnly(
  bytes: Uint8Array,
  options: {
    readonly permissions: PermissionFlags;
    readonly userPassword: string;
    readonly ownerPassword: string;
  },
): Promise<EncryptResult> {
  const fileKey = randomBytes(32);
  const permissions = permissionsToP(options.permissions);
  const { doc, context, warnings, touched } = await walk(bytes, fileKey, {
    strings: false,
    stream: isEmbeddedFile,
  });
  if (touched === 0) {
    warnings.push(
      'The document has no file attachments, so "encrypt only file attachments" protected nothing.',
    );
  }
  const strings = buildStandardR6({
    fileKey,
    // Both passwords wrap the same key; an empty user password is what lets the document open.
    password: options.userPassword,
    permissions,
    encryptMetadata: true,
  });
  const owner =
    options.ownerPassword === '' || options.ownerPassword === options.userPassword
      ? null
      : buildStandardR6({
          fileKey,
          password: options.ownerPassword,
          permissions,
          encryptMetadata: true,
        });

  const filter = context.obj({});
  filter.set(PDFName.of('CFM'), PDFName.of('AESV3'));
  filter.set(PDFName.of('Length'), PDFNumber.of(32));
  const cf = context.obj({});
  cf.set(PDFName.of('StdCF'), filter);

  const dict = context.obj({});
  dict.set(PDFName.of('Filter'), PDFName.of('Standard'));
  dict.set(PDFName.of('V'), PDFNumber.of(5));
  dict.set(PDFName.of('R'), PDFNumber.of(6));
  dict.set(PDFName.of('Length'), PDFNumber.of(256));
  dict.set(PDFName.of('P'), PDFNumber.of(permissions));
  dict.set(PDFName.of('CF'), cf);
  dict.set(PDFName.of('StmF'), PDFName.of('Identity'));
  dict.set(PDFName.of('StrF'), PDFName.of('Identity'));
  dict.set(PDFName.of('EFF'), PDFName.of('StdCF'));
  dict.set(PDFName.of('U'), PDFHexString.of(toHex(strings.u)));
  dict.set(PDFName.of('UE'), PDFHexString.of(toHex(strings.ue)));
  dict.set(PDFName.of('O'), PDFHexString.of(toHex((owner ?? strings).o)));
  dict.set(PDFName.of('OE'), PDFHexString.of(toHex((owner ?? strings).oe)));
  dict.set(PDFName.of('Perms'), PDFHexString.of(toHex(strings.perms)));
  dict.set(PDFName.of('EncryptMetadata'), context.obj(true));
  ensureFileId(context);
  context.trailerInfo.Encrypt = context.register(dict);

  return { bytes: await save(doc), fileKey, permissions, warnings };
}

/**
 * Makes sure the trailer has an `/ID`, which the spec requires of every encrypted document and
 * which pdf-lib will not invent.
 *
 * The document's own id is kept when it has one — the brief asks for that, and a changed id makes
 * a viewer treat the file as a different document, losing its place and its comments. When there
 * is none, one is generated: a file with `/Encrypt` and no `/ID` is malformed, and qpdf says so.
 * The `/ID` strings are never encrypted, which is why this happens in the trailer and not in the
 * walk above.
 */
function ensureFileId(context: PDFContext): void {
  const existing = context.trailerInfo.ID;
  if (existing instanceof PDFArray && existing.size() === 2) return;
  const id = PDFHexString.of(toHex(randomBytes(16)));
  const array = PDFArray.withContext(context);
  array.push(id);
  array.push(id);
  context.trailerInfo.ID = array;
}

// ---- the walk -----------------------------------------------------------------------------------

interface Walked {
  readonly doc: PDFDocument;
  readonly context: PDFContext;
  readonly warnings: string[];
  /** How many streams were encrypted. */
  readonly touched: number;
}

async function walk(bytes: Uint8Array, key: Uint8Array, options: WalkOptions): Promise<Walked> {
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  } catch (error) {
    throw new SecurityError(
      'damaged',
      'The document could not be read to protect it.',
      error instanceof Error ? error.message : String(error),
    );
  }
  const context = doc.context;
  const warnings: string[] = [];
  let touched = 0;

  for (const [ref, object] of context.enumerateIndirectObjects()) {
    if (object instanceof PDFRawStream) {
      // A stream's dictionary carries strings even when its body is left alone.
      if (options.strings) await encryptStrings(object.dict, key);
      if (!options.stream(object.dict, ref)) continue;
      // `contents` is readonly, so the stream is replaced rather than mutated — which is also the
      // honest description of what happened to it.
      const encrypted = await aesEncryptContent(key, object.contents);
      object.dict.set(PDFName.of('Length'), PDFNumber.of(encrypted.length));
      context.assign(ref, PDFRawStream.of(object.dict, encrypted));
      touched++;
    } else if (options.strings) {
      await encryptStrings(object, key);
    }
  }
  return { doc, context, warnings, touched };
}

function save(doc: PDFDocument): Promise<Uint8Array> {
  // `useObjectStreams: false` is required, not a preference. See the note at the top of the file.
  return doc.save({ useObjectStreams: false, updateFieldAppearances: false });
}

/** `/Type /EmbeddedFile` — the streams the `/EFF` arrangement protects. */
function isEmbeddedFile(dict: PDFDict): boolean {
  const type = dict.get(PDFName.of('Type'));
  return type instanceof PDFName && type.asString() === '/EmbeddedFile';
}

/**
 * Everything except cross-reference streams, and except the metadata stream when the reader asked
 * for metadata to stay readable.
 *
 * The catalogue's `/Metadata` reference is looked up on the first call rather than up front,
 * because the predicate is built before the document has been parsed.
 */
function everythingBut(encryptMetadata: boolean): (dict: PDFDict, ref: PDFRef) => boolean {
  let metadata: PDFRef | null = null;
  let resolved = false;
  return (dict, ref) => {
    const type = dict.get(PDFName.of('Type'));
    if (type instanceof PDFName && type.asString() === '/XRef') return false;
    if (encryptMetadata) return true;
    if (!resolved) {
      resolved = true;
      const context = (dict as unknown as { context: PDFContext }).context;
      const root = context.lookup(context.trailerInfo.Root);
      const found = root instanceof PDFDict ? root.get(PDFName.of('Metadata')) : undefined;
      metadata = found instanceof PDFRef ? found : null;
    }
    return metadata === null || !refsEqual(metadata, ref);
  };
}

function refsEqual(a: PDFRef, b: PDFRef): boolean {
  return a.objectNumber === b.objectNumber && a.generationNumber === b.generationNumber;
}

/**
 * Encrypts every string reachable from `object` without following indirect references — each
 * indirect object is visited once by the caller, so following them here would encrypt a shared
 * string twice.
 */
async function encryptStrings(object: PDFObject, key: Uint8Array, depth = 0): Promise<void> {
  if (depth > 64) return;
  if (object instanceof PDFArray) {
    for (let i = 0; i < object.size(); i++) {
      const child = object.get(i);
      const replaced = await encryptedString(child, key);
      if (replaced) object.set(i, replaced);
      else await encryptStrings(child, key, depth + 1);
    }
    return;
  }
  if (object instanceof PDFDict) {
    for (const [name, value] of object.entries()) {
      const replaced = await encryptedString(value, key);
      if (replaced) object.set(name, replaced);
      else await encryptStrings(value, key, depth + 1);
    }
  }
}

/** The encrypted form of a string object, or `null` when this object is not a string. */
async function encryptedString(object: PDFObject, key: Uint8Array): Promise<PDFHexString | null> {
  if (object instanceof PDFHexString) {
    return PDFHexString.of(toHex(await aesEncryptContent(key, object.asBytes())));
  }
  if (object instanceof PDFString) {
    return PDFHexString.of(toHex(await aesEncryptContent(key, literalBytes(object))));
  }
  return null;
}

/**
 * The bytes a literal string stands for.
 *
 * pdf-lib 1.17's `PDFString` has no `asBytes()`, and `asString()` returns the source text with its
 * parentheses and escapes intact — so the escapes are undone here, or a document containing `\(`
 * would be encrypted as two characters instead of the one it means.
 */
function literalBytes(string: PDFString): Uint8Array {
  const source = string.asString();
  const inner = source.startsWith('(') && source.endsWith(')') ? source.slice(1, -1) : source;
  const out: number[] = [];
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i] ?? '';
    if (c !== '\\') {
      out.push(inner.charCodeAt(i) & 0xff);
      continue;
    }
    const next = inner[++i] ?? '';
    switch (next) {
      case 'n':
        out.push(0x0a);
        break;
      case 'r':
        out.push(0x0d);
        break;
      case 't':
        out.push(0x09);
        break;
      case 'b':
        out.push(0x08);
        break;
      case 'f':
        out.push(0x0c);
        break;
      case '\n':
        break; // a line continuation contributes nothing
      default: {
        if (next >= '0' && next <= '7') {
          let octal = next;
          while (octal.length < 3) {
            const digit = inner[i + 1] ?? '';
            if (digit < '0' || digit > '7') break;
            octal += digit;
            i++;
          }
          out.push(Number.parseInt(octal, 8) & 0xff);
        } else {
          out.push(next.charCodeAt(0) & 0xff);
        }
      }
    }
  }
  return Uint8Array.from(out);
}

/** The `/Encrypt` dictionary for the public-key handler. */
function buildPubSecDict(
  context: PDFContext,
  options: {
    readonly blobs: ReadonlyArray<Uint8Array>;
    readonly encryptMetadata: boolean;
    readonly permissions: number;
    readonly attachmentsOnly: boolean;
  },
): PDFDict {
  const recipients = PDFArray.withContext(context);
  for (const blob of options.blobs) recipients.push(PDFHexString.of(toHex(blob)));

  const filter = context.obj({});
  filter.set(PDFName.of('CFM'), PDFName.of('AESV3'));
  filter.set(PDFName.of('Length'), PDFNumber.of(32));
  filter.set(PDFName.of('Recipients'), recipients);
  filter.set(PDFName.of('EncryptMetadata'), context.obj(options.encryptMetadata));

  const cf = context.obj({});
  cf.set(PDFName.of('DefaultCryptFilter'), filter);

  const dict = context.obj({});
  dict.set(PDFName.of('Filter'), PDFName.of('Adobe.PubSec'));
  dict.set(PDFName.of('SubFilter'), PDFName.of('adbe.pkcs7.s5'));
  dict.set(PDFName.of('V'), PDFNumber.of(5));
  dict.set(PDFName.of('R'), PDFNumber.of(6));
  dict.set(PDFName.of('Length'), PDFNumber.of(256));
  dict.set(PDFName.of('P'), PDFNumber.of(options.permissions));
  dict.set(PDFName.of('CF'), cf);
  if (options.attachmentsOnly) {
    dict.set(PDFName.of('StmF'), PDFName.of('Identity'));
    dict.set(PDFName.of('StrF'), PDFName.of('Identity'));
    dict.set(PDFName.of('EFF'), PDFName.of('DefaultCryptFilter'));
  } else {
    dict.set(PDFName.of('StmF'), PDFName.of('DefaultCryptFilter'));
    dict.set(PDFName.of('StrF'), PDFName.of('DefaultCryptFilter'));
  }
  dict.set(PDFName.of('EncryptMetadata'), context.obj(options.encryptMetadata));
  return dict;
}

/**
 * Rewrites a document's `/Encrypt` dictionary as a standard-handler one wrapping the same file key
 * under `password`, leaving every encrypted byte alone.
 *
 * This is how the tests prove the encryption above is right: qpdf reads the result and validates
 * every stream in it. It is *not* how the app opens a certificate-protected file — that has to
 * work on documents pdf-lib cannot parse, and does the same swap at the byte level in
 * `decrypt.ts`.
 */
export async function toStandardHandler(
  bytes: Uint8Array,
  options: {
    readonly fileKey: Uint8Array;
    readonly password: string;
    readonly permissions: number;
    readonly encryptMetadata: boolean;
  },
): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  const context = doc.context;
  const strings = buildStandardR6(options);

  const filter = context.obj({});
  filter.set(PDFName.of('CFM'), PDFName.of('AESV3'));
  filter.set(PDFName.of('Length'), PDFNumber.of(32));
  const cf = context.obj({});
  cf.set(PDFName.of('StdCF'), filter);

  const dict = context.obj({});
  dict.set(PDFName.of('Filter'), PDFName.of('Standard'));
  dict.set(PDFName.of('V'), PDFNumber.of(5));
  dict.set(PDFName.of('R'), PDFNumber.of(6));
  dict.set(PDFName.of('Length'), PDFNumber.of(256));
  dict.set(PDFName.of('P'), PDFNumber.of(options.permissions));
  dict.set(PDFName.of('CF'), cf);
  dict.set(PDFName.of('StmF'), PDFName.of('StdCF'));
  dict.set(PDFName.of('StrF'), PDFName.of('StdCF'));
  dict.set(PDFName.of('U'), PDFHexString.of(toHex(strings.u)));
  dict.set(PDFName.of('UE'), PDFHexString.of(toHex(strings.ue)));
  dict.set(PDFName.of('O'), PDFHexString.of(toHex(strings.o)));
  dict.set(PDFName.of('OE'), PDFHexString.of(toHex(strings.oe)));
  dict.set(PDFName.of('Perms'), PDFHexString.of(toHex(strings.perms)));
  dict.set(PDFName.of('EncryptMetadata'), context.obj(options.encryptMetadata));

  ensureFileId(context);
  const previous = context.trailerInfo.Encrypt;
  if (previous instanceof PDFRef) context.assign(previous, dict);
  else context.trailerInfo.Encrypt = context.register(dict);
  return save(doc);
}

/**
 * The public-key security handler's envelopes and file key (M70, ISO 32000-2 §7.6.5).
 *
 * The shape of it: one 20-byte seed is generated for the document and sealed to each recipient in
 * a CMS enveloped-data structure, together with **that recipient's own four permission bytes** —
 * which is the whole mechanism behind per-recipient permissions, and the reason they cost nothing
 * extra. The file key is then the hash of the seed followed by every sealed blob in the order
 * `/Recipients` lists them.
 *
 * That ordering matters and is easy to get wrong: the hash is over the *ciphertext*, so the array
 * written into the file and the array hashed here must be the same array in the same order. They
 * are produced together by {@link sealRecipients} for exactly that reason.
 */

import forge from 'node-forge';
import { SecurityError, type Recipient } from '../types';
import { permissionsToP } from '../permissions';
import { certificateFromDer } from './certificates';
import { concat, fromBinary, randomBytes, sha1, sha256, toBinary } from './crypto';

/** What the recipients produced: the blobs to write, and the key they imply. */
export interface SealedRecipients {
  /** DER of each recipient's CMS enveloped-data, in the order `/Recipients` must list them. */
  readonly blobs: ReadonlyArray<Uint8Array>;
  /** The file encryption key. 32 bytes for AESV3. */
  readonly fileKey: Uint8Array;
}

/**
 * The four permission bytes that go in the envelope.
 *
 * The spec asks for `/P` as a **big-endian** 4-byte value here, which is the opposite of the
 * little-endian `/Perms` block in the standard handler. Getting this backwards produces a file
 * that opens perfectly and grants the wrong permissions, which is worse than one that fails, so
 * it has a test of its own.
 */
export function permissionBytes(p: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setInt32(0, p | 0, false);
  return out;
}

/** Reads them back. */
export function readPermissionBytes(bytes: Uint8Array): number {
  return new DataView(bytes.buffer, bytes.byteOffset, 4).getInt32(0, false);
}

/**
 * Seals a fresh seed to every recipient.
 *
 * AES-256 for the content encryption inside each envelope, and the recipient's RSA public key for
 * the key transport. `algorithm` decides the digest the file key is derived with — SHA-256 for
 * AESV3, SHA-1 for the older modes, which this app does not write but can read.
 */
export function sealRecipients(options: {
  readonly recipients: ReadonlyArray<Recipient>;
  readonly encryptMetadata: boolean;
  readonly digest?: 'sha256' | 'sha1';
  /** Injected by the tests so a sealed document is reproducible. */
  readonly seed?: Uint8Array;
}): SealedRecipients {
  if (options.recipients.length === 0) {
    throw new SecurityError(
      'bad-certificate',
      'A certificate-protected document needs at least one recipient.',
    );
  }
  const seed = options.seed ?? randomBytes(20);
  const blobs = options.recipients.map((recipient) => {
    const cert = certificateFromDer(recipient.certificate);
    const envelope = forge.pkcs7.createEnvelopedData();
    try {
      envelope.addRecipient(cert);
    } catch (error) {
      throw new SecurityError(
        'bad-certificate',
        `${recipient.name}'s certificate cannot be used to encrypt to. It needs an RSA key that allows key encipherment.`,
        error instanceof Error ? error.message : String(error),
      );
    }
    const payload = concat(seed, permissionBytes(permissionsToP(recipient.permissions)));
    envelope.content = forge.util.createBuffer(toBinary(payload));
    envelope.encrypt(undefined, forge.pki.oids['aes256-CBC']);
    return fromBinary(forge.asn1.toDer(envelope.toAsn1()).getBytes());
  });
  return { blobs, fileKey: deriveFileKey(seed, blobs, options) };
}

/**
 * The file key: `digest(seed ‖ blob₁ ‖ blob₂ ‖ … ‖ FFFFFFFF when metadata is in the clear)`,
 * truncated to the key length.
 */
export function deriveFileKey(
  seed: Uint8Array,
  blobs: ReadonlyArray<Uint8Array>,
  options: { readonly encryptMetadata: boolean; readonly digest?: 'sha256' | 'sha1' },
): Uint8Array {
  const parts: Uint8Array[] = [seed, ...blobs];
  if (!options.encryptMetadata) parts.push(new Uint8Array([0xff, 0xff, 0xff, 0xff]));
  return options.digest === 'sha1' ? sha1(...parts).subarray(0, 16) : sha256(...parts);
}

/** What a recipient's private key got us back out of the envelope. */
export interface OpenedEnvelope {
  readonly seed: Uint8Array;
  /** `/P` for this recipient, as the envelope stated it. */
  readonly permissions: number;
  /** Index of the blob in `/Recipients` that opened. */
  readonly index: number;
}

/**
 * Tries every blob with one private key and returns the first that opens.
 *
 * Every blob is tried rather than the one matching the certificate, because a `.p12` may hold a
 * key whose certificate is a re-issue of the one the document was encrypted to — same key, new
 * certificate, different serial — and refusing that would be an unhelpful kind of correct.
 */
export function openEnvelopes(
  blobs: ReadonlyArray<Uint8Array>,
  privateKey: forge.pki.PrivateKey,
): OpenedEnvelope | null {
  for (const [index, blob] of blobs.entries()) {
    const opened = tryOne(blob, privateKey, index);
    if (opened) return opened;
  }
  return null;
}

function tryOne(
  blob: Uint8Array,
  privateKey: forge.pki.PrivateKey,
  index: number,
): OpenedEnvelope | null {
  let message: forge.pkcs7.PkcsEnvelopedData;
  try {
    message = forge.pkcs7.messageFromAsn1(
      forge.asn1.fromDer(forge.util.createBuffer(toBinary(blob))),
    ) as forge.pkcs7.PkcsEnvelopedData;
  } catch {
    return null;
  }
  const recipients = message.recipients ?? [];
  for (const recipient of recipients) {
    try {
      message.decrypt(recipient, privateKey as forge.pki.rsa.PrivateKey);
    } catch {
      continue;
    }
    const content = message.content;
    if (!content) continue;
    const bytes = fromBinary(typeof content === 'string' ? content : content.getBytes());
    // 20 bytes of seed and 4 of permissions. Some producers append nothing else; some append
    // extensions we do not need, so a longer payload is fine and a shorter one is not.
    if (bytes.length < 24) continue;
    return {
      seed: bytes.subarray(0, 20),
      permissions: readPermissionBytes(bytes.subarray(20, 24)),
      index,
    };
  }
  return null;
}

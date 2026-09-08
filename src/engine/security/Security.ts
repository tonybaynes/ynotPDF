/**
 * `Security` — the engine-level answer to every security question the app has (M70).
 *
 * Four operations, and nothing above this file needs to know which of them qpdf performs and
 * which we perform ourselves (ADR 0012):
 *
 * - {@link Security.inspect} — what a file's protection actually is.
 * - {@link Security.protect} — put protection on a document.
 * - {@link Security.remove} — take it off.
 * - {@link Security.unlockWithDigitalId} — open a certificate-protected file with a `.p12`.
 *
 * There is no UI here and no model: bytes in, bytes out, plus values from `types.ts`. That is what
 * lets M120 run the identical code over a batch with no window open, and what lets every one of
 * these be tested against qpdf in a plain Node process.
 */

import { encryptArgs, needsWeakCryptoFlag, pToPermissions } from './permissions';
import { encryptAttachmentsOnly, encryptToRecipients } from './pubsec/encrypt';
import { isCertificateEncrypted, readPubSecHeader, unlockWithPrivateKey } from './pubsec/decrypt';
import { desummarise, loadKeyPair, summarise, toRecipient } from './pubsec/certificates';
import {
  boolOf,
  dictOf,
  findEncryptDict,
  lastStartXref,
  nameOf,
  numberOf,
  readTrailer,
  recipientBlobs,
  type PdfValue,
} from './pubsec/syntax';
import { certificateFromDer } from './pubsec/certificates';
import { warningsFrom, type Qpdf } from './qpdf';
import {
  ALL_ALLOWED,
  SecurityError,
  UNENCRYPTED,
  type EncryptionAlgorithm,
  type PermissionFlags,
  type Recipient,
  type RecipientSummary,
  type SecurityInfo,
  type SecurityIntent,
  type Secrets,
} from './types';

/** What {@link Security.protect} produced. */
export interface ProtectResult {
  readonly bytes: Uint8Array;
  /** Things worth telling the reader, in plain words. Never a reason to fail the save. */
  readonly warnings: ReadonlyArray<string>;
}

/** What a `.p12` got us into. */
export interface UnlockResult {
  /** The document, decrypted. */
  readonly bytes: Uint8Array;
  /** What this recipient's own envelope allows them to do. */
  readonly permissions: PermissionFlags;
  /** The certificate the key belongs to, for the "opened as" line in Properties. */
  readonly openedAs: string;
}

export class Security {
  private readonly qpdf: Qpdf;

  constructor(qpdf: Qpdf) {
    this.qpdf = qpdf;
  }

  /**
   * Reads a file's `/Encrypt` dictionary.
   *
   * The dictionary is plaintext even in an encrypted document — a reader has to find it before it
   * can decrypt anything — so the algorithm, the revision, `/P` and whether metadata is encrypted
   * are read straight out of the bytes, which is exact. qpdf is asked one thing on top of that,
   * and only when a password was supplied: whether that password is the user's or the owner's,
   * which is not in the file and which decides whether permissions bite (`allows`, in the
   * renderer).
   */
  async inspect(bytes: Uint8Array): Promise<SecurityInfo> {
    const startXref = lastStartXref(bytes);
    const trailer = startXref === null ? null : readTrailer(bytes, startXref);
    const found = trailer ? findEncryptDict(bytes, trailer) : findEncryptDict(bytes);
    if (!found) return UNENCRYPTED;

    const filter = nameOf(found.entries, 'Filter');
    const handler = filter === 'Adobe.PubSec' ? 'public-key' : 'standard';
    const rawPermissions = numberOf(found.entries, 'P') ?? -1;
    const revision = numberOf(found.entries, 'R');
    const metadataEncrypted = boolOf(found.entries, 'EncryptMetadata', true);
    const recipients =
      handler === 'public-key' ? describeRecipients(recipientBlobs(found.entries)) : [];

    return {
      encrypted: true,
      handler,
      algorithm: algorithmOf(found.entries, revision),
      revision,
      rawPermissions,
      permissions: pToPermissions(rawPermissions),
      opensWithoutPassword:
        handler === 'public-key' ? false : await this.opensWithoutPassword(bytes),
      metadataEncrypted,
      recipients,
    };
  }

  /** Whether the file opens with no password at all. */
  private async opensWithoutPassword(bytes: Uint8Array): Promise<boolean> {
    const run = await this.qpdf.run(['--show-encryption', 'in.pdf'], { 'in.pdf': bytes });
    return run.code === 0;
  }

  /**
   * Whether `password` is this file's *owner* password.
   *
   * qpdf says so in words, and the distinction is the whole of permission enforcement: a document
   * opened with the user password has its `/P` flags respected, and one opened with the owner
   * password does not.
   */
  async isOwnerPassword(bytes: Uint8Array, password: string): Promise<boolean> {
    const run = await this.qpdf.run(['--show-encryption', `--password=${password}`, 'in.pdf'], {
      'in.pdf': bytes,
    });
    if (run.code !== 0) return false;
    return /Supplied password is owner password/i.test(run.output);
  }

  /**
   * Puts protection on an unencrypted document.
   *
   * Password protection is qpdf's, entirely. The two arrangements qpdf has no option for —
   * certificate recipients, and encrypting only the file attachments — go through our own pass
   * (ADR 0012), which produces a file qpdf can then read back.
   */
  async protect(
    bytes: Uint8Array,
    intent: SecurityIntent,
    secrets: Secrets = {},
  ): Promise<ProtectResult> {
    if (intent.kind === 'none') return { bytes, warnings: [] };

    if (intent.kind === 'certificate') {
      const recipients = intent.recipients.map(desummarise);
      const result = await encryptToRecipients(bytes, {
        recipients,
        scope: intent.scope,
      });
      return { bytes: result.bytes, warnings: result.warnings };
    }

    const user = secrets.user ?? '';
    const owner = secrets.owner ?? '';
    if (user === '' && owner === '') {
      throw new SecurityError(
        'failed',
        'Password protection needs an open password, a permissions password, or both.',
      );
    }

    if (intent.scope === 'attachments-only') {
      const result = await encryptAttachmentsOnly(bytes, {
        permissions: intent.permissions,
        userPassword: user,
        ownerPassword: owner,
      });
      return { bytes: result.bytes, warnings: result.warnings };
    }

    const args: string[] = [];
    if (needsWeakCryptoFlag(intent.algorithm)) args.push('--allow-weak-crypto');
    args.push(
      ...encryptArgs({
        algorithm: intent.algorithm,
        permissions: intent.permissions,
        scope: intent.scope,
        userPassword: user,
        ownerPassword: owner,
      }),
      'in.pdf',
      'out.pdf',
    );
    const run = await this.qpdf.expect(args, { 'in.pdf': bytes }, ['out.pdf']);
    const out = run.files.get('out.pdf');
    if (!out) {
      throw new SecurityError('failed', 'The document could not be protected.', run.output);
    }
    return { bytes: out, warnings: warningsFrom(run.output) };
  }

  /**
   * Takes protection off, with the owner password.
   *
   * A certificate-protected file needs its `.p12` instead, so this refuses one by name rather
   * than telling the reader their password is wrong when they never had one.
   */
  async remove(bytes: Uint8Array, password: string): Promise<ProtectResult> {
    if (isCertificateEncrypted(bytes)) {
      throw new SecurityError(
        'not-a-recipient',
        'This document is protected with certificates. Open it with your digital ID first, then remove the protection.',
      );
    }
    const run = await this.qpdf.expect(
      ['--decrypt', `--password=${password}`, 'in.pdf', 'out.pdf'],
      { 'in.pdf': bytes },
      ['out.pdf'],
    );
    const out = run.files.get('out.pdf');
    if (!out) {
      throw new SecurityError('failed', 'The protection could not be removed.', run.output);
    }
    return { bytes: out, warnings: warningsFrom(run.output) };
  }

  /**
   * Decrypts a document with a password, for the save pipeline: M21 hands the writer plaintext,
   * and a protected document has to be made plaintext first.
   */
  async decrypt(bytes: Uint8Array, password: string): Promise<Uint8Array> {
    const result = await this.remove(bytes, password);
    return result.bytes;
  }

  /**
   * Opens a certificate-protected document with a `.p12`.
   *
   * Two steps, and neither of them parses the document: recover the file key from the recipient's
   * envelope, append a standard-handler dictionary wrapping it, and let qpdf decrypt (ADR 0012).
   */
  async unlockWithDigitalId(
    bytes: Uint8Array,
    p12: Uint8Array,
    p12Password: string,
  ): Promise<UnlockResult> {
    const keyPair = loadKeyPair(p12, p12Password);
    const unlocked = unlockWithPrivateKey(bytes, keyPair.privateKey);
    const run = await this.qpdf.expect(
      ['--decrypt', `--password=${unlocked.password}`, 'in.pdf', 'out.pdf'],
      { 'in.pdf': unlocked.bytes },
      ['out.pdf'],
    );
    const out = run.files.get('out.pdf');
    if (!out) {
      throw new SecurityError(
        'failed',
        'The document was unlocked but could not be read.',
        run.output,
      );
    }
    return {
      bytes: out,
      permissions: pToPermissions(unlocked.permissions),
      openedAs: keyPair.certificate.name,
    };
  }

  /** Whether these bytes are a certificate-protected document. */
  isCertificateProtected(bytes: Uint8Array): boolean {
    return isCertificateEncrypted(bytes);
  }

  /** The recipients of a certificate-protected document, without opening it. */
  recipientsOf(bytes: Uint8Array): ReadonlyArray<RecipientSummary> {
    const header = readPubSecHeader(bytes);
    return header ? describeRecipients(header.blobs) : [];
  }

  /** qpdf's version, for the About box. */
  version(): Promise<string> {
    return this.qpdf.version();
  }
}

/**
 * What the recipients of a file are, read from the envelopes without opening any of them.
 *
 * A CMS envelope names its recipients by issuer and serial number, not by certificate — the
 * certificate is the recipient's, not the document's — so this is what a file can honestly say
 * about who it was encrypted for: how many, and (when the envelope carries them) their issuers.
 */
function describeRecipients(blobs: ReadonlyArray<Uint8Array>): RecipientSummary[] {
  return blobs.map((_blob, index) =>
    summarise(
      toRecipient(
        {
          name: `Recipient ${String(index + 1)}`,
          issuer: 'named in the sealed envelope',
          serial: '—',
          validFrom: '',
          validTo: '',
          der: new Uint8Array(0),
          expired: false,
        },
        ALL_ALLOWED,
        `envelope-${String(index)}`,
      ),
    ),
  );
}

/**
 * The algorithm a dictionary describes.
 *
 * `/V` says most of it; for `/V 4` the method is in whichever crypt filter `/StmF` names, because
 * that revision made the cipher a property of the filter rather than of the document.
 */
function algorithmOf(
  entries: ReadonlyMap<string, PdfValue>,
  revision: number | null,
): EncryptionAlgorithm | null {
  const v = numberOf(entries, 'V');
  if (v === 5) return 'aes-256';
  if (v === 4) {
    const cfm = cryptFilterMethod(entries);
    if (cfm === 'AESV2') return 'aes-128';
    if (cfm === 'AESV3') return 'aes-256';
    return 'rc4-128';
  }
  if (revision === 2 || v === 1) return 'rc4-40';
  return 'rc4-128';
}

/** `/CF`'s `/CFM`, preferring the filter `/StmF` names. */
function cryptFilterMethod(entries: ReadonlyMap<string, PdfValue>): string | null {
  const cf = dictOf(entries, 'CF');
  if (!cf) return null;
  const preferred = nameOf(entries, 'StmF');
  const names = preferred ? [preferred, ...cf.keys()] : [...cf.keys()];
  for (const name of names) {
    const filter = dictOf(cf, name);
    const cfm = filter ? nameOf(filter, 'CFM') : null;
    if (cfm) return cfm;
  }
  return null;
}

export { certificateFromDer, desummarise, summarise, toRecipient };
export type { Recipient };

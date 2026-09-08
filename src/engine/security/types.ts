/**
 * The vocabulary of document security (M70): what a file's protection *is*, in terms this app
 * uses everywhere — the dialog, the model's intent, the save pipeline stage, batch, and the
 * Security tab in Properties.
 *
 * Nothing here is a password. Passwords and private keys travel as separate arguments to the one
 * or two functions that need them and are never part of a value that could be stored, journaled
 * or logged (ADR 0012).
 *
 * Geometry of the `/P` bitfield and the algorithm names follow ISO 32000 §7.6; the conversions
 * live in `permissions.ts` and are tested against qpdf's own `--show-encryption`.
 */

import type { CommandPermission } from '@shared/module';

/**
 * How the file is encrypted. These are the four the Protect dialog offers, mirroring Foxit 14.
 *
 * `rc4-128` and `aes-128` exist for files that must be *opened* by software older than 2008 and
 * are marked as weak in the dialog with a word, not a colour. New protection should be
 * `aes-256`, which is the default everywhere.
 */
export type EncryptionAlgorithm = 'aes-256' | 'aes-128' | 'rc4-128' | 'rc4-40';

/** Human names, for dialogs and the Properties tab. Never derive these from the id in the UI. */
export const ALGORITHM_LABELS: Readonly<Record<EncryptionAlgorithm, string>> = {
  'aes-256': '256-bit AES',
  'aes-128': '128-bit AES',
  'rc4-128': '128-bit RC4 (compatibility)',
  'rc4-40': '40-bit RC4 (compatibility)',
};

/** Whether an algorithm is one we would recommend today. Drives the dialog's worded caution. */
export function isWeakAlgorithm(algorithm: EncryptionAlgorithm): boolean {
  return algorithm !== 'aes-256';
}

/** Key length in bits. */
export function algorithmBits(algorithm: EncryptionAlgorithm): 40 | 128 | 256 {
  switch (algorithm) {
    case 'aes-256':
      return 256;
    case 'rc4-40':
      return 40;
    default:
      return 128;
  }
}

/**
 * How much printing is allowed. The PDF spec spends two bits on this: bit 3 is "print at all"
 * and bit 12 is "print at full resolution", and `low` is the combination that lets a reader
 * print a degraded copy.
 */
export type PrintPermission = 'none' | 'low' | 'high';

/**
 * What kind of change is allowed. Also two spec bits plus two more (bit 4 "modify", bit 6
 * "add or modify annotations", bit 9 "fill form fields", bit 11 "assemble"), collapsed into the
 * five choices Foxit offers because the twenty-odd combinations are not a decision anyone makes.
 */
export type ModifyPermission =
  'none' | 'assemble' | 'fill-and-sign' | 'comment-fill-and-sign' | 'all';

/** What the security handler allows, in the app's own words. */
export interface PermissionFlags {
  readonly print: PrintPermission;
  readonly modify: ModifyPermission;
  /** Bit 5: copying text and graphics. */
  readonly copy: boolean;
  /** Bit 10: extraction for accessibility. Deprecated in PDF 2.0 and ignored by most readers. */
  readonly accessibility: boolean;
}

/** Everything allowed — what an unencrypted document has, and the dialog's starting point. */
export const ALL_ALLOWED: PermissionFlags = {
  print: 'high',
  modify: 'all',
  copy: true,
  accessibility: true,
};

/** Nothing allowed beyond opening and reading. */
export const NONE_ALLOWED: PermissionFlags = {
  print: 'none',
  modify: 'none',
  copy: false,
  accessibility: true,
};

/**
 * Which parts of the file are encrypted (Foxit's "Encrypt all contents" / "Encrypt all except
 * metadata" / "Encrypt only file attachments").
 *
 * `attachments-only` is the PDF 2.0 `/EFF` arrangement: the document itself is readable and only
 * embedded files need the password. It exists so a covering note can be read without one.
 */
export type EncryptionScope = 'all' | 'except-metadata' | 'attachments-only';

export const SCOPE_LABELS: Readonly<Record<EncryptionScope, string>> = {
  all: 'Encrypt all document contents',
  'except-metadata': 'Encrypt all contents except metadata',
  'attachments-only': 'Encrypt only file attachments',
};

/**
 * One recipient of a certificate-encrypted document: a certificate, and what that person may do.
 *
 * `certificate` is the DER bytes of an X.509 certificate. `id` is our own stable handle for the
 * recipient inside one document — recipients are matched by it when the list is edited, so two
 * recipients holding the same certificate stay distinguishable.
 */
export interface Recipient {
  readonly id: string;
  /** Common name, or the subject line when there is no CN. For display only. */
  readonly name: string;
  /** Issuer common name, so two certificates with the same subject can be told apart. */
  readonly issuer: string;
  /** Serial number as uppercase hex. */
  readonly serial: string;
  /** ISO 8601. */
  readonly validFrom: string;
  readonly validTo: string;
  /** DER bytes of the certificate. */
  readonly certificate: Uint8Array;
  readonly permissions: PermissionFlags;
}

/** A recipient without its bytes — what the model stores and the dialog lists. */
export type RecipientSummary = Omit<Recipient, 'certificate'> & {
  /** Base64 DER, so the recipient survives the journal and a recovery replay. */
  readonly certificateBase64: string;
};

/**
 * What a document's protection should become. This is the value M70 hangs off the model and
 * hands to the save pipeline. It carries no password: `hasUserPassword` and `hasOwnerPassword`
 * say whether one was set, and the secrets themselves live only in `SecurityService`'s private
 * map (ADR 0012).
 */
export type SecurityIntent = PasswordIntent | CertificateIntent | NoSecurityIntent;

export interface PasswordIntent {
  readonly kind: 'password';
  readonly algorithm: EncryptionAlgorithm;
  readonly scope: EncryptionScope;
  readonly permissions: PermissionFlags;
  readonly hasUserPassword: boolean;
  readonly hasOwnerPassword: boolean;
}

export interface CertificateIntent {
  readonly kind: 'certificate';
  /** Always `aes-256`; the field is here so the Properties tab reads one shape (ADR 0012). */
  readonly algorithm: 'aes-256';
  readonly scope: EncryptionScope;
  readonly recipients: ReadonlyArray<RecipientSummary>;
}

export interface NoSecurityIntent {
  readonly kind: 'none';
}

export const NO_SECURITY: NoSecurityIntent = { kind: 'none' };

/** The passwords for one document, held in memory only and never serialised. */
export interface Secrets {
  /** Needed to open the file. Empty string and undefined both mean "no open password". */
  readonly user?: string;
  /** Needed to change permissions. */
  readonly owner?: string;
}

/**
 * What a file's `/Encrypt` dictionary actually says, read back from the bytes. This is the
 * *state*, as against `SecurityIntent`, which is what the reader asked for — the Security tab
 * shows this one.
 */
export interface SecurityInfo {
  readonly encrypted: boolean;
  /** `null` when the file is not encrypted. */
  readonly handler: 'standard' | 'public-key' | null;
  readonly algorithm: EncryptionAlgorithm | null;
  /** `/R`, the security handler revision. */
  readonly revision: number | null;
  /** `/P` as the file stores it (a negative 32-bit integer). */
  readonly rawPermissions: number | null;
  readonly permissions: PermissionFlags;
  /** True when the file can be opened with no password at all. */
  readonly opensWithoutPassword: boolean;
  /** True when metadata is left in the clear. */
  readonly metadataEncrypted: boolean;
  /** Recipients, when the handler is public-key. */
  readonly recipients: ReadonlyArray<RecipientSummary>;
}

export const UNENCRYPTED: SecurityInfo = {
  encrypted: false,
  handler: null,
  algorithm: null,
  revision: null,
  rawPermissions: null,
  permissions: ALL_ALLOWED,
  opensWithoutPassword: true,
  metadataEncrypted: false,
  recipients: [],
};

/**
 * Something the reader may want to do that a permission can forbid.
 *
 * The same list as `CommandPermission`, under the name the `/P` bitfield uses. It is declared in
 * the manifest contract rather than here because a command declares which permission governs it,
 * and one list is better than two that can drift.
 */
export type ProtectedAction = CommandPermission;

/** Raised when qpdf, or our own certificate code, refuses to do something. */
export class SecurityError extends Error {
  override readonly name = 'SecurityError';
  readonly code: SecurityErrorCode;
  /** qpdf's own stderr, when there is any. Never contains a password. */
  readonly detail: string;

  constructor(code: SecurityErrorCode, message: string, detail = '') {
    super(message);
    this.code = code;
    this.detail = detail;
  }
}

export type SecurityErrorCode =
  /** The password given does not open the file. */
  | 'wrong-password'
  /** The file needs a password and none was given. */
  | 'password-required'
  /** The private key given does not match any recipient. */
  | 'not-a-recipient'
  /** The `.p12` password is wrong, or the file is not a `.p12`. */
  | 'bad-key-file'
  /** The certificate file could not be read. */
  | 'bad-certificate'
  /** The document is damaged past the point qpdf will work on it. */
  | 'damaged'
  /** Something else qpdf said no to. */
  | 'failed';

/**
 * Building a **standard** security handler dictionary around a file key we already have (M70).
 *
 * This exists because of an asymmetry in qpdf: it will happily decrypt a file whose key it can
 * derive from a password, but it will not encrypt with a key of our choosing. Certificate
 * security gives us a file key that comes from the recipients rather than from a password — so
 * to let qpdf touch such a file at all, we wrap that same key under a throwaway password in a
 * `/Standard` R6 dictionary, which is a forward computation and entirely spec-defined.
 *
 * That single trick does two jobs (ADR 0012):
 *
 * - **Opening** a certificate-encrypted file: swap `/Adobe.PubSec` for `/Standard`, hand it to
 *   `qpdf --decrypt`, and qpdf parses the object streams, the cross-reference streams and the
 *   damage — none of which we then have to.
 * - **Testing** one we wrote: swap the same way and run `qpdf --check`, which decrypts and
 *   validates every stream in the document. If our content encryption were wrong by a byte, qpdf
 *   would say so.
 *
 * Algorithms 2.B, 8, 9 and 10 of ISO 32000-2 §7.6.4.3, in that order.
 */

import {
  aesCbcNoPad,
  aesEcbNoPad,
  concat,
  encodePassword,
  equalBytes,
  hash2b,
  randomBytes,
} from './crypto';

/** The five strings a revision-6 `/Encrypt` dictionary carries. */
export interface StandardR6Strings {
  /** 48 bytes: hash, validation salt, key salt. */
  readonly u: Uint8Array;
  /** 32 bytes: the file key wrapped under the user password. */
  readonly ue: Uint8Array;
  /** 48 bytes. */
  readonly o: Uint8Array;
  /** 32 bytes: the file key wrapped under the owner password. */
  readonly oe: Uint8Array;
  /** 16 bytes: the permissions, encrypted with the file key so they cannot be edited. */
  readonly perms: Uint8Array;
}

/**
 * Builds `/U`, `/UE`, `/O`, `/OE` and `/Perms` for a known file key.
 *
 * Both passwords are the same value here by design: the file this produces is a stepping stone
 * that never reaches disk, and giving it one password rather than two removes a way to get it
 * wrong. Where the two genuinely differ — a file the reader is protecting — qpdf writes the
 * dictionary itself and this function is not involved.
 */
export function buildStandardR6(options: {
  readonly fileKey: Uint8Array;
  readonly password: string;
  readonly permissions: number;
  readonly encryptMetadata: boolean;
}): StandardR6Strings {
  const pw = encodePassword(options.password);
  const empty = new Uint8Array(0);
  const zeroIv = new Uint8Array(16);

  // Algorithm 8 — the user password entries.
  const userValidationSalt = randomBytes(8);
  const userKeySalt = randomBytes(8);
  const u = concat(hash2b(pw, userValidationSalt, empty), userValidationSalt, userKeySalt);
  const ue = aesCbcNoPad('encrypt', hash2b(pw, userKeySalt, empty), zeroIv, options.fileKey);

  // Algorithm 9 — the owner password entries, which hash the 48 bytes of `/U` as well.
  const ownerValidationSalt = randomBytes(8);
  const ownerKeySalt = randomBytes(8);
  const o = concat(hash2b(pw, ownerValidationSalt, u), ownerValidationSalt, ownerKeySalt);
  const oe = aesCbcNoPad('encrypt', hash2b(pw, ownerKeySalt, u), zeroIv, options.fileKey);

  return {
    u,
    ue,
    o,
    oe,
    perms: buildPerms(options.fileKey, options.permissions, options.encryptMetadata),
  };
}

/**
 * Algorithm 10 — `/Perms`.
 *
 * Sixteen bytes encrypted with the file key: the permissions, four `0xFF` bytes, whether metadata
 * is encrypted, the marker `adb`, and four random bytes. A reader that can derive the file key
 * can therefore check that nobody edited `/P` in a text editor.
 */
export function buildPerms(
  fileKey: Uint8Array,
  permissions: number,
  encryptMetadata: boolean,
): Uint8Array {
  const perms = new Uint8Array(16);
  new DataView(perms.buffer).setInt32(0, permissions | 0, true);
  perms[4] = 0xff;
  perms[5] = 0xff;
  perms[6] = 0xff;
  perms[7] = 0xff;
  perms[8] = encryptMetadata ? 0x54 /* T */ : 0x46; /* F */
  perms[9] = 0x61; /* a */
  perms[10] = 0x64; /* d */
  perms[11] = 0x62; /* b */
  perms.set(randomBytes(4), 12);
  return aesEcbNoPad('encrypt', fileKey, perms).subarray(0, 16);
}

/**
 * Algorithm 2.A, the reading direction: recovers the file key from a revision-6 dictionary and a
 * password. Returns `null` when the password is neither the user's nor the owner's.
 *
 * Only the tests need this — the app itself never opens a standard-handler file this way, because
 * qpdf does — but it is what proves {@link buildStandardR6} inverts, and it is forty lines.
 */
export function recoverR6FileKey(
  strings: StandardR6Strings,
  password: string,
): { readonly key: Uint8Array; readonly as: 'user' | 'owner' } | null {
  const pw = encodePassword(password);
  const empty = new Uint8Array(0);
  const zeroIv = new Uint8Array(16);

  const uHash = strings.u.subarray(0, 32);
  const uValidationSalt = strings.u.subarray(32, 40);
  const uKeySalt = strings.u.subarray(40, 48);
  if (equalBytes(hash2b(pw, uValidationSalt, empty), uHash)) {
    const intermediate = hash2b(pw, uKeySalt, empty);
    return { key: aesCbcNoPad('decrypt', intermediate, zeroIv, strings.ue), as: 'user' };
  }

  const first48 = strings.u.subarray(0, 48);
  const oHash = strings.o.subarray(0, 32);
  const oValidationSalt = strings.o.subarray(32, 40);
  const oKeySalt = strings.o.subarray(40, 48);
  if (equalBytes(hash2b(pw, oValidationSalt, first48), oHash)) {
    const intermediate = hash2b(pw, oKeySalt, first48);
    return { key: aesCbcNoPad('decrypt', intermediate, zeroIv, strings.oe), as: 'owner' };
  }
  return null;
}

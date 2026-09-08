/**
 * The cryptographic primitives PDF security is built out of (M70).
 *
 * Two libraries, for two different reasons:
 *
 * - **Web Crypto** does the bulk content encryption. AESV3 encrypts each string and stream with
 *   AES-256-CBC and PKCS#7 padding, which is exactly `crypto.subtle`'s AES-CBC, so a megabyte of
 *   page content is encrypted at native speed in both Node and a Web Worker.
 * - **node-forge** does the small pieces where the spec asks for AES *without* padding — the
 *   hardening loop of Algorithm 2.B, and the wrapped file key in `/UE` and `/OE`. `crypto.subtle`
 *   always pads on encrypt and always validates padding on decrypt, and there is no option to
 *   turn that off; forge's ciphers take `finish(() => true)`, which is the documented way to say
 *   "this input is already a whole number of blocks".
 *
 * Nothing here logs, and nothing here holds onto a key after it returns.
 */

import forge from 'node-forge';

/** Bytes ⇄ forge's binary strings. forge speaks latin-1 strings, not `Uint8Array`. */
export function toBinary(bytes: Uint8Array): string {
  let s = '';
  // Chunked, because `String.fromCharCode(...bytes)` blows the argument limit past ~100 kB.
  const CHUNK = 8192;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return s;
}

export function fromBinary(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

export function toHex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

export function fromHex(hex: string): Uint8Array {
  const clean = hex.replace(/[^0-9a-fA-F]/g, '');
  const out = new Uint8Array(clean.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function toBase64(bytes: Uint8Array): string {
  return forge.util.encode64(toBinary(bytes));
}

export function fromBase64(b64: string): Uint8Array {
  return fromBinary(forge.util.decode64(b64));
}

/** Cryptographically strong random bytes. */
export function randomBytes(n: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(n);
  globalThis.crypto.getRandomValues(out);
  return out;
}

/**
 * forge's block cipher, with the one method its published types omit.
 *
 * `finish()` takes an optional padding function, and returning `true` from it without touching
 * the buffer is the documented way to say "already a whole number of blocks, add nothing". The
 * `@types/node-forge` declaration has it as `() => boolean`, so it is restated here rather than
 * worked around with a cast at each of the four call sites.
 */
interface NoPadCipher {
  start(options?: { iv?: string }): void;
  update(payload: forge.util.ByteBuffer): void;
  finish(pad?: () => boolean): boolean;
  output: forge.util.ByteStringBuffer;
}

/**
 * A copy that TypeScript knows is backed by a plain `ArrayBuffer`.
 *
 * `Uint8Array` became generic in the current lib types, and a view whose buffer might be a
 * `SharedArrayBuffer` is not a `BufferSource` — which is what `crypto.subtle` takes. Every array
 * that reaches Web Crypto goes through here.
 */
function forSubtle(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(bytes.length);
  out.set(bytes);
  return out;
}

/** AES-CBC with **no** padding. The input must be a whole number of 16-byte blocks. */
export function aesCbcNoPad(
  direction: 'encrypt' | 'decrypt',
  key: Uint8Array,
  iv: Uint8Array,
  data: Uint8Array,
): Uint8Array {
  const cipher = (direction === 'encrypt'
    ? forge.cipher.createCipher('AES-CBC', toBinary(key))
    : forge.cipher.createDecipher('AES-CBC', toBinary(key))) as unknown as NoPadCipher;
  cipher.start({ iv: toBinary(iv) });
  cipher.update(forge.util.createBuffer(toBinary(data)));
  cipher.finish(() => true);
  return fromBinary(cipher.output.getBytes());
}

/** AES-ECB with no padding, one block. `/Perms` is the only thing in PDF that uses ECB. */
export function aesEcbNoPad(
  direction: 'encrypt' | 'decrypt',
  key: Uint8Array,
  data: Uint8Array,
): Uint8Array {
  const cipher = (direction === 'encrypt'
    ? forge.cipher.createCipher('AES-ECB', toBinary(key))
    : forge.cipher.createDecipher('AES-ECB', toBinary(key))) as unknown as NoPadCipher;
  cipher.start();
  cipher.update(forge.util.createBuffer(toBinary(data)));
  cipher.finish(() => true);
  return fromBinary(cipher.output.getBytes());
}

export function sha256(...parts: ReadonlyArray<Uint8Array>): Uint8Array {
  const md = forge.md.sha256.create();
  for (const p of parts) md.update(toBinary(p));
  return fromBinary(md.digest().getBytes());
}

export function sha1(...parts: ReadonlyArray<Uint8Array>): Uint8Array {
  const md = forge.md.sha1.create();
  for (const p of parts) md.update(toBinary(p));
  return fromBinary(md.digest().getBytes());
}

/** AES-256-CBC with a random IV in front, which is how PDF stores an AESV3 string or stream. */
export async function aesEncryptContent(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const iv = randomBytes(16);
  const cryptoKey = await importCbcKey(key);
  const cipher = new Uint8Array(
    await globalThis.crypto.subtle.encrypt({ name: 'AES-CBC', iv }, cryptoKey, forSubtle(data)),
  );
  const out = new Uint8Array(iv.length + cipher.length);
  out.set(iv);
  out.set(cipher, iv.length);
  return out;
}

/** The inverse. Throws when the padding is wrong, which is what a bad key looks like. */
export async function aesDecryptContent(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  if (data.length < 32) return new Uint8Array(0);
  const iv = forSubtle(data.subarray(0, 16));
  const cryptoKey = await importCbcKey(key);
  return new Uint8Array(
    await globalThis.crypto.subtle.decrypt(
      { name: 'AES-CBC', iv },
      cryptoKey,
      forSubtle(data.subarray(16)),
    ),
  );
}

async function importCbcKey(key: Uint8Array): Promise<CryptoKey> {
  return globalThis.crypto.subtle.importKey('raw', forSubtle(key), { name: 'AES-CBC' }, false, [
    'encrypt',
    'decrypt',
  ]);
}

/**
 * A password as revision 6 wants it: UTF-8, at most 127 bytes.
 *
 * The spec asks for SASLprep (RFC 4013) first. We do not run it, and the reason is worth writing
 * down rather than leaving as a silent omission: SASLprep normalises and folds characters, so a
 * password typed the same way twice can hash differently only if the *inputs* differ in
 * normalisation — and both of ours come from the same text field in the same process. qpdf, which
 * writes every password-protected file this app produces, does not run SASLprep either. The one
 * case it would matter is a file protected elsewhere with a password containing, say, a composed
 * versus decomposed accent; that password would be rejected here and the reader told the password
 * did not work, which is a wrong answer but a safe one.
 */
export function encodePassword(password: string): Uint8Array {
  const bytes = new TextEncoder().encode(password);
  return bytes.length <= 127 ? bytes : bytes.subarray(0, 127);
}

/**
 * Algorithm 2.B (ISO 32000-2 §7.6.4.3.4) — the hardening hash revision 6 uses everywhere.
 *
 * `udata` is empty for a user password and the first 48 bytes of `/U` for an owner password. The
 * loop runs at least 64 times and then until the last byte of the round's AES output is small
 * enough, which is what makes it slow enough to be worth something against a dictionary attack.
 */
export function hash2b(password: Uint8Array, salt: Uint8Array, udata: Uint8Array): Uint8Array {
  let k = sha256(password, salt, udata);
  for (let round = 0; ; round++) {
    const one = concat(password, k, udata);
    const k1 = new Uint8Array(one.length * 64);
    for (let i = 0; i < 64; i++) k1.set(one, i * one.length);
    const e = aesCbcNoPad('encrypt', k.subarray(0, 16), k.subarray(16, 32), k1);
    // The first 16 bytes of E as a big-endian integer, modulo 3. Since 256 ≡ 1 (mod 3), that is
    // the same as the sum of those bytes modulo 3, which avoids a bignum for one branch.
    let sum = 0;
    for (let i = 0; i < 16; i++) sum += e[i] ?? 0;
    const mod = sum % 3;
    const md =
      mod === 0
        ? forge.md.sha256.create()
        : mod === 1
          ? forge.md.sha384.create()
          : forge.md.sha512.create();
    md.update(toBinary(e));
    k = fromBinary(md.digest().getBytes());
    if (round >= 63 && (e[e.length - 1] ?? 0) <= round - 31) break;
  }
  return k.subarray(0, 32);
}

export function concat(...parts: ReadonlyArray<Uint8Array>): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** Constant-time-ish comparison. Used on hashes, where an early return leaks nothing useful. */
export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

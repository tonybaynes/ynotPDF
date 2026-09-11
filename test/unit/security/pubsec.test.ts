/**
 * Certificate security (M70, ADR 0012).
 *
 * This is the crypto qpdf will not do for us, so it is the crypto that has to be proved hardest.
 * The central test is `qpdf reads back what we encrypted`: our public-key file gets a
 * standard-handler dictionary wrapping the *same* file key, and qpdf then decrypts and validates
 * every stream in it. Nothing about that can pass by accident — a wrong IV, a wrong key, a
 * double-encrypted string or a stream we forgot would all make qpdf complain.
 */

import { describe, expect, it } from 'vitest';
import {
  aesCbcNoPad,
  aesDecryptContent,
  aesEncryptContent,
  encodePassword,
  hash2b,
  randomBytes,
  toHex,
} from '@engine/security/pubsec/crypto';
import { buildStandardR6, recoverR6FileKey } from '@engine/security/pubsec/standard';
import {
  deriveFileKey,
  openEnvelopes,
  permissionBytes,
  readPermissionBytes,
  sealRecipients,
} from '@engine/security/pubsec/envelope';
import {
  encryptAttachmentsOnly,
  encryptToRecipients,
  toStandardHandler,
} from '@engine/security/pubsec/encrypt';
import { isCertificateEncrypted, readPubSecHeader } from '@engine/security/pubsec/decrypt';
import { loadCertificates, loadKeyPair } from '@engine/security/pubsec/certificates';
import { permissionsToP, pToPermissions } from '@engine/security/permissions';
import { ALL_ALLOWED, NONE_ALLOWED, type PermissionFlags } from '@engine/security/types';
import { fixture, makeIdentity, qpdf, recipientFor, security } from './helpers';

// Key generation is the slow part of every test here, so the identities are made once.
const alice = makeIdentity('Alice Adams');
const bob = makeIdentity('Bob Brown', 'bobs-password');
const mallory = makeIdentity('Mallory');

describe('the block ciphers', () => {
  it('encrypts and decrypts content with a random IV in front', async () => {
    const key = randomBytes(32);
    const data = new TextEncoder().encode('the quick brown fox');
    const a = await aesEncryptContent(key, data);
    const b = await aesEncryptContent(key, data);
    // A fresh IV every time, so the same plaintext never produces the same bytes.
    expect(toHex(a)).not.toBe(toHex(b));
    expect(new TextDecoder().decode(await aesDecryptContent(key, a))).toBe('the quick brown fox');
    expect(new TextDecoder().decode(await aesDecryptContent(key, b))).toBe('the quick brown fox');
  });

  /**
   * The property is "a wrong key does not get the data back" — not "a wrong key throws".
   *
   * This used to assert `rejects.toThrow()`, and that is a coin flip. `crypto.subtle.decrypt`
   * rejects AES-CBC when the PKCS#7 padding is invalid, and a wrong key leaves random bytes in
   * the final block: they pass for valid padding about **1 time in 256** (the last byte reads as
   * 1, or the last n bytes all read as n). When that happens the decrypt resolves, returns
   * rubbish, and the test failed — having found nothing wrong. It fired on 2026-09-11.
   *
   * Both outcomes are correct behaviour. Recovering the plaintext would not be, so that is what
   * is asserted. Deterministic, and a stronger claim than the one it replaces.
   */
  it('refuses to decrypt with the wrong key', async () => {
    const plain = randomBytes(64);
    const data = await aesEncryptContent(randomBytes(32), plain);
    let recovered: Uint8Array | null = null;
    try {
      recovered = await aesDecryptContent(randomBytes(32), data);
    } catch {
      // Rejected outright — the common case, and the one the old assertion relied on.
    }
    if (recovered !== null) expect(toHex(recovered)).not.toBe(toHex(plain));
  });

  it('does AES-CBC without padding, which is what the spec asks for in /UE', () => {
    const key = randomBytes(32);
    const iv = new Uint8Array(16);
    const plain = randomBytes(32);
    const cipher = aesCbcNoPad('encrypt', key, iv, plain);
    // No padding means no extra block: 32 bytes in, 32 bytes out.
    expect(cipher.length).toBe(32);
    expect(toHex(aesCbcNoPad('decrypt', key, iv, cipher))).toBe(toHex(plain));
  });
});

describe('the revision 6 hash and dictionary', () => {
  it('is deterministic and salt-dependent', () => {
    const pw = encodePassword('correct horse');
    const salt = randomBytes(8);
    expect(toHex(hash2b(pw, salt, new Uint8Array(0)))).toBe(
      toHex(hash2b(pw, salt, new Uint8Array(0))),
    );
    expect(toHex(hash2b(pw, salt, new Uint8Array(0)))).not.toBe(
      toHex(hash2b(pw, randomBytes(8), new Uint8Array(0))),
    );
  });

  it('truncates a password at 127 bytes, as revision 6 requires', () => {
    expect(encodePassword('a'.repeat(200)).length).toBe(127);
    expect(encodePassword('é'.repeat(100)).length).toBe(127);
  });

  it('wraps a file key so the same password unwraps it, as user and as owner', () => {
    const fileKey = randomBytes(32);
    const strings = buildStandardR6({
      fileKey,
      password: 'let me in',
      permissions: -3904,
      encryptMetadata: true,
    });
    const asUser = recoverR6FileKey(strings, 'let me in');
    expect(asUser).not.toBeNull();
    expect(toHex(asUser?.key ?? new Uint8Array())).toBe(toHex(fileKey));
    expect(recoverR6FileKey(strings, 'wrong')).toBeNull();
  });
});

describe('the recipient envelopes', () => {
  it('writes /P big-endian, which is the opposite of the standard handler', () => {
    const p = permissionsToP(NONE_ALLOWED);
    const bytes = permissionBytes(p);
    expect(readPermissionBytes(bytes)).toBe(p);
    // Big-endian: the sign bit is in the first byte, not the last.
    expect(bytes[0]).toBeGreaterThan(0x7f);
  });

  it('gives every recipient the same seed and their own permissions', () => {
    const readOnly: PermissionFlags = {
      print: 'none',
      modify: 'none',
      copy: false,
      accessibility: true,
    };
    const sealed = sealRecipients({
      recipients: [recipientFor(alice, ALL_ALLOWED), recipientFor(bob, readOnly)],
      encryptMetadata: true,
    });
    expect(sealed.blobs).toHaveLength(2);
    const forAlice = openEnvelopes(sealed.blobs, alice.privateKey);
    const forBob = openEnvelopes(sealed.blobs, bob.privateKey);
    expect(forAlice).not.toBeNull();
    expect(forBob).not.toBeNull();
    expect(toHex(forAlice?.seed ?? new Uint8Array())).toBe(toHex(forBob?.seed ?? new Uint8Array()));
    expect(pToPermissions(forAlice?.permissions ?? 0)).toEqual(ALL_ALLOWED);
    expect(pToPermissions(forBob?.permissions ?? 0)).toEqual(readOnly);
  });

  it('opens for nobody else', () => {
    const sealed = sealRecipients({ recipients: [recipientFor(alice)], encryptMetadata: true });
    expect(openEnvelopes(sealed.blobs, mallory.privateKey)).toBeNull();
  });

  it('derives one file key that every recipient agrees on', () => {
    const sealed = sealRecipients({
      recipients: [recipientFor(alice), recipientFor(bob)],
      encryptMetadata: true,
    });
    for (const identity of [alice, bob]) {
      const opened = openEnvelopes(sealed.blobs, identity.privateKey);
      const key = deriveFileKey(opened?.seed ?? new Uint8Array(), sealed.blobs, {
        encryptMetadata: true,
      });
      expect(toHex(key)).toBe(toHex(sealed.fileKey));
    }
  });

  it('derives a different key when metadata is left in the clear', () => {
    const seed = randomBytes(20);
    const sealed = sealRecipients({
      recipients: [recipientFor(alice)],
      encryptMetadata: true,
      seed,
    });
    expect(toHex(deriveFileKey(seed, sealed.blobs, { encryptMetadata: false }))).not.toBe(
      toHex(sealed.fileKey),
    );
  });

  it('refuses a document with no recipients', () => {
    expect(() => sealRecipients({ recipients: [], encryptMetadata: true })).toThrow(
      /at least one recipient/,
    );
  });
});

describe('reading certificates off disk', () => {
  it('reads DER and PEM alike', () => {
    for (const bytes of [alice.cer, alice.pem]) {
      const certs = loadCertificates(bytes);
      expect(certs).toHaveLength(1);
      expect(certs[0]?.name).toBe('Alice Adams');
      expect(certs[0]?.issuer).toBe('Alice Adams');
      expect(certs[0]?.expired).toBe(false);
    }
  });

  it('says so, by name, when a file has no certificate in it', () => {
    expect(() => loadCertificates(fixture('blank.pdf'), 'blank.pdf')).toThrow(
      /No certificate could be read from blank\.pdf/,
    );
  });

  it('opens a .p12 with its password and refuses it without', () => {
    const pair = loadKeyPair(bob.p12, 'bobs-password');
    expect(pair.certificate.name).toBe('Bob Brown');
    expect(() => loadKeyPair(bob.p12, 'wrong')).toThrow(/Check the password/);
  });
});

describe('a certificate-encrypted document', () => {
  const s = security();

  it('qpdf reads back every stream we encrypted', async () => {
    // The central test. Our file, with its /Adobe.PubSec dictionary swapped for a /Standard one
    // wrapping the identical file key — so if a single byte of our content encryption were wrong,
    // qpdf would fail to decrypt it and say so.
    const result = await encryptToRecipients(fixture('annotated.pdf'), {
      recipients: [recipientFor(alice)],
      scope: 'all',
    });
    const asStandard = await toStandardHandler(result.bytes, {
      fileKey: result.fileKey,
      password: 'check-me',
      permissions: result.permissions,
      encryptMetadata: true,
    });
    const run = await qpdf().run(['--check', '--password=check-me', 'in.pdf'], {
      'in.pdf': asStandard,
    });
    expect(run.output).toMatch(/No syntax or stream encoding errors found/);
    expect(run.code).toBe(0);
  }, 60_000);

  it.each(['blank.pdf', 'multipage.pdf', 'text.pdf', 'form.pdf', 'outline.pdf', 'links.pdf'])(
    'qpdf reads back %s',
    async (name) => {
      const result = await encryptToRecipients(fixture(name), {
        recipients: [recipientFor(alice)],
        scope: 'all',
      });
      const asStandard = await toStandardHandler(result.bytes, {
        fileKey: result.fileKey,
        password: 'x',
        permissions: result.permissions,
        encryptMetadata: true,
      });
      const run = await qpdf().run(['--check', '--password=x', 'in.pdf'], { 'in.pdf': asStandard });
      expect(run.output).toMatch(/No syntax or stream encoding errors found/);
    },
    60_000,
  );

  it('announces itself as public-key protected', async () => {
    const { bytes } = await encryptToRecipients(fixture('blank.pdf'), {
      recipients: [recipientFor(alice), recipientFor(bob)],
      scope: 'all',
    });
    expect(isCertificateEncrypted(bytes)).toBe(true);
    const header = readPubSecHeader(bytes);
    expect(header?.blobs).toHaveLength(2);
    const info = await s.inspect(bytes);
    expect(info.handler).toBe('public-key');
    expect(info.algorithm).toBe('aes-256');
    expect(info.recipients).toHaveLength(2);
  }, 60_000);

  it('opens with the recipient’s .p12 and not without it', async () => {
    // The acceptance test, in full: encrypt to Alice, open as Alice, fail as Mallory.
    const { bytes } = await encryptToRecipients(fixture('multipage.pdf'), {
      recipients: [recipientFor(alice)],
      scope: 'all',
    });
    const opened = await s.unlockWithDigitalId(bytes, alice.p12, alice.p12Password);
    expect(opened.openedAs).toBe('Alice Adams');
    expect((await s.inspect(opened.bytes)).encrypted).toBe(false);
    const check = await qpdf().run(['--check', 'in.pdf'], { 'in.pdf': opened.bytes });
    expect(check.output).toMatch(/File is not encrypted/);

    await expect(
      s.unlockWithDigitalId(bytes, mallory.p12, mallory.p12Password),
    ).rejects.toMatchObject({ code: 'not-a-recipient' });
    await expect(s.unlockWithDigitalId(bytes, alice.p12, 'not-the-password')).rejects.toMatchObject(
      { code: 'bad-key-file' },
    );
  }, 60_000);

  it('gives each recipient the permissions their own envelope carries', async () => {
    const readOnly: PermissionFlags = {
      print: 'none',
      modify: 'none',
      copy: false,
      accessibility: true,
    };
    const { bytes } = await encryptToRecipients(fixture('blank.pdf'), {
      recipients: [recipientFor(alice, ALL_ALLOWED), recipientFor(bob, readOnly)],
      scope: 'all',
    });
    const asAlice = await s.unlockWithDigitalId(bytes, alice.p12, alice.p12Password);
    const asBob = await s.unlockWithDigitalId(bytes, bob.p12, bob.p12Password);
    expect(asAlice.permissions).toEqual(ALL_ALLOWED);
    expect(asBob.permissions).toEqual(readOnly);
  }, 60_000);

  it('survives an incremental update appended to a file that used a cross-reference stream', async () => {
    // `annotated.pdf` is written with cross-reference streams; opening it exercises the stream
    // branch of the appended update, which is the one a classic table would get wrong.
    const { bytes } = await encryptToRecipients(fixture('annotated.pdf'), {
      recipients: [recipientFor(bob)],
      scope: 'all',
    });
    const opened = await s.unlockWithDigitalId(bytes, bob.p12, bob.p12Password);
    const check = await qpdf().run(['--check', 'in.pdf'], { 'in.pdf': opened.bytes });
    expect(check.code).toBe(0);
  }, 60_000);

  it('says who it was encrypted for, and what it is, without opening it', async () => {
    const { bytes } = await encryptToRecipients(fixture('blank.pdf'), {
      recipients: [recipientFor(alice), recipientFor(bob)],
      scope: 'all',
    });
    // A public-key file names its recipients in sealed envelopes; it does not carry their
    // certificates, which is why a save cannot put the protection back on its own.
    expect(s.isCertificateProtected(bytes)).toBe(true);
    expect(s.recipientsOf(bytes)).toHaveLength(2);
    expect(s.isCertificateProtected(fixture('blank.pdf'))).toBe(false);
    expect(s.recipientsOf(fixture('blank.pdf'))).toEqual([]);
  }, 60_000);

  it('leaves metadata readable when the reader asked for that', async () => {
    const result = await encryptToRecipients(fixture('text.pdf'), {
      recipients: [recipientFor(alice)],
      scope: 'except-metadata',
    });
    const info = await s.inspect(result.bytes);
    expect(info.handler).toBe('public-key');
    expect(info.metadataEncrypted).toBe(false);
    // And the file is still readable end to end, which the swapped-dictionary check proves.
    const asStandard = await toStandardHandler(result.bytes, {
      fileKey: result.fileKey,
      password: 'x',
      permissions: result.permissions,
      encryptMetadata: false,
    });
    const run = await qpdf().run(['--check', '--password=x', 'in.pdf'], { 'in.pdf': asStandard });
    expect(run.output).toMatch(/No syntax or stream encoding errors found/);
  }, 60_000);

  it('refuses to have its protection removed with a password', async () => {
    const { bytes } = await encryptToRecipients(fixture('blank.pdf'), {
      recipients: [recipientFor(alice)],
      scope: 'all',
    });
    await expect(s.remove(bytes, 'anything')).rejects.toMatchObject({ code: 'not-a-recipient' });
  }, 60_000);
});

describe('encrypting only the file attachments', () => {
  const s = security();

  it('leaves the document readable and the attachment protected', async () => {
    const result = await encryptAttachmentsOnly(fixture('attachments.pdf'), {
      permissions: ALL_ALLOWED,
      userPassword: '',
      ownerPassword: 'owner',
    });
    const info = await s.inspect(result.bytes);
    expect(info.encrypted).toBe(true);
    // No password needed to read the document itself.
    expect(info.opensWithoutPassword).toBe(true);
    const run = await qpdf().run(['--check', 'in.pdf'], { 'in.pdf': result.bytes });
    expect(run.output).not.toMatch(/invalid password/);
  }, 60_000);

  it('says so when there was nothing to protect', async () => {
    const result = await encryptAttachmentsOnly(fixture('blank.pdf'), {
      permissions: ALL_ALLOWED,
      userPassword: '',
      ownerPassword: 'owner',
    });
    expect(result.warnings.join(' ')).toMatch(/no file attachments/);
  }, 60_000);
});

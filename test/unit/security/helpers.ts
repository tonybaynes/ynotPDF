/**
 * Shared helpers for the security suite (M70): a real qpdf built from the wasm on disk, fixture
 * loading, and a synthetic certificate authority so certificate tests need no committed secrets.
 *
 * The qpdf here is the same `Qpdf` class the app ships — only the two constructor arguments differ
 * (the factory and the wasm come from `node_modules` rather than from an inlined asset), which is
 * the point of injecting them.
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import forge from 'node-forge';
import { Qpdf, type QpdfFactory } from '@engine/security/qpdf';
import { Security } from '@engine/security/Security';
import { toRecipient, type ParsedCertificate } from '@engine/security/pubsec/certificates';
import { ALL_ALLOWED, type PermissionFlags, type Recipient } from '@engine/security/types';

const require_ = createRequire(import.meta.url);

export const ROOT = process.cwd();
export const FIXTURES = join(ROOT, 'test', 'fixtures');

export function fixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(FIXTURES, name)));
}

let shared: Security | null = null;

/** One qpdf per test process. Instantiating the module costs ~40 ms; the tests run hundreds. */
export function security(): Security {
  shared ??= new Security(qpdf());
  return shared;
}

/**
 * A real qpdf. No `locateFile`: under Node the module's own default finds `qpdf.wasm` next to
 * itself in `node_modules`, which is exactly what a test wants. The bundled app supplies one
 * (`src/engine/security/qpdf-asset.ts`) because a packaged renderer has no such file to read.
 */
export function qpdf(): Qpdf {
  return new Qpdf({ factory: require_('@neslinesli93/qpdf-wasm') as QpdfFactory });
}

// ---- synthetic certificates ---------------------------------------------------------------------

export interface TestIdentity {
  readonly certificate: ParsedCertificate;
  readonly privateKey: forge.pki.rsa.PrivateKey;
  /** A `.p12` holding both, protected with {@link TestIdentity.p12Password}. */
  readonly p12: Uint8Array;
  readonly p12Password: string;
  /** DER bytes of the certificate on its own, as a `.cer` file would hold them. */
  readonly cer: Uint8Array;
  /** The same certificate PEM-encoded, as a `.pem` file would hold it. */
  readonly pem: Uint8Array;
}

/**
 * A self-signed RSA identity.
 *
 * 2048 bits: enough to be a real key, and generating a 4096-bit one takes long enough to make the
 * suite annoying. Nothing here is a secret — every one is generated at test time and thrown away,
 * which is why no `.p12` is committed.
 */
export function makeIdentity(commonName: string, password = 'p12-password'): TestIdentity {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber =
    '01' +
    Math.floor(Math.random() * 1e12)
      .toString(16)
      .padStart(12, '0');
  cert.validity.notBefore = new Date(Date.UTC(2020, 0, 1));
  cert.validity.notAfter = new Date(Date.UTC(2040, 0, 1));
  const attrs = [
    { name: 'commonName', value: commonName },
    { name: 'organizationName', value: 'ynotPDF tests' },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', keyEncipherment: true, digitalSignature: true },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());

  const der = binaryToBytes(forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes());
  const p12Asn1 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], password, {
    generateLocalKeyId: true,
    friendlyName: commonName,
  });
  return {
    certificate: {
      name: commonName,
      issuer: commonName,
      serial: cert.serialNumber.replace(/^0+/, '').toUpperCase(),
      validFrom: cert.validity.notBefore.toISOString(),
      validTo: cert.validity.notAfter.toISOString(),
      der,
      expired: false,
    },
    privateKey: keys.privateKey,
    p12: binaryToBytes(forge.asn1.toDer(p12Asn1).getBytes()),
    p12Password: password,
    cer: der,
    pem: new TextEncoder().encode(forge.pki.certificateToPem(cert)),
  };
}

/** A recipient built from a test identity. */
export function recipientFor(
  identity: TestIdentity,
  permissions: PermissionFlags = ALL_ALLOWED,
): Recipient {
  return toRecipient(identity.certificate, permissions);
}

function binaryToBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

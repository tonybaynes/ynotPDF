/**
 * Reading certificates and private keys off disk (M70).
 *
 * Everything a reader might hand us for a certificate-protected document:
 *
 * - `.cer` / `.crt` / `.der` / `.pem` — one certificate, DER or PEM.
 * - `.p7b` / `.p7c` — a PKCS#7 bundle, which is how a certificate *chain* is usually exported and
 *   which may hold several unrelated certificates as well.
 * - `.p12` / `.pfx` — a PKCS#12 keystore holding a private key and its certificate, which is what
 *   a recipient opens the file with.
 *
 * There is no PDF in this file, which is deliberate: M81 needs exactly the same loading for
 * signing and should import it rather than write a second one.
 */

import forge from 'node-forge';
import { SecurityError, type Recipient, type RecipientSummary } from '../types';
import { ALL_ALLOWED } from '../types';
import { fromBase64, toBase64, toBinary, toHex } from './crypto';

/** A parsed certificate, plus the DER we will actually put in the envelope. */
export interface ParsedCertificate {
  readonly name: string;
  readonly issuer: string;
  readonly serial: string;
  readonly validFrom: string;
  readonly validTo: string;
  readonly der: Uint8Array;
  /** True when the clock is outside the certificate's validity. Reported, never enforced. */
  readonly expired: boolean;
}

/** A private key and the certificate that goes with it, out of a `.p12`. */
export interface KeyPairFile {
  readonly certificate: ParsedCertificate;
  /** forge's private key object. Never leaves the worker. */
  readonly privateKey: forge.pki.PrivateKey;
}

/**
 * Reads whatever certificates are in a file. Never returns an empty array: a file with nothing
 * readable in it is an error the reader needs to see, not an empty list they would have to guess
 * about.
 */
export function loadCertificates(bytes: Uint8Array, fileName = 'the file'): ParsedCertificate[] {
  const certs = tryPem(bytes) ?? tryPkcs7(bytes) ?? tryDer(bytes);
  if (!certs || certs.length === 0) {
    throw new SecurityError(
      'bad-certificate',
      `No certificate could be read from ${fileName}. It should be a .cer, .crt, .der, .pem or .p7b file.`,
    );
  }
  return certs;
}

function tryPem(bytes: Uint8Array): ParsedCertificate[] | null {
  const text = toBinary(bytes);
  if (!text.includes('-----BEGIN CERTIFICATE-----')) return null;
  const out: ParsedCertificate[] = [];
  for (const block of text.split(/(?=-----BEGIN CERTIFICATE-----)/)) {
    if (!block.includes('-----BEGIN CERTIFICATE-----')) continue;
    try {
      out.push(describe(forge.pki.certificateFromPem(block)));
    } catch {
      // One unreadable block in a bundle is not a reason to reject the rest.
    }
  }
  return out.length > 0 ? out : null;
}

function tryDer(bytes: Uint8Array): ParsedCertificate[] | null {
  try {
    const asn1 = forge.asn1.fromDer(forge.util.createBuffer(toBinary(bytes)));
    return [describe(forge.pki.certificateFromAsn1(asn1))];
  } catch {
    return null;
  }
}

function tryPkcs7(bytes: Uint8Array): ParsedCertificate[] | null {
  try {
    const asn1 = forge.asn1.fromDer(forge.util.createBuffer(toBinary(bytes)));
    const message = forge.pkcs7.messageFromAsn1(asn1) as { certificates?: forge.pki.Certificate[] };
    const certs = message.certificates ?? [];
    return certs.length > 0 ? certs.map(describe) : null;
  } catch {
    return null;
  }
}

/** Opens a `.p12` with its password. */
export function loadKeyPair(bytes: Uint8Array, password: string): KeyPairFile {
  let p12: forge.pkcs12.Pkcs12Pfx;
  try {
    const asn1 = forge.asn1.fromDer(forge.util.createBuffer(toBinary(bytes)));
    p12 = forge.pkcs12.pkcs12FromAsn1(asn1, password);
  } catch (error) {
    // forge says "Invalid password?" for a bad password and something else for a bad file, but
    // both arrive here and the reader's next step is the same either way: check the password,
    // then check the file.
    throw new SecurityError(
      'bad-key-file',
      'The digital ID could not be opened. Check the password, and that the file is a .p12 or .pfx.',
      error instanceof Error ? error.message : String(error),
    );
  }
  const keyBags = {
    ...p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag }),
    ...p12.getBags({ bagType: forge.pki.oids.keyBag }),
  };
  const privateKey = Object.values(keyBags)
    .flat()
    .find((bag) => bag?.key)?.key;
  const certificate = Object.values(p12.getBags({ bagType: forge.pki.oids.certBag }))
    .flat()
    .find((bag) => bag?.cert)?.cert;
  if (!privateKey || !certificate) {
    throw new SecurityError(
      'bad-key-file',
      'That file has no private key and certificate pair in it, so it cannot open a protected document.',
    );
  }
  return { certificate: describe(certificate), privateKey };
}

function describe(cert: forge.pki.Certificate): ParsedCertificate {
  const der = new Uint8Array(
    forge.util
      .createBuffer(forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes())
      .toHex()
      .match(/../g)
      ?.map((h) => Number.parseInt(h, 16)) ?? [],
  );
  const now = Date.now();
  return {
    name: fieldOf(cert.subject, 'CN') ?? fieldOf(cert.subject, 'O') ?? 'Unnamed certificate',
    issuer: fieldOf(cert.issuer, 'CN') ?? fieldOf(cert.issuer, 'O') ?? 'Unknown issuer',
    serial: cert.serialNumber.replace(/^0+/, '').toUpperCase() || '0',
    validFrom: cert.validity.notBefore.toISOString(),
    validTo: cert.validity.notAfter.toISOString(),
    der,
    expired: now < cert.validity.notBefore.getTime() || now > cert.validity.notAfter.getTime(),
  };
}

function fieldOf(name: forge.pki.Certificate['subject'], shortName: string): string | null {
  const field = name.attributes.find((a) => a.shortName === shortName);
  return typeof field?.value === 'string' && field.value !== '' ? field.value : null;
}

let nextRecipientId = 0;

/** Turns a parsed certificate into a recipient with permissions attached. */
export function toRecipient(
  cert: ParsedCertificate,
  permissions = ALL_ALLOWED,
  id?: string,
): Recipient {
  return {
    id: id ?? `r${String(++nextRecipientId)}`,
    name: cert.name,
    issuer: cert.issuer,
    serial: cert.serial,
    validFrom: cert.validFrom,
    validTo: cert.validTo,
    certificate: cert.der,
    permissions,
  };
}

/** The storable form — base64 DER, so a recipient survives the journal and a recovery replay. */
export function summarise(recipient: Recipient): RecipientSummary {
  const { certificate, ...rest } = recipient;
  return { ...rest, certificateBase64: toBase64(certificate) };
}

/** And back again. */
export function desummarise(summary: RecipientSummary): Recipient {
  const { certificateBase64, ...rest } = summary;
  return { ...rest, certificate: fromBase64(certificateBase64) };
}

/** A short line identifying a certificate, for a list the reader reads. */
export function describeCertificate(cert: {
  readonly name: string;
  readonly issuer: string;
  readonly serial: string;
}): string {
  return `${cert.name} — issued by ${cert.issuer}, serial ${cert.serial}`;
}

/** The DER as forge wants it, for the envelope. */
export function certificateFromDer(der: Uint8Array): forge.pki.Certificate {
  try {
    return forge.pki.certificateFromAsn1(
      forge.asn1.fromDer(forge.util.createBuffer(toBinary(der))),
    );
  } catch (error) {
    throw new SecurityError(
      'bad-certificate',
      'A recipient certificate could not be read.',
      error instanceof Error ? error.message : String(error),
    );
  }
}

/** Uppercase hex of a certificate's DER, for telling two certificates apart in a log-free way. */
export function fingerprint(der: Uint8Array): string {
  return toHex(
    new Uint8Array(
      forge.md.sha256
        .create()
        .update(toBinary(der))
        .digest()
        .getBytes()
        .split('')
        .map((c) => c.charCodeAt(0)),
    ),
  ).toUpperCase();
}

/**
 * Helpers for the content-stream suite (M50): the decoded content of a page, read with pdf-lib
 * so the tests do not depend on the engine for what is a pure-bytes concern.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { pageContentOf } from '@engine/content/pdf';

export const FIXTURES = join(process.cwd(), 'test', 'fixtures');

/** Every fixture PDF, synthetic and external. Ones pdf-lib or PDFium cannot read are skipped. */
export function openableFixtures(): Array<{ readonly name: string; readonly bytes: Uint8Array }> {
  const skip = new Set([
    'corrupt.pdf',
    'truncated.pdf',
    'broken-xref.pdf',
    'encrypted.pdf',
    'encrypted-aes128.pdf',
    'encrypted-aes256.pdf',
    'encrypted-owner.pdf',
    'xfa.pdf',
  ]);
  const out: Array<{ name: string; bytes: Uint8Array }> = [];
  for (const f of readdirSync(FIXTURES)) {
    if (f.endsWith('.pdf') && !skip.has(f)) {
      out.push({ name: f, bytes: new Uint8Array(readFileSync(join(FIXTURES, f))) });
    }
  }
  const external = join(FIXTURES, 'external');
  if (existsSync(external)) {
    for (const f of readdirSync(external)) {
      if (f.endsWith('.pdf')) {
        out.push({
          name: `external/${f}`,
          bytes: new Uint8Array(readFileSync(join(external, f))),
        });
      }
    }
  }
  // The operator's own files (git-ignored, personal): named by number so nothing about them
  // reaches a log. Absent on CI and other machines, which simply means fewer tests.
  const local = join(FIXTURES, 'local');
  if (existsSync(local)) {
    readdirSync(local)
      .filter((f) => f.toLowerCase().endsWith('.pdf'))
      .forEach((f, i) => {
        out.push({ name: `local/#${i + 1}`, bytes: new Uint8Array(readFileSync(join(local, f))) });
      });
  }
  return out;
}

/**
 * Decoded content of every page, or `null` when pdf-lib cannot read the file at all — an
 * encrypted file, a damaged one, or a stream it cannot decode. Those are PDFium's problem to
 * open, not the parser's to round-trip, so a test treats `null` as "nothing to check here".
 */
export async function pageContents(bytes: Uint8Array): Promise<Uint8Array[] | null> {
  try {
    const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
    return doc.getPages().map((page) => pageContentOf(doc, page));
  } catch {
    return null;
  }
}

/** Latin-1 bytes of a string, so `\xff` in a test is one byte, as it is in a file. */
export function ascii(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

export function text(bytes: Uint8Array): string {
  return new TextDecoder('latin1').decode(bytes);
}

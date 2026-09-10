/**
 * Helpers for the content-stream suite (M50): the decoded content of a page, read with pdf-lib
 * so the tests do not depend on the engine for what is a pure-bytes concern.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  PDFArray,
  PDFDocument,
  PDFName,
  PDFRawStream,
  PDFRef,
  PDFStream,
  decodePDFRawStream,
} from 'pdf-lib';

export const FIXTURES = join(process.cwd(), 'test', 'fixtures');

/** Every fixture PDF that opens without a password, synthetic and external. */
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
  return out;
}

/** Decoded content of every page, concatenated per page the way the spec says (7.7.3.3). */
export async function pageContents(bytes: Uint8Array): Promise<Uint8Array[]> {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  return doc.getPages().map((page) => {
    const contents = page.node.get(PDFName.of('Contents'));
    const refs: PDFRef[] = [];
    const resolved = contents instanceof PDFRef ? doc.context.lookup(contents) : contents;
    if (contents instanceof PDFRef && resolved instanceof PDFStream) refs.push(contents);
    else if (resolved instanceof PDFArray) {
      for (const item of resolved.asArray()) if (item instanceof PDFRef) refs.push(item);
    }
    const parts: Uint8Array[] = [];
    for (const ref of refs) {
      const stream = doc.context.lookup(ref);
      if (stream instanceof PDFRawStream) parts.push(decodePDFRawStream(stream).decode());
      else if (stream instanceof PDFStream) parts.push(stream.getContents());
      parts.push(new Uint8Array([0x0a]));
    }
    const total = parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(total);
    let at = 0;
    for (const p of parts) {
      out.set(p, at);
      at += p.length;
    }
    return out;
  });
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

/**
 * Reading a page's content stream out of PDF bytes (M50, ADR 0018), with pdf-lib.
 *
 * PDFium has no API that hands back the bytes of a content stream, only the objects it parsed
 * from them — so the original operators come from the file itself. `/Contents` may be one
 * stream or an array of them; the spec (7.7.3.3) says the array is one logical stream with the
 * pieces separated by whitespace, which is what the newline between them here provides.
 */

import {
  PDFArray,
  PDFDocument,
  PDFName,
  PDFRawStream,
  PDFRef,
  PDFStream,
  decodePDFRawStream,
  type PDFPage,
} from 'pdf-lib';

/** The decoded, concatenated content of one page of an already loaded document. */
export function pageContentOf(doc: PDFDocument, page: PDFPage): Uint8Array {
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
}

/** The decoded content of page `index` of `bytes`, or `null` when there is no such page. */
export async function readPageContent(
  bytes: Uint8Array,
  index: number,
): Promise<Uint8Array | null> {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  const page = doc.getPages()[index];
  return page ? pageContentOf(doc, page) : null;
}

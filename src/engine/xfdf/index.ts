/**
 * Comment exchange — FDF and XFDF (M32). Pure over text and bytes; no DOM, no engine, no model
 * beyond the annotation types, so a unit test and M120's batch runner can both use it.
 */

export * from './types';
export * from './values';
export { readXfdf } from './read';
export { writeXfdf, escapeXmlText, escapeXmlAttribute } from './write';
export { readFdf, writeFdf } from './fdf';
export { toXfdf, patchFrom, extraFrom, type ExportContext } from './convert';
export {
  PdfLexer,
  writeValue,
  bytesToBinary,
  binaryToBytes,
  decodePdfText,
  encodePdfText,
  type PdfValue,
} from './pdfsyntax';

import { readFdf } from './fdf';
import { readXfdf } from './read';
import { bytesToBinary } from './pdfsyntax';
import { XfdfError, type XfdfDocument } from './types';

/** The two formats, as the file dialogs and the commands name them. */
export type CommentFormat = 'xfdf' | 'fdf';

/** The format a file name implies, or null when it is neither. */
export function formatOfName(name: string): CommentFormat | null {
  const lower = name.toLowerCase();
  if (lower.endsWith('.xfdf')) return 'xfdf';
  if (lower.endsWith('.fdf')) return 'fdf';
  return null;
}

/**
 * Reads an exchange file whichever of the two it is, sniffing the content rather than trusting
 * the extension — a reviewer who saved an XFDF as `.fdf` should still be able to import it.
 */
export function readComments(bytes: Uint8Array, hint?: CommentFormat | null): XfdfDocument {
  const head = bytesToBinary(bytes.subarray(0, 1024));
  const looksFdf = /%FDF-\d/.test(head);
  const looksXfdf = head.includes('<xfdf') || head.includes('<XFDF') || head.includes('<?xml');
  if (looksFdf) return readFdf(bytes);
  if (looksXfdf) return readXfdf(new TextDecoder('utf-8').decode(bytes));
  // Neither header is there: try what the caller expected, then the other, then say so plainly.
  const order: CommentFormat[] = hint === 'fdf' ? ['fdf', 'xfdf'] : ['xfdf', 'fdf'];
  for (const format of order) {
    try {
      return format === 'fdf' ? readFdf(bytes) : readXfdf(new TextDecoder('utf-8').decode(bytes));
    } catch {
      continue;
    }
  }
  throw new XfdfError('malformed', 'This file is not an FDF or XFDF comment file');
}

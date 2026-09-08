/**
 * Bytes → string for text-like inputs (M91). Honours a UTF-8 or UTF-16 byte-order mark and
 * otherwise assumes UTF-8, replacing what does not decode rather than failing.
 */

export function decodeText(bytes: Uint8Array): string {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder('utf-8').decode(bytes.subarray(3));
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  }
  return new TextDecoder('utf-8').decode(bytes);
}

/** Splits on any line ending, dropping a single trailing empty line a final newline leaves. */
export function splitLines(text: string): string[] {
  const lines = text.split(/\r\n|\r|\n/);
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Expands tabs to the next multiple of `tabSize` columns. */
export function expandTabs(line: string, tabSize: number): string {
  if (!line.includes('\t')) return line;
  const size = Math.max(1, Math.floor(tabSize));
  let out = '';
  for (const ch of line) {
    if (ch === '\t') {
      const pad = size - (out.length % size);
      out += ' '.repeat(pad);
    } else {
      out += ch;
    }
  }
  return out;
}

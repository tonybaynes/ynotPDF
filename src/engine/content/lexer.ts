/**
 * Content-stream lexer (M50, ADR 0018).
 *
 * Turns the bytes of a content stream into tokens, keeping the byte offset of every one so the
 * parser above can hand each operator the exact slice of source it came from. That is what
 * makes an untouched stream round-trip byte for byte.
 *
 * A content stream is *not* a PDF file: there are no indirect references, no `obj`/`endobj`
 * and no streams — except the one exception the spec carves out, the inline image between
 * `BI` and `EI`, whose binary payload has to be skipped by hand because it is not tokenisable.
 */

/** Byte classes from PDF 32000-1 table 1. */
const WHITESPACE = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
const DELIMITERS = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25]);

export function isWhitespace(byte: number): boolean {
  return WHITESPACE.has(byte);
}

export function isDelimiter(byte: number): boolean {
  return DELIMITERS.has(byte);
}

/** Neither whitespace nor a delimiter — the bytes a keyword, number or name is made of. */
export function isRegular(byte: number): boolean {
  return !WHITESPACE.has(byte) && !DELIMITERS.has(byte);
}

export type TokenKind =
  | 'number'
  | 'name'
  | 'string'
  | 'hexstring'
  | 'array-open'
  | 'array-close'
  | 'dict-open'
  | 'dict-close'
  | 'brace-open'
  | 'brace-close'
  | 'keyword'
  | 'comment'
  | 'inline-image';

export interface Token {
  readonly kind: TokenKind;
  /** Byte offsets into the source, `[start, end)`. */
  readonly start: number;
  readonly end: number;
  /** Numbers: the value. Names and keywords: the decoded text. Strings: the decoded bytes. */
  readonly number?: number;
  readonly text?: string;
  readonly bytes?: Uint8Array;
  /** Inline image only: where the binary payload sits, between `ID` and `EI`. */
  readonly data?: { readonly start: number; readonly end: number };
}

/** A malformed stream: reported rather than thrown, so a bad page is still readable. */
export interface LexIssue {
  readonly at: number;
  readonly message: string;
}

export interface LexResult {
  readonly tokens: ReadonlyArray<Token>;
  readonly issues: ReadonlyArray<LexIssue>;
}

const LATIN1 = new TextDecoder('latin1');

/** Decodes a name body (PDF 7.3.5), resolving `#xx` escapes. */
export function decodeName(raw: Uint8Array): string {
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const b = raw[i] ?? 0;
    if (b === 0x23 && i + 2 < raw.length) {
      const value = Number.parseInt(LATIN1.decode(raw.subarray(i + 1, i + 3)), 16);
      if (!Number.isNaN(value)) {
        out += String.fromCharCode(value);
        i += 2;
        continue;
      }
    }
    out += String.fromCharCode(b);
  }
  return out;
}

/** Decodes a literal string's body (between the parentheses), resolving PDF escapes. */
export function decodeLiteralString(raw: Uint8Array): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < raw.length; i++) {
    const b = raw[i] ?? 0;
    if (b !== 0x5c) {
      out.push(b);
      continue;
    }
    const next = raw[++i];
    if (next === undefined) break;
    switch (next) {
      case 0x6e:
        out.push(0x0a);
        break;
      case 0x72:
        out.push(0x0d);
        break;
      case 0x74:
        out.push(0x09);
        break;
      case 0x62:
        out.push(0x08);
        break;
      case 0x66:
        out.push(0x0c);
        break;
      case 0x0a:
        break;
      case 0x0d:
        if (raw[i + 1] === 0x0a) i++;
        break;
      default:
        if (next >= 0x30 && next <= 0x37) {
          let value = next - 0x30;
          for (let d = 0; d < 2; d++) {
            const digit = raw[i + 1];
            if (digit === undefined || digit < 0x30 || digit > 0x37) break;
            value = value * 8 + (digit - 0x30);
            i++;
          }
          out.push(value & 0xff);
        } else {
          out.push(next);
        }
    }
  }
  return Uint8Array.from(out);
}

/** Decodes a hex string's body (between the angle brackets). */
export function decodeHexString(raw: Uint8Array): Uint8Array {
  const digits: number[] = [];
  for (const b of raw) {
    const d =
      b >= 0x30 && b <= 0x39
        ? b - 0x30
        : b >= 0x41 && b <= 0x46
          ? b - 0x41 + 10
          : b >= 0x61 && b <= 0x66
            ? b - 0x61 + 10
            : -1;
    if (d >= 0) digits.push(d);
  }
  // An odd number of digits means a trailing zero (PDF 7.3.4.3).
  if (digits.length % 2 === 1) digits.push(0);
  const out = new Uint8Array(digits.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = ((digits[i * 2] ?? 0) << 4) | (digits[i * 2 + 1] ?? 0);
  }
  return out;
}

/** Numbers as PDF writes them: `1`, `-3`, `.5`, `4.`, and Acrobat's `--7`. */
const NUMBER = /^[+-]*(?:\d+\.?\d*|\.\d+)$/;

function parseNumber(text: string): number {
  const value = Number.parseFloat(text.replace(/^([+-])[+-]+/, '$1'));
  return Number.isFinite(value) ? value : 0;
}

/**
 * Tokenises `source`. Never throws: anything unparsable becomes an issue and the scan moves on,
 * because half a page is better than none and M71 has to be able to look at a broken file.
 */
export function lex(source: Uint8Array): LexResult {
  const tokens: Token[] = [];
  const issues: LexIssue[] = [];
  let i = 0;
  const n = source.length;

  while (i < n) {
    const b = source[i] ?? 0;
    if (isWhitespace(b)) {
      i++;
      continue;
    }
    const start = i;
    if (b === 0x25) {
      while (i < n && source[i] !== 0x0a && source[i] !== 0x0d) i++;
      tokens.push({ kind: 'comment', start, end: i });
      continue;
    }
    if (b === 0x5b || b === 0x5d || b === 0x7b || b === 0x7d) {
      const kind: TokenKind =
        b === 0x5b
          ? 'array-open'
          : b === 0x5d
            ? 'array-close'
            : b === 0x7b
              ? 'brace-open'
              : 'brace-close';
      tokens.push({ kind, start, end: ++i });
      continue;
    }
    if (b === 0x2f) {
      i++;
      const bodyStart = i;
      while (i < n && isRegular(source[i] ?? 0)) i++;
      tokens.push({ kind: 'name', start, end: i, text: decodeName(source.subarray(bodyStart, i)) });
      continue;
    }
    if (b === 0x28) {
      i++;
      const bodyStart = i;
      let depth = 1;
      while (i < n) {
        const c = source[i] ?? 0;
        if (c === 0x5c) {
          i += 2;
          continue;
        }
        if (c === 0x28) depth++;
        else if (c === 0x29 && --depth === 0) break;
        i++;
      }
      if (i >= n) issues.push({ at: start, message: 'unterminated string' });
      const bodyEnd = Math.min(i, n);
      i = Math.min(i + 1, n);
      tokens.push({
        kind: 'string',
        start,
        end: i,
        bytes: decodeLiteralString(source.subarray(bodyStart, bodyEnd)),
      });
      continue;
    }
    if (b === 0x3c) {
      if (source[i + 1] === 0x3c) {
        i += 2;
        tokens.push({ kind: 'dict-open', start, end: i });
        continue;
      }
      i++;
      const bodyStart = i;
      while (i < n && source[i] !== 0x3e) i++;
      if (i >= n) issues.push({ at: start, message: 'unterminated hex string' });
      const bodyEnd = Math.min(i, n);
      i = Math.min(i + 1, n);
      tokens.push({
        kind: 'hexstring',
        start,
        end: i,
        bytes: decodeHexString(source.subarray(bodyStart, bodyEnd)),
      });
      continue;
    }
    if (b === 0x3e) {
      if (source[i + 1] === 0x3e) {
        i += 2;
        tokens.push({ kind: 'dict-close', start, end: i });
        continue;
      }
      issues.push({ at: i, message: 'stray angle bracket' });
      i++;
      continue;
    }
    if (b === 0x29) {
      issues.push({ at: i, message: 'stray close parenthesis' });
      i++;
      continue;
    }

    // A number or a keyword.
    while (i < n && isRegular(source[i] ?? 0)) i++;
    if (i === start) {
      issues.push({ at: i, message: `unexpected byte 0x${b.toString(16)}` });
      i++;
      continue;
    }
    const text = LATIN1.decode(source.subarray(start, i));
    if (NUMBER.test(text)) {
      tokens.push({ kind: 'number', start, end: i, number: parseNumber(text) });
      continue;
    }
    if (text === 'BI') {
      const image = lexInlineImage(source, i, issues);
      tokens.push({ kind: 'inline-image', start, end: image.end, data: image.data });
      i = image.end;
      continue;
    }
    tokens.push({ kind: 'keyword', start, end: i, text });
  }

  return { tokens, issues };
}

/**
 * Skips an inline image, from just after `BI` to just after `EI`.
 *
 * The payload between `ID` and `EI` is arbitrary binary, so the end has to be found rather than
 * parsed: look for `EI` preceded by whitespace and followed by whitespace, a delimiter or the
 * end of the stream. That is the heuristic every other reader uses, and the reason inline
 * images are best avoided in a file one intends to edit.
 */
function lexInlineImage(
  source: Uint8Array,
  from: number,
  issues: LexIssue[],
): { readonly end: number; readonly data: { readonly start: number; readonly end: number } } {
  const n = source.length;
  let i = from;
  while (i < n - 1) {
    const isId =
      source[i] === 0x49 &&
      source[i + 1] === 0x44 &&
      (i === 0 || !isRegular(source[i - 1] ?? 0)) &&
      (i + 2 >= n || !isRegular(source[i + 2] ?? 0));
    if (isId) break;
    i++;
  }
  if (i >= n - 1) {
    issues.push({ at: from, message: 'inline image without ID' });
    return { end: n, data: { start: n, end: n } };
  }
  // Exactly one whitespace byte follows `ID`; the payload starts after it.
  const dataStart = i + 2 + (isWhitespace(source[i + 2] ?? 0) ? 1 : 0);
  for (let j = dataStart; j < n - 1; j++) {
    const isEi =
      source[j] === 0x45 &&
      source[j + 1] === 0x49 &&
      isWhitespace(source[j - 1] ?? 0x20) &&
      (j + 2 >= n || !isRegular(source[j + 2] ?? 0));
    if (isEi) return { end: j + 2, data: { start: dataStart, end: j - 1 } };
  }
  issues.push({ at: from, message: 'inline image without EI' });
  return { end: n, data: { start: dataStart, end: n } };
}

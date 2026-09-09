/**
 * Just enough PDF object syntax to read and write an FDF file (M32). Pure, no dependencies.
 *
 * FDF is a PDF file — header, indirect objects, trailer — but a tiny one: no cross-reference
 * table worth trusting, no streams that matter to us, and a single `/FDF` dictionary at the root.
 * pdf-lib will not open it (it wants `%PDF`, an xref and a `/Catalog`), and reaching for a full
 * parser to read four kinds of value would be the wrong shape of dependency for a layer that has
 * to stay importable by a unit test.
 *
 * So: a tokeniser over the file's bytes read as one code unit each ("binary text"), which keeps
 * the offsets exact, and a serialiser that writes the same forms back. Strings are decoded from
 * their bytes properly — UTF-16BE when the BOM says so, PDFDocEncoding otherwise — because a
 * comment's text is the whole point of the file.
 */

/** A PDF object as this layer models it. Streams are read as bytes and never written. */
export type PdfValue =
  | { readonly kind: 'null' }
  | { readonly kind: 'bool'; readonly value: boolean }
  | { readonly kind: 'number'; readonly value: number }
  | { readonly kind: 'string'; readonly value: string }
  | { readonly kind: 'name'; readonly value: string }
  | { readonly kind: 'array'; readonly value: ReadonlyArray<PdfValue> }
  | { readonly kind: 'dict'; readonly value: ReadonlyMap<string, PdfValue> }
  | { readonly kind: 'ref'; readonly number: number; readonly generation: number };

export const PDF_NULL: PdfValue = { kind: 'null' };

// ---- decoding -----------------------------------------------------------------------------------

/** Bytes as one code unit each, so a string index is a byte offset. */
export function bytesToBinary(bytes: Uint8Array): string {
  let out = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    out += String.fromCharCode(...bytes.subarray(i, Math.min(bytes.length, i + chunk)));
  }
  return out;
}

export function binaryToBytes(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

/**
 * PDFDocEncoding's 0x18–0x1F and 0x80–0x9F, which are where it and Latin-1 disagree
 * (PDF 32000-1, annex D.2). Everything else in the range is Latin-1.
 */
const PDF_DOC_HIGH = [
  0x2022, 0x2020, 0x2021, 0x2026, 0x2014, 0x2013, 0x0192, 0x2044, 0x2039, 0x203a, 0x2212, 0x2030,
  0x201e, 0x201c, 0x201d, 0x2018, 0x2019, 0x201a, 0x2122, 0xfb01, 0xfb02, 0x0141, 0x0152, 0x0160,
  0x0178, 0x017d, 0x0131, 0x0142, 0x0153, 0x0161, 0x017e, 0xfffd,
];

function decodePdfDoc(binary: string): string {
  let out = '';
  for (let i = 0; i < binary.length; i++) {
    const code = binary.charCodeAt(i) & 0xff;
    out += String.fromCharCode(code >= 0x80 && code <= 0x9f ? (PDF_DOC_HIGH[code - 0x80] ?? code) : code);
  }
  return out;
}

function encodePdfDoc(text: string): string | null {
  let out = '';
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x80 || (code >= 0xa0 && code <= 0xff)) {
      out += String.fromCharCode(code);
      continue;
    }
    const at = PDF_DOC_HIGH.indexOf(code);
    if (at < 0) return null; // needs UTF-16
    out += String.fromCharCode(0x80 + at);
  }
  return out;
}

/** A PDF text string's bytes → text: UTF-16BE behind a BOM, PDFDocEncoding otherwise. */
export function decodePdfText(binary: string): string {
  if (binary.length >= 2 && binary.charCodeAt(0) === 0xfe && binary.charCodeAt(1) === 0xff) {
    let out = '';
    for (let i = 2; i + 1 < binary.length; i += 2) {
      out += String.fromCharCode(((binary.charCodeAt(i) & 0xff) << 8) | (binary.charCodeAt(i + 1) & 0xff));
    }
    return out;
  }
  return decodePdfDoc(binary);
}

/** Text → the bytes of a PDF text string, with the BOM when PDFDocEncoding cannot hold it. */
export function encodePdfText(text: string): string {
  const simple = encodePdfDoc(text);
  if (simple !== null) return simple;
  let out = 'þÿ';
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    out += String.fromCharCode((unit >> 8) & 0xff, unit & 0xff);
  }
  return out;
}

// ---- tokenising ---------------------------------------------------------------------------------

const WHITESPACE = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
const DELIMITERS = new Set('()<>[]{}/%'.split('').map((c) => c.charCodeAt(0)));

function isWhite(code: number): boolean {
  return WHITESPACE.has(code);
}

function isRegular(code: number): boolean {
  return !isWhite(code) && !DELIMITERS.has(code);
}

/** A cursor over the file's binary text. One instance parses one file. */
export class PdfLexer {
  private at = 0;
  private readonly text: string;

  constructor(text: string) {
    this.text = text;
  }

  get position(): number {
    return this.at;
  }

  set position(value: number) {
    this.at = Math.max(0, Math.min(this.text.length, value));
  }

  get done(): boolean {
    this.skip();
    return this.at >= this.text.length;
  }

  /** Skips whitespace and `%` comments. */
  skip(): void {
    for (;;) {
      while (this.at < this.text.length && isWhite(this.text.charCodeAt(this.at))) this.at++;
      if (this.text.charCodeAt(this.at) !== 0x25) return; // '%'
      while (this.at < this.text.length && this.text.charCodeAt(this.at) !== 0x0a) this.at++;
    }
  }

  /** The next bare token (`obj`, `endobj`, `trailer`, a number, `R`), or null at the end. */
  peekWord(): string | null {
    const save = this.at;
    const word = this.readWord();
    this.at = save;
    return word;
  }

  readWord(): string | null {
    this.skip();
    const start = this.at;
    while (this.at < this.text.length && isRegular(this.text.charCodeAt(this.at))) this.at++;
    if (this.at === start) return null;
    return this.text.slice(start, this.at);
  }

  /**
   * Reads one object. Returns null at the end of input or on a token that cannot start one, so a
   * caller scanning a whole file can step past `endobj` without a special case.
   */
  readValue(depth = 0): PdfValue | null {
    if (depth > 64) return PDF_NULL; // a cycle in a hand-made file must not hang the reader
    this.skip();
    if (this.at >= this.text.length) return null;
    const code = this.text.charCodeAt(this.at);
    if (code === 0x2f) return this.readName();
    if (code === 0x28) return this.readLiteralString();
    if (code === 0x5b) return this.readArray(depth);
    if (code === 0x3c) {
      return this.text.charCodeAt(this.at + 1) === 0x3c
        ? this.readDictionary(depth)
        : this.readHexString();
    }
    if (code === 0x5d || code === 0x3e || code === 0x29) return null; // a closer, not a value
    const word = this.readWord();
    if (word === null) {
      this.at++; // an unexpected delimiter: step over it rather than spin
      return null;
    }
    if (word === 'true') return { kind: 'bool', value: true };
    if (word === 'false') return { kind: 'bool', value: false };
    if (word === 'null') return PDF_NULL;
    if (/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(word)) {
      const value = Number(word);
      // `12 0 R` — a reference. Only an integer can start one.
      if (Number.isInteger(value) && value >= 0) {
        const save = this.at;
        const gen = this.readWord();
        if (gen !== null && /^\d+$/.test(gen) && this.peekWord() === 'R') {
          this.readWord();
          return { kind: 'ref', number: value, generation: Number(gen) };
        }
        this.at = save;
      }
      return { kind: 'number', value };
    }
    return null;
  }

  private readName(): PdfValue {
    this.at++; // '/'
    let out = '';
    while (this.at < this.text.length && isRegular(this.text.charCodeAt(this.at))) {
      const char = this.text[this.at] ?? '';
      if (char === '#' && /^[0-9a-f]{2}$/i.test(this.text.slice(this.at + 1, this.at + 3))) {
        out += String.fromCharCode(Number.parseInt(this.text.slice(this.at + 1, this.at + 3), 16));
        this.at += 3;
        continue;
      }
      out += char;
      this.at++;
    }
    return { kind: 'name', value: out };
  }

  private readLiteralString(): PdfValue {
    this.at++; // '('
    let depth = 1;
    let raw = '';
    while (this.at < this.text.length) {
      const char = this.text[this.at] ?? '';
      this.at++;
      if (char === '\\') {
        const next = this.text[this.at] ?? '';
        this.at++;
        switch (next) {
          case 'n':
            raw += '\n';
            break;
          case 'r':
            raw += '\r';
            break;
          case 't':
            raw += '\t';
            break;
          case 'b':
            raw += '\b';
            break;
          case 'f':
            raw += '\f';
            break;
          case '\n':
            break; // a line continuation
          case '\r':
            if (this.text[this.at] === '\n') this.at++;
            break;
          default:
            if (next >= '0' && next <= '7') {
              let octal = next;
              while (octal.length < 3) {
                const digit = this.text[this.at] ?? '';
                if (digit < '0' || digit > '7') break;
                octal += digit;
                this.at++;
              }
              raw += String.fromCharCode(Number.parseInt(octal, 8) & 0xff);
            } else {
              raw += next;
            }
        }
        continue;
      }
      if (char === '(') depth++;
      if (char === ')') {
        depth--;
        if (depth === 0) break;
      }
      raw += char;
    }
    return { kind: 'string', value: decodePdfText(raw) };
  }

  private readHexString(): PdfValue {
    this.at++; // '<'
    let digits = '';
    while (this.at < this.text.length && this.text[this.at] !== '>') {
      const char = this.text[this.at] ?? '';
      if (/[0-9a-f]/i.test(char)) digits += char;
      this.at++;
    }
    this.at++; // '>'
    if (digits.length % 2 === 1) digits += '0';
    let raw = '';
    for (let i = 0; i < digits.length; i += 2) {
      raw += String.fromCharCode(Number.parseInt(digits.slice(i, i + 2), 16));
    }
    return { kind: 'string', value: decodePdfText(raw) };
  }

  private readArray(depth: number): PdfValue {
    this.at++; // '['
    const items: PdfValue[] = [];
    for (;;) {
      this.skip();
      if (this.at >= this.text.length) break;
      if (this.text[this.at] === ']') {
        this.at++;
        break;
      }
      const value = this.readValue(depth + 1);
      if (value === null) {
        if (this.text[this.at] === ']') {
          this.at++;
          break;
        }
        continue;
      }
      items.push(value);
    }
    return { kind: 'array', value: items };
  }

  private readDictionary(depth: number): PdfValue {
    this.at += 2; // '<<'
    const entries = new Map<string, PdfValue>();
    for (;;) {
      this.skip();
      if (this.at >= this.text.length) break;
      if (this.text.startsWith('>>', this.at)) {
        this.at += 2;
        break;
      }
      if (this.text[this.at] !== '/') {
        // Not a key: step past whatever it is rather than loop for ever.
        const value = this.readValue(depth + 1);
        if (value === null) this.at++;
        continue;
      }
      const key = this.readName();
      const value = this.readValue(depth + 1);
      if (key.kind === 'name') entries.set(key.value, value ?? PDF_NULL);
    }
    return { kind: 'dict', value: entries };
  }
}

// ---- serialising --------------------------------------------------------------------------------

const NAME_SAFE = /^[A-Za-z0-9_.\-+]*$/;

function writeName(value: string): string {
  if (NAME_SAFE.test(value)) return `/${value}`;
  let out = '/';
  for (const char of value) {
    const code = char.charCodeAt(0);
    out += NAME_SAFE.test(char) ? char : `#${code.toString(16).padStart(2, '0')}`;
  }
  return out;
}

function writeString(value: string): string {
  const raw = encodePdfText(value);
  // Hex whenever the text needed UTF-16 or carries anything awkward: shorter to reason about
  // than an escaping table, and every reader takes it.
  const needsHex = /[^\x20-\x7e]/.test(raw) || raw.includes('\\');
  if (needsHex) {
    let hex = '';
    for (let i = 0; i < raw.length; i++) hex += (raw.charCodeAt(i) & 0xff).toString(16).padStart(2, '0');
    return `<${hex.toUpperCase()}>`;
  }
  return `(${raw.replace(/([()\\])/g, '\\$1')})`;
}

/** One value as PDF syntax. Numbers keep four decimals at most, as everywhere else. */
export function writeValue(value: PdfValue): string {
  switch (value.kind) {
    case 'null':
      return 'null';
    case 'bool':
      return value.value ? 'true' : 'false';
    case 'number': {
      const rounded = Math.round(value.value * 1e4) / 1e4;
      return Object.is(rounded, -0) ? '0' : String(rounded);
    }
    case 'string':
      return writeString(value.value);
    case 'name':
      return writeName(value.value);
    case 'array':
      return `[${value.value.map(writeValue).join(' ')}]`;
    case 'dict': {
      const parts: string[] = [];
      for (const [key, entry] of value.value) parts.push(`${writeName(key)} ${writeValue(entry)}`);
      return `<<${parts.join(' ')}>>`;
    }
    case 'ref':
      return `${String(value.number)} ${String(value.generation)} R`;
  }
}

// ---- reading helpers ----------------------------------------------------------------------------

export function asNumber(value: PdfValue | undefined): number | null {
  return value?.kind === 'number' ? value.value : null;
}

export function asString(value: PdfValue | undefined): string | null {
  return value?.kind === 'string' ? value.value : null;
}

export function asName(value: PdfValue | undefined): string | null {
  return value?.kind === 'name' ? value.value : null;
}

export function asArray(value: PdfValue | undefined): ReadonlyArray<PdfValue> {
  return value?.kind === 'array' ? value.value : [];
}

export function asNumbers(value: PdfValue | undefined): number[] {
  return asArray(value)
    .map((item) => (item.kind === 'number' ? item.value : Number.NaN))
    .filter((n) => Number.isFinite(n));
}

export function asDict(value: PdfValue | undefined): ReadonlyMap<string, PdfValue> | null {
  return value?.kind === 'dict' ? value.value : null;
}

/** Builds a dictionary value, skipping entries whose value is null or undefined. */
export function dict(entries: Readonly<Record<string, PdfValue | null | undefined>>): PdfValue {
  const map = new Map<string, PdfValue>();
  for (const [key, value] of Object.entries(entries)) {
    if (value === null || value === undefined) continue;
    map.set(key, value);
  }
  return { kind: 'dict', value: map };
}

export const pdfNumber = (value: number): PdfValue => ({ kind: 'number', value });
export const pdfString = (value: string): PdfValue => ({ kind: 'string', value });
export const pdfName = (value: string): PdfValue => ({ kind: 'name', value });
export const pdfArray = (value: ReadonlyArray<PdfValue>): PdfValue => ({ kind: 'array', value });
export const pdfNumbers = (values: ReadonlyArray<number>): PdfValue =>
  pdfArray(values.map(pdfNumber));

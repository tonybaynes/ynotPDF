/**
 * Content-stream parser (M50, ADR 0018): tokens → operators with operands.
 *
 * The one property that everything above depends on: **op spans tile the source**. Op *i*'s
 * span runs from the end of op *i−1* to the end of its own operator token, so the whitespace and
 * comments between two operators belong to the later one, and the `trailer` is whatever follows
 * the last operator. Concatenating every span and the trailer reproduces the input exactly, and
 * `serialise` relies on that to copy untouched ops byte for byte.
 */

import { lex, type LexIssue, type Token } from './lexer';

/** An operand value. Strings keep their bytes; a content stream's text is not Unicode. */
export type ContentValue =
  | { readonly kind: 'number'; readonly value: number }
  | { readonly kind: 'name'; readonly value: string }
  | { readonly kind: 'string'; readonly value: Uint8Array; readonly hex: boolean }
  | { readonly kind: 'bool'; readonly value: boolean }
  | { readonly kind: 'null' }
  | { readonly kind: 'array'; readonly items: ReadonlyArray<ContentValue> }
  | { readonly kind: 'dict'; readonly entries: ReadonlyArray<readonly [string, ContentValue]> };

/** An inline image: its dictionary and its raw payload. */
export interface InlineImage {
  readonly dict: ReadonlyArray<readonly [string, ContentValue]>;
  readonly data: Uint8Array;
}

/** One operator and its operands. */
export interface ContentOp {
  readonly operator: string;
  readonly operands: ReadonlyArray<ContentValue>;
  /**
   * Byte span in the source this op owns, `[start, end)`. Absent for an op that was built rather
   * than parsed, which the serialiser then formats.
   */
  readonly span?: readonly [number, number];
  /** Present when `operator` is `BI`: the whole `BI … ID … EI` sequence is one op. */
  readonly image?: InlineImage;
}

export interface ContentStream {
  readonly source: Uint8Array;
  readonly ops: ReadonlyArray<ContentOp>;
  /** Bytes after the last operator: `[start, end)`. */
  readonly trailer: readonly [number, number];
  readonly issues: ReadonlyArray<LexIssue>;
}

/** Parses a content stream. Operands with no operator at the end become an issue, not an op. */
export function parse(source: Uint8Array): ContentStream {
  const { tokens, issues } = lex(source);
  const ops: ContentOp[] = [];
  const problems = [...issues];
  let operands: ContentValue[] = [];
  let spanStart = 0;
  let i = 0;

  while (i < tokens.length) {
    const t = tokens[i];
    if (!t) break;
    switch (t.kind) {
      case 'comment':
        i++;
        continue;
      case 'keyword': {
        const text = t.text ?? '';
        if (text === 'true' || text === 'false') {
          operands.push({ kind: 'bool', value: text === 'true' });
          i++;
          continue;
        }
        if (text === 'null') {
          operands.push({ kind: 'null' });
          i++;
          continue;
        }
        ops.push({ operator: text, operands, span: [spanStart, t.end] });
        operands = [];
        spanStart = t.end;
        i++;
        continue;
      }
      case 'inline-image': {
        const image = parseInlineImage(source, t, problems);
        ops.push({ operator: 'BI', operands: [], span: [spanStart, t.end], image });
        operands = [];
        spanStart = t.end;
        i++;
        continue;
      }
      default: {
        const parsed = parseValue(tokens, i, problems);
        operands.push(parsed.value);
        i = parsed.next;
      }
    }
  }
  if (operands.length > 0) {
    problems.push({ at: spanStart, message: `${operands.length} operand(s) with no operator` });
  }
  return { source, ops, trailer: [spanStart, source.length], issues: problems };
}

function parseValue(
  tokens: ReadonlyArray<Token>,
  at: number,
  issues: LexIssue[],
): { readonly value: ContentValue; readonly next: number } {
  const t = tokens[at];
  if (!t) return { value: { kind: 'null' }, next: at + 1 };
  switch (t.kind) {
    case 'number':
      return { value: { kind: 'number', value: t.number ?? 0 }, next: at + 1 };
    case 'name':
      return { value: { kind: 'name', value: t.text ?? '' }, next: at + 1 };
    case 'string':
      return {
        value: { kind: 'string', value: t.bytes ?? new Uint8Array(), hex: false },
        next: at + 1,
      };
    case 'hexstring':
      return {
        value: { kind: 'string', value: t.bytes ?? new Uint8Array(), hex: true },
        next: at + 1,
      };
    case 'array-open': {
      const items: ContentValue[] = [];
      let i = at + 1;
      while (i < tokens.length) {
        const n = tokens[i];
        if (!n) break;
        if (n.kind === 'array-close') return { value: { kind: 'array', items }, next: i + 1 };
        if (n.kind === 'comment') {
          i++;
          continue;
        }
        if (n.kind === 'keyword' && n.text !== 'true' && n.text !== 'false' && n.text !== 'null') {
          // An operator inside an array: the array was never closed.
          issues.push({ at: t.start, message: 'unterminated array' });
          return { value: { kind: 'array', items }, next: i };
        }
        const parsed = parseValue(tokens, i, issues);
        items.push(parsed.value);
        i = parsed.next;
      }
      issues.push({ at: t.start, message: 'unterminated array' });
      return { value: { kind: 'array', items }, next: i };
    }
    case 'dict-open': {
      const entries: Array<readonly [string, ContentValue]> = [];
      let i = at + 1;
      while (i < tokens.length) {
        const n = tokens[i];
        if (!n) break;
        if (n.kind === 'dict-close') return { value: { kind: 'dict', entries }, next: i + 1 };
        if (n.kind === 'comment') {
          i++;
          continue;
        }
        if (n.kind === 'keyword' && n.text !== 'true' && n.text !== 'false' && n.text !== 'null') {
          // An operator inside a dictionary: the dictionary was never closed.
          issues.push({ at: t.start, message: 'unterminated dictionary' });
          return { value: { kind: 'dict', entries }, next: i };
        }
        if (n.kind !== 'name') {
          issues.push({ at: n.start, message: 'dictionary key is not a name' });
          i++;
          continue;
        }
        const parsed = parseValue(tokens, i + 1, issues);
        entries.push([n.text ?? '', parsed.value]);
        i = parsed.next;
      }
      issues.push({ at: t.start, message: 'unterminated dictionary' });
      return { value: { kind: 'dict', entries }, next: i };
    }
    case 'keyword':
      if (t.text === 'true' || t.text === 'false') {
        return { value: { kind: 'bool', value: t.text === 'true' }, next: at + 1 };
      }
      if (t.text === 'null') return { value: { kind: 'null' }, next: at + 1 };
      issues.push({ at: t.start, message: `unexpected operator ${t.text ?? ''} as operand` });
      return { value: { kind: 'null' }, next: at + 1 };
    default:
      issues.push({ at: t.start, message: `unexpected ${t.kind}` });
      return { value: { kind: 'null' }, next: at + 1 };
  }
}

/** The dictionary between `BI` and `ID` is a bare sequence of key/value pairs, no `<<`. */
function parseInlineImage(source: Uint8Array, t: Token, issues: LexIssue[]): InlineImage {
  const data = t.data ?? { start: t.end, end: t.end };
  // Re-lex just the dictionary part: from after `BI` to just before `ID`.
  const dictEnd = Math.max(t.start + 2, data.start - 3);
  const inner = lex(source.subarray(t.start + 2, dictEnd));
  const tokens = inner.tokens;
  const entries: Array<readonly [string, ContentValue]> = [];
  let i = 0;
  while (i < tokens.length) {
    const k = tokens[i];
    if (!k) break;
    if (k.kind !== 'name') {
      i++;
      continue;
    }
    const parsed = parseValue(tokens, i + 1, issues);
    entries.push([k.text ?? '', parsed.value]);
    i = parsed.next;
  }
  return { dict: entries, data: source.subarray(data.start, Math.max(data.start, data.end)) };
}

/** Numeric operands of an op, in order; non-numbers read as 0. */
export function numbers(op: ContentOp): number[] {
  return op.operands.map((v) => (v.kind === 'number' ? v.value : 0));
}

/** The first name operand, or null. */
export function nameOperand(op: ContentOp): string | null {
  const v = op.operands.find((o) => o.kind === 'name');
  return v?.kind === 'name' ? v.value : null;
}

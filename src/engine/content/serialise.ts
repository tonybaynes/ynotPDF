/**
 * Content-stream serialiser (M50, ADR 0018): operators back to bytes.
 *
 * An op that still carries its source span is copied byte for byte — whitespace, comments and
 * the producer's own number formatting included. Only an op that was built or changed is
 * formatted here. That is the whole of the byte-preservation guarantee: nothing is reformatted
 * that did not have to be.
 */

import type { ContentOp, ContentStream, ContentValue, InlineImage } from './parser';
import { isRegular, isWhitespace } from './lexer';

const LATIN1 = new TextDecoder('latin1');

/** Formats a number the way content streams like them: no exponent, no trailing zeros. */
export function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return '0';
  if (Number.isInteger(n)) return n === 0 ? '0' : String(n);
  const fixed = n.toFixed(5).replace(/0+$/, '').replace(/\.$/, '');
  return fixed === '-0' || fixed === '' ? '0' : fixed;
}

/** Escapes a name's body (PDF 7.3.5): delimiters, whitespace and `#` become `#xx`. */
export function formatName(name: string): string {
  let out = '/';
  for (const ch of name) {
    const code = ch.charCodeAt(0);
    if (code > 0x7e || code < 0x21 || code === 0x23 || !isRegular(code)) {
      out += `#${code.toString(16).padStart(2, '0')}`;
    } else {
      out += ch;
    }
  }
  return out;
}

function formatString(bytes: Uint8Array, hex: boolean): string {
  if (hex) {
    let out = '<';
    for (const b of bytes) out += b.toString(16).padStart(2, '0');
    return `${out}>`;
  }
  let out = '(';
  for (const b of bytes) {
    switch (b) {
      case 0x28:
        out += '\\(';
        break;
      case 0x29:
        out += '\\)';
        break;
      case 0x5c:
        out += '\\\\';
        break;
      case 0x0a:
        out += '\\n';
        break;
      case 0x0d:
        out += '\\r';
        break;
      default:
        out +=
          b < 0x20 || b > 0x7e ? `\\${b.toString(8).padStart(3, '0')}` : String.fromCharCode(b);
    }
  }
  return `${out})`;
}

/** Formats one operand. */
export function formatValue(v: ContentValue): string {
  switch (v.kind) {
    case 'number':
      return formatNumber(v.value);
    case 'name':
      return formatName(v.value);
    case 'string':
      return formatString(v.value, v.hex);
    case 'bool':
      return v.value ? 'true' : 'false';
    case 'null':
      return 'null';
    case 'array':
      return `[${v.items.map(formatValue).join(' ')}]`;
    case 'dict':
      return `<<${v.entries.map(([k, e]) => `${formatName(k)} ${formatValue(e)}`).join(' ')}>>`;
  }
}

function formatInlineImage(image: InlineImage): Uint8Array {
  const head = `BI ${image.dict.map(([k, v]) => `${formatName(k)} ${formatValue(v)}`).join(' ')} ID `;
  const tail = '\nEI';
  const out = new Uint8Array(head.length + image.data.length + tail.length);
  out.set(encodeLatin1(head), 0);
  out.set(image.data, head.length);
  out.set(encodeLatin1(tail), head.length + image.data.length);
  return out;
}

/** Formats one op as text (without its source span). */
export function formatOp(op: ContentOp): string {
  if (op.operator === 'BI' && op.image) return LATIN1.decode(formatInlineImage(op.image));
  const operands = op.operands.map(formatValue);
  return operands.length > 0 ? `${operands.join(' ')} ${op.operator}` : op.operator;
}

function encodeLatin1(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

/**
 * Serialises `ops` against the source they were parsed from. Ops with a span are copied; ops
 * without one are formatted on their own line, and get a trailing newline whenever what follows
 * would otherwise run straight into them.
 */
export function serialise(stream: ContentStream, ops: ReadonlyArray<ContentOp>): Uint8Array {
  const parts: Uint8Array[] = [];
  let total = 0;
  const push = (bytes: Uint8Array): void => {
    parts.push(bytes);
    total += bytes.length;
  };
  const source = stream.source;

  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    if (!op) continue;
    if (op.span) {
      push(source.subarray(op.span[0], op.span[1]));
      continue;
    }
    const bytes =
      op.operator === 'BI' && op.image ? formatInlineImage(op.image) : encodeLatin1(formatOp(op));
    const next = ops[i + 1];
    const nextStartsRegular = next?.span
      ? isRegular(source[next.span[0]] ?? 0x20)
      : next !== undefined
        ? false
        : isRegular(source[stream.trailer[0]] ?? 0x20) && stream.trailer[1] > stream.trailer[0];
    const previous = parts[parts.length - 1];
    const previousEndsRegular =
      previous !== undefined && previous.length > 0
        ? !isWhitespace(previous[previous.length - 1] ?? 0x20)
        : false;
    push(encodeLatin1(previousEndsRegular ? '\n' : ''));
    push(bytes);
    if (nextStartsRegular) push(encodeLatin1('\n'));
  }
  push(source.subarray(stream.trailer[0], stream.trailer[1]));

  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** Builds an op from plain values — the way edits describe what they add. */
export function op(
  operator: string,
  ...operands: Array<number | string | ContentValue>
): ContentOp {
  return {
    operator,
    operands: operands.map((o) =>
      typeof o === 'number'
        ? { kind: 'number', value: o }
        : typeof o === 'string'
          ? { kind: 'name', value: o }
          : o,
    ),
  };
}

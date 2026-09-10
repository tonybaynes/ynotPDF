/**
 * The content-stream lexer and parser (M50): every token kind the spec defines, the escapes
 * producers actually emit, and the one binary exception — inline images.
 */

import { describe, expect, it } from 'vitest';
import {
  decodeHexString,
  decodeLiteralString,
  decodeName,
  formatName,
  formatNumber,
  formatOp,
  lex,
  numbers,
  op,
  parse,
  serialise,
} from '@engine/content';
import { ascii, text } from './helpers';

describe('lex', () => {
  it('reads numbers the way producers write them', () => {
    const { tokens } = lex(ascii('1 -3 .5 4. +2 --7 0.000'));
    expect(tokens.map((t) => t.number)).toEqual([1, -3, 0.5, 4, 2, -7, 0]);
  });

  it('reads names with #xx escapes and keeps their byte offsets', () => {
    const { tokens } = lex(ascii('/F1 /A#20B /#2Fslash'));
    expect(tokens.map((t) => t.text)).toEqual(['F1', 'A B', '/slash']);
    expect(tokens[1]?.start).toBe(4);
    expect(tokens[1]?.end).toBe(10);
  });

  it('reads literal strings with nested parentheses and escapes', () => {
    const { tokens } = lex(ascii('(a(b)c) (line\\nbreak) (\\101\\12) (tail\\\n)'));
    expect(tokens.map((t) => text(t.bytes ?? new Uint8Array()))).toEqual([
      'a(b)c',
      'line\nbreak',
      'A\n',
      'tail',
    ]);
  });

  it('reads hex strings, odd digits and whitespace included', () => {
    expect([...decodeHexString(ascii('41 42 4'))]).toEqual([0x41, 0x42, 0x40]);
    const { tokens } = lex(ascii('<48656C6C6F> Tj'));
    expect(text(tokens[0]?.bytes ?? new Uint8Array())).toBe('Hello');
    expect(tokens[1]?.kind).toBe('keyword');
  });

  it('reads arrays, dictionaries, booleans, null and comments', () => {
    const { tokens } = lex(ascii('[1 (a) /N] << /K true /V null >> % note\nQ'));
    expect(tokens.map((t) => t.kind)).toEqual([
      'array-open',
      'number',
      'string',
      'name',
      'array-close',
      'dict-open',
      'name',
      'keyword',
      'name',
      'keyword',
      'dict-close',
      'comment',
      'keyword',
    ]);
  });

  it('skips an inline image as one token and finds its payload', () => {
    const src = ascii('q BI /W 2 /H 2 /BPC 8 /CS /G ID \x00\xff\x45\x49 EI Q');
    const { tokens, issues } = lex(src);
    expect(issues).toEqual([]);
    expect(tokens.map((t) => t.kind)).toEqual(['keyword', 'inline-image', 'keyword']);
    const image = tokens[1];
    expect(image?.data).toEqual({ start: 32, end: 36 });
  });

  it('reports rather than throws on broken input', () => {
    const { issues } = lex(ascii('(never closed'));
    expect(issues.map((i) => i.message)).toEqual(['unterminated string']);
    expect(lex(ascii(') > x')).issues.length).toBe(2);
  });

  it('decodes names and strings on their own', () => {
    expect(decodeName(ascii('A#2'))).toBe('A#2');
    expect([...decodeLiteralString(ascii('\\r\\t\\b\\f\\x'))]).toEqual([13, 9, 8, 12, 0x78]);
  });
});

describe('parse', () => {
  it('groups operands with their operator and tiles the source with spans', () => {
    const src = ascii('  1 0 0 1 10 20 cm\n/F1 12 Tf % comment\n(Hi) Tj  ');
    const stream = parse(src);
    expect(stream.ops.map((o) => o.operator)).toEqual(['cm', 'Tf', 'Tj']);
    expect(numbers(stream.ops[0] ?? op('x'))).toEqual([1, 0, 0, 1, 10, 20]);
    let at = 0;
    for (const o of stream.ops) {
      expect(o.span?.[0]).toBe(at);
      at = o.span?.[1] ?? at;
    }
    expect(stream.trailer).toEqual([at, src.length]);
    expect(serialise(stream, stream.ops)).toEqual(src);
  });

  it('parses nested arrays and dictionaries as operands', () => {
    const stream = parse(ascii('[(A) -20 (B)] TJ /Span << /MCID 3 /Alt (x) >> BDC EMC'));
    expect(stream.ops[0]?.operands[0]?.kind).toBe('array');
    const dict = stream.ops[1]?.operands[1];
    expect(dict?.kind).toBe('dict');
    if (dict?.kind === 'dict') expect(dict.entries.map(([k]) => k)).toEqual(['MCID', 'Alt']);
    expect(stream.ops.map((o) => o.operator)).toEqual(['TJ', 'BDC', 'EMC']);
  });

  it('keeps an inline image as one op with its dictionary and bytes', () => {
    const stream = parse(ascii('BI /W 1 /H 1 /BPC 8 /CS /G ID \xaa EI\nQ'));
    expect(stream.ops[0]?.operator).toBe('BI');
    expect(stream.ops[0]?.image?.dict.map(([k]) => k)).toEqual(['W', 'H', 'BPC', 'CS']);
    expect([...(stream.ops[0]?.image?.data ?? [])]).toEqual([0xaa]);
    expect(stream.ops[1]?.operator).toBe('Q');
  });

  it('reports operands left without an operator', () => {
    const stream = parse(ascii('1 2 3'));
    expect(stream.ops).toEqual([]);
    expect(stream.issues[0]?.message).toContain('operand');
  });

  it('survives an unterminated array and an operator where a value belongs', () => {
    const stream = parse(ascii('[1 2 Tj << /A 1 Q'));
    expect(stream.ops.map((o) => o.operator)).toEqual(['Tj', 'Q']);
    expect(stream.issues.length).toBeGreaterThan(0);
  });
});

describe('serialise', () => {
  it('formats numbers without noise', () => {
    expect(formatNumber(1)).toBe('1');
    expect(formatNumber(0)).toBe('0');
    expect(formatNumber(-0)).toBe('0');
    expect(formatNumber(0.5)).toBe('0.5');
    expect(formatNumber(1.23456789)).toBe('1.23457');
    expect(formatNumber(2.5e-7)).toBe('0');
    expect(formatNumber(Number.NaN)).toBe('0');
  });

  it('escapes names and strings so they read back the same', () => {
    expect(formatName('A B/C#')).toBe('/A#20B#2fC#23');
    const s = op('Tj', { kind: 'string', value: ascii('a(b)\\\n\x01'), hex: false });
    const round = parse(ascii(formatOp(s)));
    expect(
      text(
        round.ops[0]?.operands[0]?.kind === 'string'
          ? round.ops[0].operands[0].value
          : new Uint8Array(),
      ),
    ).toBe('a(b)\\\n\x01');
    const h = op('Tj', { kind: 'string', value: new Uint8Array([0, 255]), hex: true });
    expect(formatOp(h)).toBe('<00ff> Tj');
  });

  it('formats built ops on their own lines between copied ones', () => {
    const src = ascii('q\n1 0 0 RG\nQ');
    const stream = parse(src);
    const ops = [stream.ops[0], op('cm', 2, 0, 0, 2, 0, 0), stream.ops[1], stream.ops[2]].filter(
      (o): o is NonNullable<typeof o> => o !== undefined,
    );
    expect(text(serialise(stream, ops))).toBe('q\n2 0 0 2 0 0 cm\n1 0 0 RG\nQ');
  });

  it('separates a built op from a copied one that starts without whitespace', () => {
    const src = ascii('ET/F1 12 Tf');
    const stream = parse(src);
    const ops = [stream.ops[0], op('Q'), stream.ops[1]].filter(
      (o): o is NonNullable<typeof o> => o !== undefined,
    );
    expect(text(serialise(stream, ops))).toBe('ET\nQ/F1 12 Tf');
    const src2 = ascii('ET 1 w');
    const stream2 = parse(src2);
    const ops2 = [stream2.ops[0], op('Q'), stream2.ops[1]].filter(
      (o): o is NonNullable<typeof o> => o !== undefined,
    );
    // `1 w` keeps its own leading space, so nothing is added.
    expect(text(serialise(stream2, ops2))).toBe('ET\nQ 1 w');
  });

  it('writes an inline image back with its payload', () => {
    const stream = parse(ascii('BI /W 1 /H 1 ID \xaa EI'));
    const rebuilt = op('BI');
    const withImage = { ...rebuilt, image: stream.ops[0]?.image };
    const out = text(serialise(stream, [withImage]));
    expect(out.startsWith('BI /W 1 /H 1 ID ')).toBe(true);
    expect(out.endsWith('\nEI')).toBe(true);
  });
});

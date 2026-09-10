/**
 * Content-stream edits (M50): a transform wraps exactly the object's operators, a text move
 * becomes an explicit `Tm` with the operators after it repaired, a removal drops the span, an
 * insert lands on top — and everything else in the stream stays byte for byte.
 */

import { describe, expect, it } from 'vitest';
import {
  applyEdits,
  drawXObjectOps,
  localDelta,
  matrix,
  parse,
  scanObjects,
  serialise,
  trueTextMatrix,
} from '@engine/content';
import { ascii, text } from './helpers';

const PAGE = ascii(
  [
    'q',
    '1 0 0 RG 2 w',
    '10 10 m 50 50 l S',
    '0 0 1 rg',
    '100 100 200 50 re f',
    'Q',
    'q 0.5 0 0 0.5 0 0 cm /Im1 Do Q',
    'BT /F1 12 Tf 1 0 0 1 72 700 Tm (Hello) Tj (World) Tj 0 -14 Td (Next) Tj ET',
  ].join('\n'),
);

describe('applyEdits — page-level objects', () => {
  it('wraps a path in q/cm/Q and leaves the rest byte-identical', () => {
    const stream = parse(PAGE);
    const { ops, refused, applied } = applyEdits(stream, [
      { kind: 'transform', index: 0, matrix: matrix.translation(10, 0) },
    ]);
    expect(refused).toEqual([]);
    expect(applied).toBe(1);
    const out = text(serialise(stream, ops));
    expect(out).toContain('2 w\nq\n1 0 0 1 10 0 cm\n10 10 m 50 50 l S\nQ\n0 0 1 rg');
    expect(out.replace('q\n1 0 0 1 10 0 cm\n', '').replace(' S\nQ\n', ' S\n')).toBe(text(PAGE));
  });

  it('conjugates the delta into a scaled frame', () => {
    const stream = parse(PAGE);
    const { ops } = applyEdits(stream, [
      { kind: 'transform', index: 2, matrix: matrix.translation(10, 20) },
    ]);
    const out = text(serialise(stream, ops));
    // Under `0.5 cm` a 10 pt move on the page is 20 units in the object's frame.
    expect(out).toContain('q\n1 0 0 1 20 40 cm /Im1 Do\nQ Q');
    expect(localDelta(matrix.translation(10, 20), [0.5, 0, 0, 0.5, 0, 0])).toEqual([
      1, 0, 0, 1, 20, 40,
    ]);
  });

  it('composes repeated transforms of one object and lets a removal win', () => {
    const stream = parse(PAGE);
    const { ops } = applyEdits(stream, [
      { kind: 'transform', index: 1, matrix: matrix.translation(1, 0) },
      { kind: 'transform', index: 1, matrix: matrix.translation(2, 0) },
      { kind: 'transform', index: 0, matrix: matrix.translation(5, 5) },
      { kind: 'remove', index: 0 },
    ]);
    const out = text(serialise(stream, ops));
    expect(out).toContain('1 0 0 1 3 0 cm\n100 100 200 50 re f\nQ');
    expect(out).not.toContain('10 10 m');
    expect(out).not.toContain('5 5 cm');
  });

  it('treats an identity transform as done and refuses a missing object', () => {
    const stream = parse(PAGE);
    const result = applyEdits(stream, [
      { kind: 'transform', index: 0, matrix: matrix.IDENTITY },
      { kind: 'remove', index: 99 },
    ]);
    expect(result.applied).toBe(1);
    expect(result.refused[0]).toContain('no object 99');
    expect(serialise(stream, result.ops)).toEqual(PAGE);
  });

  it('refuses a path interleaved with state operators', () => {
    const stream = parse(ascii('10 10 m 3 w 20 20 l S'));
    const result = applyEdits(stream, [
      { kind: 'transform', index: 0, matrix: matrix.translation(1, 1) },
    ]);
    expect(result.refused[0]).toContain('interleaved');
  });

  it('inserts on top after closing the q the producer left open', () => {
    const stream = parse(ascii('q 1 0 0 1 5 5 cm 0 0 m 1 1 l S'));
    const { ops } = applyEdits(stream, [
      { kind: 'insert', ops: drawXObjectOps('X1', matrix.translation(1, 2)) },
    ]);
    expect(text(serialise(stream, ops))).toBe(
      'q 1 0 0 1 5 5 cm 0 0 m 1 1 l S\nQ\nq\n1 0 0 1 1 2 cm\n/X1 Do\nQ',
    );
  });
});

describe('applyEdits — text', () => {
  const reported = (): Map<number, [number, number, number, number, number, number]> =>
    new Map([
      [3, [1, 0, 0, 1, 72, 700]],
      [4, [1, 0, 0, 1, 105, 700]],
      [5, [1, 0, 0, 1, 72, 686]],
    ]);

  it('moves a text object with an explicit Tm and repairs the one after it', () => {
    const stream = parse(PAGE);
    const { ops, refused } = applyEdits(
      stream,
      [{ kind: 'transform', index: 3, matrix: matrix.translation(0, -100) }],
      { textMatrices: reported() },
    );
    expect(refused).toEqual([]);
    const out = text(serialise(stream, ops));
    // Hello moves; World gets its own start back; the Td that follows gets the line matrix back.
    expect(out).toContain(
      '1 0 0 1 72 700 Tm\n1 0 0 1 72 600 Tm (Hello) Tj\n1 0 0 1 105 700 Tm (World) Tj\n1 0 0 1 72 700 Tm 0 -14 Td (Next) Tj ET',
    );
  });

  it('repairs only the text matrix after a removal', () => {
    const stream = parse(PAGE);
    const { ops, refused } = applyEdits(stream, [{ kind: 'remove', index: 3 }], {
      textMatrices: reported(),
    });
    expect(refused).toEqual([]);
    const out = text(serialise(stream, ops));
    // World gets its own start; that clobbers the line matrix, so the Td after it gets it back.
    expect(out).toContain(
      '72 700 Tm\n1 0 0 1 105 700 Tm (World) Tj\n1 0 0 1 72 700 Tm 0 -14 Td (Next) Tj ET',
    );
    expect(out).not.toContain('(Hello)');
  });

  it('skips a following show operator that is itself removed', () => {
    const stream = parse(PAGE);
    const { ops } = applyEdits(
      stream,
      [
        { kind: 'remove', index: 3 },
        { kind: 'remove', index: 4 },
      ],
      { textMatrices: reported() },
    );
    const out = text(serialise(stream, ops));
    expect(out).toContain('72 700 Tm 0 -14 Td (Next) Tj ET');
  });

  it('refuses a text edit without recorded matrices', () => {
    const stream = parse(PAGE);
    const result = applyEdits(stream, [
      { kind: 'transform', index: 3, matrix: matrix.translation(1, 0) },
    ]);
    expect(result.refused[0]).toContain('no recorded matrix');
  });

  it('undoes the horizontal scaling and rise PDFium folds in', () => {
    expect(trueTextMatrix([2, 0, 0, 1, 10, 10], 2, 0)).toEqual([1, 0, 0, 1, 10, 10]);
    expect(trueTextMatrix([1, 0, 0, 1, 10, 15], 1, 5)).toEqual([1, 0, 0, 1, 10, 10]);
  });
});

describe('scanObjects', () => {
  it('lists the objects PDFium would, with their spans and frames', () => {
    const scan = scanObjects(parse(PAGE).ops);
    expect(scan.objects.map((o) => o.kind)).toEqual([
      'path',
      'path',
      'xobject',
      'text',
      'text',
      'text',
    ]);
    expect(scan.objects[2]?.ctm).toEqual([0.5, 0, 0, 0.5, 0, 0]);
    expect(scan.objects[2]?.name).toBe('Im1');
    expect(scan.objects[4]?.text?.tlm).toEqual([1, 0, 0, 1, 72, 700]);
    expect(scan.objects[5]?.text?.tlm).toEqual([1, 0, 0, 1, 72, 686]);
    expect(scan.openDepth).toBe(0);
  });

  it('drops what PDFium drops: one-point paths, clips, empty and fontless text', () => {
    const scan = scanObjects(
      parse(
        ascii('5 5 m S 0 0 10 10 re W n BT (nofont) Tj /F1 9 Tf () Tj [(a)] TJ ET 1 1 m 2 2 l h S'),
      ).ops,
    );
    expect(scan.objects.map((o) => o.kind)).toEqual(['text', 'path']);
  });

  it('tracks TD, T*, quote operators and the leading they imply', () => {
    const scan = scanObjects(parse(ascii("BT /F1 1 Tf 0 -10 TD (a) Tj T* (b) Tj (c) ' ET")).ops);
    expect(scan.objects.map((o) => o.text?.tlm[5])).toEqual([-10, -20, -30]);
  });

  it('reports unclosed q and the CTM at the end', () => {
    const scan = scanObjects(parse(ascii('q q 2 0 0 2 0 0 cm Q 1 0 0 1 3 4 cm')).ops);
    expect(scan.openDepth).toBe(1);
    expect(scan.ctmAtEnd).toEqual([1, 0, 0, 1, 3, 4]);
  });
});

describe('matrix', () => {
  it('multiplies in row-vector order and inverts', () => {
    const m = matrix.multiply(matrix.translation(10, 0), matrix.scaling(2, 2));
    expect(matrix.apply(m, { x: 0, y: 0 })).toEqual({ x: 20, y: 0 });
    const inv = matrix.invert(m);
    expect(inv && matrix.isIdentity(matrix.multiply(m, inv))).toBe(true);
    expect(matrix.invert([0, 0, 0, 0, 1, 1])).toBeNull();
  });

  it('rotates and scales about a point', () => {
    const r = matrix.rotation(90, { x: 10, y: 10 });
    const p = matrix.apply(r, { x: 20, y: 10 });
    expect(p.x).toBeCloseTo(10);
    expect(p.y).toBeCloseTo(20);
    const s = matrix.scaling(2, 3, { x: 1, y: 1 });
    expect(matrix.apply(s, { x: 1, y: 1 })).toEqual({ x: 1, y: 1 });
    expect(matrix.applyToRect(s, { x0: 0, y0: 0, x1: 2, y1: 2 })).toEqual({
      x0: -1,
      y0: -2,
      x1: 3,
      y1: 4,
    });
  });

  it('decomposes scale, rotation and a flip', () => {
    const d = matrix.decompose(matrix.multiply(matrix.scaling(2, -3), matrix.rotation(30)));
    expect(d.scaleX).toBeCloseTo(2);
    expect(d.scaleY).toBeCloseTo(-3);
    expect(d.rotate).toBeCloseTo(30);
    expect(d.skewed).toBe(false);
    expect(matrix.decompose([1, 0, 1, 1, 0, 0]).skewed).toBe(true);
  });

  it('conjugates and falls back on a singular frame', () => {
    const c = matrix.conjugate(matrix.translation(10, 0), matrix.scaling(2, 2));
    expect(c).toEqual([1, 0, 0, 1, 5, 0]);
    expect(matrix.conjugate(matrix.translation(1, 1), [0, 0, 0, 0, 0, 0])).toEqual([
      1, 0, 0, 1, 1, 1,
    ]);
    expect(matrix.matrixEquals([1, 0, 0, 1, 0, 0], matrix.IDENTITY)).toBe(true);
  });
});

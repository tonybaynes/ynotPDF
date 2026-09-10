/**
 * Style edits (M50): a path's stroke and fill go inside the same `q … Q` a transform uses, and
 * nothing that is not a path accepts one.
 */

import { describe, expect, it } from 'vitest';
import { applyEdits, matrix, parse, serialise, styleOps } from '@engine/content';
import { ascii, text } from './helpers';

const PAGE = ascii(
  ['0 0 1 rg', '100 100 200 50 re f', 'q /Im1 Do Q', 'BT /F1 12 Tf (Hi) Tj ET'].join('\n'),
);

describe('applyEdits — style', () => {
  it('writes colours, width and dash inside the wrapper', () => {
    const stream = parse(PAGE);
    const { ops, refused } = applyEdits(stream, [
      {
        kind: 'style',
        index: 0,
        style: { fillColor: 0xff0000, strokeColor: 0x0000ff, strokeWidth: 2.5, dash: [3, 1] },
      },
    ]);
    expect(refused).toEqual([]);
    const out = text(serialise(stream, ops));
    expect(out).toContain('q\n1 0 0 rg\n0 0 1 RG\n2.5 w\n[3 1] 0 d\n100 100 200 50 re f\nQ');
    expect(out.startsWith('0 0 1 rg\nq')).toBe(true);
  });

  it('shares the wrapper with a transform and merges repeated styles', () => {
    const stream = parse(PAGE);
    const { ops } = applyEdits(stream, [
      { kind: 'style', index: 0, style: { fillColor: 0x00ff00 } },
      { kind: 'transform', index: 0, matrix: matrix.translation(5, 0) },
      { kind: 'style', index: 0, style: { strokeWidth: 1 } },
    ]);
    const out = text(serialise(stream, ops));
    expect(out).toContain('q\n1 0 0 1 5 0 cm\n0 1 0 rg\n1 w\n100 100 200 50 re f\nQ');
  });

  it('refuses a style on an XObject or a text object, and drops it with a removal', () => {
    const stream = parse(PAGE);
    const result = applyEdits(stream, [
      { kind: 'style', index: 1, style: { fillColor: 0 } },
      { kind: 'style', index: 2, style: { fillColor: 0 } },
    ]);
    expect(result.refused).toEqual([
      'style: object 1 is not a path',
      'style: object 2 is not a path',
    ]);
    const removed = applyEdits(stream, [
      { kind: 'style', index: 0, style: { fillColor: 0 } },
      { kind: 'remove', index: 0 },
    ]);
    const out = text(serialise(stream, removed.ops));
    expect(out).not.toContain('0 0 0 rg');
    expect(out).not.toContain('re f');
    expect(removed.applied).toBe(1);
  });

  it('is a no-op for an empty style', () => {
    const stream = parse(PAGE);
    const result = applyEdits(stream, [{ kind: 'style', index: 0, style: {} }]);
    expect(serialise(stream, result.ops)).toEqual(PAGE);
    expect(result.applied).toBe(1);
  });

  it('formats style ops on their own', () => {
    expect(styleOps({ dash: [] }).map((o) => o.operator)).toEqual(['d']);
    expect(styleOps({}).length).toBe(0);
  });
});

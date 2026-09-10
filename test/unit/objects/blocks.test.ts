/**
 * Text blocks (M50): the engine's per-operator text objects grouped by M13's paragraphs, with
 * a block for anything the runs did not reach.
 */

import { describe, expect, it } from 'vitest';
import type { PageObject, TextRun } from '@engine/PdfEngine';
import { blockOf, textBlocks } from '@modules/M50-object-model/blocks';

function run(text: string, x: number, y: number, objectIndex: number, size = 12): TextRun {
  const width = text.length * size * 0.5;
  const rect = { x0: x, y0: y - size * 0.2, x1: x + width, y1: y + size * 0.8 };
  const chars = Array.from(text).map((_c, i) => ({
    x0: x + i * size * 0.5,
    y0: rect.y0,
    x1: x + (i + 1) * size * 0.5,
    y1: rect.y1,
  }));
  return {
    text,
    rect,
    chars,
    origin: { x, y },
    matrix: [size, 0, 0, size, x, y],
    fontName: 'Helvetica',
    fontSize: size,
    color: 0,
    objectIndex,
  };
}

function object(index: number, kind: PageObject['kind'], rect: PageObject['rect']): PageObject {
  return { index, kind, rect, matrix: [1, 0, 0, 1, 0, 0] };
}

describe('textBlocks', () => {
  it('groups the lines of a paragraph and separates a gap', () => {
    const runs = [
      run('The quick brown fox', 72, 700, 0),
      run('jumps over the dog', 72, 686, 1),
      run('A new paragraph here', 72, 600, 2),
    ];
    const objects = runs.map((r, i) => object(i, 'text', r.rect));
    objects.push(object(3, 'path', { x0: 0, y0: 0, x1: 10, y1: 10 }));
    const blocks = textBlocks(0, runs, objects);
    expect(blocks.map((b) => b.members)).toEqual([[0, 1], [2]]);
    expect(blocks[0]?.id).toBe('t0');
    expect(blocks[0]?.text).toContain('quick brown fox');
    expect(blocks[0]?.rect.y0).toBeCloseTo(686 - 2.4, 6);
    expect(blocks[0]?.rect.y1).toBeCloseTo(700 + 9.6, 6);
    expect(blockOf(blocks, 1)?.id).toBe('t0');
    expect(blockOf(blocks, 3)).toBeNull();
  });

  it('gives a text object no run reached a block of its own', () => {
    const runs = [run('Only this', 72, 700, 0)];
    const objects = [
      object(0, 'text', runs[0]?.rect ?? { x0: 0, y0: 0, x1: 1, y1: 1 }),
      object(1, 'text', { x0: 300, y0: 300, x1: 320, y1: 312 }),
    ];
    const blocks = textBlocks(0, runs, objects);
    expect(blocks.map((b) => b.id)).toEqual(['t0', 't1']);
    expect(blocks[1]?.members).toEqual([1]);
  });

  it('ignores runs that point at objects that are not text', () => {
    const runs = [run('stray', 10, 10, 5)];
    const objects = [object(0, 'path', { x0: 0, y0: 0, x1: 1, y1: 1 })];
    expect(textBlocks(0, runs, objects)).toEqual([]);
  });

  it('is empty with no text', () => {
    expect(textBlocks(0, [], [object(0, 'image', { x0: 0, y0: 0, x1: 1, y1: 1 })])).toEqual([]);
  });
});

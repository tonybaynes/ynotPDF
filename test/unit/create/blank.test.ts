/**
 * A blank document (M91): page size, orientation and count, checked with the real engine.
 */

import { describe, expect, it } from 'vitest';
import {
  BlankConverter,
  DEFAULT_BLANK_OPTIONS,
  MAX_BLANK_PAGES,
} from '@engine/create/blank/BlankConverter';
import { ConvertCancelled } from '@engine/create/types';
import { mmToPt } from '@shared/pdf';
import { engine } from '../engine/helpers';

const converter = new BlankConverter();
const ctx = { env: {} };

async function sizes(
  bytes: Uint8Array,
  pages: number[],
): Promise<{ width: number; height: number }[]> {
  const pdf = await engine();
  const doc = await pdf.open(bytes);
  try {
    const out: { width: number; height: number }[] = [];
    for (const i of pages) {
      const s = await pdf.pageSize(doc, i);
      out.push({ width: s.width, height: s.height });
    }
    return out;
  } finally {
    await pdf.close(doc);
  }
}

describe('BlankConverter', () => {
  it('takes no file', () => {
    expect(converter.accepts()).toBe(false);
    expect(converter.extensions).toEqual([]);
    expect(converter.mimes).toEqual([]);
    expect(converter.id).toBe('blank');
    expect(converter.defaults()).toEqual(DEFAULT_BLANK_OPTIONS);
    expect(converter.defaults()).not.toBe(DEFAULT_BLANK_OPTIONS);
  });

  it('makes one A4 portrait page by default', async () => {
    const result = await converter.convert([], converter.defaults(), ctx);
    expect(result).toMatchObject({ pageCount: 1, title: 'Untitled', warnings: [] });
    const [size] = await sizes(result.bytes, [0]);
    expect(size?.width).toBeCloseTo(mmToPt(210), 1);
    expect(size?.height).toBeCloseTo(mmToPt(297), 1);
    const pdf = await engine();
    const doc = await pdf.open(result.bytes);
    try {
      expect(await pdf.pageCount(doc)).toBe(1);
      expect((await pdf.metadata(doc)).title).toBe('Untitled');
    } finally {
      await pdf.close(doc);
    }
  });

  it('makes three Letter landscape pages', async () => {
    const result = await converter.convert(
      [],
      { pageSize: { kind: 'preset', id: 'Letter' }, orientation: 'landscape', count: 3 },
      ctx,
    );
    expect(result.pageCount).toBe(3);
    const all = await sizes(result.bytes, [0, 1, 2]);
    expect(all).toHaveLength(3);
    for (const s of all) {
      expect(s.width).toBeCloseTo(792, 1);
      expect(s.height).toBeCloseTo(612, 1);
    }
  });

  it('clamps the count to 1..MAX_BLANK_PAGES', async () => {
    const small = { kind: 'custom', widthMm: 10, heightMm: 10 } as const;
    const zero = await converter.convert(
      [],
      { ...converter.defaults(), pageSize: small, count: 0 },
      ctx,
    );
    expect(zero.pageCount).toBe(1);
    const negative = await converter.convert(
      [],
      { ...converter.defaults(), pageSize: small, count: -4 },
      ctx,
    );
    expect(negative.pageCount).toBe(1);
    const nan = await converter.convert(
      [],
      { ...converter.defaults(), pageSize: small, count: Number.NaN },
      ctx,
    );
    expect(nan.pageCount).toBe(1);
    const fraction = await converter.convert(
      [],
      { ...converter.defaults(), pageSize: small, count: 2.9 },
      ctx,
    );
    expect(fraction.pageCount).toBe(2);
    const huge = await converter.convert(
      [],
      { ...converter.defaults(), pageSize: small, count: 5000 },
      ctx,
    );
    expect(huge.pageCount).toBe(MAX_BLANK_PAGES);
    const pdf = await engine();
    const doc = await pdf.open(huge.bytes);
    try {
      expect(await pdf.pageCount(doc)).toBe(MAX_BLANK_PAGES);
    } finally {
      await pdf.close(doc);
    }
  });

  it('normalises a custom size to portrait and swaps it for landscape', async () => {
    const custom = { kind: 'custom', widthMm: 100, heightMm: 50 } as const;
    const portrait = await converter.convert(
      [],
      { pageSize: custom, orientation: 'portrait', count: 1 },
      ctx,
    );
    const [p] = await sizes(portrait.bytes, [0]);
    expect(p?.width).toBeCloseTo(mmToPt(50), 1);
    expect(p?.height).toBeCloseTo(mmToPt(100), 1);
    const landscape = await converter.convert(
      [],
      { pageSize: custom, orientation: 'landscape', count: 1 },
      ctx,
    );
    const [l] = await sizes(landscape.bytes, [0]);
    expect(l?.width).toBeCloseTo(mmToPt(100), 1);
    expect(l?.height).toBeCloseTo(mmToPt(50), 1);
  });

  it('writes the title and reports progress', async () => {
    const progress: [number | null, string][] = [];
    const result = await converter.convert(
      [],
      { ...converter.defaults(), count: 250, title: 'Notes' },
      { env: {}, progress: (f, m) => progress.push([f, m]) },
    );
    expect(result.title).toBe('Notes');
    expect(progress.map(([, m]) => m)).toEqual([
      'Adding page 1 of 250',
      'Adding page 101 of 250',
      'Adding page 201 of 250',
    ]);
    expect(progress[1]?.[0]).toBeCloseTo(0.4, 5);
    const pdf = await engine();
    const doc = await pdf.open(result.bytes);
    try {
      expect((await pdf.metadata(doc)).title).toBe('Notes');
    } finally {
      await pdf.close(doc);
    }
  });

  it('stops when cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      converter.convert([], converter.defaults(), { env: {}, signal: controller.signal }),
    ).rejects.toBeInstanceOf(ConvertCancelled);
  });
});

/**
 * Split (M41). Two acceptance lines live here — "split back by bookmark ⇒ per-file page counts
 * match the originals", and "split by size 1 MB produces files each ≤ 1 MB (except single pages
 * larger)" — plus the naming, which is the part a reader sees first and the part most likely to
 * produce a file name their operating system refuses.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { combine } from '@engine/ops/combine';
import {
  fillNamePattern,
  formatBytes,
  formatPageRange,
  planGroups,
  safeFileName,
  split,
} from '@engine/ops/split';
import { readOutline } from '@engine/ops/pdfdoc';
import { OpCancelled, OpFailed, type OpSource } from '@engine/ops/types';

const FIXTURES = join(process.cwd(), 'test', 'fixtures');

function fixture(name: string): OpSource {
  return { name, bytes: new Uint8Array(readFileSync(join(FIXTURES, name))) };
}

/** One part's bytes, with a failure that names what was missing rather than a type error. */
function partBytes(
  parts: ReadonlyArray<{ readonly bytes: Uint8Array }>,
  index: number,
): Uint8Array {
  const part = parts[index];
  if (!part) throw new Error(`the split produced no part ${String(index + 1)}`);
  return part.bytes;
}

async function pageCountOf(bytes: Uint8Array): Promise<number> {
  return (await PDFDocument.load(bytes, { ignoreEncryption: true })).getPageCount();
}

describe('formatPageRange', () => {
  it('runs consecutive pages together, 1-based', () => {
    expect(formatPageRange([0, 1, 2, 4])).toBe('1-3, 5');
    expect(formatPageRange([3])).toBe('4');
    expect(formatPageRange([])).toBe('');
  });

  it('sorts and de-duplicates first', () => {
    expect(formatPageRange([4, 0, 1, 1, 2])).toBe('1-3, 5');
  });
});

describe('safeFileName', () => {
  it('replaces the characters no operating system will take', () => {
    expect(safeFileName('a/b\\c:d*e?f"g<h>i|j')).toBe('a-b-c-d-e-f-g-h-i-j');
  });

  it('drops a trailing dot or space, which Windows silently eats', () => {
    expect(safeFileName('Report. ')).toBe('Report');
  });

  it('never answers with nothing', () => {
    expect(safeFileName('   ')).toBe('part');
    expect(safeFileName('...')).toBe('part');
  });
});

describe('fillNamePattern', () => {
  const base = { name: 'Report', index: 2, total: 12, pages: [10, 11, 12] };

  it('fills the tokens the dialog documents', () => {
    expect(fillNamePattern('{name}_{index}_{range}', base)).toBe('Report_03_11-13.pdf');
    expect(fillNamePattern('{name} {start}-{end} ({count})', base)).toBe('Report 11-13 (3).pdf');
  });

  it('pads the index to the width of the largest part number', () => {
    expect(fillNamePattern('{index}', { ...base, total: 9 })).toBe('3.pdf');
    expect(fillNamePattern('{index}', { ...base, total: 100 })).toBe('003.pdf');
  });

  it('leaves an unknown token alone, so a typo is visible rather than silent', () => {
    expect(fillNamePattern('{name}-{nope}', base)).toBe('Report-{nope}.pdf');
  });

  it('uses the bookmark title when there is one', () => {
    expect(fillNamePattern('{name} - {title}', { ...base, title: 'Chapter 2: results' })).toBe(
      'Report - Chapter 2- results.pdf',
    );
  });
});

describe('planGroups', () => {
  it('cuts every N pages, last group short', () => {
    expect(planGroups({ kind: 'count', pages: 2 }, 5).map((g) => g.pages)).toEqual([
      [0, 1],
      [2, 3],
      [4],
    ]);
  });

  it('treats a count of zero as one, rather than looping forever', () => {
    expect(planGroups({ kind: 'count', pages: 0 }, 3)).toHaveLength(3);
  });

  it('cuts at top-level bookmarks and keeps the pages before the first one', () => {
    const groups = planGroups({ kind: 'bookmarks' }, 6, [
      { title: 'One', page: 2 },
      { title: 'Two', page: 4 },
    ]);
    expect(groups.map((g) => g.pages)).toEqual([
      [0, 1],
      [2, 3],
      [4, 5],
    ]);
    expect(groups.map((g) => g.title)).toEqual([undefined, 'One', 'Two']);
  });

  it('leaves a document with no bookmarks whole', () => {
    expect(planGroups({ kind: 'bookmarks' }, 3, [])).toEqual([{ pages: [0, 1, 2] }]);
  });

  it('cleans up explicit ranges and drops the empty ones', () => {
    expect(
      planGroups({ kind: 'ranges', groups: [[2, 0, 0], [9], [1]] }, 3).map((g) => g.pages),
    ).toEqual([[0, 2], [1]]);
  });
});

describe('split', () => {
  it('by page count: every part has the pages it should', async () => {
    const result = await split(fixture('multipage.pdf').bytes, {
      rule: { kind: 'count', pages: 2 },
      baseName: 'multipage',
    });
    expect(result.parts.map((p) => p.name)).toEqual([
      'multipage_1_1-2.pdf',
      'multipage_2_3-4.pdf',
      'multipage_3_5.pdf',
    ]);
    for (const part of result.parts) {
      expect(await pageCountOf(part.bytes)).toBe(part.pages.length);
    }
  });

  it('round-trips the corpus: combine by file, split back by bookmark, same page counts', async () => {
    const names = ['blank.pdf', 'multipage.pdf', 'text.pdf', 'outline.pdf', 'rotated.pdf'];
    const sources = names.map(fixture);
    const originals = await Promise.all(sources.map(async (s) => await pageCountOf(s.bytes)));
    const combined = await combine(sources, { bookmarkPerFile: true, keepBookmarks: false });
    const result = await split(combined.bytes, {
      rule: { kind: 'bookmarks' },
      baseName: 'corpus',
    });
    expect(result.parts.map((p) => p.pages.length)).toEqual(originals);
    expect(result.parts.map((p) => p.title)).toEqual([
      'blank',
      'multipage',
      'text',
      'outline',
      'rotated',
    ]);
    for (const [i, part] of result.parts.entries()) {
      expect(await pageCountOf(part.bytes)).toBe(originals[i]);
    }
  });

  it('says so when there are no bookmarks to split at, and leaves the file whole', async () => {
    const result = await split(fixture('multipage.pdf').bytes, { rule: { kind: 'bookmarks' } });
    expect(result.parts).toHaveLength(1);
    expect(result.warnings.join(' ')).toContain('no top-level bookmarks');
  });

  it('by size: every part is inside the budget, or is a single page that cannot be', async () => {
    const budget = 40_000;
    const source = fixture('skewed.pdf');
    const result = await split(source.bytes, {
      rule: { kind: 'size', bytes: budget },
      baseName: 'skewed',
    });
    expect(result.parts.length).toBeGreaterThan(0);
    for (const part of result.parts) {
      if (part.bytes.byteLength > budget) expect(part.pages).toHaveLength(1);
    }
    // Nothing is lost: the parts together are the document.
    expect(result.parts.flatMap((p) => [...p.pages]).sort((a, b) => a - b)).toEqual([0, 1, 2, 3]);
  });

  it('by size: a budget nothing fits still produces one file per page and says why', async () => {
    const result = await split(fixture('skewed.pdf').bytes, {
      rule: { kind: 'size', bytes: 1000 },
      baseName: 'skewed',
    });
    expect(result.parts).toHaveLength(4);
    expect(result.warnings.join(' ')).toMatch(/on its own, which is over the limit/);
  });

  it('by size: refuses a budget of nothing', async () => {
    await expect(
      split(fixture('blank.pdf').bytes, { rule: { kind: 'size', bytes: 0 } }),
    ).rejects.toBeInstanceOf(OpFailed);
  });

  it('keeps each part its own bookmarks, re-pointed at its own pages', async () => {
    const result = await split(fixture('outline.pdf').bytes, {
      rule: { kind: 'count', pages: 1 },
      baseName: 'outline',
    });
    for (const part of result.parts) {
      const outline = readOutline(await PDFDocument.load(part.bytes));
      for (const item of outline) {
        if (item.page !== null) expect(item.page).toBe(0);
      }
    }
  });

  it('drops bookmarks when told to', async () => {
    const result = await split(fixture('outline.pdf').bytes, {
      rule: { kind: 'count', pages: 3 },
      keepBookmarks: false,
    });
    const outline = readOutline(await PDFDocument.load(partBytes(result.parts, 0)));
    expect(outline).toEqual([]);
  });

  it('drops comments when told to, and keeps the form', async () => {
    const kept = await split(fixture('annotated.pdf').bytes, { rule: { kind: 'count', pages: 1 } });
    const dropped = await split(fixture('annotated.pdf').bytes, {
      rule: { kind: 'count', pages: 1 },
      keepComments: false,
    });
    const annotationsOf = async (bytes: Uint8Array): Promise<number> => {
      const doc = await PDFDocument.load(bytes);
      return doc.getPage(0).node.Annots()?.size() ?? 0;
    };
    expect(await annotationsOf(partBytes(kept.parts, 0))).toBeGreaterThan(0);
    expect(await annotationsOf(partBytes(dropped.parts, 0))).toBe(0);
  });

  it('drops the form when told to', async () => {
    const result = await split(fixture('form.pdf').bytes, {
      rule: { kind: 'count', pages: 1 },
      keepForms: false,
    });
    const doc = await PDFDocument.load(partBytes(result.parts, 0));
    expect(doc.getForm().getFields()).toHaveLength(0);
  });

  it('refuses a document with no pages', async () => {
    await expect(
      split(fixture('corrupt.pdf').bytes, { rule: { kind: 'count', pages: 1 } }),
    ).rejects.toBeInstanceOf(OpFailed);
  });

  it('stops when the signal says so', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      split(
        fixture('multipage.pdf').bytes,
        { rule: { kind: 'count', pages: 1 } },
        { signal: controller.signal },
      ),
    ).rejects.toBeInstanceOf(OpCancelled);
  });
});

describe('formatBytes', () => {
  it('says it the way a reader would', () => {
    expect(formatBytes(512)).toBe('512 bytes');
    expect(formatBytes(2048)).toBe('2 kB');
    expect(formatBytes(1024 * 1024 * 3.5)).toBe('3.5 MB');
  });
});

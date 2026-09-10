/**
 * M100's acceptance tests for the pipeline itself, plus the properties every preset has to keep.
 *
 * These are the two the brief names — a bloated file shrinks by at least half with Standard, and
 * a broken cross-reference table repairs and opens — and the two the design promises: a lossless
 * preset changes no rendered pixel at all, and no preset ever changes the page count or the text.
 */

import { describe, expect, it } from 'vitest';
import {
  AUDIT_ORDER,
  auditBytes,
  isLossless,
  optimise,
  presetById,
  repairBytes,
  type OptimisePreset,
} from '@engine/optimise';
import {
  factsOf,
  fixture,
  hamming,
  pageHashes,
  repairTools,
  structureHook,
  tasks,
} from './helpers';

/** A built-in preset by id. Throws rather than returning null, so no test needs an assertion. */
function preset(id: string): OptimisePreset {
  const found = presetById(id);
  if (!found) throw new Error(`no such preset: ${id}`);
  return found;
}

const standard = preset('standard');
const lossless = preset('lossless');
const smallest = preset('smallest');

describe('optimise — the acceptance tests', () => {
  it('shrinks the bloated fixture by at least half with the Standard preset', async () => {
    const bytes = fixture('bloated.pdf');
    const before = await factsOf(bytes);

    const result = await optimise(bytes, standard.options, { structure: structureHook() });

    expect(result.after).toBeLessThanOrEqual(result.before / 2);
    // The document is still the same document.
    const after = await factsOf(result.bytes);
    expect(after.pages).toBe(before.pages);
    expect(after.sizes).toEqual(before.sizes);
    expect(after.text).toEqual(before.text);
  });

  it('leaves the bloated fixture clean by qpdf’s own reckoning', async () => {
    const result = await optimise(fixture('bloated.pdf'), standard.options, {
      structure: structureHook(),
    });
    const check = await tasks().check(result.bytes);
    expect(check.errors).toEqual([]);
    expect(check.warnings).toEqual([]);
    expect(check.ok).toBe(true);
  });

  it('linearises when asked, and qpdf agrees that it did', async () => {
    const options = {
      ...standard.options,
      structure: { ...standard.options.structure, linearise: true },
    };
    const result = await optimise(fixture('bloated.pdf'), options, { structure: structureHook() });
    expect(result.linearised).toBe(true);
    const check = await tasks().check(result.bytes);
    expect(check.linearised).toBe(true);
    expect(check.errors).toEqual([]);
  });

  it('renders the bloated fixture identically after a lossless optimise', async () => {
    expect(isLossless(lossless.options)).toBe(true);
    const bytes = fixture('bloated.pdf');
    const before = await pageHashes(bytes);
    const result = await optimise(bytes, lossless.options, { structure: structureHook() });
    const after = await pageHashes(result.bytes);
    // Exactly zero: a lossless preset touches no image sample and no font program, so there is
    // nothing for a tolerance to absorb.
    expect(after).toEqual(before);
    expect(result.after).toBeLessThan(result.before);
  });

  it('renders within tolerance after the lossy presets', async () => {
    const bytes = fixture('bloated.pdf');
    const before = await pageHashes(bytes);
    for (const preset of [standard, smallest]) {
      const result = await optimise(bytes, preset.options, { structure: structureHook() });
      const after = await pageHashes(result.bytes);
      expect(after).toHaveLength(before.length);
      after.forEach((hash, i) => {
        // 8 of 64 bits: a downsampled and re-encoded photograph moves a few, a wrong page moves
        // most of them.
        expect(hamming(hash, before[i] ?? '')).toBeLessThanOrEqual(8);
      });
    }
  });

  it('keeps the page count and the text of every fixture it can read', async () => {
    for (const name of ['text.pdf', 'multipage.pdf', 'image.pdf', 'outline.pdf', 'fonts.pdf']) {
      const bytes = fixture(name);
      const before = await factsOf(bytes);
      const result = await optimise(bytes, standard.options, { structure: structureHook() });
      const after = await factsOf(result.bytes);
      expect({ name, ...after }).toEqual({ name, ...before });
    }
  });

  it('reports what it did, and never claims more than the file actually lost', async () => {
    const result = await optimise(fixture('bloated.pdf'), standard.options, {
      structure: structureHook(),
    });
    expect(result.changes.length).toBeGreaterThan(0);
    expect(result.changes.map((c) => c.what).join(' ')).toMatch(/duplicate|image/i);
    const claimed = result.changes.reduce((n, c) => n + c.saved, 0);
    expect(claimed).toBeLessThanOrEqual(result.before - result.after);
  });

  it('does nothing at all when nothing is asked for', async () => {
    const nothing = {
      ...lossless.options,
      structure: {
        objectStreams: false,
        recompressStreams: false,
        removeUnused: false,
        linearise: false,
      },
      dedupe: { images: false, fonts: false, xobjects: false },
    };
    const bytes = fixture('text.pdf');
    const result = await optimise(bytes, nothing, { structure: structureHook() });
    expect(result.changes).toEqual([]);
    expect(await factsOf(result.bytes)).toEqual(await factsOf(bytes));
  });

  it('merges the bloated fixture’s three identical pictures into one', async () => {
    const result = await optimise(fixture('bloated.pdf'), lossless.options, {
      structure: structureHook(),
    });
    const merged = result.changes.find((c) => /duplicate/i.test(c.what));
    expect(merged?.count).toBeGreaterThanOrEqual(2);
  });
});

describe('repair', () => {
  it('repairs the broken-xref fixture, and the repaired copy opens and is clean', async () => {
    const result = await repairBytes(fixture('broken-xref.pdf'), await repairTools());
    expect(result.repaired).toBe(true);

    const facts = await factsOf(result.bytes);
    expect(facts.pages).toBe(1);
    const check = await tasks().check(result.bytes);
    expect(check.ok).toBe(true);
  });

  it('says a file neither engine can read is beyond repair', async () => {
    const tools = await repairTools();
    await expect(repairBytes(fixture('corrupt.pdf'), tools)).rejects.toThrow(/too badly damaged/i);
    await expect(repairBytes(fixture('truncated.pdf'), tools)).rejects.toThrow(
      /too badly damaged/i,
    );
  });

  it('reads a healthy file as healthy and a damaged one as damaged', async () => {
    const healthy = await tasks().check(fixture('text.pdf'));
    expect(healthy.ok).toBe(true);
    expect(healthy.version).toBe('1.7');
    expect(healthy.linearised).toBe(false);
    expect(healthy.encrypted).toBe(false);

    const broken = await tasks().check(fixture('broken-xref.pdf'));
    expect(broken.ok).toBe(false);
    expect(broken.errors.length).toBeGreaterThan(0);
    expect(broken.unreadable).toBe(true);
  });

  it('does not pronounce a protected file healthy when it could not read it', async () => {
    // qpdf needs the password before it can check anything, so an encrypted file comes back
    // unreadable rather than clean — which is the answer a caller has to be able to tell apart
    // from "nothing wrong with it".
    const check = await tasks().check(fixture('encrypted.pdf'));
    expect(check.ok).toBe(false);
    expect(check.unreadable).toBe(true);
  });
});

describe('space audit', () => {
  it('divides the whole file up and nothing else', async () => {
    const bytes = fixture('bloated.pdf');
    const audit = await auditBytes(bytes);
    expect(audit.total).toBe(bytes.length);
    const sum = audit.slices.reduce((n, s) => n + s.bytes, 0);
    // Rounding to whole bytes per slice can cost a byte or two of the total.
    expect(Math.abs(sum - audit.total)).toBeLessThanOrEqual(audit.slices.length);
    expect(audit.slices.map((s) => s.category)).toEqual([...AUDIT_ORDER]);
  });

  it('puts most of the bloated fixture down to its images', async () => {
    const audit = await auditBytes(fixture('bloated.pdf'));
    const images = audit.slices.find((s) => s.category === 'images');
    expect(images?.share).toBeGreaterThan(0.5);
    expect(images?.objects).toBeGreaterThanOrEqual(3);
  });

  it('finds no images in a text-only document', async () => {
    const audit = await auditBytes(fixture('text.pdf'));
    expect(audit.slices.find((s) => s.category === 'images')?.bytes).toBe(0);
  });

  it('finds the bookmarks in an outlined document and the comments in a commented one', async () => {
    const outline = await auditBytes(fixture('outline.pdf'));
    expect(outline.slices.find((s) => s.category === 'bookmarks')?.bytes).toBeGreaterThan(0);
    const comments = await auditBytes(fixture('comments.pdf'));
    expect(comments.slices.find((s) => s.category === 'comments')?.bytes).toBeGreaterThan(0);
  });
});

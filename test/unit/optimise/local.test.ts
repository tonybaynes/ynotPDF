/**
 * M100 against the operator's own files (`test/fixtures/local/`, git-ignored).
 *
 * The corpus is synthetic and was written by us, which means it exercises exactly the shapes we
 * thought of. These four were written by an airline's booking system and by Foxit, and they are
 * the ones that will find the case nobody designed for. Every test here is skipped where the
 * files are not present — CI and a fresh clone have neither.
 *
 * Nothing here reads or asserts on the *contents* of those files. What is checked is the property
 * every one of them has to keep: the same pages, the same text, still readable afterwards.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { auditBytes, optimise, presetById, type OptimisePreset } from '@engine/optimise';
import { factsOf, structureHook, tasks } from './helpers';

const LOCAL = join(process.cwd(), 'test', 'fixtures', 'local');

const FILES = [
  '220909 Cemair AMB 4D.pdf',
  '241109 B-Pass AMB.pdf',
  'boarding_pass.pdf',
  'Sample Portfolio.pdf',
];

const present = FILES.filter((name) => existsSync(join(LOCAL, name)));

function preset(id: string): OptimisePreset {
  const found = presetById(id);
  if (!found) throw new Error(`no such preset: ${id}`);
  return found;
}

describe.skipIf(present.length === 0)('the operator’s own files', () => {
  for (const name of present) {
    it(`optimises ${name} without changing what it says`, async () => {
      const bytes = new Uint8Array(readFileSync(join(LOCAL, name)));
      const before = await factsOf(bytes);

      const result = await optimise(bytes, preset('standard').options, {
        structure: structureHook(),
      });

      const after = await factsOf(result.bytes);
      expect(after.pages).toBe(before.pages);
      expect(after.sizes).toEqual(before.sizes);
      expect(after.text).toEqual(before.text);
      // Never bigger than it started, whatever it turned out to contain.
      expect(result.after).toBeLessThanOrEqual(result.before);

      const check = await tasks().check(result.bytes);
      expect(check.errors).toEqual([]);
    }, 120_000);

    it(`audits ${name} down to its own length`, async () => {
      const bytes = new Uint8Array(readFileSync(join(LOCAL, name)));
      const audit = await auditBytes(bytes);
      expect(audit.total).toBe(statSync(join(LOCAL, name)).size);
      const sum = audit.slices.reduce((n, s) => n + s.bytes, 0);
      expect(Math.abs(sum - audit.total)).toBeLessThanOrEqual(audit.slices.length);
    }, 60_000);
  }

  it('leaves a portfolio’s attached files alone unless it is told to drop them', async () => {
    const name = 'Sample Portfolio.pdf';
    if (!present.includes(name)) return;
    const bytes = new Uint8Array(readFileSync(join(LOCAL, name)));
    const result = await optimise(bytes, preset('standard').options, {
      structure: structureHook(),
    });
    // Standard does not discard attachments, so a portfolio survives it whole. "Smallest" does,
    // and says so — that is the preset that is allowed to gut a portfolio.
    expect(result.warnings.join(' ')).not.toMatch(/portfolio/i);
    expect(preset('standard').options.discard.embeddedFiles).toBe(false);
    expect(preset('smallest').options.discard.embeddedFiles).toBe(true);
  }, 120_000);
});

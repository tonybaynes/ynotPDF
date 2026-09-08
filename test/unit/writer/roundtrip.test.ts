/**
 * M21 acceptance: a no-op save of every fixture round-trips.
 *
 * The document goes through the whole real pipeline — PDFium opens it, PDFium serialises it, the
 * writer re-writes it with an empty plan — and then both files are opened in the engine again
 * and compared field by field by `test/unit/roundtrip.ts`. Zero differences is the bar.
 *
 * Encrypted fixtures are checked for the opposite: the writer refuses them, because rewriting an
 * encrypted file with pdf-lib would emit plaintext under a trailer that still claims encryption.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Document } from '@core/Document';
import { planIsEmpty, WriteUnsupported } from '@engine/Writer';
import { FullRewriteWriter } from '@engine/writers/FullRewriteWriter';
import { buildWritePlan } from '@modules/M21-save/plan';
import { engine, FIXTURES } from '../engine/helpers';
import { compareDocuments, summarise } from '../roundtrip';

interface FixtureManifest {
  readonly fixtures: Record<string, { readonly error?: string; readonly password?: string }>;
}

const manifest = JSON.parse(
  readFileSync(join(FIXTURES, 'manifest.json'), 'utf8'),
) as FixtureManifest;

/** Every synthetic fixture that opens at all: broken ones are M10's business, not the writer's. */
const CASES = Object.entries(manifest.fixtures)
  .filter(([name, spec]) => !name.includes('/') && !spec.error)
  .map(([name, spec]) => [name, spec.password] as const);

function fixtureBytes(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(FIXTURES, name)));
}

describe('no-op save', () => {
  it('has fixtures to check', () => {
    expect(CASES.length).toBeGreaterThan(10);
  });

  for (const [name, password] of CASES) {
    it(`${name} round-trips, or is refused when it is protected`, async () => {
      const eng = await engine();
      const original = fixtureBytes(name);
      const open = password === undefined ? {} : { password };
      // The whole pipeline, exactly as `file.save` runs it: model, plan, engine bytes, writer.
      const doc = await Document.open(eng, original.slice(), open);
      const encrypted = doc.state.security.encrypted;
      const { plan, warnings } = buildWritePlan(doc);
      expect(warnings).toEqual([]);
      expect(planIsEmpty(plan)).toBe(true);
      const base = await eng.save(doc.handle);
      await doc.close();

      const writer = new FullRewriteWriter();

      // A protected file must be refused, not quietly rewritten into an unprotected one.
      if (encrypted) {
        await expect(writer.write({ bytes: base, plan })).rejects.toThrow(WriteUnsupported);
        return;
      }

      const result = await writer.write({ bytes: base, plan });
      expect(result.warnings).toEqual([]);

      const differences = await compareDocuments(eng, original.slice(), result.bytes.slice(), {
        ...(password === undefined ? {} : { passwordA: password }),
      });
      expect(summarise(differences), `${name}: ${summarise(differences)}`).toBe('no differences');
    });
  }
});

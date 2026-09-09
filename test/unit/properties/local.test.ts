/**
 * The operator's own files (M72). Skipped everywhere but his machine: `test/fixtures/local/` is
 * git-ignored, and nothing here quotes or copies what it reads.
 *
 * What it is for is the judgement a synthetic fixture cannot give — a real boarding pass and a
 * real Foxit-made portfolio have fonts, metadata and viewer preferences that nobody here chose.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Document } from '@core/Document';
import { FullRewriteWriter } from '@engine/writers/FullRewriteWriter';
import { readXmp } from '@engine/xmp';
import { buildWritePlan } from '@modules/M21-save/plan';
import { SetPropertiesCommand } from '@modules/M72-properties-metadata/commands';
import { engine, FIXTURES } from '../engine/helpers';
import { compareDocuments, summarise } from '../roundtrip';

const LOCAL = join(FIXTURES, 'local');
const files = ['Sample Portfolio.pdf', '220909 Cemair AMB 4D.pdf'];

describe('the operator’s own files', () => {
  for (const name of files) {
    const path = join(LOCAL, name);
    it.skipIf(!existsSync(path))(`${name}: fonts, view and metadata read`, async () => {
      const eng = await engine();
      const handle = await eng.open(new Uint8Array(readFileSync(path)));
      try {
        const fonts = await eng.fonts(handle);
        const view = await eng.initialView(handle);
        const meta = await eng.metadata(handle);
        // Nothing about the *content* is asserted — only that the reads answer sensibly.
        expect(Array.isArray(fonts)).toBe(true);
        for (const font of fonts) {
          expect(font.name).not.toBe('');
          expect(font.type).not.toBe('Unknown');
          expect(typeof font.embedded).toBe('boolean');
          // A subset prefix and a name are consistent by construction.
          expect(font.subset).toBe(/^[A-Z]{6}\+/.test(font.name));
        }
        expect(['none', 'outlines', 'thumbnails', 'fullscreen', 'attachments', 'ocg']).toContain(
          view.pageMode,
        );
        expect(typeof meta.version).toBe('string');
      } finally {
        await eng.close(handle);
      }
    });

    it.skipIf(!existsSync(path))(`${name}: a title change round-trips`, async () => {
      const eng = await engine();
      const original = new Uint8Array(readFileSync(path));
      const doc = await Document.open(eng, original.slice());
      await doc.apply(new SetPropertiesCommand(doc, { title: 'Retitled by ynotPDF' }));
      const { plan, warnings } = buildWritePlan(doc);
      expect(warnings).toEqual([]);
      const base = await doc.engine.save(doc.handle);
      const written = await new FullRewriteWriter().write({ bytes: base, plan });
      await doc.close();

      const handle = await eng.open(written.bytes);
      try {
        const meta = await eng.metadata(handle);
        expect(meta.title).toBe('Retitled by ynotPDF');
        expect(readXmp(meta.xmp).title).toBe('Retitled by ynotPDF');
      } finally {
        await eng.close(handle);
      }

      /*
       * And nothing else moved. Four kinds of field are ignored, and only four:
       *
       * - `title` and `xmp` are what the edit changed;
       * - `created` and `modified` are the same instants re-serialised: the writer normalises a
       *   PDF date to UTC, so `+01:00` comes back as the same moment written as `Z`;
       * - `version` is M21's, not this module's: a full rewrite with object streams is PDF 1.7,
       *   and an *empty* plan over this same file reports the same 1.4 → 1.7 on its own.
       */
      const differences = await compareDocuments(eng, original, written.bytes, {
        ignore: [
          'metadata.title',
          'metadata.xmp',
          'metadata.created',
          'metadata.modified',
          'metadata.version',
        ],
      });
      expect(differences, summarise(differences)).toEqual([]);
    });
  }
});

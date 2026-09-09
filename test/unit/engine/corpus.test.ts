/**
 * Engine corpus test (M10 acceptance): every fixture in `test/fixtures/manifest.json` opens (or
 * fails with the documented code), reports the expected structure, and renders to the same
 * perceptual hash as recorded in `test/fixtures/hashes/<platform>.json` (Hamming tolerance
 * `HASH_TOLERANCE` bits). Page-0 text is snapshotted in the same file.
 *
 * `YNOT_UPDATE_HASHES=1` (`npm run hashes`) rewrites the platform file from the current output.
 * External fixtures that have not been fetched are skipped, never failed.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  EngineError,
  type AnnotationFlags,
  type AnnotationSubtype,
  type FormFieldType,
} from '@engine/PdfEngine';
import { FIXTURES, dhash, engine, hamming } from './helpers';

interface Expectation {
  readonly pages?: number;
  readonly size?: readonly [number, number];
  readonly pageSizes?: Readonly<Record<string, readonly [number, number, number]>>;
  readonly text?: string;
  readonly exactText?: string;
  readonly textAlso?: string;
  readonly annotations?: number;
  readonly subtypes?: ReadonlyArray<AnnotationSubtype>;
  readonly fields?: number;
  readonly fieldTypes?: ReadonlyArray<FormFieldType>;
  readonly hasForm?: boolean;
  readonly hasXfa?: boolean;
  readonly encrypted?: boolean;
  readonly password?: string;
  readonly error?: string;
  readonly outline?: number;
  readonly layers?: number;
  readonly attachments?: number;
  readonly links?: number;
  readonly labels?: ReadonlyArray<string>;
  readonly permissions?: Readonly<Record<string, boolean>>;
  readonly xmpContains?: string;
  readonly objects?: ReadonlyArray<string>;
  readonly renderPages?: number;
  readonly annotationFlags?: Readonly<Record<string, Partial<AnnotationFlags>>>;
  /**
   * The fonts the document's resources name, in order (M72, ADR 0017), each as
   * `"<name> <type> <embedded|missing> [subset] [encoding]"` — the words the Fonts tab shows.
   */
  readonly fonts?: ReadonlyArray<string>;
  /** Fields of `initialView()` that must match; anything not named is not checked (M72). */
  readonly initialView?: Readonly<Record<string, unknown>>;
  /** Custom information-dictionary entries the file carries (M72). */
  readonly custom?: Readonly<Record<string, string>>;
  readonly trapped?: string;
  readonly lang?: string;
  readonly baseUrl?: string;
  readonly notes?: string;
}

interface Manifest {
  readonly fixtures: Readonly<Record<string, Expectation>>;
}

interface Snapshot {
  render: string[];
  text: string;
}

const HASH_TOLERANCE = 6;
const UPDATE = process.env['YNOT_UPDATE_HASHES'] === '1';
const manifest = JSON.parse(readFileSync(join(FIXTURES, 'manifest.json'), 'utf8')) as Manifest;
const hashesDir = join(FIXTURES, 'hashes');
const hashesFile = join(hashesDir, `${process.platform}.json`);
const stored: Record<string, Snapshot> = existsSync(hashesFile)
  ? (JSON.parse(readFileSync(hashesFile, 'utf8')) as Record<string, Snapshot>)
  : {};
const produced: Record<string, Snapshot> = {};

afterAll(() => {
  if (!UPDATE) return;
  mkdirSync(hashesDir, { recursive: true });
  const merged = { ...stored, ...produced };
  const sorted = Object.fromEntries(
    Object.keys(merged)
      .sort()
      .map((k) => [k, merged[k]]),
  );
  writeFileSync(hashesFile, `${JSON.stringify(sorted, null, 2)}\n`);
  console.info(`corpus: wrote ${Object.keys(produced).length} snapshots to ${hashesFile}`);
});

describe('engine corpus', () => {
  for (const [name, exp] of Object.entries(manifest.fixtures)) {
    const path = join(FIXTURES, name);
    it.skipIf(!existsSync(path))(
      `${name}${exp.notes ? ` — ${exp.notes}` : ''}`,
      async () => {
        const e = await engine();
        const bytes = new Uint8Array(readFileSync(path));
        const options = exp.password === undefined ? {} : { password: exp.password };
        if (exp.error !== undefined) {
          const err = await e.open(bytes, options).catch((x: unknown) => x);
          expect(err).toBeInstanceOf(EngineError);
          expect((err as EngineError).code).toBe(exp.error);
          return;
        }
        if (exp.password !== undefined) {
          await expect(e.open(bytes)).rejects.toMatchObject({ code: 'password-required' });
        }
        const doc = await e.open(bytes, options);
        try {
          const pages = await e.pageCount(doc);
          if (exp.pages !== undefined) expect(pages).toBe(exp.pages);
          const size0 = await e.pageSize(doc, 0);
          if (exp.size) {
            expect(size0.width).toBeCloseTo(exp.size[0], 1);
            expect(size0.height).toBeCloseTo(exp.size[1], 1);
          }
          for (const [index, [w, h, rot]] of Object.entries(exp.pageSizes ?? {})) {
            const s = await e.pageSize(doc, Number(index));
            expect(s.width, `page ${index} width`).toBeCloseTo(w, 1);
            expect(s.height, `page ${index} height`).toBeCloseTo(h, 1);
            expect(s.rotation, `page ${index} rotation`).toBe(rot);
          }
          const runs = await e.textRuns(doc, 0);
          const text = runs.map((r) => r.text).join(' ');
          if (exp.text !== undefined) expect(text).toContain(exp.text);
          if (exp.textAlso !== undefined) expect(text).toContain(exp.textAlso);
          if (exp.exactText !== undefined) expect(runs[0]?.text).toBe(exp.exactText);
          const annots = await e.annotations(doc, 0);
          if (exp.annotations !== undefined) expect(annots).toHaveLength(exp.annotations);
          if (exp.subtypes)
            expect([...new Set(annots.map((a) => a.subtype))].sort()).toEqual(
              [...exp.subtypes].sort(),
            );
          for (const [index, flags] of Object.entries(exp.annotationFlags ?? {})) {
            expect(annots[Number(index)]?.flags).toMatchObject(flags);
          }
          if (exp.fields !== undefined || exp.fieldTypes) {
            const fields = await e.formFields(doc);
            if (exp.fields !== undefined) expect(fields).toHaveLength(exp.fields);
            if (exp.fieldTypes) expect(fields.map((f) => f.type)).toEqual(exp.fieldTypes);
          }
          const meta = await e.metadata(doc);
          expect(meta.pageCount).toBe(pages);
          if (exp.hasForm !== undefined) expect(meta.hasForm).toBe(exp.hasForm);
          if (exp.hasXfa !== undefined) expect(meta.hasXfa).toBe(exp.hasXfa);
          if (exp.encrypted !== undefined) expect(meta.encrypted).toBe(exp.encrypted);
          if (exp.xmpContains !== undefined) expect(meta.xmp ?? '').toContain(exp.xmpContains);
          if (exp.outline !== undefined) expect(await e.outline(doc)).toHaveLength(exp.outline);
          if (exp.layers !== undefined) expect(await e.layers(doc)).toHaveLength(exp.layers);
          if (exp.attachments !== undefined)
            expect(await e.attachments(doc)).toHaveLength(exp.attachments);
          if (exp.links !== undefined) expect(await e.links(doc, 0)).toHaveLength(exp.links);
          if (exp.labels)
            expect((await e.pageLabels(doc)).slice(0, exp.labels.length)).toEqual(exp.labels);
          if (exp.permissions) expect(await e.permissions(doc)).toMatchObject(exp.permissions);
          if (exp.fonts) {
            const fonts = await e.fonts(doc);
            expect(
              fonts.map((f) =>
                [
                  f.name,
                  f.descendantType ?? f.type,
                  f.embedded ? 'embedded' : 'missing',
                  ...(f.subset ? ['subset'] : []),
                  ...(f.encoding === undefined ? [] : [f.encoding]),
                ].join(' '),
              ),
            ).toEqual(exp.fonts);
          }
          if (exp.initialView) expect(await e.initialView(doc)).toMatchObject(exp.initialView);
          if (exp.custom) expect(meta.custom).toEqual(exp.custom);
          if (exp.trapped !== undefined) expect(meta.trapped).toBe(exp.trapped);
          if (exp.lang !== undefined) expect(meta.lang).toBe(exp.lang);
          if (exp.baseUrl !== undefined) expect(meta.baseUrl).toBe(exp.baseUrl);
          if (exp.objects) {
            const kinds = (await e.pageObjects(doc, 0)).map((o) => o.kind);
            for (const k of exp.objects) expect(kinds).toContain(k);
          }
          // Render regression: 72 dpi hash per page (first few pages), plus the page-0 text.
          const renderPages = Math.min(pages, exp.renderPages ?? 3);
          const render: string[] = [];
          for (let p = 0; p < renderPages; p++) render.push(dhash(await e.renderRaw(doc, p, 1)));
          const snapshot: Snapshot = { render, text: text.slice(0, 200) };
          produced[name] = snapshot;
          const previous = stored[name];
          if (!UPDATE) {
            expect(
              previous,
              `no snapshot for ${name} in ${hashesFile}; run npm run hashes`,
            ).toBeDefined();
            if (!previous) return;
            expect(snapshot.text).toBe(previous.text);
            expect(render.length).toBe(previous.render.length);
            render.forEach((h, i) => {
              const distance = hamming(h, previous.render[i] ?? '');
              expect(
                distance,
                `${name} page ${i}: hash ${h} vs stored ${previous.render[i]}`,
              ).toBeLessThanOrEqual(HASH_TOLERANCE);
            });
          }
        } finally {
          await e.close(doc);
        }
      },
      60_000,
    );
  }
});

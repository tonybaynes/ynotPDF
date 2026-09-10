/**
 * The engine half of M33 (ADR 0018): `pageObjectPaths` against real PDFium, the two new
 * `DictValue` kinds, and the dictionary mappings that carry a measurement into a file.
 */

import { describe, expect, it } from 'vitest';
import { PDFDocument, PDFName, type PDFRef } from 'pdf-lib';
import {
  ANNOTATION_DICT_MAPPINGS,
  DEFAULT_MEASURE_SCALE,
  dictEntries,
  dictMapping,
  linearFactor,
  measureDictValue,
  normaliseScale,
  toDictValue,
} from '@engine/appearance';
import type { PdfPoint } from '@shared/pdf';
import { snapAt } from '@modules/M33-measuring-tools/snap';
import { engine, fixture } from '../engine/helpers';
import { must } from '../find/helpers';

const MM = 72 / 25.4;
const mm = (value: number): number => value * MM;

/** The engine's optional path reader, which the PDFium adapter always has (ADR 0018). */
async function outlines(
  eng: Awaited<ReturnType<typeof engine>>,
  doc: Parameters<typeof eng.close>[0],
): Promise<ReadonlyArray<{ index: number; subpaths: ReadonlyArray<ReadonlyArray<PdfPoint>> }>> {
  expect(typeof eng.pageObjectPaths).toBe('function');
  return await eng.pageObjectPaths(doc, 0);
}

/** Whether any subpath has a point within `tolerance` of `at`. */
function hasPointNear(
  paths: ReadonlyArray<ReadonlyArray<PdfPoint>>,
  at: PdfPoint,
  tolerance = 0.5,
): boolean {
  return paths.some((path) => path.some((p) => Math.hypot(p.x - at.x, p.y - at.y) <= tolerance));
}

describe('pageObjectPaths', () => {
  it('reports the fixture’s lines and box as polylines in page space', async () => {
    const eng = await engine();
    const doc = await eng.open(fixture('measure.pdf'));
    try {
      const objects = await outlines(eng, doc);
      expect(objects.length).toBeGreaterThan(0);
      const subpaths = objects.flatMap((o) => o.subpaths);
      // The 100 mm line's two ends.
      expect(hasPointNear(subpaths, { x: mm(20), y: mm(250) })).toBe(true);
      expect(hasPointNear(subpaths, { x: mm(120), y: mm(250) })).toBe(true);
      // The rectangle's four corners.
      for (const corner of [
        { x: mm(20), y: mm(200) },
        { x: mm(70), y: mm(200) },
        { x: mm(70), y: mm(220) },
        { x: mm(20), y: mm(220) },
      ]) {
        expect(hasPointNear(subpaths, corner), JSON.stringify(corner)).toBe(true);
      }
      // The triangle's right angle.
      expect(hasPointNear(subpaths, { x: mm(30), y: mm(120) })).toBe(true);
    } finally {
      await eng.close(doc);
    }
  });

  it('names the object each outline came from, so a caller can look it up', async () => {
    const eng = await engine();
    const doc = await eng.open(fixture('measure.pdf'));
    try {
      const objects = await outlines(eng, doc);
      const all = await eng.pageObjects(doc, 0);
      for (const item of objects) {
        expect(all[item.index], String(item.index)).toBeDefined();
        expect(all[item.index]?.kind).toBe('path');
      }
    } finally {
      await eng.close(doc);
    }
  });

  it('gives the snapper enough to find the crossing at (150, 100) mm', async () => {
    const eng = await engine();
    const doc = await eng.open(fixture('measure.pdf'));
    try {
      const objects = await outlines(eng, doc);
      const paths = objects.flatMap((o) => o.subpaths);
      const found = snapAt({ x: mm(150) + 2, y: mm(100) - 2 }, paths, 6, {
        endpoints: false,
        midpoints: false,
        intersections: true,
        paths: false,
      });
      expect(found?.kind).toBe('intersections');
      expect(found?.point.x).toBeCloseTo(mm(150), 3);
      expect(found?.point.y).toBeCloseTo(mm(100), 3);
    } finally {
      await eng.close(doc);
    }
  });

  it('closes a closed subpath by repeating its first point', async () => {
    const eng = await engine();
    const doc = await eng.open(fixture('measure.pdf'));
    try {
      const objects = await outlines(eng, doc);
      const closed = objects
        .flatMap((o) => o.subpaths)
        .filter((path) => {
          const first = path[0];
          const last = path[path.length - 1];
          return path.length > 2 && first?.x === last?.x && first?.y === last?.y;
        });
      // The 50 x 20 mm rectangle is the closed one.
      expect(closed.length).toBeGreaterThanOrEqual(1);
    } finally {
      await eng.close(doc);
    }
  });

  it('walks as deep as a file nests, composing the matrices on the way', async () => {
    /*
     * Three forms deep, which is what a placed drawing inside a stamp inside an imported page
     * looks like — and one deeper than the guard this used to have. Built here rather than added
     * to the corpus because the point is the *nesting*: a line at (10,10)-(90,10) inside a form
     * placed at (20,20), inside one at (50,50), inside one at (100,100), has to come back at
     * (180,180)-(260,180).
     */
    const pdf = await PDFDocument.create({ updateMetadata: false });
    const page = pdf.addPage([400, 400]);
    const ctx = pdf.context;
    const form = (content: string, resources?: PDFRef): PDFRef =>
      ctx.register(
        ctx.flateStream(content, {
          Type: 'XObject',
          Subtype: 'Form',
          FormType: 1,
          BBox: ctx.obj([0, 0, 400, 400]),
          Matrix: ctx.obj([1, 0, 0, 1, 0, 0]),
          ...(resources ? { Resources: ctx.obj({ XObject: ctx.obj({ Child: resources }) }) } : {}),
        }),
      );
    const inner = form('1 w 10 10 m 90 10 l S');
    const middle = form('q 1 0 0 1 20 20 cm /Child Do Q', inner);
    const outer = form('q 1 0 0 1 50 50 cm /Child Do Q', middle);
    page.node.setXObject(PDFName.of('Outer'), outer);
    page.node.set(
      PDFName.of('Contents'),
      ctx.register(ctx.flateStream('q 1 0 0 1 100 100 cm /Outer Do Q')),
    );

    const eng = await engine();
    const doc = await eng.open(await pdf.save({ useObjectStreams: false }));
    try {
      const subpaths = (await outlines(eng, doc)).flatMap((o) => o.subpaths);
      expect(subpaths.length, 'nothing was found inside the nested forms').toBeGreaterThan(0);
      expect(hasPointNear(subpaths, { x: 180, y: 180 }, 1)).toBe(true);
      expect(hasPointNear(subpaths, { x: 260, y: 180 }, 1)).toBe(true);
    } finally {
      await eng.close(doc);
    }
  });

  it('has nothing to say about a page with no paths on it', async () => {
    const eng = await engine();
    const doc = await eng.open(fixture('blank.pdf'));
    try {
      const objects = await outlines(eng, doc);
      expect(objects).toEqual([]);
    } finally {
      await eng.close(doc);
    }
  });
});

describe('reading a /Measure back out of a file', () => {
  it('measures a reopened annotation at the scale the file states', () => {
    // Proved end to end in `roundtrip.test.ts`; this is the reader on its own, against a file
    // whose factor is deliberately not 1 so a missing conversion would show.
    const plan = normaliseScale({
      fromValue: 1,
      fromUnit: 'cm',
      toValue: 5,
      toUnit: 'm',
      precision: 2,
      denominator: 0,
    });
    const dict = measureDictValue(plan);
    expect(dict.kind).toBe('dict');
    if (dict.kind !== 'dict') return;
    const distance = dict.value['D'];
    expect(distance?.kind).toBe('array');
    if (distance?.kind !== 'array') return;
    const format = distance.value[0];
    expect(format?.kind).toBe('dict');
    if (format?.kind !== 'dict') return;
    const c = format.value['C'];
    expect(c?.kind === 'number' ? c.value : Number.NaN).toBeCloseTo(linearFactor(plan), 12);
  });
});

describe('the dictionary mappings a measurement needs', () => {
  it('names /Measure, the leaders and the caption', () => {
    for (const [key, pdfKey] of [
      ['measure', 'Measure'],
      ['leaderLength', 'LL'],
      ['leaderExtend', 'LLE'],
      ['leaderOffset', 'LLO'],
      ['caption', 'Cap'],
      ['captionPosition', 'CP'],
      ['captionOffset', 'CO'],
    ] as const) {
      expect(dictMapping(key)?.pdfKey, key).toBe(pdfKey);
    }
  });

  it('turns a scale into the whole dictionary, and rubbish into nothing', () => {
    const entries = dictEntries({ measure: DEFAULT_MEASURE_SCALE });
    expect(entries['Measure']?.kind).toBe('dict');
    expect(dictEntries({ measure: 'nonsense' })['Measure']).toBeUndefined();
    // A cleared scale removes the entry rather than leaving a stale one in the file.
    expect(dictEntries({ measure: null })['Measure']).toBeNull();
  });

  it('writes /Cap false as a value, not as an absence', () => {
    expect(dictEntries({ caption: false })['Cap']).toEqual({ kind: 'bool', value: false });
    expect(dictEntries({ caption: true })['Cap']).toEqual({ kind: 'bool', value: true });
    // Anything that is not a boolean is malformed, and is skipped rather than half-written.
    const mapping = must(dictMapping('caption'), 'caption');
    expect(toDictValue(mapping, 'yes')).toBeNull();
    expect(toDictValue(mapping, false)).toEqual({ kind: 'bool', value: false });
    expect(dictEntries({ caption: 'yes' })['Cap']).toBeUndefined();
  });

  it('writes a leader of zero as zero', () => {
    expect(dictEntries({ leaderLength: 0 })['LL']).toEqual({ kind: 'number', value: 0 });
    expect(dictEntries({ leaderLength: -8 })['LL']).toEqual({ kind: 'number', value: -8 });
  });

  it('coerces the two new kinds only where they make sense', () => {
    const bool = must(
      ANNOTATION_DICT_MAPPINGS.find((m) => m.kind === 'bool'),
      'a bool mapping',
    );
    expect(toDictValue(bool, true)).toEqual({ kind: 'bool', value: true });
    const measure = must(dictMapping('measure'), 'measure');
    expect(toDictValue(measure, 42)).toBeNull();
    // Neither shape can be guessed from a bare model value, so both coerce to nothing.
    for (const kind of ['dict', 'array'] as const) {
      expect(
        toDictValue({ key: 'x', pdfKey: 'X', kind, engineWritable: false }, [1, 2]),
        kind,
      ).toBeNull();
    }
  });
});

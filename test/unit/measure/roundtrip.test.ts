/**
 * M33 acceptance, at the model level and through the whole real pipeline.
 *
 * Three measurements are made on the synthetic `measure.pdf` — the 100 mm line, the 50 × 20 mm
 * rectangle and the 3-4-5 triangle — after a calibration; the document is saved through M21's
 * planner, PDFium and `FullRewriteWriter`, reopened in PDFium, and every measurement is measured
 * again out of the file. Then the file itself is inspected: the `/Measure` dictionary Acrobat
 * would read, the dimension `/IT`, `/LL` and friends, and an appearance stream carrying the
 * caption.
 *
 * The acceptance lines this covers:
 *
 * - a 100 mm line measures 100.0 mm ± 0.1 after calibration; the 50 × 20 mm rectangle is 1000 mm²;
 * - a saved measurement carries `/Measure` and reopens with the same value.
 */

import { describe, expect, it } from 'vitest';
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFString,
  decodePDFRawStream,
} from 'pdf-lib';
import { Document } from '@core/Document';
import { AddAnnotationCommand, DEFAULT_ANNOTATION_FLAGS, draftAnnotation } from '@core/commands';
import { FullRewriteWriter } from '@engine/writers/FullRewriteWriter';
import { buildWritePlan } from '@modules/M21-save/plan';
import {
  MEASURE_INTENTS,
  POINTS_PER_UNIT,
  measurementOf,
  normaliseScale,
  type MeasureScale,
} from '@engine/appearance';
import { measurementRect } from '@modules/M33-measuring-tools/provider';
import { calibrationScale } from '@modules/M33-measuring-tools/scale';
import { engine, fixture } from '../engine/helpers';
import { must } from '../find/helpers';

const NOW = '2026-09-10T12:00:00.000Z';
const MM = 72 / 25.4;
const mm = (value: number): number => value * MM;

/** A PDF text string, whichever of the two forms the writer chose. */
function textOf(value: unknown): string {
  if (value instanceof PDFHexString || value instanceof PDFString) return value.decodeText();
  return '';
}

const common = {
  flags: DEFAULT_ANNOTATION_FLAGS,
  author: 'A Reader',
  created: NOW,
  modified: NOW,
};

/**
 * The scale a reader would get by calibrating on the fixture's 100 mm line and typing "100 mm".
 * Worked out the same way the calibrate tool does, so the test proves the tool's arithmetic too.
 */
const CALIBRATED: MeasureScale = must(
  calibrationScale({
    pagePoints: mm(100),
    realValue: 100,
    unit: 'mm',
    precision: 1,
    pointsPerUnit: POINTS_PER_UNIT.mm,
  }),
  'calibration',
);

/** The three measurements, exactly on the fixture's geometry. */
const CASES = [
  {
    name: 'the 100 mm line',
    subtype: 'Line' as const,
    intent: MEASURE_INTENTS.Line,
    vertices: [
      { x: mm(20), y: mm(250) },
      { x: mm(120), y: mm(250) },
    ],
    expected: 100,
    text: '100.0 mm',
    subject: 'Distance',
  },
  {
    name: 'the 50 x 20 mm rectangle',
    subtype: 'Polygon' as const,
    intent: MEASURE_INTENTS.Polygon,
    vertices: [
      { x: mm(20), y: mm(200) },
      { x: mm(70), y: mm(200) },
      { x: mm(70), y: mm(220) },
      { x: mm(20), y: mm(220) },
    ],
    expected: 1000,
    text: '1,000.0 mm²',
    subject: 'Area',
  },
  {
    name: 'the 3-4-5 triangle',
    subtype: 'PolyLine' as const,
    intent: MEASURE_INTENTS.PolyLine,
    vertices: [
      { x: mm(30), y: mm(120) },
      { x: mm(90), y: mm(120) },
      { x: mm(30), y: mm(165) },
      { x: mm(30), y: mm(120) },
    ],
    expected: 180,
    text: '180.0 mm',
    subject: 'Perimeter',
  },
];

interface Made {
  bytes: Uint8Array;
  before: Array<{ subject: string; value: number; text: string }>;
  warnings: string[];
}

/** Opens `measure.pdf`, measures the three shapes at the calibrated scale, saves for real. */
async function makeMeasured(): Promise<Made> {
  const eng = await engine();
  const doc = await Document.open(eng, fixture('measure.pdf'));
  const page = must(doc.state.pages[0], 'page');
  await doc.loadAnnotations(page.id);
  const before: Made['before'] = [];
  for (const item of CASES) {
    const extra: Record<string, unknown> = {
      intent: item.intent,
      measure: CALIBRATED,
      caption: true,
      captionPosition: 'Top',
      fontSize: 9,
    };
    if (item.subtype === 'Line') {
      extra['leaderLength'] = 8;
      extra['leaderExtend'] = 4;
      extra['leaderOffset'] = 2;
    }
    const measurement = must(
      measurementOf({ subtype: item.subtype, vertices: item.vertices, extra }),
      item.name,
    );
    const draft = draftAnnotation(doc, page.id, {
      subtype: item.subtype,
      rect: { x0: 0, y0: 0, x1: 0, y1: 0 },
      color: 0x5b2d91,
      borderWidth: 1,
      paths: [item.vertices],
      contents: measurement.text,
      subject: item.subject,
      ...common,
      extra,
    });
    // The rect is what the drawing needs — the leaders and the caption included — so it is taken
    // from the draft rather than guessed before it exists.
    const placed = { ...draft, rect: measurementRect(draft, item.vertices) };
    await doc.apply(new AddAnnotationCommand(doc, placed));
    before.push({ subject: item.subject, value: measurement.value, text: measurement.text });
  }
  const { plan, warnings } = buildWritePlan(doc);
  const base = await eng.save(doc.handle);
  await doc.close();
  const result = await new FullRewriteWriter().write({
    bytes: base,
    plan,
    options: { objectStreams: false },
  });
  return { bytes: result.bytes, before, warnings: [...warnings, ...result.warnings] };
}

let made: Promise<Made> | null = null;
const measured = (): Promise<Made> => (made ??= makeMeasured());

describe('a measurement measures what the geometry says', () => {
  it('a 100 mm line is 100.0 mm after calibration, and a 50 x 20 mm rect is 1000 mm²', async () => {
    const { before } = await measured();
    const distance = must(
      before.find((r) => r.subject === 'Distance'),
      'distance',
    );
    const area = must(
      before.find((r) => r.subject === 'Area'),
      'area',
    );
    const perimeter = must(
      before.find((r) => r.subject === 'Perimeter'),
      'perimeter',
    );
    expect(Math.abs(distance.value - 100)).toBeLessThanOrEqual(0.1);
    expect(distance.text).toBe('100.0 mm');
    expect(Math.abs(area.value - 1000)).toBeLessThanOrEqual(0.1);
    expect(area.text).toBe('1,000.0 mm²');
    expect(Math.abs(perimeter.value - 180)).toBeLessThanOrEqual(0.1);
  });

  it('calibrating on that line gives back true size, whatever unit is asked for', () => {
    // 1 mm of page really is 1 mm, so the ratio comes out as 1 : 1.
    expect(normaliseScale(CALIBRATED).toValue).toBeCloseTo(1, 9);
    // Half as long a line means everything measures twice as big.
    const doubled = must(
      calibrationScale({
        pagePoints: mm(50),
        realValue: 100,
        unit: 'mm',
        precision: 1,
        pointsPerUnit: POINTS_PER_UNIT.mm,
      }),
      'doubled',
    );
    expect(doubled.toValue).toBeCloseTo(2, 9);
    // Nothing can be calibrated from a line of no length, or to a length of nothing.
    expect(
      calibrationScale({
        pagePoints: 0,
        realValue: 100,
        unit: 'mm',
        precision: 1,
        pointsPerUnit: 1,
      }),
    ).toBeNull();
    expect(
      calibrationScale({
        pagePoints: 10,
        realValue: 0,
        unit: 'mm',
        precision: 1,
        pointsPerUnit: 1,
      }),
    ).toBeNull();
  });
});

describe('a saved measurement reopens with the same value', () => {
  it('saves without a warning', async () => {
    const { warnings } = await measured();
    expect(warnings).toEqual([]);
  });

  it('measures the same after a save and a reopen', async () => {
    const eng = await engine();
    const { bytes, before } = await measured();
    const doc = await Document.open(eng, bytes);
    try {
      const page = must(doc.state.pages[0], 'page');
      const after = (await doc.loadAnnotations(page.id))
        .filter((a) => a.family === 'shape' && typeof a.extra['intent'] === 'string')
        .map((a) => {
          const measurement = measurementOf({
            subtype: a.subtype,
            vertices: a.family === 'shape' ? a.vertices : [],
            extra: a.extra,
          });
          return {
            subject: a.subject ?? '',
            value: measurement?.value ?? Number.NaN,
            text: measurement?.text ?? '',
            contents: a.contents,
          };
        });
      expect(after).toHaveLength(before.length);
      for (const wanted of before) {
        const found = must(
          after.find((r) => r.subject === wanted.subject),
          wanted.subject,
        );
        // The scale came back out of `/Measure`, and the points out of `/L` or `/Vertices`.
        expect(Math.abs(found.value - wanted.value), wanted.subject).toBeLessThanOrEqual(0.1);
        expect(found.text, wanted.subject).toBe(wanted.text);
        // `/Contents` carries it too, for a viewer that cannot measure.
        expect(found.contents).toBe(wanted.text);
      }
    } finally {
      await doc.close();
    }
  });
});

describe('the file itself', () => {
  it('carries a RectilinearMeasure dictionary with number formats on every axis', async () => {
    const { bytes } = await measured();
    const pdf = await PDFDocument.load(bytes);
    const page = must(pdf.getPages()[0], 'page');
    const annots = must(page.node.Annots(), 'annots');
    let checked = 0;
    for (const ref of annots.asArray()) {
      const dict = pdf.context.lookupMaybe(ref, PDFDict);
      const measure = dict?.lookupMaybe(PDFName.of('Measure'), PDFDict);
      if (!measure) continue;
      checked++;
      expect(measure.lookupMaybe(PDFName.of('Subtype'), PDFName)?.decodeText()).toBe('RL');
      expect(textOf(measure.get(PDFName.of('R')))).toBe('1 mm = 1 mm');
      for (const axis of ['X', 'Y', 'D', 'A', 'T']) {
        const array = measure.lookupMaybe(PDFName.of(axis), PDFArray);
        expect(array, axis).toBeDefined();
        const format = pdf.context.lookupMaybe(array?.get(0), PDFDict);
        expect(format?.lookupMaybe(PDFName.of('Type'), PDFName)?.decodeText()).toBe('NumberFormat');
        expect(format?.lookupMaybe(PDFName.of('C'), PDFNumber)).toBeDefined();
        // `/U` is a text string; it may be written as a hex string, hence the loose check.
        expect(format?.get(PDFName.of('U'))).toBeDefined();
      }
      // The area format's label carries the squared unit.
      const areaFormat = pdf.context.lookupMaybe(
        measure.lookupMaybe(PDFName.of('A'), PDFArray)?.get(0),
        PDFDict,
      );
      expect(textOf(areaFormat?.get(PDFName.of('U')))).toBe('mm²');
    }
    expect(checked).toBe(CASES.length);
  });

  it('carries the dimension intent, the leaders and the caption entries', async () => {
    const { bytes } = await measured();
    const pdf = await PDFDocument.load(bytes);
    const page = must(pdf.getPages()[0], 'page');
    const annots = must(page.node.Annots(), 'annots');
    const intents: string[] = [];
    let leaders = 0;
    for (const ref of annots.asArray()) {
      const dict = pdf.context.lookupMaybe(ref, PDFDict);
      if (!dict?.lookupMaybe(PDFName.of('Measure'), PDFDict)) continue;
      const intent = dict.lookupMaybe(PDFName.of('IT'), PDFName)?.decodeText() ?? '';
      intents.push(intent);
      expect(dict.get(PDFName.of('Cap'))?.toString()).toBe('true');
      expect(dict.lookupMaybe(PDFName.of('CP'), PDFName)?.decodeText()).toBe('Top');
      if (intent === 'LineDimension') {
        leaders++;
        expect(dict.lookupMaybe(PDFName.of('LL'), PDFNumber)?.asNumber()).toBe(8);
        expect(dict.lookupMaybe(PDFName.of('LLE'), PDFNumber)?.asNumber()).toBe(4);
        expect(dict.lookupMaybe(PDFName.of('LLO'), PDFNumber)?.asNumber()).toBe(2);
      }
    }
    expect(intents.sort()).toEqual(['LineDimension', 'PolyLineDimension', 'PolygonDimension']);
    expect(leaders).toBe(1);
  });

  it('gives every measurement an appearance stream that draws its caption', async () => {
    const { bytes } = await measured();
    const pdf = await PDFDocument.load(bytes);
    const page = must(pdf.getPages()[0], 'page');
    const annots = must(page.node.Annots(), 'annots');
    let withText = 0;
    for (const ref of annots.asArray()) {
      const dict = pdf.context.lookupMaybe(ref, PDFDict);
      if (!dict?.lookupMaybe(PDFName.of('Measure'), PDFDict)) continue;
      const ap = dict.lookupMaybe(PDFName.of('AP'), PDFDict);
      const normal: unknown = pdf.context.lookup(ap?.get(PDFName.of('N')));
      expect(normal).toBeInstanceOf(PDFRawStream);
      if (!(normal instanceof PDFRawStream)) continue;
      const content = new TextDecoder('latin1').decode(decodePDFRawStream(normal).decode());
      if (content.includes('Tj')) withText++;
    }
    expect(withText).toBe(CASES.length);
  });
});

/**
 * M33's remaining pure parts: the results list and its CSV, the scale record, the settings, the
 * provider's patches, and what the overlay draws.
 */

import { describe, expect, it } from 'vitest';
import { must } from '../find/helpers';
import type { ModelAnnotation } from '@core/model';
import type { ModelId } from '@core/Ids';
import { DEFAULT_ANNOTATION_FLAGS } from '@core/commands';
import { DEFAULT_MEASURE_SCALE, MEASURE_INTENTS, normaliseScale } from '@engine/appearance';
import type { PdfPoint } from '@shared/pdf';
import {
  CAPTION_HANDLE,
  captionHandleFor,
  drawnByOverlay,
  handlesFor,
  hitRects,
  intentOf,
  isMeasureAnnotation,
  measurementFor,
  shapesFor,
  toLayerAnnotation,
} from '@modules/M33-measuring-tools/overlay';
import {
  dragMeasurementHandle,
  measureProvider,
  measurementRect,
  moveCaption,
  moveMeasurement,
  resizeMeasurement,
} from '@modules/M33-measuring-tools/provider';
import type { MeasureService } from '@modules/M33-measuring-tools/MeasureService';
import { MEASURE_TOOL_IDS } from '@modules/M33-measuring-tools/tools';
import {
  BOM,
  csvBytes,
  resultRows,
  resultTotals,
  rowsToCsv,
  rowsToText,
} from '@modules/M33-measuring-tools/results';
import {
  EMPTY_SCALE_RECORD,
  documentScalePatch,
  hasPageScale,
  pageScalePatch,
  readScaleRecord,
  scaleFor,
} from '@modules/M33-measuring-tools/scale';
import {
  DEFAULT_MEASURE_SETTINGS,
  MEASURE_SETTINGS_SCHEMA,
  MEASURE_TOOLS,
  ipcSettingsStorage,
  SNAP_KINDS,
  SNAP_LABELS,
  SNAP_SETTING,
  factoryMeasureDefaults,
  memorySettingsStorage,
  mergeMeasureDefaults,
  readMeasureDefaults,
  readMeasureSettings,
  writeMeasureDefaults,
  writeMeasureSetting,
} from '@modules/M33-measuring-tools/settings';

const MM = 72 / 25.4;
const mm = (value: number): number => value * MM;

let seq = 0;

/** A model measurement, as the service builds one. */
function measurement(patch: {
  subtype: 'Line' | 'Polygon' | 'PolyLine';
  vertices: PdfPoint[];
  extra?: Record<string, unknown>;
  pageId?: string;
  contents?: string;
}): ModelAnnotation {
  const intent =
    patch.subtype === 'Line'
      ? MEASURE_INTENTS.Line
      : patch.subtype === 'Polygon'
        ? MEASURE_INTENTS.Polygon
        : MEASURE_INTENTS.PolyLine;
  const extra = { intent, measure: DEFAULT_MEASURE_SCALE, ...patch.extra };
  const base = {
    id: `an-${String(++seq)}` as ModelId,
    pageId: (patch.pageId ?? 'pg-0') as ModelId,
    family: 'shape' as const,
    subtype: patch.subtype,
    rect: { x0: 0, y0: 0, x1: 0, y1: 0 },
    flags: DEFAULT_ANNOTATION_FLAGS,
    contents: patch.contents ?? null,
    author: 'A Reader',
    created: '2026-09-10T12:00:00.000Z',
    modified: '2026-09-10T12:00:00.000Z',
    color: 0x5b2d91,
    interiorColor: null,
    opacity: null,
    borderWidth: 1,
    appearanceState: null,
    name: null,
    subject: patch.subtype === 'Polygon' ? 'Area' : 'Distance',
    inReplyTo: null,
    state: null,
    extra,
    vertices: patch.vertices,
  };
  return { ...base, rect: measurementRect(base, patch.vertices) };
}

const line = (): ModelAnnotation =>
  measurement({
    subtype: 'Line',
    vertices: [
      { x: mm(20), y: mm(250) },
      { x: mm(120), y: mm(250) },
    ],
    contents: '100.0 mm',
  });

const box = (): ModelAnnotation =>
  measurement({
    subtype: 'Polygon',
    vertices: [
      { x: mm(20), y: mm(200) },
      { x: mm(70), y: mm(200) },
      { x: mm(70), y: mm(220) },
      { x: mm(20), y: mm(220) },
    ],
    contents: '1,000.0 mm²',
  });

describe('what the module owns', () => {
  it('claims a shape with a dimension intent, and nothing else', () => {
    expect(isMeasureAnnotation(line())).toBe(true);
    expect(isMeasureAnnotation(box())).toBe(true);
    const plain = measurement({
      subtype: 'Line',
      vertices: [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
      ],
      extra: { intent: 'LineArrow' },
    });
    expect(isMeasureAnnotation(plain)).toBe(false);
    expect(intentOf(plain)).toBeNull();
    expect(intentOf(line())).toBe('LineDimension');
  });

  it('reads the measurement off it', () => {
    expect(measurementFor(line())?.text).toBe('100.0 mm');
    expect(measurementFor(box())?.text).toBe('1,000.0 mm²');
  });
});

describe('the overlay', () => {
  it('draws a measurement until the file carries an appearance for it', () => {
    const fresh = line();
    expect(drawnByOverlay(fresh, new Set())).toBe(true);
    const saved = { ...fresh, extra: { ...fresh.extra, hasAP: true } } as ModelAnnotation;
    expect(drawnByOverlay(saved, new Set())).toBe(false);
    // Touched this session: the model has moved on from what the file holds.
    expect(drawnByOverlay(saved, new Set([String(saved.id)]))).toBe(true);
    // With the comment filter on, the raster draws nothing, so the overlay draws everything.
    expect(drawnByOverlay(saved, new Set(), false)).toBe(true);
  });

  it('draws nothing for a hidden one, or for something that is not ours', () => {
    const hidden = {
      ...line(),
      flags: { ...DEFAULT_ANNOTATION_FLAGS, hidden: true },
    } as ModelAnnotation;
    expect(drawnByOverlay(hidden, new Set())).toBe(false);
    const plain = measurement({
      subtype: 'Line',
      vertices: [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
      ],
      extra: { intent: undefined },
    });
    expect(drawnByOverlay(plain, new Set())).toBe(false);
    expect(shapesFor(plain)).toEqual([]);
  });

  it('paints the line, its leaders and its caption', () => {
    const shapes = shapesFor(
      measurement({
        subtype: 'Line',
        vertices: [
          { x: 100, y: 100 },
          { x: 300, y: 100 },
        ],
        extra: { leaderLength: 8, leaderExtend: 4, leaderOffset: 2 },
      }),
    );
    expect(shapes.filter((s) => s.kind === 'path')).toHaveLength(3);
    const text = shapes.find((s) => s.kind === 'text');
    expect(text?.kind).toBe('text');
    if (text?.kind === 'text') expect(text.lines[0]?.text).toBe('70.6 mm');
  });

  it('gives a measurement one handle per measured point, and hits on its rect', () => {
    const a = box();
    expect(handlesFor(a)).toBe('vertices');
    expect(hitRects(a)).toEqual([a.rect]);
    const layer = toLayerAnnotation(a, 2, { edited: new Set() });
    expect(layer.page).toBe(2);
    expect(layer.handles).toBe('vertices');
    expect(layer.vertices).toHaveLength(4);
    expect(layer.shapes.length).toBeGreaterThan(0);
    const hiddenLayer = toLayerAnnotation(a, 0, { edited: new Set(), hidden: true });
    expect(hiddenLayer.hidden).toBe(true);
  });
});

describe('the provider patches', () => {
  it('moves the rect and the points together, so the value does not change', () => {
    const a = line();
    const patch = moveMeasurement(a, 10, -5);
    expect(patch.vertices?.[0]).toEqual({ x: mm(20) + 10, y: mm(250) - 5 });
    expect(patch.rect?.x0).toBeCloseTo(a.rect.x0 + 10, 9);
    const moved = { ...a, ...patch } as ModelAnnotation;
    expect(measurementFor(moved)?.text).toBe('100.0 mm');
  });

  it('scales the points into a resized box, and takes the rect from what it then draws', () => {
    const a = line();
    const wider = {
      x0: a.rect.x0,
      y0: a.rect.y0,
      x1: a.rect.x0 + (a.rect.x1 - a.rect.x0) * 2,
      y1: a.rect.y1,
    };
    const patch = resizeMeasurement(a, wider);
    expect(patch).not.toBeNull();
    if (!patch?.vertices) return;
    const resized = { ...a, ...patch } as ModelAnnotation;
    // Twice as wide is twice as long — and the rect is what the drawing needs, not the handle's box.
    expect(measurementFor(resized)?.value).toBeCloseTo(200, 1);
    expect(patch.rect).toBeDefined();
  });

  it('moves one measured point when its handle is dragged', () => {
    const a = line();
    const patch = dragMeasurementHandle(a, 'v1', { x: mm(70), y: mm(250) });
    expect(patch?.vertices?.[1]).toEqual({ x: mm(70), y: mm(250) });
    const dragged = { ...a, ...patch } as ModelAnnotation;
    expect(measurementFor(dragged)?.text).toBe('50.0 mm');
  });

  it('gives the caption a handle of its own, beside the measured points', () => {
    const a = line();
    const handle = must(captionHandleFor(a), 'caption handle');
    expect(handle.id).toBe(CAPTION_HANDLE);
    const layer = toLayerAnnotation(a, 0, { edited: new Set() });
    expect(layer.extraHandles).toEqual([handle]);
    // Two measured points *and* the caption: the caption is extra, not instead.
    expect(layer.vertices).toHaveLength(2);
    // A measurement with its value hidden has nothing to grab.
    const quiet = { ...a, extra: { ...a.extra, caption: false } } as ModelAnnotation;
    expect(captionHandleFor(quiet)).toBeNull();
    expect(toLayerAnnotation(quiet, 0, { edited: new Set() }).extraHandles).toBeUndefined();
  });

  it('dragging the caption moves the label and nothing else', () => {
    const a = line();
    const start = must(captionHandleFor(a), 'handle').point;
    const patch = must(
      dragMeasurementHandle(a, CAPTION_HANDLE, { x: start.x + 30, y: start.y + 12 }),
      'patch',
    );
    // The measured points are untouched, so the value is untouched.
    expect(patch.vertices).toBeUndefined();
    const moved = { ...a, ...patch } as ModelAnnotation;
    expect(measurementFor(moved)?.text).toBe('100.0 mm');
    const landed = must(captionHandleFor(moved), 'moved handle').point;
    expect(landed.x).toBeCloseTo(start.x + 30, 2);
    expect(landed.y).toBeCloseTo(start.y + 12, 2);
    // And the rect grew to hold it where it now is.
    expect(must(patch.rect, 'rect').y1).toBeGreaterThanOrEqual(a.rect.y1);
  });

  it('puts the caption back where it belongs', () => {
    const a = line();
    const start = must(captionHandleFor(a), 'handle').point;
    const nudged = {
      ...a,
      ...must(dragMeasurementHandle(a, CAPTION_HANDLE, { x: start.x + 40, y: start.y }), 'patch'),
    } as ModelAnnotation;
    const back = {
      ...nudged,
      extra: { ...nudged.extra, captionOffset: [0, 0] },
    } as ModelAnnotation;
    const home = must(captionHandleFor(back), 'home').point;
    expect(home.x).toBeCloseTo(start.x, 6);
    expect(home.y).toBeCloseTo(start.y, 6);
  });

  it('refuses to move a caption on something that has none', () => {
    const plain = measurement({
      subtype: 'Line',
      vertices: [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
      ],
      extra: { intent: 'LineArrow' },
    });
    expect(moveCaption(plain, { x: 5, y: 5 })).toBeNull();
    expect(dragMeasurementHandle(plain, CAPTION_HANDLE, { x: 5, y: 5 })).toBeNull();
  });

  it('refuses a handle that is not a vertex, or one past the end', () => {
    expect(dragMeasurementHandle(line(), 'nw', { x: 0, y: 0 })).toBeNull();
    expect(dragMeasurementHandle(line(), 'v9', { x: 0, y: 0 })).toBeNull();
  });

  it('does nothing but move an annotation that is not a shape at all', () => {
    // Nothing should ever hand these an annotation the provider does not own, but a patch that
    // silently produced NaN geometry would be far worse than one that refuses.
    const note = { ...line(), family: 'note' as const, subtype: 'Text' as const, icon: null };
    const notShape = note as unknown as ModelAnnotation;
    expect(measurementRect(notShape, [])).toEqual(note.rect);
    expect(moveMeasurement(notShape, 5, 5).vertices).toBeUndefined();
    expect(resizeMeasurement(notShape, note.rect)).toBeNull();
    expect(dragMeasurementHandle(notShape, 'v0', { x: 0, y: 0 })).toBeNull();
  });
});

describe('the results list', () => {
  const pages = [
    { id: 'pg-0', label: '1' },
    { id: 'pg-1', label: '2' },
  ];
  const byPage: Record<string, ModelAnnotation[]> = {
    'pg-0': [line(), box()],
    'pg-1': [
      measurement({
        subtype: 'Line',
        vertices: [
          { x: 0, y: 0 },
          { x: mm(50), y: 0 },
        ],
        pageId: 'pg-1',
      }),
    ],
  };
  const rows = resultRows(pages, (id) => byPage[id] ?? []);

  it('lists every measurement, page by page, with its kind in words', () => {
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.kindLabel)).toEqual(['Distance', 'Area', 'Distance']);
    expect(rows.map((r) => r.pageLabel)).toEqual(['1', '1', '2']);
    expect(rows[0]?.text).toBe('100.0 mm');
    expect(rows[0]?.ratio).toBe('1 mm = 1 mm');
  });

  it('totals lengths and areas apart, and never adds two units together', () => {
    const totals = resultTotals(rows);
    expect(totals).toHaveLength(2);
    const length = totals.find((t) => t.kind === 'length');
    const area = totals.find((t) => t.kind === 'area');
    expect(length?.count).toBe(2);
    expect(length?.text).toBe('150.0 mm');
    expect(area?.count).toBe(1);
    expect(area?.unit).toBe('mm²');
    // Lengths first, so the list reads the way the tools are ordered.
    expect(totals[0]?.kind).toBe('length');
  });

  it('has no totals at all when nothing has been measured', () => {
    expect(resultTotals([])).toEqual([]);
    expect(resultRows(pages, () => [])).toEqual([]);
  });

  it('writes CSV with a BOM, CRLF and RFC 4180 quoting', () => {
    const csv = rowsToCsv(rows);
    expect(csv.startsWith(BOM)).toBe(true);
    expect(csv).toContain('\r\n');
    expect(csv.split('\r\n')[0]).toBe(
      `${BOM}"Page","Type","Value","Unit","Scale","Comment","Author","Created"`,
    );
    // The number and its unit are separate columns, so a spreadsheet can add them up.
    expect(csv).toContain('"100.0","mm"');
    expect(csvBytes(rows).length).toBeGreaterThan(csv.length - 3);
  });

  it('doubles a quote inside a comment rather than breaking the row', () => {
    const quoted = resultRows([{ id: 'p', label: '1' }], () => [
      measurement({
        subtype: 'Line',
        vertices: [
          { x: 0, y: 0 },
          { x: 10, y: 0 },
        ],
        contents: 'the "long" wall',
      }),
    ]);
    expect(rowsToCsv(quoted)).toContain('"the ""long"" wall"');
  });

  it('copies as tab-separated text, which is what a spreadsheet wants', () => {
    const text = rowsToText(rows);
    expect(text.split('\n')[0]).toBe('Page\tType\tValue\tUnit\tScale\tComment\tAuthor\tCreated');
    expect(text.split('\n')).toHaveLength(4);
  });
});

describe('the scale record', () => {
  it('is empty when the document carries nothing', () => {
    expect(readScaleRecord({})).toEqual(EMPTY_SCALE_RECORD);
    expect(scaleFor(EMPTY_SCALE_RECORD, null)).toEqual(DEFAULT_MEASURE_SCALE);
  });

  it("prefers a page's own calibration to the document's, and the document's to the fallback", () => {
    const docScale = normaliseScale({ ...DEFAULT_MEASURE_SCALE, toValue: 2 });
    const pageScale = normaliseScale({ ...DEFAULT_MEASURE_SCALE, toValue: 5 });
    const record = readScaleRecord({
      ...documentScalePatch(docScale),
      ...pageScalePatch(EMPTY_SCALE_RECORD, 'pg-1' as ModelId, pageScale),
    });
    expect(scaleFor(record, 'pg-1' as ModelId)).toEqual(pageScale);
    expect(scaleFor(record, 'pg-0' as ModelId)).toEqual(docScale);
    expect(hasPageScale(record, 'pg-1' as ModelId)).toBe(true);
    expect(hasPageScale(record, 'pg-0' as ModelId)).toBe(false);
    expect(hasPageScale(record, null)).toBe(false);
  });

  it('clears one page without touching the others', () => {
    const first = normaliseScale({ ...DEFAULT_MEASURE_SCALE, toValue: 2 });
    const second = normaliseScale({ ...DEFAULT_MEASURE_SCALE, toValue: 3 });
    let record = readScaleRecord(pageScalePatch(EMPTY_SCALE_RECORD, 'pg-0' as ModelId, first));
    record = readScaleRecord(pageScalePatch(record, 'pg-1' as ModelId, second));
    const cleared = readScaleRecord(pageScalePatch(record, 'pg-0' as ModelId, null));
    expect(hasPageScale(cleared, 'pg-0' as ModelId)).toBe(false);
    expect(scaleFor(cleared, 'pg-1' as ModelId)).toEqual(second);
  });

  it('throws nothing away, and nothing in, on a malformed record', () => {
    const record = readScaleRecord({ scale: 'nonsense', pageScales: 42 });
    expect(record).toEqual(EMPTY_SCALE_RECORD);
    expect(readScaleRecord({ pageScales: { 'pg-0': null } }).pages).toEqual({});
  });
});

describe('the settings', () => {
  it('gives every tool a factory default, and the distance tool its leaders', () => {
    for (const tool of MEASURE_TOOLS) {
      const defaults = factoryMeasureDefaults(tool);
      expect(defaults.subject.length).toBeGreaterThan(0);
      expect(defaults.color).toBeGreaterThan(0);
    }
    expect(factoryMeasureDefaults('distance').leaderLength).toBe(8);
    expect(factoryMeasureDefaults('area').leaderLength).toBe(0);
  });

  it('merges a stored object over the factory field by field, ignoring rubbish', () => {
    const merged = mergeMeasureDefaults('distance', {
      color: 0x123456,
      borderWidth: 'thick',
      dashArray: [3, 'x', -1],
      captionPosition: 'Sideways',
      caption: false,
    });
    expect(merged.color).toBe(0x123456);
    expect(merged.borderWidth).toBe(factoryMeasureDefaults('distance').borderWidth);
    expect(merged.dashArray).toEqual([3]);
    expect(merged.captionPosition).toBe('Top');
    expect(merged.caption).toBe(false);
    expect(mergeMeasureDefaults('distance', null)).toEqual(factoryMeasureDefaults('distance'));
  });

  it('round-trips through the storage', async () => {
    const storage = memorySettingsStorage();
    await writeMeasureSetting(storage, 'snapTolerance', 20);
    await writeMeasureSetting(
      storage,
      'scale',
      normaliseScale({ ...DEFAULT_MEASURE_SCALE, toValue: 5 }),
    );
    const settings = await readMeasureSettings(storage);
    expect(settings.snapTolerance).toBe(20);
    expect(settings.scale.toValue).toBe(5);
    expect(settings.snap).toBe(DEFAULT_MEASURE_SETTINGS.snap);
    await writeMeasureDefaults(storage, 'area', {
      ...factoryMeasureDefaults('area'),
      fontSize: 14,
    });
    expect((await readMeasureDefaults(storage, 'area')).fontSize).toBe(14);
  });

  it('keeps a stored scale only when it is one', async () => {
    const storage = memorySettingsStorage({ 'measure.scale': { fromValue: 1 } });
    expect((await readMeasureSettings(storage)).scale).toEqual(DEFAULT_MEASURE_SETTINGS.scale);
  });

  it('names every snap kind, and the setting that governs it', () => {
    for (const kind of SNAP_KINDS) {
      expect(SNAP_LABELS[kind].length).toBeGreaterThan(0);
      expect(SNAP_SETTING[kind]).toMatch(/^snap/);
      expect(DEFAULT_MEASURE_SETTINGS[SNAP_SETTING[kind]]).toBeTypeOf('boolean');
    }
  });

  it('offers the schema M130 renders, with a default for every property', () => {
    expect(MEASURE_SETTINGS_SCHEMA.namespace).toBe('measure');
    for (const [key, spec] of Object.entries(MEASURE_SETTINGS_SCHEMA.properties)) {
      expect(spec.title.length, key).toBeGreaterThan(0);
      expect(spec.default, key).toBeDefined();
    }
  });
});

describe('the provider', () => {
  it('outranks M31 and claims only a measurement, and hands the rest to the pure parts', async () => {
    const seen: string[] = [];
    const service = {
      afterChange: (a: ModelAnnotation) => {
        seen.push(String(a.id));
        return Promise.resolve();
      },
    } as unknown as MeasureService;
    const provider = measureProvider(service);
    expect(provider.id).toBe('M33');
    // M31's provider claims every shape at the default priority of 0; this one has to win.
    expect(provider.priority).toBeGreaterThan(0);
    expect(provider.creationTools).toBe(MEASURE_TOOL_IDS);
    const a = line();
    expect(provider.owns(a)).toBe(true);
    expect(provider.describe?.(a)).toBe('Distance measurement');
    expect(provider.describe?.(box())).toBe('Area measurement');
    expect(provider.toLayer(a, 0, { edited: new Set() }).handles).toBe('vertices');
    expect(provider.movePatch(a, 1, 1).rect).toBeDefined();
    expect(provider.resizePatch(a, a.rect)).not.toBeNull();
    expect(provider.handlePatch?.(a, 'v0', { x: 0, y: 0 })).not.toBeNull();
    await provider.afterChange?.(a);
    expect(seen).toEqual([String(a.id)]);
  });
});

describe('the settings storage', () => {
  it('says nothing and writes nothing when there is no bridge, as there is not in a test', async () => {
    const storage = ipcSettingsStorage();
    await expect(storage.get('measure.scale')).resolves.toBeUndefined();
    await expect(storage.set('measure.scale', 1)).resolves.toBeUndefined();
  });
});

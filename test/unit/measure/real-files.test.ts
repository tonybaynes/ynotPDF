/**
 * M33 against the operator's own PDFs (`test/fixtures/local/`, git-ignored).
 *
 * The synthetic `measure.pdf` is built to be easy: it is straight lines at whole millimetres on
 * an A4 page. These are what the module is for — real files from four producers, with their own
 * page boxes, their own annotations and their own idea of what a path is. Two things are checked
 * on each: a distance, a perimeter and an area drawn on the first page survive a save and reopen
 * with the value they were made with, and `pageObjectPaths` gives the snapper something real to
 * hold on to.
 *
 * Every test skips when the folder is empty, because CI and every other machine has no copy of it
 * (CLAUDE.md). Nothing here reads, prints or asserts anything about what the documents *say*: the
 * checks are about geometry and structure only.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Document } from '@core/Document';
import { AddAnnotationCommand, DEFAULT_ANNOTATION_FLAGS, draftAnnotation } from '@core/commands';
import { FullRewriteWriter } from '@engine/writers/FullRewriteWriter';
import { buildWritePlan } from '@modules/M21-save/plan';
import { MEASURE_INTENTS, POINTS_PER_UNIT, measurementOf } from '@engine/appearance';
import { isMeasureAnnotation } from '@modules/M33-measuring-tools/overlay';
import { measurementRect } from '@modules/M33-measuring-tools/provider';
import { calibrationScale } from '@modules/M33-measuring-tools/scale';
import { snapAt } from '@modules/M33-measuring-tools/snap';
import { engine, FIXTURES } from '../engine/helpers';
import { must } from '../find/helpers';

const LOCAL = join(FIXTURES, 'local');

function localFiles(): string[] {
  if (!existsSync(LOCAL)) return [];
  return readdirSync(LOCAL)
    .filter((name) => name.toLowerCase().endsWith('.pdf'))
    .sort();
}

const files = localFiles();
const NOW = '2026-09-10T12:00:00.000Z';
const common = { flags: DEFAULT_ANNOTATION_FLAGS, author: 'A Reader', created: NOW, modified: NOW };

/** True size in millimetres, worked out the way the calibrate tool does. */
const SCALE = must(
  calibrationScale({
    pagePoints: POINTS_PER_UNIT.mm * 100,
    realValue: 100,
    unit: 'mm',
    precision: 1,
    pointsPerUnit: POINTS_PER_UNIT.mm,
  }),
  'scale',
);

describe.skipIf(files.length === 0)('the measuring tools on the operator’s own files', () => {
  it.each(files)(
    '%s: a distance, a perimeter and an area survive a save and a reopen',
    async (name) => {
      const eng = await engine();
      const doc = await Document.open(eng, new Uint8Array(readFileSync(join(LOCAL, name))));
      const page = must(doc.state.pages[0], 'page');
      await doc.loadAnnotations(page.id);
      // Inside the page's own crop box, whatever that is, so nothing is measured off the paper.
      const box = page.cropBox;
      const w = box.x1 - box.x0;
      const h = box.y1 - box.y0;
      const at = (fx: number, fy: number) => ({ x: box.x0 + w * fx, y: box.y0 + h * fy });
      const cases = [
        {
          subtype: 'Line' as const,
          intent: MEASURE_INTENTS.Line,
          vertices: [at(0.15, 0.7), at(0.6, 0.7)],
          subject: 'Distance',
          extra: { leaderLength: 8, leaderExtend: 4, leaderOffset: 2 },
        },
        {
          subtype: 'PolyLine' as const,
          intent: MEASURE_INTENTS.PolyLine,
          vertices: [at(0.15, 0.5), at(0.5, 0.5), at(0.5, 0.6)],
          subject: 'Perimeter',
          extra: {},
        },
        {
          subtype: 'Polygon' as const,
          intent: MEASURE_INTENTS.Polygon,
          vertices: [at(0.15, 0.25), at(0.55, 0.25), at(0.55, 0.4), at(0.15, 0.4)],
          subject: 'Area',
          extra: {},
        },
      ];
      const before: Array<{ subject: string; text: string; value: number }> = [];
      for (const item of cases) {
        const extra = {
          intent: item.intent,
          measure: SCALE,
          caption: true,
          captionPosition: 'Top',
          fontSize: 9,
          ...item.extra,
        };
        const measurement = must(
          measurementOf({ subtype: item.subtype, vertices: item.vertices, extra }),
          item.subject,
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
        await doc.apply(
          new AddAnnotationCommand(doc, {
            ...draft,
            rect: measurementRect(draft, item.vertices),
          }),
        );
        before.push({
          subject: item.subject,
          text: measurement.text,
          value: measurement.value,
        });
      }
      const { plan, warnings } = buildWritePlan(doc);
      const base = await eng.save(doc.handle);
      await doc.close();
      const result = await new FullRewriteWriter().write({
        bytes: base,
        plan,
        options: { objectStreams: false },
      });
      expect([...warnings, ...result.warnings], name).toEqual([]);

      const reopened = await Document.open(eng, result.bytes);
      try {
        const first = must(reopened.state.pages[0], 'page');
        const found = (await reopened.loadAnnotations(first.id)).filter(isMeasureAnnotation);
        expect(found, name).toHaveLength(cases.length);
        for (const a of found) {
          const wanted = must(
            before.find((r) => r.subject === a.subject),
            String(a.subject),
          );
          const measurement = must(
            measurementOf({
              subtype: a.subtype,
              vertices: a.family === 'shape' ? a.vertices : [],
              extra: a.extra,
            }),
            String(a.subject),
          );
          expect(measurement.text, `${name} ${String(a.subject)}`).toBe(wanted.text);
          expect(Math.abs(measurement.value - wanted.value)).toBeLessThanOrEqual(0.1);
          // Inside the page's crop box, and carrying the appearance a reader will see.
          const crop = first.cropBox;
          expect(a.rect.x0, `${name} rect`).toBeGreaterThanOrEqual(crop.x0 - 1);
          expect(a.rect.x1, `${name} rect`).toBeLessThanOrEqual(crop.x1 + 1);
          expect(a.extra['hasAP'], `${name} appearance`).toBe(true);
        }
      } finally {
        await reopened.close();
      }
    },
    60_000,
  );

  it.each(files)('%s: the snapper has real geometry to work with', async (name) => {
    const eng = await engine();
    const doc = await eng.open(new Uint8Array(readFileSync(join(LOCAL, name))));
    try {
      const outlines = await eng.pageObjectPaths(doc, 0);
      const paths = outlines.flatMap((o) => o.subpaths).filter((p) => p.length >= 2);
      // Not every page has drawn paths on it — a scan is one image — so this is a soft claim:
      // whatever there is, snapping to it must land on a point of it rather than throw.
      if (paths.length === 0) return;
      const first = must(paths[0], 'a subpath');
      const vertex = must(first[0], 'a vertex');
      const found = snapAt({ x: vertex.x + 0.5, y: vertex.y + 0.5 }, paths, 4, {
        endpoints: true,
        midpoints: true,
        intersections: true,
        paths: true,
      });
      expect(found, name).not.toBeNull();
      expect(Number.isFinite(found?.point.x ?? Number.NaN), name).toBe(true);
      expect(Number.isFinite(found?.point.y ?? Number.NaN), name).toBe(true);
    } finally {
      await eng.close(doc);
    }
  });
});

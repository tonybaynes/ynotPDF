/**
 * M31 acceptance, at the model level and through the whole real pipeline: every shape, an ink
 * stroke, catalogue and custom stamps and a file attachment are created, the document is saved
 * through M21's planner, PDFium and `FullRewriteWriter`, reopened in PDFium, and compared field
 * by field. Then the file itself is inspected: every annotation has an appearance stream, and a
 * PNG stamp placed ten times is embedded **once** — counted by pdf-lib and by qpdf's `--json`,
 * as the brief asks.
 *
 * The engine's own contract for a stamp is checked here too: an appearance stream survives a
 * move and a resize, and goes when the colour changes.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PDFDict, PDFDocument, PDFName, PDFStream } from 'pdf-lib';
import { Document } from '@core/Document';
import {
  AddAnnotationCommand,
  DEFAULT_ANNOTATION_FLAGS,
  SetCustomCommand,
  draftAnnotation,
} from '@core/commands';
import type { ModelAnnotation } from '@core/model';
import type { ModelId } from '@core/Ids';
import { FullRewriteWriter } from '@engine/writers/FullRewriteWriter';
import { buildWritePlan, XOBJECTS_NAMESPACE } from '@modules/M21-save/plan';
import {
  inkRect,
  parseStampCatalogue,
  shapeRectFor,
  stampDrawing,
  stampForm,
  stampKey,
  stampRectAt,
  STAMP_KEY,
  STAMP_SIZE,
} from '@engine/appearance';
import { AttachFileCommand } from '@modules/M31-shapes-ink-stamps/commands';
import { quadOfRect } from '@modules/M31-shapes-ink-stamps/geometry';
import {
  AREA_HIGHLIGHT_INTENT,
  drawnByOverlay,
  isDrawing,
} from '@modules/M31-shapes-ink-stamps/overlay';
import { toBase64 } from '@modules/M31-shapes-ink-stamps/stampImport';
import { engine, fixture } from '../engine/helpers';
import { must } from '../find/helpers';
import { qpdf } from '../security/helpers';

const NOW = '2026-09-09T12:00:00.000Z';
const PNG = new Uint8Array(
  readFileSync(join(process.cwd(), 'test', 'fixtures', 'create', 'logo-alpha.png')),
);
const PNG_SIZE = { width: 120, height: 60 };

const catalogue = parseStampCatalogue(
  JSON.parse(readFileSync(join(process.cwd(), 'resources', 'stamps', 'catalogue.json'), 'utf8')),
);

const common = { flags: DEFAULT_ANNOTATION_FLAGS, author: 'A Reader', created: NOW, modified: NOW };

/** Every draft M31's tools make, as the service builds them. */
function drafts(doc: Document, pageId: ModelId): ModelAnnotation[] {
  const line = [
    { x: 72, y: 700 },
    { x: 300, y: 720 },
  ];
  const polygon = [
    { x: 320, y: 600 },
    { x: 420, y: 620 },
    { x: 400, y: 700 },
    { x: 330, y: 690 },
  ];
  const stroke = Array.from({ length: 30 }, (_v, i) => ({
    x: 72 + i * 6,
    y: 500 + Math.sin(i / 3) * 12,
  }));
  const arrowExtra = {
    lineEndings: ['None', 'ClosedArrow'],
    intent: 'LineArrow',
    dashArray: [4, 2],
  };
  const areaRect = { x0: 72, y0: 400, x1: 240, y1: 440 };
  return [
    draftAnnotation(doc, pageId, {
      subtype: 'Square',
      rect: { x0: 72, y0: 560, x1: 240, y1: 640 },
      color: 0x0b5cd6,
      interiorColor: 0xdcebff,
      borderWidth: 2,
      subject: 'Rectangle',
      ...common,
      extra: { cloudy: 1, dashArray: [3, 3] },
    } as never),
    draftAnnotation(doc, pageId, {
      subtype: 'Circle',
      rect: { x0: 260, y0: 560, x1: 360, y1: 640 },
      color: 0x007a87,
      borderWidth: 1,
      subject: 'Oval',
      ...common,
    } as never),
    draftAnnotation(doc, pageId, {
      subtype: 'Line',
      rect: shapeRectFor('Line', line, 2, arrowExtra),
      color: 0xc2185b,
      interiorColor: 0xc2185b,
      borderWidth: 2,
      paths: [line],
      subject: 'Arrow',
      ...common,
      extra: arrowExtra,
    } as never),
    draftAnnotation(doc, pageId, {
      subtype: 'Polygon',
      rect: shapeRectFor('Polygon', polygon, 1, { cloudy: 2 }),
      color: 0x5b2d91,
      borderWidth: 1,
      paths: [polygon],
      subject: 'Cloud',
      ...common,
      extra: { cloudy: 2, intent: 'PolygonCloud' },
    } as never),
    draftAnnotation(doc, pageId, {
      subtype: 'PolyLine',
      rect: shapeRectFor('PolyLine', polygon, 1, { lineEndings: ['Circle', 'Square'] }),
      color: 0x465063,
      borderWidth: 1,
      paths: [polygon],
      subject: 'Polyline',
      ...common,
      extra: { lineEndings: ['Circle', 'Square'] },
    } as never),
    draftAnnotation(doc, pageId, {
      subtype: 'Ink',
      rect: inkRect([stroke], 2, [[]]),
      color: 0xb35900,
      borderWidth: 2,
      paths: [stroke],
      subject: 'Pencil',
      ...common,
      extra: { pressures: [stroke.map((_p, i) => 0.3 + (i % 5) * 0.15)] },
    } as never),
    draftAnnotation(doc, pageId, {
      subtype: 'Highlight',
      rect: areaRect,
      color: 0xffe14d,
      quadPoints: quadOfRect(areaRect),
      subject: 'Area Highlight',
      ...common,
      extra: { intent: AREA_HIGHLIGHT_INTENT },
    } as never),
  ];
}

/** The comparable shape of one annotation — what "round-trips" means. */
function summary(a: ModelAnnotation): Record<string, unknown> {
  const r = (n: number): number => Math.round(n * 100) / 100;
  return {
    subtype: a.subtype,
    rect: [a.rect.x0, a.rect.y0, a.rect.x1, a.rect.y1].map(r),
    color: a.color,
    interiorColor: a.interiorColor,
    borderWidth: a.borderWidth,
    subject: a.subject,
    vertices: 'vertices' in a ? a.vertices.map((p) => [r(p.x), r(p.y)]) : [],
    paths: 'paths' in a ? a.paths.map((p) => p.length) : [],
    quadPoints: 'quadPoints' in a ? a.quadPoints.map(r) : [],
    lineEndings: a.extra['lineEndings'] ?? null,
    cloudy: a.extra['cloudy'] ?? null,
    dashArray: a.extra['dashArray'] ?? null,
    intent: a.extra['intent'] ?? null,
    icon: a.extra['icon'] ?? null,
  };
}

interface Made {
  bytes: Uint8Array;
  before: Record<string, unknown>[];
  warnings: string[];
  stampCount: number;
}

/** Opens `text.pdf`, adds everything, saves through the real pipeline. */
async function makeAnnotated(): Promise<Made> {
  const eng = await engine();
  const doc = await Document.open(eng, fixture('text.pdf'));
  const page = must(doc.state.pages[0], 'page');
  await doc.loadAnnotations(page.id);
  for (const draft of drafts(doc, page.id)) await doc.apply(new AddAnnotationCommand(doc, draft));

  // Two catalogue stamps of one kind: one picture.
  const approved = must(
    catalogue.stamps.find((s) => s.id === 'Approved'),
    'Approved',
  );
  const drawing = stampDrawing(approved.lines, approved.color);
  const key = stampKey(approved.id, approved.lines, approved.color);
  const form = stampForm(drawing);
  await doc.apply(
    new SetCustomCommand(doc, XOBJECTS_NAMESPACE, {
      [key]: { kind: 'form', content: form.content, bbox: form.bbox, resources: form.resources },
    }),
  );
  for (const [i, rotate] of [0, 30].entries()) {
    await doc.apply(
      new AddAnnotationCommand(
        doc,
        draftAnnotation(doc, page.id, {
          subtype: 'Stamp',
          rect: stampRectAt({ x: 150 + i * 220, y: 300 }, drawing, 0.8, rotate),
          subject: 'Approved',
          ...common,
          extra: {
            icon: 'Approved',
            [STAMP_KEY]: key,
            [STAMP_SIZE]: [drawing.width, drawing.height],
            rotate,
          },
        } as never),
      ),
    );
  }
  // Ten custom PNG stamps: one embedded picture.
  const imageKey = 'image:logo';
  await doc.apply(
    new SetCustomCommand(doc, XOBJECTS_NAMESPACE, {
      [imageKey]: { kind: 'image', format: 'png', data: toBase64(PNG), ...PNG_SIZE },
    }),
  );
  for (let i = 0; i < 10; i++) {
    await doc.apply(
      new AddAnnotationCommand(
        doc,
        draftAnnotation(doc, page.id, {
          subtype: 'Stamp',
          rect: stampRectAt(
            { x: 90 + (i % 5) * 100, y: 200 - Math.floor(i / 5) * 60 },
            PNG_SIZE,
            0.5,
            0,
          ),
          subject: 'Logo',
          ...common,
          extra: {
            icon: 'custom-logo',
            [STAMP_KEY]: imageKey,
            [STAMP_SIZE]: [PNG_SIZE.width, PNG_SIZE.height],
          },
        } as never),
      ),
    );
  }
  // A file pinned to the page.
  await doc.batch('Attach notes.txt', async () => {
    await doc.apply(
      new AttachFileCommand(doc, page.id, {
        name: 'notes.txt',
        bytes: new Uint8Array([104, 105]),
        description: 'notes',
        mimeType: 'text/plain',
      }),
    );
    await doc.apply(
      new AddAnnotationCommand(
        doc,
        draftAnnotation(doc, page.id, {
          subtype: 'FileAttachment',
          rect: { x0: 500, y0: 700, x1: 520, y1: 720 },
          color: 0x0b5cd6,
          contents: 'notes',
          subject: 'File Attachment',
          ...common,
          extra: { icon: 'Paperclip', attachmentName: 'notes.txt' },
        } as never),
      ),
    );
  });

  const before = doc.annotations(page.id).filter(isDrawing).map(summary);
  const stampCount = doc.annotations(page.id).filter((a) => a.family === 'stamp').length;
  const { plan, warnings } = buildWritePlan(doc);
  const base = await eng.save(doc.handle);
  await doc.close();
  const result = await new FullRewriteWriter().write({
    bytes: base,
    plan,
    options: { objectStreams: false },
  });
  return { bytes: result.bytes, before, warnings: [...warnings, ...result.warnings], stampCount };
}

let made: Promise<Made> | null = null;
const annotated = (): Promise<Made> => (made ??= makeAnnotated());

describe('every shape, stroke, stamp and attachment survives a save and a reopen', () => {
  it('the annotation list is equal, field for field, with nothing left in the overlay', async () => {
    const eng = await engine();
    const { bytes, before, warnings, stampCount } = await annotated();
    expect(warnings).toEqual([]);
    expect(stampCount).toBe(12);
    expect(before.length).toBe(7 + 12 + 1);

    const reopened = await Document.open(eng, bytes.slice());
    const page = must(reopened.state.pages[0], 'page');
    const list = await reopened.loadAnnotations(page.id);
    const after = list.filter(isDrawing).map(summary);
    await reopened.close();

    const key = (a: Record<string, unknown>): string => JSON.stringify(a);
    expect(after.map(key).sort()).toEqual(before.map(key).sort());
    // Every one of them came back with an appearance stream, so the raster draws them all.
    for (const a of list.filter(isDrawing)) {
      expect(a.extra['hasAP'], `${a.subtype} ${String(a.id)}`).toBe(true);
      expect(drawnByOverlay(a, new Set()), `${a.subtype} ${String(a.id)}`).toBe(false);
    }
  });

  it('every one of them carries an appearance stream, and a cloud is arcs', async () => {
    const { bytes } = await annotated();
    const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
    const annots = must(pdf.getPage(0).node.Annots(), 'annots');
    expect(annots.size()).toBe(7 + 12 + 1);
    for (let i = 0; i < annots.size(); i++) {
      const dict = pdf.context.lookupMaybe(annots.get(i), PDFDict);
      const subtype = dict?.get(PDFName.of('Subtype'))?.toString();
      const ap = dict?.lookupMaybe(PDFName.of('AP'), PDFDict);
      const n = ap ? pdf.context.lookupMaybe(ap.get(PDFName.of('N')), PDFStream) : undefined;
      expect(n, `${subtype ?? '?'} has no /AP /N`).toBeDefined();
    }
  });

  it('a PNG stamp placed ten times is embedded once — counted by pdf-lib and by qpdf', async () => {
    const { bytes } = await annotated();
    const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
    // A PNG's alpha becomes a soft mask, which is an image object of its own: the count is of
    // the images that are not some other image's mask — the pictures.
    let images = 0;
    let masks = 0;
    for (const [, object] of pdf.context.enumerateIndirectObjects()) {
      if (
        object instanceof PDFStream &&
        object.dict.get(PDFName.of('Subtype'))?.toString() === '/Image'
      ) {
        images++;
        if (object.dict.get(PDFName.of('SMask')) !== undefined) masks++;
      }
    }
    expect(images - masks).toBe(1);

    const run = await qpdf().run(['--json', 'in.pdf'], { 'in.pdf': bytes.slice() });
    expect(run.code, run.output.slice(0, 400)).toBeLessThanOrEqual(3);
    const json = run.output.slice(run.output.indexOf('{'));
    const parsed: unknown = JSON.parse(json);
    const text = JSON.stringify(parsed);
    // qpdf's JSON writes every dictionary entry as `"/Key": "/Name"`, so the image XObjects are
    // exactly the objects whose `/Subtype` is `/Image`, and the masks are the ones an `/SMask`
    // entry points at — the count the brief asks for is the difference.
    const imageObjects = (text.match(/"\/Subtype":\s*"\/Image"/g) ?? []).length;
    const maskRefs = (text.match(/"\/SMask":\s*"\d+ \d+ R"/g) ?? []).length;
    expect(imageObjects - maskRefs).toBe(1);
    expect(text).toContain('/Catalog');
  });

  it('the attached file is on the annotation, listed once, and no longer in the name tree', async () => {
    const eng = await engine();
    const { bytes } = await annotated();
    const reopened = await Document.open(eng, bytes.slice());
    const notes = reopened.state.attachments.filter((a) => a.name === 'notes.txt');
    expect(notes.length).toBe(1);
    expect(notes[0]?.pageId).toBe(reopened.state.pages[0]?.id);
    expect(notes[0]?.engineId.startsWith('annot.')).toBe(true);
    expect(notes[0]?.description).toBe('notes');
    expect(await eng.attachmentData(reopened.handle, must(notes[0], 'notes').engineId)).toEqual(
      new Uint8Array([104, 105]),
    );
    await reopened.close();
  });
});

describe('a stamp in the engine', () => {
  it('keeps its appearance through a move and a resize, and loses it when its colour changes', async () => {
    const eng = await engine();
    const handle = await eng.open(fixture('text.pdf'));
    const created = await eng.addAnnotation(handle, {
      page: 0,
      subtype: 'Stamp',
      rect: { x0: 100, y0: 100, x1: 200, y1: 150 },
      flags: DEFAULT_ANNOTATION_FLAGS,
    });
    await eng.setAnnotationAppearance(handle, created.id, '0 0 1 rg 100 100 100 50 re f');
    const withAp = (await eng.annotations(handle, 0)).find((a) => a.id === created.id);
    expect(withAp?.extra?.['hasAP']).toBe(true);

    const moved = await eng.updateAnnotation(handle, created.id, {
      rect: { x0: 150, y0: 150, x1: 350, y1: 250 },
      modified: NOW,
    });
    expect(moved.extra?.['hasAP']).toBe(true);
    expect(moved.rect).toEqual({ x0: 150, y0: 150, x1: 350, y1: 250 });

    const recoloured = await eng.updateAnnotation(handle, created.id, { color: 0xff0000 });
    expect(recoloured.extra?.['hasAP']).toBe(false);
    await eng.close(handle);
  });

  it('an ink keeps the rect it was given: PDFium never gets to inflate it', async () => {
    const eng = await engine();
    const handle = await eng.open(fixture('text.pdf'));
    const rect = { x0: 100, y0: 100, x1: 200, y1: 150 };
    const created = await eng.addAnnotation(handle, {
      page: 0,
      subtype: 'Ink',
      rect,
      flags: DEFAULT_ANNOTATION_FLAGS,
      color: 0,
      borderWidth: 6,
      paths: [
        [
          { x: 110, y: 110 },
          { x: 190, y: 140 },
        ],
      ],
    });
    expect(created.rect).toEqual(rect);
    expect(created.extra?.['hasAP']).toBe(true);
    // And again after an edit, which is where the inflation used to compound.
    const moved = await eng.updateAnnotation(handle, created.id, {
      rect: { x0: 0, y0: 0, x1: 100, y1: 50 },
      paths: [
        [
          { x: 10, y: 10 },
          { x: 90, y: 40 },
        ],
      ],
      borderWidth: 6,
    });
    expect(moved.rect).toEqual({ x0: 0, y0: 0, x1: 100, y1: 50 });
    expect(moved.extra?.['hasAP']).toBe(true);
    await eng.close(handle);
  });
});

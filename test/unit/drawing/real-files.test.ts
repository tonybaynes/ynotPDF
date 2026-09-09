/**
 * M31 against the operator's own PDFs (`test/fixtures/local/`, git-ignored).
 *
 * The synthetic fixtures are built to be easy; these are what the module is for — three boarding
 * passes from three different producers and a Foxit portfolio. Drawing on a real page is where a
 * wrong assumption about page boxes, `/Annots` or a producer's own appearance streams shows up:
 * every file gets a cloudy rectangle, an arrow, a pencil stroke, a catalogue stamp and a pinned
 * file on its first page, is saved through the whole real pipeline, and is reopened.
 *
 * Every test skips when the folder is empty, because CI and every other machine has no copy of it
 * (CLAUDE.md). Nothing here reads, prints or asserts anything about what the documents *say*: the
 * checks are about geometry and structure only.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Document } from '@core/Document';
import {
  AddAnnotationCommand,
  DEFAULT_ANNOTATION_FLAGS,
  SetCustomCommand,
  draftAnnotation,
} from '@core/commands';
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
import { isDrawing } from '@modules/M31-shapes-ink-stamps/overlay';
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
const catalogue = parseStampCatalogue(
  JSON.parse(readFileSync(join(process.cwd(), 'resources', 'stamps', 'catalogue.json'), 'utf8')),
);
const NOW = '2026-09-09T12:00:00.000Z';
const common = { flags: DEFAULT_ANNOTATION_FLAGS, author: 'A Reader', created: NOW, modified: NOW };

describe.skipIf(files.length === 0)('the drawing tools on the operator’s own files', () => {
  it.each(files)(
    '%s takes a rectangle, an arrow, a stroke, a stamp and a file, and gives them back',
    async (name) => {
      const eng = await engine();
      const doc = await Document.open(eng, new Uint8Array(readFileSync(join(LOCAL, name))));
      const page = must(doc.state.pages[0], 'page');
      const box = page.cropBox;
      const w = box.x1 - box.x0;
      const h = box.y1 - box.y0;
      // Everything sits well inside the page's own crop box, whatever its origin and size.
      const at = (fx: number, fy: number): { x: number; y: number } => ({
        x: box.x0 + fx * w,
        y: box.y0 + fy * h,
      });
      const originally = (await doc.loadAnnotations(page.id)).length;

      const line = [at(0.1, 0.8), at(0.4, 0.85)];
      const stroke = Array.from({ length: 24 }, (_v, i) => ({
        x: box.x0 + w * (0.1 + i * 0.015),
        y: box.y0 + h * (0.6 + Math.sin(i / 3) * 0.02),
      }));
      const arrowExtra = { lineEndings: ['None', 'OpenArrow'], intent: 'LineArrow' };
      const approved = must(
        catalogue.stamps.find((s) => s.id === 'Approved'),
        'Approved',
      );
      const drawing = stampDrawing(approved.lines, approved.color);
      const key = stampKey(approved.id, approved.lines, approved.color);
      const form = stampForm(drawing);

      const rectangle = draftAnnotation(doc, page.id, {
        subtype: 'Square',
        rect: { x0: at(0.1, 0.1).x, y0: at(0.1, 0.1).y, x1: at(0.4, 0.3).x, y1: at(0.4, 0.3).y },
        color: 0x0b5cd6,
        borderWidth: 2,
        subject: 'Rectangle',
        ...common,
        extra: { cloudy: 1 },
      } as never);
      const arrow = draftAnnotation(doc, page.id, {
        subtype: 'Line',
        rect: shapeRectFor('Line', line, 2, arrowExtra),
        color: 0xc2185b,
        borderWidth: 2,
        paths: [line],
        subject: 'Arrow',
        ...common,
        extra: arrowExtra,
      } as never);
      const ink = draftAnnotation(doc, page.id, {
        subtype: 'Ink',
        rect: inkRect([stroke], 2),
        color: 0xb35900,
        borderWidth: 2,
        paths: [stroke],
        subject: 'Pencil',
        ...common,
      } as never);
      const stamp = draftAnnotation(doc, page.id, {
        subtype: 'Stamp',
        rect: stampRectAt(at(0.6, 0.2), drawing, Math.min(1, (w * 0.3) / drawing.width), 15),
        subject: 'Approved',
        ...common,
        extra: {
          icon: 'Approved',
          [STAMP_KEY]: key,
          [STAMP_SIZE]: [drawing.width, drawing.height],
          rotate: 15,
        },
      } as never);
      const pin = draftAnnotation(doc, page.id, {
        subtype: 'FileAttachment',
        rect: {
          x0: at(0.8, 0.8).x,
          y0: at(0.8, 0.8).y,
          x1: at(0.8, 0.8).x + 20,
          y1: at(0.8, 0.8).y + 20,
        },
        color: 0x0b5cd6,
        contents: 'notes',
        subject: 'File Attachment',
        ...common,
        extra: { icon: 'PushPin', attachmentName: 'm31-notes.txt' },
      } as never);

      for (const draft of [rectangle, arrow, ink])
        await doc.apply(new AddAnnotationCommand(doc, draft));
      await doc.apply(
        new SetCustomCommand(doc, XOBJECTS_NAMESPACE, {
          [key]: {
            kind: 'form',
            content: form.content,
            bbox: form.bbox,
            resources: form.resources,
          },
        }),
      );
      await doc.apply(new AddAnnotationCommand(doc, stamp));
      await doc.batch('Attach', async () => {
        await doc.apply(
          new AttachFileCommand(doc, page.id, {
            name: 'm31-notes.txt',
            bytes: new Uint8Array([104, 105]),
          }),
        );
        await doc.apply(new AddAnnotationCommand(doc, pin));
      });
      expect(doc.annotations(page.id).length).toBe(originally + 5);

      const { plan, warnings } = buildWritePlan(doc);
      const base = await eng.save(doc.handle);
      await doc.close();
      const result = await new FullRewriteWriter().write({
        bytes: base,
        plan,
        options: { objectStreams: false },
      });
      expect([...warnings, ...result.warnings]).toEqual([]);

      const reopened = await Document.open(eng, result.bytes.slice());
      const back = await reopened.loadAnnotations(must(reopened.state.pages[0], 'page').id);
      const ours = back.filter(isDrawing);
      expect(ours.length).toBeGreaterThanOrEqual(5);
      for (const a of ours) {
        expect(a.extra['hasAP'], a.subtype).toBe(true);
        // Inside the page it was drawn on.
        expect(a.rect.x0).toBeGreaterThanOrEqual(box.x0 - 1);
        expect(a.rect.y0).toBeGreaterThanOrEqual(box.y0 - 1);
        expect(a.rect.x1).toBeLessThanOrEqual(box.x1 + 1);
        expect(a.rect.y1).toBeLessThanOrEqual(box.y1 + 1);
      }
      const arrowBack = must(
        ours.find((a) => a.subtype === 'Line'),
        'arrow',
      );
      expect(arrowBack.extra['lineEndings']).toEqual(['None', 'OpenArrow']);
      expect(
        must(
          ours.find((a) => a.subtype === 'Square'),
          'rectangle',
        ).extra['cloudy'],
      ).toBe(1);
      expect(
        must(
          ours.find((a) => a.subtype === 'Ink'),
          'ink',
        ).family === 'ink'
          ? 1
          : 0,
      ).toBe(1);
      const notes = reopened.state.attachments.filter((a) => a.name === 'm31-notes.txt');
      expect(notes.length).toBe(1);
      expect(notes[0]?.pageId).toBe(reopened.state.pages[0]?.id);
      await reopened.close();
    },
  );
});

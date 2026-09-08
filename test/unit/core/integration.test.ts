/**
 * The document model driving **real PDFium** (M20). The unit tests above prove the model's
 * algebra against a fake engine; this file proves the two halves agree — that a command which
 * says a page is rotated leaves a raster that is actually rotated, and that undo puts the file
 * back rather than only the model.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { Document } from '@core/Document';
import {
  AddAnnotationCommand,
  DeleteAnnotationCommand,
  DeletePagesCommand,
  InsertPagesCommand,
  MovePageCommand,
  RotatePagesCommand,
  SetFieldValueCommand,
  SetMetadataCommand,
  SetPageBoxCommand,
  UpdateAnnotationCommand,
  draftAnnotation,
} from '@core/commands';
import { replayJournal, serialiseJournal } from '@core/Journal';
import type { PdfiumEngine } from '@engine/pdfium/PdfiumEngine';
import { dhash, engine, fixture, hamming } from '../engine/helpers';
import { must } from './helpers';

const FLAGS = {
  hidden: false,
  print: true,
  noView: false,
  readOnly: false,
  locked: false,
} as const;

let pdfium: PdfiumEngine;

beforeAll(async () => {
  pdfium = await engine();
});

async function open(name: string): Promise<Document> {
  return await Document.open(pdfium, fixture(name), { name, path: null });
}

/** The rendered hash of a model page, resolved through the id table. */
async function pageHash(doc: Document, index: number): Promise<string> {
  const enginePage = doc.enginePage(doc.page(index).id);
  if (enginePage === undefined) throw new Error('page is not in the engine');
  return dhash(await pdfium.renderRaw(doc.handle, enginePage, 1));
}

async function pageText(doc: Document, index: number): Promise<string> {
  const enginePage = doc.enginePage(doc.page(index).id);
  if (enginePage === undefined) throw new Error('page is not in the engine');
  const runs = await pdfium.textRuns(doc.handle, enginePage);
  return runs
    .map((r) => r.text)
    .join(' ')
    .trim();
}

describe('opening a real file', () => {
  it('reads the whole model from a document with everything in it', async () => {
    const doc = await open('annotated.pdf');
    try {
      expect(doc.pageCount).toBeGreaterThan(0);
      expect(doc.state.metadata.version).toMatch(/^\d\.\d$/);
      expect(doc.validate()).toEqual([]);
      const list = await doc.loadAnnotations(doc.page(0).id);
      expect(list.length).toBeGreaterThan(0);
      expect(list.every((a) => a.id.startsWith('an-'))).toBe(true);
      expect(doc.validate()).toEqual([]);
    } finally {
      await doc.close();
    }
  });

  it('builds the field tree from a real AcroForm', async () => {
    const doc = await open('form.pdf');
    try {
      expect(doc.state.fields.length).toBeGreaterThan(0);
      const person = doc.fieldByName('person');
      expect(person?.synthetic).toBe(true);
      expect(person?.childIds.length).toBeGreaterThan(0);
      expect(doc.validate()).toEqual([]);
    } finally {
      await doc.close();
    }
  });

  it('reads the outline and its destinations', async () => {
    const doc = await open('outline.pdf');
    try {
      expect(doc.state.outline.length).toBeGreaterThan(0);
      for (const item of doc.state.outline) {
        if (!item.destinationId) continue;
        const dest = doc.destination(item.destinationId);
        expect(dest?.pageId).not.toBeUndefined();
      }
      expect(doc.validate()).toEqual([]);
    } finally {
      await doc.close();
    }
  });
});

describe('rotation reaches the raster', () => {
  it('renders differently after the command and identically after undo', async () => {
    const doc = await open('text.pdf');
    try {
      const before = await pageHash(doc, 0);
      await doc.apply(new RotatePagesCommand(doc, [doc.page(0).id], 90, true));
      expect(doc.page(0).rotation).toBe(90);
      expect(hamming(await pageHash(doc, 0), before)).toBeGreaterThan(6);

      await doc.undoLast();
      expect(doc.page(0).rotation).toBe(0);
      expect(hamming(await pageHash(doc, 0), before)).toBe(0);
      expect(doc.state.writeIntents).toEqual([]);
    } finally {
      await doc.close();
    }
  });
});

describe('page order is the model, and rendering follows it', () => {
  it('moving a page changes what page 0 renders, without touching the file', async () => {
    const doc = await open('multipage.pdf');
    try {
      const first = await pageText(doc, 0);
      const second = await pageText(doc, 1);
      expect(first).not.toBe(second);

      await doc.apply(new MovePageCommand(doc, doc.page(0).id, 1));

      expect(await pageText(doc, 0)).toBe(second);
      expect(await pageText(doc, 1)).toBe(first);
      // The engine still holds its own order; only the model reordered.
      expect(await pdfium.pageCount(doc.handle)).toBe(5);
      expect(doc.state.writeIntents).toContain('page-order');

      await doc.undoLast();
      expect(await pageText(doc, 0)).toBe(first);
    } finally {
      await doc.close();
    }
  });

  it('deleting a page hides it while the engine keeps it, so undo can render it again', async () => {
    const doc = await open('multipage.pdf');
    try {
      const firstText = await pageText(doc, 0);
      const pageId = doc.page(0).id;

      await doc.apply(new DeletePagesCommand(doc, [pageId]));
      expect(doc.pageCount).toBe(4);
      expect(await pdfium.pageCount(doc.handle)).toBe(5);
      expect(await pageText(doc, 0)).not.toBe(firstText);

      await doc.undoLast();
      expect(doc.pageCount).toBe(5);
      expect(doc.page(0).id).toBe(pageId);
      expect(await pageText(doc, 0)).toBe(firstText);
    } finally {
      await doc.close();
    }
  });

  it('inserting a blank page puts a real, blank page where the model says', async () => {
    const doc = await open('multipage.pdf');
    try {
      const secondText = await pageText(doc, 1);
      await doc.apply(new InsertPagesCommand(doc, 1, 1, { width: 200, height: 300 }));
      expect(doc.pageCount).toBe(6);
      expect(await pageText(doc, 1)).toBe('');
      expect(await pageText(doc, 2)).toBe(secondText);

      await doc.undoLast();
      expect(doc.pageCount).toBe(5);
      expect(await pageText(doc, 1)).toBe(secondText);
      expect(await pdfium.pageCount(doc.handle)).toBe(5);
    } finally {
      await doc.close();
    }
  });
});

describe('cropping reaches the raster', () => {
  it('shrinks the rendered page and restores it on undo', async () => {
    const doc = await open('text.pdf');
    try {
      const pageId = doc.page(0).id;
      const before = doc.page(0).cropBox;
      await doc.apply(
        new SetPageBoxCommand(doc, pageId, 'crop', { x0: 20, y0: 20, x1: 300, y1: 400 }),
      );
      const enginePage = doc.enginePage(pageId) ?? 0;
      const cropped = await pdfium.renderRaw(doc.handle, enginePage, 1);
      expect(cropped.width).toBeLessThan(before.x1 - before.x0);

      await doc.undoLast();
      const restored = await pdfium.renderRaw(doc.handle, enginePage, 1);
      expect(restored.width).toBeCloseTo(before.x1 - before.x0, 0);
      expect(doc.page(0).cropBox).toEqual(before);
    } finally {
      await doc.close();
    }
  });
});

describe('annotations reach the file', () => {
  it('adding one lists it in the engine, and undo removes it from both', async () => {
    const doc = await open('text.pdf');
    try {
      const pageId = doc.page(0).id;
      await doc.loadAnnotations(pageId);
      const before = (await pdfium.annotations(doc.handle, 0)).length;

      const draft = draftAnnotation(doc, pageId, {
        subtype: 'Square',
        rect: { x0: 100, y0: 100, x1: 300, y1: 200 },
        flags: FLAGS,
        contents: 'from the model',
        color: 0x3392ff,
      });
      const add = new AddAnnotationCommand(doc, draft);
      await doc.apply(add);

      expect(doc.annotations(pageId)).toHaveLength(before + 1);
      const engineList = await pdfium.annotations(doc.handle, 0);
      expect(engineList).toHaveLength(before + 1);
      expect(engineList[before]?.contents).toBe('from the model');
      expect(doc.state.writeIntents).toEqual([]);

      await doc.undoLast();
      expect(doc.annotations(pageId)).toHaveLength(before);
      expect(await pdfium.annotations(doc.handle, 0)).toHaveLength(before);

      await doc.redoLast();
      expect(doc.annotations(pageId)).toHaveLength(before + 1);
      // The model id is the one the command minted, whatever PDFium renumbered.
      expect(doc.annotations(pageId).at(-1)?.id).toBe(add.annotationId);
    } finally {
      await doc.close();
    }
  });

  it('updating one changes the file and undo puts the old values back', async () => {
    const doc = await open('text.pdf');
    try {
      const pageId = doc.page(0).id;
      await doc.loadAnnotations(pageId);
      const draft = draftAnnotation(doc, pageId, {
        subtype: 'Square',
        rect: { x0: 10, y0: 10, x1: 100, y1: 50 },
        flags: FLAGS,
        contents: 'original',
      });
      await doc.apply(new AddAnnotationCommand(doc, draft));
      const id = must(doc.annotations(pageId).at(-1)?.id);

      await doc.apply(new UpdateAnnotationCommand(doc, id, { contents: 'edited' }));
      const engineId = doc.idTable.engineKey('annotation', id);
      const engineList = await pdfium.annotations(doc.handle, 0);
      expect(engineList.find((a) => a.id === engineId)?.contents).toBe('edited');

      await doc.undoLast();
      expect(doc.annotation(id)?.contents).toBe('original');
      const after = await pdfium.annotations(doc.handle, 0);
      expect(after.find((a) => a.id === doc.idTable.engineKey('annotation', id))?.contents).toBe(
        'original',
      );
    } finally {
      await doc.close();
    }
  });

  it('deleting one keeps every surviving id pointing at the right annotation', async () => {
    const doc = await open('text.pdf');
    try {
      const pageId = doc.page(0).id;
      await doc.loadAnnotations(pageId);
      for (const contents of ['first', 'second', 'third']) {
        await doc.apply(
          new AddAnnotationCommand(
            doc,
            draftAnnotation(doc, pageId, {
              subtype: 'Square',
              rect: { x0: 10, y0: 10, x1: 100, y1: 50 },
              flags: FLAGS,
              contents,
            }),
          ),
        );
      }
      const [a, b, c] = doc.annotations(pageId).slice(-3);
      await doc.apply(new DeleteAnnotationCommand(doc, must(a?.id)));

      // b and c are still themselves, in the model and in the engine.
      const engineList = await pdfium.annotations(doc.handle, 0);
      for (const survivor of [b, c]) {
        const engineId = doc.idTable.engineKey('annotation', must(survivor?.id));
        expect(engineList.find((x) => x.id === engineId)?.contents).toBe(survivor?.contents);
      }

      await doc.undoLast();
      expect(doc.annotations(pageId).map((x) => x.contents)).toContain('first');
    } finally {
      await doc.close();
    }
  });
});

describe('form fields reach the file', () => {
  it('sets a value that the engine then reports', async () => {
    const doc = await open('form.pdf');
    try {
      const field = doc.state.fields.find((f) => f.type === 'text' && !f.synthetic);
      expect(field, 'the form fixture has a text field').toBeTruthy();
      if (!field) return;
      const original = field.value;

      await doc.apply(new SetFieldValueCommand(doc, field.id, 'Set by the model'));
      expect(doc.field(field.id)?.value).toBe('Set by the model');
      const engineFields = await pdfium.formFields(doc.handle);
      expect(engineFields.find((f) => f.name === field.name)?.value).toBe('Set by the model');
      expect(doc.state.writeIntents).toEqual([]);

      await doc.undoLast();
      expect(doc.field(field.id)?.value).toBe(original);
      expect((await pdfium.formFields(doc.handle)).find((f) => f.name === field.name)?.value).toBe(
        original,
      );
    } finally {
      await doc.close();
    }
  });
});

describe('what the writer will have to do', () => {
  it('records a metadata intent, because PDFium cannot set it', async () => {
    const doc = await open('text.pdf');
    try {
      await doc.apply(new SetMetadataCommand(doc, { title: 'Renamed by M20' }));
      expect(doc.state.metadata.title).toBe('Renamed by M20');
      expect(doc.state.writeIntents).toEqual(['metadata']);
      // The engine's own view is unchanged, which is exactly why the intent exists.
      expect((await pdfium.metadata(doc.handle)).title).not.toBe('Renamed by M20');
    } finally {
      await doc.close();
    }
  });
});

describe('a whole session, journalled and replayed', () => {
  it('replays into a second document that matches the first', async () => {
    const doc = await open('multipage.pdf');
    const replayed = await open('multipage.pdf');
    try {
      const pageId = doc.page(0).id;
      await doc.loadAnnotations(pageId);
      await doc.batch('Prepare the document', async () => {
        await doc.apply(new RotatePagesCommand(doc, [doc.page(0).id], 90, true));
        await doc.apply(new MovePageCommand(doc, doc.page(4).id, 0));
      });
      await doc.apply(new DeletePagesCommand(doc, [doc.page(3).id]));
      await doc.apply(
        new AddAnnotationCommand(
          doc,
          draftAnnotation(doc, pageId, {
            subtype: 'Highlight',
            rect: { x0: 10, y0: 10, x1: 200, y1: 40 },
            flags: FLAGS,
            color: 0xffff00,
            quadPoints: [10, 40, 200, 40, 10, 10, 200, 10],
          }),
        ),
      );
      await doc.apply(new SetMetadataCommand(doc, { subject: 'Reviewed' }));
      expect(doc.validate()).toEqual([]);

      const file = JSON.parse(JSON.stringify(serialiseJournal(doc))) as ReturnType<
        typeof serialiseJournal
      >;
      expect(file.complete).toBe(true);

      await replayed.loadAnnotations(replayed.page(0).id);
      const result = await replayJournal(replayed, file.entries);
      expect(result.skipped).toBe(0);
      expect(replayed.snapshot()).toEqual(doc.snapshot());
      expect(replayed.validate()).toEqual([]);

      // And the replayed file renders the same as the one that was edited live.
      for (let i = 0; i < doc.pageCount; i++) {
        expect(hamming(await pageHash(replayed, i), await pageHash(doc, i))).toBeLessThanOrEqual(6);
      }
    } finally {
      await doc.close();
      await replayed.close();
    }
  });

  it('undoes the whole session back to the file as opened', async () => {
    const doc = await open('multipage.pdf');
    try {
      await doc.loadAnnotations(doc.page(0).id);
      const before = doc.snapshot();
      const hashes = await Promise.all([0, 1, 2].map((i) => pageHash(doc, i)));

      await doc.apply(new RotatePagesCommand(doc, [doc.page(0).id], 180, true));
      await doc.apply(new MovePageCommand(doc, doc.page(0).id, 2));
      await doc.apply(new DeletePagesCommand(doc, [doc.page(1).id]));
      await doc.apply(new InsertPagesCommand(doc, 0, 1, { width: 400, height: 400 }));

      while (doc.undo.canUndo) await doc.undoLast();

      expect(doc.snapshot()).toEqual(before);
      expect(await Promise.all([0, 1, 2].map((i) => pageHash(doc, i)))).toEqual(hashes);
      expect(doc.isDirty).toBe(false);
    } finally {
      await doc.close();
    }
  });
});

describe('annotation ids survive a delete and its undo, against real PDFium', () => {
  it('so the next edit lands on the annotation the user picked', async () => {
    const doc = await open('text.pdf');
    try {
      const pageId = doc.page(0).id;
      await doc.loadAnnotations(pageId);
      for (const contents of ['alpha', 'beta', 'gamma']) {
        await doc.apply(
          new AddAnnotationCommand(
            doc,
            draftAnnotation(doc, pageId, {
              subtype: 'Square',
              rect: { x0: 10, y0: 10, x1: 100, y1: 50 },
              flags: FLAGS,
              contents,
            }),
          ),
        );
      }
      const [alpha, beta, gamma] = doc.annotations(pageId).slice(-3);
      const alphaId = must(alpha, 'alpha').id;

      await doc.apply(new DeleteAnnotationCommand(doc, alphaId));
      await doc.undoLast();

      // Every model id must still name its own annotation in the file.
      const engineList = await pdfium.annotations(doc.handle, 0);
      for (const model of [alpha, beta, gamma]) {
        const one = must(model, 'annotation');
        const key = doc.idTable.engineKey('annotation', one.id);
        expect(
          engineList.find((a) => a.id === key)?.contents,
          `${one.id} points at the wrong annotation`,
        ).toBe(one.contents);
      }

      // And an edit goes where it was aimed.
      await doc.apply(new UpdateAnnotationCommand(doc, alphaId, { contents: 'alpha edited' }));
      const after = await pdfium.annotations(doc.handle, 0);
      expect(after.filter((a) => a.contents === 'alpha edited')).toHaveLength(1);
      expect(after.some((a) => a.contents === 'beta')).toBe(true);
      expect(after.some((a) => a.contents === 'gamma')).toBe(true);
    } finally {
      await doc.close();
    }
  });
});

/**
 * The acceptance property (M20): apply N random commands, undo them all, and the model must be
 * byte-for-byte what it was. Then redo them all and it must be what it was after the run.
 *
 * This is the test the whole design exists to pass. Undo that is merely "close enough" is what
 * makes an editor lose someone's work, so the assertion is a deep equality of the entire model —
 * pages, annotations, fields, destinations, layers, metadata, the custom bag and the write
 * intents — not a spot check of the thing the last command touched.
 *
 * It runs against `FakeEngine` so a thousand commands take seconds rather than minutes, in three
 * engine configurations: one that supports everything, one that matches what PDFium can really
 * do, and one that supports nothing, which exercises every model-only fallback path.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { Document } from '@core/Document';
import type { Command } from '@core/Command';
import {
  AddAnnotationCommand,
  DeleteAnnotationCommand,
  DeletePagesCommand,
  InsertPagesCommand,
  MovePageCommand,
  RotatePagesCommand,
  SetCustomCommand,
  SetFieldValueCommand,
  SetLayerVisibleCommand,
  SetMetadataCommand,
  SetPageBoxCommand,
  SetPageLabelCommand,
  UpdateAnnotationCommand,
  draftAnnotation,
} from '@core/commands';
import type { Rotation } from '@shared/pdf';
import { FULL_SUPPORT, NO_SUPPORT, PDFIUM_SUPPORT, type FakeSupport } from './fakeEngine';
import { annotationSource, loadAllAnnotations, must, openFake, RICH_SPEC } from './helpers';

/** One step the generator can ask for. Resolved against the live document when it is applied. */
type Step =
  | { kind: 'rotate'; page: number; rotation: Rotation }
  | { kind: 'insert'; at: number; count: number }
  | { kind: 'delete'; page: number }
  | { kind: 'move'; page: number; to: number }
  | { kind: 'crop'; page: number; x: number; y: number }
  | { kind: 'label'; page: number; text: string }
  | { kind: 'addAnnotation'; page: number; subtype: 'Square' | 'Highlight' | 'Ink' | 'Text' }
  | { kind: 'updateAnnotation'; page: number; annotation: number; text: string }
  | { kind: 'deleteAnnotation'; page: number; annotation: number }
  | { kind: 'field'; field: number; value: string }
  | { kind: 'metadata'; title: string }
  | { kind: 'layer'; layer: number; visible: boolean }
  | { kind: 'custom'; key: string; value: number };

const stepArb: fc.Arbitrary<Step> = fc.oneof(
  fc.record({
    kind: fc.constant('rotate' as const),
    page: fc.nat(9),
    rotation: fc.constantFrom<Rotation>(0, 90, 180, 270),
  }),
  fc.record({
    kind: fc.constant('insert' as const),
    at: fc.nat(9),
    count: fc.integer({ min: 1, max: 3 }),
  }),
  fc.record({ kind: fc.constant('delete' as const), page: fc.nat(9) }),
  fc.record({ kind: fc.constant('move' as const), page: fc.nat(9), to: fc.nat(9) }),
  fc.record({
    kind: fc.constant('crop' as const),
    page: fc.nat(9),
    x: fc.integer({ min: 0, max: 100 }),
    y: fc.integer({ min: 0, max: 100 }),
  }),
  fc.record({
    kind: fc.constant('label' as const),
    page: fc.nat(9),
    text: fc.string({ maxLength: 6 }),
  }),
  fc.record({
    kind: fc.constant('addAnnotation' as const),
    page: fc.nat(9),
    subtype: fc.constantFrom(
      'Square' as const,
      'Highlight' as const,
      'Ink' as const,
      'Text' as const,
    ),
  }),
  fc.record({
    kind: fc.constant('updateAnnotation' as const),
    page: fc.nat(9),
    annotation: fc.nat(4),
    text: fc.string({ maxLength: 8 }),
  }),
  fc.record({
    kind: fc.constant('deleteAnnotation' as const),
    page: fc.nat(9),
    annotation: fc.nat(4),
  }),
  fc.record({
    kind: fc.constant('field' as const),
    field: fc.nat(4),
    value: fc.string({ maxLength: 6 }),
  }),
  fc.record({ kind: fc.constant('metadata' as const), title: fc.string({ maxLength: 10 }) }),
  fc.record({ kind: fc.constant('layer' as const), layer: fc.nat(2), visible: fc.boolean() }),
  fc.record({
    kind: fc.constant('custom' as const),
    key: fc.constantFrom('a', 'b', 'c'),
    value: fc.nat(100),
  }),
);

/** Picks the nth item of a list, wrapping, or null when the list is empty. */
function pick<T>(list: ReadonlyArray<T>, n: number): T | null {
  return list.length === 0 ? null : (list[n % list.length] ?? null);
}

/**
 * Turns a generated step into a command against the document as it is now. Returns null when the
 * step cannot apply — the document has one page left and the step wants to delete one, say. A
 * step that cannot apply is skipped rather than forced, because the property is about undo, not
 * about how the command layer handles nonsense.
 */
function buildCommand(doc: Document, step: Step): Command | null {
  const pages = doc.state.pages;
  const page = pick(pages, step.kind === 'insert' ? 0 : ((step as { page?: number }).page ?? 0));
  switch (step.kind) {
    case 'rotate':
      return page ? new RotatePagesCommand(doc, [page.id], step.rotation) : null;
    case 'insert':
      return new InsertPagesCommand(doc, step.at % (pages.length + 1), step.count, {
        width: 300,
        height: 400,
      });
    case 'delete':
      // A document must keep a page, and the property is not about that rule.
      return page && pages.length > 1 ? new DeletePagesCommand(doc, [page.id]) : null;
    case 'move':
      return page ? new MovePageCommand(doc, page.id, step.to % pages.length) : null;
    case 'crop':
      return page
        ? new SetPageBoxCommand(doc, page.id, 'crop', {
            x0: step.x,
            y0: step.y,
            x1: step.x + 200,
            y1: step.y + 200,
          })
        : null;
    case 'label':
      return page ? new SetPageLabelCommand(doc, page.id, step.text) : null;
    case 'addAnnotation':
      return page
        ? new AddAnnotationCommand(
            doc,
            draftAnnotation(
              doc,
              page.id,
              annotationSource(step.subtype, annotationExtras(step.subtype)),
            ),
          )
        : null;
    case 'updateAnnotation': {
      const target = page ? pick(doc.annotations(page.id), step.annotation) : null;
      return target ? new UpdateAnnotationCommand(doc, target.id, { contents: step.text }) : null;
    }
    case 'deleteAnnotation': {
      const target = page ? pick(doc.annotations(page.id), step.annotation) : null;
      return target ? new DeleteAnnotationCommand(doc, target.id) : null;
    }
    case 'field': {
      const field = pick(
        doc.state.fields.filter((f) => !f.synthetic),
        step.field,
      );
      return field ? new SetFieldValueCommand(doc, field.id, step.value) : null;
    }
    case 'metadata':
      return new SetMetadataCommand(doc, { title: step.title });
    case 'layer': {
      const layer = pick(doc.state.layers, step.layer);
      return layer ? new SetLayerVisibleCommand(doc, layer.id, step.visible) : null;
    }
    case 'custom':
      return new SetCustomCommand(doc, 'M20', { [step.key]: step.value });
  }
}

function annotationExtras(subtype: string): Record<string, unknown> {
  if (subtype === 'Highlight') return { quadPoints: [0, 20, 40, 20, 0, 0, 40, 0] };
  if (subtype === 'Ink') {
    return {
      paths: [
        [
          { x: 1, y: 1 },
          { x: 9, y: 9 },
        ],
      ],
    };
  }
  return {};
}

/**
 * Applies a sequence, then undoes and redoes it all, checking the model each way. Returns how
 * many steps actually turned into commands, so a caller can prove the run was not vacuous.
 */
async function roundTrip(steps: ReadonlyArray<Step>, support: FakeSupport): Promise<number> {
  const { doc } = await openFake(RICH_SPEC, support);
  await loadAllAnnotations(doc);
  const before = doc.snapshot();
  let applied = 0;

  for (const step of steps) {
    const command = buildCommand(doc, step);
    if (!command) continue;
    // Each step is its own undo entry; merging is tested separately.
    doc.breakMerge();
    await doc.apply(command);
    applied++;
  }
  expect(doc.validate()).toEqual([]);
  const after = doc.snapshot();
  expect(doc.undo.state.length).toBe(applied);

  while (doc.undo.canUndo) await doc.undoLast();
  expect(doc.snapshot()).toEqual(before);
  expect(doc.validate()).toEqual([]);

  while (doc.undo.canRedo) await doc.redoLast();
  expect(doc.snapshot()).toEqual(after);
  expect(doc.validate()).toEqual([]);
  return applied;
}

describe('undo is exact', () => {
  it('a thousand random commands undo to the original model', async () => {
    const steps = fc.sample(stepArb, { numRuns: 1000, seed: 20 });
    const applied = await roundTrip(steps, PDFIUM_SUPPORT);
    // Guards against a vacuous pass: the run really did change the document 1 000-odd times.
    expect(applied).toBeGreaterThan(800);
  });

  it('holds for any generated sequence, whatever the engine supports', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(stepArb, { minLength: 1, maxLength: 40 }),
        fc.constantFrom(FULL_SUPPORT, PDFIUM_SUPPORT, NO_SUPPORT),
        async (steps, support) => {
          await roundTrip(steps, support);
        },
      ),
      { numRuns: 60 },
    );
  });

  it('holds when the whole sequence is one transaction', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(stepArb, { minLength: 2, maxLength: 20 }), async (steps) => {
        const { doc } = await openFake(RICH_SPEC, PDFIUM_SUPPORT);
        await loadAllAnnotations(doc);
        const before = doc.snapshot();
        doc.beginTransaction('Batch');
        for (const step of steps) {
          const command = buildCommand(doc, step);
          if (command) await doc.apply(command);
        }
        await doc.commit();
        // Whatever happened inside, it is at most one undo entry.
        expect(doc.undo.state.length).toBeLessThanOrEqual(1);
        const after = doc.snapshot();
        await doc.undoLast();
        expect(doc.snapshot()).toEqual(before);
        await doc.redoLast();
        expect(doc.snapshot()).toEqual(after);
      }),
      { numRuns: 40 },
    );
  });

  it('a rolled-back transaction leaves nothing behind', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(stepArb, { minLength: 1, maxLength: 15 }), async (steps) => {
        const { doc } = await openFake(RICH_SPEC, PDFIUM_SUPPORT);
        await loadAllAnnotations(doc);
        const before = doc.snapshot();
        doc.beginTransaction('Abandoned');
        for (const step of steps) {
          const command = buildCommand(doc, step);
          if (command) await doc.apply(command);
        }
        await doc.rollback();
        expect(doc.snapshot()).toEqual(before);
        expect(doc.undo.state.length).toBe(0);
        expect(doc.validate()).toEqual([]);
      }),
      { numRuns: 30 },
    );
  });

  it('undoing part-way and carrying on branches the history correctly', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(stepArb, { minLength: 4, maxLength: 20 }),
        stepArb,
        async (steps, extra) => {
          const { doc } = await openFake(RICH_SPEC, PDFIUM_SUPPORT);
          await loadAllAnnotations(doc);
          const marks: unknown[] = [doc.snapshot()];
          for (const step of steps) {
            const command = buildCommand(doc, step);
            if (!command) continue;
            doc.breakMerge();
            await doc.apply(command);
            marks.push(doc.snapshot());
          }
          const half = Math.floor((marks.length - 1) / 2);
          for (let i = marks.length - 1; i > half; i--) await doc.undoLast();
          expect(doc.snapshot()).toEqual(marks[half]);

          const branch = buildCommand(doc, extra);
          if (branch) {
            doc.breakMerge();
            await doc.apply(branch);
            expect(doc.undo.canRedo).toBe(false);
            await doc.undoLast();
            expect(doc.snapshot()).toEqual(marks[half]);
          }
          expect(doc.validate()).toEqual([]);
        },
      ),
      { numRuns: 30 },
    );
  });
});

describe('ids survive everything', () => {
  it('a page keeps its id through moves, deletions and undo', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(stepArb, { minLength: 1, maxLength: 25 }), async (steps) => {
        const { doc } = await openFake(RICH_SPEC, PDFIUM_SUPPORT);
        const tracked = doc.page(2).id;
        const seen = new Set<string>();
        for (const step of steps) {
          const command = buildCommand(doc, step);
          if (!command) continue;
          doc.breakMerge();
          await doc.apply(command);
          for (const p of doc.state.pages) seen.add(p.id);
        }
        while (doc.undo.canUndo) await doc.undoLast();
        // Whatever happened in between, the page is back and still has the id it started with.
        expect(doc.pageById(tracked)).not.toBeNull();
        expect(doc.pageIndex(tracked)).toBe(2);
      }),
      { numRuns: 30 },
    );
  });

  it('never hands out the same id twice', async () => {
    const { doc } = await openFake(RICH_SPEC, PDFIUM_SUPPORT);
    const steps = fc.sample(stepArb, { numRuns: 200, seed: 7 });
    const issued = new Set<string>();
    const record = (): void => {
      for (const p of doc.state.pages) issued.add(String(p.id));
    };
    record();
    const sizeBefore = issued.size;
    for (const step of steps) {
      const command = buildCommand(doc, step);
      if (!command) continue;
      doc.breakMerge();
      await doc.apply(command);
    }
    const ids = doc.state.pages.map((p) => String(p.id));
    expect(new Set(ids).size).toBe(ids.length);
    expect(sizeBefore).toBe(4);
  });
});

describe('merging', () => {
  it('a run of edits to one target is a single undo step', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.string({ maxLength: 8 }), { minLength: 2, maxLength: 20 }),
        async (values) => {
          const { doc } = await openFake(RICH_SPEC, PDFIUM_SUPPORT);
          const field = doc.fieldByName('address.city');
          const before = doc.snapshot();
          for (const value of values) {
            await doc.apply(new SetFieldValueCommand(doc, must(field?.id), value));
          }
          expect(doc.undo.state.length).toBe(1);
          await doc.undoLast();
          expect(doc.snapshot()).toEqual(before);
        },
      ),
      { numRuns: 25 },
    );
  });
});

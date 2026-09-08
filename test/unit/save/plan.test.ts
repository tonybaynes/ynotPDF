/**
 * The write plan (M21).
 *
 * The property that matters is **sparseness**: a plan says only what the engine could not do, so
 * what it does not mention the writer does not touch. Every test here is a variation on "make one
 * kind of change and check that exactly one section of the plan filled in".
 *
 * `FakeEngine` (M20's) rather than PDFium: the plan is a pure function of the model, and the
 * fake's `supports` flags let a mutation be turned off so the fallback path is exercised too.
 */

import { describe, expect, it } from 'vitest';
import type { Document } from '@core/Document';
import type { ModelField } from '@core/model';
import {
  AddAnnotationCommand,
  DeletePagesCommand,
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
import { planIsEmpty } from '@engine/Writer';
import { buildWritePlan, toAppearanceInput, touchedEntities } from '@modules/M21-save/plan';
import { AddOutlineItemCommand } from '@modules/M21-save/commands';
import type { FakeSupport } from '../core/fakeEngine';
import { annotationSource, must, openFake } from '../core/helpers';

/**
 * The M20 fixture: four pages, annotations, a form, an outline, layers and a signature.
 *
 * The two mutations turned off here are the two PDFium genuinely cannot do — there is no
 * information-dictionary setter, and layer visibility is a per-object rendering concern — so
 * this is the fake configured to behave like the engine that actually ships.
 */
async function richDocument(support: Partial<FakeSupport> = {}): Promise<Document> {
  const { doc } = await openFake(undefined, {
    setMetadata: false,
    setLayerVisible: false,
    ...support,
  });
  return doc;
}

/** A leaf text field — the fixture's top-level `address` node is a parent, not a field. */
function textField(doc: Document): ModelField {
  return must(
    doc.state.fields.find((f) => f.type === 'text' && f.widgets.length > 0),
    'text field',
  );
}

describe('a document nobody has touched', () => {
  it('plans nothing at all', async () => {
    const doc = await richDocument();
    const { plan, warnings } = buildWritePlan(doc);
    expect(warnings).toEqual([]);
    expect(planIsEmpty(plan)).toBe(true);
    expect(plan.pagesUnchanged).toBe(true);
    expect(plan.labels).toBe(false);
    expect(plan.metadata).toBeNull();
    expect(plan.outline).toBeNull();
    expect(plan.layers).toBeNull();
    expect(plan.fields).toBeNull();
    // Every page is named, in order, pointing at itself.
    expect(plan.pages.map((p) => p.source)).toEqual([0, 1, 2, 3]);
    await doc.close();
  });

  it('still carries the metadata as a fallback, for a file whose /Info was lost', async () => {
    const doc = await richDocument();
    const { plan } = buildWritePlan(doc);
    expect(plan.metadataFallback).not.toBeNull();
    expect(plan.metadataFallback?.title).toBe(doc.state.metadata.title);
    // A fallback is not work: it applies only to a base that has no information dictionary.
    expect(planIsEmpty(plan)).toBe(true);
    await doc.close();
  });
});

describe('one change fills in one section', () => {
  it('a rotation the engine took plans nothing', async () => {
    const doc = await richDocument();
    await doc.apply(new RotatePagesCommand(doc, [doc.page(0).id], 90, true));
    expect(doc.state.writeIntents).toEqual([]);
    expect(planIsEmpty(buildWritePlan(doc).plan)).toBe(true);
    await doc.close();
  });

  it('moving a page turns off pagesUnchanged and nothing else', async () => {
    const doc = await richDocument();
    await doc.apply(new MovePageCommand(doc, doc.page(3).id, 0));
    const { plan } = buildWritePlan(doc);
    expect(plan.pagesUnchanged).toBe(false);
    expect(plan.pages.map((p) => p.source)).toEqual([3, 0, 1, 2]);
    expect(plan.labels).toBe(false);
    expect(plan.metadata).toBeNull();
    await doc.close();
  });

  it('deleting a page leaves it out of the plan', async () => {
    const doc = await richDocument();
    await doc.apply(new DeletePagesCommand(doc, [doc.page(1).id]));
    const { plan } = buildWritePlan(doc);
    expect(plan.pagesUnchanged).toBe(false);
    expect(plan.pages.map((p) => p.source)).toEqual([0, 2, 3]);
    await doc.close();
  });

  it('renaming a page asks for labels — for every page, so the tree is complete', async () => {
    const doc = await richDocument();
    await doc.apply(new SetPageLabelCommand(doc, doc.page(0).id, 'Cover'));
    const { plan } = buildWritePlan(doc);
    expect(plan.labels).toBe(true);
    expect(plan.pages.map((p) => p.label)).toEqual(['Cover', 'ii', '1', '2']);
    expect(plan.pagesUnchanged).toBe(true);
    await doc.close();
  });

  it('a bleed box the engine cannot set is planned; a crop box the engine took is not', async () => {
    const doc = await richDocument();
    const pageId = doc.page(0).id;
    await doc.apply(new SetPageBoxCommand(doc, pageId, 'crop', { x0: 0, y0: 0, x1: 100, y1: 100 }));
    expect(buildWritePlan(doc).plan.pages[0]?.boxes).toBeUndefined();

    await doc.apply(new SetPageBoxCommand(doc, pageId, 'bleed', { x0: 1, y0: 2, x1: 90, y1: 95 }));
    const { plan } = buildWritePlan(doc);
    expect(plan.pages[0]?.boxes).toEqual({ bleed: { x0: 1, y0: 2, x1: 90, y1: 95 } });
    // Only the page that changed carries boxes.
    expect(plan.pages[1]?.boxes).toBeUndefined();
    await doc.close();
  });

  it('setting metadata plans it, and PDFium never takes it', async () => {
    const doc = await richDocument();
    await doc.apply(new SetMetadataCommand(doc, { title: 'New' }));
    const { plan } = buildWritePlan(doc);
    expect(plan.metadata?.title).toBe('New');
    expect(plan.labels).toBe(false);
    await doc.close();
  });

  it('a layer toggle plans the whole layer list, with names and positions', async () => {
    const doc = await richDocument();
    const layer = must(doc.state.layers[0], 'layer');
    await doc.apply(new SetLayerVisibleCommand(doc, layer.id, !layer.visible));
    const { plan } = buildWritePlan(doc);
    expect(plan.layers).not.toBeNull();
    expect(plan.layers?.[0]).toMatchObject({ name: layer.name, index: 0 });
    expect(plan.layers?.[0]?.visible).toBe(!layer.visible);
    await doc.close();
  });

  it('module state is not a document change and is never planned', async () => {
    const doc = await richDocument();
    await doc.apply(new SetCustomCommand(doc, 'M30', { pen: 'red' }));
    expect(doc.state.writeIntents).toEqual(['custom']);
    expect(planIsEmpty(buildWritePlan(doc).plan)).toBe(true);
    await doc.close();
  });

  it('adding a bookmark plans the outline, with its destination', async () => {
    const doc = await richDocument();
    const pageId = doc.page(2).id;
    await doc.apply(new AddOutlineItemCommand(doc, { title: 'Later', target: { pageId } }));
    const { plan } = buildWritePlan(doc);
    expect(plan.outline).not.toBeNull();
    const added = plan.outline?.find((o) => o.title === 'Later');
    expect(added?.dest?.page).toBe(2);
    expect(added?.parent).toBeNull();
    await doc.close();
  });
});

describe('which entities were touched', () => {
  it('names the annotations the session changed, and no others', async () => {
    const doc = await richDocument();
    const pageId = doc.page(0).id;
    await doc.loadAnnotations(pageId);
    const existing = must(doc.annotations(pageId)[0], 'annotation');

    // Nothing touched yet.
    expect(touchedEntities(doc).annotations.size).toBe(0);

    await doc.apply(new UpdateAnnotationCommand(doc, existing.id, { contents: 'edited' }));
    const touched = touchedEntities(doc);
    expect([...touched.annotations]).toEqual([existing.id]);
    await doc.close();
  });

  it('sees through a transaction to the commands inside it', async () => {
    const doc = await richDocument();
    const pageId = doc.page(0).id;
    await doc.loadAnnotations(pageId);
    const existing = must(doc.annotations(pageId)[0], 'annotation');
    await doc.batch('Two edits', async () => {
      await doc.apply(new UpdateAnnotationCommand(doc, existing.id, { contents: 'a' }));
      await doc.apply(new SetFieldValueCommand(doc, textField(doc).id, 'x'));
    });
    const touched = touchedEntities(doc);
    expect(touched.annotations.has(existing.id)).toBe(true);
    expect(touched.fields.size).toBe(1);
    await doc.close();
  });
});

describe('annotations in the plan', () => {
  it('an untouched Highlight is left to PDFium, which draws it already', async () => {
    const doc = await richDocument();
    const pageId = doc.page(0).id;
    await doc.loadAnnotations(pageId);
    const { plan } = buildWritePlan(doc);
    const highlight = plan.pages[0]?.annotations?.find((a) => a.subtype === 'Highlight');
    expect(highlight).toBeUndefined();
    // The Ink on the same page is in the same position: PDFium draws that too.
    expect(plan.pages[0]?.annotations ?? []).toHaveLength(0);
    await doc.close();
  });

  it('an untouched subtype PDFium never draws is offered for repair, not replacement', async () => {
    const doc = await richDocument();
    const pageId = doc.page(1).id;
    // A Line put into the file by some other tool, with no appearance stream.
    await doc.engine.addAnnotation(doc.handle, {
      ...annotationSource('Line', { rect: { x0: 5, y0: 5, x1: 80, y1: 40 } }),
      page: 1,
    });
    await doc.loadAnnotations(pageId);

    const { plan } = buildWritePlan(doc);
    const entry = must(
      plan.pages[1]?.annotations?.find((a) => a.subtype === 'Line'),
      'planned Line',
    );
    // Offered, so a missing `/AP` is filled — but never replacing one the file already has.
    expect(entry.appearance?.replace).toBe(false);
    expect(entry.properties).toBeUndefined();
    await doc.close();
  });

  it('an edited annotation is replaced, and a cleared value is planned as a removal', async () => {
    const doc = await richDocument();
    const pageId = doc.page(0).id;
    await doc.loadAnnotations(pageId);
    const existing = must(doc.annotations(pageId)[0], 'annotation');
    await doc.apply(new UpdateAnnotationCommand(doc, existing.id, { contents: null }));

    const { plan } = buildWritePlan(doc);
    const entry = plan.pages[0]?.annotations?.find((a) => a.rect.x0 === existing.rect.x0);
    expect(entry?.appearance?.replace).toBe(true);
    expect(entry?.properties?.contents).toBeNull();
    /*
     * The whole model record is planned, not only the values that went away (changed by M30, ADR
     * 0013). PDFium's `FPDFAnnot_SetColor` refuses while an annotation has an appearance stream —
     * and it builds one itself for most markup subtypes — so leaving the still-set values "to the
     * engine, which already wrote it" quietly lost a recoloured highlight. For an annotation the
     * session actually edited, the model is the intent, so it is written in full.
     */
    expect(entry?.properties && 'quadPoints' in entry.properties).toBe(true);
    expect(entry?.properties?.color).toBe(existing.color);
    expect(entry?.insert).toBeUndefined();
    await doc.close();
  });

  it('an added annotation is planned with its appearance', async () => {
    const doc = await richDocument();
    const pageId = doc.page(1).id;
    await doc.loadAnnotations(pageId);
    const draft = draftAnnotation(
      doc,
      pageId,
      annotationSource('Line', { rect: { x0: 10, y0: 10, x1: 90, y1: 60 } }),
    );
    await doc.apply(new AddAnnotationCommand(doc, draft));

    const { plan } = buildWritePlan(doc);
    const page = plan.pages[1];
    const entry = page?.annotations?.find((a) => a.subtype === 'Line');
    expect(entry?.appearance?.replace).toBe(true);
    expect(entry?.appearance?.input.subtype).toBe('Line');
    await doc.close();
  });

  it('a page whose annotations were never loaded plans none of them', async () => {
    const doc = await richDocument();
    const { plan } = buildWritePlan(doc);
    expect(plan.pages[2]?.annotations).toBeUndefined();
    await doc.close();
  });
});

describe('the appearance input', () => {
  it('carries the geometry of whichever family the annotation is', async () => {
    const doc = await richDocument();
    const pageId = doc.page(0).id;
    await doc.loadAnnotations(pageId);
    const markup = must(doc.annotations(pageId)[0], 'markup annotation');
    const ink = must(doc.annotations(pageId)[1], 'ink annotation');
    expect(toAppearanceInput(markup).quadPoints.length).toBeGreaterThan(0);
    expect(toAppearanceInput(ink).paths.length).toBeGreaterThan(0);
    // The rect is normalised, whichever way round the file had it.
    const input = toAppearanceInput(markup);
    expect(input.rect.x1).toBeGreaterThanOrEqual(input.rect.x0);
    await doc.close();
  });
});

describe('fields', () => {
  it('a cleared field is planned as a removal', async () => {
    // Field values go to the engine when it can take them; a fake that refuses is what makes the
    // `fields` write intent, which is the only thing that puts a field into the plan.
    const doc = await richDocument({ setFieldValue: false });
    const field = textField(doc);
    await doc.apply(new SetFieldValueCommand(doc, field.id, ''));
    const { plan } = buildWritePlan(doc);
    expect(plan.fields).toEqual([{ name: field.name, value: null }]);
    await doc.close();
  });

  it('a field the engine took is not planned at all', async () => {
    const doc = await richDocument();
    const field = textField(doc);
    await doc.apply(new SetFieldValueCommand(doc, field.id, 'Leeds'));
    expect(doc.state.writeIntents).toEqual([]);
    expect(buildWritePlan(doc).plan.fields).toBeNull();
    await doc.close();
  });
});

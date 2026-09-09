/**
 * M32 acceptance, at the model and file level:
 *
 * - **Export XFDF from a fixture with 20 mixed annotations → import into a blank copy → the
 *   annotation list deep-equals (minus ids).**
 * - **Foxit- and Acrobat-exported XFDF fixtures import with all fields.**
 * - **Reply/status round-trip through save.**
 *
 * This runs the whole real pipeline: PDFium reads `comments.pdf`, `exportComments` turns the
 * model into an exchange document, `importComments` puts it into a second document as commands,
 * M21's planner builds a `WritePlan`, `FullRewriteWriter` applies it, and the result is reopened
 * in PDFium. The version that drives the running app is `test/e2e/comments.spec.ts`; this one is
 * where a regression in the *file* shows up, with a stack trace rather than a screenshot.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFString, PDFHexString } from 'pdf-lib';
import { Document } from '@core/Document';
import type { AnnotationPatch, ModelAnnotation } from '@core/model';
import type { ModelId } from '@core/Ids';
import { FullRewriteWriter } from '@engine/writers/FullRewriteWriter';
import { buildWritePlan } from '@modules/M21-save/plan';
import { readXfdf, writeXfdf, readComments, writeFdf } from '@engine/xfdf';
import {
  exportComments,
  importComments,
  serialiseComments,
} from '@modules/M32-comments-panel/exchange';
import { buildComments } from '@modules/M32-comments-panel/model';
import type { AnnotationService } from '@modules/M30-markup-annotations/AnnotationService';
import { engine, fixture } from '../engine/helpers';
import { must } from '../find/helpers';

const xfdfFixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../../fixtures/xfdf/${name}`, import.meta.url)), 'utf8');

/**
 * The bits of `AnnotationService` that `importComments` uses. The real one needs a whole shell;
 * everything it does here is a command on the document, which is what is being tested.
 */
function fakeAnnotations(doc: Document): AnnotationService {
  const edited = new Set<string>();
  const service = {
    edited,
    markEdited: (id: string) => edited.add(id),
    patch: async (id: ModelId, patch: AnnotationPatch) => {
      const { UpdateAnnotationCommand } = await import('@core/commands');
      await doc.apply(new UpdateAnnotationCommand(doc, id, patch));
    },
  };
  return service as unknown as AnnotationService;
}

/** Every comparable field of an annotation, without the ids that cannot survive a copy. */
function summary(a: ModelAnnotation): Record<string, unknown> {
  const round = (n: number): number => Math.round(n * 100) / 100;
  const geometry: Record<string, unknown> = {};
  if ('quadPoints' in a) geometry['quadPoints'] = a.quadPoints.map(round);
  if ('paths' in a) geometry['paths'] = a.paths.map((p) => p.map((q) => [round(q.x), round(q.y)]));
  if ('vertices' in a) geometry['vertices'] = a.vertices.map((q) => [round(q.x), round(q.y)]);
  if ('icon' in a) geometry['icon'] = a.icon;
  const extra: Record<string, unknown> = {};
  for (const key of Object.keys(a.extra).sort()) {
    // `hasAP` and `popup` are the engine's report of the file it read, not the comment.
    if (key === 'hasAP' || key === 'popup') continue;
    extra[key] = a.extra[key];
  }
  return {
    subtype: a.subtype,
    rect: [round(a.rect.x0), round(a.rect.y0), round(a.rect.x1), round(a.rect.y1)],
    contents: a.contents,
    author: a.author,
    subject: a.subject,
    color: a.color,
    interiorColor: a.interiorColor,
    borderWidth: a.borderWidth,
    state: a.state,
    created: a.created,
    modified: a.modified,
    flags: a.flags,
    ...geometry,
    extra,
  };
}

/** A key that identifies one comment across two documents: everything but its id. */
const key = (a: Record<string, unknown>): string => JSON.stringify(a);

async function openFixture(name: string): Promise<Document> {
  const eng = await engine();
  const doc = await Document.open(eng, fixture(name));
  for (const page of doc.state.pages) await doc.loadAnnotations(page.id);
  return doc;
}

/** A copy of the fixture with every annotation stripped — the "blank copy" to import into. */
async function strippedCopy(name: string): Promise<Uint8Array> {
  const pdf = await PDFDocument.load(fixture(name));
  for (const page of pdf.getPages()) page.node.delete(PDFName.of('Annots'));
  return pdf.save({ useObjectStreams: false });
}

describe('XFDF export → import → the annotation list is equal', () => {
  it('round-trips every comment in the twenty-annotation fixture', async () => {
    const eng = await engine();
    const source = await openFixture('comments.pdf');
    const before = source.state.pages
      .flatMap((page) => source.annotations(page.id))
      .map(summary)
      .map(key)
      .sort();
    expect(before.length).toBeGreaterThanOrEqual(20);

    const exchange = exportComments(source, { format: 'xfdf', formData: false });
    expect(exchange.annotations.length).toBe(before.length);
    const text = writeXfdf(exchange);
    await source.close();

    const target = await Document.open(eng, await strippedCopy('comments.pdf'));
    for (const page of target.state.pages) await target.loadAnnotations(page.id);
    expect(target.state.pages.flatMap((p) => target.annotations(p.id))).toHaveLength(0);

    const result = await importComments(target, fakeAnnotations(target), readXfdf(text), {
      policy: 'replace',
    });
    expect(result.added).toBe(before.length);
    expect(result.offPage).toBe(0);
    expect(result.replies).toBe(4);

    const after = target.state.pages
      .flatMap((page) => target.annotations(page.id))
      .map(summary)
      .map(key)
      .sort();
    await target.close();
    expect(after).toEqual(before);
  }, 60_000);

  it('keeps the reply threads, not just the annotations', async () => {
    const eng = await engine();
    const source = await openFixture('comments.pdf');
    const threadsOf = (doc: Document): string[] => {
      const all = doc.state.pages.flatMap((page) => doc.annotations(page.id));
      const index = new Map(doc.state.pages.map((page, at) => [page.id, at]));
      return buildComments(all, (id) => index.get(id) ?? 0)
        .map(
          (entry) =>
            `${entry.type}|${entry.author}|${entry.status}|${String(entry.replies.length)}`,
        )
        .sort();
    };
    const before = threadsOf(source);
    const text = writeXfdf(exportComments(source, { format: 'xfdf', formData: false }));
    await source.close();

    const target = await Document.open(eng, await strippedCopy('comments.pdf'));
    for (const page of target.state.pages) await target.loadAnnotations(page.id);
    await importComments(target, fakeAnnotations(target), readXfdf(text), { policy: 'replace' });
    const after = threadsOf(target);
    await target.close();
    expect(after).toEqual(before);
    // The fixture has one Accepted thread and one Rejected one; they must both survive.
    expect(after.filter((t) => t.includes('|accepted|'))).toHaveLength(1);
    expect(after.filter((t) => t.includes('|rejected|'))).toHaveLength(1);
  }, 60_000);

  it('round-trips through FDF as well as XFDF', async () => {
    const eng = await engine();
    const source = await openFixture('comments.pdf');
    const before = source.state.pages
      .flatMap((page) => source.annotations(page.id))
      .map(summary)
      .map(key)
      .sort();
    const bytes = serialiseComments(
      exportComments(source, { format: 'fdf', formData: false }),
      'fdf',
    );
    await source.close();

    const target = await Document.open(eng, await strippedCopy('comments.pdf'));
    for (const page of target.state.pages) await target.loadAnnotations(page.id);
    await importComments(target, fakeAnnotations(target), readComments(bytes, 'fdf'), {
      policy: 'replace',
    });
    const after = target.state.pages
      .flatMap((page) => target.annotations(page.id))
      .map(summary)
      .map(key)
      .sort();
    await target.close();
    expect(after).toEqual(before);
  }, 60_000);

  it('replacing by name imports the same file twice without doubling anything', async () => {
    const eng = await engine();
    const source = await openFixture('comments.pdf');
    const text = writeXfdf(exportComments(source, { format: 'xfdf', formData: false }));
    const count = source.state.pages.flatMap((page) => source.annotations(page.id)).length;
    await source.close();

    const target = await Document.open(eng, await strippedCopy('comments.pdf'));
    for (const page of target.state.pages) await target.loadAnnotations(page.id);
    const service = fakeAnnotations(target);
    await importComments(target, service, readXfdf(text), { policy: 'replace' });
    const second = await importComments(target, service, readXfdf(text), { policy: 'replace' });
    expect(second.added).toBe(0);
    expect(second.replaced).toBe(count);
    expect(target.state.pages.flatMap((page) => target.annotations(page.id))).toHaveLength(count);
    await target.close();
  }, 60_000);

  it('adding instead of replacing gives every comment a second copy', async () => {
    const eng = await engine();
    const source = await openFixture('comments.pdf');
    const text = writeXfdf(exportComments(source, { format: 'xfdf', formData: false }));
    const count = source.state.pages.flatMap((page) => source.annotations(page.id)).length;
    await source.close();

    const target = await Document.open(eng, await strippedCopy('comments.pdf'));
    for (const page of target.state.pages) await target.loadAnnotations(page.id);
    const service = fakeAnnotations(target);
    await importComments(target, service, readXfdf(text), { policy: 'replace' });
    await importComments(target, service, readXfdf(text), { policy: 'add' });
    expect(target.state.pages.flatMap((page) => target.annotations(page.id))).toHaveLength(
      count * 2,
    );
    await target.close();
  }, 60_000);

  it('is one undo step, however many comments it brought', async () => {
    const eng = await engine();
    const source = await openFixture('comments.pdf');
    const text = writeXfdf(exportComments(source, { format: 'xfdf', formData: false }));
    await source.close();

    const target = await Document.open(eng, await strippedCopy('comments.pdf'));
    for (const page of target.state.pages) await target.loadAnnotations(page.id);
    await importComments(target, fakeAnnotations(target), readXfdf(text), { policy: 'replace' });
    expect(
      target.state.pages.flatMap((page) => target.annotations(page.id)).length,
    ).toBeGreaterThan(0);
    await target.undoLast();
    expect(target.state.pages.flatMap((page) => target.annotations(page.id))).toHaveLength(0);
    await target.close();
  }, 60_000);
});

describe('an export from another editor imports with all its fields', () => {
  const cases: ReadonlyArray<{ name: string; file: string; count: number }> = [
    { name: 'Acrobat', file: 'acrobat.xfdf', count: 9 },
    { name: 'Foxit', file: 'foxit.xfdf', count: 11 },
  ];

  for (const entry of cases) {
    it(`imports a ${entry.name}-shaped export into a real document`, async () => {
      const eng = await engine();
      const doc = await Document.open(eng, fixture('multipage.pdf'));
      for (const page of doc.state.pages) await doc.loadAnnotations(page.id);
      const source = readXfdf(xfdfFixture(entry.file));
      const result = await importComments(doc, fakeAnnotations(doc), source, {
        policy: 'replace',
      });
      expect(result.added).toBe(entry.count);
      expect(result.offPage).toBe(0);

      const imported = doc.state.pages.flatMap((page) => doc.annotations(page.id));
      expect(imported).toHaveLength(entry.count);

      // Every field the file gave is on the model annotation it became.
      for (const incoming of source.annotations) {
        const landed = imported.find((a) => a.name === incoming.name);
        expect(landed, incoming.name ?? '?').toBeDefined();
        if (!landed) continue;
        expect(landed.subtype).toBe(incoming.subtype);
        expect(landed.author).toBe(incoming.author);
        expect(landed.contents).toBe(incoming.contents);
        expect(landed.color).toBe(incoming.color);
        expect(landed.created).toBe(incoming.created);
        expect(landed.rect.x0).toBeCloseTo(incoming.rect.x0, 2);
        expect(landed.rect.y1).toBeCloseTo(incoming.rect.y1, 2);
        if (incoming.quadPoints.length > 0) {
          expect('quadPoints' in landed ? landed.quadPoints : []).toEqual(incoming.quadPoints);
        }
        if (incoming.state !== null) expect(landed.state).toBe(incoming.state);
        if (incoming.intent !== null) expect(landed.extra['intent']).toBe(incoming.intent);
        if (incoming.callout.length > 0) expect(landed.extra['callout']).toEqual(incoming.callout);
        if (incoming.dashArray) expect(landed.extra['dashArray']).toEqual(incoming.dashArray);
        if (incoming.cloudy !== null) expect(landed.extra['cloudy']).toBe(incoming.cloudy);
        if (incoming.attachmentName !== null) {
          expect(landed.extra['attachmentName']).toBe(incoming.attachmentName);
        }
        if (incoming.subtype === 'Ink') {
          expect('paths' in landed ? landed.paths.length : 0).toBe(incoming.paths.length);
        }
      }

      // The threads the file described are threads in the model.
      const index = new Map(doc.state.pages.map((page, at) => [page.id, at]));
      const threads = buildComments(imported, (id) => index.get(id) ?? 0);
      const replied = threads.filter((t) => t.replies.length > 0);
      expect(replied.length).toBeGreaterThan(0);
      await doc.close();
    }, 60_000);
  }

  it('an FDF from Acrobat imports the same way', async () => {
    const eng = await engine();
    const doc = await Document.open(eng, fixture('multipage.pdf'));
    for (const page of doc.state.pages) await doc.loadAnnotations(page.id);
    const bytes = new Uint8Array(
      readFileSync(fileURLToPath(new URL('../../fixtures/xfdf/acrobat.fdf', import.meta.url))),
    );
    const result = await importComments(doc, fakeAnnotations(doc), readComments(bytes), {
      policy: 'replace',
    });
    expect(result.added).toBe(4);
    const imported = doc.state.pages.flatMap((page) => doc.annotations(page.id));
    const note = imported.find((a) => a.name === 'fdf-0002');
    expect(note?.contents).toBe('The copy says “élan”');
    const index = new Map(doc.state.pages.map((page, at) => [page.id, at]));
    const thread = buildComments(imported, (id) => index.get(id) ?? 0).find(
      (t) => t.id === note?.id,
    );
    expect(thread?.status).toBe('rejected');
    await doc.close();
  }, 60_000);

  it('a comment on a page the document does not have is counted, not lost silently', async () => {
    const eng = await engine();
    const doc = await Document.open(eng, fixture('blank.pdf'));
    await doc.loadAnnotations(must(doc.state.pages[0], 'page').id);
    const result = await importComments(
      doc,
      fakeAnnotations(doc),
      readXfdf(xfdfFixture('acrobat.xfdf')),
      { policy: 'replace' },
    );
    // The one-page fixture keeps only the page-0 comments; the page-1 ones are reported.
    expect(result.offPage).toBeGreaterThan(0);
    expect(result.added).toBeGreaterThan(0);
    await doc.close();
  }, 60_000);
});

describe('replies and status survive a save', () => {
  /** Saves a document the way M21 does, and gives the bytes back. */
  async function saveThrough(doc: Document): Promise<Uint8Array> {
    const { plan, warnings } = buildWritePlan(doc);
    const base = await doc.engine.save(doc.handle);
    const result = await new FullRewriteWriter().write({
      bytes: base,
      plan,
      options: { objectStreams: false },
    });
    expect([...warnings, ...result.warnings]).toEqual([]);
    return result.bytes;
  }

  it('an imported thread is still a thread after a save and a reopen', async () => {
    const eng = await engine();
    const source = await openFixture('comments.pdf');
    const text = writeXfdf(exportComments(source, { format: 'xfdf', formData: false }));
    await source.close();

    const target = await Document.open(eng, await strippedCopy('comments.pdf'));
    for (const page of target.state.pages) await target.loadAnnotations(page.id);
    await importComments(target, fakeAnnotations(target), readXfdf(text), { policy: 'replace' });
    const bytes = await saveThrough(target);
    await target.close();

    const reopened = await Document.open(eng, bytes.slice());
    for (const page of reopened.state.pages) await reopened.loadAnnotations(page.id);
    const all = reopened.state.pages.flatMap((page) => reopened.annotations(page.id));
    const index = new Map(reopened.state.pages.map((page, at) => [page.id, at]));
    const threads = buildComments(all, (id) => index.get(id) ?? 0);
    await reopened.close();

    const replied = threads.filter((t) => t.replies.length > 0);
    expect(replied.length).toBe(2);
    expect(threads.filter((t) => t.status === 'accepted')).toHaveLength(1);
    expect(threads.filter((t) => t.status === 'rejected')).toHaveLength(1);
    // The status is on a reply, and it says who set it — which is the whole point of the model.
    const accepted = threads.find((t) => t.status === 'accepted');
    expect(accepted?.statusBy).toBe('A. Reviewer');
  }, 60_000);

  it('`/IRT` is written as a reference to the parent annotation, not as its name', async () => {
    const eng = await engine();
    const source = await openFixture('comments.pdf');
    const text = writeXfdf(exportComments(source, { format: 'xfdf', formData: false }));
    await source.close();

    const target = await Document.open(eng, await strippedCopy('comments.pdf'));
    for (const page of target.state.pages) await target.loadAnnotations(page.id);
    await importComments(target, fakeAnnotations(target), readXfdf(text), { policy: 'replace' });
    const bytes = await saveThrough(target);
    await target.close();

    const pdf = await PDFDocument.load(bytes);
    const page = must(pdf.getPages()[0], 'page');
    const annots = page.node.lookup(PDFName.of('Annots'), PDFArray);
    let irts = 0;
    for (let i = 0; i < annots.size(); i++) {
      const dict = pdf.context.lookupMaybe(annots.get(i), PDFDict);
      const irt = dict?.get(PDFName.of('IRT'));
      if (irt === undefined) continue;
      irts++;
      // A reference, not a string: anything else and no other reader threads the reply.
      expect(irt.constructor.name).toBe('PDFRef');
      const parent = pdf.context.lookupMaybe(irt, PDFDict);
      expect(parent).toBeDefined();
      const nm = parent?.get(PDFName.of('NM'));
      expect(nm instanceof PDFString || nm instanceof PDFHexString).toBe(true);
      // `/RT` says what the reference means.
      const rt = dict?.lookupMaybe(PDFName.of('RT'), PDFName)?.decodeText();
      expect(rt).toBe('R');
    }
    expect(irts).toBe(4);
  }, 60_000);

  it('a reply whose target is not in the file is written as a loose note, with a warning', async () => {
    const eng = await engine();
    const doc = await Document.open(eng, fixture('blank.pdf'));
    const page = must(doc.state.pages[0], 'page');
    await doc.loadAnnotations(page.id);
    const template = must(readXfdf(xfdfFixture('acrobat.xfdf')).annotations[2], 'a reply');
    const orphan = readXfdf(
      writeXfdf({
        href: null,
        ids: null,
        fields: [],
        annotations: [{ ...template, page: 0, inReplyTo: 'nobody-here' }],
      }),
    );
    const result = await importComments(doc, fakeAnnotations(doc), orphan, { policy: 'replace' });
    expect(result.added).toBe(1);
    expect(result.replies).toBe(0);
    // It is a comment of its own rather than a lost one.
    const all = doc.annotations(page.id);
    expect(all).toHaveLength(1);
    expect(all[0]?.inReplyTo).toBeNull();
    await doc.close();
  }, 60_000);

  it('an export never dirties the document it is exporting', async () => {
    const source = await openFixture('comments.pdf');
    const before = source.isDirty;
    const revision = source.state.revision;
    exportComments(source, { format: 'xfdf', formData: true });
    writeFdf(exportComments(source, { format: 'fdf', formData: false }));
    expect(source.isDirty).toBe(before);
    expect(source.state.revision).toBe(revision);
    await source.close();
  }, 60_000);
});

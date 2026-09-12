/** Recovery uses real engine bytes and the writer, including edits already present in bytes. */
import { describe, expect, it } from 'vitest';
import { Document } from '@core/Document';
import {
  DeletePagesCommand,
  InsertPagesCommand,
  RotatePagesCommand,
  SetMetadataCommand,
  UpdateAnnotationCommand,
} from '@core/commands';
import { FullRewriteWriter } from '@engine/writers/FullRewriteWriter';
import { buildWritePlan } from '@modules/M21-save/plan';
import {
  checkpointRecord,
  listRecoverable,
  memoryRecoveryStorage,
  parseRecoveryRecord,
} from '@modules/M21-save/recovery';
import {
  CoverSheetCommand,
  PortfolioEditCommand,
  ReplaceFileCommand,
  portfolioOfDocument,
  setPortfolioRecord,
} from '@modules/M42-portfolios/commands';
import { portfolioFrom } from '@modules/M42-portfolios/read';
import { blobKey, withFile, withoutFile } from '@shared/portfolio';
import { engine, fixture } from '../engine/helpers';
import { must } from '../core/helpers';
import { Documents } from '@app/tabs/Documents';
import { Registry } from '@core/Registry';
import { DocumentService, DOCUMENT_SERVICE } from '@modules/M20-document-model/DocumentService';
import { SaveService } from '@modules/M21-save/SaveService';
import { memorySettingsStorage } from '@modules/M21-save/settings';

async function save(doc: Document): Promise<Uint8Array> {
  const { plan, warnings } = buildWritePlan(doc);
  expect(warnings).toEqual([]);
  const written = await new FullRewriteWriter().write({
    bytes: await doc.engine.save(doc.handle),
    plan,
  });
  expect(written.warnings).toEqual([]);
  doc.undo.markSaved();
  return written.bytes;
}

async function crash(doc: Document): Promise<Document> {
  const storage = memoryRecoveryStorage();
  const record = await checkpointRecord(doc, storage, { id: 'test', source: null, now: 10 });
  await storage.save(record.id, JSON.stringify(record));
  const parsed = must(parseRecoveryRecord(must((await storage.list())[0]).payload));
  expect(await listRecoverable(storage)).toHaveLength(1);
  const checkpoint = must(parsed.checkpoint);
  await doc.close();
  const restored = await Document.open(
    await engine(),
    await storage.readBlob(record.id, checkpoint.engine),
  );
  restored.restoreCheckpoint(checkpoint.document);
  for (const [key, hash] of Object.entries(checkpoint.blobs))
    restored.blobs.set(key, await storage.readBlob(record.id, hash));
  return restored;
}

describe('self-contained recovery checkpoints', () => {
  it('recovers an unsaved zero-command document through SaveService and retains missing-base records', async () => {
    const storage = memoryRecoveryStorage();
    let doc = await Document.open(await engine(), fixture('multipage.pdf'));
    doc.undo.markUnsaved();
    const record = await checkpointRecord(doc, storage, { id: 'pathless', source: null, now: 10 });
    await storage.save(record.id, JSON.stringify(record));
    await doc.close();
    const tabs = new Documents();
    const registry = new Registry();
    const docs = new DocumentService(tabs, await engine());
    registry.provide(DOCUMENT_SERVICE, docs);
    const service = new SaveService({
      registry,
      shell: {
        documents: tabs,
        invalidate: () => undefined,
        toasts: { show: () => undefined },
      } as never,
      recoveryStorage: storage,
      settingsStorage: memorySettingsStorage(),
    });
    await service.load();
    try {
      const broken = {
        ...record,
        checkpoint: { ...must(record.checkpoint), engine: '0'.repeat(64) },
      };
      expect(await service.recoverOne(broken)).toBe(false);
      expect(storage.size).toBe(1);
      expect(tabs.tabs).toHaveLength(0);
      expect(await service.recoverOne(record)).toBe(true);
      expect(storage.size).toBe(1);
      doc = must(docs.active);
      expect(doc.pageCount).toBe(5);
      expect(doc.isDirty).toBe(true);
      expect(doc.state.path).toBeNull();
      expect(service.state(doc.id)?.recoveryId).toBe(record.id);
      await service.autosaveNow();
      expect(storage.size).toBe(1);
    } finally {
      service.dispose();
      await doc.close();
    }
  });

  it('does not rotate twice after Save, another edit and a crash', async () => {
    let doc = await Document.open(await engine(), fixture('multipage.pdf'), { path: 'C:/old.pdf' });
    await doc.apply(new RotatePagesCommand(doc, [doc.page(0).id], 90, true));
    await save(doc);
    await doc.apply(new SetMetadataCommand(doc, { title: 'After save' }));
    const expected = doc.snapshot();
    doc = await crash(doc);
    expect(doc.snapshot()).toEqual(expected);
    expect(doc.page(0).rotation).toBe(90);
    expect(doc.isDirty).toBe(true);
    const output = await save(doc);
    const reopened = await Document.open(await engine(), output);
    expect(reopened.page(0).rotation).toBe(90);
    expect(reopened.state.title).toBe('After save');
    await reopened.close();
    await doc.close();
  });

  it('recovers undo past a save, a branch, deleted pages and repeated saves', async () => {
    let doc = await Document.open(await engine(), fixture('multipage.pdf'));
    await doc.apply(new RotatePagesCommand(doc, [doc.page(0).id], 90, true));
    await save(doc);
    await doc.undoLast();
    await doc.apply(new DeletePagesCommand(doc, [doc.page(1).id]));
    await doc.apply(new InsertPagesCommand(doc, 1, 1, { width: 123, height: 456 }));
    await save(doc);
    await doc.apply(new SetMetadataCommand(doc, { title: 'Branched' }));
    const expected = doc.snapshot();
    doc = await crash(doc);
    expect(doc.snapshot()).toEqual(expected);
    const output = await save(doc);
    const reopened = await Document.open(await engine(), output);
    expect(reopened.pageCount).toBe(doc.pageCount);
    expect(reopened.page(0).rotation).toBe(0);
    await reopened.close();
    await doc.close();
  });

  it('keeps a pathless dirty document with no journal and survives a second crash', async () => {
    let doc = await Document.open(await engine(), fixture('multipage.pdf'));
    doc.undo.markUnsaved();
    doc = await crash(doc);
    expect(doc.state.path).toBeNull();
    expect(doc.pageCount).toBe(5);
    doc = await crash(doc);
    expect(doc.isDirty).toBe(true);
    expect(doc.pageCount).toBe(5);
    await doc.close();
  });

  it('restores existing annotation IDs and edits before any lazy loading, then saves them', async () => {
    let doc = await Document.open(await engine(), fixture('annotated.pdf'));
    for (const page of [...doc.state.pages].reverse()) await doc.loadAnnotations(page.id);
    const annotation = must(Object.values(doc.state.annotations).flat()[0]);
    await doc.apply(
      new UpdateAnnotationCommand(doc, annotation.id, { contents: 'Recovered contents' }),
    );
    const expected = doc.snapshot();
    doc = await crash(doc);
    expect(doc.snapshot()).toEqual(expected);
    expect(doc.annotation(annotation.id)?.contents).toBe('Recovered contents');
    // A later edit and its undo must keep the checkpoint's writer provenance.
    await doc.apply(new SetMetadataCommand(doc, { title: 'Temporary' }));
    await doc.undoLast();
    const output = await save(doc);
    const reopened = await Document.open(await engine(), output);
    for (const page of reopened.state.pages) await reopened.loadAnnotations(page.id);
    expect(
      Object.values(reopened.state.annotations)
        .flat()
        .some((a) => a.contents === 'Recovered contents'),
    ).toBe(true);
    await reopened.close();
    await doc.close();
  });

  it('recovers portfolio structure, replacement and added bytes, and a replacement cover', async () => {
    let doc = await Document.open(await engine(), fixture('portfolio.pdf'));
    const portfolio = must(
      portfolioFrom(
        await doc.engine.collection(doc.handle),
        await doc.engine.attachments(doc.handle),
      ),
    );
    setPortfolioRecord(doc, portfolio);
    const original = must(portfolio.files[0]);
    const replacement = fixture('multipage.pdf');
    const replaced = withFile(portfolio, {
      ...original,
      name: 'renamed.pdf',
      mimeType: 'application/pdf',
      size: replacement.length,
      source: { kind: 'added' },
    });
    await doc.apply(new ReplaceFileCommand(doc, original.id, replaced, replacement));
    const added = {
      ...original,
      id: 'new-file',
      name: 'added.pdf',
      source: { kind: 'added' as const },
      size: replacement.length,
    };
    const next = {
      ...withoutFile(replaced, must(replaced.files[1]).id),
      files: [...withoutFile(replaced, must(replaced.files[1]).id).files, added],
    };
    await doc.apply(
      new PortfolioEditCommand(doc, 'Add and remove files', next, {
        blobs: [{ key: blobKey(added.id), bytes: replacement }],
      }),
    );
    await doc.apply(new CoverSheetCommand(doc, 'Replace cover', fixture('multipage.pdf'), next));
    const expected = doc.snapshot();
    doc = await crash(doc);
    expect(doc.snapshot()).toEqual(expected);
    expect(doc.blobs.get(blobKey(original.id))).toEqual(replacement);
    expect(doc.blobs.get(blobKey(added.id))).toEqual(replacement);
    expect(portfolioOfDocument(doc)?.files).toEqual(next.files);
    const output = await save(doc);
    const reopened = await Document.open(await engine(), output);
    const attachments = await reopened.engine.attachments(reopened.handle);
    for (const name of ['renamed.pdf', 'added.pdf']) {
      const attachment = must(attachments.find((a) => a.name === name));
      expect(attachment).toBeDefined();
      expect(await reopened.engine.attachmentData(reopened.handle, attachment.id)).toEqual(
        replacement,
      );
    }
    expect(reopened.pageCount).toBe(1);
    await reopened.close();
    await doc.close();
  });
});

/**
 * Editing a portfolio, undoing it, and saving it (M42, ADR 0014).
 *
 * The whole pipeline as the application runs it: a real `Document` over the real engine, edits
 * applied as `Command`s through the undo stack, `buildWritePlan` turning the model into
 * instructions, and `FullRewriteWriter` producing the bytes — then the file is opened again and
 * asked whether it still says what the reader meant.
 *
 * This is the brief's "each undoable, each survives save/reopen", one test per operation.
 */

import { describe, expect, it } from 'vitest';
import { Document } from '@core/Document';
import { FullRewriteWriter } from '@engine/writers/FullRewriteWriter';
import { buildWritePlan } from '@modules/M21-save/plan';
import {
  PortfolioEditCommand,
  portfolioOfDocument,
  setPortfolioRecord,
} from '@modules/M42-portfolios/commands';
import { portfolioFrom } from '@modules/M42-portfolios/read';
import { uniqueColumnKey } from '@modules/M42-portfolios/PortfolioService';
import {
  blobKey,
  filePath,
  nextOrder,
  reordered,
  sortedFiles,
  withFile,
  withFilesAdded,
  withoutFile,
  type Portfolio,
  type PortfolioFile,
} from '@shared/portfolio';
import { engine, fixture } from '../engine/helpers';

/** A document over the fixture, with its portfolio read in the way the service reads it. */
async function openPortfolio(bytes: Uint8Array): Promise<Document> {
  const pdfium = await engine();
  const doc = await Document.open(pdfium, bytes.slice());
  const collection = await pdfium.collection(doc.handle);
  const attachments = await pdfium.attachments(doc.handle);
  const portfolio = portfolioFrom(collection, attachments);
  if (portfolio === null) throw new Error('the fixture is not a portfolio');
  setPortfolioRecord(doc, portfolio);
  return doc;
}

/** Saves the way `SaveService` does: the engine's bytes, plus the plan, through the writer. */
async function save(doc: Document): Promise<Uint8Array> {
  const base = await doc.engine.save(doc.handle);
  const { plan } = buildWritePlan(doc);
  const result = await new FullRewriteWriter().write({
    bytes: base,
    plan,
    options: { objectStreams: false },
  });
  expect(result.warnings).toEqual([]);
  return result.bytes;
}

/** Saves, opens the saved file, and returns the portfolio it reads back. */
async function saveAndReopen(doc: Document): Promise<Portfolio> {
  const bytes = await save(doc);
  const reopened = await openPortfolio(bytes);
  const portfolio = portfolioOfDocument(reopened);
  await reopened.close();
  if (portfolio === null) throw new Error('the saved file is not a portfolio');
  return portfolio;
}

function must(portfolio: Portfolio, name: string): PortfolioFile {
  const file = portfolio.files.find((f) => f.name === name);
  if (!file) throw new Error(`no file called ${name}`);
  return file;
}

/** Applies one structural change through the undo stack, as the service does. */
async function edit(
  doc: Document,
  label: string,
  change: (portfolio: Portfolio) => Portfolio,
  blobs?: ReadonlyArray<{ key: string; bytes: Uint8Array }>,
): Promise<void> {
  const portfolio = portfolioOfDocument(doc);
  if (!portfolio) throw new Error('not a portfolio');
  await doc.apply(new PortfolioEditCommand(doc, label, change(portfolio), blobs ? { blobs } : {}));
}

const names = (portfolio: Portfolio): string[] => sortedFiles(portfolio).map((f) => f.name);

/** The document's portfolio, or a failure that names the problem rather than a null. */
function current(doc: Document): Portfolio {
  const portfolio = portfolioOfDocument(doc);
  if (portfolio === null) throw new Error('the document is not a portfolio');
  return portfolio;
}

describe('editing a portfolio', () => {
  it('reads the fixture as five files in two folders', async () => {
    const doc = await openPortfolio(fixture('portfolio.pdf'));
    const portfolio = current(doc);
    expect(portfolio.files).toHaveLength(5);
    expect(portfolio.folders.map((f) => f.name)).toEqual(['', 'Statements']);
    // `/D` in the file is the key `<0>instruction.pdf`; the model holds the name.
    expect(portfolio.initialFile).toBe('instruction.pdf');
    expect(names(portfolio)).toEqual([
      'readme.txt',
      'instruction.pdf',
      'people.csv',
      'january.txt',
      'february.txt',
    ]);
    await doc.close();
  }, 60000);

  it('reorders, undoes exactly, and the new order survives a save', async () => {
    const doc = await openPortfolio(fixture('portfolio.pdf'));
    const before = names(current(doc));
    const reversed = [...before].reverse();
    const ids = reversed.map((name) => must(current(doc), name).id);

    await edit(doc, 'Reorder files', (p) => reordered(p, ids));
    expect(names(current(doc))).toEqual(reversed);

    await doc.undo.undo();
    expect(names(current(doc))).toEqual(before);
    await doc.undo.redo();
    expect(names(current(doc))).toEqual(reversed);

    expect(names(await saveAndReopen(doc))).toEqual(reversed);
    await doc.close();
  }, 60000);

  it('renames a file, and the saved file lists it under the new name', async () => {
    const doc = await openPortfolio(fixture('portfolio.pdf'));
    const target = must(current(doc), 'readme.txt');
    await edit(doc, 'Rename', (p) => withFile(p, { ...target, name: 'read-me-first.txt' }));
    await doc.undo.undo();
    expect(names(current(doc))).toContain('readme.txt');
    await doc.undo.redo();

    const saved = await saveAndReopen(doc);
    expect(names(saved)).toContain('read-me-first.txt');
    expect(names(saved)).not.toContain('readme.txt');
    await doc.close();
  }, 60000);

  it('describes a file, and the description is where a reader looks for it', async () => {
    const doc = await openPortfolio(fixture('portfolio.pdf'));
    const target = must(current(doc), 'people.csv');
    await edit(doc, 'Describe', (p) =>
      withFile(p, { ...target, description: 'Everyone on the job' }),
    );
    const saved = await saveAndReopen(doc);
    expect(must(saved, 'people.csv').description).toBe('Everyone on the job');
    await doc.close();
  }, 60000);

  it('removes a file, and the saved file no longer has it', async () => {
    const doc = await openPortfolio(fixture('portfolio.pdf'));
    const target = must(current(doc), 'february.txt');
    await edit(doc, 'Remove', (p) => withoutFile(p, target.id));
    await doc.undo.undo();
    expect(portfolioOfDocument(doc)?.files).toHaveLength(5);
    await doc.undo.redo();

    const saved = await saveAndReopen(doc);
    expect(saved.files).toHaveLength(4);
    expect(names(saved)).not.toContain('february.txt');
    await doc.close();
  }, 60000);

  it('moves a file into a folder, and it extracts under that folder afterwards', async () => {
    const doc = await openPortfolio(fixture('portfolio.pdf'));
    const target = must(current(doc), 'people.csv');
    await edit(doc, 'Move', (p) => withFile(p, { ...target, folderId: 1 }));
    const saved = await saveAndReopen(doc);
    const moved = must(saved, 'people.csv');
    expect(moved.folderId).toBe(1);
    expect(filePath(saved, moved)).toBe('Statements/people.csv');
    await doc.close();
  }, 60000);

  it('adds a column, fills it in, and both survive the save', async () => {
    const doc = await openPortfolio(fixture('portfolio.pdf'));
    const portfolio = current(doc);
    const key = uniqueColumnKey(portfolio, 'Case number');
    const target = must(portfolio, 'instruction.pdf');
    await edit(doc, 'Add column', (p) => ({
      ...p,
      schema: [...p.schema, { key, label: 'Case number', kind: 'text', order: 50, visible: true }],
    }));
    await edit(doc, 'Fill it in', (p) => {
      const file = p.files.find((f) => f.id === target.id);
      return file ? withFile(p, { ...file, fields: { ...file.fields, [key]: 'A/17' } }) : p;
    });

    const saved = await saveAndReopen(doc);
    expect(saved.schema.find((c) => c.key === key)?.label).toBe('Case number');
    expect(must(saved, 'instruction.pdf').fields[key]).toBe('A/17');

    await doc.undo.undo();
    expect(
      portfolioOfDocument(doc)?.files.find((f) => f.id === target.id)?.fields[key],
    ).toBeUndefined();
    await doc.close();
  }, 60000);

  it('adds a file from this session and writes its bytes exactly once', async () => {
    const doc = await openPortfolio(fixture('portfolio.pdf'));
    const body = new TextEncoder().encode('A late addition.\n');
    const id = 'added:1';
    const record: PortfolioFile = {
      id,
      name: 'late.txt',
      folderId: 0,
      description: 'Arrived after the pack was made',
      mimeType: 'text/plain',
      size: body.length,
      created: '2026-03-04T09:00:00Z',
      modified: '2026-03-04T09:00:00Z',
      fields: {},
      order: nextOrder(current(doc)),
      source: { kind: 'added' },
    };
    await edit(doc, 'Add late.txt', (p) => withFilesAdded(p, [record]), [
      { key: blobKey(id), bytes: body },
    ]);

    const bytes = await save(doc);
    const reopened = await openPortfolio(bytes);
    const saved = current(reopened);
    const added = must(saved, 'late.txt');
    expect(added.description).toBe('Arrived after the pack was made');

    // And the bytes are exactly what went in.
    const attachments = await reopened.engine.attachments(reopened.handle);
    const match = attachments.find((a) => a.name === 'late.txt');
    expect(match).toBeDefined();
    const readBack = await reopened.engine.attachmentData(reopened.handle, match?.id ?? '');
    expect(Array.from(readBack)).toEqual(Array.from(body));
    await reopened.close();
    await doc.close();
  }, 60000);

  it('extracts every file with its own bytes and its own folder path', async () => {
    const doc = await openPortfolio(fixture('portfolio.pdf'));
    const portfolio = current(doc);
    const attachments = await doc.engine.attachments(doc.handle);
    const written = new Map<string, Uint8Array>();
    for (const file of sortedFiles(portfolio)) {
      const match = attachments.find(
        (a) => a.treeKey === (file.source.kind === 'embedded' ? file.source.treeKey : ''),
      );
      expect(match, `${file.name} is in the engine`).toBeDefined();
      written.set(
        filePath(portfolio, file),
        await doc.engine.attachmentData(doc.handle, match?.id ?? ''),
      );
    }
    expect([...written.keys()].sort()).toEqual([
      'Statements/february.txt',
      'Statements/january.txt',
      'instruction.pdf',
      'people.csv',
      'readme.txt',
    ]);
    expect(new TextDecoder().decode(written.get('readme.txt'))).toBe('Read me first.\n');
    expect(new TextDecoder().decode(written.get('Statements/january.txt'))).toBe(
      'January statement.\n',
    );
    await doc.close();
  }, 60000);

  it('leaves a document nobody touched planning nothing at all', async () => {
    const doc = await openPortfolio(fixture('portfolio.pdf'));
    const { plan } = buildWritePlan(doc);
    // Reading a portfolio is not an edit: no write intent, so no portfolio section.
    expect(plan.portfolio).toBeNull();
    expect(doc.isDirty).toBe(false);
    await doc.close();
  }, 60000);
});

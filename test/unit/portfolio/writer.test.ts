/**
 * The writer's portfolio section (M42, ADR 0014).
 *
 * The first test here is the one the module exists for: change a description, save, and every
 * embedded file must come back **byte-identical**. The operator's packs contain digitally
 * signed PDFs, and a signature survives only if nothing decoded and re-encoded the stream it
 * lives in. Everything else in this file is structure — folders, keys, order, `/Params` — and
 * matters less than that one assertion.
 *
 * The synthetic `portfolio.pdf` fixture is written by `scripts/make-fixtures.ts` with raw
 * dictionaries, so these tests read something our own writer did not produce. The operator's
 * `Sample Portfolio.pdf` is used as well when it is on the machine.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  PDFArray,
  PDFBool,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFString,
} from 'pdf-lib';
import { emptyWritePlan, type PlannedPortfolio, type WritePlan } from '@engine/Writer';
import { FullRewriteWriter } from '@engine/writers/FullRewriteWriter';
import { portfolioFrom } from '@modules/M42-portfolios/read';
import { COLUMN_SUBTYPE, orderFields, treeKey, type Portfolio } from '@shared/portfolio';
import { engine, fixture } from '../engine/helpers';

const LOCAL = join(process.cwd(), 'test', 'fixtures', 'local', 'Sample Portfolio.pdf');

// ---- reading a saved file back ------------------------------------------------------------------

interface SavedFile {
  readonly key: string;
  readonly name: string;
  readonly description: string | null;
  readonly fields: Record<string, string>;
  /** The PDF object type each `/CI` value was stored as. */
  readonly fieldTypes: Record<string, 'number' | 'string' | 'hex' | 'other'>;
  readonly raw: Uint8Array;
  readonly params: Record<string, string>;
  readonly subtype: string | null;
}

interface SavedPortfolio {
  readonly files: SavedFile[];
  readonly view: string | null;
  readonly sort: { key: string; ascending: boolean } | null;
  readonly initialFile: string | null;
  /** `/Split` — where the file list goes and how much room it has. */
  readonly split: { direction: string; position: number } | null;
  readonly folders: Array<{ id: number; name: string; parentId: number | null }>;
  readonly schema: Array<{ key: string; label: string; subtype: string; visible: boolean }>;
}

const text = (v: unknown): string | null =>
  v instanceof PDFString || v instanceof PDFHexString ? v.decodeText() : null;

async function read(bytes: Uint8Array): Promise<SavedPortfolio> {
  const doc = await PDFDocument.load(bytes, {
    ignoreEncryption: true,
    updateMetadata: false,
    throwOnInvalidObject: false,
  });
  const ctx = doc.context;
  const files: SavedFile[] = [];
  const walk = (node: PDFDict | undefined, depth: number): void => {
    if (!node || depth > 32) return;
    const kids = node.lookupMaybe(PDFName.of('Kids'), PDFArray);
    if (kids) {
      for (const kid of kids.asArray()) walk(ctx.lookupMaybe(kid, PDFDict), depth + 1);
      return;
    }
    const names = node.lookupMaybe(PDFName.of('Names'), PDFArray)?.asArray() ?? [];
    for (let i = 1; i < names.length; i += 2) {
      const key = text(names[i - 1]);
      const spec = ctx.lookupMaybe(names[i], PDFDict);
      if (key === null || !spec) continue;
      const ef = spec.lookupMaybe(PDFName.of('EF'), PDFDict);
      const stream = ef ? ctx.lookup(ef.get(PDFName.of('F'))) : undefined;
      const params: Record<string, string> = {};
      let raw: Uint8Array = new Uint8Array();
      let subtype: string | null = null;
      if (stream instanceof PDFRawStream) {
        raw = stream.contents;
        subtype = stream.dict.lookupMaybe(PDFName.of('Subtype'), PDFName)?.decodeText() ?? null;
        const p = stream.dict.lookupMaybe(PDFName.of('Params'), PDFDict);
        for (const [k, v] of p?.entries() ?? []) params[k.decodeText()] = String(ctx.lookup(v));
      }
      const ci = spec.lookupMaybe(PDFName.of('CI'), PDFDict);
      const fields: Record<string, string> = {};
      const fieldTypes: SavedFile['fieldTypes'] = {};
      for (const [k, v] of ci?.entries() ?? []) {
        const value = ctx.lookup(v);
        const name = k.decodeText();
        fields[name] = value instanceof PDFNumber ? String(value.asNumber()) : (text(value) ?? '');
        fieldTypes[name] =
          value instanceof PDFNumber
            ? 'number'
            : value instanceof PDFHexString
              ? 'hex'
              : value instanceof PDFString
                ? 'string'
                : 'other';
      }
      files.push({
        key,
        name: text(spec.lookup(PDFName.of('UF'))) ?? text(spec.lookup(PDFName.of('F'))) ?? '',
        description: text(spec.lookup(PDFName.of('Desc'))),
        fields,
        fieldTypes,
        raw,
        params,
        subtype,
      });
    }
  };
  walk(
    doc.catalog
      .lookupMaybe(PDFName.of('Names'), PDFDict)
      ?.lookupMaybe(PDFName.of('EmbeddedFiles'), PDFDict),
    0,
  );

  const collection = doc.catalog.lookupMaybe(PDFName.of('Collection'), PDFDict);
  const folders: SavedPortfolio['folders'] = [];
  const walkFolders = (node: PDFDict | undefined, parentId: number | null, depth: number): void => {
    let current = node;
    let guard = 0;
    while (current && depth < 32 && guard++ < 64) {
      const id = current.lookupMaybe(PDFName.of('ID'), PDFNumber)?.asNumber() ?? -1;
      folders.push({ id, name: text(current.lookup(PDFName.of('Name'))) ?? '', parentId });
      walkFolders(current.lookupMaybe(PDFName.of('Child'), PDFDict), id, depth + 1);
      current = current.lookupMaybe(PDFName.of('Next'), PDFDict);
    }
  };
  walkFolders(collection?.lookupMaybe(PDFName.of('Folders'), PDFDict), null, 0);

  const schema: SavedPortfolio['schema'] = [];
  const schemaDict = collection?.lookupMaybe(PDFName.of('Schema'), PDFDict);
  for (const [k, v] of schemaDict?.entries() ?? []) {
    const field = ctx.lookupMaybe(v, PDFDict);
    if (!field) continue;
    schema.push({
      key: k.decodeText(),
      label: text(field.lookup(PDFName.of('N'))) ?? '',
      subtype: field.lookupMaybe(PDFName.of('Subtype'), PDFName)?.decodeText() ?? '',
      visible: field.lookup(PDFName.of('V')) === PDFBool.True,
    });
  }
  const sortDict = collection?.lookupMaybe(PDFName.of('Sort'), PDFDict);
  const sortKey = sortDict?.lookupMaybe(PDFName.of('S'), PDFName)?.decodeText();
  const splitDict = collection?.lookupMaybe(PDFName.of('Split'), PDFDict);
  const split =
    splitDict === undefined
      ? null
      : {
          direction: splitDict.lookupMaybe(PDFName.of('Direction'), PDFName)?.decodeText() ?? '',
          position: splitDict.lookupMaybe(PDFName.of('Position'), PDFNumber)?.asNumber() ?? -1,
        };

  return {
    files,
    view: collection?.lookupMaybe(PDFName.of('View'), PDFName)?.decodeText() ?? null,
    sort:
      sortKey === undefined
        ? null
        : { key: sortKey, ascending: sortDict?.lookup(PDFName.of('A')) !== PDFBool.False },
    initialFile: text(collection?.lookup(PDFName.of('D')) ?? null),
    split,
    folders,
    schema,
  };
}

// ---- building a plan from a portfolio ------------------------------------------------------------

/** The same mapping `buildWritePlan` does, so a test can plan without a whole `Document`. */
function planFor(
  portfolio: Portfolio,
  pageCount: number,
  blobs = new Map<string, Uint8Array>(),
): WritePlan {
  const planned: PlannedPortfolio = {
    view: portfolio.view,
    schema: portfolio.schema.map((c) => ({
      key: c.key,
      label: c.label,
      subtype: COLUMN_SUBTYPE[c.kind],
      order: c.order,
      visible: c.visible,
    })),
    sort: portfolio.sort,
    reorderKey: portfolio.orderKey,
    initialFile: portfolio.initialFile,
    folders: portfolio.folders.map((f) => ({
      id: f.id,
      name: f.name,
      parentId: f.parentId,
      description: f.description,
      created: f.created,
      modified: f.modified,
    })),
    files: [...portfolio.files]
      .sort((a, b) => a.order - b.order)
      .map((file) => ({
        name: file.name,
        folderId: file.folderId,
        description: file.description,
        mimeType: file.mimeType,
        fields: orderFields(file, portfolio.orderKey),
        source:
          file.source.kind === 'embedded'
            ? ({ kind: 'keep', treeKey: file.source.treeKey } as const)
            : ({
                kind: 'bytes',
                bytes: blobs.get(file.id) ?? new Uint8Array(),
                created: file.created,
                modified: file.modified,
              } as const),
      })),
  };
  return { ...emptyWritePlan(pageCount), portfolio: planned };
}

const write = (bytes: Uint8Array, plan: WritePlan): ReturnType<FullRewriteWriter['write']> =>
  new FullRewriteWriter().write({ bytes, plan, options: { objectStreams: false } });

/** Opens a file in the real engine and reads its portfolio the way the service does. */
async function openPortfolio(
  bytes: Uint8Array,
): Promise<{ portfolio: Portfolio; base: Uint8Array; pages: number }> {
  const pdfium = await engine();
  const doc = pdfium.openSync(bytes);
  try {
    const collection = await pdfium.collection(doc);
    const attachments = await pdfium.attachments(doc);
    const portfolio = portfolioFrom(collection, attachments);
    if (portfolio === null) throw new Error('the fixture is not a portfolio');
    return {
      portfolio,
      base: await pdfium.save(doc),
      pages: await pdfium.pageCount(doc),
    };
  } finally {
    await pdfium.close(doc);
  }
}

/** Every embedded stream's raw bytes, by file name. */
async function rawByName(bytes: Uint8Array): Promise<Map<string, Uint8Array>> {
  const saved = await read(bytes);
  return new Map(saved.files.map((f) => [f.name, f.raw]));
}

// ---- the tests ------------------------------------------------------------------------------------

describe('the writer’s portfolio section', () => {
  it('leaves every embedded file byte-identical when a description changes', async () => {
    const original = fixture('portfolio.pdf');
    const before = await rawByName(original);
    const { portfolio, base, pages } = await openPortfolio(original);

    const target = portfolio.files.find((f) => f.name === 'instruction.pdf');
    expect(target).toBeDefined();
    const edited: Portfolio = {
      ...portfolio,
      files: portfolio.files.map((f) =>
        f.id === target?.id ? { ...f, description: 'Signed on the 3rd' } : f,
      ),
    };

    const result = await write(base, planFor(edited, pages));
    expect(result.applied).toContain('portfolio');
    expect(result.warnings).toEqual([]);

    const after = await rawByName(result.bytes);
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    for (const [name, bytes] of before) {
      expect(after.get(name), `${name} is still in the portfolio`).toBeDefined();
      expect(Array.from(after.get(name) ?? []), `${name} is byte-identical`).toEqual(
        Array.from(bytes),
      );
    }
    const saved = await read(result.bytes);
    expect(saved.files.find((f) => f.name === 'instruction.pdf')?.description).toBe(
      'Signed on the 3rd',
    );
  }, 60000);

  it('keeps /Params — size, dates and checksum — exactly as the file had them', async () => {
    const original = fixture('portfolio.pdf');
    const beforeParams = (await read(original)).files;
    const { portfolio, base, pages } = await openPortfolio(original);
    const result = await write(base, planFor(portfolio, pages));
    const afterParams = (await read(result.bytes)).files;
    for (const before of beforeParams) {
      const after = afterParams.find((f) => f.name === before.name);
      expect(after?.params, `${before.name} /Params`).toEqual(before.params);
      expect(after?.subtype, `${before.name} /Subtype`).toBe(before.subtype);
    }
  }, 60000);

  it('writes the folder tree and keys each file with its folder', async () => {
    const original = fixture('portfolio.pdf');
    const { portfolio, base, pages } = await openPortfolio(original);
    const result = await write(base, planFor(portfolio, pages));
    const saved = await read(result.bytes);

    expect(saved.folders).toEqual([
      { id: 0, name: '', parentId: null },
      { id: 1, name: 'Statements', parentId: 0 },
    ]);
    const keys = saved.files.map((f) => f.key).sort();
    expect(keys).toContain(treeKey('january.txt', 1));
    expect(keys).toContain(treeKey('readme.txt', 0));
    // The name tree has to be sorted by key, or a reader's binary search misses entries.
    expect(saved.files.map((f) => f.key)).toEqual([...saved.files.map((f) => f.key)].sort());
  }, 60000);

  it('round-trips the collection: view, sort, initial file and the schema', async () => {
    const original = fixture('portfolio.pdf');
    const { portfolio, base, pages } = await openPortfolio(original);
    const result = await write(base, planFor(portfolio, pages));
    const saved = await read(result.bytes);

    expect(saved.view).toBe('T');
    expect(saved.split).toEqual({ direction: 'V', position: 30 });
    expect(saved.sort).toEqual({ key: 'ynot:Order', ascending: true });
    // `/D` has to be a key of the name tree, or a viewer cannot find the file it names.
    expect(saved.initialFile).toBe(treeKey('instruction.pdf', 0));
    expect(saved.files.map((f) => f.key)).toContain(saved.initialFile);
    expect((await openPortfolio(result.bytes)).portfolio.initialFile).toBe('instruction.pdf');
    expect(saved.schema.find((c) => c.key === 'FileName')?.subtype).toBe('F');
    expect(saved.schema.find((c) => c.key === 'ynot:Order')?.visible).toBe(false);
  }, 60000);

  it('carries the reader’s order in the order column, so a reopen finds it', async () => {
    const original = fixture('portfolio.pdf');
    const { portfolio, base, pages } = await openPortfolio(original);
    // Reverse the order the reader sees.
    const reversed: Portfolio = {
      ...portfolio,
      files: portfolio.files.map((f) => ({ ...f, order: portfolio.files.length - 1 - f.order })),
    };
    const result = await write(base, planFor(reversed, pages));
    const reopened = await openPortfolio(result.bytes);
    const names = [...reopened.portfolio.files]
      .sort((a, b) => a.order - b.order)
      .map((f) => f.name);
    const expected = [...reversed.files].sort((a, b) => a.order - b.order).map((f) => f.name);
    expect(names).toEqual(expected);
  }, 60000);

  it('writes a number column as numbers and a date column as dates, which is what a viewer sorts on', async () => {
    const original = fixture('portfolio.pdf');
    const { portfolio, base, pages } = await openPortfolio(original);
    const target = portfolio.files.find((f) => f.name === 'instruction.pdf');
    expect(target).toBeDefined();
    const due = '2026-03-04T00:00:00.000Z';
    const edited: Portfolio = {
      ...portfolio,
      schema: [
        ...portfolio.schema,
        { key: 'ynot:Due', label: 'Due', kind: 'date', order: 50, visible: true },
        { key: 'ynot:Ref', label: 'Ref', kind: 'number', order: 51, visible: true },
      ],
      files: portfolio.files.map((f) =>
        f.id === target?.id
          ? { ...f, fields: { ...f.fields, 'ynot:Due': due, 'ynot:Ref': '17', 'ynot:Odd': 'n/a' } }
          : f,
      ),
    };
    const result = await write(base, planFor(edited, pages));
    expect(result.warnings).toEqual([]);

    const saved = await read(result.bytes);
    const file = saved.files.find((f) => f.name === 'instruction.pdf');
    expect(file?.fieldTypes['ynot:Ref']).toBe('number');
    expect(file?.fields['ynot:Ref']).toBe('17');
    expect(file?.fieldTypes['ynot:Due']).toBe('string');
    expect(file?.fields['ynot:Due']).toMatch(/^D:20260304/);
    // A value that is not what its column wants is kept as text rather than lost.
    expect(file?.fieldTypes['ynot:Odd']).toBe('hex');
    // Every file's order is a number, not only the edited one's.
    for (const each of saved.files) {
      expect(each.fieldTypes['ynot:Order'], `${each.name} order`).toBe('number');
    }

    // Read back through the engine the date is ISO again, so the grid shows it as a date.
    const reopened = (await openPortfolio(result.bytes)).portfolio;
    const back = reopened.files.find((f) => f.name === 'instruction.pdf');
    expect(Date.parse(back?.fields['ynot:Due'] ?? '')).toBe(Date.parse(due));
    expect(back?.fields['ynot:Ref']).toBe('17');
  }, 60000);

  it('puts the file list down the left for tiles, as Foxit does, unless the file says otherwise', async () => {
    // A tile portfolio with no `/Split` of its own — the fixture with the entry removed.
    const doc = await PDFDocument.load(fixture('portfolio.pdf'), { updateMetadata: false });
    const collection = doc.catalog.lookupMaybe(PDFName.of('Collection'), PDFDict);
    expect(collection).toBeDefined();
    collection?.delete(PDFName.of('Split'));
    const bare = await doc.save({ useObjectStreams: false });
    expect((await read(bare)).split).toBeNull();

    const { portfolio, base, pages } = await openPortfolio(bare);
    expect(portfolio.view).toBe('tile');
    const written = await write(base, planFor(portfolio, pages));
    expect((await read(written.bytes)).split).toEqual({ direction: 'V', position: 30 });

    // A producer's own split is left alone — here the fixture's, widened.
    const doc2 = await PDFDocument.load(fixture('portfolio.pdf'), { updateMetadata: false });
    const split = doc2.catalog
      .lookupMaybe(PDFName.of('Collection'), PDFDict)
      ?.lookupMaybe(PDFName.of('Split'), PDFDict);
    split?.set(PDFName.of('Position'), PDFNumber.of(45));
    const widened = await doc2.save({ useObjectStreams: false });
    const again = await openPortfolio(widened);
    const kept = await write(again.base, planFor(again.portfolio, again.pages));
    expect((await read(kept.bytes)).split).toEqual({ direction: 'V', position: 45 });

    // Details view asks for no split of its own; a viewer lays the table out as it likes.
    const details = await openPortfolio(bare);
    const table = await write(
      details.base,
      planFor({ ...details.portfolio, view: 'details' }, details.pages),
    );
    expect((await read(table.bytes)).view).toBe('D');
    expect((await read(table.bytes)).split).toBeNull();
  }, 60000);

  it('embeds a new file once, with its size, dates and checksum', async () => {
    const original = fixture('portfolio.pdf');
    const { portfolio, base, pages } = await openPortfolio(original);
    const body = new TextEncoder().encode('A note added in this session.\n');
    const added: Portfolio = {
      ...portfolio,
      files: [
        ...portfolio.files,
        {
          id: 'added-1',
          name: 'note.txt',
          folderId: 0,
          description: 'Added later',
          mimeType: 'text/plain',
          size: body.length,
          created: '2026-02-03T10:00:00Z',
          modified: '2026-02-03T10:00:00Z',
          fields: {},
          order: portfolio.files.length,
          source: { kind: 'added' },
        },
      ],
    };
    const blobs = new Map([['added-1', body]]);
    const result = await write(base, planFor(added, pages, blobs));
    const saved = await read(result.bytes);
    const note = saved.files.find((f) => f.name === 'note.txt');

    expect(note).toBeDefined();
    expect(note?.params['Size']).toBe(String(body.length));
    expect(note?.params['CheckSum']).toBeDefined();
    expect(note?.params['CreationDate']).toContain('D:20260203');
    expect(note?.subtype).toBe('text/plain');
    // Flate, once: the raw stream is shorter than the plaintext would be uncompressed only if
    // the content compresses, so assert the filter instead of guessing at sizes.
    const doc = await PDFDocument.load(result.bytes, {
      ignoreEncryption: true,
      updateMetadata: false,
      throwOnInvalidObject: false,
    });
    const walk = doc.context.enumerateIndirectObjects();
    const streams = walk
      .map(([, object]) => object)
      .filter((o): o is PDFRawStream => o instanceof PDFRawStream)
      .filter(
        (o) => o.dict.lookupMaybe(PDFName.of('Type'), PDFName)?.decodeText() === 'EmbeddedFile',
      );
    expect(streams.length).toBe(portfolio.files.length + 1);
  }, 60000);

  it('removes a file’s stream when the plan drops it', async () => {
    const original = fixture('portfolio.pdf');
    const { portfolio, base, pages } = await openPortfolio(original);
    const dropped = portfolio.files.find((f) => f.name === 'people.csv');
    const smaller: Portfolio = {
      ...portfolio,
      files: portfolio.files.filter((f) => f.id !== dropped?.id),
    };
    const result = await write(base, planFor(smaller, pages));
    const saved = await read(result.bytes);

    expect(saved.files.map((f) => f.name)).not.toContain('people.csv');
    const doc = await PDFDocument.load(result.bytes, {
      ignoreEncryption: true,
      updateMetadata: false,
      throwOnInvalidObject: false,
    });
    const embeddedStreams = doc.context
      .enumerateIndirectObjects()
      .map(([, object]) => object)
      .filter((o): o is PDFRawStream => o instanceof PDFRawStream)
      .filter(
        (o) => o.dict.lookupMaybe(PDFName.of('Type'), PDFName)?.decodeText() === 'EmbeddedFile',
      );
    expect(embeddedStreams.length).toBe(portfolio.files.length - 1);
  }, 60000);
});

describe.skipIf(!existsSync(LOCAL))('the operator’s own portfolio', () => {
  it('changes one description and leaves all three embedded files byte-identical', async () => {
    const original = new Uint8Array(readFileSync(LOCAL));
    const before = await rawByName(original);
    expect(before.size).toBeGreaterThan(0);

    const { portfolio, base, pages } = await openPortfolio(original);
    const first = [...portfolio.files].sort((a, b) => a.order - b.order)[0];
    expect(first).toBeDefined();
    const edited: Portfolio = {
      ...portfolio,
      files: portfolio.files.map((f) =>
        f.id === first?.id ? { ...f, description: 'Checked by the operator' } : f,
      ),
    };

    const result = await write(base, planFor(edited, pages));
    expect(result.warnings).toEqual([]);
    const after = await rawByName(result.bytes);
    for (const [name, bytes] of before) {
      expect(Array.from(after.get(name) ?? []), `${name} is byte-identical`).toEqual(
        Array.from(bytes),
      );
    }
    const saved = await read(result.bytes);
    expect(saved.files.find((f) => f.name === first?.name)?.description).toBe(
      'Checked by the operator',
    );
    // Still a portfolio, and still Foxit's own schema, folder and layout.
    expect(saved.view).not.toBeNull();
    expect(saved.folders.length).toBeGreaterThan(0);
    expect(saved.split).toEqual((await read(original)).split);
  }, 120000);

  it('keeps Foxit’s order column as numbers, so Foxit still shows the files in its order', async () => {
    // The regression the operator saw in Foxit: it declares `foxit:Order` as a number column
    // and ignores it once a save has turned the values into strings, so the files came back
    // sorted by name instead of in the order the pack was built in.
    const original = new Uint8Array(readFileSync(LOCAL));
    const before = await read(original);
    const orderKey = before.schema.find((c) => c.subtype === 'N')?.key;
    if (orderKey === undefined) return; // this copy has no order column, so there is nothing to keep
    const numeric = before.files.filter((f) => f.fieldTypes[orderKey] === 'number');
    expect(numeric.length, 'Foxit wrote its order as numbers').toBe(before.files.length);

    const { portfolio, base, pages } = await openPortfolio(original);
    const result = await write(base, planFor(portfolio, pages));
    const after = await read(result.bytes);
    expect(after.sort?.key).toBe(orderKey);
    for (const was of before.files) {
      const now = after.files.find((f) => f.name === was.name);
      expect(now?.fieldTypes[orderKey], `${was.name} order is still a number`).toBe('number');
      expect(now?.fields[orderKey], `${was.name} keeps its place`).toBe(was.fields[orderKey]);
    }
  }, 120000);
});

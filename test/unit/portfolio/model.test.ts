/**
 * The shared portfolio model and the reader (M42, ADR 0014).
 *
 * Pure functions, so these are the cheap tests — but two of them carry real weight. The
 * name-tree key is how a file says which folder it is in, and the order column is how the
 * reader's own order survives a save; both are conventions rather than anything the format
 * enforces, so they are pinned here.
 */

import { describe, expect, it } from 'vitest';
import type { Attachment, PdfCollection } from '@engine/PdfEngine';
import {
  columnValue,
  describePortfolio,
  emptyPortfolio,
  filePath,
  filesInFolder,
  folderPath,
  namesInFolder,
  nextFolderId,
  ORDER_KEY,
  orderFields,
  parseTreeKey,
  reordered,
  ROOT_FOLDER_ID,
  sortedFiles,
  totalSize,
  treeKey,
  uniqueName,
  withoutField,
  type Portfolio,
  type PortfolioFile,
} from '@shared/portfolio';
import { portfolioFrom } from '@modules/M42-portfolios/read';

function file(id: string, patch: Partial<PortfolioFile> = {}): PortfolioFile {
  return {
    id,
    name: `${id}.txt`,
    folderId: ROOT_FOLDER_ID,
    description: null,
    mimeType: 'text/plain',
    size: 10,
    created: null,
    modified: null,
    fields: {},
    order: 0,
    source: { kind: 'added' },
    ...patch,
  };
}

function portfolioWith(files: ReadonlyArray<PortfolioFile>): Portfolio {
  return { ...emptyPortfolio(), files: [...files] };
}

/** The file that must be there. */
function mustFile(file: PortfolioFile | undefined): PortfolioFile {
  if (!file) throw new Error('expected a file');
  return file;
}

/** A read that must have produced a portfolio; the failure names the problem, not a null. */
function must(portfolio: Portfolio | null): Portfolio {
  if (portfolio === null) throw new Error('expected a portfolio');
  return portfolio;
}

describe('the name-tree key', () => {
  it('carries the folder, and reads back as it was written', () => {
    expect(treeKey('note.txt', 0)).toBe('<0>note.txt');
    expect(treeKey('note.txt', 7)).toBe('<7>note.txt');
    expect(parseTreeKey('<7>note.txt')).toEqual({ name: 'note.txt', folderId: 7 });
  });

  it('reads a key with no prefix as a file at the top level', () => {
    // An ordinary attachment in a document that is not a portfolio looks exactly like this.
    expect(parseTreeKey('note.txt')).toEqual({ name: 'note.txt', folderId: ROOT_FOLDER_ID });
  });

  it('keeps a name that happens to contain angle brackets', () => {
    expect(parseTreeKey('<draft> plan.pdf')).toEqual({
      name: '<draft> plan.pdf',
      folderId: ROOT_FOLDER_ID,
    });
  });
});

describe('names', () => {
  it('numbers a duplicate rather than colliding in the name tree', () => {
    expect(uniqueName([], 'a.pdf')).toBe('a.pdf');
    expect(uniqueName(['a.pdf'], 'a.pdf')).toBe('a (2).pdf');
    expect(uniqueName(['a.pdf', 'a (2).pdf'], 'a.pdf')).toBe('a (3).pdf');
  });

  it('compares without regard to case, because a file system does not either', () => {
    expect(uniqueName(['A.PDF'], 'a.pdf')).toBe('a (2).pdf');
  });

  it('ignores the file being renamed when it looks for a clash', () => {
    const portfolio = portfolioWith([
      file('one', { name: 'a.pdf' }),
      file('two', { name: 'b.pdf' }),
    ]);
    expect(namesInFolder(portfolio, ROOT_FOLDER_ID, 'one')).toEqual(['b.pdf']);
  });
});

describe('folders', () => {
  const portfolio: Portfolio = {
    ...emptyPortfolio(),
    folders: [
      { id: 0, name: '', parentId: null, description: null, created: null, modified: null },
      { id: 1, name: 'Statements', parentId: 0, description: null, created: null, modified: null },
      { id: 2, name: '2026', parentId: 1, description: null, created: null, modified: null },
    ],
    files: [file('a', { folderId: 2, name: 'january.txt' })],
  };

  it('joins a path from the root', () => {
    expect(folderPath(portfolio, 0)).toBe('');
    expect(folderPath(portfolio, 2)).toBe('Statements/2026');
  });

  it('gives a file the path it extracts to', () => {
    expect(filePath(portfolio, mustFile(portfolio.files[0]))).toBe('Statements/2026/january.txt');
  });

  it('hands out an id nothing is using', () => {
    expect(nextFolderId(portfolio)).toBe(3);
  });

  it('lists a folder’s own files, in the reader’s order', () => {
    expect(filesInFolder(portfolio, 2).map((f) => f.name)).toEqual(['january.txt']);
    expect(filesInFolder(portfolio, 1)).toHaveLength(0);
  });
});

describe('order', () => {
  it('renumbers from zero in the sequence a drag produces', () => {
    const portfolio = portfolioWith([
      file('a', { order: 0 }),
      file('b', { order: 1 }),
      file('c', { order: 2 }),
    ]);
    const next = reordered(portfolio, ['c', 'a']);
    expect(next.files.map((f) => `${f.id}:${String(f.order)}`)).toEqual(['c:0', 'a:1', 'b:2']);
  });

  it('is written into the order column, which is what survives a save', () => {
    const f = file('a', { order: 4, fields: { Note: 'hello' } });
    expect(orderFields(f, ORDER_KEY)).toEqual({ Note: 'hello', [ORDER_KEY]: '4' });
  });

  it('sorts by the sort column, with empty cells last whichever way the arrow points', () => {
    const portfolio: Portfolio = {
      ...portfolioWith([
        file('a', { name: 'b.txt', order: 0, description: 'Beta' }),
        file('b', { name: 'a.txt', order: 1, description: null }),
        file('c', { name: 'c.txt', order: 2, description: 'Alpha' }),
      ]),
      sort: { key: 'Description', ascending: true },
    };
    expect(sortedFiles(portfolio).map((f) => f.id)).toEqual(['c', 'a', 'b']);
    const down = { ...portfolio, sort: { key: 'Description', ascending: false } };
    expect(sortedFiles(down).map((f) => f.id)).toEqual(['a', 'c', 'b']);
  });

  it('falls back to the reader’s own order when the sort names the order column', () => {
    const portfolio = portfolioWith([file('a', { order: 2 }), file('b', { order: 0 })]);
    expect(sortedFiles(portfolio).map((f) => f.id)).toEqual(['b', 'a']);
  });
});

describe('column values', () => {
  it('reads the file for a standard column and the fields for a custom one', () => {
    const f = file('a', { name: 'x.pdf', size: 2048, fields: { Case: 'A/17' } });
    expect(
      columnValue(f, { key: 'FileName', label: '', kind: 'name', order: 0, visible: true }),
    ).toBe('x.pdf');
    expect(columnValue(f, { key: 'Size', label: '', kind: 'size', order: 0, visible: true })).toBe(
      2048,
    );
    expect(columnValue(f, { key: 'Case', label: '', kind: 'text', order: 0, visible: true })).toBe(
      'A/17',
    );
    expect(
      columnValue(f, { key: 'Gone', label: '', kind: 'text', order: 0, visible: true }),
    ).toBeNull();
  });

  it('drops one column’s value without touching the others', () => {
    expect(withoutField({ a: '1', b: '2' }, 'a')).toEqual({ b: '2' });
  });
});

describe('describing a portfolio', () => {
  it('counts files and folders in words', () => {
    expect(describePortfolio(emptyPortfolio())).toBe('0 files');
    expect(describePortfolio(portfolioWith([file('a')]))).toBe('1 file');
    const withFolder: Portfolio = {
      ...portfolioWith([file('a'), file('b')]),
      folders: [
        { id: 0, name: '', parentId: null, description: null, created: null, modified: null },
        { id: 1, name: 'F', parentId: 0, description: null, created: null, modified: null },
      ],
    };
    expect(describePortfolio(withFolder)).toBe('2 files in 1 folder');
  });

  it('adds up the sizes, and says nothing when no file states one', () => {
    expect(totalSize(portfolioWith([file('a', { size: 10 }), file('b', { size: 5 })]))).toBe(15);
    expect(totalSize(portfolioWith([file('a', { size: null })]))).toBeNull();
  });
});

// ---- the reader -----------------------------------------------------------------------------

function attachment(name: string, patch: Partial<Attachment> = {}): Attachment {
  return { id: `att.${name}`, name, ...patch };
}

const schema: PdfCollection['fields'] = [
  { key: 'FileName', label: 'Name', kind: 'F', order: 0, visible: true },
  { key: 'foxit:Order', label: 'Order', kind: 'N', order: 7, visible: true },
];

describe('reading a collection into the model', () => {
  it('is null for an ordinary document', () => {
    expect(portfolioFrom(null, [])).toBeNull();
  });

  it('keeps the order column the file already uses rather than adding a second', () => {
    const collection: PdfCollection = {
      view: 'details',
      fields: schema,
      folderCount: 0,
      reorderKey: 'foxit:Order',
    };
    const portfolio = portfolioFrom(collection, [
      attachment('b.pdf', { treeKey: '<0>b.pdf', collectionFields: { 'foxit:Order': '1' } }),
      attachment('a.pdf', { treeKey: '<0>a.pdf', collectionFields: { 'foxit:Order': '0' } }),
    ]);
    expect(portfolio?.orderKey).toBe('foxit:Order');
    expect(portfolio?.schema.filter((c) => c.key === 'foxit:Order')).toHaveLength(1);
    expect(sortedFiles(must(portfolio)).map((f) => f.name)).toEqual(['a.pdf', 'b.pdf']);
  });

  it('gives a portfolio with no /Folders a root anyway', () => {
    const portfolio = portfolioFrom({ view: 'tile', fields: [], folderCount: 0 }, []);
    expect(portfolio?.folders).toEqual([
      { id: 0, name: '', parentId: null, description: null, created: null, modified: null },
    ]);
  });

  it('puts a file whose folder is missing at the top level rather than losing it', () => {
    const portfolio = portfolioFrom({ view: 'details', fields: [], folderCount: 0 }, [
      attachment('stray.pdf', { treeKey: '<9>stray.pdf', folderId: 9 }),
    ]);
    expect(portfolio?.files[0]?.folderId).toBe(ROOT_FOLDER_ID);
    expect(portfolio?.files[0]?.name).toBe('stray.pdf');
  });

  it('ignores a /Sort naming a column the schema does not have', () => {
    const portfolio = portfolioFrom(
      { view: 'details', fields: schema, folderCount: 0, sort: { key: 'Nope', ascending: false } },
      [],
    );
    expect(portfolio?.sort?.key).toBe(portfolio?.orderKey);
  });

  it('leaves a page’s file-attachment annotation out of the collection', () => {
    const portfolio = portfolioFrom({ view: 'details', fields: [], folderCount: 0 }, [
      attachment('embedded.pdf', { treeKey: '<0>embedded.pdf' }),
      attachment('on-a-page.pdf', { page: 0 }),
    ]);
    expect(portfolio?.files.map((f) => f.name)).toEqual(['embedded.pdf']);
  });

  it('reads a folder tree and keeps the file in its folder', () => {
    const portfolio = portfolioFrom(
      {
        view: 'details',
        fields: [],
        folderCount: 2,
        folders: [
          { id: 0, name: '', parentId: null },
          { id: 1, name: 'Statements', parentId: 0 },
        ],
      },
      [attachment('january.txt', { treeKey: '<1>january.txt', folderId: 1 })],
    );
    expect(folderPath(must(portfolio), 1)).toBe('Statements');
    expect(portfolio?.files[0]?.folderId).toBe(1);
  });
});

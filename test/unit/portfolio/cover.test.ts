/**
 * The cover sheet and "convert to a single PDF" (M42).
 *
 * Both are pure: given a portfolio and a way to read a file, they produce bytes. That is what
 * lets the cover be regenerated in a batch action later, and it is why these tests need no
 * engine and no window.
 */

import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { emptyPortfolio, type Portfolio, type PortfolioFile } from '@shared/portfolio';
import {
  COVER_TEMPLATE,
  fill,
  formatBytes,
  generateCover,
  toWinAnsi,
} from '@modules/M42-portfolios/cover';
import { convertToSinglePdf } from '@modules/M42-portfolios/merge';
import { engine, fixture } from '../engine/helpers';

function file(name: string, patch: Partial<PortfolioFile> = {}): PortfolioFile {
  return {
    id: name,
    name,
    folderId: 0,
    description: null,
    mimeType: 'application/pdf',
    size: 1024,
    created: '2026-01-01T00:00:00Z',
    modified: '2026-01-01T00:00:00Z',
    fields: {},
    order: 0,
    source: { kind: 'added' },
    ...patch,
  };
}

function portfolioOf(names: ReadonlyArray<string>): Portfolio {
  return {
    ...emptyPortfolio(),
    files: names.map((name, i) => file(name, { order: i, description: `About ${name}` })),
  };
}

/** The text of the generated page, read back through the real engine. */
async function coverText(bytes: Uint8Array): Promise<string> {
  const pdfium = await engine();
  const doc = pdfium.openSync(bytes);
  try {
    const runs = await pdfium.textRuns(doc, 0);
    return runs.map((r) => r.text).join(' ');
  } finally {
    await pdfium.close(doc);
  }
}

describe('the generated cover sheet', () => {
  it('is one page and lists every file with its description and size', async () => {
    const portfolio = portfolioOf(['instruction.pdf', 'people.csv', 'readme.txt']);
    const bytes = await generateCover(portfolio, {
      title: 'Job pack 42',
      date: new Date('2026-03-04T12:00:00Z'),
    });
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(1);

    const text = await coverText(bytes);
    expect(text).toContain('Job pack 42');
    expect(text).toContain('4 March 2026');
    expect(text).toContain('3 files');
    for (const name of ['instruction.pdf', 'people.csv', 'readme.txt']) {
      expect(text, `${name} is on the cover`).toContain(name);
      expect(text).toContain(`About ${name}`);
    }
  }, 60000);

  it('lists the file added since the last one when it is regenerated', async () => {
    const before = portfolioOf(['a.pdf']);
    const after: Portfolio = { ...before, files: [...before.files, file('b.pdf', { order: 1 })] };
    const first = await coverText(await generateCover(before, { title: 'Pack' }));
    const second = await coverText(await generateCover(after, { title: 'Pack' }));
    expect(first).not.toContain('b.pdf');
    expect(second).toContain('a.pdf');
    expect(second).toContain('b.pdf');
  }, 60000);

  it('shows a file’s folder in its name, so the list matches what extraction writes', async () => {
    const portfolio: Portfolio = {
      ...emptyPortfolio(),
      folders: [
        { id: 0, name: '', parentId: null, description: null, created: null, modified: null },
        {
          id: 1,
          name: 'Statements',
          parentId: 0,
          description: null,
          created: null,
          modified: null,
        },
      ],
      files: [file('january.txt', { folderId: 1 })],
    };
    const text = await coverText(await generateCover(portfolio, { title: 'Pack' }));
    expect(text).toContain('Statements/january.txt');
  }, 60000);

  it('says how many files it could not fit rather than stopping quietly', async () => {
    const many = portfolioOf(Array.from({ length: 200 }, (_v, i) => `file-${String(i)}.pdf`));
    const text = await coverText(await generateCover(many, { title: 'Big pack' }));
    expect(text).toMatch(/and \d+ more files/);
  }, 60000);

  it('leaves out a line whose only content is an empty placeholder', () => {
    expect(fill('{subtitle}', { subtitle: '' })).toBe('');
    expect(fill('Prepared {date}', { date: '4 March 2026' })).toBe('Prepared 4 March 2026');
    expect(fill('{unknown}', {})).toBe('{unknown}');
  });

  it('ships a template with the three columns the operator can edit', () => {
    expect(COVER_TEMPLATE.table.columns.map((c) => c.key)).toEqual(['name', 'description', 'size']);
  });

  it('replaces a character the standard fonts cannot draw rather than throwing', () => {
    expect(toWinAnsi('café')).toBe('café');
    expect(toWinAnsi('日本語')).toBe('???');
    expect(toWinAnsi('one… two')).toBe('one… two');
  });

  it('formats sizes in units a reader reads', () => {
    expect(formatBytes(512)).toBe('512 bytes');
    expect(formatBytes(2048)).toBe('2.0 kB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
  });
});

describe('convert to a single PDF', () => {
  it('puts the pages of every embedded PDF in the portfolio’s own order', async () => {
    const twoPage = fixture('multipage.pdf');
    const onePage = fixture('blank.pdf');
    const portfolio = portfolioOf(['second.pdf', 'first.pdf']);
    const reordered: Portfolio = {
      ...portfolio,
      files: portfolio.files.map((f) => ({ ...f, order: f.name === 'first.pdf' ? 0 : 1 })),
    };
    const bytes = new Map([
      ['second.pdf', twoPage],
      ['first.pdf', onePage],
    ]);
    const result = await convertToSinglePdf(reordered, (f) =>
      Promise.resolve(bytes.get(f.name) ?? null),
    );
    expect(result.merged).toEqual(['first.pdf', 'second.pdf']);
    const doc = await PDFDocument.load(result.bytes);
    expect(doc.getPageCount()).toBe(1 + 5);
  }, 60000);

  it('names the files it could not merge instead of dropping them quietly', async () => {
    const portfolio = portfolioOf(['notes.txt', 'real.pdf']);
    const result = await convertToSinglePdf(portfolio, (f) =>
      Promise.resolve(
        f.name === 'real.pdf' ? fixture('blank.pdf') : new TextEncoder().encode('hi'),
      ),
    );
    expect(result.merged).toEqual(['real.pdf']);
    expect(result.skipped).toEqual(['notes.txt']);
  }, 60000);

  it('still produces a readable document when nothing could be merged', async () => {
    const portfolio = portfolioOf(['notes.txt']);
    const result = await convertToSinglePdf(portfolio, () =>
      Promise.resolve(new TextEncoder().encode('not a pdf')),
    );
    const doc = await PDFDocument.load(result.bytes);
    expect(doc.getPageCount()).toBe(1);
    expect(result.skipped).toEqual(['notes.txt']);
  }, 60000);
});

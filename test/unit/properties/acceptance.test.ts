/**
 * M72's acceptance tests, at the level they can honestly be made in a unit test: the whole real
 * pipeline — PDFium opens the file, the model changes, the plan is built, the writer writes, and
 * PDFium opens the result — with no fakes anywhere (ADR 0017).
 *
 * The three claims from the brief:
 *
 * 1. Set the title, the author, the keywords and a custom property, save, reopen: the information
 *    dictionary and the XMP packet agree, and the engine's own metadata read confirms it.
 * 2. Set "Fit page, Bookmarks panel, page 3", save, reopen: the file asks for exactly that.
 * 3. The Fonts tab lists what `fonts.pdf` actually carries — the third is in
 *    `test/unit/engine/corpus.test.ts`, against the expected list in the fixture manifest, because
 *    that is where every other per-fixture expectation lives.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Document } from '@core/Document';
import { FullRewriteWriter } from '@engine/writers/FullRewriteWriter';
import { readXmp } from '@engine/xmp';
import { buildWritePlan } from '@modules/M21-save/plan';
import {
  SetInitialViewCommand,
  SetPropertiesCommand,
} from '@modules/M72-properties-metadata/commands';
import { engine, FIXTURES } from '../engine/helpers';
import { compareDocuments, describeDocument, summarise } from '../roundtrip';

function fixtureBytes(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(FIXTURES, name)));
}

/** Runs the save pipeline over a document and returns the bytes it would have written. */
async function saveThrough(doc: Document): Promise<Uint8Array> {
  const { plan, warnings } = buildWritePlan(doc);
  expect(warnings).toEqual([]);
  const base = await doc.engine.save(doc.handle);
  const result = await new FullRewriteWriter().write({ bytes: base, plan });
  expect(result.warnings).toEqual([]);
  return result.bytes;
}

describe('properties survive a save', () => {
  it('writes the title, author, keywords and a custom property into both the Info dictionary and the XMP', async () => {
    const eng = await engine();
    const doc = await Document.open(eng, fixtureBytes('multipage.pdf'));
    await doc.apply(
      new SetPropertiesCommand(doc, {
        title: 'Quarterly report',
        author: 'A Writer; Another Writer',
        keywords: 'quarter; report; 2026',
        subject: 'The numbers',
        custom: { Department: 'Accounts', Reference: 'INV-2026-0042' },
        trapped: 'False',
        lang: 'en-GB',
      }),
    );
    const saved = await saveThrough(doc);
    await doc.close();

    const reopened = await eng.open(saved);
    try {
      const meta = await eng.metadata(reopened);
      expect(meta.title).toBe('Quarterly report');
      expect(meta.author).toBe('A Writer; Another Writer');
      expect(meta.keywords).toBe('quarter; report; 2026');
      expect(meta.subject).toBe('The numbers');
      expect(meta.custom).toEqual({ Department: 'Accounts', Reference: 'INV-2026-0042' });
      expect(meta.trapped).toBe('False');
      expect(meta.lang).toBe('en-GB');

      // The two views of the same facts agree — which is the whole point of the module.
      const xmp = readXmp(meta.xmp);
      expect(xmp.title).toBe(meta.title);
      expect(xmp.author).toBe(meta.author);
      expect(xmp.subject).toBe(meta.subject);
      expect(xmp.keywords).toBe(meta.keywords);
      expect(xmp.trapped).toBe(meta.trapped);
      expect(xmp.custom).toEqual(meta.custom);
    } finally {
      await eng.close(reopened);
    }
  });

  it('removes a property the reader cleared, from the dictionary and the packet alike', async () => {
    const eng = await engine();
    const doc = await Document.open(eng, fixtureBytes('initial-view.pdf'));
    expect(doc.state.metadata.custom).toHaveProperty('Reference');
    await doc.apply(
      new SetPropertiesCommand(doc, {
        title: null,
        custom: { Department: 'Accounts' },
      }),
    );
    const saved = await saveThrough(doc);
    await doc.close();

    const reopened = await eng.open(saved);
    try {
      const meta = await eng.metadata(reopened);
      expect(meta.title).toBeUndefined();
      expect(meta.custom).toEqual({ Department: 'Accounts' });
      const xmp = readXmp(meta.xmp);
      expect(xmp.title).toBeUndefined();
      expect(xmp.custom).toEqual({ Department: 'Accounts' });
    } finally {
      await eng.close(reopened);
    }
  });

  it('leaves a PDF/A identification block where it was', async () => {
    const eng = await engine();
    const doc = await Document.open(eng, fixtureBytes('pdfa-1b.pdf'));
    await doc.apply(new SetPropertiesCommand(doc, { title: 'Renamed but still PDF/A-shaped' }));
    const saved = await saveThrough(doc);
    await doc.close();

    const reopened = await eng.open(saved);
    try {
      const meta = await eng.metadata(reopened);
      expect(meta.xmp).toContain('pdfaid:part');
      expect(readXmp(meta.xmp).title).toBe('Renamed but still PDF/A-shaped');
    } finally {
      await eng.close(reopened);
    }
  });
});

describe('the initial view survives a save', () => {
  it('reopens with fit page, the bookmarks panel and page 3', async () => {
    const eng = await engine();
    const doc = await Document.open(eng, fixtureBytes('multipage.pdf'));
    const thirdPage = doc.state.pages[2];
    expect(thirdPage).toBeDefined();
    await doc.apply(
      new SetInitialViewCommand(doc, {
        pageMode: 'outlines',
        initialPageId: thirdPage?.id ?? null,
        initialFit: 'fit',
      }),
    );
    const saved = await saveThrough(doc);
    await doc.close();

    // Reopened as a whole document, so the model's own reading is what is checked — the same
    // path that decides what the application does when a reader opens the file.
    const reopened = await Document.open(eng, saved);
    try {
      expect(reopened.state.view.pageMode).toBe('outlines');
      expect(reopened.state.view.initialFit).toBe('fit');
      const target = reopened.state.pages.findIndex(
        (p) => p.id === reopened.state.view.initialPageId,
      );
      expect(target).toBe(2);
    } finally {
      await reopened.close();
    }
  });

  it('keeps every viewer preference the file already had', async () => {
    const eng = await engine();
    const original = fixtureBytes('initial-view.pdf');
    const doc = await Document.open(eng, original.slice());
    await doc.apply(new SetInitialViewCommand(doc, { centreWindow: true }));
    const saved = await saveThrough(doc);
    await doc.close();

    const view = await eng.open(saved).then(async (handle) => {
      const result = await eng.initialView(handle);
      await eng.close(handle);
      return result;
    });
    expect(view).toMatchObject({
      pageMode: 'outlines',
      pageLayout: 'two-column-left',
      hideToolbar: true,
      displayDocTitle: true,
      printScaling: 'none',
      direction: 'r2l',
      centreWindow: true,
    });
    expect(view.openAction).toMatchObject({ page: 2, fit: 'fit' });
  });

  it('does not touch the view of a document nobody changed', async () => {
    const eng = await engine();
    const original = fixtureBytes('initial-view.pdf');
    const doc = await Document.open(eng, original.slice());
    const saved = await saveThrough(doc);
    await doc.close();
    const differences = await compareDocuments(eng, original, saved);
    expect(differences, summarise(differences)).toEqual([]);
  });
});

describe('the fonts a document carries', () => {
  it('are the ones the file declares, embedded status and all', async () => {
    const eng = await engine();
    const handle = await eng.open(fixtureBytes('fonts.pdf'));
    try {
      const fonts = await eng.fonts(handle);
      expect(fonts.map((f) => f.name)).toEqual([
        'Helvetica',
        'YnotBox',
        'ABCDEF+YnotBox',
        'Arial',
        'GHIJKL+YnotBox',
        'YnotBlock',
      ]);
      expect(fonts.filter((f) => f.embedded).map((f) => f.name)).toEqual([
        'YnotBox',
        'ABCDEF+YnotBox',
        'GHIJKL+YnotBox',
        'YnotBlock',
      ]);
      expect(fonts.filter((f) => f.subset).map((f) => f.name)).toEqual([
        'ABCDEF+YnotBox',
        'GHIJKL+YnotBox',
      ]);
    } finally {
      await eng.close(handle);
    }
  });

  it('survive a save unchanged', async () => {
    const eng = await engine();
    const original = fixtureBytes('fonts.pdf');
    const doc = await Document.open(eng, original.slice());
    await doc.apply(new SetPropertiesCommand(doc, { title: 'Still the same fonts' }));
    const saved = await saveThrough(doc);
    await doc.close();

    const before = await eng.open(original.slice());
    const after = await eng.open(saved);
    try {
      const a = await describeDocument(eng, before, { text: false });
      const b = await describeDocument(eng, after, { text: false });
      expect(b.fonts).toEqual(a.fonts);
    } finally {
      await eng.close(before);
      await eng.close(after);
    }
  });
});

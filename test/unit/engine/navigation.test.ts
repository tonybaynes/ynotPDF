/**
 * The engine half of M12 (ADR 0011), against real PDFium: optional-content visibility,
 * embedded-file editing and the `/Collection` read that makes a PDF Portfolio a portfolio.
 *
 * Every assertion is paired with a re-render or a re-read. A layer that says it is hidden while
 * the raster still draws it is exactly the bug this file exists to catch.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { EngineError, type DocHandle } from '@engine/PdfEngine';
import type { PdfiumEngine } from '@engine/pdfium/PdfiumEngine';
import { dhash, engine, fixture, hamming } from './helpers';

const LOCAL = join(process.cwd(), 'test', 'fixtures', 'local');
const PORTFOLIO = join(LOCAL, 'Sample Portfolio.pdf');

let pdfium: PdfiumEngine;

beforeAll(async () => {
  pdfium = await engine();
});

async function withDoc<T>(name: string, fn: (doc: DocHandle) => Promise<T> | T): Promise<T> {
  const doc = pdfium.openSync(fixture(name));
  try {
    return await fn(doc);
  } finally {
    await pdfium.close(doc);
  }
}

describe('layer visibility (setLayerVisible)', () => {
  it('hiding a layer changes the render, and showing it puts the page back', async () => {
    await withDoc('layers.pdf', async (doc) => {
      const layers = await pdfium.layers(doc);
      expect(layers.length).toBeGreaterThanOrEqual(2);
      const before = dhash(await pdfium.renderRaw(doc, 0, 1));

      const target = layers[0];
      if (!target) throw new Error('no layer');
      await pdfium.setLayerVisible(doc, target.id, false);
      const hidden = dhash(await pdfium.renderRaw(doc, 0, 1));
      expect(hamming(before, hidden)).toBeGreaterThan(0);

      await pdfium.setLayerVisible(doc, target.id, true);
      expect(dhash(await pdfium.renderRaw(doc, 0, 1))).toBe(before);
    });
  });

  it('survives the page cache: a reloaded page is still drawn without the layer', async () => {
    await withDoc('layers.pdf', async (doc) => {
      const [layer] = await pdfium.layers(doc);
      if (!layer) throw new Error('no layer');
      const before = dhash(await pdfium.renderRaw(doc, 0, 1));
      await pdfium.setLayerVisible(doc, layer.id, false);
      const hidden = dhash(await pdfium.renderRaw(doc, 0, 1));
      // Force the page out of the cache the way a structural edit would.
      await pdfium.setPageRotation(doc, 0, 0);
      expect(dhash(await pdfium.renderRaw(doc, 0, 1))).toBe(hidden);
      expect(hamming(before, hidden)).toBeGreaterThan(0);
    });
  });

  it('leaves the bytes alone — a save after hiding still carries both layers', async () => {
    const saved = await withDoc('layers.pdf', async (doc) => {
      const [layer] = await pdfium.layers(doc);
      if (!layer) throw new Error('no layer');
      await pdfium.setLayerVisible(doc, layer.id, false);
      return await pdfium.save(doc);
    });
    const reopened = pdfium.openSync(saved);
    try {
      expect((await pdfium.layers(reopened)).length).toBeGreaterThanOrEqual(2);
    } finally {
      await pdfium.close(reopened);
    }
  });

  it('rejects a layer id the document does not have', async () => {
    await withDoc('layers.pdf', async (doc) => {
      await expect(pdfium.setLayerVisible(doc, 'ocg.99999', false)).rejects.toBeInstanceOf(
        EngineError,
      );
    });
  });
});

describe('attachments (add / update / delete)', () => {
  const bytes = new TextEncoder().encode('hello from M12');

  it('adds an embedded file with a description and reads it back', async () => {
    await withDoc('blank.pdf', async (doc) => {
      const added = await pdfium.addAttachment(doc, {
        name: 'note.txt',
        bytes,
        description: 'A note',
        mimeType: 'text/plain',
      });
      expect(added.name).toBe('note.txt');
      const list = await pdfium.attachments(doc);
      const found = list.find((a) => a.name === 'note.txt');
      expect(found?.description).toBe('A note');
      expect(found?.mimeType).toBe('text/plain');
      expect(found?.size).toBe(bytes.length);
      const data = await pdfium.attachmentData(doc, added.id);
      expect(new TextDecoder().decode(data)).toBe('hello from M12');
    });
  });

  it('survives a save and reopen', async () => {
    const saved = await withDoc('blank.pdf', async (doc) => {
      await pdfium.addAttachment(doc, { name: 'note.txt', bytes, description: 'A note' });
      return await pdfium.save(doc);
    });
    const reopened = pdfium.openSync(saved);
    try {
      const list = await pdfium.attachments(reopened);
      expect(list.map((a) => a.name)).toContain('note.txt');
      expect(list.find((a) => a.name === 'note.txt')?.description).toBe('A note');
    } finally {
      await pdfium.close(reopened);
    }
  });

  it('changes a description without touching the bytes', async () => {
    await withDoc('attachments.pdf', async (doc) => {
      const [first] = await pdfium.attachments(doc);
      if (!first) throw new Error('fixture has no attachments');
      const data = await pdfium.attachmentData(doc, first.id);
      const updated = await pdfium.updateAttachment(doc, first.id, { description: 'Edited' });
      expect(updated.description).toBe('Edited');
      expect(await pdfium.attachmentData(doc, first.id)).toEqual(data);
    });
  });

  it('renames by re-embedding, keeping the bytes and the description', async () => {
    await withDoc('attachments.pdf', async (doc) => {
      const [first] = await pdfium.attachments(doc);
      if (!first) throw new Error('fixture has no attachments');
      await pdfium.updateAttachment(doc, first.id, { description: 'Kept' });
      const data = await pdfium.attachmentData(doc, first.id);
      const renamed = await pdfium.updateAttachment(doc, first.id, { name: 'renamed.bin' });
      expect(renamed.name).toBe('renamed.bin');
      expect(renamed.description).toBe('Kept');
      expect(await pdfium.attachmentData(doc, renamed.id)).toEqual(data);
      expect((await pdfium.attachments(doc)).map((a) => a.name)).not.toContain(first.name);
    });
  });

  it('deletes one and leaves the other', async () => {
    await withDoc('attachments.pdf', async (doc) => {
      const before = await pdfium.attachments(doc);
      expect(before.length).toBe(2);
      const victim = before[0];
      if (!victim) throw new Error('fixture has no attachments');
      await pdfium.deleteAttachment(doc, victim.id);
      const after = await pdfium.attachments(doc);
      expect(after.length).toBe(1);
      expect(after.map((a) => a.name)).not.toContain(victim.name);
    });
  });

  it('refuses to edit a file-attachment annotation through the embedded-file API', async () => {
    await withDoc('blank.pdf', async (doc) => {
      await expect(pdfium.deleteAttachment(doc, 'annot.0.0')).rejects.toBeInstanceOf(EngineError);
    });
  });
});

describe('collection (PDF Portfolio)', () => {
  it('an ordinary document has none', async () => {
    await withDoc('attachments.pdf', async (doc) => {
      expect(await pdfium.collection(doc)).toBeNull();
    });
  });

  // The operator's real portfolio; git-ignored, so CI and other machines skip this.
  it.skipIf(!existsSync(PORTFOLIO))(
    'reads the schema, the view and the per-file values of a real portfolio',
    async () => {
      const doc = pdfium.openSync(new Uint8Array(readFileSync(PORTFOLIO)));
      try {
        const collection = await pdfium.collection(doc);
        expect(collection).not.toBeNull();
        expect(collection?.fields.length).toBeGreaterThan(0);
        // Sorted by /O, and the file-name column comes first in a Foxit-made portfolio.
        const orders = collection?.fields.map((f) => f.order) ?? [];
        expect([...orders].sort((a, b) => a - b)).toEqual(orders);
        expect(collection?.fields.some((f) => f.kind === 'F')).toBe(true);
        const attachments = await pdfium.attachments(doc);
        expect(attachments.length).toBe(3);
        expect(attachments.every((a) => a.name.toLowerCase().endsWith('.pdf'))).toBe(true);
        // Every embedded file carries the custom `/CI` column this portfolio sorts on.
        expect(attachments.every((a) => Object.keys(a.collectionFields ?? {}).length > 0)).toBe(
          true,
        );
        // The cover sheet is the document's own page.
        expect(await pdfium.pageCount(doc)).toBeGreaterThanOrEqual(1);
      } finally {
        await pdfium.close(doc);
      }
    },
  );
});

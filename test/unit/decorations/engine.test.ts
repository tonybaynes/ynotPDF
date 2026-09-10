/**
 * Decorations against real PDFium and the real writer (M53, ADR 0020).
 *
 * The acceptance lines live here in their engine form: a header whose text really is in the page,
 * a Bates run that is sequential and searchable, and a watermark that renders *under* the page's
 * own text. The module's e2e journey then proves a person can reach all three.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import type { DocHandle } from '@engine/PdfEngine';
import type { PdfiumEngine } from '@engine/pdfium/PdfiumEngine';
import { FullRewriteWriter } from '@engine/writers/FullRewriteWriter';
import { emptyWritePlan, type PlannedDecoration, type WritePlan } from '@engine/Writer';
import { drawDecoration } from '@engine/decorations/draw';
import {
  DEFAULT_MARGINS,
  type BatesSpec,
  type DecorationSpec,
  type HeaderFooterSpec,
  type PageContext,
  type WatermarkSpec,
} from '@engine/decorations/types';
import { engine, fixture, inkCoverage } from '../engine/helpers';

let pdfium: PdfiumEngine;

beforeAll(async () => {
  pdfium = await engine();
});

const DOCUMENT = {
  fileName: 'multipage.pdf',
  fullPath: '/tmp/multipage.pdf',
  title: 'Fixture',
  author: 'Tests',
  subject: '',
  pageCount: 5,
  labels: [] as ReadonlyArray<string>,
  now: '2026-09-11T09:24:00.000Z',
};

const HEADER: HeaderFooterSpec = {
  kind: 'header-footer',
  zones: { 'footer-centre': '<<1 of n>>' },
  font: 'Helvetica',
  size: 10,
  colour: 0x000000,
  margins: DEFAULT_MARGINS,
  underline: false,
  shrink: 0,
  startNumber: 1,
  totalOverride: 0,
};

async function pageContexts(doc: DocHandle, count: number): Promise<PageContext[]> {
  const out: PageContext[] = [];
  for (let i = 0; i < count; i++) {
    const size = await pdfium.pageSize(doc, i);
    out.push({
      index: i,
      ordinal: i + 1,
      rangeCount: count,
      box: size.cropBox,
      rotation: size.rotation,
      document: { ...DOCUMENT, pageCount: count },
    });
  }
  return out;
}

/** Applies one decoration to every page of an open document, through the engine. */
async function apply(doc: DocHandle, spec: DecorationSpec, id = 'd1'): Promise<void> {
  const count = await pdfium.pageCount(doc);
  const contexts = await pageContexts(doc, count);
  for (const page of contexts) {
    const { draw } = drawDecoration(id, spec, { page });
    await pdfium.setDecorations(doc, page.index, draw ? [draw] : []);
  }
}

async function textOf(doc: DocHandle, page: number): Promise<string> {
  const runs = await pdfium.textRuns(doc, page);
  return runs.map((r) => r.text).join(' ');
}

describe('headers and footers', () => {
  it('puts "k of n" on every page, and takes it off again', async () => {
    const doc = pdfium.openSync(fixture('multipage.pdf'));
    try {
      const count = await pdfium.pageCount(doc);
      const before: string[] = [];
      for (let i = 0; i < count; i++) before.push(await textOf(doc, i));
      await apply(doc, HEADER);
      for (let i = 0; i < count; i++) {
        expect(await textOf(doc, i)).toContain(`${String(i + 1)} of ${String(count)}`);
      }
      // The same call with nothing in it is "remove".
      for (let i = 0; i < count; i++) await pdfium.setDecorations(doc, i, []);
      for (let i = 0; i < count; i++) expect(await textOf(doc, i)).toBe(before[i]);
    } finally {
      await pdfium.close(doc);
    }
  });

  it('survives a save and comes back as a marker that names its own settings', async () => {
    const doc = pdfium.openSync(fixture('multipage.pdf'));
    let saved: Uint8Array;
    try {
      await apply(doc, HEADER, 'dec-7');
      saved = await pdfium.save(doc);
    } finally {
      await pdfium.close(doc);
    }
    const re = pdfium.openSync(saved);
    try {
      expect(await textOf(re, 2)).toContain('3 of 5');
      const found = await pdfium.decorations(re, 2);
      expect(found).toHaveLength(1);
      expect(found[0]?.id).toBe('dec-7');
      expect(found[0]?.kind).toBe('header-footer');
      expect(JSON.parse(found[0]?.spec ?? '{}')).toMatchObject({ kind: 'header-footer' });
    } finally {
      await pdfium.close(re);
    }
  });

  it('draws the header at the top of the page as the reader sees it, whatever /Rotate says', async () => {
    const doc = pdfium.openSync(fixture('rotated.pdf'));
    try {
      const count = await pdfium.pageCount(doc);
      const bands: Array<{ top: number; bottom: number }> = [];
      for (let page = 0; page < count; page++) bands.push(await inkBands(doc, page));
      await apply(doc, { ...HEADER, size: 18, zones: { 'header-left': 'TOP' } });
      for (let page = 0; page < count; page++) {
        const before = bands[page];
        const after = await inkBands(doc, page);
        const rotation = (await pdfium.pageSize(doc, page)).rotation;
        const where = `page ${String(page)} at ${String(rotation)}°`;
        // The render already has `/Rotate` applied, so "the top of the image" is what a reader
        // calls the top of the page. The header has to be there, and the bottom untouched.
        expect(after.top, `${where}: nothing new at the top`).toBeGreaterThan(
          (before?.top ?? 0) + 0.0005,
        );
        expect(after.bottom, `${where}: the bottom changed`).toBeCloseTo(before?.bottom ?? 0, 4);
      }
    } finally {
      await pdfium.close(doc);
    }
  });
});

describe('Bates numbering', () => {
  it('runs 000123 upwards and is findable as text', async () => {
    const spec: BatesSpec = {
      kind: 'bates',
      prefix: 'ACME',
      suffix: '',
      digits: 6,
      startAt: 123,
      zone: 'footer-right',
      font: 'Courier',
      size: 9,
      colour: 0x000000,
      margins: DEFAULT_MARGINS,
    };
    const doc = pdfium.openSync(fixture('multipage.pdf'));
    try {
      await apply(doc, spec);
      const count = await pdfium.pageCount(doc);
      for (let i = 0; i < count; i++) {
        expect(await textOf(doc, i)).toContain(`ACME${String(123 + i).padStart(6, '0')}`);
      }
    } finally {
      await pdfium.close(doc);
    }
  });
});

describe('watermarks', () => {
  const spec: WatermarkSpec = {
    kind: 'watermark',
    source: { kind: 'text', text: 'DRAFT' },
    font: 'Helvetica-Bold',
    size: 48,
    colour: 0x808080,
    rotation: 45,
    scale: 0.7,
    position: 'centre',
    offsetX: 0,
    offsetY: 0,
    behind: true,
    print: true,
    screen: true,
  };

  it('goes under the page content when it is behind, and over it when it is not', async () => {
    const doc = pdfium.openSync(fixture('text.pdf'));
    try {
      await apply(doc, spec);
      const objects = await pdfium.pageObjects(doc, 0);
      expect(objects[0]?.kind).toBe('form');
      await apply(doc, { ...spec, behind: false });
      const after = await pdfium.pageObjects(doc, 0);
      expect(after[after.length - 1]?.kind).toBe('form');
    } finally {
      await pdfium.close(doc);
    }
  });

  it('adds ink to the page, and removing it puts the raster back', async () => {
    const doc = pdfium.openSync(fixture('blank.pdf'));
    try {
      const size = await pdfium.pageSize(doc, 0);
      const whole = { x: 0, y: 0, width: size.width, height: size.height };
      const before = inkCoverage(await pdfium.renderRaw(doc, 0, 1), whole, 220);
      expect(before).toBe(0);
      await apply(doc, spec);
      expect(inkCoverage(await pdfium.renderRaw(doc, 0, 1), whole, 220)).toBeGreaterThan(0);
      await pdfium.setDecorations(doc, 0, []);
      expect(inkCoverage(await pdfium.renderRaw(doc, 0, 1), whole, 220)).toBe(0);
    } finally {
      await pdfium.close(doc);
    }
  });
});

describe('the writer', () => {
  it('appends a stream instead of editing the page, and a second save is idempotent', async () => {
    const doc = pdfium.openSync(fixture('multipage.pdf'));
    let planned: PlannedDecoration[] = [];
    let base: Uint8Array;
    let original: { content: string; resources: string };
    try {
      const contexts = await pageContexts(doc, await pdfium.pageCount(doc));
      const page = contexts[0];
      if (!page) throw new Error('no page');
      const content = await pdfium.pageContent(doc, 0);
      original = { content: toBase64(content.content), resources: content.resources };
      const { draw } = drawDecoration('d1', HEADER, { page });
      if (draw) planned = [draw];
      base = await pdfium.save(doc);
    } finally {
      await pdfium.close(doc);
    }

    const plan: WritePlan = {
      ...emptyWritePlan(5),
      pages: [
        { source: 0, decorations: { original, items: planned } },
        { source: 1 },
        { source: 2 },
        { source: 3 },
        { source: 4 },
      ],
    };
    const first = await new FullRewriteWriter().write({ bytes: base, plan });
    expect(first.applied).toContain('decorations');

    const doc2 = pdfium.openSync(first.bytes);
    try {
      expect(await textOf(doc2, 0)).toContain('1 of 5');
      expect(await pdfium.decorations(doc2, 0)).toHaveLength(1);
      // The other pages were not planned, so nothing was written to them.
      expect(await pdfium.decorations(doc2, 1)).toHaveLength(0);
    } finally {
      await pdfium.close(doc2);
    }

    // Saving the same plan again must not leave two headers on the page.
    const second = await new FullRewriteWriter().write({ bytes: first.bytes, plan });
    const doc3 = pdfium.openSync(second.bytes);
    try {
      expect(await pdfium.decorations(doc3, 0)).toHaveLength(1);
      expect(await textOf(doc3, 0)).toContain('1 of 5');
    } finally {
      await pdfium.close(doc3);
    }
  });
});

/** Ink in the top and bottom tenths of a page as it is displayed. */
async function inkBands(doc: DocHandle, page: number): Promise<{ top: number; bottom: number }> {
  const render = await pdfium.renderRaw(doc, page, 1);
  const band = Math.max(1, Math.round(render.height * 0.1));
  return {
    top: inkCoverage(render, { x: 0, y: 0, width: render.width, height: band }, 220),
    bottom: inkCoverage(
      render,
      { x: 0, y: render.height - band, width: render.width, height: band },
      220,
    ),
  };
}

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

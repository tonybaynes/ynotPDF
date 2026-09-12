import { beforeAll, describe, expect, it, vi } from 'vitest';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFStream, degrees } from 'pdf-lib';
import { printToPdf } from '@modules/M13-select-find-print/print/printToPdf';
import { bakePrintAppearances } from '@modules/M13-select-find-print/print/appearances';
import { imposePages, DEFAULT_IMPOSITION } from '@modules/M13-select-find-print/print/imposition';
import { must } from './helpers';
import { engine } from '../engine/helpers';
import { Document } from '@core/Document';
import { AddAnnotationCommand, draftAnnotation, DEFAULT_ANNOTATION_FLAGS } from '@core/commands';
import { printSnapshot } from '@modules/M13-select-find-print/print/snapshot';

let pdfium: Awaited<ReturnType<typeof engine>>;
beforeAll(async () => {
  pdfium = await engine();
});

/** Distinct, searchable appearances: catches loss, wrong state, duplicate drawing and rotation. */
async function fixture(rotation = 0): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([300, 400]);
  page.setMediaBox(-30, -20, 300, 400);
  page.setCropBox(10, 20, 220, 300);
  page.setRotation(degrees(rotation));
  page.drawText('Page content', { x: 20, y: 290, size: 12 });
  const font = await doc.embedFont('Helvetica');
  const ap = (text: string) =>
    doc.context.register(
      doc.context.flateStream(`0 g BT /F 10 Tf 2 5 Td (${text}) Tj ET`, {
        Type: 'XObject',
        Subtype: 'Form',
        BBox: [0, 0, 180, 20],
        Resources: { Font: { F: font.ref } },
      }),
    );
  const add = (text: string, flags: number, y: number, subtype = 'Stamp') => {
    const dict = doc.context.obj({
      Type: 'Annot',
      Subtype: subtype,
      Rect: [20, y, 200, y + 20],
      F: flags,
      AP: { N: ap(text) },
    });
    page.node.addAnnot(doc.context.register(dict));
  };
  add('Printable stamp', 4, 250);
  add('Screen only', 0, 225);
  add('Hidden mark', 6, 200);
  add('Print only', 36, 175);
  add('Unknown appearance', 4, 150, 'FutureAnnotation');
  add('Link appearance', 4, 125, 'Link');
  const field = doc.getForm().createTextField('name');
  field.setText('Current field value');
  field.addToPage(page, { x: 20, y: 70, width: 180, height: 25 });
  const check = doc.getForm().createCheckBox('checked');
  check.addToPage(page, { x: 20, y: 35, width: 20, height: 20 });
  check.check();
  return doc.save();
}

async function printed(bytes: Uint8Array, annotations = true, forms = true) {
  const handle = await pdfium.open(bytes);
  try {
    const size = await pdfium.pageSize(handle, 0);
    const sheets = imposePages([{ index: 0, ...size }], {
      ...DEFAULT_IMPOSITION,
      paper: size,
      autoRotate: false,
      scaling: 'actual',
    });
    return await printToPdf({
      engine: pdfium,
      doc: handle,
      bytes,
      sheets,
      asImage: false,
      render: { dpi: 72, annotations, forms, grayscale: false },
    });
  } finally {
    await pdfium.close(handle);
  }
}

async function textOf(bytes: Uint8Array): Promise<string> {
  const handle = await pdfium.open(bytes);
  try {
    return (await pdfium.textRuns(handle, 0)).map((r) => r.text).join('');
  } finally {
    await pdfium.close(handle);
  }
}

describe('vector print appearances', () => {
  it('materialises an unsaved writer-only annotation without changing the source or undo history', async () => {
    const pdf = await PDFDocument.create();
    pdf.addPage([300, 400]).drawText('Original text', { x: 30, y: 350 });
    const doc = await Document.open(pdfium, await pdf.save());
    try {
      const page = must(doc.state.pages[0], 'page');
      await doc.loadAnnotations(page.id);
      const annotation = draftAnnotation(doc, page.id, {
        subtype: 'FreeText',
        rect: { x0: 30, y0: 200, x1: 250, y1: 250 },
        contents: 'Unsaved words',
        flags: DEFAULT_ANNOTATION_FLAGS,
        extra: { defaultAppearance: '/Helv 12 Tf 0 g' },
      });
      await doc.apply(new AddAnnotationCommand(doc, annotation));
      const before = doc.snapshot();
      const bytes = await printSnapshot(doc);
      expect(await textOf(await printed(bytes))).toContain('Unsaved words');
      expect(doc.snapshot()).toEqual(before);
      expect(doc.isDirty).toBe(true);
      await doc.undo.undo();
      expect(doc.annotations(page.id)).toHaveLength(0);
      await doc.undo.redo();
      expect(doc.annotations(page.id)).toHaveLength(1);
    } finally {
      await doc.close();
    }
  });
  it.each([
    [true, true],
    [true, false],
    [false, true],
    [false, false],
  ])('comments=%s forms=%s preserve only printable marks', async (annotations, forms) => {
    const bytes = await fixture();
    const copy = bytes.slice();
    const output = await printed(bytes, annotations, forms);
    const text = await textOf(output);
    expect(text).toContain('Page content');
    for (const label of [
      'Printable stamp',
      'Print only',
      'Unknown appearance',
      'Link appearance',
    ]) {
      expect(text.includes(label)).toBe(annotations);
    }
    expect(text.includes('Current field value')).toBe(forms);
    expect(text).not.toContain('Screen only');
    expect(text).not.toContain('Hidden mark');
    expect(bytes).toEqual(copy);
    const doc = await PDFDocument.load(output);
    expect(doc.getPage(0).node.Annots()?.size() ?? 0).toBe(0);
    expect(doc.catalog.has(PDFName.of('AcroForm'))).toBe(false);
  });

  it.each([0, 90, 180, 270])(
    'preserves rendered placement with crop origin and rotation %s',
    async (rotation) => {
      const bytes = await fixture(rotation);
      const output = await printed(bytes);
      const before = await pdfium.open(bytes);
      const after = await pdfium.open(output);
      try {
        const a = await pdfium.renderRaw(before, 0, 1, undefined, {
          annotations: true,
          forms: true,
          printing: true,
        });
        const b = await pdfium.renderRaw(after, 0, 1, undefined, {
          annotations: false,
          forms: false,
        });
        expect([b.width, b.height]).toEqual([a.width, a.height]);
        let changed = 0;
        for (let i = 0; i < a.rgba.length; i += 4) {
          if (
            Math.abs((a.rgba[i] ?? 0) - (b.rgba[i] ?? 0)) > 20 ||
            Math.abs((a.rgba[i + 1] ?? 0) - (b.rgba[i + 1] ?? 0)) > 20 ||
            Math.abs((a.rgba[i + 2] ?? 0) - (b.rgba[i + 2] ?? 0)) > 20
          )
            changed++;
        }
        // Subpixel antialiasing may differ when content is nested. Missing any one labelled
        // appearance changes substantially more than this; text checks above also require each.
        expect(changed / (a.width * a.height)).toBeLessThan(0.004);
      } finally {
        await pdfium.close(before);
        await pdfium.close(after);
      }
    },
  );

  it('repairs a missing text-widget appearance from its current value', async () => {
    const doc = await PDFDocument.load(await fixture());
    const field = doc.getForm().getTextField('name');
    field.setText('Regenerated value');
    for (const widget of field.acroField.getWidgets()) widget.dict.delete(PDFName.of('AP'));
    const output = await printed(await doc.save({ updateFieldAppearances: false }));
    expect(await textOf(output)).toContain('Regenerated value');
  });

  it.each(['matrix', 'noRotate', 'opacity'])(
    'preserves %s annotation geometry on a rotated page',
    async (variant) => {
      const doc = await PDFDocument.load(await fixture(90));
      const stamp = doc.context.lookup(
        must(doc.getPage(0).node.Annots(), 'annotations').get(0),
        PDFDict,
      );
      if (variant === 'noRotate') stamp.set(PDFName.of('F'), PDFNumber.of(20));
      else if (variant === 'opacity') stamp.set(PDFName.of('CA'), PDFNumber.of(0.35));
      else {
        const ap = doc.context.lookup(stamp.get(PDFName.of('AP')), PDFDict);
        const normal = doc.context.lookup(ap.get(PDFName.of('N')));
        if (!(normal instanceof PDFStream)) throw new Error('Missing appearance fixture');
        normal.dict.set(PDFName.of('Matrix'), doc.context.obj([0, 1, -1, 0, 0, 0]));
      }
      const bytes = await doc.save();
      const output = await printed(bytes);
      const before = await pdfium.open(bytes);
      const after = await pdfium.open(output);
      try {
        const a = await pdfium.renderRaw(before, 0, 1, undefined, {
          annotations: true,
          forms: true,
          printing: true,
        });
        const b = await pdfium.renderRaw(after, 0, 1, undefined, {
          annotations: false,
          forms: false,
        });
        let changed = 0;
        for (let i = 0; i < a.rgba.length; i += 4)
          if (Math.abs((a.rgba[i] ?? 0) - (b.rgba[i] ?? 0)) > 20) changed++;
        expect(changed / (a.width * a.height)).toBeLessThan(0.0005);
      } finally {
        await pdfium.close(before);
        await pdfium.close(after);
      }
    },
  );

  it('rejects unknown missing appearances instead of reporting a successful incomplete PDF', async () => {
    const doc = await PDFDocument.load(await fixture());
    const annots = must(doc.getPage(0).node.Annots(), 'annotations');
    const stamp = doc.context.lookup(annots.get(4), PDFDict);
    stamp.delete(PDFName.of('AP'));
    const bytes = await doc.save();
    await expect(printed(bytes)).rejects.toThrow(
      'FutureAnnotation has no usable normal appearance',
    );
    await expect(printed(bytes, false)).resolves.toBeInstanceOf(Uint8Array);
  });

  it('rejects unknown appearance states and degenerate geometry', async () => {
    const doc = await PDFDocument.load(await fixture());
    const stamp = doc.context.lookup(
      must(doc.getPage(0).node.Annots(), 'annotations').get(0),
      PDFDict,
    );
    const ap = doc.context.lookup(stamp.get(PDFName.of('AP')), PDFDict);
    ap.set(PDFName.of('N'), doc.context.obj({ On: ap.get(PDFName.of('N')) }));
    stamp.set(PDFName.of('AS'), PDFName.of('Missing'));
    expect(() => {
      bakePrintAppearances(doc, new Set([0]), { annotations: true, forms: false });
    }).toThrow('no usable normal appearance');
    stamp.delete(PDFName.of('AS'));
    const rect = doc.context.lookup(stamp.get(PDFName.of('Rect')), PDFArray);
    rect.set(2, PDFNumber.of(20));
    expect(() => {
      bakePrintAppearances(doc, new Set([0]), { annotations: true, forms: false });
    }).toThrow('invalid appearance geometry');
  });

  it('does not inspect appearances on pages outside the selected print range', async () => {
    const doc = await PDFDocument.load(await fixture());
    const extra = doc.addPage([100, 100]);
    extra.node.addAnnot(
      doc.context.register(doc.context.obj({ Subtype: 'Unknown', F: 4, Rect: [1, 1, 5, 5] })),
    );
    expect(await textOf(await printed(await doc.save()))).toContain('Printable stamp');
  });

  it('prints blank pages even when they have no content streams or annotations', async () => {
    const pdf = await PDFDocument.create();
    pdf.addPage([200, 300]);
    const output = await printed(await pdf.save());
    expect((await PDFDocument.load(output)).getPageCount()).toBe(1);
    expect(await textOf(output)).toBe('');
  });

  it('keeps annotation appearances and sheet labels through rotated tiling and n-up', async () => {
    const bytes = await fixture(90);
    const handle = await pdfium.open(bytes);
    try {
      const size = await pdfium.pageSize(handle, 0);
      for (const layout of [
        {
          ...DEFAULT_IMPOSITION,
          paper: { width: 600, height: 220 },
          nUp: { columns: 2, rows: 1, order: 'horizontal' as const, border: true },
        },
        {
          ...DEFAULT_IMPOSITION,
          paper: { width: 150, height: 220 },
          tile: { scale: 1, overlap: 0, marks: true },
        },
        {
          ...DEFAULT_IMPOSITION,
          paper: { width: 600, height: 220 },
          booklet: { subset: 'both' as const, binding: 'left' as const },
        },
      ]) {
        const sheets = imposePages(
          [
            { index: 0, ...size },
            { index: 0, ...size },
          ],
          layout,
        );
        const output = await printToPdf({
          engine: pdfium,
          doc: handle,
          bytes,
          sheets,
          asImage: false,
          render: { dpi: 72, annotations: true, forms: true, grayscale: false },
        });
        const result = await pdfium.open(output);
        try {
          let text = '';
          for (let i = 0; i < sheets.length; i++)
            text += (await pdfium.textRuns(result, i)).map((r) => r.text).join('');
          expect(text).toContain('Printable stamp');
          expect(text).toContain('Current field value');
          if (layout.tile) expect(text).toContain('1 of 2');
          expect(await pdfium.pageCount(result)).toBe(sheets.length);
        } finally {
          await pdfium.close(result);
        }
      }
    } finally {
      await pdfium.close(handle);
    }
  });

  it('rejects a queued edit during snapshot capture without mixing its model and engine bytes', async () => {
    const pdf = await PDFDocument.create();
    pdf.addPage([200, 300]);
    const doc = await Document.open(pdfium, await pdf.save());
    let started: () => void = () => undefined;
    let release: () => void = () => undefined;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const save = pdfium.save.bind(pdfium);
    const spy = vi.spyOn(pdfium, 'save').mockImplementationOnce(async (...args) => {
      started();
      await blocked;
      return save(...args);
    });
    try {
      const capture = printSnapshot(doc);
      const rejected = expect(capture).rejects.toThrow('document changed');
      await entered;
      let edited = false;
      const edit = doc.apply({
        id: 'test.print.concurrent',
        label: 'Concurrent edit',
        do: () => {
          edited = true;
        },
        undo: () => {
          edited = false;
        },
      });
      expect(edited).toBe(false);
      release();
      await rejected;
      await edit;
      expect(edited).toBe(true);
    } finally {
      release();
      spy.mockRestore();
      await doc.close();
    }
  });

  it('cancels before reading source bytes', async () => {
    const pdf = await PDFDocument.create();
    pdf.addPage([200, 300]);
    const doc = await Document.open(pdfium, await pdf.save());
    const save = vi.spyOn(pdfium, 'save');
    try {
      const controller = new AbortController();
      controller.abort();
      await expect(printSnapshot(doc, controller.signal)).rejects.toThrow();
      expect(save).not.toHaveBeenCalled();
    } finally {
      save.mockRestore();
      await doc.close();
    }
  });
});

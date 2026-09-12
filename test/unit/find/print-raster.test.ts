import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { PDFDocument, degrees } from 'pdf-lib';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Document } from '@core/Document';
import { AddAnnotationCommand, DEFAULT_ANNOTATION_FLAGS, draftAnnotation } from '@core/commands';
import { printSnapshot } from '@modules/M13-select-find-print/print/snapshot';
import { withRasterSnapshot } from '@modules/M13-select-find-print/print/rasterSnapshot';
import { PrintService } from '@modules/M13-select-find-print/print/PrintService';
import { printToPdf } from '@modules/M13-select-find-print/print/printToPdf';
import { DEFAULT_PRINT_SETTINGS } from '@modules/M13-select-find-print/settings';
import { renderSheet } from '@modules/M13-select-find-print/print/render';
import { invoke } from '@shared/ipc';
import { engine } from '../engine/helpers';
import { must } from './helpers';

vi.mock('@shared/ipc', () => ({ hasBridge: () => true, invoke: vi.fn() }));
vi.mock('@modules/M13-select-find-print/print/render', () => ({ renderSheet: vi.fn() }));
let pdfium: Awaited<ReturnType<typeof engine>>;
beforeAll(async () => {
  pdfium = await engine();
});
afterEach(() => vi.restoreAllMocks());

async function fixture(rotation = 0) {
  const pdf = await PDFDocument.create();
  const p = pdf.addPage([300, 400]);
  p.setCropBox(10, 20, 260, 350);
  p.setRotation(degrees(rotation));
  p.drawText('Page one', { x: 30, y: 340, size: 12 });
  const field = pdf.getForm().createTextField('field');
  field.setText('Current form value');
  field.addToPage(p, { x: 30, y: 260, width: 180, height: 20 });
  pdf.addPage([300, 400]).drawText('Page two', { x: 30, y: 340 });
  const doc = await Document.open(pdfium, await pdf.save());
  const page = must(doc.state.pages[0], 'page');
  await doc.loadAnnotations(page.id);
  await doc.apply(
    new AddAnnotationCommand(
      doc,
      draftAnnotation(doc, page.id, {
        subtype: 'FreeText',
        rect: { x0: 30, y0: 180, x1: 230, y1: 220 },
        contents: 'Unsaved print words',
        flags: DEFAULT_ANNOTATION_FLAGS,
        extra: { defaultAppearance: '/Helv 14 Tf 0 g' },
      }),
    ),
  );
  return doc;
}

describe('disposable raster print snapshots', () => {
  it.each([0, 90, 180, 270])(
    'renders unsaved content at rotation %s without changing source or undo',
    async (rotation) => {
      const doc = await fixture(rotation);
      const before = doc.snapshot();
      const sourceBytes = await pdfium.save(doc.handle);
      const reference = await pdfium.open(await printSnapshot(doc));
      const closed = vi.spyOn(pdfium, 'close');
      let printedHandle = doc.handle;
      try {
        await withRasterSnapshot(
          { engine: pdfium, doc: doc.handle, snapshot: (signal) => printSnapshot(doc, signal) },
          new Set([0]),
          { annotations: true, forms: true },
          undefined,
          async (handle) => {
            printedHandle = handle;
            expect(handle).not.toBe(doc.handle);
            const text = (await pdfium.textRuns(handle, 0)).map((run) => run.text).join('');
            expect(text).toContain('Unsaved print words');
            expect(text).toContain('Current form value');
            const raster = await pdfium.renderRaw(handle, 0, 1, undefined, {
              annotations: false,
              forms: false,
              printing: true,
            });
            const old = await pdfium.renderRaw(doc.handle, 0, 1, undefined, {
              annotations: true,
              forms: true,
              printing: true,
            });
            expect([raster.width, raster.height]).toEqual([old.width, old.height]);
            expect(raster.rgba).not.toEqual(old.rgba);
            const expected = await pdfium.renderRaw(reference, 0, 1, undefined, {
              annotations: true,
              forms: true,
              printing: true,
            });
            let changed = 0;
            for (let i = 0; i < expected.rgba.length; i += 4) {
              if (
                [0, 1, 2].some(
                  (channel) =>
                    Math.abs((expected.rgba[i + channel] ?? 0) - (raster.rgba[i + channel] ?? 0)) >
                    20,
                )
              )
                changed++;
            }
            expect(changed / (expected.width * expected.height)).toBeLessThan(0.005);
          },
        );
        expect(closed).toHaveBeenCalledWith(printedHandle);
        expect(doc.snapshot()).toEqual(before);
        expect(await pdfium.save(doc.handle)).toEqual(sourceBytes);
        await doc.undo.undo();
        expect(
          doc
            .annotations(must(doc.state.pages[0], 'page').id)
            .some((a) => a.subtype === 'FreeText'),
        ).toBe(false);
        await doc.undo.redo();
        expect(
          doc
            .annotations(must(doc.state.pages[0], 'page').id)
            .some((a) => a.subtype === 'FreeText'),
        ).toBe(true);
      } finally {
        await pdfium.close(reference);
        await doc.close();
      }
    },
  );

  it.each([
    [true, true],
    [true, false],
    [false, true],
    [false, false],
  ])('applies comments=%s forms=%s before engine rendering', async (annotations, forms) => {
    const doc = await fixture();
    try {
      await withRasterSnapshot(
        {
          engine: pdfium,
          doc: doc.handle,
          snapshot: (signal) => printSnapshot(doc, signal, { annotations, forms }),
        },
        new Set([0]),
        { annotations, forms },
        undefined,
        async (handle) => {
          const text = (await pdfium.textRuns(handle, 0)).map((run) => run.text).join('');
          expect(text.includes('Unsaved print words')).toBe(annotations);
          expect(text.includes('Current form value')).toBe(forms);
          const pdf = await PDFDocument.load(await pdfium.save(handle));
          expect(pdf.getPage(0).node.Annots()).toBeUndefined();
        },
      );
    } finally {
      await doc.close();
    }
  });

  it('ignores unresolved appearances outside the selected sheets', async () => {
    const pdf = await PDFDocument.create();
    pdf.addPage([300, 400]).drawText('Selected');
    pdf.addPage([300, 400]).node.addAnnot(
      pdf.context.register(
        pdf.context.obj({
          Type: 'Annot',
          Subtype: 'FutureAnnotation',
          F: 4,
          Rect: [10, 10, 30, 30],
        }),
      ),
    );
    const doc = await pdfium.open(await pdf.save());
    try {
      const source = { engine: pdfium, doc };
      const options = { annotations: true, forms: true };
      await expect(
        withRasterSnapshot(source, new Set([0]), options, undefined, () => Promise.resolve(true)),
      ).resolves.toBe(true);
      await expect(
        withRasterSnapshot(source, new Set([1]), options, undefined, () => Promise.resolve(true)),
      ).rejects.toThrow('no usable normal appearance');
    } finally {
      await pdfium.close(doc);
    }
  });

  it.each(['success', 'failure', 'cancel'] as const)(
    'closes its handle after %s',
    async (outcome) => {
      const doc = await fixture();
      const abort = new AbortController();
      const close = vi.spyOn(pdfium, 'close');
      let snapshot = doc.handle;
      try {
        const pending = withRasterSnapshot(
          { engine: pdfium, doc: doc.handle },
          new Set([1]),
          { annotations: true, forms: true },
          abort.signal,
          (handle) => {
            snapshot = handle;
            if (outcome === 'cancel') {
              abort.abort();
              abort.signal.throwIfAborted();
            }
            if (outcome === 'failure') throw new Error('render failed');
            return Promise.resolve(true);
          },
        );
        if (outcome === 'success') await expect(pending).resolves.toBe(true);
        else await expect(pending).rejects.toThrow();
        expect(close).toHaveBeenCalledWith(snapshot);
        expect(close).not.toHaveBeenCalledWith(doc.handle);
      } finally {
        await doc.close();
      }
    },
  );

  it('cancels after an asynchronous open and still closes the new handle', async () => {
    const doc = await fixture();
    const abort = new AbortController();
    const original = pdfium.open.bind(pdfium);
    const close = vi.spyOn(pdfium, 'close');
    const open = vi.spyOn(pdfium, 'open').mockImplementation(async (bytes, options) => {
      const handle = await original(bytes, options);
      abort.abort();
      return handle;
    });
    const use = vi.fn();
    try {
      await expect(
        withRasterSnapshot(
          { engine: pdfium, doc: doc.handle },
          new Set([1]),
          { annotations: true, forms: true },
          abort.signal,
          use,
        ),
      ).rejects.toThrow();
      expect(use).not.toHaveBeenCalled();
      expect(close).toHaveBeenCalledTimes(1);
      expect(open).toHaveBeenCalledTimes(1);
    } finally {
      await doc.close();
    }
  });

  it('rejects cancellation before taking source bytes', async () => {
    const doc = await fixture();
    const snapshot = vi.fn();
    const abort = new AbortController();
    abort.abort();
    try {
      await expect(
        withRasterSnapshot(
          { engine: pdfium, doc: doc.handle, snapshot },
          new Set([0]),
          { annotations: true, forms: true },
          abort.signal,
          vi.fn(),
        ),
      ).rejects.toThrow();
      expect(snapshot).not.toHaveBeenCalled();
    } finally {
      await doc.close();
    }
  });
});

describe('printer spool orchestration', () => {
  it.each([
    [true, false, true],
    [false, true, true],
    [true, false, false],
  ])(
    'raster PDF image=%s grey=%s supplied snapshot=%s uses the same isolated appearances',
    async (asImage, grayscale, supplied) => {
      const doc = await fixture();
      const bytes = await printSnapshot(doc);
      const handle = await pdfium.open(bytes);
      const service = new PrintService();
      const settings = { ...DEFAULT_PRINT_SETTINGS, dpi: 96 };
      const plan = service.plan({
        settings,
        pageSizes: [{ width: 260, height: 350 }],
        currentPage: 0,
        selectedPages: [],
      });
      vi.mocked(renderSheet)
        .mockReset()
        .mockImplementation(async (_sheet, options) => {
          expect(options.doc).not.toBe(handle);
          expect(options.grayscale).toBe(grayscale);
          expect(options.annotations).toBe(false);
          expect(options.forms).toBe(false);
          expect((await pdfium.textRuns(options.doc, 0)).map((run) => run.text).join('')).toContain(
            'Unsaved print words',
          );
          return new Uint8Array(
            readFileSync(join(process.cwd(), 'test/fixtures/create/logo-alpha.png')),
          );
        });
      try {
        const output = await printToPdf({
          engine: pdfium,
          doc: handle,
          sheets: plan.sheets,
          asImage,
          render: { dpi: 96, annotations: true, forms: true, grayscale },
          ...(supplied ? { bytes } : {}),
        });
        expect((await PDFDocument.load(output)).getPageCount()).toBe(1);
        expect(renderSheet).toHaveBeenCalledTimes(1);
      } finally {
        await pdfium.close(handle);
        await doc.close();
      }
    },
  );

  it.each(['complete', 'cancel', 'changed', 'render failure'] as const)(
    'uses one snapshot for a job and handles %s before printer delivery',
    async (outcome) => {
      const doc = await fixture();
      const settings = { ...DEFAULT_PRINT_SETTINGS, dpi: 96 };
      const service = new PrintService();
      const plan = service.plan({
        settings,
        pageSizes: [
          { width: 260, height: 350 },
          { width: 300, height: 400 },
        ],
        currentPage: 0,
        selectedPages: [],
      });
      const snapshot = vi.fn((signal?: AbortSignal) => printSnapshot(doc, signal));
      const abort = new AbortController();
      let current = true;
      const handles: unknown[] = [];
      vi.mocked(invoke)
        .mockReset()
        .mockImplementation((...args) => {
          const [channel] = args;
          if (channel === 'print:begin') return Promise.resolve('job');
          if (channel === 'print:finish')
            return Promise.resolve({ sheets: 2, printed: false, documentPath: 'spool.html' });
          return Promise.resolve(undefined);
        });
      vi.mocked(renderSheet)
        .mockReset()
        .mockImplementation((_sheet, options) => {
          handles.push(options.doc);
          expect(options.annotations).toBe(false);
          expect(options.forms).toBe(false);
          expect(options.doc).not.toBe(doc.handle);
          if (outcome === 'render failure') throw new Error('render failed');
          return Promise.resolve(new Uint8Array([1, 2, 3]));
        });
      const close = vi.spyOn(pdfium, 'close');
      try {
        const result = await service.print({
          source: {
            engine: pdfium,
            doc: doc.handle,
            title: 'Synthetic',
            snapshot,
            assertCurrent: () => {
              if (!current) throw new Error('Document changed');
            },
          },
          plan,
          settings,
          signal: abort.signal,
          dryRun: true,
          onProgress: () => {
            if (outcome === 'cancel') abort.abort();
            if (outcome === 'changed') current = false;
          },
        });
        expect(snapshot).toHaveBeenCalledTimes(1);
        expect(new Set(handles).size).toBe(1);
        expect(close).toHaveBeenCalledWith(handles[0]);
        const channels = vi.mocked(invoke).mock.calls.map(([channel]) => channel);
        if (outcome === 'complete') {
          expect(result.sheets).toBe(2);
          expect(channels).toEqual(['print:begin', 'print:sheet', 'print:sheet', 'print:finish']);
        } else {
          expect(result.error).toBeTruthy();
          expect(channels).toContain('print:cancel');
          expect(channels).not.toContain('print:finish');
        }
      } finally {
        await doc.close();
      }
    },
  );
});

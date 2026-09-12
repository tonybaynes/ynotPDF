import { expect, test } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { Qpdf, type QpdfFactory } from '../../../src/engine/security/qpdf';
import { PDFDocument, degrees } from 'pdf-lib';
import { launchApp, type App } from '../harness';
import { journey } from '../journey';
import { expectNothingClipped, expectReadable, expectWindowSound } from '../layout';

let app: App;
test.beforeAll(async () => {
  app = await launchApp({ noDemo: true, window: { width: 1280, height: 900 } });
  // Intercept the final native delivery boundary. Main still writes real sheets and HTML,
  // loads its print window and waits for the images. No test can reach a physical printer.
  await app.electron.evaluate(({ app: electronApp }) => {
    const state = globalThis as typeof globalThis & {
      m13Spool?: string[];
      m13SpoolSerial?: number;
    };
    state.m13Spool = [];
    state.m13SpoolSerial = 0;
    electronApp.on('web-contents-created', (_event, contents) => {
      contents.print = (_options, callback) => {
        try {
          const { readFileSync } = process.getBuiltinModule('fs');
          const { dirname, join } = process.getBuiltinModule('path');
          const { fileURLToPath } = process.getBuiltinModule('url');
          const path = fileURLToPath(contents.getURL());
          const html = readFileSync(path, 'utf8');
          state.m13Spool = [...html.matchAll(/<img src="([^"]+)"/g)].map((match) =>
            readFileSync(join(dirname(path), match[1] ?? '')).toString('base64'),
          );
          state.m13SpoolSerial = (state.m13SpoolSerial ?? 0) + 1;
          callback?.(true, '');
        } catch (error) {
          callback?.(false, String(error));
        }
      };
    });
  });
});
test.afterAll(async () => {
  await app.close();
});

/** Keep geometry in CI logs even when a passing retry means no trace artifact is uploaded. */
async function expectWindowSoundWithDiagnostics(): Promise<void> {
  try {
    await expectWindowSound(app.page);
  } catch (error) {
    const geometry = await app.page
      .evaluate(() => {
        const viewport = document.documentElement.clientWidth;
        const elements = [...document.querySelectorAll('*')];
        const describe = (element: Element) => {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return {
            tag: element.tagName,
            id: element.id,
            className: element.getAttribute('class'),
            text: element.textContent?.slice(0, 100),
            rect: {
              x: rect.x,
              y: rect.y,
              width: rect.width,
              right: rect.right,
              bottom: rect.bottom,
            },
            clientWidth: element.clientWidth,
            scrollWidth: element.scrollWidth,
            display: style.display,
            position: style.position,
            overflowX: style.overflowX,
            minWidth: style.minWidth,
            flexWrap: style.flexWrap,
            font: style.font,
            parent: element.parentElement
              ? {
                  tag: element.parentElement.tagName,
                  id: element.parentElement.id,
                  className: element.parentElement.getAttribute('class'),
                  overflowX: getComputedStyle(element.parentElement).overflowX,
                }
              : null,
          };
        };
        return {
          viewport,
          body: describe(document.body),
          overRight: elements
            .filter((element) => {
              const rect = element.getBoundingClientRect();
              return rect.width > 0 && rect.height > 0 && rect.right > viewport + 1;
            })
            .map(describe),
          status: elements.filter((element) => element.closest('.statusbar')).map(describe),
          tabs: elements.filter((element) => element.matches('.tabstrip, .tab')).map(describe),
        };
      })
      .catch((captureError: unknown) => ({ captureError: String(captureError) }));
    console.error(`M13 window geometry: ${JSON.stringify(geometry)}`);
    throw error;
  }
}

async function preview(previous?: string): Promise<string> {
  const image = app.page.locator('.print-preview-image');
  await expect(image).toBeVisible();
  await expect
    .poll(async () =>
      image.evaluate((node: HTMLImageElement) => node.complete && node.naturalWidth > 0),
    )
    .toBe(true);
  if (previous) await expect(image).not.toHaveAttribute('src', previous);
  return (await image.getAttribute('src')) ?? '';
}

async function previewPng(): Promise<string> {
  return app.page.locator('.print-preview-image').evaluate((image: HTMLImageElement) => {
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('No canvas context');
    context.drawImage(image, 0, 0);
    return canvas.toDataURL('image/png').split(',')[1] ?? '';
  });
}

/** Compare decoded pixels, not PNG encoder metadata; no blob fetch outside the app's CSP. */
async function pixelHashes(pngs: string[]): Promise<string[]> {
  return app.electron.evaluate(({ nativeImage }, images) => {
    const { createHash } = process.getBuiltinModule('crypto');
    return images.map((png) => {
      const image = nativeImage.createFromBuffer(Buffer.from(png, 'base64'));
      const size = image.getSize();
      return `${size.width}x${size.height}:${createHash('sha256').update(image.toBitmap()).digest('hex')}`;
    });
  }, pngs);
}

async function resetSpool(): Promise<number> {
  return app.electron.evaluate(() => {
    const state = globalThis as typeof globalThis & { m13Spool: string[]; m13SpoolSerial: number };
    state.m13Spool = [];
    return state.m13SpoolSerial + 1;
  });
}

async function waitForSpool(serial: number, sheets: number): Promise<void> {
  await expect
    .poll(() =>
      app.electron.evaluate(() => {
        const state = globalThis as typeof globalThis & {
          m13Spool: string[];
          m13SpoolSerial: number;
        };
        return { serial: state.m13SpoolSerial, sheets: state.m13Spool.length };
      }),
    )
    .toEqual({ serial, sheets });
}

async function preparedSheets(): Promise<string[]> {
  return app.electron.evaluate(
    () => (globalThis as typeof globalThis & { m13Spool: string[] }).m13Spool,
  );
}

test('M13 — the settled preview and prepared printer sheet include unsaved text, custom stamp and designed field', async () => {
  const source = await PDFDocument.create();
  source.addPage([595.28, 841.89]).drawText('Snapshot print review', { x: 40, y: 780, size: 18 });
  await app.run('file.openBytes', {
    file: {
      path: null,
      name: 'preview-source.pdf',
      bytes: [...(await source.save())],
    },
  });
  const j = journey(app);
  await j.clickRibbon('form', 'Text field');
  await j.dragOnPageAt([0.1, 0.23], [0.47, 0.265]);
  await expect.poll(async () => ((await app.run('dev.formFields')) as unknown[]).length).toBe(1);
  const fields = (await app.run('dev.formFields')) as Array<{ name: string }>;
  const field = fields[0];
  if (!field) throw new Error('The Text field tool created no field');
  await j.clickRibbon('form', 'Fill In Form');
  await app.page
    .locator('.layer-widget')
    .getByRole('textbox', { name: field.name, exact: true })
    .first()
    .fill('Unsaved designed field');
  await app.page.keyboard.press('Tab');
  await app.run('annot.identity', { name: 'Print reviewer', initials: 'PR', email: '' });
  const stamp = await app.run('draw.stampCustom', {
    label: 'Synthetic logo',
    png: [...readFileSync(join(process.cwd(), 'test/fixtures/create/logo-alpha.png'))],
    width: 120,
    height: 60,
  });
  await j.openPanel('nav.stamps');
  await j.clickPanelTile('nav.stamps', `.stamp-tile[data-stamp="${String(stamp)}"]`);
  await j.clickPageAt([0.25, 0.7]);
  await expect
    .poll(
      async () =>
        ((await app.run('dev.annotations', { page: 0 })) as Array<{ subtype: string }>).filter(
          (annotation) => annotation.subtype === 'Stamp',
        ).length,
    )
    .toBe(1);
  await j.clickRibbon('comment', 'Text Box');
  await j.dragOnPageAt([0.55, 0.3], [0.9, 0.38]);
  await app.page.locator('.annot-editor').fill('Unsaved preview text');
  await app.page.keyboard.press('Control+Enter');
  await expect(app.page.locator('.annot-editor')).toBeHidden();
  await expect
    .poll(async () =>
      ((await app.run('dev.annotations', { page: 0 })) as Array<{ contents: string }>).some(
        (a) => a.contents === 'Unsaved preview text',
      ),
    )
    .toBe(true);
  const before = await app.run('dev.documentSummary');
  const journal = await app.run('dev.documentJournal');
  await app.page.keyboard.press('ControlOrMeta+p');
  const dialog = app.page.locator('#print-dialog');
  const dpi = dialog.getByLabel('Resolution (DPI)', { exact: true });
  await dpi.fill('96');
  await dpi.press('Tab');
  let url = await preview();
  await expectNothingClipped(dialog);
  await expectReadable(dialog);
  await app.page.locator('.print-preview-image').scrollIntoViewIfNeeded();
  await app.page.screenshot({ path: test.info().outputPath('settled-preview.png') });
  const withAll = await previewPng();
  const regions = (await app.run('dev.annotations', { page: 0 })) as Array<{
    subtype: string;
    rect: { x0: number; y0: number; x1: number; y1: number };
  }>;
  const rects = [
    regions.find((a) => a.subtype === 'FreeText')?.rect ?? { x0: 0, y0: 0, x1: 0, y1: 0 },
    regions.find((a) => a.subtype === 'Stamp')?.rect ?? { x0: 0, y0: 0, x1: 0, y1: 0 },
    { x0: 60, y0: 620, x1: 280, y1: 650 },
  ];
  const ink = async () =>
    app.page.locator('.print-preview-image').evaluate((image: HTMLImageElement, areas) => {
      const canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('No 2D context for preview inspection');
      ctx.drawImage(image, 0, 0);
      return areas.map((r) => {
        const x = Math.floor((r.x0 / 595.28) * canvas.width);
        const y = Math.floor(((841.89 - r.y1) / 841.89) * canvas.height);
        const w = Math.max(1, Math.floor(((r.x1 - r.x0) / 595.28) * canvas.width));
        const h = Math.max(1, Math.floor(((r.y1 - r.y0) / 841.89) * canvas.height));
        const pixels = ctx.getImageData(x, y, w, h).data;
        let count = 0;
        for (let i = 0; i < pixels.length; i += 4)
          if (
            (pixels[i] ?? 255) < 220 ||
            (pixels[i + 1] ?? 255) < 220 ||
            (pixels[i + 2] ?? 255) < 220
          )
            count++;
        return count;
      });
    }, rects);
  expect((await ink()).every((n) => n > 20)).toBe(true);
  await dialog.getByLabel('Comments and annotations', { exact: true }).uncheck();
  url = await preview(url);
  expect(await ink()).toEqual([0, 0, expect.any(Number)]);
  expect((await ink())[2]).toBeGreaterThan(20);
  await dialog.getByLabel('Form fields', { exact: true }).uncheck();
  url = await preview(url);
  expect(await ink()).toEqual([0, 0, 0]);
  await dialog.getByLabel('Comments and annotations', { exact: true }).check();
  url = await preview(url);
  expect((await ink()).slice(0, 2).every((n) => n > 20)).toBe(true);
  expect((await ink())[2]).toBe(0);
  await dialog.getByLabel('Form fields', { exact: true }).check();
  await preview(url);
  await app.page.screenshot({ path: test.info().outputPath('print-options.png') });
  const serial = await resetSpool();
  await dialog.getByRole('button', { name: 'Print', exact: true }).click();
  await waitForSpool(serial, 1);
  await expect(app.page.getByText('Sent 1 sheets to the printer', { exact: true })).toBeVisible();
  const spool = await preparedSheets();
  expect(spool).toHaveLength(1);
  expect(await pixelHashes(spool)).toEqual(await pixelHashes([withAll]));
  writeFileSync(
    test.info().outputPath('prepared-sheet.png'),
    Buffer.from(spool[0] ?? '', 'base64'),
  );
  expect(await app.run('dev.documentSummary')).toEqual(before);
  expect(await app.run('dev.documentJournal')).toEqual(journal);
  await app.page.keyboard.press('ControlOrMeta+z');
  expect(await app.run('dev.documentJournal')).not.toEqual(journal);
  await expectWindowSoundWithDiagnostics();
});

test('M13 — unresolved preview reports its error, excluded comments load, and a closed dialog cannot publish late work', async () => {
  const source = await PDFDocument.create();
  const page = source.addPage([300, 400]);
  page.drawText('Selected content', { x: 30, y: 340 });
  page.node.addAnnot(
    source.context.register(
      source.context.obj({
        Type: 'Annot',
        Subtype: 'FutureAnnotation',
        F: 4,
        Rect: [30, 100, 100, 150],
      }),
    ),
  );
  await app.run('file.openBytes', {
    file: {
      path: null,
      name: 'preview-error.pdf',
      bytes: [...(await source.save())],
    },
  });
  await app.page.keyboard.press('ControlOrMeta+p');
  const dialog = app.page.locator('#print-dialog');
  await expect(dialog.locator('.print-preview-status')).toContainText(
    'no usable normal appearance',
  );
  await expect(dialog.locator('.print-preview-image')).toBeHidden();
  await app.page.screenshot({ path: test.info().outputPath('preview-error.png') });
  await dialog.getByLabel('Comments and annotations', { exact: true }).uncheck();
  await preview();
  await dialog.getByLabel('Comments and annotations', { exact: true }).check();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog).toBeHidden();
  await app.page.keyboard.press('ControlOrMeta+p');
  await expect(dialog.locator('.print-preview-status')).toContainText(
    'no usable normal appearance',
  );
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expectWindowSoundWithDiagnostics();
});

for (const authority of ['none', 'low', 'full'] as const) {
  test(`M13 — ${authority} print authority is enforced for preview and prepared sheets`, async () => {
    const pdf = await PDFDocument.create();
    pdf.addPage([300, 400]).drawText('Protected print content', { x: 30, y: 340, size: 12 });
    const require_ = createRequire(import.meta.url);
    const qpdf = new Qpdf({ factory: require_('@neslinesli93/qpdf-wasm') as QpdfFactory });
    const encrypted = await qpdf.run(
      [
        '--encrypt',
        '',
        'synthetic-owner',
        '256',
        `--print=${authority}`,
        '--modify=none',
        '--extract=n',
        '--',
        'in.pdf',
        'out.pdf',
      ],
      { 'in.pdf': await pdf.save() },
      ['out.pdf'],
    );
    expect(encrypted.code).toBe(0);
    const bytes = encrypted.files.get('out.pdf');
    if (!bytes) throw new Error('qpdf did not create encrypted fixture');
    await app.run('file.openBytes', {
      file: {
        path: null,
        name: `print-${authority}.pdf`,
        bytes: [...bytes],
      },
    });
    const before = (await app.run('dev.securityState')) as {
      allows: { print: boolean; printHigh: boolean };
    };
    expect(before.allows.print).toBe(authority !== 'none');
    expect(before.allows.printHigh).toBe(authority === 'full');
    expect(await app.isEnabled('file.print')).toBe(authority !== 'none');
    const low = (await app.run('dev.printDryRun', { settings: { dpi: 96 } })) as {
      sheets: number;
      error: string | null;
    } | null;
    const high = (await app.run('dev.printDryRun', { settings: { dpi: 300 } })) as {
      sheets: number;
      error: string | null;
    } | null;
    if (authority === 'none') expect(low).toBeNull();
    else expect(low).toMatchObject({ sheets: 1, error: null });
    if (authority === 'full') expect(high).toMatchObject({ sheets: 1, error: null });
    else expect(high).toBeNull();
    if (authority !== 'none') {
      await app.page.keyboard.press('ControlOrMeta+p');
      await preview();
      await app.page
        .locator('#print-dialog')
        .getByRole('button', { name: 'Cancel', exact: true })
        .click();
    }
    expect(await app.run('dev.securityState')).toEqual(before);
    await expectWindowSoundWithDiagnostics();
  });
}

for (const [mode, rotation] of [
  ['single', 0],
  ['nup', 90],
  ['booklet', 180],
  ['tile', 270],
] as const) {
  test(`M13 — selected cropped pages at ${rotation} degrees have identical ${mode} preview and spool sheets`, async () => {
    const source = await PDFDocument.create();
    for (let i = 0; i < 2; i++) {
      const page = source.addPage([650, 880]);
      page.setMediaBox(-30, -20, 650, 880);
      page.setCropBox(10, 20, 600, 800);
      page.setRotation(degrees(rotation));
      page.drawText(`Selected page ${i + 1}`, { x: 40, y: 760, size: 24 });
      const field = source.getForm().createTextField(`page${i}`);
      field.setText(`Printed field ${i + 1}`);
      field.addToPage(page, { x: 100, y: 350, width: 200, height: 40 });
    }
    source.addPage([300, 400]).node.addAnnot(
      source.context.register(
        source.context.obj({
          Type: 'Annot',
          Subtype: 'FutureAnnotation',
          F: 4,
          Rect: [30, 100, 100, 150],
        }),
      ),
    );
    await app.run('file.openBytes', {
      file: {
        path: null,
        name: `imposed-${mode}.pdf`,
        bytes: [...(await source.save())],
      },
    });
    const before = await app.run('dev.documentJournal');
    await app.page.keyboard.press('ControlOrMeta+p');
    const dialog = app.page.locator('#print-dialog');
    await dialog.getByPlaceholder('2-4, 7', { exact: true }).fill('1-2');
    await dialog.getByLabel('Layout', { exact: true }).selectOption(mode);
    const dpi = dialog.getByLabel('Resolution (DPI)', { exact: true });
    await dpi.fill('96');
    await dpi.press('Tab');
    await dialog.getByLabel('Comments and annotations', { exact: true }).check();
    await dialog.getByLabel('Form fields', { exact: true }).check();
    const previews: string[] = [];
    let previous: string | undefined;
    for (;;) {
      previous = await preview(previous);
      previews.push(await previewPng());
      if (previews.length === 1) {
        await app.page.locator('.print-preview-image').scrollIntoViewIfNeeded();
        await app.page.screenshot({ path: test.info().outputPath(`${mode}-preview.png`) });
      }
      const next = dialog.getByRole('button', { name: 'Next sheet', exact: true });
      if (await next.isDisabled()) break;
      await next.click();
    }
    expect(previews.length).toBeGreaterThan(0);
    if (mode === 'tile') expect(previews.length).toBeGreaterThan(2);
    const serial = await resetSpool();
    await dialog.getByRole('button', { name: 'Print', exact: true }).click();
    await waitForSpool(serial, previews.length);
    await expect(
      app.page.getByText(`Sent ${previews.length} sheets to the printer`, { exact: true }).last(),
    ).toBeVisible();
    const spool = await preparedSheets();
    expect(await pixelHashes(spool)).toEqual(await pixelHashes(previews));
    expect(await app.run('dev.documentJournal')).toEqual(before);
    await expectWindowSoundWithDiagnostics();
  });
}

test('M13 — scrolling and switching a long tab strip contains screen-reader status without hiding it', async () => {
  const pdf = await PDFDocument.create();
  pdf.addPage([400, 500]).drawText('Tab overflow regression', { x: 30, y: 450, size: 16 });
  const bytes = [...(await pdf.save())];
  const names = Array.from(
    { length: 12 },
    (_, index) => `Long synthetic document ${index + 1} for tab overflow.pdf`,
  );
  for (const name of names) {
    await app.run('file.openBytes', { file: { path: null, name, bytes } });
  }
  const strip = app.page.locator('#tabstrip');
  expect(await strip.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
  const first = strip.getByRole('tab').filter({ hasText: names[0] ?? '' });
  const last = strip.getByRole('tab').filter({ hasText: names.at(-1) ?? '' });
  await first.click();
  await expect(first).toHaveAttribute('aria-selected', 'true');
  const j = journey(app);
  await app.run('annot.identity', { name: 'Tab reviewer', initials: 'TR', email: '' });
  await j.clickRibbon('comment', 'Text Box');
  await j.dragOnPageAt([0.2, 0.2], [0.6, 0.3]);
  await app.page.locator('.annot-editor').fill('Unsaved accessible status');
  await app.page.keyboard.press('Control+Enter');
  await expect(first).toHaveAccessibleName(/Modified/);
  // Adding the empty box marks the tab dirty before the asynchronous text edit commits.
  await expect
    .poll(() => app.run('dev.documentJournal'))
    .toMatchObject({
      entries: expect.arrayContaining([
        expect.objectContaining({
          type: 'annot.update',
          payload: expect.objectContaining({
            patch: expect.objectContaining({ contents: 'Unsaved accessible status' }),
          }),
        }),
      ]),
    });
  const journal = await app.run('dev.documentJournal');
  for (const tab of [last, first, last, first]) {
    await tab.click();
    await expect(tab).toHaveAttribute('aria-selected', 'true');
    await expectWindowSoundWithDiagnostics();
  }
  await expect(first).toHaveAccessibleName(/Modified/);
  await expect(first.locator('.sr-only')).toHaveText(' (Modified)');
  expect(await app.run('dev.documentJournal')).toEqual(journal);
  await app.page.screenshot({ path: test.info().outputPath('overflowed-tabs.png') });
  await expectWindowSoundWithDiagnostics();
});

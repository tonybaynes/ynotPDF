import { expect, test } from '@playwright/test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument, PDFName } from 'pdf-lib';
import { launchApp, fixturePath, type App } from '../harness';
import { journey } from '../journey';
import { expectNothingClipped, expectReadable, expectWindowSound } from '../layout';

let app: App;
let scratch: string;
test.beforeAll(async () => {
  app = await launchApp({ noDemo: true, window: { width: 1280, height: 900 } });
  scratch = mkdtempSync(join(tmpdir(), 'ynot-m13-print-'));
});
test.afterAll(async () => {
  await app.close();
  rmSync(scratch, { recursive: true, force: true });
});

test('M13 — print an unsaved text box and filled form through the print dialog, then undo the original edit', async () => {
  const j = journey(app);
  const source = await PDFDocument.create();
  const page = source.addPage([595.28, 841.89]);
  page.drawText('Print journey', { x: 40, y: 780 });
  const input = source.getForm().createTextField('fields.text');
  input.setText('Original value');
  input.addToPage(page, { x: 60, y: 680, width: 220, height: 30 });
  const bytes = [...(await source.save())];
  await app.run('file.openBytes', {
    file: { path: fixturePath('print-source.pdf'), name: 'print-source.pdf', bytes },
  });
  await j.clickRibbon('form', 'Fill In Form');
  const field = app.page
    .locator('.layer-widget')
    .getByRole('textbox', { name: 'fields.text', exact: true })
    .first();
  await field.fill('Printed current value');
  await app.page.keyboard.press('Tab');
  await expect
    .poll(
      async () =>
        ((await app.run('dev.formFields')) as Array<{ name: string; value: string }>).find(
          (f) => f.name === 'fields.text',
        )?.value,
    )
    .toBe('Printed current value');
  await app.run('annot.identity', { name: 'Print reviewer', initials: 'PR', email: '' });
  await j.clickRibbon('comment', 'Text Box');
  await j.dragOnPageAt([0.55, 0.3], [0.9, 0.38]);
  const editor = app.page.locator('.annot-editor');
  await expect(editor).toBeVisible();
  await editor.fill('Unsaved printed annotation');
  await app.page.keyboard.press('Control+Enter');
  await expect(editor).toBeHidden();
  await expect
    .poll(async () =>
      ((await app.run('dev.annotations', { page: 0 })) as Array<{ contents: string }>).some(
        (a) => a.contents === 'Unsaved printed annotation',
      ),
    )
    .toBe(true);
  const before = await app.run('dev.documentSummary');
  const journal = await app.run('dev.documentJournal');
  const target = join(scratch, 'with-appearances.pdf');
  await app.electron.evaluate(({ dialog }, path) => {
    dialog.showSaveDialog = () => Promise.resolve({ canceled: false, filePath: path });
  }, target);
  await app.page.keyboard.press('ControlOrMeta+p');
  const dialog = app.page.locator('#print-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('Print as image', { exact: true })).not.toBeChecked();
  await expectNothingClipped(dialog);
  await expectReadable(dialog);
  await dialog.getByRole('button', { name: 'Print to PDF…', exact: true }).click();
  await expect.poll(() => existsSync(target), { timeout: 30000 }).toBe(true);
  await expect(app.page.getByText('Wrote 1 sheets', { exact: true })).toBeVisible();
  expect(await app.run('dev.documentSummary')).toEqual(before);
  expect(await app.run('dev.documentJournal')).toEqual(journal);
  // Undo remains on the source: printing adds no edit and never replaces its pages.
  await app.page.keyboard.press('ControlOrMeta+z');
  expect(await app.run('dev.documentJournal')).not.toEqual(journal);
  const output = readFileSync(target);
  const pdf = await PDFDocument.load(output);
  expect(pdf.catalog.has(PDFName.of('AcroForm'))).toBe(false);
  expect(pdf.getPages().every((page) => (page.node.Annots()?.size() ?? 0) === 0)).toBe(true);
  await app.run('file.openBytes', {
    file: { path: fixturePath('printed.pdf'), name: 'printed.pdf', bytes: [...output] },
  });
  const text = (await app.run('dev.textLayer', { page: 0 })) as { text: string };
  expect(text.text).toContain('Printed current value');
  expect(text.text).toContain('Unsaved printed annotation');
  await expectWindowSound(app.page);
});

test('M13 — a missing appearance reports an error and disabling comments deliberately excludes it', async () => {
  const source = await PDFDocument.create();
  const page = source.addPage([300, 400]);
  page.drawText('Printable page content', { x: 30, y: 350, size: 14 });
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
      path: fixturePath('missing-appearance.pdf'),
      name: 'missing-appearance.pdf',
      bytes: [...(await source.save())],
    },
  });
  const target = join(scratch, 'missing-appearance-output.pdf');
  await app.electron.evaluate(({ dialog }, path) => {
    dialog.showSaveDialog = () => Promise.resolve({ canceled: false, filePath: path });
  }, target);
  await app.page.keyboard.press('ControlOrMeta+p');
  await app.page
    .locator('#print-dialog')
    .getByRole('button', { name: 'Print to PDF…', exact: true })
    .click();
  const error = app.page.getByRole('dialog', { name: 'Print to PDF', exact: true });
  await expect(error).toContainText('no usable normal appearance');
  expect(existsSync(target)).toBe(false);
  await error.getByRole('button', { name: 'OK', exact: true }).click();
  await app.page.keyboard.press('ControlOrMeta+p');
  const print = app.page.locator('#print-dialog');
  await print.getByLabel('Comments and annotations', { exact: true }).uncheck();
  await print.getByRole('button', { name: 'Print to PDF…', exact: true }).click();
  await expect.poll(() => existsSync(target), { timeout: 30000 }).toBe(true);
  await expect(app.page.getByText('Wrote 1 sheets', { exact: true }).last()).toBeVisible();
  const output = await PDFDocument.load(readFileSync(target));
  expect(output.getPageCount()).toBe(1);
  expect(output.getPage(0).node.Annots()?.size() ?? 0).toBe(0);
  await expectWindowSound(app.page);
});

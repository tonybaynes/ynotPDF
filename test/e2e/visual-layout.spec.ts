/** Cross-platform layout checks and reviewable images; pixel baselines remain Windows-only. */
import { expect, test } from '@playwright/test';
import { join } from 'node:path';
import { launchApp, type App } from './harness';
import { journey } from './journey';
import {
  expectInsideWindow,
  expectNoOverlap,
  expectNativeValueFits,
  expectReadable,
  expectWindowSound,
} from './layout';

/** Keep successful captures too: screenshots are evidence for human visual review. */
async function capture(app: App, name: string): Promise<void> {
  await app.page.evaluate(() => document.fonts.ready);
  const path = test.info().outputPath(name + '.png');
  await app.page.screenshot({ path, animations: 'disabled' });
  await test.info().attach(name, { path, contentType: 'image/png' });
}

for (const scale of [100, 150, 200]) {
  test.describe('visual layout at ' + String(scale) + '%', () => {
    let app: App;
    test.beforeAll(async () => {
      app = await launchApp({
        noDemo: true,
        window: { width: 1440, height: 1000 },
        settings: { 'ui.scale': scale },
      });
      expect(
        await app.page.evaluate(() =>
          Number.parseFloat(
            getComputedStyle(document.documentElement).getPropertyValue('--ui-scale'),
          ),
        ),
      ).toBeCloseTo(scale / 100);
    });
    test.afterAll(async () => {
      await app.close();
    });
    for (const theme of ['graphite', 'midnight', 'daylight', 'high-contrast']) {
      test(
        theme + ' keeps start, document panels and Preferences readable and reachable',
        async () => {
          await app.run('view.theme.set.' + theme);
          await expect(app.page.locator('#empty-state')).toBeVisible();
          await expectWindowSound(app.page);
          await expectReadable(app.page.locator('#ribbon'));
          await expectReadable(app.page.locator('#statusbar'));
          const home = app.page.locator('#ribbon-tabs [data-tab="home"]');
          await home.focus();
          await app.page.keyboard.press('Tab');
          const focus = app.page.locator(':focus');
          await expect(focus).toBeVisible();
          await expectInsideWindow(focus);
          expect(await focus.evaluate((node) => node.matches(':focus-visible'))).toBe(true);
          expect(
            await focus.evaluate((node) => {
              const style = getComputedStyle(node);
              return style.outlineStyle !== 'none' || style.boxShadow !== 'none';
            }),
          ).toBe(true);
          await capture(app, 'start-keyboard-focus');

          const j = journey(app);
          await j.openDocument(join(process.cwd(), 'test', 'fixtures', 'comments.pdf'));
          await j.openPanel('nav.pages');
          await app.run('annot.selectAll');
          if (!(await app.page.locator('#pane-right').isVisible()))
            await app.run('view.pane.right.toggle');
          await expect(app.page.locator('canvas').first()).toBeVisible();
          await expect
            .poll(async () => {
              const perf = (await app.run('dev.viewerPerf')) as {
                queued: number;
                inFlight: number;
              };
              return perf.queued + perf.inFlight;
            })
            .toBe(0);
          await capture(app, 'document-and-panels');
          await expectNoOverlap(
            app.page.locator('.status-left'),
            app.page.locator('.status-centre'),
          );
          await expectNoOverlap(
            app.page.locator('.status-centre'),
            app.page.locator('.status-right'),
          );
          await expectNoOverlap(
            app.page.locator('.status-left'),
            app.page.locator('.status-right'),
          );
          await expectWindowSound(app.page);
          await expectReadable(app.page.locator('#pane-left'));
          await expectReadable(app.page.locator('#pane-right'));

          // Native text fields can crop their value without reporting scroll overflow.
          // Measure each actual fit label in the field's rendered font instead.
          for (const [command, label] of [
            ['view.zoom.fitPage', 'Fit page'],
            ['view.zoom.fitWidth', 'Fit width'],
            ['view.zoom.fitVisible', 'Fit visible'],
          ]) {
            if (!command || !label) throw new Error('Missing fit-mode test case');
            await app.run(command);
            const field = app.page.locator('#status-zoom-input');
            await expect(field).toHaveValue(label);
            await expectNativeValueFits(field);
          }
          await expect
            .poll(async () => {
              const perf = (await app.run('dev.viewerPerf')) as {
                queued: number;
                inFlight: number;
              };
              return perf.queued + perf.inFlight;
            })
            .toBe(0);
          await capture(app, 'fit-visible-label');

          const opening = app.run('app.preferences');
          const dialog = app.page.locator('#preferences-dialog');
          await expect(dialog).toBeVisible();
          await expectWindowSound(app.page);
          await expectReadable(dialog);
          await capture(app, 'preferences');
          await app.page.keyboard.press('Shift+Tab');
          expect(await dialog.evaluate((node) => node.contains(document.activeElement))).toBe(true);
          await app.page.keyboard.press('Escape');
          await opening;
          await expect(dialog).toHaveCount(0);
          await app.run('file.close');
          await expect(app.page.locator('#empty-state')).toBeVisible();
        },
      );
    }
  });
}

test.describe('export native choices at 200%', () => {
  let app: App;
  test.beforeAll(async () => {
    app = await launchApp({
      noDemo: true,
      window: { width: 1280, height: 800 },
      settings: { 'ui.scale': 200 },
    });
    await journey(app).openDocument(join(process.cwd(), 'test', 'fixtures', 'comments.pdf'));
  });
  test.afterAll(async () => {
    await app.close();
  });
  for (const theme of ['graphite', 'midnight', 'daylight', 'high-contrast']) {
    test(theme + ' displays full export values and wrapping explanations', async () => {
      await app.run('view.theme.set.' + theme);
      const opening = app.run('convert.exportImages');
      const dialog = app.page.locator('#export-images-dialog');
      await expect(dialog).toBeVisible();
      const format = dialog.getByLabel('Format', { exact: true });
      for (const value of ['png', 'jpeg', 'tiff', 'bmp']) {
        await format.selectOption(value);
        await expectNativeValueFits(format);
      }
      await format.selectOption('tiff');
      // Reintroduce the original long native value: the regression must detect it.
      await format.evaluate((node) => {
        const option = (node as HTMLSelectElement).selectedOptions[0];
        if (option) option.textContent = 'TIFF — lossless, can hold every page in one file';
      });
      try {
        await expect(expectNativeValueFits(format)).rejects.toThrow(/Native value.*available/);
      } finally {
        await format.evaluate((node) => {
          const option = (node as HTMLSelectElement).selectedOptions[0];
          if (option) option.textContent = 'TIFF';
        });
      }
      await expectNativeValueFits(format);
      await format.scrollIntoViewIfNeeded();
      await capture(app, 'export-format-visible');
      await dialog.getByLabel('Colour', { exact: true }).selectOption('mono');
      await expectNativeValueFits(dialog.getByLabel('Colour', { exact: true }));
      const method = dialog.getByLabel('Black and white method', { exact: true });
      for (const value of ['floyd-steinberg', 'none']) {
        await method.selectOption(value);
        await method.scrollIntoViewIfNeeded();
        await expectNativeValueFits(method);
      }
      await capture(app, 'export-method-visible');
      const compression = dialog.getByLabel('TIFF compression', { exact: true });
      for (const value of ['deflate', 'packbits', 'none', 'group4']) {
        await compression.selectOption(value);
        await compression.scrollIntoViewIfNeeded();
        await expectNativeValueFits(compression);
      }
      await expect(dialog).toContainText('black and white (1-bit) pages only');
      await expectInsideWindow(dialog);
      await expectReadable(dialog);
      await capture(app, 'export-group4-visible-options');
      await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
      await opening;
      await expect(dialog).toHaveCount(0);
    });
  }
});

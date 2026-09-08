import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(import.meta.dirname, 'src/shared'),
      '@engine': resolve(import.meta.dirname, 'src/engine'),
      '@core': resolve(import.meta.dirname, 'src/renderer/core'),
      '@app': resolve(import.meta.dirname, 'src/renderer/app'),
      '@view': resolve(import.meta.dirname, 'src/renderer/view'),
      '@theme': resolve(import.meta.dirname, 'src/renderer/theme'),
      '@modules': resolve(import.meta.dirname, 'src/renderer/modules'),
    },
  },
  test: {
    include: ['test/unit/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    coverage: {
      provider: 'v8',
      include: [
        'src/renderer/core/**/*.ts',
        // M21's engine half: the writer contract, the pdf-lib writer and the appearance
        // generators. M10's PDFium adapter stays out — it is proved against the corpus, not by
        // line coverage.
        'src/engine/Writer.ts',
        'src/engine/writers/**/*.ts',
        'src/engine/appearance/**/*.ts',
        // M91's converters: pure over bytes, so all of them are gated.
        'src/engine/create/**/*.ts',
        'src/shared/pageSizes.ts',
        'scripts/lib/**/*.ts',
        'src/renderer/theme/**/*.ts',
        'src/renderer/modules/**/*.ts',
        'src/renderer/view/**/*.ts',
      ],
      /*
       * Excluded from the gate, not from the tests: the gallery is a dev-only page and the
       * status-bar switcher is pure DOM wiring — both are exercised by Playwright
       * (test/e2e/theme.spec.ts), which is where UI behaviour belongs.
       */
      exclude: [
        'src/renderer/theme/gallery.ts',
        'src/renderer/modules/M01-theme-system/switcher.ts',
        /*
         * M11's DOM half. There is no jsdom in this repo (the brief adds no libraries), so the
         * viewport, the page views, the overlays, the loupe and the HUD are proved by Playwright
         * in `test/e2e/viewer.spec.ts` instead — which is where DOM behaviour belongs anyway.
         * Everything they are built out of is pure and gated below.
         */
        'src/renderer/view/DocumentView.ts',
        'src/renderer/view/PageView.ts',
        'src/renderer/view/Layers.ts',
        'src/renderer/view/Overlays.ts',
        'src/renderer/view/Loupe.ts',
        'src/renderer/view/PerfHud.ts',
        'src/renderer/view/TileRenderer.ts',
        'src/renderer/modules/M11-viewer/Viewer.ts',
        'src/renderer/modules/M11-viewer/ViewerService.ts',
        'src/renderer/modules/M11-viewer/password.ts',
        'src/renderer/modules/M11-viewer/tools.ts',
        /*
         * M21's DOM and shell half, for the same reason: `SaveService` orchestrates dialogs,
         * IPC and the tab strip, and `dialogs.ts` and `manifest.ts` are the dialogs and the
         * contribution points themselves. All three are proved by Playwright in
         * `test/e2e/save.spec.ts`, which is where a Save / Don't save / Cancel flow belongs;
         * the decisions underneath them are unit-tested in `test/unit/save/service.test.ts`.
         */
        'src/renderer/modules/M21-save/SaveService.ts',
        'src/renderer/modules/M21-save/dialogs.ts',
        'src/renderer/modules/M21-save/manifest.ts',
        /*
         * M91's DOM and shell half, for the same reason again: `CreateService` orchestrates the
         * file dialogs, the Worker, main's printer and the tab strip; `dialogs.ts` and `forms.ts`
         * are the option dialogs themselves; `manifest.ts` is the contribution points; and the
         * two decoders and the Worker entry need a browser. All are proved by Playwright in
         * `test/e2e/create.spec.ts`, and everything they are built out of is pure and gated
         * above (`src/engine/create/**`) or below.
         */
        'src/renderer/modules/M91-create-pdf/CreateService.ts',
        'src/renderer/modules/M91-create-pdf/dialogs.ts',
        'src/renderer/modules/M91-create-pdf/forms.ts',
        'src/renderer/modules/M91-create-pdf/manifest.ts',
        'src/renderer/modules/M91-create-pdf/open.ts',
        'src/renderer/modules/M91-create-pdf/rasterDecoder.ts',
        'src/renderer/modules/M91-create-pdf/create.worker.ts',
      ],
      reporter: ['text', 'lcov'],
      thresholds: {
        'src/renderer/core/Store.ts': { lines: 95, functions: 95, statements: 95 },
        'src/renderer/core/UndoStack.ts': { lines: 95, functions: 95, statements: 95 },
        // M20's model. The undo stack has to be exactly right, so the gate is high.
        'src/renderer/core/Document.ts': { lines: 92, functions: 90, statements: 92 },
        'src/renderer/core/commands.ts': { lines: 95, functions: 95, statements: 95 },
        'src/renderer/core/Journal.ts': { lines: 95, functions: 95, statements: 95 },
        'src/renderer/core/Ids.ts': { lines: 95, functions: 95, statements: 95 },
        'src/renderer/core/model.ts': { lines: 90, functions: 90, statements: 90 },
        'src/renderer/core/events.ts': { lines: 90, functions: 90, statements: 90 },
        'src/renderer/theme/ThemeManager.ts': { lines: 95, functions: 95, statements: 95 },
        'src/renderer/theme/contrast.ts': { lines: 95, functions: 95, statements: 95 },
        'src/renderer/theme/separation.ts': { lines: 95, functions: 95, statements: 95 },
        'src/renderer/theme/parse.ts': { lines: 95, functions: 95, statements: 95 },
        'src/renderer/modules/M01-theme-system/**': { lines: 90, functions: 90, statements: 90 },
        // M11's pure view maths: the layout table, tiling, the LRU, Night Mode, zoom, units,
        // guides and history. These decide what the reader sees, so the gate is high.
        'src/renderer/view/layout.ts': { lines: 95, functions: 95, statements: 95 },
        'src/renderer/view/tiles.ts': { lines: 95, functions: 95, statements: 95 },
        'src/renderer/view/TileCache.ts': { lines: 95, functions: 90, statements: 95 },
        'src/renderer/view/night.ts': { lines: 95, functions: 95, statements: 95 },
        'src/renderer/view/zoom.ts': { lines: 90, functions: 90, statements: 90 },
        'src/renderer/view/units.ts': { lines: 90, functions: 90, statements: 90 },
        'src/renderer/view/guides.ts': { lines: 90, functions: 85, statements: 90 },
        'src/renderer/view/history.ts': { lines: 95, functions: 95, statements: 95 },
        'src/renderer/modules/M11-viewer/settings.ts': {
          lines: 90,
          functions: 85,
          statements: 90,
        },
        // M21. The writer decides what the file on disk says, so its gate is the highest here.
        'src/engine/writers/FullRewriteWriter.ts': { lines: 85, functions: 90, statements: 85 },
        'src/engine/appearance/generators.ts': { lines: 90, functions: 95, statements: 90 },
        'src/engine/appearance/content.ts': { lines: 90, functions: 85, statements: 90 },
        'src/engine/appearance/metrics.ts': { lines: 95, functions: 95, statements: 95 },
        'src/engine/appearance/index.ts': { lines: 90, functions: 90, statements: 90 },
        'src/renderer/modules/M21-save/plan.ts': { lines: 90, functions: 90, statements: 90 },
        'src/renderer/modules/M21-save/recovery.ts': { lines: 85, functions: 75, statements: 85 },
        'src/renderer/modules/M21-save/commands.ts': { lines: 90, functions: 90, statements: 90 },
        'src/renderer/modules/M21-save/settings.ts': { lines: 80, functions: 70, statements: 80 },
        'src/renderer/modules/M21-save/WriterClient.ts': {
          lines: 75,
          functions: 80,
          statements: 75,
        },
        // M91. The converters decide what a created document says, so their gates are high; the
        // header parsers are the highest because everything downstream trusts what they report.
        'src/engine/create/images/headers.ts': { lines: 90, functions: 95, statements: 90 },
        'src/engine/create/images/layout.ts': { lines: 95, functions: 95, statements: 95 },
        'src/engine/create/images/raster.ts': { lines: 90, functions: 90, statements: 90 },
        'src/engine/create/images/tiff.ts': { lines: 85, functions: 90, statements: 85 },
        'src/engine/create/images/ImageConverter.ts': { lines: 85, functions: 90, statements: 85 },
        'src/engine/create/text/TextConverter.ts': { lines: 90, functions: 90, statements: 90 },
        'src/engine/create/text/decode.ts': { lines: 95, functions: 95, statements: 95 },
        'src/engine/create/blank/BlankConverter.ts': { lines: 90, functions: 90, statements: 90 },
        'src/engine/create/html/HtmlConverter.ts': { lines: 85, functions: 85, statements: 85 },
        'src/engine/create/web/crawl.ts': { lines: 90, functions: 90, statements: 90 },
        'src/engine/create/web/assemble.ts': { lines: 90, functions: 90, statements: 90 },
        'src/engine/create/web/urls.ts': { lines: 95, functions: 95, statements: 95 },
        'src/engine/create/web/WebConverter.ts': { lines: 85, functions: 85, statements: 85 },
        'src/engine/create/registry.ts': { lines: 90, functions: 90, statements: 90 },
        'src/engine/create/types.ts': { lines: 90, functions: 90, statements: 90 },
        'src/engine/create/markdown.ts': { lines: 95, functions: 95, statements: 95 },
        'src/shared/pageSizes.ts': { lines: 90, functions: 90, statements: 90 },
        'src/renderer/modules/M91-create-pdf/settings.ts': {
          lines: 80,
          functions: 70,
          statements: 80,
        },
        'src/renderer/modules/M91-create-pdf/ConvertClient.ts': {
          lines: 75,
          functions: 80,
          statements: 75,
        },
      },
    },
  },
});

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
      },
    },
  },
});

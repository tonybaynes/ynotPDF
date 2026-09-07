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
      ],
      /*
       * Excluded from the gate, not from the tests: the gallery is a dev-only page and the
       * status-bar switcher is pure DOM wiring — both are exercised by Playwright
       * (test/e2e/theme.spec.ts), which is where UI behaviour belongs.
       */
      exclude: [
        'src/renderer/theme/gallery.ts',
        'src/renderer/modules/M01-theme-system/switcher.ts',
      ],
      reporter: ['text', 'lcov'],
      thresholds: {
        'src/renderer/core/Store.ts': { lines: 95, functions: 95, statements: 95 },
        'src/renderer/core/UndoStack.ts': { lines: 95, functions: 95, statements: 95 },
        'src/renderer/theme/ThemeManager.ts': { lines: 95, functions: 95, statements: 95 },
        'src/renderer/theme/contrast.ts': { lines: 95, functions: 95, statements: 95 },
        'src/renderer/theme/separation.ts': { lines: 95, functions: 95, statements: 95 },
        'src/renderer/theme/parse.ts': { lines: 95, functions: 95, statements: 95 },
        'src/renderer/modules/M01-theme-system/**': { lines: 90, functions: 90, statements: 90 },
      },
    },
  },
});

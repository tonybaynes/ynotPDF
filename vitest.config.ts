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
      '@modules': resolve(import.meta.dirname, 'src/renderer/modules'),
    },
  },
  test: {
    include: ['test/unit/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    coverage: {
      provider: 'v8',
      include: ['src/renderer/core/**/*.ts', 'scripts/lib/**/*.ts'],
      reporter: ['text', 'lcov'],
      thresholds: {
        'src/renderer/core/Store.ts': { lines: 95, functions: 95, statements: 95 },
        'src/renderer/core/UndoStack.ts': { lines: 95, functions: 95, statements: 95 },
      },
    },
  },
});

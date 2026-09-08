import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';

/**
 * Three build entries (main, preload, renderer). The PDF engine Worker
 * (`src/engine/worker.ts`) is a fourth bundle emitted by the renderer build:
 * Vite discovers it through `new Worker(new URL('./worker.ts', import.meta.url))`
 * in `src/engine/EngineClient.ts` and compiles it as an ES-module worker.
 *
 * The main build has a second entry, `searchWorker`, for M13's folder search: it runs in a Node
 * `worker_thread` started by `src/main/search/index.ts`, which loads it from `out/main/` by name
 * (ADR 0011). Vite cannot discover it the way it discovers a Web Worker, so it is declared here.
 */
const aliases = {
  '@shared': resolve(import.meta.dirname, 'src/shared'),
  '@engine': resolve(import.meta.dirname, 'src/engine'),
  '@core': resolve(import.meta.dirname, 'src/renderer/core'),
  '@app': resolve(import.meta.dirname, 'src/renderer/app'),
  '@view': resolve(import.meta.dirname, 'src/renderer/view'),
  '@theme': resolve(import.meta.dirname, 'src/renderer/theme'),
  '@modules': resolve(import.meta.dirname, 'src/renderer/modules'),
};

export default defineConfig({
  main: {
    resolve: { alias: aliases },
    build: {
      externalizeDeps: true,
      rollupOptions: {
        input: {
          index: resolve(import.meta.dirname, 'src/main/index.ts'),
          searchWorker: resolve(import.meta.dirname, 'src/main/search/worker.ts'),
        },
      },
    },
  },
  preload: {
    resolve: { alias: aliases },
    build: {
      externalizeDeps: true,
      // The window runs with `sandbox: true`; sandboxed preloads must be plain CommonJS.
      rollupOptions: {
        input: { index: resolve(import.meta.dirname, 'src/preload/index.ts') },
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    resolve: { alias: aliases },
    worker: { format: 'es' },
    // M10: the PDFium wasm is inlined into the engine worker bundle (`?inline`).
    assetsInclude: ['**/*.wasm'],
    build: {
      rollupOptions: { input: { index: resolve(import.meta.dirname, 'src/renderer/index.html') } },
    },
  },
});

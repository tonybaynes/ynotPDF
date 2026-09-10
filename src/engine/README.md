# src/engine

The PDF engine layer. Runs inside a **Web Worker** so rendering never blocks the UI.

| File              | What                                                                                                                                                        |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PdfEngine.ts`    | The `PdfEngine` interface every backend implements, all value types (`TextRun`, `Annotation`, `FormField`, ...), `EngineError`, and `NotImplementedEngine`. |
| `EngineClient.ts` | Renderer-side proxy. `EngineClient.spawn().engine` is a `PdfEngine` whose calls travel over `postMessage`.                                                  |
| `worker.ts`       | Worker entry: `serveEngine(createEngine(), self)`. M10 swaps `createEngine()` for the PDFium adapter.                                                       |
| `rpc.ts`          | Message shapes and the transferable collector.                                                                                                              |

Writing (M21, ADR 0010):

| File                           | What                                                                                                   |
| ------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `Writer.ts`                    | The `Writer` interface and `WritePlan` — the finished document as data. Every section is nullable.     |
| `writers/FullRewriteWriter.ts` | pdf-lib. Applies what PDFium could not; everything it does not plan, it does not touch.                |
| `appearance/`                  | `/AP` generation for the subtypes PDFium will not synthesise. A registry: later modules add their own. |

A writer takes the document **as the engine holds it** plus a plan of what is left over, and is a
pure function of the two — no clock, no file, no UI — so a crash recovery and a batch run produce
the file an interactive save would. M80 adds `IncrementalWriter` behind the same interface.

Adapters (M10 `PdfiumEngine`, later qpdf / Tesseract bridges) live here as `<name>Engine.ts` /
`<name>Adapter.ts`. Geometry is PDF points, origin bottom-left; see `src/shared/pdf.ts`.

Optimising and repairing (M100, ADR 0019):

| File                 | What                                                                                                                                |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `optimise/`          | Reducing a file's size: images, fonts, duplicates, discards, the space audit, the presets. Pure over bytes, so a Worker can run it. |
| `optimise/qpdf/`     | The qpdf façade — object streams, flate, unreferenced objects, linearisation, `--check`. Given a runner; never makes one.           |
| `optimise/repair.ts` | PDFium first, qpdf second: this build of qpdf reconstructs nothing, and the two disagree about what is fatal (ADR 0019 §1a).        |

`src/engine/optimise/**` may not import from `src/main`, `src/renderer` or `node:*`, which is what
lets M120's batch and M121's command line optimise a file with no window open.

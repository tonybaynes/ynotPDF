# src/engine

The PDF engine layer. Runs inside a **Web Worker** so rendering never blocks the UI.

| File              | What                                                                                                                                                        |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PdfEngine.ts`    | The `PdfEngine` interface every backend implements, all value types (`TextRun`, `Annotation`, `FormField`, ...), `EngineError`, and `NotImplementedEngine`. |
| `EngineClient.ts` | Renderer-side proxy. `EngineClient.spawn().engine` is a `PdfEngine` whose calls travel over `postMessage`.                                                  |
| `worker.ts`       | Worker entry: `serveEngine(createEngine(), self)`. M10 swaps `createEngine()` for the PDFium adapter.                                                       |
| `rpc.ts`          | Message shapes and the transferable collector.                                                                                                              |

Adapters (M10 `PdfiumEngine`, later qpdf / Tesseract bridges) live here as `<name>Engine.ts` /
`<name>Adapter.ts`. Geometry is PDF points, origin bottom-left; see `src/shared/pdf.ts`.

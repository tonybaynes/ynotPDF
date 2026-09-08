# test

- `unit/` — vitest. Model, engine, lint-rule and hook tests. `npm test` enforces coverage gates
  on `Store.ts`, `UndoStack.ts`, the M20 model files (`Document`, `commands`, `Journal`, `Ids`,
  `model`, `events`) and the theme maths.
  - `unit/core/` — the document model (M20). `fakeEngine.ts` is an in-memory `PdfEngine` so the
    property test can apply a thousand commands in seconds and can turn individual mutations off
    to exercise the fallback paths; `integration.test.ts` runs the same model over real PDFium.
  - `unit/engine/` — the PDFium adapter (M10, M20) against the fixture corpus.
- `e2e/` — Playwright driving the built Electron app through `harness.ts`
  (`launchApp()` → `run(commandId, args)`). Every module's UI test goes through this.
- `fixtures/` — synthetic PDF corpus; see its README. The only place `.pdf` files may live.

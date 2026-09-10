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

## Running the suite while you work

E2E windows are **invisible by default**: parked off every display, transparent, kept out of the
taskbar, and shown inactive, so a run never steals the keyboard or follows you between virtual
desktops. Playwright drives the renderer over the debug protocol rather than real OS input, so
nothing is lost — screenshots, focus order and pointer journeys all still work.

To watch a run (debugging a journey, say):

```bash
YNOT_E2E_VISIBLE=1 npx playwright test test/e2e/<spec>.spec.ts
```

On Windows PowerShell: `$env:YNOT_E2E_VISIBLE=1; npx playwright test …` — and clear it after with
`Remove-Item Env:YNOT_E2E_VISIBLE`.

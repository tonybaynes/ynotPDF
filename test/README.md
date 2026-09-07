# test

- `unit/` — vitest. Model, engine, lint-rule and hook tests. `npm test` enforces ≥ 95 % line
  coverage on `Store.ts` and `UndoStack.ts`.
- `e2e/` — Playwright driving the built Electron app through `harness.ts`
  (`launchApp()` → `run(commandId, args)`). Every module's UI test goes through this.
- `fixtures/` — synthetic PDF corpus; see its README. The only place `.pdf` files may live.

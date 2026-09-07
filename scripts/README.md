# scripts

Build and maintenance helpers, all TypeScript run directly by Node 26 (`node scripts/x.ts`,
no transpile step — keep to erasable syntax).

| Script              | Purpose                                                                                                                                                         |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `check-styles.ts`   | Lint rule: no colour literals outside `src/renderer/theme/`; no `rgba()` alpha < 1, `opacity` < 1 or `backdrop-filter` anywhere. Logic in `lib/style-rules.ts`. |
| `check-licenses.ts` | Fails on GPL/AGPL/LGPL-only/commercial production dependencies (`license-checker`).                                                                             |
| `make-icon.ts`      | Generates the placeholder 512×512 `resources/build/icon.png`; electron-builder derives `.ico`/`.icns`. Replace with the real logo (M131).                       |
| `make-fixtures.ts`  | Generates the synthetic PDF corpus in `test/fixtures/` (pdf-lib + a tiny RC4 writer).                                                                           |
| `fetch-binaries.ts` | Downloads per-OS native binaries listed in `resources/binaries.json` into `resources/bin/`, verifying SHA-256.                                                  |

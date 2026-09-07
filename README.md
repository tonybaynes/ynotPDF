# ynotPDF

Cross-platform (Windows / macOS / Linux) PDF editor targeting the feature set of Foxit PDF
Editor 14. Electron + TypeScript, PDFium engine, four colour themes, dark by default.

- Master plan: [PLAN.md](PLAN.md) · session rules: [CLAUDE.md](CLAUDE.md) · module briefs:
  [docs/modules/](docs/modules/) · decisions: [docs/adr/](docs/adr/)
- Architecture: PLAN.md §4. Contracts every module codes against: `src/engine/PdfEngine.ts`,
  `src/shared/module.ts`, `src/shared/ipc.ts`, `src/renderer/core/*`.

## Setup

Requirements: **Node 26+** and npm 11+, git. No Docker, no global tools.

```bash
npm install
```

`npm install` also downloads the Electron binary (`postinstall`) and installs the git hooks
(`prepare` → husky → `.githooks/`). npm 11 gates third-party install scripts; the ones we need
(`electron`, `esbuild`, `electron-winstaller`) are approved in `package.json` → `allowScripts`.

Native engine binaries (PDFium, qpdf, Tesseract) are fetched per OS by
`npm run fetch-binaries` from `resources/binaries.json` — empty until M10.

## Scripts

| Script                   | What                                                                      |
| ------------------------ | ------------------------------------------------------------------------- |
| `npm run dev`            | electron-vite dev server with HMR, opens the app                          |
| `npm run build`          | Production build into `out/` (main, preload, renderer, engine worker)     |
| `npm test`               | vitest unit tests with coverage (≥ 95 % on `Store.ts`, `UndoStack.ts`)    |
| `npm run e2e`            | Build, then Playwright drives the built app (`test/e2e/harness.ts`)       |
| `npm run lint`           | eslint · prettier --check · colour/opacity rules · tsc                    |
| `npm run format`         | prettier --write                                                          |
| `npm run fixtures`       | Regenerate the synthetic PDF corpus in `test/fixtures/`                   |
| `npm run icon`           | Regenerate the placeholder app icon (`resources/build/icon.png`)          |
| `npm run gallery`        | Dev-only theme gallery: all four palettes, every contrast number          |
| `npm run fetch-binaries` | Download pinned native binaries into `resources/bin/`                     |
| `npm run licenses`       | Fail on GPL/AGPL/LGPL/commercial production dependencies                  |
| `npm run package`        | Build + electron-builder installers into `release/` (unsigned until M131) |

## Repository layout

See PLAN.md §7. Every folder has a `README.md` saying what belongs there.

## Conventions

- Branch `mod/<Mid>-<slug>` in its own worktree; merge to `main` when CI is green on all three
  OSes. Commits `<Mid>: <what>` with the Claude co-author trailer.
- Colours only through theme tokens (`src/renderer/theme/`, four themes, Graphite default).
  No `rgba()` alpha < 1, no `opacity` < 1, no `backdrop-filter` — the lint fails otherwise,
  and `npm test` fails if any theme breaks the contrast rules. `npm run gallery` shows them.
- Every user action is a registered command (palette); every document change is an undoable
  `Command`.
- Never commit real customer PDFs, binaries or secrets — the pre-commit hook refuses them.

## Testing the app from Playwright

```ts
import { launchApp } from './harness';
const app = await launchApp();
await app.run('app.about');
```

`window.__ynot.run(commandId, args)` exists only when the app is launched with `YNOT_E2E=1`.

## Installing local toolchains

None needed yet. When a module installs one (Rust, C++, emsdk), it records why in `docs/adr/`
and adds the install step here.

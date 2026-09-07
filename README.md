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

Build-time downloads come from `resources/binaries.json` via `npm run fetch-binaries` (pinned
SHA-256, git-ignored): today that is the Liberation and DejaVu font files PDFium uses for
non-embedded fonts (M10). Run it once before `npm run build` / `npm run dev`; without the fonts
the app still works and PDFium falls back to its built-in Foxit fonts. Later modules add qpdf and
Tesseract the same way. The PDF engine itself is PDFium compiled to WebAssembly (`@hyzyla/pdfium`,
plain npm dependency, no native binary).

`npm run fetch-fixtures` downloads the pinned pdf.js test PDFs into `test/fixtures/external/`
for the engine corpus test; when they are absent those entries are skipped.

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
| `npm run gallery`        | Dev-only theme gallery on <http://localhost:5199/gallery.html>            |
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

## Application shell (M02)

The chrome is data-driven from module manifests (`src/shared/module.ts`, ADR 0004): ribbon
groups and contextual tabs, panels on either side, status-bar slots, File-backstage slots,
creators and context menus. Nothing outside `src/renderer/app/` builds ribbon DOM. Every widget
kind is exercised by the demo module in `test/e2e/demo-module/` (registered only in e2e runs)
and `test/e2e/shell.spec.ts` — extend the demo when you add a widget; never delete from it.

Icons are Lucide (ISC) via the `lucide` devDependency, tree-shaken through
`src/renderer/app/icons.ts`; register extra icons with `registerIcon()`. `axe-core` (dev only)
checks contrast and focus in the shell e2e for all four themes.

## Testing the app from Playwright

```ts
import { launchApp } from './harness';
const app = await launchApp();
await app.run('app.about');
```

`window.__ynot.run(commandId, args)` exists only when the app is launched with `YNOT_E2E=1`.

## Installing local toolchains

None needed yet. When a module installs one (Rust, C++, emsdk), it records why in `docs/adr/`
and adds the install step here. M10 evaluated native PDFium (koffi FFI) and a custom emscripten
build and needed neither: the npm wasm build passes every performance target (ADR 0006).

## PDF engine (M10)

PDFium runs as WebAssembly inside the renderer's engine Worker (`src/engine/`). Useful commands:

- `npm run fetch-binaries` — fonts for non-embedded text (once; git-ignored).
- `npm run fetch-fixtures` — pinned pdf.js test PDFs for the corpus test (git-ignored).
- `npm run bench` — engine benchmarks; writes `docs/bench/engine-<platform>-<arch>.json`.
- `npm run hashes` — regenerate `test/fixtures/hashes/<platform>.json` after an intentional
  rendering change (new PDFium, fonts or fixtures). Review the diff.
- In the app: **Engine: probe a PDF** (command palette, `dev.engineOpen`) opens a file in the
  worker and reports what the engine sees.

# M03 — Windows on ARM (arm64) support

| | |
|---|---|
| **Module id** | `M03` — branch `mod/M03-windows-arm` (no renderer module folder: this touches build config only) |
| **Earliest wave** | 2 (see `PLAN.md` §0/§12) |
| **Tier** | Core |
| **Depends on** | M00, M10 |
| **Unlocks** | nothing blocks on it, but M70, M90 and M131 read its ADR |

## Your task — the prompt for this conversation

You are building **M03 — Windows on ARM (arm64) support** of ynotPDF. Carry
this brief out end to end without waiting to be asked for the next step:

1. Read this file completely, then `CLAUDE.md`, `PLAN.md` §2–4, §9 and §12,
   and the briefs of your direct dependencies: [M00 Scaffold](./M00-scaffold.md),
   [M10 Engine layer](./M10-engine-layer.md) — especially their Build logs
   and `docs/adr/0006-pdfium-adapter.md`. Confirm both are ☑ in `PLAN.md`
   §0.
2. Create branch `mod/M03-windows-arm` from `main` in a new git worktree and
   work there.
3. Fill in **Design decisions** below before changing config; write
   `docs/adr/00NN-windows-arm.md` recording what is architecture-specific in
   the app today and the rule for future native binaries.
4. Implement the **Scope** section — all of it.
5. Run `npm run lint`, `npm test`, `npm run build`, `npm run package`
   locally; push and make CI green on all three OSes with the new arm64
   artifacts present.
6. Merge to `main`, tick M03 ☑ in `PLAN.md` §0 in the same merge, fill in
   the **Build log** below.
7. Report back in a few plain lines, including exactly how the operator can
   test the arm64 installer.

---

## Purpose

Make the Windows build ship for **arm64** as well as x64, prove it in CI,
and set the rule every later module follows when it adds a native binary.
The operator wants Windows-on-ARM as a first-class target.

## Why this is small

After M00 and M10 the app contains **no architecture-specific code**:
Electron itself publishes `win32-arm64` builds, PDFium runs as
WebAssembly (`@hyzyla/pdfium`, ADR 0006), and the only fetched binaries are
fonts (`resources/binaries.json` targets `any`). So today arm64 support is
packaging + verification. The lasting value is the rule for M70 (qpdf), M90
(Tesseract) and M131 (installers), which will add real native binaries.

## Scope — build all of this

- `electron-builder.yml`: Windows targets `nsis` and `msi` for
  `arch: [x64, arm64]`; keep `artifactName` carrying `${arch}` (it already
  does) so files come out as `ynotPDF-<ver>-win-x64.exe` /
  `…-win-arm64.exe`; confirm the NSIS installer refuses to install the
  wrong architecture (electron-builder does this by default — verify and
  note).
- `scripts/fetch-binaries.ts` / `resources/binaries.json`: fetching must be
  driven by the **target** platform/arch (from `--platform`/`--arch` args or
  env `YNOT_TARGET`), not only the host, so an x64 runner can package an
  arm64 installer. Add a lint-style check that every entry with a
  `win32-x64` target also has `win32-arm64` **or** an explicit
  `"arm64Fallback": "wasm"` field, and fail `fetch-binaries` otherwise, with
  a worded message naming the module.
- `src/main` runtime helper `targetArch()` (or similar) exposing
  `process.arch` to modules that must choose a binary vs WASM path; unit
  test.
- `.github/workflows/ci.yml`: the Windows job packages **both** x64 and
  arm64 (cross-package on the x64 runner: `electron-builder --win --x64
  --arm64`); artifact upload picks up both. Then **verify** the arm64 build
  actually runs: add a `windows-11-arm` job if the runner is available to
  this repository (check `gh api /repos/tonybaynes/ynotPDF/actions/runners`
  and try a workflow run; GitHub hosts `windows-11-arm` runners — availability
  for private repos depends on the plan). If it is available: install the
  arm64 artifact silently, launch, run the Playwright smoke (`app.about`).
  If it is not available: document that clearly in the ADR and in
  `README.md`, and provide a manual smoke checklist the operator runs on an
  ARM device; do not pretend it was tested.
- `README.md`: supported platforms table (Windows x64, Windows arm64, macOS
  universal, Linux x64), how to build a specific arch locally, how to tell
  which one is installed (About dialog — add the arch string to
  `app.about`, a tiny additive change in `src/renderer/app/`).
- `docs/adr/00NN-windows-arm.md`: the rule — every native binary ships
  `win32-arm64` or declares a WASM fallback; CI packages both; M70/M90/M131
  briefs already reference this ADR by name.
- `PLAN.md` §3.1 already lists the target; keep it true.

## Out of scope

Linux arm64 (not requested; the same mechanism would cover it later).
Signing (M131). Native PDFium (still in reserve per ADR 0006 — if it is
ever adopted, `pdfium-binaries` publishes `win-arm64`).

## Design notes & constraints

- Cross-packaging arm64 from an x64 runner is the normal electron-builder
  path; the Electron arm64 zip is downloaded into the cache. Keep the cache
  paths outside the workspace as M00 did (ESM `type: module` gotcha).
- Do not add a fourth full test matrix leg unless the ARM runner exists;
  the point is a real smoke on real ARM, or an honest note that it awaits
  one.

## Files you will create or touch

`electron-builder.yml`, `.github/workflows/ci.yml`, `scripts/fetch-binaries.ts`,
`resources/binaries.json` (schema note in `$comment`), `src/main/arch.ts`,
`src/renderer/app/` (About dialog arch string — additive), `README.md`,
`docs/adr/00NN-windows-arm.md`, tests.

## Libraries

None new.

## Acceptance tests — the module is done when these pass

- CI's Windows job uploads four installers: NSIS and MSI for x64 **and**
  arm64, each named with its arch.
- `fetch-binaries` fails with a worded error when a test entry has
  `win32-x64` but neither `win32-arm64` nor `arm64Fallback`.
- Either: the `windows-11-arm` job installs and launches the arm64 build and
  the smoke passes — or: the ADR and README state that ARM CI is
  unavailable and the operator's manual smoke on an ARM device is recorded
  in the Build log (ask the operator whether an ARM machine exists).
- About dialog shows `Windows arm64` / `Windows x64` correctly.

---

## Project context (identical in every module brief — read once per session)

**ynotPDF** is a cross-platform (Windows / macOS / Linux) desktop PDF editor
targeting the feature set of **Foxit PDF Editor 14**, with four colour themes
and a dark default. Project root: `D:\Projects\ynotPDF` (Windows path;
`/d/Projects/ynotPDF` in Git Bash). Master plan: `PLAN.md`. Session rules:
`CLAUDE.md`. This brief is one module of that plan.

**Stack (fixed — do not substitute):**
- **TypeScript** end-to-end, `strict`. **Electron** shell, **electron-vite**
  build, **vitest** unit tests, **Playwright** e2e. Node 26.
- **Vanilla DOM UI, no framework.** State → DOM via the in-house store in
  `src/renderer/core/store.ts`.
- **PDF engine:** PDFium (BSD) behind the `PdfEngine` interface in
  `src/engine/PdfEngine.ts`, running in a Web Worker. Writing via **pdf-lib**
  (MIT); structural work via **qpdf** (Apache-2.0); fonts via **fontkit**
  (MIT); OCR via **Tesseract** (Apache-2.0). Permissive licences only —
  never MuPDF, iText, Ghostscript or anything AGPL/commercial.
- **No Docker, ever** (build or runtime). The installer is self-contained;
  native binaries are bundled per OS **and CPU architecture** and fetched
  at build time by `scripts/fetch-binaries.ts` (`resources/binaries.json`,
  pinned checksums, git-ignored). **Supported targets: Windows x64 and
  Windows arm64, macOS universal (x64 + arm64), Linux x64.** Any module that
  adds a native binary must supply a `win32-arm64` entry or a WASM fallback
  that is used automatically on that architecture — the arm64 installer must
  never ship a feature that silently fails. Installing
  build toolchains locally (Rust, C++, emsdk) is pre-approved if a module
  needs one — record it in `docs/adr/` and `README.md`.

**Architecture contracts (stubbed by M00; code against these):**
- `PdfEngine` — open/close, pageCount, pageSize, render(page, scale, rect) →
  ImageBitmap, textRuns, pageObjects, annotations, formFields, outline, layers,
  attachments, metadata, plus mutation counterparts. Runs in a Worker; the
  renderer talks to it through `src/engine/EngineClient.ts`.
- `Document` (`src/renderer/core/Document.ts`) — in-memory model (pages,
  annotations, fields, objects, metadata) plus a journal of `Command`s. Engine
  = source of truth for bytes; Document = source of truth for intent.
- `Command` — `{ id, label, do(), undo(), merge?(next) }`. **Every document
  change is a Command** so undo/redo, autosave and batch all work for free.
- `Tool` — pointer/keyboard handler bound to a page overlay layer. One
  active tool at a time. Modules provide tools.
- `ModuleManifest` (`src/shared/module.ts`) — a module folder exports
  `manifest.ts` registering commands, ribbon groups, panels, tools,
  shortcuts and a settings schema. The shell is data-driven from manifests.
- Page overlay layers, bottom → top: raster canvas · text layer · annotation
  layer (SVG) · form-widget layer · object-edit layer · tool layer.
- IPC: renderer ↔ main only through the typed API in `src/shared/ipc.ts`,
  exposed by `src/preload/`.

**Folders:** `src/main/` (Electron main) · `src/preload/` · `src/shared/`
(types, IPC, manifest type) · `src/engine/` (engine + adapters, Worker) ·
`src/renderer/app/` (shell) · `src/renderer/core/` (Document, Command,
Store, Registry, Selection) · `src/renderer/view/` (PageView, Viewport,
tiles, layers) · `src/renderer/theme/` · `src/renderer/modules/<Mid>-<slug>/`
(**your module lives here**) · `resources/` · `test/{fixtures,unit,e2e}` ·
`docs/{adr,modules}` · `scripts/`.

**UI & accessibility rules (non-negotiable — the operator has low vision and
is colourblind: black and red read as the same colour):**
- Colours **only** via theme tokens (`--bg-app`, `--bg-panel`, `--fg`,
  `--fg-muted`, `--icon`, `--accent`, `--border`, `--focus`, `--selection`,
  `--danger`, `--warning`, `--success`, `--info`, …). Never a literal.
- Text ≥ 4.5:1, icons/borders ≥ 3:1 in all four themes (Graphite dark
  default, Midnight, Daylight, High Contrast). No grey-on-dark text.
- **Never differentiate by red/green or gold/green alone.** Status = word +
  icon. Distinguish on blue↔yellow and lightness.
- Modals/overlays/popups **fully opaque**: no `rgba()` alpha < 1, no
  `opacity` < 1, no `backdrop-filter`.
- Every control keyboard-reachable with a visible focus ring; every command
  registered so it appears in the command palette (Ctrl/Cmd+Shift+P).
- Icons: **Lucide** (ISC), stroke, `currentColor`.

**Working conventions:**
- Branch `mod/<Mid>-<slug>` from `main`, in its own git worktree
  (`git worktree add ../ynotPDF-<Mid> mod/<Mid>-<slug>`). Merge to `main`
  only when acceptance tests pass in CI on all three OSes.
- Write only inside your module folder, your engine adapter file(s), your
  tests, `resources/` data and this spec. Edits to shared files
  (`src/shared`, `src/renderer/core`, `src/renderer/app`, `package.json`)
  must be minimal, additive, and listed in the PR description. Changing a
  contract needs an ADR (`docs/adr/NNNN-*.md`) merged first as its own PR.
- Data that can change (presets, stamp catalogues, substitution tables)
  goes in `resources/` data files, not code.
- Commits: `<Mid>: <what>` and end with
  `Co-Authored-By: Claude <noreply@anthropic.com>`. Never commit real
  customer PDFs, binaries, or secrets — fixtures are public-domain/synthetic.
- Replies to the operator: short and plain (eyesight). Never leave the
  operator a to-do you could do yourself.

---

## Design decisions (fill in before coding; keep current)

_None yet._

## Build log (fill in at merge)

_Not started._

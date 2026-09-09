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

_Credit rule (operator): every open-source component this module adds
must be creditable by M131's generated acknowledgements page — npm
packages need only a licence in their metadata; binaries/WASM go in
`resources/binaries.json` with `license`, `homepage`, `copyright`; anything
vendored, adapted or copied (code, icons, fonts, data) goes in
`resources/credits.json`. Permissive licences only (MIT, BSD, ISC,
Apache-2.0, 0BSD, OFL for fonts; MPL-2.0 only for an external program the
user installs, never bundled). **Never bundle or link, however tempting:
Ghostscript, MuPDF, iText (AGPL); Poppler/pdftotext/pdftoppm, pdf2htmlEX,
GPL-only Hunspell dictionaries (GPL).** Dual-licensed packages are used
under their permissive option and credited as such (`node-forge` = BSD).
The app is sold commercially; a copyleft component would block that._

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
targeting the feature set of **Foxit PDF Editor 14** — *feature set only*:
**never copy Foxit's icons, artwork, wording, help text or documentation.**
Industry-standard icon conventions shared by Adobe, Foxit, Tungsten and
others (magnifier = zoom, hand = pan, highlighter, stamp, padlock, pen for
sign) are generic — use them freely; what must not be copied is Foxit's
*specific artwork*: its exact shapes, colours, pixel layouts. Icons come
from Lucide or are drawn by us — similar in idea or better, never traced
or pixel-copied. Help and
documentation are written from scratch for ynotPDF. *(Operator rule,
2026-09-09.)* Four colour themes
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
- **Real sample PDFs for hands-on testing live in `test/fixtures/local/`**
  (git-ignored; the operator drops files there, so they carry personal
  data). Currently: three airline boarding passes and **`Sample
  Portfolio.pdf`, a Foxit-made PDF Portfolio (`/Collection`) containing
  those three** — use it for attachments, embedded-file and portfolio
  behaviour. Open them when you manually check
  your module against real-world files, and prefer them over synthetic
  fixtures for "does it look right" judgements. Tests may use them only
  with `it.skipIf(!existsSync(...))` — CI and other machines don't have
  them. Never copy, commit or quote their contents; `local/README.md`
  lists what is there.
- Replies to the operator: short and plain (eyesight). Never leave the
  operator a to-do you could do yourself.

---

## Design decisions (fill in before coding; keep current)

Taken 2026-09-08, before any config changed. Findings 3–5 come from reading
electron-builder 26.15.3's own NSIS/MSI code, not from its documentation.

1. **arm64 is a packaging target, not a code path — today.** Nothing in the
   app is architecture-specific: PDFium is WebAssembly (ADR 0006), the only
   fetched binaries are fonts (`targets: { any: … }`), and Electron publishes
   `win32-arm64`. So M03 changes build config, adds one runtime helper and one
   guard, and writes the rule the modules with real native binaries follow.
2. **One installer per architecture, not a combined one.** electron-builder's
   NSIS target defaults to `buildUniversalInstaller: true`, which emits a
   *combined* x64+arm64 installer **and** (because our `artifactName` contains
   `${arch}`) the two per-arch ones — three `.exe` files, the combined one
   carrying both app payloads (~2× the download). We set
   `nsis.buildUniversalInstaller: false`, so the Windows job emits exactly
   four artifacts: `ynotPDF-<ver>-win-{x64,arm64}.{exe,msi}`.
3. **The "electron-builder refuses the wrong architecture by default" premise
   in the brief is false, and we fix it.** `templates/nsis/common.nsh`
   (`check64BitAndSetRegView`) only ever guards *32-bit Windows*; the message
   catalogue has `win7Required` and `x64WinRequired` and nothing for arm64.
   Worse, `include/extractAppPackage.nsh` picks the payload at run time from
   `$packageArch`, and on an x64 PC an arm64-only installer leaves that
   variable **empty** — it then tries to unpack `app-.7z`, i.e. it fails
   messily instead of saying why. So we ship `resources/build/installer.nsh`
   with a `customInit` macro: when the package is arm64-only
   (`APP_ARM64` defined, `APP_64` not) and `${IsNativeARM64}` is false, show a
   worded message and quit. `customInit` (not `preInit`) is the hook, because
   `preInit` is also inserted into the intermediate `BUILD_UNINSTALLER` pass
   that electron-builder *runs on the x64 build machine* — a guard there would
   break the arm64 build itself.
4. **The x64 installer stays installable on ARM, deliberately.** NSIS's
   `identify_package` accepts `${IsNativeARM64}` for a 64-bit payload, and
   Windows 11 runs x64 Electron under emulation. It is a working fallback, so
   we do not block it; the About dialog names it instead (decision 6).
5. **The arm64 MSI is an x64-declared package carrying arm64 binaries.**
   `MsiTarget.js` maps `Arch.arm64 → x64` for candle because the bundled WiX
   4.0.0.5512.2 has no arm64 platform. It builds and installs, but MSI gets no
   architecture guard at all. NSIS is therefore the recommended installer on
   ARM; the MSI stays for the group-policy/imaging case. Noted in ADR 0009 and
   the README.
6. **`targetArch()` reports what the build is; `hostArch()` reports what the
   PC is** (`src/main/arch.ts`, pure functions, unit-tested). Windows sets
   `PROCESSOR_ARCHITEW6432=ARM64` inside an emulated x64 process, which is the
   only detection available without a native call. The About dialog shows
   `Windows arm64`, `Windows x64`, or `Windows x64 (emulated on arm64)` — the
   last one is exactly what the operator needs to see when checking which
   installer landed on an ARM PC.
7. **Fetching is driven by the *target*, not the host.** `fetch-binaries`
   already took `--platform`/`--arch`; it now also reads `YNOT_TARGET`
   (`win32-arm64`), which is what CI sets, so an x64 runner can assemble an
   arm64 payload. Precedence: explicit flags → `YNOT_TARGET` → host.
8. **The rule is enforced by a check, not by a review habit.**
   `fetch-binaries` fails before downloading anything if an entry offers
   `win32-x64` without `win32-arm64` and without `"arm64Fallback": "wasm"`.
   The message names the module (`M70`, `M90`, …) so the failure lands on
   whoever added the entry.
9. **ARM CI: verify, don't assume.** `tonybaynes/ynotPDF` is a *public* repo
   on a personal account and registers no self-hosted runners
   (`gh api …/actions/runners` → `total_count: 0`), so GitHub's hosted
   `windows-11-arm` label should be free and available. That is a claim until
   a run proves it, so the workflow gains a real `windows-11-arm` job that
   installs the arm64 NSIS silently, launches it and runs the `app.about`
   smoke. If the run cannot get a runner, the job goes and the ADR/README say
   so plainly. Either way the operator's own ARM PC gets a manual checklist.

   Outcome: the runner **is** available and the smoke passes on real ARM
   hardware. Two corrections were needed, both in the job rather than the
   packaging. First, `perMachine: false` only sets the installer's *default*,
   and the runner user is an admin, so the elevated `/S` install went
   all-users; the step now passes `/S /currentuser` and reads the install
   location back from the uninstall registry key. Second — and this one is
   worth remembering — **the NSIS installer cannot complete on that image**:
   Defender removes the unsigned PE binaries from NSIS's `%TEMP%` unpack
   directory while `CopyFiles /SILENT` swallows the failure, leaving an install
   with `app.asar` and every `.pak` but no `ynotPDF.exe` and no DLLs, and
   Tamper Protection makes `Set-MpPreference` a no-op that still reports
   success. CI installs the arm64 **MSI** instead (msiexec writes through
   Windows Installer, so it is unaffected). Signing in M131 is the real fix.
   Consequence: the NSIS path on ARM is covered only by the operator's manual
   smoke, and the checklist now starts by checking the executable is there.

## Build log (fill in at merge)

**Shipped (2026-09-08).** Branch `mod/M03-windows-arm` in worktree `../ynotPDF-M03`.

- `electron-builder.yml`: Windows `nsis` and `msi` for `arch: [x64, arm64]`,
  `nsis.buildUniversalInstaller: false` (one installer per arch, no combined
  double-payload one), `nsis.include: resources/build/installer.nsh`.
  Four artifacts per push: `ynotPDF-<ver>-win-{x64,arm64}.{exe,msi}`.
- `resources/build/installer.nsh` (new): `customInit` macro refusing an
  arm64-only installer on a non-ARM64 PC. **electron-builder has no such guard
  of its own** — the brief's premise was wrong, and the ADR records what its
  NSIS templates actually do.
- `scripts/fetch-binaries.ts`: `resolveTarget()` (flags → `YNOT_TARGET` → host)
  and `checkArm64Coverage()`, which fails before any download when an entry has
  `win32-x64` without `win32-arm64` or `"arm64Fallback": "wasm"`, naming the
  module. `BinaryEntry`/`Manifest` exported for the tests.
- `src/main/arch.ts` (new): `targetArch()`, `targetPlatform()`,
  `binaryTarget()`, `hostArch()`, `isEmulated()`, `archLabel()`.
  `src/shared/platform.ts` (new): `platformName()`, `platformLabel()`,
  `binaryTargetKey()`.
- Shared-file edits, minimal and additive: `AppInfo.hostArch` (`src/shared/ipc.ts`),
  `app:info` fills it (`src/main/ipc.ts`), About dialog shows
  `platformLabel(...)` and tags each `<dd>` with `data-field`
  (`src/renderer/app/dialogs.ts`).
- Tests: `test/unit/arch.test.ts` (24 assertions over injected arch/platform/env,
  including the emulation cases), `test/unit/fetch-binaries.test.ts` (+9:
  coverage rule, `resolveTarget` precedence, and the real manifest passes),
  `test/e2e/arch.spec.ts` (About names the arch; `YNOT_EXPECT_ARCH` asserts an
  exact one). 1161 unit tests and 62 e2e green.
- CI: Windows job cross-packages both arches (`--win --x64 --arm64`) and fails if
  any of the four installers is missing; new `windows-11-arm` job installs the
  arm64 build on GitHub's hosted ARM runner and runs the smoke with
  `YNOT_EXPECT_ARCH=arm64`.

**Verified.**

- Locally on x64 (2026-09-08): arm64 NSIS `/S` → exit 1, nothing installed
  (guard holds); x64 NSIS `/S /currentuser` → installs, smoke passes, About reads
  `Windows x64`; x64 MSI `/qn` → installs, smoke passes. `fetch-binaries` fails
  with the worded message on a test entry, and passes once `arm64Fallback` is set.
- On ARM in CI (run 34207087608, all four jobs green): the arm64 build installed
  on a `windows-11-arm` runner, launched, and the About dialog read exactly
  `Windows arm64` — plus the engine-worker round trip, so PDFium's WASM ran on
  ARM.
- Operator's manual smoke on his own ARM device: _pending_ — he is taking the
  arm64 NSIS installer from the CI artifact. It matters because CI installs the
  MSI (below), so nothing else exercises the NSIS path on ARM.

**What cost the most time, and what future modules should know.**

- `perMachine: false` only sets the NSIS installer's *default*. The CI runner
  user is an admin, so an elevated `/S` install went all-users. Pass
  `/currentuser`, and read the install location from the uninstall registry key
  (`InstallLocation` is empty; `DisplayIcon` and `UninstallString` carry it).
- **The NSIS installer cannot complete on GitHub's ARM image.** It exits 0 and
  leaves `locales/`, `resources/app.asar` and every `.pak` — and none of the PE
  binaries. Defender takes the unsigned `ynotPDF.exe` and DLLs out of NSIS's
  `%TEMP%` unpack directory, and `CopyFiles /SILENT` swallows the failure.
  Tamper Protection makes `Set-MpPreference -DisableRealtimeMonitoring` a no-op
  that still reports success, and path exclusions changed nothing. CI installs
  the arm64 MSI instead; `msiexec` writes through Windows Installer and is
  unaffected. **M131 signing is the real fix** — when it lands, re-check the
  NSIS path and drop the fallback. Until then an unsigned NSIS install can lose
  its executable on any strict-AV machine, which is now step 3 of the manual
  checklist in ADR 0009.

**Deferred / notes.**

- Linux arm64 is not covered (not a supported target); the same mechanism extends
  to it when it is.
- The arm64 MSI is an x64-declared WiX package carrying arm64 binaries and has no
  architecture guard at all — M131 revisits it with a newer WiX.
- No change to the render-hash fixtures: PDFium is WASM, so ARM renders
  identically and needs no baseline of its own.

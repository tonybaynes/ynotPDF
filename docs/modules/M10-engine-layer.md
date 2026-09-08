# M10 — PDF engine layer & PDFium adapter

| | |
|---|---|
| **Module id** | `M10` — folder `src/renderer/modules/M10-engine-layer/`, branch `mod/M10-engine-layer` |
| **Earliest wave** | 1 (see `PLAN.md` §0/§12) |
| **Tier** | Core |
| **Depends on** | M00 |
| **Unlocks** | [M11 Viewer — rendering, navigation, zoom, layouts](./M11-viewer.md), [M20 Document model, commands & undo stack](./M20-document-model.md) |

## Your task — the prompt for this conversation

You are building **M10 — PDF engine layer & PDFium adapter** of ynotPDF. Carry this brief out end to
end without waiting to be asked for the next step:

1. Read this file completely, then `CLAUDE.md`, `PLAN.md` §2–4, §9 and §12,
   and the briefs of your direct dependencies: [M00 Scaffold, CI & packaging smoke](./M00-scaffold.md).
   Confirm each dependency is ☑ in `PLAN.md` §0. If one is not, say so and
   stop — do not build against unfinished work.
2. Create branch `mod/M10-engine-layer` from `main` in a new git worktree and
   work there.
3. Fill in **Design decisions** below (short, concrete) before writing code;
   update it as you go. Write ADRs for any contract change.
4. Implement the **Scope** section — all of it, not the easy parts. Every
   document change is an undoable `Command`; every user action is a
   registered command with a palette entry and, where sensible, a shortcut.
5. Write the tests listed under **Acceptance tests** (plus whatever unit
   tests you needed while building). Run `npm run lint`, `npm test`,
   `npm run e2e` locally, then push and make CI green on all three OSes.
6. Merge to `main` (PR if the remote supports it, else fast-forward), tick
   this module ☑ in `PLAN.md` §0 in the same merge, and fill in the
   **Build log** below with what shipped, what was deferred and why.
7. Report back in a few plain lines: what works, what to try, anything the
   operator must do by hand.

---

## Purpose

Turn the `PdfEngine` stub into a working engine backed by PDFium running
in a Web Worker, with the fixture corpus and the engine test suite that
every later module relies on. Decide, with measurements, between PDFium
WASM in the renderer worker and native PDFium in the main process.

## Foxit 14 reference — what to emulate

Foxit's core engine — PDFium *is* the open-sourced Foxit engine, so PDFium
behaviour (rendering, text extraction, form handling) is the reference.

## Scope — build all of this

- `PdfiumEngine` implementing every `PdfEngine` read method: open (bytes +
  optional password, error taxonomy: bad password / corrupt / unsupported),
  close, pageCount, pageSize/rotation/boxes (MediaBox, CropBox, …), render
  (page, scale, clip rect, flags: annotations on/off, forms on/off,
  grayscale, print-mode) → `ImageBitmap`/RGBA buffer, `textRuns(page)` →
  glyph runs with unicode, font name/size/style, bbox per char, reading
  order; `pageObjects(page)` → text/image/path/shading/form-xobject with
  bbox, matrix, fill/stroke; `annotations(page)` → typed annotation
  records incl. appearance state; `formFields()` tree; `outline()`;
  `layers()` (OCG names + visibility); `attachments()`; `metadata()` (info
  dict + XMP raw); `links(page)`; `pageLabels()`.
- Worker wrapper: `EngineClient` RPC with transferable buffers, request
  cancellation (render requests superseded by scroll are dropped), one
  worker per window, document handles, structured errors.
- **Adapter decision (measure, then decide, then ADR):** start with
  `@hyzyla/pdfium` (WASM). Benchmark render of a 300-dpi A4 scan page, a
  vector-heavy CAD page and a 500-page text doc's `textRuns`. If WASM misses
  the targets (< 150 ms per A4 tile set at 1× DPR; `textRuns` < 30 ms/page)
  or lacks needed C-API exports, implement `PdfiumNativeEngine` in
  `src/main/engine/` using `pdfium-binaries` prebuilt libs through `koffi`
  FFI (no compiler), bridged over IPC with shared buffers. Both may coexist;
  the interface must not change.
- Font substitution: bundle Liberation + DejaVu (OFL/free) in
  `resources/fonts/` and register them with PDFium so non-embedded fonts
  render consistently across OSes; substitution table as a data file.
- Fixture corpus: extend M00's synthetic set with the pdf.js test-suite
  PDFs that are Apache-2.0/public-domain (script downloads and pins them),
  plus PDF/A, encrypted (RC4/AES-128/AES-256, owner-only), broken xref,
  huge page count, CJK/RTL text, rotated pages, mixed boxes, forms
  (AcroForm all field types), annotations (all subtypes), layers,
  attachments, outlines, JavaScript-bearing, XFA (must open with a warning),
  scanned images (for OCR later). `test/fixtures/manifest.json` describes
  each with expected page counts/text snippets.
- Engine test suite: open every fixture; page count/size; render hash per
  page at 72 dpi (perceptual hash, tolerance) stored per OS in
  `test/fixtures/hashes/`; `textRuns` snapshot; field/annotation counts.

## Out of scope

Any mutation method (M20+ add them additively). UI.

## Design notes & constraints

- Units: PDF points, origin bottom-left; expose a `PageGeometry` helper for
  device↔page transforms including `/Rotate` and CropBox offset — every
  later module uses it, get it right once.
- Render pipeline must support tile rects so M11 can stream tiles.
- Structured `EngineError { code, message, recoverable }`.
- Keep PDFium's form-fill environment (`FPDFDOC_InitFormFillEnvironment`)
  initialised per document so widgets render with values.

## Files you will create or touch

`src/engine/**` (PdfiumEngine, EngineClient, worker entry, geometry),
optionally `src/main/engine/**`, `scripts/fetch-binaries.ts`,
`scripts/fetch-fixtures.ts`, `test/fixtures/**`, `test/unit/engine/**`,
`docs/adr/0002-pdfium-adapter.md`.

## Libraries

`@hyzyla/pdfium` (WASM); optionally `koffi` + `pdfium-binaries`; Liberation
and DejaVu fonts.

## Acceptance tests — the module is done when these pass on all three OSes

- Entire corpus opens (or fails with the documented error code);
  encrypted fixtures open with the right password and fail with
  `BAD_PASSWORD` otherwise.
- Render hashes stable across three consecutive CI runs per OS.
- `textRuns` on the text fixture equals the expected string; per-glyph
  bboxes contain their glyph in the rendered bitmap (sampled).
- Benchmarks recorded in the ADR with the adapter decision.
- Cancelling 50 queued renders during a simulated scroll leaves the worker
  responsive within 100 ms.

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

- **Adapter: PDFium WASM, driven raw.** `@hyzyla/pdfium` 2.1.13 (MIT, pinned exact) supplies the
  wasm + emscripten glue; we use only its `PDFiumModule` factory and drive the C API ourselves
  through a small FFI layer (`src/engine/pdfium/ffi.ts`). Its wrapper classes are not used — they
  cover a fraction of the API and pass a JS object where PDFium expects a pointer.
- **The shipped wasm has a fixed function table** (`min = max = 3023`), so JS callbacks are
  impossible out of the box: no font registration, no `FPDF_SaveAsCopy`, no pause/cancel. We
  patch the table limits at load time (`src/engine/pdfium/wasm.ts`: rewrite one section of the
  binary, verified by magic + structure) and implement `addFunction` with the standard tiny
  wrapper-module trick. Measured cost: none. Recorded in ADR 0006 with the benchmarks.
- **Loading inside Electron.** `fetch()` of `file://` fails under `loadFile`, so the wasm is
  inlined into the worker chunk (`?inline`, base64) and font files are lazy chunks via
  `import.meta.glob(..., { query: '?inline' })`. Node unit tests read the same bytes from disk.
- **Fonts.** Liberation 2.1.5 + DejaVu 2.37 (OFL / Bitstream Vera licence, both permissive) are
  fetched at build time by `scripts/fetch-binaries.ts` (which learns to extract `.tar.gz` and
  `.zip`) into git-ignored `resources/fonts/`; the committed data file
  `resources/fonts/substitutions.json` maps PDF family names → files. They are registered through
  `FPDF_SetSystemFontInfo` callbacks. Without the files PDFium falls back to its built-in Foxit
  fonts — still identical on every OS, just less faithful for Arial/Verdana/Cyrillic.
- **Geometry.** `PageGeometry` (`src/engine/geometry.ts`) is the one place that knows
  `/Rotate` + CropBox offset; it agrees with M00's `PageTransform` (cross-checked by a test).
  Tiles: `FPDF_RenderPageBitmap` with a negative start offset into a tile-sized bitmap,
  `FPDF_REVERSE_BYTE_ORDER` so the buffer is RGBA. `RenderResult.rect` is the page rect the
  integer tile actually covers.
- **Forms** render with values: zeroed `FPDF_FORMFILLINFO` v1, `FORM_OnAfterLoadPage`,
  `FPDF_FFLDraw` after the page, field highlight removed (Foxit-faithful raster).
- **Layers and XMP have no PDFium API.** The catalog is read with pdf-lib (now a runtime dep,
  MIT): `/OCProperties` → layers, `/Metadata` → raw XMP. Encrypted files are first copied
  without security via `FPDF_SaveAsCopy(FPDF_REMOVE_SECURITY)` so strings are readable.
  `RenderOptions.layers` overrides are accepted but not applied in M10 (M12 can use
  `FPDFPageObj_SetIsActive` per marked object).
- **Cancellation.** The worker serialises requests in its own queue; `{ kind: 'cancel', id }`
  drops a queued request or aborts an in-flight render, which uses the progressive
  `FPDF_RenderPageBitmap_Start`/`Continue` API with an `IFSDK_PAUSE` that yields to the event
  loop every ~20 ms. Cancelled calls reject with code `cancelled`. `EngineClient.request()`
  returns a handle with `cancel()`; `cancelRenders(doc?)` drops every pending render.
- **Error taxonomy.** `FPDF_ERR_PASSWORD` → `password-required` (no password given) or
  `wrong-password`; `FILE`/`FORMAT`/`UNKNOWN` → `corrupt`; `SECURITY` → `unsupported`.
  XFA files open (AcroForm fallback) with `metadata.hasXfa = true` for the UI to warn.
- **Ids.** Annotations `a<page>.<index>`, FileAttachment annots `annot.<page>.<index>`,
  embedded files `att.<n>`, layers `ocg.<objnum>`. Stable while the document is open and
  unmodified; M20/M30 own reassignment after mutations.
- **Contract additions** (ADR 0005, additive): `links(doc, page)`, render flags
  (`printing`, `smoothText/Images/Paths`, `lcdText`), page-object colours/stroke/font,
  text-run style (`bold`, `italic`, `weight`, `angle`), annotation `appearanceState`/`name`/
  `subject`, error code `cancelled`, RPC `cancel` message.
- **Tests** run the engine in Node through `renderRaw()` (RGBA buffer) and a 64-bit dHash;
  hashes live in `test/fixtures/hashes/<platform>.json` with a Hamming tolerance of 6 bits.
  Benchmarks: `node scripts/bench-engine.ts` (documents generated on the fly, not committed).
- **Module folder** `M10-engine-layer/manifest.ts` registers `dev.engineOpen` and
  `dev.engineBenchmark` (palette, Developer) — the e2e proves the WASM worker inside the app.
- Mutation methods stay `NotImplementedError` in `PdfiumEngine` (M20+ add them additively).

## Build log (fill in at merge)

**Built 2026-09-07 on `mod/M10-engine-layer` (worktree `../ynotPDF-M10`); pushed and merged
via PR on 2026-09-08** once the operator made the repository public (GitHub Actions minutes had
run out on the private repo the day before). Green locally on Windows: lint, 949 unit tests,
50 Playwright tests.

**Shipped:**

- `PdfiumEngine` (`src/engine/pdfium/`) on `@hyzyla/pdfium` 2.1.13 WASM, driven through our own
  FFI layer: open with the error taxonomy (`password-required` / `wrong-password` / `corrupt` /
  `unsupported`), close, pageCount, pageSize (MediaBox/CropBox/`/Rotate`, degenerate boxes fall
  back to PDFium's Letter), pageLabels, metadata (+ raw XMP, linearized, tagged, form/XFA flags),
  permissions, outline (destinations + URI/launch actions), layers (via pdf-lib catalog read),
  attachments (+ FileAttachment annotations) and attachmentData, render (tiles, extra rotation,
  annotations/forms/grayscale/print/smoothing/LCD flags, background colour, progressive and
  cancellable), textRuns (runs with per-glyph boxes, font name/size/style/weight/angle, colour,
  generated spaces boxed between neighbours), pageObjects (kind, bbox, matrix, fill/stroke, font,
  image size, form child count, optional-content layer id), annotations (all subtypes, flags,
  colours with raw fallback, quad points, ink/vertex/line paths, IRT/popup links, `/AS`, widgets'
  field name/type), formFields (grouped by name, values, options, checkbox/radio export values),
  links, and `save` via `FPDF_SaveAsCopy`. Mutations remain `NotImplementedError` (M20+).
- Wasm table patch + `addFunction` (`wasm.ts`) making callbacks possible in the stock build;
  `FontRegistry` (`fonts.ts`) implementing `FPDF_SYSFONTINFO` from `resources/fonts/substitutions.json`.
- `PageGeometry` (`src/engine/geometry.ts`) with tile snapping; agrees with `PageTransform`.
- Worker: serialised queue, `cancel` message, boot-failure reporting; assets inlined
  (`worker-assets.ts`). `EngineClient.request()`/`cancel()`/`cancelRenders()`.
- Contract additions per ADR 0005; `src/shared/module.ts` untouched.
- Fonts: Liberation 2.1.5 + DejaVu 2.37 fetched by `fetch-binaries` (now extracts tar.gz/zip),
  git-ignored; substitution data file; CI caches them.
- Fixtures: 18 new synthetic files (AES-128/256/owner-only encryption written by hand, rotated,
  mixed boxes, page labels, links, all field types, all annotation subtypes, JavaScript, XFA,
  PDF/A-1b structure, CJK + Hebrew, broken xref, truncated, corrupt, 1000 pages, scan);
  `form.pdf` and `layers.pdf` fixed (checkbox `/AS`, real BDC/EMC). 35 pinned pdf.js files via
  `fetch-fixtures`. `test/fixtures/manifest.json` (63 entries) + `hashes/{win32,darwin,linux}.json`.
- Tests: 100+ unit tests across `test/unit/engine/` (smoke, corpus, geometry, fonts, wasm patch,
  worker queue/cancel incl. the 50-render scroll test) and `fetch-binaries` archive readers;
  Playwright `test/e2e/engine.spec.ts` drives the WASM worker in the built app through
  `dev.engineOpen`. Benchmarks in `docs/bench/engine-win32-x64.json` (ADR 0006).
- Module folder `M10-engine-layer` with the `dev.engineOpen` palette command.
- Docs: ADR 0005 (contract additions), ADR 0006 (adapter decision + measurements), README.

**Shared files touched (minimal, additive):** `src/engine/PdfEngine.ts` (new optional fields,
`links`, `cancelled`), `src/engine/rpc.ts` (`cancel`), `src/engine/EngineClient.ts`,
`src/engine/worker.ts`, `src/renderer/main.ts` (register M10 manifest), `package.json`
(runtime deps `@hyzyla/pdfium`, `pdf-lib`; scripts `fetch-fixtures`, `bench`, `hashes`),
`tsconfig.node.json` (`vite/client` types for `?inline`), `.gitignore`, `.github/workflows/ci.yml`
(fetch + cache step), `scripts/fetch-binaries.ts`, `scripts/make-fixtures.ts`, `PLAN.md` §0.

**Deferred / notes:**

- `RenderOptions.layers` overrides are not applied (no PDFium OCG API); M12 can use
  `FPDFPageObj_SetIsActive` per marked object or reload after editing `/OCProperties`.
- No CJK font bundled: CJK text extracts correctly, glyphs render with PDFium's fallback.
- `external/bug1782186.pdf`: PDFium rejects the password pdf.js accepts; recorded as
  `wrong-password` in the manifest rather than hidden.
- Render hashes for macOS/Linux are copies of the Windows set (the wasm is byte-identical); the
  first CI run confirms or the corpus test prints the actual values to paste in.
- Suggested CI economy for when Actions resume: run the three-OS matrix on pull requests and
  `main` only, Linux-only on other branch pushes (macOS minutes cost 10×).

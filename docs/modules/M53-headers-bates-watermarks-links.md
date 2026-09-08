# M53 — Header/footer, Bates numbering, watermark, background & links

| | |
|---|---|
| **Module id** | `M53` — folder `src/renderer/modules/M53-headers-bates-watermarks-links/`, branch `mod/M53-headers-bates-watermarks-links` |
| **Earliest wave** | 6 (see `PLAN.md` §0/§12) |
| **Tier** | Core |
| **Depends on** | M50, M21 |
| **Unlocks** | [M120 Batch processing & action wizard](./M120-batch-actions.md) |

## Your task — the prompt for this conversation

You are building **M53 — Header/footer, Bates numbering, watermark, background & links** of ynotPDF. Carry this brief out end to
end without waiting to be asked for the next step:

1. Read this file completely, then `CLAUDE.md`, `PLAN.md` §2–4, §9 and §12,
   and the briefs of your direct dependencies: [M50 Page-object model — select, move, resize, align, arrange](./M50-object-model.md), [M21 Save, Save As, autosave & recovery](./M21-save.md).
   Confirm each dependency is ☑ in `PLAN.md` §0. If one is not, say so and
   stop — do not build against unfinished work.
2. Create branch `mod/M53-headers-bates-watermarks-links` from `main` in a new git worktree and
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

Page-decoration features with live preview and presets: headers/footers
with macros, Bates numbering, text/image watermarks, backgrounds, and the
link tool (manual and auto-detect URLs).

## Foxit 14 reference — what to emulate

Foxit Edit / Organize: Header & Footer (add/update/remove, six zones, font,
margins, page-number and date macros, range, shrink page to avoid overlap,
presets), Bates Numbering (add/remove, prefix/suffix, digits, start,
across multiple files), Watermark (text or file, rotation, opacity ✗ →
solid colours only for our own; keep existing), position, scale relative
to page, appear behind/in front, range, presets), Background (colour or
file, same options), Link tool (draw rect, visible/invisible, style, action:
go to page/URL/file/open; auto-create links from URLs), Edit/Delete links.

## Scope — build all of this

- Shared "page decoration" dialog framework: opaque dialog with preview
  pane rendered through the engine, page range, presets stored in
  `resources/presets/*.json` + user presets in settings.
- Header/footer: 6 zones, font/size/colour, margins/units, macros
  (`<<1>>`, `<<1 of n>>`, date formats, filename, Bates), underline, shrink
  page option; add/update/remove as Commands writing tagged Form XObjects
  (mark with a `/YNOT` marker so "update/remove" finds them, Foxit does the
  same with its own marker).
- Bates: prefix/suffix/digits/start, across documents in one run (batch-
  aware), remove.
- Watermark/background: text or PDF/image file, rotation, scale, position
  grid, behind/in front, range, also appears when printing option,
  remove; existing (foreign) watermarks detected by marker where possible.
- Link tool: draw rectangle, border style/colour/visibility, action editor
  shared with M12 destinations/M61 actions; auto-detect URLs/emails in text
  (regex over `textRuns`) → links with review dialog; edit/delete/list
  links; link layer rendering (dashed outline when editing).

## Out of scope

Articles (Parked).

## Design notes & constraints

- Decorations are XObjects added to each page's content with a marker so
  later edits are exact and undoable; never bake into existing streams.
- Preview uses the real writer on a copy of one page (fast path).

## Files you will create or touch

`src/renderer/modules/M53-headers-bates-watermarks-links/**`,
`src/engine/decorations/**`, `resources/presets/**`, tests.

## Libraries

None new.

## Acceptance tests — the module is done when these pass on all three OSes

- Header with `<<1 of n>>` on 100 pages ⇒ each page's extracted text ends
  with "k of 100"; remove ⇒ text gone, render equals original.
- Bates 000123… sequential and searchable.
- Watermark behind content: render diff shows watermark under text.
- Auto-detect links finds every URL in the fixture; clicking opens via
  IPC with a confirmation for external URLs.

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

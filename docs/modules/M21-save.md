# M21 — Save, Save As, autosave & recovery

| | |
|---|---|
| **Module id** | `M21` — folder `src/renderer/modules/M21-save/`, branch `mod/M21-save` |
| **Earliest wave** | 2 (see `PLAN.md` §0/§12) |
| **Tier** | Core |
| **Depends on** | M20, M11 |
| **Unlocks** | [M30 Annotations — text markup, notes, typewriter, text box, callout](./M30-markup-annotations.md), [M40 Organise pages — insert, delete, extract, replace, rotate, move, labels](./M40-organise-pages.md), [M50 Page-object model — select, move, resize, align, arrange](./M50-object-model.md), [M70 Encryption, permissions & certificate security](./M70-encryption.md), [M72 Document properties, metadata & XMP, initial view](./M72-properties-metadata.md), [M80 Incremental-update writer](./M80-incremental-writer.md), [M91 Create PDF from images, web pages, clipboard, HTML/Markdown & text](./M91-create-pdf.md) |

## Your task — the prompt for this conversation

You are building **M21 — Save, Save As, autosave & recovery** of ynotPDF. Carry this brief out end to
end without waiting to be asked for the next step:

1. Read this file completely, then `CLAUDE.md`, `PLAN.md` §2–4, §9 and §12,
   and the briefs of your direct dependencies: [M20 Document model, commands & undo stack](./M20-document-model.md), [M11 Viewer — rendering, navigation, zoom, layouts](./M11-viewer.md).
   Confirm each dependency is ☑ in `PLAN.md` §0. If one is not, say so and
   stop — do not build against unfinished work.
2. Create branch `mod/M21-save` from `main` in a new git worktree and
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

Write the document back to disk: Save / Save As via a full pdf-lib
rewrite that applies the journal, autosave with crash recovery, file-lock
and changed-on-disk handling, and the close-with-unsaved flow.

## Foxit 14 reference — what to emulate

Foxit File → Save / Save As (with "reduce file size" option — that part is
M100), autosave interval preference, document recovery on restart, "file
modified outside" prompt.

## Scope — build all of this

- `Writer` interface in `src/engine/Writer.ts` with `FullRewriteWriter`
  (pdf-lib): load original bytes, apply every journaled change (page ops,
  annotations with appearance streams, fields, outline, destinations,
  layers, attachments, metadata), save with object streams, preserve
  document id/version, keep unknown objects intact.
- Appearance-stream generation service (`engine/appearance/`): builds `/AP`
  for annotation types that PDFium will not synthesise, so files look right
  in every viewer — extend per module.
- Save command (Ctrl+S): if not dirty no-op; if the file has signatures
  warn "Saving will invalidate signatures — Save As a copy instead?"
  (until M80 exists); write to temp + atomic rename; keep a `.bak` option
  (setting); reload engine handle from the new bytes without losing view
  state; clear dirty.
- Save As (Ctrl+Shift+S): OS dialog via IPC, default name from title,
  remembers folder; optional "flatten annotations/forms" checkbox (uses
  M41/M61 hooks when they exist, else hidden).
- Autosave: interval setting (default 5 min), writes journal + a hash of
  the source to `<userData>/recovery/<docId>.ynot`; cleared on save/close;
  on launch, list recoverable documents (opaque dialog: Recover / Discard),
  recovery reopens source and replays the journal.
- Close flow: Save / Don't save / Cancel (word buttons, keyboard), for one
  tab, all tabs, and app quit.
- Changed-on-disk watcher (chokidar via main): prompt Reload / Keep mine.
- Read-only/locked files: detect (open fails or write test) and show
  "Read-only" in the tab; Save becomes Save As.
- Save progress dialog for large files, cancellable before the rename.

## Out of scope

Incremental updates (M80). Optimisation options (M100). Encryption on
save (M70 hooks into the writer pipeline).

## Design notes & constraints

- The writer must be a pure function of (original bytes, journal) so
  autosave recovery and batch reuse it; no UI in `src/engine/`.
- Round-trip fidelity is the whole game: build the comparison harness
  (`test/unit/roundtrip.ts`) that opens A and B in the engine and diffs
  page count/sizes, text, annotation lists, field values, outline, metadata
  — every later module adds cases to it.

## Files you will create or touch

`src/engine/Writer.ts`, `src/engine/writers/FullRewriteWriter.ts`,
`src/engine/appearance/**`, `src/renderer/modules/M21-save/**`,
`src/main/fs/**` (atomic write, watcher, recovery store), tests.

## Libraries

pdf-lib, chokidar (MIT).

## Acceptance tests — the module is done when these pass on all three OSes

- No-op save of every fixture round-trips: harness reports zero
  differences; file still opens in Chrome's viewer (Playwright loads it in
  a plain browser context).
- Rotate + reorder pages, add a bookmark, change title → save → reopen ⇒
  all present.
- Kill the app (test hook) after edits ⇒ next launch offers recovery and
  replays the edits.
- Save to a read-only path falls back to Save As with a worded message.

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
  native binaries are bundled per OS and fetched at build time by
  `scripts/fetch-binaries.ts` (pinned checksums, git-ignored). Installing
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

# M120 — Batch processing & action wizard

| | |
|---|---|
| **Module id** | `M120` — folder `src/renderer/modules/M120-batch-actions/`, branch `mod/M120-batch-actions` |
| **Earliest wave** | 7 (see `PLAN.md` §0/§12) |
| **Tier** | Core |
| **Depends on** | M21, M41, M53, M61, M70, M90, M92, M100 |
| **Unlocks** | [M121 Command-line interface](./M121-cli.md) |

## Your task — the prompt for this conversation

You are building **M120 — Batch processing & action wizard** of ynotPDF. Carry this brief out end to
end without waiting to be asked for the next step:

1. Read this file completely, then `CLAUDE.md`, `PLAN.md` §2–4, §9 and §12,
   and the briefs of your direct dependencies: [M21 Save, Save As, autosave & recovery](./M21-save.md), [M41 Merge, split, extract to files, crop & flatten](./M41-merge-split-crop.md), [M53 Header/footer, Bates numbering, watermark, background & links](./M53-headers-bates-watermarks-links.md), [M61 Field logic — validation, formatting, calculation, actions; data import/export; flatten](./M61-form-logic-data.md), [M70 Encryption, permissions & certificate security](./M70-encryption.md), [M90 OCR — searchable image, image+text, editable text](./M90-ocr.md), [M92 Export to images, text, HTML & RTF](./M92-export.md), [M100 Optimise (reduce size), linearise, repair, remove duplicates](./M100-optimise-repair.md).
   Confirm each dependency is ☑ in `PLAN.md` §0. If one is not, say so and
   stop — do not build against unfinished work.
2. Create branch `mod/M120-batch-actions` from `main` in a new git worktree and
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

Run any sequence of document operations over many files or folders with
progress, logging and error handling; save sequences as reusable actions.

## Foxit 14 reference — what to emulate

Foxit Action Wizard (create/edit/run actions: steps with options, input
files/folders/open docs, output folder/naming/overwrite) and the many
"Multiple Files" variants (OCR, convert, protect, watermark, Bates, export
data, print).

## Scope — build all of this

- Action model: ordered steps `{ opId, options }` where an op is a
  registered **batchable operation** (each module registers its
  operations with an options schema + UI fragment). Modules merged later
  (redaction, signing, PDF/A, Office) register themselves — M120 must not
  hard-code the list. Ops available at build time: OCR, watermark/header/
  Bates, encrypt/remove security, redact-by-pattern, optimise, PDF/A,
  export image/text, export form data, flatten, split, combine, convert
  from Office/images, rename/metadata set, print (M13), run saved action.
- Run dialog: inputs (files, folders recursive with filters, open docs),
  output (same folder/other folder/overwrite/suffix pattern), parallelism
  (worker pool in main), progress per file, pause/cancel, error policy
  (skip/stop), log panel + saved log file, summary with counts.
- Saved actions library (settings) with import/export JSON; ribbon gallery;
  "Run on open documents".
- Journal-based execution: an action is replayed as Commands on a headless
  `Document` in a worker — the same code path the UI uses, so behaviour
  is identical.

## Out of scope

Scheduling/watch folders (nice-to-have later).

## Design notes & constraints

- Everything batchable is defined by modules; M120 only orchestrates.

## Files you will create or touch

`src/renderer/modules/M120-batch-actions/**`, `src/main/batch/**`,
`src/shared/batch.ts` (op registration types — additive), tests.

## Libraries

None new.

## Acceptance tests — the module is done when these pass on all three OSes

- Action: OCR → header → encrypt over 20 fixtures ⇒ 20 outputs, each
  searchable, headed, encrypted; log lists 20 OK; a deliberately broken
  input is skipped with a worded error under "skip" policy and stops the
  run under "stop".

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

# M20 — Document model, commands & undo stack

| | |
|---|---|
| **Module id** | `M20` — folder `src/renderer/modules/M20-document-model/`, branch `mod/M20-document-model` |
| **Earliest wave** | 1 (see `PLAN.md` §0/§12) |
| **Tier** | Core |
| **Depends on** | M00, M10 |
| **Unlocks** | [M21 Save, Save As, autosave & recovery](./M21-save.md), [M12 Navigation panels — thumbnails, bookmarks, layers, attachments, destinations](./M12-navigation-panels.md) |

## Your task — the prompt for this conversation

You are building **M20 — Document model, commands & undo stack** of ynotPDF. Carry this brief out end to
end without waiting to be asked for the next step:

1. Read this file completely, then `CLAUDE.md`, `PLAN.md` §2–4, §9 and §12,
   and the briefs of your direct dependencies: [M00 Scaffold, CI & packaging smoke](./M00-scaffold.md), [M10 PDF engine layer & PDFium adapter](./M10-engine-layer.md).
   Confirm each dependency is ☑ in `PLAN.md` §0. If one is not, say so and
   stop — do not build against unfinished work.
2. Create branch `mod/M20-document-model` from `main` in a new git worktree and
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

Make the `Document`/`Command`/`UndoStack` stubs real: a complete in-memory
model of everything editable, journaled mutations, dirty tracking, change
events the UI subscribes to, and the mutation side of `PdfEngine` that
later modules extend additively.

## Foxit 14 reference — what to emulate

Foxit's unlimited multi-level undo/redo (Ctrl+Z / Ctrl+Y) across all
editing operations, and "Modified" state in the title/tab.

## Scope — build all of this

- `Document`: id, source (path/bytes), pages (ids, order, size, rotation,
  boxes, label), annotations (typed union with common base: id, page, rect,
  author, dates, contents, flags, appearance), form fields tree + widgets,
  page objects (lazy, loaded per page on demand), outline, destinations,
  layers, attachments, metadata/XMP, security state, signatures (read-only
  summary), view settings; a `revision` counter; `dirty`.
- Stable ids: every model entity gets a document-unique id that survives
  reordering; map to engine handles in an id table.
- `Command` base + `CompositeCommand` (transaction), `merge()` coalescing
  (typing, dragging), `UndoStack` per document with unlimited depth, `undo/
  redo/beginTransaction/commit/rollback`, `canUndo/canRedo` labels for the
  ribbon ("Undo Rotate Page").
- Change events: fine-grained (`page:changed`, `annotation:added`, …) via
  the store, so views re-render only what changed.
- Mutation methods added to `PdfEngine` **additively**: page insert/delete/
  move/rotate/set boxes, annotation add/update/delete, form field value
  set, metadata set — implemented in `PdfiumEngine` where PDFium supports
  them, with an in-model fallback flag so M21's writer knows what to apply.
- Journal serialisation: commands are plain data (`{type, payload}`) so
  they can be persisted for autosave/recovery (M21) and replayed for batch
  (M120).
- Model invariants + validation (`Document.validate()`), used by tests.

## Out of scope

Saving (M21). UI for undo beyond the ribbon buttons + shortcuts.

## Design notes & constraints

- Prefer engine-backed mutations (so rendering reflects edits immediately)
  with the model as the authority; if the engine cannot express an edit,
  the model records it and the page overlay draws it until save.
- Reserve a `Document.custom` bag for module-specific state with a
  namespace per module id.
- Randomised property test: apply N random commands, undo all, model deep-
  equals the original.

## Files you will create or touch

`src/renderer/core/{Document,Command,UndoStack,Journal,Ids}.ts`,
additive `src/engine/PdfEngine.ts` mutation methods + `PdfiumEngine`
implementations, `test/unit/core/**`.

## Libraries

fast-check (property tests, MIT).

## Acceptance tests — the module is done when these pass on all three OSes

- Property test: 1 000 random commands then undo all ⇒ deep-equal original;
  redo all ⇒ equals post-state; transactions undo atomically.
- Engine mutations: rotate/reorder/delete pages then `render` reflects it;
  add an annotation then `annotations(page)` lists it.
- Journal round-trips through JSON and replays to the same state.
- Ribbon undo/redo buttons show the command label and enable/disable
  correctly (e2e).

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

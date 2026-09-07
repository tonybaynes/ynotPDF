# M71 — Redaction & sanitise (remove hidden information)

| | |
|---|---|
| **Module id** | `M71` — folder `src/renderer/modules/M71-redaction/`, branch `mod/M71-redaction` |
| **Earliest wave** | 9 (see `PLAN.md` §0/§12) |
| **Tier** | Core |
| **Depends on** | M50, M51, M30 |
| **Unlocks** | [M120 Batch processing & action wizard](./M120-batch-actions.md) |

## Your task — the prompt for this conversation

You are building **M71 — Redaction & sanitise (remove hidden information)** of ynotPDF. Carry this brief out end to
end without waiting to be asked for the next step:

1. Read this file completely, then `CLAUDE.md`, `PLAN.md` §2–4, §9 and §12,
   and the briefs of your direct dependencies: [M50 Page-object model — select, move, resize, align, arrange](./M50-object-model.md), [M51 Text editing with reflow (spike first)](./M51-text-editing.md), [M30 Annotations — text markup, notes, typewriter, text box, callout](./M30-markup-annotations.md).
   Confirm each dependency is ☑ in `PLAN.md` §0. If one is not, say so and
   stop — do not build against unfinished work.
2. Create branch `mod/M71-redaction` from `main` in a new git worktree and
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

True content removal: mark text/areas/pages for redaction, search-and-
redact with patterns, apply with overlay options, whitelist mode, and the
sanitise dialog that strips hidden information.

## Foxit 14 reference — what to emulate

Foxit Protect → Mark for Redaction (text/area/pages), Search & Redact
(text, patterns: phone/email/card/NI/SSN/dates/custom regex, whole words),
Apply Redactions (with overlay text, colour, repeat, font; "remove page
content outside redactions" → whitelist redaction), Redaction properties,
Sanitize Document (metadata, attachments, bookmarks, comments, form data,
hidden text, hidden layers, embedded search index, deleted content, links,
JavaScript ✗).

## Scope — build all of this

- Mark tools: text (from selection/quads), area (rect), pages (range);
  `/Redact` annotations with overlay properties; visual pending state
  (outline + word "Pending").
- Search & redact: reuse M13 search + pattern library
  (`resources/redaction-patterns.json`: UK phone, email, card numbers with
  Luhn, NI number, dates, custom regex), review list with check-all.
- **Apply (the real work, in `engine/redact/`):** for each region: remove
  glyphs of text objects intersecting it (split `TJ` arrays; drop runs;
  keep the remainder positioned exactly — needs M51's text writer); for
  images, rasterise the intersecting region black (re-encode image with the
  area filled); for paths, clip away the region (or remove objects fully
  inside); remove annotations, links, form widgets intersecting; remove
  the region from the text layer/structure; then draw the overlay (fill
  colour, optional text, repeat) as new content; strip `/Redact` annots;
  update `/ToUnicode` subsets. Whitelist mode inverts (remove everything
  outside marks).
- Safety: apply forces Save As to a new file by default (Foxit asks);
  "Redaction applied" is not undoable after save (make that explicit).
- Sanitise dialog: checkboxes per category, "select all", applies via
  writer ops; report of what was removed.
- Forensic verification test tool (`scripts/redact-verify.ts`): scans raw
  objects (uncompressed via qpdf `--qdf`) for the redacted strings and
  image bytes.

## Out of scope

OCR of scans before redaction (M90 first; M71 marks work on OCR'd
text once it exists).

## Design notes & constraints

- Never trust the visual; the acceptance test is the forensic scan.
- Content-stream operations via the M50 model; never regex the raw
  stream.

## Files you will create or touch

`src/renderer/modules/M71-redaction/**`, `src/engine/redact/**`,
`resources/redaction-patterns.json`, `scripts/redact-verify.ts`, tests.

## Libraries

None new.

## Acceptance tests — the module is done when these pass on all three OSes

- Redact a name appearing 12 times (text) + a photo region (image) + a
  vector logo (path) ⇒ `redact-verify` finds zero occurrences/bytes;
  extraction of surrounding text is intact and correctly positioned; the
  page renders with the overlays.
- Whitelist mode leaves only the marked areas.
- Sanitise removes metadata/attachments/comments/bookmarks/hidden layers
  as ticked and reports counts.

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

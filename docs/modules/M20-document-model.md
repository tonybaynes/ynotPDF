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

- **Structure lives in the model, content lives in the engine.** Page *order*, *presence*
  and *labels* are the `Document`'s alone: deleting or moving a page edits the model's page
  list, never PDFium. `FPDFPage_Delete` is destructive and cannot be undone, so an
  engine-backed delete would make undo a lie. Everything PDFium can reverse exactly —
  rotation, boxes, annotations, field values, inserting a blank page we created — goes to the
  engine immediately so renders reflect the edit. Views resolve a model page id to the live
  PDFium index through `Document.enginePage(pageId)`; M21's writer emits the model's order.
- **Stable ids** (`Ids.ts`): every entity gets `pg-1`, `an-7`, `fl-2`, … unique within the
  document and stable across reordering, deletion and undo. `IdTable` is the two-way map
  between a model id and its engine key (page index, `a<page>.<i>` annotation id); it is
  rebound after any engine operation that renumbers, which is why an annotation deleted and
  restored by undo keeps its model id while its engine id changes.
- **Write intents, not a diff.** Each command reports whether the engine took the change.
  What the engine could not do is recorded as a `WriteIntent` kind on the document
  (`page-order`, `page-labels`, `metadata`, `layers`, `outline`, `custom`). M21 reads
  `document.writeIntents` to know what its writer must apply on top of the engine's bytes.
- **Commands are data.** Every command carries `toJSON()` → `{ id, data }` of plain JSON
  values, and a codec registered by type rebuilds it against a document (`Journal.ts`). One
  mechanism serves three features: undo/redo in memory, autosave and recovery (M21) and batch
  replay (M120). `CompositeCommand` serialises its children, so a transaction round-trips as
  a single entry.
- **Transactions.** `UndoStack.beginTransaction(label)` / `commit()` / `rollback()` sit on the
  same group stack as the existing callback form `group()`, so nesting either way flattens
  into one composite entry and one undo step. Rollback undoes in reverse and records nothing.
- **Merging.** `merge()` coalesces consecutive same-target edits (typing in a field, dragging
  an annotation). `Document.breakMerge()` is called on selection change and after an idle
  gap so "type, pause, type" is two undo steps, as Foxit behaves.
- **Fine-grained events.** `document.on('annotation:added', …)` and friends fire alongside the
  store notification, carrying the entity id, so a view repaints one annotation rather than a
  whole page. `onAny` exists for panels that mirror entire collections.
- **Annotations are a discriminated union** over subtype families (markup, ink, shape, note,
  free text, stamp, widget, link, file attachment, other) sharing `AnnotationBase` — id,
  pageId, rect, flags, author, dates, contents, appearance. Unknown or exotic subtypes
  classify as `other` rather than failing, so a file always loads.
- **Engine contract additions** (ADR 0007, additive): `signatures(doc)` and
  `namedDestinations(doc)`, both read-only and both backed by PDFium APIs the M10 build
  already exports (`FPDF_GetSignatureObject*`, `FPDF_GetNamedDest*`). Needed because the
  brief puts destinations and a signature summary in the model and neither was reachable.
- **PDFium mutation coverage.** Implemented: `setPageRotation`, `insertBlankPages`,
  `deletePages`, `movePage`, `importPages`, `setCropBox` (MediaBox through the same call),
  `addAnnotation`, `updateAnnotation`, `deleteAnnotation`, `setFieldValue` (writes `/V`, plus
  `/AS` for checkbox and radio, then regenerates the widget appearance). Absent from the
  build and therefore model-only: `setMetadata` (PDFium has no info-dictionary setter) and
  `setLayerVisible` (per-object `FPDFPageObj_SetIsActive` is M12's job, not a document
  mutation). Both raise `NotImplementedError`, which the command layer turns into a write
  intent.
- **Ribbon dynamic labels** (ADR 0008, additive): a ribbon button may declare
  `dynamicLabel(ctx)`. The shell already re-evaluates item state on every `invalidate()`, so
  Undo reads "Undo Rotate page" and greys out with no history, as Foxit does.
- **Testing.** The property test runs against `FakeEngine`, an in-memory `PdfEngine` in
  `test/unit/core/fakeEngine.ts`, so 1 000 random commands finish in seconds and every
  fallback path is exercised; a second, smaller suite runs the same commands through real
  PDFium and re-renders to prove the engine agrees. fast-check 4 (MIT) generates the
  sequences.

## Build log (fill in at merge)

**Built 2026-09-08 on `mod/M20-document-model` (worktree `../ynotPDF-M20`).**

### What shipped

- **`Document`** — the full model: pages (stable id, label, `/Rotate`, all five boxes, lazy
  content objects), annotations as a discriminated union over ten families, the form-field tree
  with its widgets, outline, destinations, layers, attachments, metadata, security state, a
  read-only signature summary, view settings, a namespaced `custom` bag, `revision`, `dirty` and
  the derived `writeIntents`. `validate()` checks fifteen invariants and `snapshot()` gives the
  JSON-safe structure the property test compares.
- **Stable ids** (`Ids.ts`) — `pg-1`, `an-7`, `fl-2` … unique per document, never reused, and an
  `IdTable` mapping each to the engine's own key. A page keeps its id through moves, deletions
  and undo; an annotation keeps its id while PDFium renumbers underneath it.
- **Commands** (`commands.ts`) — thirteen of them: rotate, insert, delete, move, set box, rename
  page, add/update/delete annotation, set field value, set metadata, set layer visibility, set
  custom state. `UndoStack` gained `beginTransaction` / `commit` / `rollback` beside the existing
  `group()`, and `Document` gained a 600 ms idle merge barrier so "type, pause, type" is two undo
  steps.
- **Change events** (`events.ts`) — sixteen typed events with the id of what changed, fired
  alongside the store notification.
- **Journal** (`Journal.ts`) — every command serialises to `{ type, payload }` of JSON and a
  registered codec rebuilds it. A transaction round-trips as one entry. Commands with no codec
  are marked, not dropped, so M21 can say what a recovery could not restore.
- **PDFium mutations** — `setPageRotation`, `deletePages`, `insertBlankPages`, `importPages`,
  `movePage`, `setCropBox` (and `setMediaBox`), `addAnnotation`, `updateAnnotation`,
  `deleteAnnotation`, `setFieldValue`, plus the two new reads `signatures` and
  `namedDestinations`. Helpers live in `src/engine/pdfium/mutations.ts`.
- **M20 module** — `DocumentService` (the `document` service), `edit.undo` / `edit.redo` with
  ribbon buttons that name what they would revert, `page.rotateRight` / `page.rotateLeft`, and
  four developer commands the e2e suite drives.

### Decisions worth knowing about

- **Page order and presence live in the model, not the engine.** `FPDFPage_Delete` is
  destructive, so an engine-backed delete would make undo a lie. Deleting or moving a page edits
  the model's list and records a `page-order` write intent; the engine keeps its own pages and
  views resolve through `Document.enginePage(pageId)`. Everything PDFium can reverse exactly —
  rotation, boxes, annotations, field values, blank pages we created — does go to the engine, so
  a render reflects the edit at once. Full reasoning in ADR 0007.
- **Form field values go through PDFium's form-fill environment**, not by writing `/V` on the
  widget. In a hierarchical form the widget is a kid whose `/Parent` holds `/T` and `/V`, and
  PDFium's annotation API cannot reach the parent — the obvious implementation writes to the
  wrong dictionary and every reader still sees the old value. `FORM_ReplaceSelection` and a
  simulated click for the button types let PDFium update the field it owns and regenerate the
  appearance.
- **The raw catalogue pass now re-serialises a mutated document.** PDFium hides `/C` and `/IC`
  behind an appearance stream it generates, so annotation colours are read with pdf-lib as a
  fallback. That fallback parsed the bytes as *opened*, which made every annotation added in the
  session appear colourless. It now saves a copy first when the document has been changed.

### Bugs found while building, and by review

- Undoing an insert deleted pages one at a time, and PDFium renumbers between deletions, so the
  second delete hit the wrong index. Every index is now collected before any of them is removed.
- Deleting a page left its annotations, its fields' widgets and any destination aimed at it
  pointing into nothing. The command now takes them with the page and restores them on undo.
- Undoing the *first* annotation on a page, or the first write to a `custom` namespace, left an
  empty shell behind — "read and empty" where there had been "not read at all". Both now restore
  the absence, which is what made the thousand-command property test pass.

A review pass over the finished branch found four more, all now covered by
`test/unit/core/regressions.test.ts`:

- **Annotation ids could end up on the wrong annotation.** The id table was repaired after an
  engine add or delete by pairing the model list and the engine list *by position*. They are not
  in the same order: an annotation restored by undo goes back where it was in the model, while
  PDFium appends it at the end. So after a delete and its undo, every id from that point on named
  its neighbour — an edit landed on the wrong annotation, and adding to a page whose annotations
  had never been loaded meant undo deleted a pre-existing one and left the added one behind. The
  table is now repaired by index arithmetic: an engine delete shifts the bindings above it down
  by one, an engine add appends and shifts nothing.
- **The journal replayed a page insert to different ids.** `InsertPagesCommand` mints page ids
  and serialised only its position, count and size, so a replay minted fresh ones and any later
  entry naming an inserted page silently did nothing — while the replay reported complete
  success. The ids are in the journal now, and the codec reserves them.
- **Clearing a value was lost on save.** An engine patch says what a field *becomes* and cannot
  say "and empty that one", so `toEngineAnnotation` omits nulls. Deleting a note's text or an ink
  list therefore only happened in the model, with no write intent, and the old value came back on
  the next save. Emptying a field now records the intent.
- **A merged rename dropped its write intent.** `SetPageLabelCommand.merge()` built a fresh
  command without adopting the intents of the two it replaced, and a merged command's `do()`
  never runs — so renaming a page twice quickly lost `page-labels` from the journal, and the
  rename would not have been written.


### Shared files touched (PLAN.md §12.3)

- `src/engine/PdfEngine.ts` — additive: `signatures()`, `namedDestinations()`, the
  `SignatureSummary` and `NamedDestination` types, both names in `ENGINE_METHODS`, and both
  methods on `NotImplementedEngine` (ADR 0007).
- `src/shared/module.ts` — additive: optional `dynamicLabel` on the ribbon `button` and `toggle`
  item variants (ADR 0008).
- `src/renderer/app/ribbon/model.ts` and `widgets.ts` — additive: `ItemState.label`, folded into
  the group signature and applied to the button's text and tooltip.
- `src/renderer/core/{Command,UndoStack,Document}.ts` — `CommandJson`, `CompositeCommand.toJSON`,
  transactions, and the model itself.
- `src/renderer/modules/M00-scaffold/manifest.ts` — **removed** the `edit.undo` / `edit.redo`
  placeholders and their `Mod+Shift+Z` binding. They were stubs against a `document` service that
  did not exist; M20 registers the real commands and provides the service. This is the one
  non-additive shared edit in the module.
- `src/renderer/main.ts` — registers the M20 manifest.
- `vitest.config.ts` — coverage gates for the new core files.
- `package.json` — `fast-check` 4.9.0 (MIT) as a dev dependency.

### Tests

1 129 unit tests and 61 e2e tests, green on Windows locally and in CI on Windows, macOS and
Linux. The four acceptance tests:

- **Property test** — 1 000 random commands, undo all, deep-equal the original; redo all,
  deep-equal the post-state. Plus generated sequences against three engine configurations
  (everything supported, exactly what PDFium supports, nothing supported), whole sequences as one
  transaction, rolled-back transactions, and branching after a partial undo.
- **Engine mutations** — rotate, reorder and delete pages, then the render or the re-read text
  agrees; add an annotation and `annotations(page)` lists it, with its colours and geometry.
- **Journal** — round-trips through `JSON.stringify` and replays into a second copy of the same
  file, giving an identical model and identical page renders.
- **Ribbon** (e2e) — Undo and Redo show "Undo Rotate page", "Undo Delete page", "Undo Insert 3
  pages", and enable and disable with the history.

`src/renderer/core` is at 96 % statements, and `Document.ts`, `commands.ts`, `Journal.ts`,
`Ids.ts`, `model.ts` and `events.ts` all carry coverage gates now.

### Deferred, and why

- **`setMetadata` and `setLayerVisible` are model-only.** PDFium has no information-dictionary
  setter, and layer visibility is a per-object rendering concern (`FPDFPageObj_SetIsActive`) that
  belongs to M12's layer panel rather than to a document mutation. Both raise
  `NotImplementedError`, both become write intents, and M21's writer applies them.
- **Text-field appearance after a value change** is whatever PDFium regenerates. The model and
  the saved file carry the right value; how faithfully the widget redraws before a save is M60's
  problem.
- **Bleed, trim and art boxes** are model-only: PDFium exposes setters for MediaBox and CropBox
  only. M41's crop UI and M21's writer will need them.
- **Named destinations are read-only.** Editing them is M12's.
- **XMP is carried but not parsed.** M72 owns document properties.

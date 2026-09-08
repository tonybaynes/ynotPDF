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

- **The writer's base is the engine's serialisation, not the bytes on disk.** PDFium has already
  applied everything it can reverse — rotation, crop/media boxes, annotations, field values,
  pages we inserted — and `FPDF_SaveAsCopy` keeps every object it does not understand. Re-doing
  that work in pdf-lib would mean two implementations of every mutation and two chances to
  disagree. So `FullRewriteWriter` takes `(base bytes, WritePlan)` and applies only what the
  engine could not: page order and presence, page labels, the three boxes PDFium has no setter
  for, the information dictionary and XMP, the outline, named destinations, layer visibility, and
  appearance streams. Determinism is unchanged — the base bytes are themselves a pure function of
  (original bytes, journal), so `write()` remains a pure function of its inputs and a recovery or
  a batch run reproduces the same file. ADR 0010.
- **The plan is data, and it is sparse.** `buildWritePlan(document)` (in the module, pure) turns
  the model into a JSON-shaped `WritePlan`. Every section is nullable and is filled **only** when
  the document carries the matching write intent, so a no-op save touches nothing and a save that
  only renamed a page rewrites only `/PageLabels`. That is what makes the round-trip acceptance
  test achievable: what the writer does not plan, it does not touch.
- **The engine knows nothing about the model.** `src/engine/Writer.ts` defines `Writer`,
  `WritePlan` and the result types in terms of page indexes and plain values; nothing under
  `src/engine/` imports from `src/renderer/`. The appearance generators take an `AppearanceInput`
  and return an `AppearanceStream` of `{ bbox, content, resources }` — content-stream text, not
  pdf-lib objects — so they are unit-testable in plain Node and the writer is the only file that
  knows which PDF library we use.
- **Appearance streams fill PDFium's gaps, they do not replace it.** The writer walks each page's
  `/Annots` and generates an `/AP` only for annotations that have none. PDFium synthesises
  Highlight, Underline, StrikeOut, Squiggly, Square, Circle, Ink, Text and Popup; it does not
  synthesise Line, Polygon, PolyLine, FreeText, FileAttachment or Caret, and those are what
  `engine/appearance/` ships generators for, plus the markup and shape families so a file written
  by a viewer that did not generate them still looks right. Later modules register their own
  generator for their subtype; the service is a registry, not a switch.
- **Encrypted files never reach pdf-lib.** pdf-lib does not decrypt strings, and a rewrite would
  emit plaintext under a trailer that still claims encryption — a broken file. So: if the plan
  needs no pdf-lib pass the engine bytes are written as they are, encryption intact; if it does,
  Save says plainly that saving will remove the password protection and offers Save As a copy or
  Cancel. Re-encrypting on save is M70's, which hooks into the same pipeline.
- **Atomic writes, in main, always.** `writeAtomic()` writes `<name>.ynot-tmp-<n>` beside the
  target, flushes it, optionally renames the previous file to `<name>.bak` (`save.keepBackup`,
  off by default), then renames the temp over the target — so an interrupted save can never leave
  a half-written PDF where the document was. The renderer cannot reach `fs`; every path goes
  through the new `file:*` IPC channels (ADR 0010).
- **A save does not reload the engine handle**, which is the one place this module knowingly
  departs from its brief. After a full rewrite the engine still holds the pages the model deleted,
  and those pages are what `undo` puts back; reopening from the saved bytes would throw them away,
  so a save would quietly cost the reader their undo history. The model stays the source of truth
  for intent and the engine for content, and every later save re-derives the same file from the
  same pair. The cost is memory, and it is the lesser harm. The one path that does reload is
  "the file changed on disk, reload it", where the reader was told exactly that first.
- **Save is cancellable up to the rename and no further.** The writer runs in M21's own Web
  Worker (`writer.worker.ts`), reports progress by phase and honours an `AbortSignal`; the
  progress dialog appears only after 400 ms so a small file never flashes one. Once the bytes
  reach main, the write is atomic and Cancel is disabled — cancelling a rename is a lie.
- **A recovery record is the journal plus a fingerprint of the source.** `<userData>/recovery/
  <id>.ynot` holds `{ path, title, savedAt, source: { size, sha256 }, journal }`. On launch the
  app lists them, opens the source, checks the fingerprint and replays the journal; a source that
  has changed underneath is offered as "recover into the file as it is now" with the mismatch
  stated in words. Commands with no journal codec are counted, not dropped, so the dialog can say
  "3 of 40 changes could not be restored" rather than quietly restoring the wrong document.
- **Autosave never blocks and never touches the user's file.** The interval timer
  (`save.autosaveMinutes`, default 5, 0 = off) writes recovery records for every dirty document;
  a save or a close clears that document's record. Nothing is written when nothing is dirty.
- **The plan names what the session changed, not what kind of thing changed.** A write intent
  says the engine could not do *a metadata change* or *an annotation change*; it cannot say which
  annotation. Walking the journal can, because every command serialises to data naming its target
  — so clearing one note's text plans that note, and leaves every other annotation alone.
- **The close flow is one function with three answers.** `confirmClose(document)` returns
  `save` / `discard` / `cancel` from an opaque dialog with worded buttons (Save · Don't save ·
  Cancel), reachable by keyboard, and is used identically for one tab, all tabs and app quit.
  Quit and window close are vetoed in main **only while a window has reported unsaved work**, so
  a clean app still quits instantly and a wedged renderer cannot hold the app open (5 s timeout).
- **Read-only is a property of the file, not of a failed save.** Opening probes the path for
  write access (and its directory, for the atomic rename); the tab shows the word "Read-only",
  and `file.save` runs Save As instead, saying why. A save that fails on permissions at the last
  moment falls back the same way, so a network share that goes away mid-session behaves like a
  read-only file rather than losing the edit.
- **Changed-on-disk is watched in main and answered in the renderer.** chokidar (MIT) watches
  each open document's path; the prompt offers Reload (throw away my edits) or Keep mine, and
  the watcher is suspended around our own writes so a save never prompts about itself.
- **Round-trip fidelity is a harness, not a snapshot.** `test/unit/roundtrip.ts` opens two files
  in the real engine and diffs page count, sizes, rotation, boxes, text runs, annotation lists,
  field values, outline, destinations, layers, attachments and metadata, returning a list of
  differences. Every later module adds cases to it rather than writing its own comparison.

## Build log (fill in at merge)

**Built 2026-09-08 on `mod/M21-save` (worktree `../ynotPDF-M21`).**

### What shipped

- **`Writer`** (`src/engine/Writer.ts`) — the contract, and `WritePlan`: the finished document as
  plain data, with every section nullable so that what the plan does not mention, the writer does
  not touch. `FullRewriteWriter` (pdf-lib) applies page order and presence, page labels, the three
  boxes PDFium has no setter for, the information dictionary and XMP, the outline, named
  destinations, layer visibility, annotation entries that had to be *removed*, cleared field
  values, and appearance streams — with object streams, the file's own `/ID` and version kept, and
  every object it has never heard of preserved. Progress by phase, cancellable between phases.
- **Appearance streams** (`src/engine/appearance/`) — a registry, not a switch, with generators
  for Square, Circle, Line, Polygon, PolyLine, Ink, Highlight, Underline, StrikeOut, Squiggly,
  FreeText, FileAttachment and Caret; a small content-stream emitter; and the Standard-14 metrics
  FreeText needs to wrap text. Later modules register their own subtype and the writer draws it.
- **Save** (`Ctrl+S`) — no-op when nothing changed; Save As when the document has no path or
  cannot be written where it is; a warning before a save that would invalidate signatures or
  remove password protection; the writer in its own Worker with a progress dialog after 400 ms;
  an atomic write with an optional `.bak`; dirty cleared.
- **Save As** (`Ctrl+Shift+S`) — the OS dialog, a default name from the title, the folder
  remembered. The flatten checkbox is hidden: M41 and M61 do not exist yet, so there is nothing
  honest to put behind it.
- **Autosave and recovery** — a record every 5 minutes (setting, 0 = off) holding the journal and
  a fingerprint of the source, in `<userData>/recovery/<id>.ynot`; cleared on save or close; an
  opaque Recover / Discard / Not now dialog on the next launch that reopens each source and
  replays. A source that has changed underneath the journal is said so in words.
- **Close flow** — Save · Don't save · Cancel, worded buttons and keyboard-reachable, identical
  for one tab, for Close All and for quitting the app.
- **Changed on disk** — chokidar in main, muted around our own writes, with a Reload / Keep mine
  prompt that says what reloading would cost.
- **Read-only** — probed on open (the file *and* its folder, because the last step is a rename
  into it); the tab carries a "Read-only" badge in words and the status bar says so too; Save
  becomes Save As with a message naming the reason. A permission failure part-way through a save
  is offered the same way rather than as an error the reader can do nothing with.
- **Status bar** — "Saved", "Unsaved changes", "Read-only" or "Saving…", a word and an icon, with
  colour only as a third cue.
- **Round-trip harness** (`test/unit/roundtrip.ts`) — opens two documents in the engine and diffs
  page count, sizes, rotation, boxes, text, annotations, fields, outline, destinations, layers,
  attachments and metadata. Every later module adds cases here rather than writing its own.

### Decisions worth knowing about

- **The writer's base is the engine's bytes, not the file's.** PDFium has already applied
  everything it can reverse, and doing it a second time in pdf-lib would mean two implementations
  of every mutation with no way to tell which was right. The plan carries only the leftovers.
  Determinism is unchanged: the base is itself a function of (original bytes, journal). ADR 0010.
- **Saving does not reload the engine handle**, which is the one place this module knowingly
  departs from its brief. After a rewrite the engine still holds the pages the model deleted, and
  those pages are what `undo` puts back — so reopening from the saved bytes would quietly cost the
  reader their undo history, which Foxit does not do. The cost is memory: pages deleted during a
  long session stay in the engine until the document is closed. The reload path that *does* exist
  is "the file changed on disk, reload it", where the reader is told exactly that first.
- **Encrypted documents are refused by the writer.** pdf-lib does not decrypt strings, so a
  rewrite would emit plaintext under a trailer still claiming encryption. When the plan needs no
  pdf-lib pass the engine's bytes go to disk with the protection intact; when it does, the reader
  is told that saving would remove the password. M70 re-encrypts here.
- **A close or a quit is intercepted only while a window has reported unsaved work**, and a
  renderer that stops answering releases the window after five seconds — with main then closing or
  quitting itself, not merely resolving a promise. An app that cannot be closed is a worse bug
  than a lost edit.
- **The plan names the annotations and fields the session actually changed**, read from the
  journal rather than guessed from the write intents. Intents say what *kind* of thing the engine
  could not do; they cannot say which one, and clearing one note's text must not rewrite every
  annotation in the document.

### Bugs found while building, and what they were

- **`file.closeAll` asked about every document twice** — once itself and once through the tab's
  own before-close hook. A reader who answered would find the same question still in the way. The
  command now just closes the tabs; the hook is where the question belongs.
- **The close/quit timeout resolved a promise and did nothing else**, so a renderer that never
  answered left an app that could not be quit — the exact failure the timeout existed to prevent.
  Main now closes the window (or quits) itself when the wait runs out.
- **`SaveService` never learned that a document had been attached to a tab.** Opening a tab and
  attaching its `Document` are two steps and the store notification comes on the first, so every
  document opened after the service started was invisible to it: no watcher, no read-only check,
  no path. `Documents.onAttached` is the missing signal (ADR 0010).
- **M21's close hook silently disarmed the shell's own question.** `Documents.close` treated a
  registered hook as a *replacement* for the default, so a dirty tab that M21 had nothing to say
  about — one with no `Document` behind it — closed without a word. The default is a backstop now.
- **A save could fail because an antivirus scanner blinked.** On Windows a rename over an existing
  file fails with `EPERM`/`EBUSY` while anything holds the target open, even for milliseconds.
  Telling the reader "the document was not saved" for that would be both wrong and alarming; the
  rename is retried for about a third of a second first.
- **An appearance stream could be emitted with no ink in it** — state changes and a path that was
  never painted. That is worse than no stream at all: a viewer honours the empty `/AP` and draws
  nothing where it would otherwise have guessed. The builder now knows whether it painted.
- **`num()` could write exponent notation**, which a PDF cannot read, for a coordinate large
  enough that `String()` reached for it. Clamped and formatted without one.
- **A repaired file lost its metadata on save.** PDFium rebuilds the cross-reference table of a
  damaged document, reads its `/Info` perfectly well, and then serialises without one — so opening
  `broken-xref.pdf` and saving it dropped the title, the author and the dates. The plan carries a
  metadata fallback that applies only when the base has no information dictionary at all.
- **Deleting a page left everything that pointed at it dangling** — the outline's `/Dest`, the
  name tree, `/OpenAction` and links on the pages that remained, all referring to an object that
  was about to go. The writer prunes them; the bookmark stays and simply does nothing, which is
  what Foxit does and better than deleting a heading the reader wrote.

### Shared files touched (PLAN.md §12.3)

- `src/shared/ipc.ts` — additive: `file:writeAtomic`, `file:probe`, `file:saveAsDialog`,
  `file:watch`, `file:suspendWatch`, the five `recovery:*` channels, `window:setUnsaved`,
  `window:confirmClose`, `app:confirmQuit`, and the push channels `file:changedOnDisk`,
  `window:closeRequested`, `app:quitRequested`, with their payload types (ADR 0010).
- `src/main/{index,ipc,window,menu}.ts` — additive: the handlers for the above, the close/quit
  interception (`beforeClose` / `onClosed` window options), and Save and Save As in the File menu.
- `src/renderer/app/tabs/Documents.ts` — additive: `onAttached`; and one behaviour change, the
  default close hook running as a backstop after the module hooks rather than instead of them
  (ADR 0010).
- `src/renderer/app/tabs/TabStrip.ts`, `tabs.css` — additive: a visible "Read-only" badge. The
  italics that were there said nothing a reader could read.
- `src/renderer/main.ts`, `src/renderer/index.html` — registers the M21 manifest and its CSS.
- `vitest.config.ts` — coverage gates for the new engine and module files; the DOM and shell half
  excluded from the gate as M11's is, and proved by Playwright.
- `.github/workflows/ci.yml` — installs Playwright's Chromium, which the "opens in a plain
  browser" acceptance test needs and Electron does not bring.
- `package.json` — `chokidar` 4.0.3 (MIT) as a dependency, `@pdf-lib/standard-fonts` 1.0.0 (MIT)
  as a dev dependency for the font-metrics drift test.
- `test/e2e/shell.spec.ts`, `test/unit/documents.test.ts` — updated for the two consequences of
  M21 landing that M02's own comments predicted: the File backstage's Save slots are filled now,
  and the close question is M21's.

### Tests

1 520 unit tests and 131 e2e tests, green on Windows locally and in CI on Windows, macOS and
Linux. The four acceptance tests:

- **No-op save round-trips every fixture** — the whole pipeline (model → plan → engine bytes →
  writer), then both files opened in the engine and compared field by field: zero differences on
  all 27 openable fixtures. Encrypted ones are checked for the opposite, that the writer refuses
  them. The saved file then opens in a plain Chromium, whose own viewer is asked for its page
  count and its error state rather than merely being pointed at the file.
- **Rotate, reorder, bookmark, title → save → reopen** — all four present, plus page labels, the
  boxes PDFium cannot set, and a deleted page taking its dangling references with it.
- **Kill the app after edits** — the process tree is killed outright, the next launch offers the
  work back in an opaque dialog, and Recover replays the journal into the reopened file.
- **Save to a read-only path** — the tab says "Read-only" in a word, Save opens the Save As offer
  with the reason in it, and the file on disk is untouched.

Plus: the close flow (Cancel, Don't save, Save, Close All) and a real app quit with unsaved work,
both driven through the running app.

### Deferred, and why

- **The "flatten annotations/forms" checkbox on Save As is hidden**, as the brief allows: M41 and
  M61 own flattening and neither exists, so there is nothing behind it yet.
- **Attachments are carried, not edited.** No module mutates them yet, so the writer preserves
  what is there and the plan has no section for them. M31 adds file attachments.
- **Named destinations are preserved, not rebuilt.** Nothing edits them before M12; when a page
  goes, the writer prunes the references to it rather than rewriting the name tree, which loses
  nothing else in it.
- **Incremental saves are M80's**, optimisation options M100's, encryption on save M70's — all
  three hook into this writer rather than replacing it.
- **A document deleted down and saved keeps its removed pages in the engine** until it is closed,
  which is the memory cost of not reloading the handle (above). If a long editing session ever
  shows this as a real problem, the fix is a handle swap that also rebases the undo stack, and
  that is a `Document` contract change with an ADR of its own.

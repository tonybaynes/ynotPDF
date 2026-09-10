# M130 — Preferences, keyboard shortcuts editor, ribbon/QAT customisation, UI scale, i18n framework

| | |
|---|---|
| **Module id** | `M130` — folder `src/renderer/modules/M130-preferences/`, branch `mod/M130-preferences` |
| **Earliest wave** | 4 (see `PLAN.md` §0/§12) |
| **Tier** | Core |
| **Depends on** | M02, M01 |
| **Unlocks** | — |

## Your task — the prompt for this conversation

You are building **M130 — Preferences, keyboard shortcuts editor, ribbon/QAT customisation, UI scale, i18n framework** of ynotPDF. Carry this brief out end to
end without waiting to be asked for the next step:

1. Read this file completely, then `CLAUDE.md`, `PLAN.md` §2–4, §9 and §12,
   and the briefs of your direct dependencies: [M02 Application shell (ribbon, panes, tabs, status bar, dialogs)](./M02-app-shell.md), [M01 Theme system (four themes)](./M01-theme-system.md).
   Confirm each dependency is ☑ in `PLAN.md` §0. If one is not, say so and
   stop — do not build against unfinished work.
2. Create branch `mod/M130-preferences` from `main` in a new git worktree and
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

The Preferences dialog aggregating every module's settings schema, a
keyboard-shortcut editor, ribbon and quick-access-toolbar customisation,
UI scale, identity, and the localisation framework (en-GB first).

## Foxit 14 reference — what to emulate

Foxit File → Preferences (dozens of categories: General, Documents, Page
Display, Commenting, Forms, Full Screen, Identity, Languages, Measuring,
Print, Reading, Security, Signature, Spelling, Trust Manager, Units…),
Customize Ribbon / Quick Access Toolbar, keyboard shortcuts.

## Scope — build all of this

- Preferences dialog (opaque, categories list left, search across all
  settings, reset per category/all): generated from module `SettingsSchema`s
  (types: boolean, number with units, enum, colour-token pick, text, file
  path, list); live apply where possible; import/export settings JSON.
- Identity (name, initials, email, organisation) used by annotations/
  signatures.
- Shortcut editor: every command, current binding, record new, conflict
  detection with words, reset; export/import; printable cheat sheet (PDF
  via pdf-lib!).
- Customise ribbon/QAT: reorder/hide groups and buttons, add commands to
  QAT, reset.
- UI scale slider 100–200 %, font choice (UI font from bundled set).
- i18n: `resources/i18n/en-GB.json` extracted from code by a script;
  `t()` helper; language switch (only en-GB shipped, plus `en-US`
  spelling variant as a proof).
- Units preference used app-wide (rulers, crop, measure).

## Out of scope

Cloud sync of settings.

## Design notes & constraints

- Scan page carries `scan.autoDeskew` ("Straighten scanned pages automatically
  when importing images", default off) registered by M41; M91 reads it.
- **View page must carry `ui.leftPaneOnOpen`** (Pages / Bookmarks / Last
  used / Closed — default Pages), registered by M12. The operator relies
  on the thumbnail pane; it must be settable here in words, not only from
  the pane's context menu.
- Settings live in one `electron-store` with schema versions and
  migrations; modules read via a typed `settings.get('M11.tileCacheMb')`.

## Files you will create or touch

`src/renderer/modules/M130-preferences/**`, `src/shared/settings.ts`
(additive), `resources/i18n/**`, `scripts/extract-i18n.ts`, tests.

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

## Acceptance tests — the module is done when these pass on all three OSes

- Every setting exposed by every merged module appears, changes, persists
  and applies live where declared; search finds "tile cache".
- Rebind Ctrl+F to Ctrl+Shift+F ⇒ find bar opens on the new key;
  conflict warns.
- Cheat-sheet PDF lists all bindings.

---

## Project context (identical in every module brief — read once per session)

**ynotPDF** is a cross-platform (Windows / macOS / Linux) desktop PDF editor
targeting the feature set of **Foxit PDF Editor 14** — *feature set only*:
**never copy Foxit's icons, artwork, wording, help text or documentation.**
Industry-standard icon conventions shared by Adobe, Foxit, Tungsten and
others (magnifier = zoom, hand = pan, highlighter, stamp, padlock, pen for
sign) are generic — use them freely; what must not be copied is Foxit's
*specific artwork*: its exact shapes, colours, pixel layouts. Icons come
from **Lucide (ISC) first**; when it lacks one, **Tabler Icons (MIT)** or
**Phosphor (MIT)** — same stroke style — then Fluent UI System Icons (MIT),
Material Symbols / Remix Icon (Apache-2.0); otherwise draw our own in the
Lucide stroke style. Not Font Awesome, Flaticon/Freepik, Noun Project or
Icons8. **Clipart / illustrations** (stamps, cover sheets, help, first
run): Openclipart and Public Domain Vectors (CC0), Wikimedia Commons (only
files marked CC0 / public domain / CC BY), unDraw and Pixabay (own free
commercial licences). Never CC BY-SA, BY-NC or BY-ND; never Freepik,
Flaticon, Vecteezy, Clker or image-search results. CC0 preferred, CC BY
acceptable. Every set and every clipart item used is entered in
`resources/credits.json` with source URL, author and licence. Similar in
idea or better, never traced or pixel-copied. **Never open, read, extract or decompile anything from an
installed Foxit, Adobe or Tungsten product** (e.g. `C:\Program Files\Foxit
Software\…`) — not icons, strings, templates, fonts, help, stamps or
JavaScript; their EULAs forbid it and it would leave a copying trail. Learn
their behaviour only as a user would, from the running app and public
documentation. Record in your Design decisions where a feature's
behaviour came from (public docs, the PDF spec ISO 32000, our own choice)
— this file is the provenance record. Help and
documentation are written from scratch for ynotPDF. *(Tony's rule,
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

**UI & accessibility rules (non-negotiable — Tony has low vision and is
colourblind: black and red read as the same colour):**
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
- **A feature is not covered until a test reaches it the way a person does**
  (M04). Asserting that something is *visible* is not asserting that it is
  *usable*: a UI test presses the button by its **visible label**, clicks the
  panel tile, clicks the page, and then asserts *where* things are —
  `test/e2e/journey.ts` and `test/e2e/layout.ts` are the helpers, and
  `test/README.md` states the rule in full. `app.run(...)` is for setup, never
  for the action under test.
- Data that can change (presets, stamp catalogues, substitution tables)
  goes in `resources/` data files, not code.
- Commits: `<Mid>: <what>` and end with
  `Co-Authored-By: Claude <noreply@anthropic.com>`. Never commit real
  customer PDFs, binaries, or secrets — fixtures are public-domain/synthetic.
- **Real sample PDFs for hands-on testing live in `test/fixtures/local/`**
  (git-ignored; Tony drops files there, so they carry personal
  data). Currently: three airline boarding passes and **`Sample
  Portfolio.pdf`, a Foxit-made PDF Portfolio (`/Collection`) containing
  those three** — use it for attachments, embedded-file and portfolio
  behaviour. Open them when you manually check
  your module against real-world files, and prefer them over synthetic
  fixtures for "does it look right" judgements. Tests may use them only
  with `it.skipIf(!existsSync(...))` — CI and other machines don't have
  them. Never copy, commit or quote their contents; `local/README.md`
  lists what is there.
- **Tony is who you are working for — call him Tony, not "the operator"**
  (2026-09-11). Older text across this repository still says "the operator";
  that is history and is not being rewritten, but new writing uses his name.
- Replies to Tony: short and plain (eyesight). Never leave him a to-do you
  could do yourself.

---

## Design decisions (fill in before coding; keep current)

- **Contract additions are additive and recorded in
  [ADR 0018](../adr/0018-preferences-contracts.md).** `SettingSpec` gains the four types the
  brief asks for that M00 did not define — `colour` (a theme token, never a literal), `path`
  (a file or folder), `list` (an ordered list of strings) and `unit` on `number` — plus optional
  `description`, `keywords`, `advanced` and `live` on every type; `SettingsSchema` gains optional
  `title`, `icon` and `order` so a module can name its own page. `Registry` gains
  `unbindShortcut()` and `serviceNames()`. Four settings IPC channels are added (`settings:all`,
  `settings:setMany`, `settings:reset`, `settings:path`) because get/set one key at a time cannot
  export, import or reset. Everything already merged compiles and renders unchanged.
- **Preferences is generated, never hand-listed.** One page per *module* (not per namespace —
  M02 and M12 both write `ui.*`), labelled with the manifest's `name` unless its schema overrides
  it, ordered and iconed from `resources/preferences.json`. A module merged tomorrow gets its page
  for free; M41's `scan.autoDeskew` will appear on a Scan page with no code change here.
- **Live apply rides an existing convention rather than a new hook.** Every module service already
  exposes `load()` that re-reads its settings and applies them (M11, M12, M13, M21, M30, M31, M32,
  M40, M42, M70, M72, M91 all do). After a write M130 calls `load()` on every registered service
  that has one, applies `theme.*` through M01's `ThemeManager` and the shell's `ui.*` keys through
  the `UiState` store, then tells its own listeners. No other module's folder is touched.
- **Search is over title + description + keywords + the key itself, plus a synonym table in
  `resources/preferences.json`.** "tile cache" finds `viewer.cache.megabytes` because the synonym
  table says so — the operator's words, not the module author's, and data rather than code.
- **Shortcuts are stored as overrides, not as a full table** (`shortcuts.bindings`, a map of
  command id → key or `null` for "unbound"). A module that changes its own default binding is
  then still obeyed for every command the reader has not touched, and Reset is deleting a key.
  Rebinding unbinds the old key first (`Registry.unbindShortcut`), which is why that method exists.
- **Conflicts are words, never a colour.** "Ctrl+F is already **Find**" with a warning icon, an
  Assign anyway / Cancel choice, and the displaced command shown as unbound afterwards.
- **The cheat sheet is drawn with pdf-lib and the standard fonts** (same approach as M42's cover
  sheet), paginated, two columns, grouped by category, and opens as an unsaved document — the way
  M32's comment summary already arrives.
- **Ribbon/QAT customisation is a filter over the group list, not a fork of the ribbon.** M130
  registers a `ribbonCustomisation` service; `Ribbon.ts` asks for it (one small additive edit) and
  applies hidden/reordered groups and items before the pure model runs. The manifests stay the
  source of truth; the customisation is a diff on top, stored under `ui.ribbon.custom`, and Reset
  deletes it.
- **Units: `app.units` is the app-wide preference and `viewer.rulers.units` follows it.** M11
  already owns the ruler key and reads it in `load()`; writing both keeps one visible answer in
  Preferences without a second source of truth. A `units` service exposes it to M33/M41 later.
- **UI font comes from the fonts already bundled** (Liberation, DejaVu — OFL, fetched by
  `fetch-binaries` and credited under M10), loaded the way M10 loads them: `import.meta.glob`
  with `?inline` so a build without fetched fonts silently keeps the system stack. Options live in
  `resources/ui-fonts.json`; the choice sets `--font-ui`. No new package, no new binary.
- **i18n is a framework plus a proof, not a translation.** `t(key, fallback)` reads a catalogue;
  `scripts/extract-i18n.ts` walks the source for `t('…', '…')` call sites and writes
  `resources/i18n/en-GB.json` from the fallbacks, then generates `en-US.json` by applying the
  spelling table in `resources/i18n/spelling-en-US.json`. en-US is therefore a real catalogue that
  the script can regenerate, not a special case in the lookup. M130's own UI is the first consumer;
  `t()` falls back to en-GB and then to the literal, so a module that has not adopted it still reads.
- **Settings are versioned in `src/shared/settings.ts`** — one `SCHEMA_VERSION`, an ordered list of
  migrations, run in main when the store opens, and applied again to any imported JSON so an
  exported file from an older build imports cleanly.
- **A settings value that is an object must not have dots in its own keys.** Found while building:
  `electron-store` treats a dotted key as a path, so reading the whole file back spreads an object
  across one key per field — and a map keyed by a command id or a ribbon group id comes back
  nested and unrecognisable. Both of M130's composite settings are therefore stored as arrays of
  entries. The rule is on `flatten` in `src/shared/settings.ts`; `valueAt` and `dropTree` handle
  the legitimate nested case.
- **The UI scale keeps M01's command.** M01 already registers `view.uiScale.set`; M130's slider
  writes `ui.scale` and the theme applier hands it to the `ThemeManager`. One command, one owner.
- **M01's schema and its storage disagree**, and the alias table is the patch, not the fix: M01
  declares `theme.scale` and `theme.nightMode` while its `ThemeManager` reads `ui.scale` and
  `view.nightMode`. Preferences writes both sides so the setting the reader changes is the one the
  app obeys. M01 should tidy this when it is next opened; the alias line can go with it. M41 drifts the
  other way — its schema names `documentOps` as a namespace but stores every key without it —
  and a *prefix* alias in the same table (`documentOps.` → nothing) covers all fourteen of its
  settings at once.
- **i18n covers M130's own interface, and nothing else yet.** `t()` needs a literal key at the call
  site so the extractor can find it, which rules out translating another module's setting titles
  from here. Each module adopts `t()` when it is next touched; until then a switched language
  respells M130's own text and leaves the rest in en-GB, which reads correctly either way.
- **Provenance.** The category list (General, Documents, Page Display, Commenting, Identity,
  Languages, Units, Security…), "Customize Ribbon / Quick Access Toolbar" and a shortcut editor
  with a printable list are Foxit's *feature set*, learned as a user; every word, layout, icon and
  behaviour here is ours. The `Mod`-key and key-tip conventions are Windows/macOS platform
  conventions, not Foxit's.

## Build log (fill in at merge)

**Shipped (2026-09-10):**

- **Contracts** — [ADR 0018](../adr/0018-preferences-contracts.md), all additive:
  `SettingSpec` gains the `colour` (theme token), `path` and `list` types, `unit` on `number`, and
  `description` / `keywords` / `section` / `advanced` / `live` on every type; `SettingsSchema` gains
  `title` / `icon` / `order`; `Registry.unbindShortcut()` and `Registry.serviceNames()`; IPC
  `settings:all`, `settings:setMany`, `settings:reset`, `settings:path`; a `ribbonCustomisation`
  service the ribbon asks for; and the `load()` reload convention every module service already met.
  Everything merged before this compiles and renders unchanged.
- **`src/shared/settings.ts`** (new): the schema version and its migration list, the flat/nested
  pair the dotted store needs (`flatten`, `unflatten`, `valueAt`, `dropTree`), and the exported
  file's envelope with its validation. Pure — unit-tested without Electron, and run over an
  imported file so an export from an older build imports cleanly.
- **Main**: `Settings` gains `all()`, `setMany()`, `reset(prefixes)` and `path`, and runs the
  migrations when the store opens.
- **Preferences dialog** (`PreferencesDialog.ts`, `controls.ts`, `model.ts`): one opaque window,
  pages generated from every module's `SettingsSchema`, sections within a page, search across
  title / description / keywords / key / enum labels plus a synonym table, live apply with no OK
  button, a "changed" badge in words with a per-setting reset, per-page reset, advanced settings
  behind a tick box, and a control for each of the seven types.
- **Shortcut editor**: every command with its key, recording a chord with `keyFromEvent` so what is
  stored is what the dispatcher matches, conflict resolution in words that unbinds the displaced
  command, per-command and global reset, import, and a printable PDF sheet drawn with pdf-lib from
  `resources/shortcuts/cheatsheet.json` (two columns, paginated, every command listed — including
  the unbound ones, because "what is still free" is the other half of the question).
- **Ribbon and toolbar**: a keyboard-operable tree of tabs → groups → buttons with a tick box and
  Move up / Move down on each row, a quick-access-toolbar editor, and Reset. Stored as a diff over
  the manifests, so a button added by a later module appears without touching the customisation.
- **Identity, language, units, interface font**: `identity.*` (name, initials, email, organisation)
  written where M30 reads it; `app.units` mirrored into `viewer.rulers.units` so there is one
  visible answer; the interface font chosen from the Liberation and DejaVu faces the installer
  already carries; the UI scale driven through M01's own command.
- **i18n**: `t(key, english)`, `resources/i18n/en-GB.json` extracted from the call sites by
  `scripts/extract-i18n.ts`, `en-US.json` generated from it by the spelling table, a language
  switch that redraws, and `--check` wired into `npm run lint` so the catalogues cannot drift.
- **Data, not code**: `resources/preferences.json` (page order, icons, labels, key aliases, search
  synonyms), `resources/ui-fonts.json`, `resources/shortcuts/cheatsheet.json`, `resources/i18n/**`.
- **Tests**: 7 new unit files, 175 tests (page model and search against the *real* manifests, the
  settings contract and hub, the shortcut rules and the cheat sheet, the customisation algebra,
  i18n and the extractor, units and fonts, the manifest and the two Registry additions) — 3487 unit
  tests green. `test/e2e/preferences.spec.ts` adds 34 Playwright tests covering every acceptance
  line; 407 e2e green locally.

**Three real bugs the tests found, all fixed:**

- **An object-valued setting was being destroyed by the store's dotted paths.** Reading the file
  back flattens a stored object into one key per field, so a map keyed by a command id
  (`edit.find`) or a ribbon group id (`home.clipboard`) came back nested and unrecognisable — the
  reader's shortcuts and ribbon customisation vanished on the next start. Both are now stored as
  arrays of entries; `valueAt` rebuilds a legitimately nested object and `dropTree` deletes one
  whole. The rule is written on `flatten` for the next module author.
- **The appliers were re-applying a stale cache.** M130 is not the only writer of `settings.json`;
  applying the whole snapshot on every write pushed an old value back over what another module had
  just set from its own toolbar. An applier is now given the set of keys that actually changed and
  acts only on those, and the dialog re-reads the file when it opens.
- **`view.uiScale.set` already existed** (M01's), so registering it here threw at boot. Caught by
  the manifest test that registers the whole application; M130 uses M01's command instead.

**After the first CI run (M33, M41 and M50 had landed meanwhile):** macOS failed on the e2e
spec alone — it pressed `Control+K` and asserted the text `Ctrl+F` where a Mac binds `⌘K` and
the editor rightly shows `⌘+F`. The spec now presses `Meta` on darwin and formats expectations
with the app's own `formatShortcut`, so it cannot drift from what the reader sees. Rebasing also
surfaced that M41 declares its schema under `documentOps` but stores every key without that
prefix; a data-driven *prefix alias* in `resources/preferences.json` covers all fourteen settings
in one line, and M50 gained its page entry there.

**Deferred, and why:**

- **The migration list is empty.** Nothing in the store has been renamed yet, so shipping an
  invented migration would be worse than none. The mechanism ships now — running it, and testing
  it against real steps — because adding it to a store already on a thousand machines costs a
  great deal more than adding it to an empty one, and an importer needs it before the first rename.
- **i18n covers M130's own interface only.** `t()` needs a literal key so the extractor can find
  it, which rules out translating another module's setting titles from here. Each module adopts
  `t()` when it is next touched; a switched language respells M130's text today and leaves the
  rest in en-GB, which reads correctly either way.
- **Export writes through the native save dialog**, which an e2e run cannot answer, so the e2e
  suite drives the import side with the text directly. The envelope both sides share is unit-tested
  round-trip.

**Shared-file edits, all additive and small**: `src/shared/module.ts` (the setting types),
`src/shared/ipc.ts` (four settings channels), `src/shared/settings.ts` (new),
`src/main/{settings,ipc}.ts`, `src/renderer/core/Registry.ts` (`unbindShortcut`, `serviceNames`),
`src/renderer/app/ribbon/Ribbon.ts` (the customisation hook), `src/renderer/app/services.ts`
(`SERVICE.settings`), `src/renderer/main.ts` (register M130 last, so it sees every binding),
`package.json` (`npm run i18n`, `--check` in lint), `vitest.config.ts` (coverage), and
`test/e2e/shell.spec.ts` — M130 fills the last empty File-tab slot, so the assertion that an
unfilled slot says "not available yet" moved to `test/unit/preferences/manifest.test.ts` rather
than being dropped.

**One thing for M01 when it is next opened**: its schema declares `theme.scale` and
`theme.nightMode` while its `ThemeManager` reads `ui.scale` and `view.nightMode`. Preferences
writes both sides through the alias table in `resources/preferences.json`; tidying M01 lets those
two alias lines go.

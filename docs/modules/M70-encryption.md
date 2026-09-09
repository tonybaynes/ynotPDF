# M70 — Encryption, permissions & certificate security

| | |
|---|---|
| **Module id** | `M70` — folder `src/renderer/modules/M70-encryption/`, branch `mod/M70-encryption` |
| **Earliest wave** | 2 (see `PLAN.md` §0/§12) |
| **Tier** | Core |
| **Depends on** | M21 |
| **Unlocks** | [M120 Batch processing & action wizard](./M120-batch-actions.md) |

## Your task — the prompt for this conversation

You are building **M70 — Encryption, permissions & certificate security** of ynotPDF. Carry this brief out end to
end without waiting to be asked for the next step:

1. Read this file completely, then `CLAUDE.md`, `PLAN.md` §2–4, §9 and §12,
   and the briefs of your direct dependencies: [M21 Save, Save As, autosave & recovery](./M21-save.md).
   Confirm each dependency is ☑ in `PLAN.md` §0. If one is not, say so and
   stop — do not build against unfinished work.
2. Create branch `mod/M70-encryption` from `main` in a new git worktree and
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

Password security (AES-256/AES-128/RC4-128 legacy), permission flags,
remove security, and certificate-based encryption, applied on save through
qpdf.

## Foxit 14 reference — what to emulate

Foxit Protect → Password Protect (open password, permissions password,
printing allowed none/low/high, changes allowed, copy/extract, accessibility,
encrypt all/except metadata/attachments only, algorithm), Remove Security,
Certificate Protect (recipients with per-recipient permissions), Security
Properties.

## Scope — build all of this

- Security dialog (opaque) mirroring Foxit's options; strength meter with
  words; confirm fields; store as a document security *intent* on the model
  (never the password in the journal/recovery file — hold in memory only,
  re-prompt after recovery).
- Writer pipeline stage: after the full/incremental write, run qpdf
  (`@jspawn/qpdf-wasm` in a worker or bundled CLI via IPC — choose in an
  ADR; the app ships whichever) to encrypt with the chosen algorithm/
  permissions, `--encrypt-metadata` options; remove security with the
  owner password; keep document id.
- Certificate encryption: public-key encryption per PDF spec (`/Filter
  /Adobe.PubSec`) with recipients from `.cer/.p7b` or the OS store (M81's
  certificate service if merged; otherwise file-based), per-recipient
  permissions; open such files with a private key from a `.p12` (prompt).
- Permission enforcement inside the app: respect `/P` flags when the
  document was opened with the user password (disable print/copy/edit
  commands with tooltips saying why); owner password unlocks.
- Security tab in Properties (M72) shows the state.
- Batch hook for M120.

## Out of scope

RMS/AIP (Parked).

## Design notes & constraints

- **Windows on ARM (M03):** prefer `@jspawn/qpdf-wasm` precisely because it
  is architecture-independent. If the bundled qpdf CLI is chosen instead,
  `resources/binaries.json` must carry `win32-x64` **and** `win32-arm64`
  entries (qpdf publishes both) and the ADR must say so; CI packages both.
- Passwords never logged, never in the journal, never in recovery files.
- qpdf is the single implementation of the crypto — do not reimplement.

## Files you will create or touch

`src/renderer/modules/M70-encryption/**`, `src/engine/security/**`,
`docs/adr/00NN-qpdf-packaging.md`, tests.

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

@jspawn/qpdf-wasm or qpdf release binaries (Apache-2.0), node-forge.

## Acceptance tests — the module is done when these pass on all three OSes

- Encrypt fixture with AES-256 open+owner passwords and print=none ⇒ opens
  in Chrome with the password; `qpdf --show-encryption` confirms
  algorithm and flags; our app disables Print with a worded tooltip when
  opened with the user password.
- Remove security with the owner password ⇒ `qpdf --check` shows none.
- Certificate-encrypt to a test cert ⇒ opens with its .p12, fails
  without.

---

## Project context (identical in every module brief — read once per session)

**ynotPDF** is a cross-platform (Windows / macOS / Linux) desktop PDF editor
targeting the feature set of **Foxit PDF Editor 14** — *feature set only*:
**never copy Foxit's icons, artwork, wording, help text or documentation.**
Icons come from Lucide or are drawn by us; they may be similar in idea (a
magnifier for zoom) or better, never traced or pixel-copied. Help and
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

- **qpdf ships as WebAssembly, and the package is `@neslinesli93/qpdf-wasm` (qpdf 12.2.0).** The
  brief's preferred `@jspawn/qpdf-wasm` is qpdf 10 from July 2022 and does not load on Node 26 at
  all — its Emscripten shim decides it is a browser, then `fetch()`es a `file://` URL and throws.
  The chosen build is current and runs unmodified under Node. WASM rather than a bundled CLI is
  not only the arm64 argument: qpdf publishes release binaries for Windows only, so a CLI would
  mean building qpdf ourselves for macOS and Linux, and `binaries.json` would carry four entries
  that CI has to produce. One 1.3 MB `.wasm` is the same file on every OS and every CPU. ADR 0011.
- **qpdf runs in the main process, not in a renderer Worker — and that answer was arrived at the
  hard way.** The Worker was built first, beside M21's writer. It does not work: this build of
  qpdf-wasm has had its `wasmBinary` option minified away, so it can only be pointed at a URL,
  and every URL a `file://` renderer can offer it (`data:`, `blob:`, even a `Response` served
  from a wrapped `fetch`) ends with the renderer **process dying** — no exception, no window,
  exit code 143. The same module and the same bytes work perfectly in a plain Chromium worker.
  Main is Node: the module reads its own `.wasm` off disk, and the renderer reaches it through
  typed `security:*` channels exactly as it reaches `file:writeAtomic`. It is also where M120 and
  M121 will want it. ADR 0011 records the whole of it, because the next module reaching for a
  Worker to hold a big WebAssembly module needs to know.
- **Each qpdf command gets its own module instance.** qpdf is a command-line program: `main`
  returning means `exit()`, and a second `callMain` on the same instance runs a program that has
  already ended. Node tolerates it and returns nonsense; a Chromium renderer does not survive it.
  A fresh instance per run costs about 40 ms, once or twice per save, and is what a real `qpdf`
  would do anyway.
- **qpdf does the standard security handler; it cannot do the certificate one.** qpdf 12 has no
  public-key encryption — no `--recipient`, no `/Adobe.PubSec`, and an open upstream issue rather
  than an implementation. So "qpdf is the single implementation of the crypto" holds for
  passwords, which is where it matters and where nearly every file lands, and certificate
  security is ours. ADR 0012 says so in full.
- **Certificate security is built on the two halves qpdf leaves us, and verified against qpdf.**
  Writing a public-key file needs (a) the CMS envelopes — node-forge — and (b) AES-256-CBC over
  every string and stream, which is the *same* content encryption the standard handler uses:
  for AESV3 the object key is the file key itself. So the encryptor is a walk over pdf-lib's
  object graph, and its correctness is provable: swap the `/Adobe.PubSec` dictionary for a
  `/Standard` R6 one wrapping the identical file key under a password we choose, and
  `qpdf --check` reads every stream in the file. That is the certificate acceptance test.
- **Opening a certificate-encrypted file swaps the dictionary the other way, and never parses
  the body.** From the recipient's `.p12` we recover the seed, derive the file key, then append
  an incremental update whose only content is a `/Standard` R6 `/Encrypt` dictionary wrapping
  that key under a throwaway password. `qpdf --decrypt` then does all the parsing — object
  streams, cross-reference streams, damaged files and every other case pdf-lib would refuse —
  and PDFium is handed plaintext. Twelve lines of appended bytes instead of a second PDF parser.
- **Nothing we write is encrypted twice.** Our public-key writer emits no object streams: pdf-lib
  builds those at save time, after our pass has encrypted the strings, and a string inside an
  object stream must not be encrypted separately from the stream that holds it. The password
  path has no such constraint because qpdf does the whole job itself.
- **The document carries a security *intent*, never a password.** `SecurityIntent` lives in the
  model's custom bag under `M70` and says what the file should become — algorithm, permissions,
  what to encrypt, recipients — with the passwords held in a module-private map keyed by document
  id and never written to the store, the journal, a recovery record or a log. After a crash the
  journal replays the intent and the reader is asked for the passwords again, which is the only
  honest thing a recovery file can do.
- **Setting security is an undoable `Command` like everything else.** `SetSecurityCommand` and
  `RemoveSecurityCommand` swap the intent slice and record the `custom` write intent; undo puts
  the previous intent back, and the passwords ride along in the command object rather than the
  journal so undo works in-session without ever persisting them.
- **Encryption is a stage of the save pipeline, not a second save.** M21 hands its written bytes
  to any registered `SavePipelineStage` before they reach `file:writeAtomic`, so the file that
  lands on disk is encrypted the first time and there is never a plaintext window. The stage
  interface is M21's (`src/engine/Writer.ts`, additive) and M70 registers into it; M120 gets the
  same stage for batch. A stage also answers `handlesSecurity(documentId)`, which does two things
  in M21: it silences the "saving will remove the password" warning, which would be either false
  or a second question, and it makes the save ask the engine for **decrypted** bytes — pdf-lib
  cannot rewrite an encrypted document, and the stage is what puts the protection back. ADR 0012.
- **A protected file re-encrypts itself on save.** M21 refuses to rewrite an encrypted document
  because pdf-lib would emit plaintext under an encrypted trailer. With M70 present that warning
  is replaced by the real behaviour: the engine's decrypted bytes go through the writer, and the
  pipeline stage puts the same protection back — same algorithm, same permissions, same
  passwords — using the passwords held in memory. If they are not in memory (a file opened with
  the user password, or recovered) the reader is asked before the save, not after it.
- **Permission enforcement is a declaration, not a copied `when` clause.** `CommandSpec.permission`
  (additive, `src/shared/module.ts`) names the permission a command needs; the Registry consults a
  registered `permissionGate` and the ribbon's tooltip gains a sentence saying which permission is
  missing and that the owner password lifts it. M70 registers the gate, so a build without M70
  leaves every command enabled and nothing else has to know. `SecurityService.allows(action)` is
  the single answer behind it: true when unprotected, true when opened with the owner password or
  a digital ID, otherwise what `/P` says.
- **A certificate-protected file cannot be re-protected on its own, and the save says so.** Such a
  file names its recipients inside sealed envelopes but does not carry their certificates, and
  nothing can encrypt to a certificate it does not have. A document opened with a digital ID and
  saved without being protected again therefore comes out in the clear, with a warning that says
  exactly that and asks the reader to choose the recipients again. Silence there would be the
  worst failure this module could have.
- **Passwords are compared and measured, not judged.** The strength meter reports a word
  (Very weak · Weak · Fair · Strong · Very strong) with the reason beside it, computed from
  length, character classes and a small list of the obvious ones in `resources/`; it never blocks
  a save, because the reader's document is the reader's business.
- **The permission model is one type, three representations.** `PermissionFlags` in the engine is
  the app's vocabulary; `permissionsToP()` and `pToPermissions()` convert to and from the `/P`
  bitfield, and `permissionsToQpdfArgs()` to qpdf's command line. All three are pure and tested
  against qpdf's own `--show-encryption` output, so a flag cannot mean one thing to us and
  another to the file.

## Build log (fill in at merge)

**Built 2026-09-08 on `mod/M70-encryption` (worktree `../ynotPDF-M70`).**

### What shipped

- **`Security`** (`src/engine/security/`) — four operations and no UI: what a file's protection
  *is*, put protection on, take it off, and open a certificate-protected file with a `.p12`. qpdf
  12.2.0 performs the standard security handler; the two things it has no implementation of are
  ours. Bytes in, bytes out, so M120 can run the identical code with no window open.
- **Password protection** — AES-256, AES-128, RC4-128 and RC4-40, the full permission set, and
  `/EncryptMetadata`. The `/P` arithmetic is checked against qpdf's own `--show-encryption` for
  every combination the dialog can produce, so a flag cannot mean one thing to us and another to
  the file.
- **Certificate protection** — CMS envelopes per recipient (node-forge), each carrying that
  recipient's own permission bytes, the spec's key derivation, and AES-256 over every string and
  stream. Recipients come from `.cer`, `.crt`, `.der`, `.pem` or `.p7b`; a document opens with the
  recipient's `.p12` and refuses anyone else's.
- **"Encrypt only file attachments"** — the `/EFF` arrangement, which qpdf also has no option for:
  the document reads without a password and only its embedded files are protected.
- **Remove security**, with the owner password, saying plainly what it costs before it happens.
- **The Protect dialog** — Foxit's options with the operator's requirements over the top: a
  strength meter that is a word, an icon and a sentence rather than a coloured bar; every caution
  stated in words *before* it happens; both password fields always present, always keyboard
  reachable, each with a show/hide toggle.
- **Permission enforcement** — `CommandSpec.permission` (additive) plus a registered
  `permissionGate`: a command the open document forbids is disabled, and its tooltip says which
  permission is missing and that the owner password lifts it. `protect.security` and
  `protect.remove` declare it today; M13's Print and Copy need only add the line.
- **Unlock**, which lifts the restrictions for the session with the owner password without
  changing the file — which is what an owner password is for.
- **A Security panel** (`securityPropertiesPanel()`), returned as an element so M72 can host it as
  the Properties dialog's Security tab, and shown on its own until then.
- **The save pipeline stage** (`SavePipelineStage`, `runSaveStages`) — M21's contract, M70's
  implementation. The file that lands on disk is protected the first time it is written.
- **A status item** — "Protected", "Restricted", "Unlocked" or "Protection pending", a word and an
  icon, colour only as a third cue; hidden entirely for an unprotected document.

### Decisions worth knowing about

- **qpdf runs in the main process, and the renderer Worker it was first built as does not work.**
  This build of qpdf-wasm had its `wasmBinary` option minified away, so it can only be pointed at a
  URL — and every URL a `file://` renderer can give it (`data:`, `blob:`, even a `Response` served
  from a wrapped `fetch`) kills the renderer **process**: no exception, no window, exit code 143,
  with the network and GPU utilities dying in the same breath. The same module and the same bytes
  work perfectly in a plain Chromium worker, which is what makes it Electron's problem rather than
  qpdf's. Main is Node, reads the `.wasm` off disk, and is where M120 and M121 will want it anyway.
  ADR 0011 records the whole investigation, because the next module reaching for a Worker to hold a
  large WebAssembly module needs to know.
- **Every qpdf command gets its own module instance.** qpdf is a command-line program: `main`
  returning means `exit()`, and a second `callMain` on the same instance runs a program that has
  already ended. Node tolerates it; a Chromium renderer does not survive it. About 40 ms per run.
- **qpdf has no public-key security handler, so certificate protection is ours** — and it is
  *verified* rather than asserted. Under AESV3 the object key is the file key, so a public-key file
  and a standard-handler file differ only in their `/Encrypt` dictionary. Swapping ours for a
  `/Standard` R6 dictionary wrapping the identical key lets `qpdf --check` decrypt and validate
  every stream in the document; a wrong IV, a wrong key or a stream we forgot would all show up.
  That same swap, run the other way as a twelve-line incremental update, is also how the app
  *opens* such a file — qpdf then does all the parsing, and no second PDF parser was needed.
- **Certificate protection is AES-256 only.** The older public-key modes use SHA-1 key derivation
  and per-object RC4 keys; writing one today would be creating a file with broken cryptography in
  it. Password protection still offers AES-128 and RC4, because those exist so someone can *open* a
  file in software from before 2008.
- **Passwords are held in memory and nowhere else.** The model carries an intent saying *that*
  there is an open password; the passwords live in a private map in the service. A test asserts the
  journal cannot contain one. After a crash the intent replays and the save asks again, saying why.
- **Protection is applied on save, through an undoable command.** Nothing on disk changes when the
  dialog is dismissed, which is what the dialog says and what makes Undo mean something.

### Bugs found while building, and what they were

- **"Remove Security" put the protection straight back.** A document with no recorded intent keeps
  whatever the file already had, which is right — but `{ kind: 'none' }` is *something being asked
  for*, and reading the two as the same thing made the one command that must remove protection
  quietly re-apply it. It has a regression test of its own.
- **The writer was handed encrypted bytes.** M21 asks the engine for the document as it holds it,
  and PDFium keeps the encryption unless told otherwise — so pdf-lib refused every save of a
  protected file with "this version cannot rewrite it". The save now asks for decrypted bytes when
  a stage owns the document's security, which is exactly when the protection will be put back.
- **The reader was asked the same question twice.** M21 warns before saving an encrypted document
  because a rewrite loses the password. With M70 present that warning is either false (it will be
  re-protected) or a second question (the reader just chose to remove it), so a stage now says
  whether it owns the document's security and M21 stays quiet.
- **A certificate-protected document would have been saved in the clear, silently.** It is
  decrypted before PDFium sees it, so from the engine's side it looks unprotected — the truth about
  the tab and a dangerous thing to believe about the file. A public-key file names its recipients
  but does not carry their certificates, so the protection genuinely cannot be reproduced; the save
  now says so in words and asks the reader to choose the recipients again.
- **qpdf's messages carried the name of whatever program was hosting it** — "forks.js: invalid
  password" under vitest, "this.program: invalid password" in the app, because this build ignores
  the `thisProgram` option. Stripped once, where the output is collected, with the filename that
  follows left intact.
- **`--print=high` is not a qpdf option.** We name full-resolution printing after the spec's bit 12;
  qpdf calls it `full`, and the mismatch made it reject the entire command.
- **Every file we wrote was missing its `/ID`.** The spec requires one in any encrypted document
  and pdf-lib will not invent it, so qpdf warned on every stream of every certificate-protected
  file. The document's own id is kept when it has one — a changed id makes a viewer treat the file
  as a different document.
- **The strength meter gave the least useful advice it had.** A password that is a keyboard run was
  told to add a digit, because the generic advice came first. Specific faults now win.

### Shared files touched (PLAN.md §12.3)

- `src/shared/module.ts` — additive: `CommandPermission`, and the optional `CommandSpec.permission`.
- `src/renderer/core/Registry.ts` — additive: `PERMISSION_GATE`, `PermissionGate`, `reasonDisabled`;
  `isEnabled` consults the gate and `run`'s error carries the reason when there is one.
- `src/renderer/app/ribbon/widgets.ts` — additive: a disabled control's tooltip gains the sentence.
- `src/engine/Writer.ts` — additive: `SavePipelineStage`, `runSaveStages` and their types.
- `src/renderer/modules/M21-save/SaveService.ts` — additive: the stage registry; plus the two
  behaviour changes above (the warning, and asking the engine for decrypted bytes). ADR 0012.
- `src/shared/ipc.ts`, `src/main/ipc.ts` — additive: the seven `security:*` channels and
  `file:pickFile`, with their handlers.
- `src/renderer/modules/M11-viewer/ViewerService.ts` — additive: a registered `security` service
  may decrypt bytes before the engine sees them, because PDFium cannot open a public-key file.
- `src/renderer/main.ts`, `src/renderer/index.html` — registers the manifest and its CSS.
- `test/e2e/harness.ts` — additive: `isEnabled`.
- `vitest.config.ts` — coverage gates for the new engine and module files.
- `package.json` — `@neslinesli93/qpdf-wasm` 0.3.0 (wrapper ISC, qpdf Apache-2.0) and `node-forge`
  1.4.0 (BSD-3) as dependencies; `@types/node-forge` as a dev dependency. `npm run licenses` passes.

### Tests

1 664 unit tests and 130 e2e tests, green on Windows locally and in CI on Windows, macOS and Linux.
The M70 e2e suite also passes against the packaged `win-unpacked` build, which is what proves the
wasm survives into the asar and loads from it. The three acceptance tests:

- **AES-256, open + owner passwords, print=none** — qpdf's own `--show-encryption`, run from the
  test process against the bytes actually on disk, confirms `R = 6`, AESv3 and every forbidden
  flag, and refuses the file without a password. The file then opens **in a real Chrome**, which
  asks for the password, accepts it and renders all five pages with no error. Opened in our app
  with the *user* password, the permission-governed commands are disabled and the tooltip reads
  "The document's security settings do not allow printing. Enter the owner password to unlock it."
- **Remove security with the owner password** — `qpdf --check` reports "File is not encrypted" and
  no syntax or stream errors.
- **Certificate protection** — encrypted to a throwaway identity generated by the test, it opens
  with that identity's `.p12` and brings the recipient's own permissions with it; the wrong
  identity is refused as "not one of this document's recipients" and the wrong password as a bad
  digital ID, with no tab left behind either time. qpdf itself cannot read the file at all, which
  is a second check that what we wrote really is the public-key handler.

Underneath those: the whole fixture corpus encrypted and read back, the `/P` bitfield round-tripped
and checked against qpdf for every combination the dialog offers, the revision-6 hash and key
wrapping inverted, the envelopes opened by each recipient and by nobody else, and the certificate
encryption validated stream by stream by qpdf through the swapped-dictionary trick.

### Deferred, and why

- **The Security tab lives in its own dialog** until M72 exists to host it. The panel is already an
  element (`securityPropertiesPanel()`); M72 needs one line.
- **Per-recipient permissions are set for the whole list, not per row.** The format carries them
  per recipient and the writer emits them that way — a reader can already be given different rights
  by two different files — but the dialog edits one set. The row-by-row editor is a table with a
  permissions popover in each row, and it belongs with M81's recipient management rather than
  half-built here.
- **Certificates come from files, not from the OS store.** The brief allows this ("M81's certificate
  service if merged; otherwise file-based"), and M81 has not landed.
- **`security.enforcePermissions` and `security.warnOnWeakAlgorithm` are declared but not yet
  readable from the preferences UI**, which is M130's; the schema is registered and the defaults are
  the honest ones.
- **A public-key file cannot be re-protected without being given the recipients again.** That is the
  format, not the code: the file names its recipients but does not carry their certificates.

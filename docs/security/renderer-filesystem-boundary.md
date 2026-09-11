# The renderer/main filesystem boundary — work to do

**Status: not started.** A first attempt was made on 2026-09-11, found real holes, and was
reverted from `main` before it was pushed. This file records what it found, what is worth keeping,
and what has to be true before any of it lands again. The attempt itself is preserved on the
branch `fix/hardening-review` (its first commit is the original pass; the rest is the review of
it). Nothing here has to be re-derived from scratch.

## Why this is worth doing

The renderer names paths and the main process acts on them. Nothing checks that the reader ever
chose the file. A renderer that is compromised — or simply wrong — can ask main to read or
overwrite anything the user account can reach, through `file:read`, `file:write`,
`file:writeAtomic`, `file:probe`, `file:readFolder`, `file:writeInto`, `file:watch` and
`shell:showItemInFolder`.

How real is it today? Moderate, not urgent. The renderer runs our own code; PDFium parses in a
worker; PDF JavaScript is Parked (`PLAN.md` §1) so a malicious document has no direct script
route. This is defence in depth, and it should be done deliberately rather than at speed.

## What the first attempt got right — keep these

1. **A per-window capability set.** Grants of read/write on a file, and read/write on a folder
   root, held per `BrowserWindow.id` and dropped when the window closes.
2. **Grants come from a user action** — an open or save dialog, a folder picker, a file passed on
   the command line.
3. **Canonicalise before checking, and hand the caller the canonical path.** Handlers must use
   what the check returns, not the argument they were given, or a symlink swapped in afterwards is
   followed anyway.
4. **A real `BrowserWindow` sender is required.** This is what closes `shell:openTempFile`,
   `shell:openExternal` and `shell:showItemInFolder` to anything that is not an app window.
5. **`shell:openExternal` parses the URL** instead of regex-matching it, and allows only
   `http:`/`https:`.
6. **`writeInto()` refuses a symlinked destination, a symlink anywhere in the relative path, and a
   symlinked target file** — the names come from inside a PDF, so "extract all" must not be able
   to write through a link.
7. **Folder search validates its request** (query length, hit and proximity limits, types) before
   it starts, skips symlinks, and stops at a file count and a byte budget.

## What it got wrong — do not repeat these

1. **A path at a filesystem root lost its first character.** Canonicalising a not-yet-existing
   save target rejoined the name with `path.slice(dirname(path).length + 1)`, which is correct
   only while `dirname` has no trailing separator. At a root it has one, so `C:\a.pdf` resolved to
   `ar.pdf` — checked, and written, under the wrong name. Use `basename`, and keep the regression
   test.
2. **The two sides canonicalised differently** — grants through `realpathSync.native`, checks
   through `fs/promises.realpath`. Those disagree on Windows casing and on 8.3 short names
   (`RUNNER~1` vs `runneradmin`), so a grant could fail its own check. Use one resolver, and make
   it the native one. (`fs.promises.realpath` has no `.native`; promisify the callback form.)
3. **Listing Recent granted read _and_ write on every entry.** The renderer populates that menu at
   startup, so every recently-opened document became writable before the reader touched anything.
   Grant on use, never on enumeration.
4. **`settings:path` granted write to `settings.json`.** Its only use is "Show the Settings File".
   Read is enough; write lets the renderer overwrite the file wholesale through `file:write`.
5. **Product behaviour was changed to make tests pass, twice.** `writeInto()` grew an
   `mkdir(base)` so a destination folder need not exist — outside the contract ADR 0014 states
   ("creating the directories on the way", i.e. _under_ the base) and hiding a folder that had
   been deleted or unmounted since it was chosen. And `YNOT_E2E`-only grants were added inside
   `ipc.ts` handlers. Both concessions belong in the harness, visibly, or not at all.
6. **A skipped test was replaced with one that could not fail.** `visual.spec.ts` stopped skipping
   platforms with no baselines and asserted instead that an element exists and has a non-zero
   size. macOS and Linux then reported ten green ticks for assertions nobody had made. If a check
   cannot run on a platform, make it assert something real there — `expectWindowSound` and
   `expectReadable` from `test/e2e/layout.ts` both work anywhere.
7. **Tests built expectations from `tmpdir()` without canonicalising it.** Green on Windows and
   Linux, red on macOS (`/var` → `/private/var`) and red on a Windows CI runner (8.3 short names).
   Canonicalise the temp root at setup with `realpathSync.native`.

## The open question nobody has answered

**How does a dropped file earn a grant?**

This is the part that must be designed before code is written, because getting it wrong reopens
the hole the rest of the work closes.

- `webUtils.getPathForFile(file)` is Electron's replacement for the removed `File.path`, and it
  returns a real path _only_ for a `File` the OS actually handed over. A fabricated object gets an
  empty string. So a path cannot be forged — only asserted.
- But `src/preload/index.ts` exposes a generic `invoke(channel, …args)` gated by an allow-list of
  **channel names, not arguments**. Any code in the page can call any allow-listed channel with
  anything. So a channel that means "grant this dropped path" is a channel that grants any path
  on request.
- The shape that works: the **preload** owns the conversion (a function taking the `File`, calling
  `getPathForFile` itself) and registers the grant over a channel deliberately left _off_ the
  public allow-list. The preload can invoke any channel; the page can only invoke allow-listed
  ones, so that channel is unreachable from page code and a grant can only originate from a real
  dropped file.
- Two things to verify first, both load-bearing: whether `webUtils` is available in a **sandboxed**
  preload (this app sets `sandbox: true`), and whether a `File` survives the `contextBridge`
  boundary intact enough for `getPathForFile` to recognise it.

## What the e2e harness needs

The suite opens every document through `file.openBytes`, which hands over _bytes_ and never a
path — so nothing is ever granted, and seventeen tests that write a **new** file (an XFDF sidecar,
an optimised copy, an extracted subset, a Print-to-PDF output) fail with "File access was not
granted". They are not platform-specific; they reproduce on Windows and Linux alike.

The fix belongs in the harness, not in `ipc.ts`: an explicit, test-only way to say "this staged
path is approved", mirroring what a dialog does — one grant at stage time, named so that anyone
reading it knows it is a test affordance. Widening a `YNOT_E2E` bypass inside the handlers is the
easy version and it hollows out the thing being built.

`export.spec.ts` has the same shape of dependency, and it is still there on `main`: its
`outDir()` helper is commented "a fresh empty folder to export into" and only makes up a name.
Today that works by accident — `writeInto` calls `mkdir(parent, { recursive: true })` for the
relative path, which creates the base along the way. Twelve tests failed the moment the base was
checked before that ran. Have the helper create its own folder as part of this work; it is one
line, and it stops the tests depending on an implementation detail of the thing they exercise.

## Before this lands again

- **An ADR.** This introduces a trust boundary between renderer and main. `CLAUDE.md` requires an
  ADR for a contract change and this is one.
- **Its own branch and worktree.** The first attempt went straight to `main`.
- **A full `npm run e2e`, read in full.** The first attempt ran "a representative test" and its log
  says so. Seventeen failures were hiding behind that. Do not pipe a test run through `tail` — the
  exit status of a pipeline is the last command's, and the failure block is above the cut.
- **Reconcile the totals.** `npx playwright test --list` gives the expected count; a run that
  passes fewer than that is hiding something.

## Separate, and not caused by this work

**Dragging a PDF onto the window gives it no path at all.** `src/renderer/app/shell.ts` does
`path: withPath.path ?? f.name`, and `File.path` was removed in Electron 32 (this repo is on 44,
with no `webUtils` anywhere). So the path becomes the bare filename. `SaveService.save()` diverts
to Save As only when there is no path, and `'report.pdf'` is truthy — so Save takes the overwrite
route and writes to a relative path, which Node resolves against the main process's working
directory. **Today that means Save silently writes the document somewhere other than where it came
from, and reports success.**

This predates all of the above. The capability work turned it into a loud refusal, which is
better. The one-line honest fix, independent of any capability work, is to stop substituting
`f.name` and leave the path empty: Save then routes to Save As, which is correct today and needs
no new trust. Owned by M00 (shell) and M21 (save).

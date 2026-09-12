# Open work, 2026-09-11

**Current status — 12 September 2026:** Sections 1–11 below preserve earlier investigations. For active audit repairs, verification and worktrees, start at section 12. Findings 1–12 merged in PRs #51–54; #23 was fixed by PR #49. Remaining audit repairs are not yet merged. The Review PDF editor plan task owns the current module trackers, UI test lease and serial merges.

Everything left unfinished on the night `main` was restored to `f1034ba`. Written down because
five branches and six worktrees are more than anyone should have to reconstruct from memory.

The security work has its own file — [`docs/security/renderer-filesystem-boundary.md`](security/renderer-filesystem-boundary.md).
This one is everything else.

## Nothing here is only on a disk

Every branch named below is pushed to GitHub. The restore is `git reset --hard origin/main` in the
primary checkout, which moves one local branch and touches nothing else: not another worktree, not
another branch, and nothing on the remote. `origin/main` was never moved.

## 1. The macOS flake — the oldest open item

**Branch: `fix/macos-e2e-flakes`. Not merged. This is the one to land first.**

It carries three fixes, all with tests that fail on the old code:

- **`ThemeManager` saved out of order.** Its setters fired an unawaited `persist()`, so two changes
  close together raced, and `load()` — which every settings write calls, because
  `PreferencesService.apply()` reloads every service — could read a store that had not caught up
  and put the old value back on screen. In Tony's hands: set the interface scale back to 100 % and
  it stays at 150 %. Saves are chained now and `load()` waits for them.
- **Two `panels.spec.ts` tests assumed a document opens at page 1.** M11 remembers where you left a
  document _by path_, and every test in that file opened `C:/fixtures/<name>`, so the second test
  to open `multipage.pdf` started where the first finished. Reproduced on Windows in one run. Each
  open gets its own path now.
- **`worker.test.ts` slept 5 ms** waiting for a render to start — fine idle, nothing under a
  parallel suite. Polled now.

**What it does _not_ fix, and this matters:** `preferences.spec.ts:232` — "the UI scale applies
live" — still failed on macOS CI _with_ the `ThemeManager` fix in place. The ordering bug was real
and is fixed, but it is **not** what that test is hitting. The cause is still unknown. That test is
the thing that started the whole night and it is still open.

There is overlap to check before landing: `fix/shared-fixture-paths` (worktree `../ynotPDF-paths`)
appears to be another session on the same shared-path class of bug. Reconcile the two rather than
merging both.

## 2. The visual ratio is unmeasured

**On `fix/post-restore`.** `maxDiffPixelRatio` is 0.04, down from 0.15 at Tony's instruction.
`threshold` stays at 0.35, which is the knob that absorbs antialiasing.

0.04 is reasoned, not measured. The 3 % figure it was argued against was taken at the old default
threshold of 0.2, so nobody knows the real cross-machine number at 0.35.

**Only the GitHub Windows runner can settle it.** The only baselines committed are `win32` ones and
they were seeded on Tony's machine, so a local run compares his pixels against his own and is green
at 0.04 and at 0.0004 alike. If CI fails there, Playwright prints the actual ratio and that is the
measurement — move to just above it. This is written in the file next to the constant, because the
obvious thing to reach for is a local run.

## 2b. Visual baselines exist for one platform only — M04's, to fill in

Nine of the ten screens `visual.spec.ts` compares are only ever compared on a single Windows
runner. There are no macOS or Linux baselines at all, so on those platforms the spec skips.

The skip is the honest part and should stay until this is done: a platform with no baselines says
so, rather than reporting green for a comparison it never made.

Seeding the missing ones is awkward on purpose. A baseline has to come from the machine that will
later compare against it, and the only macOS and Linux machines here are CI runners — so
generating them inside the same run that checks them would be a run grading its own homework,
which is the dead-assertion failure mode this repository has already been bitten by once. The
shape M04 proposes is a `workflow_dispatch` job that runs with `--update-snapshots=all`, uploads
the PNGs as an artifact, and leaves a person to commit them.

There is a decision inside it — how a baseline is regenerated when the interface legitimately
changes, and who may bless a new one — so it wants Tony's eye and a line in a brief rather than a
quiet commit. **M04 owns this.** Its detail follows.

**What "regenerating a baseline" has to answer.** Three things, and the middle one is the
decision:

1. _Where the image comes from._ A `workflow_dispatch` job running `--update-snapshots=all` on
   each of the three runners, uploading `test/e2e/visual.spec.ts-snapshots/` as an artifact. It
   must never run as part of the ordinary CI job: a run that writes the baseline it then compares
   against is grading its own homework, which is the same failure the removed assertion had.
2. _Who may bless one._ A baseline changes for two completely different reasons — the interface
   legitimately changed, or it broke. The image cannot tell you which. So a regenerated baseline
   needs a human to look at the before-and-after and say which it was, and the commit that lands
   it should say so in words. This is Tony's decision to make, not a rule to infer.
3. _What happens on the day it is wrong._ Committing a bad baseline is silent: every later run
   agrees with it. The protection is that regeneration is deliberate and reviewed, never
   automatic — which is why the dispatch job must not be wired to anything that runs on its own.

Until that exists, the skip stays and is the honest thing: a platform with no baselines says so
rather than reporting a comparison it never made.

## 3. The window flash — ruled out of the e2e suite, cause still unknown

Tony sees the outline of a window flash up, every now and again, while an e2e run is going.
**It does not come from the suite's own window lifecycle, and there is no fix here.**

**The evidence.** `src/main/windowProbe.ts` records every window created, shown, hidden,
maximised, restored, focused or taken full screen, with its position and whether it was visible.
Two full runs were recorded. In a complete run of 546 tests on unmodified `main`, **no window was
ever both visible and on a real display** — 129 events, every one of them either not visible or
parked at -16384,-16384. The full-screen transition, the obvious suspect, stays off-screen at
opacity 0.

**What was tried and withdrawn.** Two causes were argued from reading the code — `maximize()`
showing a window before opacity was applied, and full screen dragging a parked window onto a
display — and changes were written for both. Both are wrong, and all of it has been reverted:

- The "conclusive" probe evidence for the second one (a window maximised to 1934x1046 at -7,-7 and
  focused) was **the guard test doing it**, not the product. A test that maximises a window shows
  up in a probe as a window being maximised.
- The fix for the first was never in the build: an edit silently failed to apply, so the set
  recording which windows were parked stayed empty and the guards never ran once. The "fix" was
  never under test at all.

**What is left, and why.** The probe, as an opt-in diagnostic, because a visual event this rare
cannot be caught by watching for it:

```bash
YNOT_WINDOW_PROBE=/tmp/windows.log npm run e2e
grep -v 'bounds=-' /tmp/windows.log | grep 'visible=true'
```

A run where that prints nothing is a run where no window reached the screen. And one guard in
`app.spec.ts` pinning what `CLAUDE.md` actually promises — a run's window is off-screen and
transparent — which is true today and would fail if the parking treatment were removed.

**Where to look next.** Several sessions run e2e suites on this machine at once, and the probe only
sees its own. A run started with `YNOT_E2E_VISIBLE=1`, or any launch outside the e2e path, shows
its windows by design and nothing in `window.ts` would stop it. That fits the symptom — occasional,
brief, invisible to instrumentation — better than anything in this section. Worth ruling out before
anyone changes window management again.

Two details noticed on the way, neither a defect: Windows clamps the requested `x: -32000` to
-16384, so the number in the source is not the number in effect; and a window exists briefly at its
on-screen default position with opacity 1 before it is parked, though it is `show: false`
throughout and nothing shows it there.

**Settled on the way: parking is Windows-only now.** The guard added here caught, on its first CI
run, that macOS does not honour an off-screen position at all — it clamps the window back into the
visible frame, and a window asking for -32000,-32000 reported `0,31`: full size over the desktop,
hidden only by its opacity, and still taking mouse clicks.

The fix was not to fight the OS. Parking exists for one machine — Tony's Windows PC, which he
works on while a suite runs. The macOS, Linux and ARM runners have nobody in front of them, so a
window on screen there interrupts no one (Tony, 2026-09-11). `parkOffScreen` is now
`hidden && process.platform === 'win32'`, which is what it always meant, and the macOS problem
stops existing rather than needing a workaround. The click-through call written for it has been
removed with it.

## 4. Dropped files have no path — a real product bug

Not caused by any of tonight's work, and owned by **M00** (`src/renderer/app/shell.ts`) and **M21**
(`SaveService`). Neither session touched it.

`shell.ts` builds a dropped file's path as `withPath.path ?? f.name`. `File.path` was removed in
Electron 32; this repo is on 44 and `webUtils.getPathForFile` appears nowhere. So the path becomes
the bare filename. `SaveService.save()` diverts to Save As only when there is no path, and
`'report.pdf'` is truthy — so Save takes the overwrite route and writes to a **relative** path,
which Node resolves against the main process's working directory.

**So: drag a PDF in, edit it, press Save, and it is written somewhere other than where it came
from, and reported as saved.** Thirty seconds to reproduce.

The one-line honest fix is to stop substituting `f.name` and leave the path empty — Save then goes
to Save As, which is correct today and needs no new trust. The proper fix needs the grant design in
the security file, because a path asserted by the renderer is not a path main can trust.

## 5. Branches and worktrees to clear up

`CLAUDE.md`: a finished module leaves no folder behind. Tonight left a lot of both.

**Delete when the work above has landed:**

| Branch                                         | What it is                                                                                                                                    |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `stress/mac-1`, `stress/mac-2`, `stress/mac-3` | throwaway copies pushed to get four parallel CI samples; the workflow cancels same-branch reruns, hence three extra branches. No unique work. |
| `probe/audit-only`                             | the experiment that settled whether the audit or the review broke seventeen e2e tests. Answer: the audit. Confirmation only now.              |
| `backup/pre-reword` (local only)               | the pre-rewording form of the audit commit, kept while its message was corrected.                                                             |

**Keep until merged:** `fix/post-restore`, `fix/macos-e2e-flakes`, `fix/shared-fixture-paths`,
`mod/M53-headers-bates-watermarks-links`.

**Gone:** `fix/hardening-review` and `backup/pre-reword` were deleted at Tony's instruction on
2026-09-11. The first held the reverted hardening pass and the review of it; the second held that
commit's original message. Nothing of either survives, so
[`docs/security/renderer-filesystem-boundary.md`](security/renderer-filesystem-boundary.md) is the
entire record of that work rather than a pointer to it. Written while the code was still in front
of someone, which is why it is as specific as it is.

**Worktrees:** `../ynotPDF-review`, `../ynotPDF-macfix` and `../ynotPDF-post` are finished with once
their branches land. `../ynotPDF-M53`, `../ynotPDF-paths` and `../ynotPDF-fs` belong to other
sessions — leave them alone.

## 6. Two habits worth keeping

Both of these cost real time tonight.

**Never pipe a test run through `tail`.** The exit status of a pipeline is the last command's, so a
run with seventeen failures reports `exit 0`. The failure block sits above the cut, and the summary
line that survives looks like a pass. It fooled two sessions independently within an hour.

**Reconcile the totals.** `npx playwright test --list` gives the expected count. A run reporting
fewer passes than that is hiding something — 546 listed against 525 passed and 4 skipped was
seventeen failures in plain sight, and neither of us saw it until the arithmetic was done.

**"The suite passed" is a claim about a commit, not about a folder.** M04 ran a full suite bare,
read the exit code directly, reconciled it against `--list` — every control sound — and pushed a
tree missing an uncommitted change, so the run it trusted tested something it never shipped. The
same shape caught me an hour earlier: an edit silently failed to apply, so I spent an hour testing
a build my fix had never reached. `git status` before a push, and if it matters, run from the
pushed SHA. Neither the pipe rule nor the count check touches this one: both of us verified
honestly, and verified the wrong artefact.

**`jq` is not on this machine's PATH.** A shell pipeline that calls it fails silently in a
background watcher, so a "monitor" armed against CI can sit there reporting nothing while
everything it was meant to catch goes past. It cost M53 a whole run's worth of watching. Use
`gh`'s built-in `--jq` flag instead — `gh run view <id> --json jobs --jq '...'` — which needs no
external binary.

## 7. Every PDF we generate is non-deterministic, and six places still are

`PDFDocument.create()` leaves pdf-lib to fill `CreationDate` and `ModificationDate` from the wall
clock at save time. Those live inside a **deflate-compressed object stream**, so two otherwise
identical documents saved a second apart do not merely differ — they come out **different
lengths**. Measured here: one unchanged document saved at 575, 576 or 577 bytes across 120
consecutive one-second timestamps.

That is what CI kept reporting as `expected 1667 to be 1666` on `shortcuts.test.ts`. It was read as
a macOS problem for most of a day. It is not: macOS is simply the slowest runner in the matrix, so
it is the one whose two builds are most likely to straddle a second. Fixed for the cheat sheet by
stamping the sheet's own date into the document metadata — a sheet built for a given day is now the
same file every time.

**Still open, six call sites:** `stampPdf.ts`, `pdfium/decorations.ts`, `printToPdf.ts`,
`M42-portfolios/cover.ts` (twice) and `M42-portfolios/merge.ts`. None is failing today, because no
test asserts byte-identity on their output — the exposure is latent, not live. It becomes live the
moment anyone writes a reproducibility test, caches output by hash, or asks why saving the same
document twice gives two different files. Owned by M10 (engine), M13 (print) and M42 (portfolios);
each wants a deliberate choice about what date a generated document should carry, not a blanket
edit from here.

## 8. Cancelling a password prompt used to write the file in the clear

Codex's audit of 11 September 2026 (`Codex_Audit.md`, finding 1) found the one defect in this
repository that could quietly hand someone an unprotected copy of a protected document.

The path: recover a document whose journal carries a password-protection intent, save it, and
cancel the prompt asking for the password no longer held in memory. `secretsForSave()` returned
null, the stage returned the plaintext it had been given, and `SaveService` wrote it — reporting
success, with a warning that **nothing displays** (finding 2, still open).

The old code's reasoning is in the test it shipped with: _"The document is still saved — losing
the reader's edits would be the worse failure."_ That trade was never real. Stopping the save
loses nothing: the edits stay in the model, the document stays dirty, and its recovery record
stays on disk. Writing the file in the clear was a real loss, and a silent one.

**The fix.** Cancelling a prompt throws `WriteCancelled` — the type the pipeline already used for
an aborted save — which unwinds before the writer's bytes reach `writeBytes()`. So no file is
written, `markSaved()` is not reached, the recovery record is not discarded, and `writeTo()`
reports `reason: 'cancelled'` with a toast rather than an error dialog. Cancelling is a choice,
not a failure.

`null` is kept for the one case that is _not_ a cancellation: an intent naming no password at
all, where nobody was asked anything and there is nothing to protect the file with. That still
saves unprotected, and now says so in words that match what happened.

**A half-given answer is deliberately forgotten.** Cancelling the second of the two prompts
throws away the first. Keeping it looks kinder, but secrets are stored only once both prompts are
answered, and the check that skips the prompts treats _any_ held password as the complete set —
so half an answer left behind would protect the next save with the open password and silently
without the permissions one. Asking twice is the cheaper mistake, and there is a test saying so.

**Found on the way:** `runWriter()` declared its `progress` binding _after_ starting the writer,
while `onProgress` closed over it. Any writer reporting progress synchronously — the in-process
one, which runs wherever there is no `Worker` — hit the temporal dead zone and threw "Cannot
access 'progress' before initialization" instead of saving. Latent in the shipping app, because
the worker's progress always arrives asynchronously; fatal to any test that drives a real save.
Declaration moved above the call.

**Follow-up from the same audit, now addressed in section 9:** finding 2 — `SaveOutcome.warnings`
is collected after the document is marked clean and its recovery record discarded, and no ordinary
Save path displays it. Until that is fixed, a warning is still a value nobody reads.

## 9. Save warnings now require a decision before writing

Codex audit finding 2, implemented on `fix/save-warning-review`, on top of finding 1's
`WriteCancelled` handling. Plan warnings are shown before engine/writer work; new writer and
pipeline warnings are shown before the filesystem write. A persistent, opaque dialog names the
destination and lists the warnings as text. Cancel is the default button and Escape result.

Choosing **Save with these warnings** explicitly permits writing that result. The document stays
marked unsaved and existing recovery records are retained, because string warnings cannot reliably
distinguish an optional optimization from an omitted edit. Closing after this write does not discard
the model automatically. A subsequent warning-free save can mark it clean, or Tony can explicitly
choose Don't save on close. ADR 0021 records this policy and its limits; the separate recovery-base
and revision findings remain open.

Regression tests first produced six failures against the previous implementation, with the
warning-free control passing. The service tests cover both decision points, cancellation, retention,
close and Save As. UI tests cover the actual ribbon Save action and the certificate-protection-loss
warning, checking the destination remains unchanged until consent. New dialog wording is in the
i18n catalogue. Validation results and merge status are recorded with the PR; this note describes
the implementation, not a claim that all audit findings have been resolved.

## 10. Certificate recipient permissions survive ordinary Open and refresh

Codex audit finding 3, implemented on `fix/certificate-permissions`, based on finding 2's branch.
M70 now retains the opened source policy independently of plaintext working bytes. M11 carries
the selected recipient's permissions into M20's pre-attachment hook, before commands can observe
the tab. Session authority distinguishes recipient access from a verified owner password; modify
permission cannot grant copying or printing, and omitted recipient permissions fail closed.
Refresh, including an inspection already in flight, cannot replace that captured policy.

The ordinary-Open UI test found an additional gap: M13 print and copy paths did not consult the
permission gate. Their command declarations and output callbacks now do. Contextual Copy still
works in ordinary text inputs. Properties reports the source's certificate protection and recipient
rights. Password unlocking is unavailable for certificate sources. Source envelope identities
are not mistaken for certificates usable for re-encryption, so finding 2's pre-write warning remains.

ADR 0022 records the design and scope. Six initial regressions failed before the fix; tests also
cover pre-attachment ordering and the real two-recipient Open flow. Local and CI results belong
in the PR. M92's export-permission mapping (finding 21) and other audit findings remain separate.

## 11. Save and recovery integrity (Codex audit 4–12)

Findings 4–12 are implemented on fix/save-recovery-integrity, with ADR 0023. Security commands
restore both the intent and in-memory passwords on undo/redo. Saves and autosaves share a queue
per document; engine/model snapshots use a command read barrier and a mutation revision. A stale
save cancels before writing, or retains dirty state if edits arrived during the filesystem write.
Save As updates the model and tab path and stops the previous watcher.

Recovery v2 checkpoints the current engine, model, ID bindings, writer provenance and portfolio
blobs. It never replays the session journal against already-saved bytes. SHA-256 addressed binary
inputs are published before the atomic manifest, verified on read, and collected after they cease
to be referenced. Pathless dirty documents with no journal are recoverable. Recovery retains its
record until save/discard; another crash still offers it. The viewport is attached after restoration.
Normal saves retain undo history; recovered sessions start a fresh undo history while keeping all
checkpoint edits and write intents. Legacy v1 journals lack a trustworthy base and are retained for
manual recovery, with an explicit message, rather than risking double application.

Finding 11 moved into this batch because it shares the recovery boundary: initial fingerprints
come from the exact opening buffer and cover the whole file. A changed/unknown destination yields
a pathless recovery copy. Finding 12 also moved forward: checkpoint publication depends on atomic
writes. Short writes loop, flush failures propagate, and all failed paths clean up their temp file.

Regression evidence includes real PDFium/writer recovery cycles, undo past Save and branching,
annotation identities, portfolio replacement/addition/cover bytes, a pathless zero-command document,
missing recovery binaries, concurrent saves, and filesystem fault injection. The built app's test
survives Save/edit/two process crashes, renders the recovered document and retains recovery until
saving. Full verification and the final commit/CI status are recorded in the PR.

Findings 1–3 were merged as PRs 51, 52 and 53 on 12 September 2026 after all platform checks passed.
Tony has authorized completing every remaining audit finding and merging the verified fixes.

### PR 54 final validation follow-up

The full UI run exposed a lazy annotation read that completed after its page was removed,
republishing an orphan annotation. Document.loadAnnotations now checks that the document is
still open and the page still exists at the same engine binding before publishing. A deferred
engine-read unit regression covers delete/read-completion/undo/reload; all 52 document tests
and all 22 document-operation UI tests passed locally after the fix.

The original 249fe88 full local run was 547 passed, 6 skipped, 4 failed. Three failures were
clipboard reads: even a direct Electron main-process writeText/readText and ClipboardItem
write/read probe returned empty data on this desktop. Those same clipboard tests passed in
the Windows CI run. No clipboard assertions or skips were weakened. The fourth was the
annotation race above, also reproduced in CI. CI additionally reported thumbnail navigation
and narrow ribbon interaction failures that require review on the updated commit.

## 12. Remaining audit repairs — active checkpoint, 12 September 2026

This is an in-progress handover, not a completion claim. Worktree:
D:\Projects\ynotPDF-audit-rest, branch fix/audit-remaining, based on 9982f5b.
All changes for findings 13–25 are currently uncommitted. PR 54 for findings
4–12 remains open; macOS/Linux checks and one Windows check passed, with
remaining Windows/ARM checks running at this checkpoint. Do not merge until
all required checks pass. Findings 1–3 are merged; 23 was fixed upstream in PR 49.

Implemented and under verification:

- 13: Combine refuses catalog-dependent forms, names, layers and tags whose
  structures cannot yet be preserved. Unit tests cover refusal and unchanged sources.
- 14–16/18: per-window canonical filesystem grants, native selection/recent-open
  authority, runtime filesystem request validation, exclusive numbered extraction,
  linked-folder rejection, and native confirmation with an attachment type allowlist.
  The E2E harness stages authority through a main-process-only test hook; there is no
  renderer grant channel or product-handler bypass. Dropped files remain pathless.
- 17: shared rich-text input/output allowlist sanitisation.
- 19: composite command rollback and an integrity latch after failed rollback.
- 20: engine readiness and pending requests settle on failure/shutdown; five other
  worker clients reject pending/future requests after terminal failure.
- 21: all content exports require copy permission, including recipient restrictions.
- 22: shared authenticated Open/recovery/reload helper. Protected recovery acceptance
  tests remain to be completed. ADR 0026 records certificate checkpoint limitations.
- 24: real SPDX expression parser and conjunctive array policy; packaged binary/font
  notices and an artifact inventory gate remain unfinished.
- 25: cross-platform geometry/contrast/focus checks at three scales and four themes.
  Windows pixel baselines remain; absent macOS/Linux pixel baselines are explicit skips.

Latest local evidence: full unit suite 4,118 passed / 24 skipped with coverage gate
passing, typecheck passed, and all 12 new visual layout checks passed. The full UI
suite is still running. Its folder-search case exposed missing explicit fixture-folder
staging in the harness; two search tests now grant that folder and need a targeted rerun.
Counts apply to the working tree at each run, not an as-yet nonexistent final commit.
Logs are outside the repo in:
C:\Users\tonyb\Documents\Codex\2026-09-11\d-projects-ynotpdf\work\

Before completion: finish protected recovery and hostile-note/combine UI regressions;
finish packaged notices; review capability escalation and extraction failure paths;
resolve full UI failures; update each original audit finding without deleting Claude's
comments; distinguish findings 26–31 assessment notes from unbuilt product modules;
run final checks on committed state, push, wait for CI and merge. Preserve original
and Claude worktrees. Remove only our safely merged worktrees/branches afterwards.

Coordination: Tony's Review PDF editor plan task owns PLAN.md/future-module brief
corrections and four independent worktrees (M11 Fit Visible, M13 vector printing
appearances, M41 crop aspect ratio, M92 CCITT G4 TIFF). This audit task owns the shared
contracts/ADRs 0023–0026, filesystem IPC, authenticated opening, worker clients,
permissions, combine policy, audit notes and open-work. Coordinate shared test harness
changes and serialize full local UI runs/merges with that task.

### Checkpoint update — PR 54 merged

PR 54 merged on 12 September 2026 at 07:19 UTC as
`d322de7b43070979fac5ff586a16e39ddbda4d47`, after all eight CI jobs passed,
including both ARM installer smoke checks. Findings 1–12 are now merged.
The remaining repair work above is still uncommitted and incomplete.

The full remaining-audit UI run ended with 545 passed, 4 skipped and 10 failed.
Nine creation/import cases and one folder-search case lacked explicit fixture-folder
access staging. After correcting those test setup grants, all 58 create/search/print
UI tests passed (33.8 seconds). The separate 12 geometry/contrast/focus checks passed.
No UI process from this audit task remains active at this checkpoint. A final full run
on the completed, committed repair state remains required.

### Tony's visual review preference — 12 September 2026

Tony explicitly welcomes stronger end-to-end tests and actual screenshot inspection
of the running application, to catch problems before he meets them. Capture synthetic
fixtures only, retain useful evidence, inspect the images (not just their existence),
and turn confirmed defects into regression tests. Cover themes, UI scales, panels,
dialogs, keyboard focus and real save/reopen workflows. Keep test windows hidden.

The expanded visual-layout suite captures start/focus, a document with both panels,
and Preferences across four themes at 100/150/200 percent. Initial run: 8 passed,
4 failed; all four 200-percent cases exposed clipped Ready status text. Visual inspection
also showed zoom and theme controls overlapping at 150 percent. Statusbar CSS now
wraps controls to available space and gives the zoom field sufficient width, pending
focused rerun and inspection of the resulting screenshots. CI retains these PNGs for
seven days even on passing jobs. No pixel-baseline tolerances were relaxed.

### Visual review result — status bar correction

The corrected statusbar passed all 28 focused UI tests: 12 theme/scale captures,
6 existing window/scale tests and 10 existing Windows screenshot comparisons
(50.7 seconds, exit 0). Existing pixel baselines and tolerances were unchanged.
Build and focused ESLint passed. These are local working-tree results, not a final
merged/CI claim; the statusbar and test changes remain part of the unfinished audit batch.

Actual images inspected before/after: Midnight document/panels at 150 percent,
High Contrast document/panels at 200 percent, and Daylight Preferences at 100/200
percent. The zoom/theme overlap is gone, Ready and Fit width are fully visible,
and the right status controls use a second row when necessary. Preferences remains
opaque, with visible focus and a reachable Close button; its long content scrolls.
The synthetic comments fixture deliberately includes overlapping markups; those
are document content, not a newly introduced shell layout fault.

Successful captures live outside the repository under the review work folder:
`visual-review-fixed-results/visual-layout-visual-layou-f76b7-nces-readable-and-reachable/document-and-panels.png`
(Midnight 150 percent),
`visual-review-fixed-results/visual-layout-visual-layou-66c6b-nces-readable-and-reachable/document-and-panels.png`
(High Contrast 200 percent), and
`visual-review-fixed-results/visual-layout-visual-layou-55c9f-nces-readable-and-reachable/preferences.png`
(Daylight 200 percent). The suite captured 36 distinct views; only representative
images were individually inspected, not every captured image.

Additional open visual finding: M92's independent screenshot review exposed native
select text truncation at 200 percent in Format, black-and-white method and TIFF
compression. I inspected its high-contrast image and confirmed the clipped choices.
Coordinator has this follow-up; standard scrollWidth checks miss native select text.
An opt-in native-field width regression and M92 layout/label repair remain required.
Do not mark this issue resolved on the strength of existing geometry tests.

Fit-label follow-up: all 12 theme/scale cases passed again (17.8 seconds, exit 0),
now measuring each real Fit page / Fit width / Fit visible label in the input's
computed font against its available content width. Focused ESLint passed. The
200-percent High Contrast Fit visible screenshot was individually inspected and
shows the full label. Evidence is in visual-fit-label-results, matching the other
capture paths above, under fit-visible-label.png. This validates the label layout,
not M11's separate fit geometry/raster repair; that remains owned by the M11 task.

### Independent UI repair branch

The screenshot-led statusbar fix and stronger visual-layout checks have also been copied
into a small independent worktree, D:\Projects\ynotPDF-ui-review, branch
codex/ui-readable-controls, based on origin/main at 214f7f4. That branch contains no
unfinished security/recovery audit code. It adds short M92 native choice labels with
dynamic wrapping explanations and a grid that stacks with UI scale; enum values and
permission gates are unchanged. A reusable opt-in native-field text-width test catches
what scrollWidth misses. It is exercised against a narrow select and the actual old
long TIFF label, temporarily restored in the real dialog.

Initial independent results: 26 UI tests passed, 165 export unit tests passed, full lint
(including typecheck/styles/i18n) and build passed. Group4 screenshots from all four
200-percent themes were inspected and show full choice/explanation and reachable footer
buttons. Upper Format/Method captures are queued behind coordinator's local UI lease,
then this small branch should be committed/pushed for CI. PR63 is not yet merged;
Original/PNG option integration verification must follow it. Keep this dependency explicit.

Use C:\Users\tonyb\AppData\Local\Temp\ynotpdf-ui-slot.json before any local Electron
run. Only coordinator task 01a09469-799c-7d20-8cc5-168ca554d892 assigns the lease;
ownerThreadId must match this task 01a08f69-dfd6-71c0-a622-badd897cf217. Notify release
after actual process exit. CI runs are independent. Do not overwrite coordinator PLAN
or CHECKLIST changes. Once the UI PR merges, integrate it back into audit-rest and resolve
its duplicate uncommitted statusbar/visual-layout changes to the improved implementation.

UI PR #65 is now pushed at 6cececa on codex/ui-readable-controls, clean worktree.
Final upper Format/Method captures passed with five focused tests; High Contrast 200%
images were inspected. Coordinator independently reviewed all three HC sections and
will serialize merge after required CI. No local UI process is active; lease released.

### Additional audit regressions — 12 September 2026

Extraction now removes its exclusively created partial leaf after write/close failure,
without removing an existing collision. A fault-injected disk-full test writes partial
bytes before throwing, proves the original survives, and retries the same numbered name.
39 focused filesystem tests passed. Required folder-search options are validated too.
Settings-path escalation through recent:add, recent:open and window:new has E2E assertions.

Two new security UI cases exercise actual crash/restart: wrong standard password then
Cancel must keep recovery, retry must restore edits and restrictions; certificate working
checkpoints must restore recipient rights without owner authority. Both assert that a
remembered JSON source path grants no filesystem authority and recovery stays pathless.
Added imported hostile /RC note and Combine form-catalog refusal cases. Typecheck and
focused ESLint pass; build passes. Six focused UI tests are queued behind M41's lease;
these new E2E cases have not run yet. Coordinator owns the lease file.

Audit 24 evidence: installed @hyzyla/pdfium/dist/pdfium.wasm is byte-identical to
pdfium-lib release7243 release/node/pdfium.wasm, SHA256
71aec412a303a0405baee21c3d6d3f30ad2033dc02444130fe476be3976e2d09.
Downloaded archive SHA256 efd95da1a8fcf162e63639176b57d9e60fb01b301d740d949f40365522d9eaf5.
Archive stored outside repo in work/pdfium-7243-wasm.tgz and contains no license notices.
Upstream tag7243 modules/config.py selects PDFium chromium/7243 and Emscripten4.0.10;
current branch SHA591ce25a21001d8c26888e8b3af5426e90585dbe. This proves the binary
release match, not reproducibility from today's branch tip. Build defaults disable V8,
XFA and partition_alloc. Qpdf-wasm0.3.0 pinned gitHead's Dockerfile was READ ONLY (no
Docker run): qpdf856d32c610334855d30e96d25eb5f9636fb62f08, zlib21767c654d31d2dccdde4330529775c6c5fd5389,
jpeg-turbo7aa2a898c564041a24b09d0a6e780aaa632d08d3, Emscripten3.1.74.
Artifact inventory/notices gate is still NOT IMPLEMENTED. Coordinator notified of possible
minimal electron.vite.config.ts/electron-builder.yml/package scripts changes; no shared
build-config edits yet. Do not claim #24 complete from parser tests alone.

### Verification and release-gate checkpoint — 12 September 2026

PR65 is pushed at69b77d3b826b1df516979e06e56b2ae0aed77441 after merging M11's
main2696119. Full lint/build and331 view/export unit tests pass. All32 focused
visual/layout/FitVisible UI tests passed38.5s exit0; lease released to coordinator.
Final platform CI/merge is still pending. Do not independently merge; the central
Review PDF editor plan task owns serial merges, assignments and all local UI leases.

The broad audit branch full unit run passed4126 tests,24 skipped, coverage gates pass
(exit0,49.68s with two workers). Full lint also exited0. Six focused security/boundary/
rich-note/Combine cases are now passing: initial4/6, then2/2 after correcting the test
fixture filename and the dev recovery result shape. These were test setup corrections,
not production failures. Unknown-sender/auxiliary-window/child-frame IPC unit tests pass.

Actual rich-note screenshot inspection exposed poor contrast for valid authored dark
colours. The note editor now defaults to readable theme colours, with a checkbox for
viewing original colours; original inline colour attributes remain in the saved fragment.
A strengthened one-case UI test cycles four themes, toggles the display mode, saves and
checks the real PDF /RC. This final variation is built/queued but has not run yet.
Screenshot path from before the readability fix:
work/audit-security-ui-results/annotations-untrusted-rich-26676-roduce-interactive-elements/sanitised-rich-note.png.

Audit24 technical changes are now implemented: actual Vite build-input manifests for
main/preload/renderer/workers include bundled dev dependencies such as Lucide, increasing
the gate from44 production packages to45 runtime/bundled packages. Downloaded fonts and
opaque PDFium/qpdf artifacts have pinned hashes. out/notices is included by the existing
packaging pattern. npm run licenses:release deliberately exits1 for four known incomplete
wrapper/compiled-component notice reviews; ordinary development builds print these blockers
and never report releaseReady. See docs/security/artifact-notices.md. No complete compiled
SBOM or distribution-rights conclusion is claimed. Those prerequisites belong to M131.
The strict gate was actually executed and rejected the current missing reviews;16 focused
inventory/SPDX tests pass. Shared build configuration changes are coordinator-approved.

Codex_Audit.md now has a resolution note for every numbered section, preserving original
text and every Claude comment. Historical handovers have current-status banners. The
remaining audit source is STILL UNCOMMITTED pending the one-case M30 verification, then
checkpoint commit, integration of current main/mergedUI, final full checks, PR/CI and serial
merge. PR66 carries a coordinator-owned fix for nonreentrant PDFium page-hash tests;
consume it via main rather than duplicating it. M91's long Page select label is a recorded
visual follow-up after its import branch merges; no fix yet. Original/PNG export option
verification remains dependent on PR63.

M30 final focused UI case passed (1/1,3.0s,exit0). It measures contrast in all four
themes, toggles original/readable colours and verifies preserved colour in the saved
PDF /RC. Its first run exposed a test assumption about PDFString versus PDFHexString;
both valid PDF string encodings are now handled. Final High Contrast screenshot was
individually inspected: note words and checkbox are readable and Save/Cancel accessible.
Evidence: work/audit-note-readable-final-results/annotations-untrusted-rich-26676-roduce-interactive-elements/sanitised-rich-note.png.
No UI process remains active; coordinator has the lease again.

The duplicate uncommitted statusbar/visual-layout/CI screenshot changes were removed from
this audit branch because they are already preserved in the independent PR65 branch.
Consume that PR through main once merged; do not duplicate its implementation here.
The broader audit checkpoint therefore covers13–24 plus assessment/handovers26–31;
#25 is tracked by PR65. A final integrated full UI run and exact-head CI remain required.

### Independent review follow-up � 12 September 2026

Broad audit checkpoint8b8c179 is committed. Current main2696119 merged cleanly as3a08319;
its full lint/build passed and4241 unit tests passed,24 skipped, with coverage gates
passing. Follow-up4af6a7f resolves indirect MarkInfo flags before Combine's preservation
check;32 Combine unit tests passed and the build passed afterwards.

The coordinator found two additional review blockers, now repaired locally pending final
verification/commit: attachment name truncation could change an approved .pdf suffix into
.ps1/.cmd/.exe, and worker messageerror/malformed envelopes could strand callers. Main now
validates the exact stable sanitized basename and passes it unchanged to the temp writer.
Three extension regression cases failed before the repair; the registered IPC test also
asserts rejection before confirmation, writing or opening. No executable was launched.
All six audited worker clients settle decoding failures, validate transport envelopes before
dispatch, remove listeners on stop and handle cancellation-post exceptions. Focused tests
cover current/future callers and engine readiness before/after startup. ADR0024 records the
minimal shared transport helper; it does not claim deep validation of PDF result contents.

Full lint and units are running in audit-review-followup-{lint,unit}.log under the external
work directory. A final build, coordinator review and broad PR/CI remain pending. PR65 stays
frozen at69b77d3 awaiting CI and the coordinator's serial merge. No local UI is running or
allocated to this audit task. Request a full UI slot only after these review blockers pass.

Review follow-up verification: full units/coverage exited0,4290 passed/24 skipped,72.05s.
The final type-only interface cleanup and test lint corrections were followed by113 focused
worker/converter/capability/registered-IPC tests passing (1.46s). Full lint/build exited0.
Commit and immutable-head review are next. Coordinator explicitly queues full audit UI
after M13's focused slot and M11's full run; no audit UI lease yet.

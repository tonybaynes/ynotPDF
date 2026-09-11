# Open work, 2026-09-11

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

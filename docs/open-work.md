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
quiet commit. **M04 owns this and will fill in the detail here.**

## 3. The e2e window flash — cause NOT established

Tony sees the outline of a window flash up during a run, every now and again. **This is still
open.** Two candidate causes were found by inspection and both are now doubtful; the changes made
for them are on `fix/post-restore` and are worth keeping as hardening, but they should not be
described as the fix.

What was changed in `src/main/window.ts`: opacity goes on the instant a parked window exists
rather than at `ready-to-show`; a parked window does not restore a maximised state; and it
re-asserts opacity on `show`, `maximize`, `restore` and `enter-full-screen`.

**Why neither candidate convinces:**

- **`maximize()` showing the window before opacity was applied.** Real by inspection — Electron's
  `maximize()` shows a window as a side effect. But it only runs when a _remembered_ maximised
  state exists, and e2e uses a fresh profile per launch, so it may never fire during a run at all.
- **Full screen showing a parked window.** `view.fullScreen.toggle` is exercised by
  `viewer.spec.ts` and does move the window to a real display. But measured on Windows, opacity
  **survives** the transition without the listener, so nothing becomes visible.

**The guard in `app.spec.ts` does not test this**, and says so in its own comment: removing both
halves of the fix leaves it passing, because by the time Playwright is attached the window is past
`ready-to-show` and the construction-time path cannot be observed. It pins a real invariant — a
parked window reads as transparent — and nothing more.

**The better candidates, unexamined.** `src/main/print/index.ts` and
`src/main/webpdf/WebPdfPrinter.ts` both create a `BrowserWindow` with `show: false` and **no
parking and no transparency at all** — default size, default position, middle of the screen, and
blank. "An outline of a window, nothing else" describes one of those far better than it describes
the main window. If anything shows them for a frame, that is what Tony is seeing.

**Next step, already begun:** a temporary probe in `src/main/index.ts`, behind
`YNOT_WINDOW_PROBE=<file>`, records every window created, shown, maximised, focused or taken full
screen during a hidden run. Run the full suite with it set and read the log — that names the
culprit instead of guessing at it a third time. Remove the probe afterwards.

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

**Keep as the record:** `fix/hardening-review`. Its first commit is the original hardening pass and
the rest is the review of it. The security file points at it so none of that has to be re-derived.
Delete it only once that work has been re-landed.

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

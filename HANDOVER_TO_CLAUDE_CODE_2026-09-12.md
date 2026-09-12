# ynotPDF handover to Claude Code

Date: 2026-09-12  
Project: `D:\Projects\ynotPDF`  
Coordinator: the Codex task **Review PDF editor plan**.  
Purpose: resume the authorised PDF-editor completion project after the Codex/Luna usage limit is reached. Tony intends to hand the project back to Claude Code tomorrow evening.

## Product target

The target is a best-in-class desktop PDF editor with the relevant desktop functionality of Foxit, Adobe Acrobat Pro and Tungsten Power PDF on:

- Windows x64 (modern Intel/AMD 64-bit; 32-bit Windows is not required)
- Windows ARM64
- macOS Intel and Apple Silicon
- Ubuntu Desktop x64

The original 44 module briefs are an implementation starting point, not proof of competitor parity. The plan review found that full tag-tree editing, high-fidelity Office conversion, preflight/print-production tooling, broader XFA/JavaScript compatibility, scanner/virtual-printer integration, collaboration/enterprise/cloud integrations and other commercial-editor features still need numbered briefs and acceptance evidence. Do not claim product parity from module ticks alone.

## Coordination rules

This work is coordinated centrally. **Review ynotPDF project** is the audit owner, not a second coordinator. Do not create replacement tasks for the existing module owners. Tony allowed up to ten simultaneous tasks, but four module tasks plus the audit task were the safe capacity used here because local Electron UI work must be serialised.

Use `PLAN.md`, `CHECKLIST.txt`, `docs/plan-review-2026-09-12.md`, `docs/open-work.md`, `Codex_Audit.md` and the relevant module brief as the planning set. Preserve the completion policy:

1. Finish reopened required scope before starting new feature work.
2. Use a separate task/worktree named `M<number> - <short description>` for a new module.
3. Agree ownership before editing shared files.
4. Use real UI journeys and inspect representative screenshots; command/API tests alone are not sufficient for UI claims.
5. Commit and push coherent changes, run appropriate tests and CI, then merge serially.
6. Update both PLAN and CHECKLIST as work changes.
7. Use `✔` only when the entire required module scope is merged to `main` with required CI green. Partial repairs remain open.
8. Do not blanket-reset or clean another task’s worktree.

All document mutations must remain undoable. Use synthetic fixtures only; do not read or commit private PDF contents. Do not weaken assertions or update visual baselines to hide defects.

## Completed coordination work

The following changes were reviewed and merged to `main`:

- PR56, plan review and corrected module briefs: `1a7fd44`.
- PR58, vector Print-to-PDF appearances and snapshots: `753f5cb`.
- PR57, Group 4 TIFF export repair: `c492bfd`.
- PR55, crop ratios and rotated crop geometry: `214f7f4`.
- PR59, Fit Visible bounds, browser tile scaling and raster geometry: `2696119`.
- PR64, image-import deskew plus Combine folder and desktop-drop routes: `7c3d24d`.
- PR60/PR61, live plan/checklist and merge tracking: `dba7db3` and `5ec4c3e`.

PR64 passed all eight platform checks, including Windows x64, macOS, Ubuntu and both Windows ARM installer-smoke jobs. Its ARM qualification uses the existing MSI fallback because NSIS did not produce an executable; this is documented and is not proof of every ARM installer path.

The current primary `main` is `29d8e2b18c84996270eb0ded37410a2b29e83d9a`. The primary worktree was clean at handover apart from this new handover document before it was committed.

The coordinator also prepared PR66, **Serialize session replay renders and record module progress**, at `1d50f335fe376b0a2fa9edc77d7e9e2c3bd415c0`. It changes the coordinator tracker and fixes a real unit-test misuse: two `Promise.all` render batches could call the non-reentrant PDFium renderer concurrently when progressive rendering yielded, so the checks now render sequentially while preserving hash and undo assertions. Sixteen core integration tests, focused lint/format and diff checks passed. PR66 CI was still pending; review and merge it only after all required checks are green.

## Current module states

### M11 — Complete viewer interactions

Task title: `M11 - Complete viewer interactions`  
Task id: `01a0946e-700c-7532-92fa-031594975752`  
Worktree: `C:\Users\tonyb\.codex\worktrees\3c3a\ynotPDF`  
PR67: `https://github.com/tonybaynes/ynotPDF/pull/67`  
Frozen source head: `a4f0eb6355408e2d87f6bf14a51fbfdb0a097420`

The repair fixes genuine F11/full-screen and reading-mode Escape failures, including native/full-renderer state reconciliation and first-Escape precedence for Loupe and palette. Six real-input tests passed with no retries: F11/Escape, reading/palette/Loupe precedence, real horizontal and vertical ruler drags, and close/recent-reopen persistence. The earlier 3-pixel ruler discrepancy was the transparent grab border measured by the old test oracle; actual guide ink meets the unchanged one-CSS-pixel bound. Full unit coverage, lint, build, typecheck and static checks passed. Windows performance evidence recorded approximately 59.9341 scroll fps, 60.3602 idle fps and 62.0524/64 MB cache; this does not qualify other platforms.

Still open:

- The full local viewer UI suite has not completed on the committed PR head.
- At the latest status check, all desktop PR67 checks were green; the two Windows ARM installer-smoke checks were still running. The full local UI evidence was interrupted by the usage limit.
- Review the full-suite evidence, retries/skips, screenshots and final CI before considering the reopened M11 scope complete.
- Do not tick M11 yet.

The task then hit the account usage limit. No local Electron process was left running.

### M13 — Preserve annotations in PDF printing

Task title: `M13 - Preserve annotations in PDF printing`  
Task id: `01a0946e-7005-73e0-afae-3c0b8c212a44`  
Worktree: `C:\Users\tonyb\.codex\worktrees\08ff\ynotPDF`  
PR62: `https://github.com/tonybaynes/ynotPDF/pull/62`  
Frozen source head: `cce1f2d2dd9b64c5f515d062a721a288c7768da9`

The Linux overflow was diagnosed from CI evidence as an absolute `.sr-only` span inside an unpositioned tab, not a print-pixel or status-bar defect. A real long-tab/edit regression reproduced the problem (body width 2504 versus viewport 1280); `.tab { position: relative; }` fixes it. The final 13 preview/guard tests passed in 39.9 seconds with process exit 0. The test now waits until the asynchronous typed annotation update is present in the document journal before capturing the navigation baseline, then requires exact journal equality. All five synthetic byte-only opens use `path: null`, preserving unsaved-document semantics. The final screenshot was inspected.

Still open:

- Fresh PR62 CI was still running at handover (Windows and macOS active; Ubuntu green).
- After merge, the same task must complete model-only unsaved region-snapshot fidelity, genuine pointer/keyboard selection journeys and independent styled clipboard paste into installed Microsoft Word. Word is the documented substitute because WordPad is absent; record the actual consumer.
- Hardware-printer-driver fidelity remains unproven.
- Do not tick M13 merely because the current preview/guard tests pass.

The task also hit the account usage limit after the final local run. No local Electron process was left running.

### M41 — Complete import and Combine workflows

Task title: `M41 - Complete import and Combine workflows`  
Task id: `01a0946e-7009-78c2-8c46-a1346a0b07a1`  
Worktree: `C:\Users\tonyb\.codex\worktrees\79cb\ynotPDF`

PR64 is merged as `7c3d24d`. Automatic image-import deskew, Combine Add-folder and external desktop file-drop routes passed the local and eight-platform CI acceptance used for that bounded repair. The same task remains open.

The key unfinished gap is structural preservation. The audit guard correctly refuses seven original corpus files containing AcroForm, Names/attachments, OCG, XFA or meaningful structure metadata. That safe refusal leaves only 14 files/35 pages from the required 21 files/42 pages; refusal is not preservation and does not complete M41. Split’s `keepForms: true` path also creates a new PDF and copies pages without copying AcroForm ownership.

The coordinator approved the read-only design draft at `C:\Users\tonyb\AppData\Local\Temp\ynot-m41-import-2e912c2\preservation-design.md`. The next increment should be a new main-based branch in the same M41 task, starting with ordinary AcroForm identity/appearance preservation and Split keepForms round trips. Use shared object identity mapping, selected-page pruning, deterministic field/resource collision handling, source immutability and no-partial-output tests. Then handle Names/destinations/attachments, OCG configuration and structure trees in separate reviewed increments. Keep refusals for XFA, script-dependent collisions, unsupported active document actions and signed-input limitations until genuine support exists. Do not modify the audit-reserved Combine implementation or tests until an explicit ownership handoff is agreed.

Do not tick M41.

### M92 — Complete image export fidelity — complete

Task title: `M92 - Complete image export fidelity`  
Task id: `01a0946e-7006-7402-a18f-9c9acbd3ba72`  
Worktree: `C:\Users\tonyb\.codex\worktrees\4e0c\ynotPDF`  
PR63: `https://github.com/tonybaynes/ynotPDF/pull/63`, merged as `f823f14`  
PR65 readability/copy-permission integration: merged as `29d8e2b`

The implementation covers masks/SMasks, intrinsic dimensions, nested Form images, exact embedded-byte handling, Original versus decoded-PNG choices, transparency and collision-safe deduplication, plus separate HTML appearance semantics. Local UI and integrated checks passed; the fractional Blink width correction is test-only and preserves the authored width and pixel assertions. Actual embedded and HTML screenshots were inspected.

M92 is complete under its documented module scope: all eight PR63 and PR65 platform checks were green, including ARM installer-smoke, and the audit copy-permission/readability integration was merged. The valid compressed-TIFF decoder edge case and large-scale image-import Page-option clipping remain queued under M91.

### Audit — Review ynotPDF project

Audit task id: `01a08f69-dfd6-71c0-a622-badd897cf217`  
Worktree: `D:\Projects\ynotPDF-audit-rest`  
PR68: `https://github.com/tonybaynes/ynotPDF/pull/68`  
Latest head: `179d0e7092754932ac88115e388d34789dd01149` (draft)

The audit work covers canonical per-window filesystem capabilities, protected open/recovery, main-frame IPC validation, external-file authority, worker terminal failures, command/undo failure handling, copy permissions, rich-text sanitisation/readability, E2E grant boundaries, artifact/build-input inventory and ADRs 0024–0026. It fixed two concrete blockers: attachment filename validation now occurs after safe-name normalization, and malformed/messageerror worker messages settle pending operations instead of hanging. The latest script-only fix requires a real readable nonempty notice file before marking an artifact notice complete; five regressions and the artifact/SPDX tests pass, as do focused lint/format/typecheck and the built inventory gate. The strict release gate remains intentionally failing on four known unresolved compiled-component/notice reviews; do not claim release readiness.

Still open:

- PR68 CI was still running at handover. Merge only after all required checks are green and the final diff remains scoped.
- The full local audit UI run has not been allocated; the local UI lease remains held by M11 until its task explicitly releases it after process exit.
- After M11 releases the lease, allocate the audit’s full UI run serially, then inspect representative screenshots and actual file-boundary behavior.
- The audit work does not make the entire product or any reopened module complete.

PR65, `https://github.com/tonybaynes/ynotPDF/pull/65`, was the separate readable-controls/status/export layout repair at head `69b77d3b826b1df516979e06e56b2ae0aed77441`; it is merged as `29d8e2b` with all eight checks green. Its source and screenshots were reviewed, and it supplied the final M92 readability/copy-permission integration.

## Queued reopened work

Do not start replacement tasks while the active tasks above are unfinished. The confirmed queue is:

- M30: prove cross-renderer appearance equivalence.
- M32: use genuine Acrobat/Foxit-exported XFDF fixtures.
- M50: preserve unknown page operators during z-order changes and finish pointer/pane behavior.
- M53: multi-file Bates workflow.
- M60: image-field picture selection and button icons.
- M70: per-recipient certificate permission editing.
- M91: valid TIFF Group 4 compressed-length edge case and the visibly truncated image-import Page option at large UI scale.

The plan review also requires triage of M91 Unicode text quality and M100 font-subsetting limits before new feature dispatch. M31’s custom-stamp rotation limitation is beyond its literal placement scope and should not be reopened solely for that reason.

## Local UI lease

Before any local Electron test, read:

`C:\Users\tonyb\AppData\Local\Temp\ynotpdf-ui-slot.json`

At handover it says:

- owner: M11 task `01a0946e-700c-7532-92fa-031594975752`
- purpose: full local UI suite on PR67 head `a4f0eb6...`
- next: audit task `01a08f69-dfd6-71c0-a622-badd897cf217`
- coordinator: this original Codex task id `01a09469-799c-7d20-8cc5-168ca554d892`

Only the coordinator changes the lease after confirming the previous process has actually exited. CI runners are independent. Never infer availability from the `next` field if the current owner has not released it.

## Usage-limit handoff

The Codex/Luna tasks reached the account usage limit during the final M11/M13 follow-through. No reset credit was requested or redeemed. Their worktrees, commits and PRs are preserved, and no replacement task should be created. If Claude Code can run locally, it should still respect the ownership and UI-lease rules above; if it cannot access the existing task conversations, use the PRs, this file, PLAN, CHECKLIST and the module briefs as the source of truth.

## First actions for Claude Code

1. Read this file, `CLAUDE.md`, `PLAN.md`, `CHECKLIST.txt`, `docs/plan-review-2026-09-12.md`, `docs/open-work.md` and the applicable module briefs. The current count is 17 ticked, 10 reopened (M11/M13/M41 active and seven queued), and 17 not started.
2. Inspect exact PR heads and CI with `gh pr view 62`, `63`, `65`, `66`, `67` and `68`; do not trust stale status prose.
3. Do not tick a module until its whole acceptance scope is complete and merged.
4. Preserve the M11 lease until its owner has explicitly released it after a real process exit. Then run the audit UI suite, still serially.
5. Merge one reviewed, green PR at a time; update PLAN/CHECKLIST after each meaningful merge.
6. Continue M41 structural preservation in the same task after ownership is cleared; keep the audit refusal guard until genuine round-trip support exists.

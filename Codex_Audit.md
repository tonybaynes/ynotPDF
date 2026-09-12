# ynotPDF — Codex audit for Tony and Claude Code

**Repair status — 12 September 2026:** Findings 1–12 are merged (PRs #51–54), and #23 was already fixed by PR #49. The resolution notes below distinguish work in the current audit branch from merged repairs. PR #65 carries screenshot-led readability checks and fixes; its final CI/merge is pending. Sections 26–31 remain dated assessments, not additional feature-module requests. The original audit and Claude comments are retained as historical evidence.

Audit date: 11 September 2026. Author: Codex. Requested destination: `D:\Projects\ynotPDF\Codex_Audit.md`.

**Assessment:** the project has a substantial, coherent implementation and a useful test suite. Its main weakness is the integration between document state, undo, recovery, saving and security. Several ordinary workflows can lose changes or protection while reporting success. Resolve those paths before relying on ynotPDF for the only copy of important work. There is no evidence here that the project needs a rewrite.

Each numbered finding below gives evidence and a proposed repair/test. These are audit recommendations; no application fixes, commits, merges, branch changes or workflow changes were made.

## 0. Scope, revision and evidence conventions

The audited source is **`b6eb1369c3461cf01fd6a3b5ecb9c8185926d13b`**, the remote main revision containing the shared-fixture-path repair. Tony's local main was **`8f925eadc4a1883dc9e217bdc21353652bedd41d`**. Testing used a separate archive of the audited revision at:

`C:\Users\tonyb\Documents\Codex\2026-09-11\d-projects-ynotpdf\work\audit-20260911\source`

The snapshot has its own dependency directory, fonts, build output and test output. It is not a Git worktree and does not share mutable build directories with Claude's checkouts. Private customer PDFs in `test/fixtures/local` were not copied into it. The snapshot and logs are retained for reproduction. Repository source links below point to Tony's working copy for convenience; line numbers refer to the audited revision and may shift after repairs.

This audit covered project requirements and module status, architectural contracts, source and configuration inspection, the full existing unit and Windows UI suites, selected cross-module traces, fault injection, real PDF round trips, public dependency audit results and current GitHub CI evidence. It is not a claim that every line, bundled binary, possible PDF feature combination or supported operating system was independently verified. In particular, this was not a new native macOS/Linux/ARM test run or a penetration test of deployed installers.

**Priority definitions:** P1 = repair promptly because the affected workflow can lose data, protection or intended functionality; P2 = significant correctness, resilience, security boundary or verification weakness; P3 = documentation or maintainability follow-up. P1 does not mean every file or every session is affected.

**Evidence labels:** “Reproduced” identifies a local audit probe; “Traced” identifies an inspected production call path; “Known” means the repository already documents the problem. The audit probes deliberately assert the observed defective behaviour. Their passing result confirms the reproduction, not product correctness. Convert them to desired-behaviour regression tests when implementing fixes.

**Claude Audit Comments:** The evidence conventions here are the most valuable part of the report and should be kept in any follow-up. Three things are worth confirming for the reader: (a) I re-checked every source citation in this document against current `main` (`8d9989f`, two merges past the audited `b6eb1369`), and the line numbers still land on the cited code — findings 1-22, 24 and 25 all reproduce by inspection today; (b) finding 23 has since been **fixed** and should be read as closed (see my note there); (c) the "audit probes deliberately assert the observed defective behaviour" caveat is important — do not copy `codex-audit.test.ts` into `test/` as-is, because a suite full of assertions that defects still exist will silently go green in the wrong direction. Convert each probe to its desired-behaviour form at the moment you fix it.

## 1. P1 — Cancelling a protection-password prompt can still save plaintext

**Codex resolution (12 September 2026):** Merged in PR #51: password-prompt cancellation aborts saving without writing plaintext.

**Evidence: reproduced, A12; also explicitly asserted by an existing test.**

[SecurityService.ts:568](D:/Projects/ynotPDF/src/renderer/modules/M70-encryption/SecurityService.ts:568) returns the incoming unencrypted bytes when `secretsForSave()` returns null. That null is the result of cancelling the password prompt. The save stage adds a warning, but does not cancel the write. [SaveService.ts:476](D:/Projects/ynotPDF/src/renderer/modules/M21-save/SaveService.ts:476) then writes those bytes normally.

Trigger: recover a document whose journal contains a password-protection intent, save it, and cancel the prompt that asks for the password no longer held in memory. The document can be written without that protection. A12 verified the real stage returns the exact plaintext input buffer. [pipeline.test.ts:301](D:/Projects/ynotPDF/test/unit/security/pipeline.test.ts:301) currently treats this behaviour as correct.

This is particularly serious alongside finding 2: the warning is not displayed by the ordinary Save command. Cancelling a password prompt is not an affirmative choice to remove protection. Keeping the edits in memory does not require committing plaintext to the destination.

**Recommendation:** propagate a distinct cancellation outcome through the security stage and the save pipeline; retain the document's dirty state and recovery record. If saving unprotected is offered, make that a separate explicit action with an appropriate destination decision before writing. Test cancellation at each password prompt and assert that no filesystem write occurs and the existing target remains unchanged. Update the existing test's expected behaviour rather than merely adding a contradictory test.

**Claude Audit Comments:** Confirmed at [SecurityService.ts:569](src/renderer/modules/M70-encryption/SecurityService.ts:569) — `secrets === null` returns `input.bytes` with a warning, and [SaveService.ts:477](src/renderer/modules/M21-save/SaveService.ts:477) writes them. The finding is correct and the priority is right.

One thing to add that makes the repair much cheaper than the recommendation implies. `SaveStageResult` does not need a new cancellation channel plumbed through `runSaveStages` and `SaveOutcome`: `writeTo()` already wraps the entire writer/stage/write sequence in a `try`, and its `catch` returns `{ saved: false }` without ever reaching `markSaved()` or the recovery discard. So a typed `SaveCancelledError` thrown from the stage produces the correct behaviour — no write, dirty state preserved, recovery record preserved — for roughly ten lines of change. Add the typed error, catch it distinctly in `writeTo` so it reports "cancelled" rather than raising an error toast, and delete the misleading warning string.

The reason to use a distinct type rather than a bare throw: `runSaveStages` runs stages in order, and a later stage must not observe a half-cancelled pipeline as if it were an ordinary failure.

Second point, separate from the fix. The warning text — "The document was saved without its password protection, because the password was not given" — is written in the past tense and is _emitted before the write happens_. Even on the intended path that is the wrong tense for a value that finding 2 shows nobody displays. Whatever replaces it should be phrased as a question asked before writing, not a statement made after.

## 2. P1 — Save warnings are returned but ordinary Save does not show them

**Codex resolution (12 September 2026):** Merged in PR #52: warnings are reviewed before writing; accepted warnings retain dirty state and recovery.

**Evidence: reproduced service boundary, A14; traced command caller.**

[SaveService.ts:491](D:/Projects/ynotPDF/src/renderer/modules/M21-save/SaveService.ts:491) collects plan, writer and pipeline warnings into `SaveOutcome.warnings`, after writing and marking the document clean. [M21 manifest](D:/Projects/ynotPDF/src/renderer/modules/M21-save/manifest.ts:94) returns the service result. [Registry.ts:199](D:/Projects/ynotPDF/src/renderer/core/Registry.ts:199) returns a command's result without interpreting save warnings. The normal UI path has no warning presenter for this outcome.

This affects consequential warnings, not just diagnostics. For example, [plan.ts:607](D:/Projects/ynotPDF/src/renderer/modules/M21-save/plan.ts:607) omits a portfolio file whose blob is missing and adds a warning. Security stages can warn about lost protection, including saving a certificate-protected source without recipient certificates. A14 injected a writer warning and observed `saved: true`, the warning in the returned result, and no toast call.

**Recommendation:** define which warnings are informational and which mean the requested result was not fully produced. Display informational warnings persistently enough to read; require a decision or abort before writing when content or protection would be lost. Do not clear the dirty state for changes deliberately omitted from the output without a documented state transition. Add a UI test invoking the actual Save control with a warning-producing stage and assert visible wording and correct dirty/recovery state.

**Claude Audit Comments:** Confirmed. `writeTo()` assembles `warnings` at [SaveService.ts:490](src/renderer/modules/M21-save/SaveService.ts:490), _after_ `recoveryStorage.discard()`, `entry.source = ...` and `document.undo.markSaved()` have already run. The ordering is the real defect: by the time anyone could act on a warning, the document has been declared clean and its recovery record deleted.

A sequencing point the recommendation doesn't draw out. The warnings arrive in two distinct waves, and they do not need the same treatment:

- **Plan warnings** come from `buildWritePlan(document)` at [SaveService.ts:455](src/renderer/modules/M21-save/SaveService.ts:455) — _before_ any engine, writer or filesystem work. Every "content will be omitted" case, including the missing-portfolio-blob case cited here, is knowable at that point. These can become a pre-write decision today with no restructuring at all, and that covers the highest-consequence half of the problem.
- **Writer and stage warnings** arrive after the bytes exist but still before `writeBytes()`. These can also gate the write; only the ordering of the `markSaved`/`discard` bookkeeping needs to move below the decision.

So I would split this into two changes: gate on plan warnings first (small, safe, immediately valuable), then move the clean/discard bookkeeping below the stage-warning decision. Trying to agree one uniform severity taxonomy across all three producers before shipping anything will stall.

Also worth noting: `SaveOutcome.warnings` is typed `string[]`. A severity decision cannot be attached to a string without parsing it. Whatever else happens, that type needs to become a structured `{ severity, text }` before the UI can be honest about which warnings mean "we did not do what you asked".

## 3. P1 — Certificate recipient permissions are lost and can be bypassed even when supplied

**Codex resolution (12 September 2026):** Merged in PR #53: source policy and recipient authority survive Open/refresh; print and copy enforce those rights.

**Evidence: reproduced, A13; traced both open paths.**

[SecurityService.ts:497](D:/Projects/ynotPDF/src/renderer/modules/M70-encryption/SecurityService.ts:497) discards `opened.permissions` when returning from `prepareForOpen()`. [ViewerService.ts:254](D:/Projects/ynotPDF/src/renderer/modules/M11-viewer/ViewerService.ts:254) passes only the recipient name to `noteOpenedAs()`. Its default treats missing permissions as unlocked.

Passing permissions alone does not fix the issue. `noteOpenedAs()` can set `unlocked: false` and record the supplied rights, while `info.encrypted` remains false because PDFium sees the already-decrypted PDF. [SecurityService.ts:264](D:/Projects/ynotPDF/src/renderer/modules/M70-encryption/SecurityService.ts:264) immediately allows every action for an entry whose `info.encrypted` is false. `refresh()` can also overwrite the security information with the decrypted document's information and mark it unlocked. A13 passed `NONE_ALLOWED` explicitly and still observed both copy and modify allowed.

**Recommendation:** preserve the source security policy separately from the encryption state of the engine's working bytes. Carry recipient permissions through the normal open contract, retain them across refresh, and distinguish a recipient's individual permissions from owner-level authority. Test an actual certificate-protected PDF through the ordinary open flow with different recipients, not only the `openWithDigitalIdAt` helper. Verify menus, palette commands, properties and direct registered command execution agree.

**Claude Audit Comments:** Confirmed, and the second half of the finding — that passing permissions through would not by itself fix it — is the important part and is correct. [SecurityService.ts:264](src/renderer/modules/M70-encryption/SecurityService.ts:264) reads:

```ts
if (!entry || !entry.info.encrypted || entry.unlocked) return true;
```

There are **two** bypasses on that line, and the finding names only the first clearly. `!entry.info.encrypted` is the PDFium-sees-decrypted-bytes problem described here. `entry.unlocked` is a second one: a single boolean carrying two different meanings — "the owner password was supplied" and "a digital ID was used" — and only the first of those is owner-level authority. A certificate recipient granted `NONE_ALLOWED` is not an owner, yet trips the same flag.

Root cause in one sentence: `Entry.info` conflates _what the source file declared_ with _what the engine currently holds_. Those need to be two fields — something like `sourcePolicy` (immutable, captured once at open, never touched by `refresh()`) and `engineState` (mutable, describing the working bytes). Once they are separate, `allows()` reads only `sourcePolicy`, and the `refresh()` overwrite described in the finding becomes structurally impossible rather than something every future change has to remember not to do.

`unlocked` should become an enum in the same change: `owner | recipient | user | none`. That part is mechanical, and it is what stops the next person re-introducing this.

## 4. P1 — Undoing a password change does not restore the password used by Save

**Codex resolution (12 September 2026):** Merged in PR #54 (`d322de7`). Implemented in the recovery batch: command do/undo updates the session password binding as well as intent. Real encryption tests verify A/B undo, redo and undo of Remove Security; passwords remain absent from JSON.

**Evidence: reproduced at the encryption-client boundary, A17.**

[SecurityService.ts:299](D:/Projects/ynotPDF/src/renderer/modules/M70-encryption/SecurityService.ts:299) stores passwords in the service entry after applying a command. [SetSecurityCommand](D:/Projects/ynotPDF/src/renderer/modules/M70-encryption/commands.ts:40) holds current and previous secrets but its `do()`/`undo()` only update the model's intent. The service has no undo subscription that restores its entry's secrets. `secretsForSave()` reads that entry.

Trigger: set password A, change it to B, undo the second change, then save. A17 observed B being passed to the encryption client despite the undo. The direct service helper tested uses the same command and entry assignment as the dialog path. This can leave a file protected by a password the user believes they reverted.

**Recommendation:** make the in-memory secrets follow the same undo/redo state transition as the security intent, while keeping them out of serialization and logs. Test A → B → undo → save, redo → save, and Remove Security → undo → save against actual encrypted output and the expected passwords.

**Claude Audit Comments:** Confirmed. The service-side `Entry.secrets` is written at [SecurityService.ts:299](src/renderer/modules/M70-encryption/SecurityService.ts:299) and read by `secretsForSave()`; nothing in `SetSecurityCommand.undo()` touches it.

I'd push back slightly on the framing. "Make the in-memory secrets follow the same undo/redo state transition" suggests an undo subscription on the service. Don't do that — a subscription is a second, independent listener that can be missed, ordered wrongly, or fire for a document that has since closed. `SetSecurityCommand` _already holds both the current and the previous secrets_. The fix is for its `do()` and `undo()` to set the service entry's secrets directly, exactly as they already set the model intent. One transition, one owner, nothing to keep in sync.

A consequence the finding doesn't mention: `canReprotect(entry)` at [SecurityService.ts:559](src/renderer/modules/M70-encryption/SecurityService.ts:559) also reads `entry.secrets`, and `SaveService.stageHandlesSecurity()` uses that answer to decide whether to hand the writer **plaintext**. So after an undo, the bug is not only "the wrong password is applied" — the decision about whether the document is decrypted for the writer at all is being made from stale state. Test Remove Security → undo → save specifically; that is the case where this could plausibly produce an unprotected file rather than a wrongly-protected one.

## 5. P1 — Edits made during an asynchronous save can be incorrectly marked saved

**Codex resolution (12 September 2026):** Merged in PR #54 (`d322de7`). Implemented in the recovery batch: saves are serialized per document, engine/model reads share a command barrier, and mutation revisions include pending edits. Stale output cancels before writing; edits during the disk write stay dirty. Same-length undo/branch and overlapping save tests cover this.

**Evidence: reproduced, A03.**

[SaveService.ts:454](D:/Projects/ynotPDF/src/renderer/modules/M21-save/SaveService.ts:454) captures a write plan before asynchronous engine, writer, pipeline and filesystem work. It subsequently calls `document.undo.markSaved()` against the current history at line 484. There is no revision comparison linking that marker to the state captured by the save. `entry.saving` does not itself serialize all save requests or prevent model changes.

A03 paused the writer after an initial edit, made a second edit, then completed the earlier save. The second value remained in the model, but `isDirty` became false although the earlier plan could not contain it. Closing afterward can lose that edit without an unsaved warning. Overlapping saves are a related race that should be handled by the same design.

**Recommendation:** introduce a stable document revision/save snapshot contract. Mark only that revision saved, or serialize editing for the full operation if that is the chosen UI behaviour. Handle another edit, undo, redo and another save while a stage or disk write is pending. Preserve recovery for changes newer than the completed save. A disabled ribbon button alone will not cover programmatic commands and asynchronous callbacks.

**Claude Audit Comments:** Confirmed, and this one has a genuinely small fix that the "stable document revision/save snapshot contract" framing makes sound larger than it is.

`UndoStack` already has the counter needed. [UndoStack.ts:35](src/renderer/core/UndoStack.ts:35) keeps `private savedIndex = 0`, and `markSaved()` at [line 222](src/renderer/core/UndoStack.ts:222) sets `this.savedIndex = this.undoList.length` — reading the length _at the moment it is called_, which is the bug. Capture the length alongside `buildWritePlan()` at [SaveService.ts:455](src/renderer/modules/M21-save/SaveService.ts:455) and pass it in: `markSaved(capturedLength)`. `isDirty` then correctly stays true for an edit made during the save.

Two details that fix must get right, and they are why it is still worth writing down as a contract:

- `markSaved` must ignore a captured index that is now _ahead_ of `undoList.length` — the user undid past the save point while it was in flight. `UndoStack` already has precedent for that defensive handling at [line 249](src/renderer/core/UndoStack.ts:249) and [line 263](src/renderer/core/UndoStack.ts:263), where it sets `savedIndex = -1` to mean "dirty regardless".
- An undo followed by a different redo during the save can produce the same `undoList.length` with _different contents_. A length is not an identity. If that case matters, the counter must be a monotonic revision that increments on every mutation including undo, not a list length.

Overlapping saves are correctly flagged as related. `entry.saving` is set but only consulted by the UI; it serialises nothing. A per-entry promise chain would.

## 6. P1 — Recovery can apply already-saved changes a second time

**Codex resolution (12 September 2026):** Merged in PR #54 (`d322de7`). Implemented with recovery v2 checkpoints (ADR 0023): current engine bytes and model restore together without replaying saved history. Records survive recovery and a second crash. Normal Save keeps undo; recovery starts a fresh undo history. Legacy v1 records are retained for manual recovery because their matching base cannot be reconstructed safely.

**Evidence: reproduced with the real PDFium engine and full-rewrite writer, A01.**

[Journal.ts:101](D:/Projects/ynotPDF/src/renderer/core/Journal.ts:101) serializes the document's applied undo journal. Save retains that history to preserve undo. After saving, [SaveService.ts:483](D:/Projects/ynotPDF/src/renderer/modules/M21-save/SaveService.ts:483) changes the source fingerprint to the newly written bytes. Recovery opens the current file and replays the whole journal.

The reproduction rotated a page by 90 degrees, wrote the result, marked it saved, then made a metadata edit and created a recovery record. Reopening the saved PDF started at 90 degrees. Replaying the journal rotated it to 180 degrees, while `sourceChanged` was false. This is silent document corruption in a plausible Save → edit → crash → Recover sequence.

**Recommendation:** explicitly define the immutable base against which a recovery journal is valid. Persist a checkpoint and replay only a correctly rebased delta, or preserve the original base plus its complete journal. Simply taking commands after the saved index is insufficient when a user undoes changes across a save boundary or branches history. Test save/edit/recover, repeated saves, undo past save, redo, page deletion and insertion, not only additive metadata edits.

**Claude Audit Comments:** Confirmed, and I agree this is the most serious finding in the report. Silent byte-level corruption from an ordinary Save → edit → crash → Recover sequence is worse than any of the security findings, because the user has no way to notice it.

That said, the recommended repair is larger than the reproduced defect requires, and a much smaller invariant is available. The pieces are already in place:

- On a successful save, [SaveService.ts:482](src/renderer/modules/M21-save/SaveService.ts:482) already discards the recovery record and re-fingerprints `entry.source` to the newly written bytes.
- The undo journal is deliberately _retained_ across that save so undo still works.

So the app already acts on "the saved bytes are the new base". What it lacks is the statement that **the recovery journal's baseline is the last successful save**. A `journalBase` marker on the document, set to `undo.length` at save time, with `serialiseJournal()` emitting only entries after it, fixes the reproduced case with no new checkpoint file format.

The finding is right that this is not sufficient alone, and the reason is worth stating precisely: if the user undoes _past_ the save boundary, the recovery journal would need an inverse operation that a forward-only journal cannot express. So the rule must be that undoing past `journalBase` invalidates the recovery baseline — at which point the document either falls back to persisting bytes or marks itself unrecoverable, rather than staying silently recoverable-and-wrong. That branch is the part needing design; the common case is not.

**A separate defect in the same area, not covered by any finding.** `recoverOne()` calls `recoveryStorage.discard(record.id)` at [SaveService.ts:705](src/renderer/modules/M21-save/SaveService.ts:705) as soon as replay succeeds — _before_ the user has saved the recovered document. A crash in the window between recovery and the next save loses the work a second time, permanently. The record should survive until the recovered document is saved.

## 7. P1 — Save As updates the tab path but leaves the document's source path stale

**Codex resolution (12 September 2026):** Merged in PR #54 (`d322de7`). Implemented in the recovery batch: Save As updates Document.state.path and the tab, stops the old watcher, and serializes initial path probing with saves.

**Evidence: reproduced, A02.**

[SaveService.ts:486](D:/Projects/ynotPDF/src/renderer/modules/M21-save/SaveService.ts:486) updates the tab store and its private entry after Save As. It does not update `Document.state.path`. [recovery.ts:108](D:/Projects/ynotPDF/src/renderer/modules/M21-save/recovery.ts:108) builds the recovery path from the document state.

A02 successfully saved a pathless document and observed a populated tab path while the model and recovery record still had `path: null`. For a document originally opened from another path, recovery can instead target the old source. Other consumers of document identity can likewise see stale information.

**Recommendation:** establish one authoritative document identity/path update operation and use it for Save As, tab labels, watchers and recovery. Include the old-path watcher lifecycle. Test new document → Save As → edit → recovery, and existing A.pdf → Save As B.pdf → edit → recovery, verifying the correct bytes and path after reopening.

**Claude Audit Comments:** Confirmed, and the mechanism is more definite than the finding states. [SaveService.ts:486](src/renderer/modules/M21-save/SaveService.ts:486) calls `this.documents.update(entry.tabId, { path })`, and `Documents.update()` at [Documents.ts:96](src/renderer/app/tabs/Documents.ts:96) patches the `DocumentTab` record only — the store holds no reference to `Document.state` and structurally _cannot_ update it. This is not an omission a careful caller could have avoided; the tab store is simply the wrong place for the authoritative path to live.

`buildRecoveryRecord()` at [recovery.ts:99](src/renderer/modules/M21-save/recovery.ts:99) then reads `doc.state.path` directly. The two never meet.

The recommendation is right. One addition: the single rename operation must own the **watcher lifecycle**, and it is worth checking whether `refreshPath(entry, path)` stops watching the old path or merely starts watching the new one. If the old watcher survives, a later unrelated change to the original file fires `onDiskChange` against a document that is no longer that file — surfacing as a spurious "this file changed on disk" prompt at best.

Findings 7 and 8 compound in a specific, testable way: a new document that is Save-As'd has a real file on disk _and_ a null `state.path`, so finding 8's recovery path deletes its record while telling the user it "was never saved". Both halves of that sentence are then false.

## 8. P1 — Recovery discards unsaved documents because it has no base bytes

**Codex resolution (12 September 2026):** Merged in PR #54 (`d322de7`). Implemented in the recovery batch: binary engine checkpoints make pathless documents recoverable, including dirty documents with no commands. Missing/failed recovery retains the record.

**Evidence: reproduced, A04.**

[SaveService.ts:688](D:/Projects/ynotPDF/src/renderer/modules/M21-save/SaveService.ts:688) explicitly discards a recovery record with no source path and returns false. The record stores a journal, not the bytes needed to reconstruct a newly created document. A04 autosaved a dirty pathless document, recovered it, and observed the recovery store drop from one record to zero without restoration.

This applies to edited documents created from images/text/clipboard, embedded PDFs opened in tabs, and dropped files whose path is deliberately null. A newly created document may also be dirty without journal entries; the recoverable-record filtering needs to account for that state.

**Recommendation:** persist a recoverable base for pathless documents and content blobs used by their commands. Keep unrecoverable records available for retry/export rather than deleting them as a side effect of a failed recovery attempt. Test a new PDF with and without subsequent commands, an embedded PDF, and a dropped file, including after a first Save As.

**Claude Audit Comments:** Confirmed at [SaveService.ts:689](src/renderer/modules/M21-save/SaveService.ts:689). The path is explicit: no `record.path`, show a toast, `discard()`, return false.

The user-facing wording deserves attention separately from the architecture. The toast says the document _"was never saved, so there is no file to put the changes back into."_ Because of finding 7, this fires for documents that **were** saved — the file exists, the record's path is just stale null. The user is told a falsehood and their record is deleted on the strength of it. That combination is what makes this pair P1 rather than two independent P2s.

On the recommendation: agree, and the smallest correct first step is simply **not deleting the record**. Persisting base bytes for pathless documents is real work with a storage-budget question attached (how many unsaved documents, how large, evicted when?). Removing the `discard()` call and leaving the record visible for retry or manual export is a one-line change that converts silent data loss into a recoverable inconvenience, and it can ship while the durable-base design is still being agreed.

The finding's last sentence is easy to skim and is important: a newly created document can be dirty with an _empty_ journal. Any "is this record worth keeping" filter based on `journal.entries.length > 0` will drop exactly the documents that most need keeping.

## 9. P1 — Existing annotation edits can be counted as recovered without being restored

**Codex resolution (12 September 2026):** Merged in PR #54 (`d322de7`). Implemented in the recovery batch: checkpoint restoration installs model IDs, bindings and loaded state before attachment, avoiding lazy-target replay. The legacy journal API now counts actual model changes; a missing annotation target is reported skipped. Real annotation save/recovery tests verify restored edits.

**Evidence: reproduced using the actual model/commands with the fake engine fixture, A05.**

Annotations are loaded lazily. [SaveService.ts:698](D:/Projects/ynotPDF/src/renderer/modules/M21-save/SaveService.ts:698) opens a document and immediately replays the journal, without hydrating the original annotations required by the commands. [UpdateAnnotationCommand](D:/Projects/ynotPDF/src/renderer/core/commands.ts:534) returns when the target annotation is absent. [Journal.ts:173](D:/Projects/ynotPDF/src/renderer/core/Journal.ts:173) counts a completed `apply()` as an applied change, even if it changed nothing.

A05 edited an existing note, serialized the journal, replayed it into a freshly opened unhydrated document and received `applied: 1`. Loading the annotations afterward still returned the original note contents.

**Recommendation:** give replay explicit hydration and target-resolution requirements. Original-object references must survive a new session and a different page-loading order; a session-generated identifier is not sufficient unless its allocation is demonstrably stable. Treat a missing expected target as a recovery problem, not a successful no-op. Test real multi-page PDFs with annotations loaded in different orders and exercise update/delete/reply operations.

**Claude Audit Comments:** Confirmed, and I'd generalise it harder than the finding does. The specific defect is annotations, but the mechanism lives in `Journal`, not in M30:

[Journal.ts:173](src/renderer/core/Journal.ts:173) counts a completed `apply()` as an applied change. [UpdateAnnotationCommand](src/renderer/core/commands.ts:534) returns quietly when its target is absent. Put together: **any command whose target is lazily loaded will report success against an unhydrated document.** Annotations are just the subsystem where lazy loading is most visible. Form fields, embedded files, outline entries and object records deserve the same check before this is called fixed — probe A05 establishes the pattern, not its extent.

That argues for fixing this at the `Journal`/`Command` seam rather than in each command: a replayed command should have to _declare_ that it found its target, so "applied" means "did something" rather than "did not throw". A `CommandApplyResult` of `applied | target-missing | skipped` makes every instance visible at once, and turns finding 10's "recording a skipped count is not a substitute" complaint into something the journal can actually express.

On identity: the recommendation is right that a session-generated identifier is insufficient. Where an annotation came from the file, the PDF object number is a durable key and should be preferred. Where it was created in this session it has no file identity yet — so the journal must distinguish "refers to an object that existed in the base" from "refers to an object an earlier journal entry created". Those are different resolution problems, and conflating them is how this class of bug persists.

## 10. P1 — Portfolio edits have no recovery codecs or persisted attachment blobs

**Codex resolution (12 September 2026):** Merged in PR #54 (`d322de7`). Implemented through the shared checkpoint format rather than portfolio command replay: portfolio state, cover engine bytes and attachment blobs persist together. Real recovery/save tests verify replacement and added attachment bytes exactly. Binary content is SHA-256 addressed and checked on read.

**Evidence: reproduced codec lookup, A07; traced serialization and save-plan behaviour.**

[M42 commands](D:/Projects/ynotPDF/src/renderer/modules/M42-portfolios/commands.ts) define the portfolio command identifiers and serialize command data, but do not register corresponding journal codecs. A07 checked every exported portfolio command identifier and found no codec. Files added or replaced in a portfolio also depend on in-memory blobs, which the current recovery record does not persist.

Consequently, recovery cannot reconstruct a portfolio's editing session merely from the JSON journal. Recording a skipped count is not a substitute for recovering the embedded files. This is a priority for Tony because portfolios are a core workflow.

**Recommendation:** define durable serialization for portfolio structure and binary inputs together, including cover-sheet replacement and embedded-file replacement. Preserve the original embedded bytes exactly where that is the contract. Add crash-recovery round trips for add/remove/rename/move/replace, then compare recovered embedded files byte-for-byte. Coordinate this with finding 6 rather than designing a second incompatible checkpoint system.

**Claude Audit Comments:** Confirmed — I checked the exported command identifiers in [M42 commands.ts](src/renderer/modules/M42-portfolios/commands.ts) against the codec registry and found no registrations, matching A07.

Agree strongly with "coordinate this with finding 6 rather than designing a second incompatible checkpoint system." I'd go further: portfolios are the finding that _determines_ what finding 6's design has to be. The journal-rebasing approach I suggested there is sufficient for rotations and metadata edits, whose commands are self-describing JSON. It is **not** sufficient here, because a portfolio command's input is a binary blob that exists only in memory. No amount of journal cleverness recovers bytes that were never persisted.

So the shape of the answer is fixed by this finding: recovery needs a binary side-car store, not just a JSON journal. Concretely — content-addressed blobs written next to the recovery JSON, with journal entries referencing a hash rather than inlining base64. The JSON stays small and readable (worth a lot during an incident), deduplication is free when the same file is added twice, and eviction has a natural story. It is also exactly what finding 8's pathless-document base bytes need, so the two should share one store and be built once.

One caution on "preserve the original embedded bytes exactly where that is the contract": confirm that it _is_ the contract before building to it. If ynotPDF ever re-compresses an embedded stream on save, byte-for-byte comparison becomes the wrong acceptance test and will be quietly relaxed later — which is worse than never having asserted it.

## 11. P2 — Recovery's source-change check is incomplete and occurs after replay

**Codex resolution (12 September 2026):** Merged in PR #54 (`d322de7`). Implemented alongside recovery: source identity is captured before the opening buffer is transferred and covers every byte. Changed or unverifiable destinations open as pathless recovery copies. Legacy journal-only records are never automatically applied to an uncertain base.

**Evidence: reproduced fingerprint weakness, A06; traced initialization and replay order.**

[SaveService.ts:291](D:/Projects/ynotPDF/src/renderer/modules/M21-save/SaveService.ts:291) initializes an adopted document's source fingerprint to null. The ordinary initial `refreshPath()` probes permissions and starts watching; it does not populate the fingerprint. Thus a first editing session can have no source identity recorded at all.

[recovery.ts:82](D:/Projects/ynotPDF/src/renderer/modules/M21-save/recovery.ts:82) hashes only the first and last MiB of a file larger than 4 MiB. `sameSource()` ignores `modifiedAt`. A06 changed a byte in the middle of a 5 MiB buffer and changed its mtime, yet the comparison reported the same source. This is a change-detection failure; the hash is explicitly not intended as a security boundary.

Finally, `replayRecord()` determines/report flags after applying the journal. It does not give the reader a pre-replay decision as the file's opening comment promises.

**Recommendation:** fingerprint the exact source at adoption, use a complete identity/checkpoint strategy, and compare before mutation. Treat missing identity as unknown. Offer a safe recovery copy or a clear decision on mismatch. Do not rely on the assertion that every PDF writer necessarily changes the file's ends or length.

**Claude Audit Comments:** Confirmed on all three sub-points. `SAMPLE_BYTES` is 1 MiB and the whole-file threshold is `SAMPLE_BYTES * 4`, so the audit's "larger than 4 MiB" is exact. [sameSource()](src/renderer/modules/M21-save/recovery.ts:87) compares `size` and `hash` and never reads `modifiedAt`.

Worth flagging explicitly, because it is the kind of thing that survives a fix: the doc comment at [recovery.ts:70-74](src/renderer/modules/M21-save/recovery.ts:70) states the head+tail sampling "catches every edit a PDF writer makes (the header, the trailer and the length all move)". That claim is load-bearing — it is the stated justification for not hashing the middle — and it is false for the case that matters. It holds for _ynotPDF's own_ full-rewrite writer. It does not hold for an external tool doing an in-place update on a linearized file, which is precisely the "someone else edited this while I had it open" scenario the check exists to detect. Fix the comment as well as the code, or the next person re-derives the same shortcut.

A structural point the finding doesn't make. Even with `sameSource()` changed to compare `modifiedAt`, it still would not work: `recoverOne()` calls `fingerprintBytes(file.bytes)` at [SaveService.ts:700](src/renderer/modules/M21-save/SaveService.ts:700) with no `modifiedAt` argument, so it defaults to `0`. One side of the comparison structurally cannot carry an mtime. Both the function and its call site need changing, and `modifiedAt === 0` must be treated as "unknown" rather than as a value.

Cheap interim improvement while the full identity/checkpoint design is pending: add a third sample from the middle and include `size` in the hashed input. A few lines, no read-time cost, and it closes the reproduced A06 case.

## 12. P1 — Atomic saving ignores short writes and flush failures

**Codex resolution (12 September 2026):** Merged in PR #54 (`d322de7`). Implemented alongside checkpoint storage: atomic writes complete short writes, reject zero progress and flush failures, propagate directory errors and clean up temp files. Six filesystem fault tests verify complete output or an intact original.

**Evidence: reproduced with filesystem fault injection, A10.**

[atomic.ts:63](D:/Projects/ynotPDF/src/main/fs/atomic.ts:63) calls `handle.write(bytes)` once without checking `bytesWritten`, suppresses a `sync()` error, then renames the temporary file over the destination and reports the requested byte length. The intended contract explicitly promises a complete, flushed replacement.

A10 made the write report one byte for a four-byte input and made sync throw an I/O error. The function still renamed and returned four bytes written. This is a fault-path reproduction, not a claim that a normal save on Tony's disk was truncated. A write exception before the rename block also falls outside the later temporary-file cleanup catch.

**Recommendation:** write the complete buffer, propagate durability errors, close reliably, and clean up temporary files on every failed path. Never replace the original or report success after an incomplete write or failed flush. Test short writes, zero-progress writes, disk-full, sync failure, rename failure and backup failure; assert original bytes remain intact. Document the actual filesystem durability guarantees rather than promising more than the implementation provides.

**Claude Audit Comments:** Confirmed — and this is the finding where the code most clearly contradicts its own documentation. [atomic.ts:1-11](src/main/fs/atomic.ts:1) promises the bytes "are flushed to the platter, and only then does a rename put them in place", and the inline comment at [line 58](src/main/fs/atomic.ts:58) says the flush exists because "a power cut then leaves an empty file where the document was — the exact failure this whole dance exists to prevent." The very next line is:

```ts
await handle.sync().catch(() => undefined);
```

That is strong evidence of an oversight rather than a considered trade-off, which settles how much design discussion it needs: none. Propagate the error.

Three additions to the finding:

1. **`mkdir` failure is swallowed too.** [atomic.ts:54](src/main/fs/atomic.ts:54) does `mkdir(...).catch(() => undefined)`. The subsequent `open(temp, 'wx')` then fails with a confusing `ENOENT` instead of the real reason. Cheap to fix while in here.
2. **The temp file leaks on a write or sync throw.** The `finally` at [line 61](src/main/fs/atomic.ts:61) closes the handle but does not unlink; only the _rename_ block has cleanup. A repeatedly failing save therefore litters `.name.ynot-tmp-*` files beside the user's document, and `tempPathFor()` makes each one unique, so they accumulate rather than overwrite.
3. **`TRANSIENT` includes `EEXIST`.** [atomic.ts:80](src/main/fs/atomic.ts:80) retries rename on `EEXIST` for a third of a second. On the Windows path that is defensible, but it deserves a comment saying why — `EEXIST` on a rename-over is not obviously transient the way `EBUSY` is.

On the short write itself: `handle.write(bytes)` returning fewer bytes is rare but real for large buffers on some platforms. `writeFile(handle, bytes)` from `node:fs/promises` loops internally and is the drop-in fix — no manual loop needed.

## 13. P1 — Combining PDFs loses their AcroForm field tree without a warning

**Codex resolution (12 September 2026):** Implemented in the current audit branch; CI/merge pending. Combine refuses catalog-owned forms, name trees, layer configuration and accessibility tags/marking that cannot yet be preserved. It creates no partial output and tells Tony to keep the files separate or use a portfolio. This is explicit loss prevention, not form/tag merging. Unit cases cover catalog structures; the real-app form refusal regression passes.

**Evidence: reproduced with real PDF bytes and pdf-lib, A16.**

[combine.ts:139](D:/Projects/ynotPDF/src/engine/ops/combine.ts:139) copies source pages into a new document, but does not merge the catalog's AcroForm field tree. A16 generated a one-page PDF with one text field, combined it, and reopened the result: one page remained, but `getForm().getFields()` returned zero. There were no warnings. A retained widget appearance can make the result look acceptable while interactive form functionality is gone.

**Recommendation:** implement a deliberate form-merging policy, including duplicate field names, widget parents, page references, default resources and appearance states. If interactive form preservation is unsupported, detect that input and explain/offer the chosen alternative rather than silently producing it. Test two forms with both distinct and duplicate names, checkbox/radio groups and subsequent editing in ynotPDF. Inspect other page-copy operations for the same catalog-versus-page distinction; this probe establishes the combine defect, not every related operation.

**Claude Audit Comments:** Confirmed at [combine.ts:139](src/engine/ops/combine.ts:139): `out.copyPages(entry.doc, [...entry.pages])` copies page objects and their resources, and pdf-lib does not carry the catalog's `/AcroForm` across — by design, since the field tree is document-level.

The framing I'd add: **forms are one instance, not the whole problem.** The tell is in this same function — `combine()` already handles `/Outlines` explicitly, remapping bookmark destinations to their new page indices ([combine.ts:155-160](src/engine/ops/combine.ts:155)). Whoever wrote that understood catalog-owned structures need deliberate handling; the list just wasn't enumerated. The others a combine silently drops, or should explicitly decide about:

- `/AcroForm` — the reported finding.
- `/Names` — embedded files (portfolio-adjacent, and a core workflow here), plus named destinations that page-level link annotations point at. Dropped named destinations turn working internal links into dead ones, which reads as a rendering bug rather than a combine bug.
- `/OCProperties` — optional content groups. Layers survive at page level as marked content but lose their visibility configuration, so a layered drawing can come out with every layer visible at once.
- `/StructTreeRoot` and `/MarkInfo` — tagging. Combining two tagged, accessible PDFs currently produces an untagged one. That is an accessibility regression no current test would catch.

So the recommendation should be: enumerate the catalog-owned structures, write a per-structure policy (merge / drop-with-warning / refuse), and make the default _warn_ rather than _silent_. Then audit the other page-copy operations — the finding is right that this probe establishes combine, not everything.

A practical note on the forms work specifically: duplicate field names are the hard case, and the semantics are genuinely ambiguous. In the PDF spec two widgets sharing a fully-qualified name are _the same field_ and share a value — so merging two copies of one form is either "one field, linked values" or "rename to make them independent", and both are defensible. Pick one, document it, and expose it as an option rather than guessing.

## 14. P1 — Bulk extraction silently overwrites colliding or existing files

**Codex resolution (12 September 2026):** Implemented in the current audit branch; CI/merge pending. Extraction reserves each leaf with exclusive creation and returns the actual numbered name for collisions, including sanitised and case-only names. A partial-write fault removes only the newly created incomplete leaf; the pre-existing file remains byte-identical and retry succeeds.

**Evidence: reproduced on scratch files, A15.**

[files.ts:156](D:/Projects/ynotPDF/src/main/files.ts:156) sanitizes path segments and writes with `writeFile()`'s replacement behaviour. [PortfolioService.ts:798](D:/Projects/ynotPDF/src/renderer/modules/M42-portfolios/PortfolioService.ts:798) calls that helper for extracted files without a collision decision.

A15 extracted `a:b.txt` and `a?b.txt`: both became `a_b.txt`, and the second replaced the first. Existing destination files can likewise be overwritten. Case-insensitive filesystems add another class of collisions even when names contain no prohibited character.

**Recommendation:** plan the complete output naming map after sanitization and filesystem normalization. Detect existing files and collisions within the operation, then provide explicit replace/skip/rename behaviour. Use exclusive creation for the default safe path and handle races. Test case-only differences, reserved names, sanitization collisions, nested paths and a pre-existing destination. Do not claim “extracted all” if files were overwritten or skipped without accounting for them.

**Claude Audit Comments:** Confirmed. [files.ts:168](src/main/files.ts:168) is a plain `writeFile(target, bytes)`, whose replace-on-exist behaviour is right for a single deliberate save and wrong for a bulk extract.

The structural reason points at the fix: `writeInto()` is called **once per file** and has no view of the operation. It cannot detect a collision between two files in the same extract because it never sees the second while the first is pending. So no amount of hardening inside `writeInto()` solves the A15 case — the naming map has to be computed in `PortfolioService` _before_ any write, across the full set, after sanitisation and after filesystem normalisation.

Two additions:

- `writeInto()` should also gain an exclusive mode — `open(target, 'wx')` rather than `writeFile` — as the default. That handles the pre-existing-destination case and the race between planning and writing, which a plan alone cannot.
- The finding mentions case-insensitive filesystems; add Unicode normalisation to the same list. macOS normalises filenames to NFD, so composed and decomposed `café.pdf` collide there and not on Windows. Any dedup map keyed on the raw string behaves differently per platform.

The closing sentence — don't report "extracted all" if files were overwritten or skipped — connects this to finding 2. The honest outcome type for a bulk operation is a per-file result list, not a boolean.

## 15. P1 — Extraction can follow a junction outside the selected directory

**Codex resolution (12 September 2026):** Implemented in the current audit branch with ADR 0025; CI/merge pending. Chosen roots are canonical existing directories, linked child folders are rejected, and containment is checked before writing. Native junction and missing-root tests pass. This does not claim resistance to another local process swapping directories between filesystem calls.

**Evidence: reproduced on Windows entirely inside the audit scratch area, A09; known in the hardening notes.**

[files.ts:161](D:/Projects/ynotPDF/src/main/files.ts:161) checks lexical path containment. Subsequent directory creation and writing follow filesystem links. A09 created `selected/linked` as a junction to another scratch directory, then extracted `linked/audit.txt`. The bytes were written outside `selected`, despite the containment check.

The precondition is a linked path component or target in the chosen output tree. This is not an assertion that an arbitrary PDF can create a junction on its own. It violates the helper's documented promise about writing only inside the chosen directory.

**Recommendation:** implement the canonical-path and link protections already discussed in [renderer-filesystem-boundary.md](D:/Projects/ynotPDF/docs/security/renderer-filesystem-boundary.md), including intermediate components and existing target files. Account for replacement races and Windows path normalization. Keep this actual junction reproduction alongside macOS/Linux symlink tests and root-directory cases. Do not repeat the reverted implementation's inconsistent canonicalization.

**Claude Audit Comments:** Confirmed. [files.ts:164-165](src/main/files.ts:164) is purely lexical:

```ts
const target = resolve(base, ...segments);
const inside = target === base || target.startsWith(base.endsWith(sep) ? base : base + sep);
```

`resolve()` normalises `..` and separators; it never consults the filesystem, so a junction or symlink anywhere in the chain defeats it. A09's reproduction is the expected result rather than a surprise.

The precondition stated here is the right one and should survive into any ticket: this needs a linked component _already present_ in the chosen output tree. It is not "a PDF can write anywhere on your disk". That distinction is what makes this P1-by-contract-violation rather than P1-by-exploitability.

An adjacent fragility in the same function, not mentioned in the finding, worth fixing in the same change. [files.ts:167](src/main/files.ts:167) derives the parent directory by string arithmetic:

```ts
const parent = target.slice(0, target.length - (segments.at(-1)?.length ?? 0));
```

This assumes the sanitised last segment appears verbatim at the end of the resolved path. It holds today, but it is coupled to `safeFileName`'s current behaviour in a way nothing tests — if sanitisation ever changes length, or the last segment normalises differently under `resolve()`, this silently creates the wrong directory. `dirname(target)` is correct and free.

On the fix itself: `realpath` the parent after `mkdir` and re-check containment against a `realpath`'d base, then create the leaf with `wx` so an existing symlink at the target is not followed. The warning about "the reverted implementation's inconsistent canonicalization" names the key risk — canonicalise _both_ sides, every time, or the check is worse than none, because it looks like protection.

## 16. P1 — Opening a non-PDF attachment delegates executable content directly to the OS

**Codex resolution (12 September 2026):** Implemented in the current audit branch; CI/merge pending. Main refuses executables, scripts, shortcuts, active web formats and unknown extensions before any OS handoff. Ordinary document types require native confirmation. The actual IPC regression proves refusal precedes confirmation, and Cancel precedes temporary-file creation/opening. HTTP(S) links are parsed and other protocols refused.

**Evidence: traced; no executable payload was launched.**

[NavigationService.ts:486](D:/Projects/ynotPDF/src/renderer/modules/M12-navigation-panels/NavigationService.ts:486) sends every non-PDF attachment to `shell:openTempFile`. [ipc.ts:359](D:/Projects/ynotPDF/src/main/ipc.ts:359) writes the bytes and calls `shell.openPath()` with no executable-type policy or application-level trust decision. Filename sanitization does not make an executable or script harmless.

A crafted attachment can therefore reach the operating system's handler when the user opens it. The actual effect depends on the platform, extension, file association and OS protections. This is a user-triggered path, not automatic execution on opening a PDF. The E2E branch returns the temporary path before `shell.openPath()`, so passing attachment UI tests do not validate the real OS-launch boundary.

**Recommendation:** define a conservative embedded-file opening policy in main, with dangerous executable/script/shortcut types blocked or routed to extraction and a clear trust decision for external opening. Test the policy with a mocked OS opener so no executable is run. Check all callers of the same IPC channel, not only the navigation panel.

**Claude Audit Comments:** Confirmed at [ipc.ts:359](src/main/ipc.ts:359). The sharpest evidence that this is an oversight rather than a decision sits four lines below it, in the same handler table:

```ts
'shell:openExternal': async (_e, url) => {
  if (!/^https?:\/\//.test(url)) throw new Error('Only http(s) URLs may be opened');
```

`shell:openExternal` has a scheme allowlist. `shell:openTempFile` — which writes attacker-supplied bytes to disk and hands the path to `shell.openPath()` — has no type policy at all. The security reasoning already exists in this file; it just wasn't applied to the handler that needs it more. That makes the fix an easy sell and gives it an obvious shape to copy.

One implementation note that also resolves a testability complaint the finding raises. The `E2E` early-return sits _between_ `writeTempFile` and `shell.openPath`. Put the type policy **before** the `E2E` branch and the E2E suite exercises the real policy with only the OS launch stubbed — exactly the coverage that is missing today, at no extra cost.

I'd widen the caller audit slightly: the risky input is any bytes originating inside a PDF, so the question is not only "who calls `shell:openTempFile`" but "which paths can reach it with document-derived content". [NavigationService.ts:486](src/renderer/modules/M12-navigation-panels/NavigationService.ts:486) is one; the portfolio "open attachment" affordances are the other place to check.

Policy suggestion, since the finding leaves it open: block by **allowlist**, not blocklist. The set of attachment types worth opening directly is small and enumerable (images, text, office documents, PDFs handled internally); the set of dangerous extensions is not, varies by platform, and grows. Everything outside the allowlist routes to "extract to a folder you choose" — a genuinely useful action rather than a dead end.

## 17. P2 — Annotation rich text retains arbitrary CSS and event attributes

**Codex resolution (12 September 2026):** Implemented in the current audit branch; CI/merge pending. Both incoming and outgoing rich note fragments use the same tag/attribute allowlist. Imported hostile PDF /RC tests pass: no form, iframe, image, duplicate app ID or positioning survives, while bold and colour data remain. Screenshot inspection additionally found dark authored text unreadable on the dark editor; an editor-only readable-colours toggle now preserves stored colours, verified by an all-theme contrast test, original-colour toggle, real saved-PDF colour assertion and inspected High Contrast screenshot.

**Evidence: reproduced string sanitization, A08; traced HTML sink.**

[NotePopup.ts:69](D:/Projects/ynotPDF/src/renderer/modules/M30-markup-annotations/NotePopup.ts:69) assigns `sanitiseRich(rich)` to `innerHTML`. [sanitiseRich](D:/Projects/ynotPDF/src/renderer/modules/M30-markup-annotations/NotePopup.ts:245) allows selected tag names without stripping their attributes. A08 directly verified that a paragraph with fixed positioning, a very high z-index, arbitrary colours and an `onclick` attribute survived. The serialization helper also retains attributes on some allowed tags.

The current [CSP](D:/Projects/ynotPDF/src/renderer/index.html:7) blocks inline script handlers, so **this audit did not demonstrate JavaScript execution**. Inline styles are allowed. Document-supplied styling can interfere with note layout, readability and potentially cover other controls, depending on the DOM's layout containment. This also bypasses the static theme checker because the values come from PDF content at runtime.

**Recommendation:** parse into a restricted document fragment, allow only necessary formatting elements and narrowly validated text-formatting properties, and strip all event, navigation and layout attributes. Serialize from that same normalized representation. Add real-browser tests confirming note formatting works while fixed/absolute positioning, oversized content, event attributes and controls outside the note remain unaffected.

**Claude Audit Comments:** Confirmed. [NotePopup.ts:245-248](src/renderer/modules/M30-markup-annotations/NotePopup.ts:245) is a single regex that filters **tag names only**:

```ts
return inner.replace(/<(?!\/?(b|i|u|br|p|span)\b)[^>]*>/gi, '');
```

A `<p style="position:fixed;z-index:99999" onclick="...">` matches the allow-list on its name and passes through with every attribute intact.

The observation that makes this much cheaper to fix than the recommendation suggests: **the outbound path is already strict, and the inbound path is not.** The `/RC` _encoder_ a few lines above ([NotePopup.ts:235-242](src/renderer/modules/M30-markup-annotations/NotePopup.ts:235)) normalises `<span>` and `<font>` down to a span carrying a single validated `color` — it parses the colour, rejects what doesn't parse, and reconstructs the tag from scratch. That is precisely the right technique. It exists in this file. It is simply not used when reading.

So the fix is not "adopt a sanitiser library" — it is "make `sanitiseRich` reconstruct tags the way `sanitiseTag` already does" — and the round-trip property worth having (parse → normalise → serialise, idempotent) follows naturally, because both directions would then share one normalised representation.

I agree with the finding's care about the CSP claim, and would add why it still matters at P2 despite no demonstrated script execution: the CSP at [index.html:7](src/renderer/index.html:7) is one meta-tag edit away from being relaxed for an unrelated reason, and nothing would connect that edit to this sink. Defence that depends on a policy declared in another file, with no test asserting the coupling, is not defence you can rely on through a refactor. Fixing the sanitiser makes the CSP a second layer rather than the only one.

## 18. P2 — Main-process filesystem IPC has no per-window path authority

**Codex resolution (12 September 2026):** Implemented in the current audit branch under ADR 0025; CI/merge pending. Privileged handlers require a registered window and its main frame. Native selections and explicit Recent opening grant canonical per-window read/write authority. Listing Recent and recovery JSON grant nothing; settings reveal remains read-only. Malformed payload, sender/frame, two-window and settings escalation tests pass. Dropped documents stay pathless until Save As.

**Evidence: traced; known and explicitly deferred.**

[preload/index.ts:23](D:/Projects/ynotPDF/src/preload/index.ts:23) restricts channel names, but exposes generic invocation arguments. [ipc.ts:149](D:/Projects/ynotPDF/src/main/ipc.ts:149) accepts renderer-selected paths for reads, writes and related operations. The handler registration at line 478 does not provide a central sender/path authorization layer. TypeScript types are not runtime validation.

A compromised or erroneous app renderer can request filesystem actions outside files the user selected. This is a defence-in-depth finding with that precondition; it is not proof that an ordinary PDF currently executes renderer JavaScript. The repository already describes the problem and a reverted attempt in [renderer-filesystem-boundary.md](D:/Projects/ynotPDF/docs/security/renderer-filesystem-boundary.md).

**Recommendation:** complete the documented ADR and capability design, with per-window grants derived from trusted selection/drop/open actions, runtime schemas, sender validation and consistent canonicalization. Keep recovery, recent files, export directories and root paths in the integration test plan. Update the E2E harness to earn explicit test grants rather than introducing broad production-handler bypasses. Preserve the dropped-file path fix that has already landed.

**Claude Audit Comments:** Confirmed, correctly labelled as known and deferred, and correctly labelled defence-in-depth rather than an active exploit.

What I'd add is a **sequencing** argument the repair order in section 31 doesn't make. Findings 14, 15, 16 and 18 are not four independent items — they are one item and three of its symptoms. All four are instances of "main accepts a renderer-supplied path or blob and acts on it with the app's full privileges":

- 14: renderer-supplied output names, no collision authority.
- 15: renderer-supplied relative path, lexical containment only.
- 16: renderer-supplied bytes and filename, no type authority.
- 18: no per-window path authority at all.

If 14, 15 and 16 are each patched in place first, every one of those patches becomes a candidate for rework when the capability layer lands — and the repository already has one reverted attempt in this area to show how that goes. I'd invert the order here: write the capability ADR first (it is a document, not a large implementation), then land 15 and 16 as its first two consumers, since both need a trusted-path and trusted-type decision the ADR has to define anyway. Finding 14 is mostly a naming-plan problem and can proceed independently.

The note that "TypeScript types are not runtime validation" deserves to stay prominent. [preload/index.ts:23](src/preload/index.ts:23) restricts channel _names_ but passes arguments through unvalidated, so the entire typed IPC surface is compile-time only. A runtime schema at the handler boundary is worth having on its own merits — it catches ordinary bugs, not just hostile input — and is a good first increment that delivers value before the full capability design is agreed.

## 19. P2 — A failed composite command can leave an untracked partial edit

**Codex resolution (12 September 2026):** Implemented in the current audit branch under ADR 0024; CI/merge pending. Composite failures compensate completed children in reverse order. Failed compensation records all errors and latches UndoStack integrity failure, preventing further mutation or save/checkpoint capture until the document is reopened. Fault tests cover apply, undo/redo and rollback failures; individual multi-step commands still own their internal rollback.

**Evidence: reproduced with a faulting child command, A11.**

[CompositeCommand.do()](D:/Projects/ynotPDF/src/renderer/core/Command.ts:76) applies children in order without rolling back completed children on failure. [UndoStack.push()](D:/Projects/ynotPDF/src/renderer/core/UndoStack.ts:85) records the composite only after its `do()` succeeds. A11 applied one child and failed the next; the mutation remained, `canUndo` was false and the stack was clean.

Composite commands are used in production form reset, transform, delete, duplicate and paste flows, as well as journal/group machinery. The reproduction establishes the transaction-contract problem, not that every current form child can throw at the same place.

**Recommendation:** specify failure atomicity for commands and composites. Roll back successfully applied children in reverse order, and define what happens if rollback itself fails. Commands that mutate several engine objects need their own equivalent guarantee. Test a failure after the first of several mutations and verify model, engine, dirty marker and journal agree. Include redo failure, not only initial application.

**Claude Audit Comments:** Confirmed at [Command.ts:77](src/renderer/core/Command.ts:77):

```ts
async do(): Promise<void> {
  for (const c of this.commands) await c.do();
}
```

I think this is under-prioritised at P2 — not because the consequence is worse than stated, but because the fix is unusually cheap and the machinery already exists. Look at the method immediately below: `undo()` at [Command.ts:81-87](src/renderer/core/Command.ts:81) already walks children in reverse with a null guard. Rolling back a failed `do()` means running that same reverse walk over the applied prefix:

```ts
async do(): Promise<void> {
  const applied: Command[] = [];
  try {
    for (const c of this.commands) { await c.do(); applied.push(c); }
  } catch (error) {
    for (let i = applied.length - 1; i >= 0; i--) await applied[i]?.undo().catch(() => {});
    throw error;
  }
}
```

That is close to the whole change, and it converts "silent untracked mutation" into "operation failed, nothing changed" for every production composite at once — form reset, transform, delete, duplicate, paste. I'd pull it out of the "transaction/worker resilience" batch and land it early as a small independent change with its own test.

The part that genuinely needs design, and should not block the above: what happens when the rollback itself throws. Swallowing it (as the sketch does) leaves the document inconsistent while reporting a clean failure — the same class of lie this finding is about. The honest answer is probably to mark the document unrecoverably dirty and force a Save As, but that needs a decision. Ship the common-case rollback first and treat rollback-failure as an explicit follow-up, rather than letting it hold up a six-line improvement.

The finding is right that the journal/group machinery uses composites too, so this also affects replay. Test redo-failure, not only first application — the recommendation says so, and it is the case most likely to be skipped.

## 20. P2 — Engine-worker initialization failure leaves readiness pending indefinitely

**Codex resolution (12 September 2026):** Implemented in the current audit branch under ADR 0024; CI/merge pending. Engine startup failure, crash and termination settle readiness and pending requests and reject later calls. Writer, operations, conversion, export and optimisation workers follow the same terminal-failure rule, including synchronous postMessage failure. Lifecycle regression tests pass.

**Evidence: reproduced using the supported fake-worker interface, A18.**

[EngineClient.ts:80](D:/Projects/ynotPDF/src/engine/EngineClient.ts:80) creates a readiness promise with no rejection path. Its error handler rejects existing requests but does not reject readiness or mark the client terminal. The M10 activation path awaits `client.ready()`.

A18 emitted an initialization error, then submitted another request. Readiness remained pending and the later request remained in the pending map. A worker that cannot start can therefore leave startup waiting; after a crash, later operations may hang until another lifecycle action intervenes.

**Recommendation:** model initializing/ready/failed/terminated states explicitly. Reject readiness and future calls with the stored failure, clear listeners, and make restart/recovery a deliberate service operation with user-visible status. Test a load failure before ready, failure with requests in flight, requests after failure and termination before ready. Apply the same review to the writer and other worker clients.

**Claude Audit Comments:** Confirmed at [EngineClient.ts:80](src/engine/EngineClient.ts:80):

```ts
this.readyPromise = new Promise<void>((resolve) => { ... });
```

The executor takes `resolve` only — there is no `reject` in scope, so the readiness promise has no failure path at all, by construction. The `error` listener a few lines down rejects `this.pending` and clears it, but cannot touch readiness.

**A second hang path the finding does not name.** `terminate()` sets `this.terminated = true`, but nothing in `ready()` consults that flag and `terminate()` does not settle `readyPromise` either. So `await client.ready()` hangs forever after an _explicit, successful_ termination too — not only after a crash. Anything that tears down and recreates an engine, or calls `ready()` on a client it does not realise has been terminated, waits indefinitely with no error and no timeout. That belongs in the same repair and the same test.

The recommended explicit state machine (`initializing | ready | failed | terminated`) is the right shape and fixes both paths: `ready()` returns a promise derived from the state, and every terminal state settles it. I'd add one requirement — the stored failure must be _replayed_ to late callers, not only delivered to those already waiting, or a `ready()` called after the failure has been handled hangs exactly as it does now.

Agree about applying the same review to the writer worker client. "Promise with `resolve` only" is an easy pattern to repeat and an easy one to grep for.

## 21. P2 — Image export uses accessibility permission instead of ordinary copying permission

**Codex resolution (12 September 2026):** Implemented in the current audit branch; CI/merge pending. Both image-export commands now require ordinary copy permission, matching text/HTML/RTF export. Standard-password and certificate-recipient UI cases enforce denied exports and owner-authorised output. This gate is separate from M92’s image-fidelity repair.

**Evidence: traced command declarations and permission mapping.**

[M92 manifest:139](D:/Projects/ynotPDF/src/renderer/modules/M92-export/manifest.ts:139) and [line 220](D:/Projects/ynotPDF/src/renderer/modules/M92-export/manifest.ts:220) mark page-image export and embedded-image export as `extract-for-accessibility`. Text, HTML and RTF export use `copy`.

For a restricted document allowing accessibility extraction but disallowing ordinary copying, this permits general image export, including user-selected page rendering resolution and original embedded images. Those actions are not themselves assistive access. The current mapping makes the permission choices inconsistent across export formats.

**Recommendation:** assign ordinary content export the appropriate copying permission and retain accessibility-specific permission for actual assistive access. Add a permission matrix using an existing protected file: copy denied/accessibility allowed, both denied, ordinary user versus owner. Test actual command enablement and execution. This finding concerns the application's declared permission behaviour, not an assertion that PDF permissions prevent extraction by all other software.

**Claude Audit Comments:** Confirmed: [manifest.ts:139](src/renderer/modules/M92-export/manifest.ts:139) and [manifest.ts:220](src/renderer/modules/M92-export/manifest.ts:220) declare `extract-for-accessibility`, while the text, HTML and RTF exports at lines 256, 304 and 347 declare `copy`. The inconsistency is real and the reasoning is correct — rendering pages to PNG at a user-chosen resolution is content copying, not assistive access.

This is the cheapest fix in the entire report: two string literals and a permission-matrix test. For that reason I'd move it to the **front** of the repair queue rather than leaving it at position 21. It is self-contained, touches no shared contract, and landing it early gives the security work a green tick that costs nothing while findings 1-12 are still being designed.

Two adjacent mappings worth confirming in the same pass:

- Print declarations — PDF distinguishes `print` from `print-high-res` (faithful printing), and a degraded-print restriction is easy to map to the wrong one.
- Whether any export command declares _no_ permission at all. An absent declaration is the form this bug takes when nobody has written a matrix test, and it is invisible in a diff.

The closing caveat is correct and worth carrying into the commit message: this is about ynotPDF honouring its own declared permission model, not a claim that PDF permissions are an enforcement boundary against other software. Getting that distinction into the repository's own words will stop someone later arguing the whole mapping is pointless.

## 22. P2 — Recovery bypasses the normal password and digital-ID opening flow

**Codex resolution (12 September 2026):** Implemented in the current audit branch under ADR 0026; CI/merge pending. Open, recovery and reload share certificate preparation and password retry. Actual crash tests verify wrong-password/Cancel retains the record, retry restores edits, and certificate checkpoints retain recipient restrictions without owner authority. An ungranted remembered path restores as a pathless copy. Certificate working checkpoints are already decrypted local copies; no claim of encrypted archival recovery is made.

**Evidence: traced; separate from the reproduced plaintext-save issue.**

[SaveService.ts:698](D:/Projects/ynotPDF/src/renderer/modules/M21-save/SaveService.ts:698) invokes `DocumentService.open()` directly without a password. [DocumentService.ts:91](D:/Projects/ynotPDF/src/renderer/modules/M20-document-model/DocumentService.ts:91) opens through the engine. The password retry and certificate preparation logic instead live in [ViewerService.open()](D:/Projects/ynotPDF/src/renderer/modules/M11-viewer/ViewerService.ts:212).

An encrypted source requiring an open password, or a certificate-protected source PDFium cannot read directly, therefore does not get the normal authentication workflow during recovery. The catch reports failure rather than offering the password/digital-ID flow. The record is retained on this exception, which is better than deletion, but Recover cannot complete through this path.

**Recommendation:** factor a shared document-opening/authentication service usable by normal open, recovery and reload without losing their different UI requirements. Test recovery of both password- and certificate-protected sources, wrong credentials, cancellation and successful retry; retain records until the complete recovered state is safely available. Never persist the credentials in recovery JSON as a workaround.

**Claude Audit Comments:** Confirmed at [SaveService.ts:698](src/renderer/modules/M21-save/SaveService.ts:698) — `this.docs.open(...)` is `DocumentService.open()`, which goes straight to the engine, while the password-retry and digital-ID flow lives in `ViewerService.open()`.

The generalisation worth drawing: this is not a mistake `SaveService` made, it is a mistake the **module surface invites**. There are two exported functions called `open()`, they differ in capability rather than in name, and the weaker one is the one reachable through `DOCUMENT_SERVICE`. Any future caller — reload-on-disk-change, compare, batch, the planned CLI — picks the wrong one for the same reason, and the symptom (protected files simply fail to open in that one feature) is obscure enough to sit unreported for a long time.

So I'd strengthen the recommendation: don't merely _factor out_ a shared authenticated-open service — **make the unauthenticated one unexported** and private to M20. If the raw path stays reachable, the next caller reaches for it. The differing UI requirements the recommendation mentions are real, but they are a parameter (who supplies the prompts), not a reason for two public entry points.

Agree that retaining the record on this exception is the better behaviour and should be preserved when this is fixed. It is the one place in the recovery code that fails safe, and it would be easy to lose in a refactor.

The instruction never to persist credentials in recovery JSON should be written into the recovery record's own doc comment, not only into this report — it is exactly the shortcut a future implementer reaches for when trying to make encrypted-source recovery work end to end.

## 23. P2 — The shortcut-sheet determinism test can depend on crossing a clock second

**Codex resolution (12 September 2026):** Already resolved by PR #49 before this repair series, as Claude noted below. No duplicate fix planned.

**Evidence: observed current macOS CI failure; reproduced metadata nondeterminism, A19.**

PR 47's pull-request CI macOS job failed in [shortcuts.test.ts:318](D:/Projects/ynotPDF/test/unit/preferences/shortcuts.test.ts:318), “is deterministic for the same rows and date,” reporting 1667 bytes versus 1666. The audit retrieved the job log; this is distinct from the public-key wrong-AES-key test being repaired in that PR.

[cheatsheet.ts:162](D:/Projects/ynotPDF/src/renderer/modules/M130-preferences/shortcuts/cheatsheet.ts:162) creates a PDF with pdf-lib's current-time metadata. The supplied `options.date` controls visible text but does not fix PDF creation/modification dates. A19 held the supplied date constant and moved the clock by one second; the output metadata and bytes changed. This provides a concrete mechanism consistent with the observed CI failure, although the CI log alone does not identify its exact timestamp values.

**Recommendation:** if deterministic output is the contract, use the supplied date consistently for metadata and compare bytes/content meaningfully. If determinism is not a product requirement, test stable content and layout rather than compressed output length. In either case, explicitly cross a clock boundary in the regression test so the test does not pass by running twice within one second. Do not fix this by adding a retry or weakening the length tolerance.

CI evidence: [failed macOS job](https://github.com/tonybaynes/ynotPDF/actions/runs/34595278126/job/103249575440).

**Claude Audit Comments: this finding is FIXED — read it as closed.** It landed after the audit snapshot was taken, in `fix/cheatsheet-determinism` (commit `5d63269`, merged as `e166c4a`, now in `main` at `8d9989f`).

The current code stamps the supplied date into the document's own metadata at [cheatsheet.ts:169-171](src/renderer/modules/M130-preferences/shortcuts/cheatsheet.ts:169):

```ts
const stamp = options.date ?? new Date();
doc.setCreationDate(stamp);
doc.setModificationDate(stamp);
```

and the same `stamp` feeds the visible date text, so there is now one date rather than two.

The test at [shortcuts.test.ts:322](test/unit/preferences/shortcuts.test.ts:322) took the audit's advice precisely, and is worth pointing at as a model for the other repairs:

- it **moves the fake clock 37 seconds between the two builds**, so it cannot pass by running twice inside one second — the specific trap this finding warned about;
- it compares a **digest of the bytes**, not a length, so the assertion means what it says;
- its comment records the actual CI failure (`expected 1667 to be 1666`) and explicitly names the wrong diagnosis it rules out — "not a macOS quirk, just the slowest runner in the matrix being the one most likely to straddle a second".

The audit's two "do not" instructions — don't add a retry, don't widen the length tolerance — were both followed. This is the one finding whose recommendation can be checked against the resulting change, and it came out well.

## 24. P2 — The licence gate does not faithfully enforce the written dependency policy

**Codex resolution (12 September 2026):** The technical gate is implemented in the current audit branch; CI/merge pending. A real SPDX parser preserves grouping, arrays require every obligation, MPL is refused and UNLICENSED is root-only. Build manifests now include bundled dev dependencies and workers; font/opaque-binary hashes and packaged notices are inventoried. The strict licenses:release gate intentionally rejects currently incomplete wrapper/compiled-component notice reviews. Those distribution prerequisites remain open for M131; see docs/security/artifact-notices.md. Package metadata is not treated as a distribution-rights decision.

**Evidence: source inspection; current production inventory passed.**

[check-licenses.ts:25](D:/Projects/ynotPDF/scripts/check-licenses.ts:25) includes `MPL-2.0` despite the project's stated no-copyleft/permissive-only policy. It also allows `UNLICENSED` for every package although the comment says that exception is for the private root package.

The expression parser strips parentheses and, whenever it sees any `OR`, accepts the expression if any flattened term is allowed. That loses the meaning of mixed expressions such as `(MIT OR Apache-2.0) AND GPL-3.0`. These are defects in a policy gate, not evidence that the current shipped dependency set contains those problematic examples.

The production-only npm inventory also does not, by itself, establish the provenance and notices of everything bundled by build tooling or downloaded separately. Electron, fonts, icons, WASM assets and copied resources need their corresponding inventory/credits checks. The project already has resources and attribution records to build on.

**Recommendation:** parse SPDX expressions with their actual grouping, make exceptions package-specific, and align allowed identifiers with the policy Tony chooses. Verify the packaged artifact's complete component/notice inventory in the release gate. Keep this technical check separate from decisions about distribution rights. The current `npm run licenses` result was 44 production packages accepted; no contrary claim about a currently installed package is made here.

**Claude Audit Comments:** Confirmed on all three counts at [check-licenses.ts:48-55](scripts/check-licenses.ts:48). `MPL-2.0` and a blanket `UNLICENSED` are both in `ALLOWED`, and the flattening is as described — I traced the report's own example, `(MIT OR Apache-2.0) AND GPL-3.0`: parentheses are stripped, `FORBIDDEN` is skipped because the string contains `OR`, the expression splits on both operators into `[MIT, Apache-2.0, GPL-3.0]`, and `.some()` passes it on `MIT`. A GPL obligation is accepted silently.

**A fourth defect in the same function, not in the finding.** Two lines above the parser:

```ts
const lic = Array.isArray(entry.licenses)
  ? entry.licenses.join(' OR ')
  : (entry.licenses ?? 'UNKNOWN');
```

When `license-checker` reports an array — which it does when a package declares multiple licences, including the `AND`-style "comply with all of these" case — this **converts the list into a disjunction** before parsing. Combined with the `.some()` behaviour above, a package reported as `["MIT", "GPL-3.0"]` passes on `MIT`. That is the same failure as the parenthesis bug arriving through a different door, so fixing only the parser would leave it open.

Recommendation: don't repair the regex. `spdx-expression-parse` plus `spdx-satisfies` are small, permissively licensed, and give correct `AND`/`OR` grouping for free — and correctness is the entire point of this gate. A hand-rolled parser that has produced four distinct defects in about eight lines is giving the usual signal.

Agree that the npm production inventory does not cover Electron, fonts, icons, WASM and copied resources, and that this is separate work from the SPDX parsing. The finding's separation of "technical check" from "distribution rights decisions" is the right line to hold — an automated gate should never be the thing that decides a licensing question.

## 25. P2 — macOS and Linux screenshot comparisons still skip without baselines

**Codex resolution (12 September 2026):** PR #65 implements the agreed alternative to unstable cross-platform pixel baselines: geometry, contrast, keyboard focus and native-value fit checks across four themes and three scales, with retained screenshots. Existing Windows pixel baselines/tolerances remain. Screenshot inspection found and repaired status-bar overlap and truncated export values. After integration with merged M11, 32 focused UI tests and 331 affected unit tests pass; final platform CI/merge remains pending.

**Evidence: inspected committed snapshot inventory and test skip logic; known coverage gap.**

[visual.spec.ts:77](D:/Projects/ynotPDF/test/e2e/visual.spec.ts:77) skips screenshot comparisons on a platform without seeded images. The committed baselines are Windows-only. Consequently, successful macOS/Linux UI jobs do not demonstrate those ten screenshot comparisons passed. Other layout, keyboard, theme and UI tests on those platforms still provide real coverage.

The previously criticized 15% pixel allowance has already been reduced to **4%**, with a per-pixel threshold of 0.35. Do not report the old 15% value as current. The local Windows comparisons passed in this audit, but cross-machine calibration comes from CI, not comparison against the same machine's baselines.

**Recommendation:** seed and review platform-specific baselines on their actual rendering environments. Keep geometry, contrast and keyboard assertions alongside images. Report skipped comparisons explicitly in CI summaries. Include larger UI scale and representative newly added tools; ten screenshots at one size are a useful guard, not complete accessibility verification.

**Claude Audit Comments:** Confirmed as an accurate description of a known gap, and the correction about the pixel allowance — 4% with a 0.35 per-pixel threshold, not the previously reported 15% — is the kind of thing that keeps a report trustworthy. Worth preserving.

I'd register a mild dissent on the recommendation, because "seed platform-specific baselines on their actual rendering environments" carries a cost the finding doesn't price. Baselines seeded from a CI runner encode _that runner image's_ font stack and rasteriser. Runner images are updated on someone else's schedule, and when they are, ten screenshots go red at once for reasons unrelated to the change under review. The predictable outcome is that the tolerance gets widened or the job gets marked continue-on-error, and the coverage becomes theatre — a worse position than an honest skip.

My suggestion: keep pixel comparison **Windows-only**, where the baselines are already calibrated and the maintenance story is understood, and on macOS and Linux assert the things that are genuinely cross-platform and that genuinely regress — computed geometry, contrast ratios, focus order, keyboard traversal, element visibility at larger UI scales. Those catch the layout and accessibility breakages that matter and do not move when a font package is bumped.

Agree without reservation on the reporting point: **skipped comparisons must be visible in the CI summary.** A green job that silently skipped ten of its assertions is the exact failure mode this section is about, and it is the cheapest part to fix.

## 26. Verification results and what they mean

**Codex resolution (12 September 2026):** The table below describes the original audit run only. New local and exact-commit CI results are recorded with the repair PRs and docs/open-work.md; skipped tests are never counted as passes. The current audit branch still requires final full-suite and platform validation before merge.

The fresh audit snapshot used Node **26.7.0** and npm **11.19.0** on Windows. Exit codes were captured from the commands, not inferred from the last line of a pipeline.

| Check                           | Result                                                              | Interpretation                                                                                             |
| ------------------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `npm test`                      | Exit 0; 192 files passed, 8 skipped; 3,998 tests passed, 24 skipped | Existing unit suite passed before audit-only probes were added                                             |
| `npm run lint`                  | Exit 0                                                              | ESLint, Prettier, style checker, i18n catalogue check, icon generation and both TypeScript projects passed |
| `npm run licenses`              | Exit 0; 44 production packages accepted                             | Gate passed; limitations in finding 24 remain                                                              |
| `npm run build`                 | Exit 0                                                              | Electron main, preload and renderer built successfully                                                     |
| Playwright `test --list`        | 555 tests in 38 files                                               | Expected full-suite count                                                                                  |
| Full Playwright run after build | Exit 0; **551 passed, 4 skipped**, approximately 9.3 minutes        | Totals reconcile to 555; no failed tests                                                                   |
| Audit-only probes A01–A19       | Exit 0; **19 reproduced observations**                              | Additional cases revealing gaps in the baseline suite; not product acceptance tests                        |
| `npm audit --omit=dev --json`   | Exit 0; no reported production vulnerabilities                      | Registry result at audit time; not an exhaustive supply-chain/security assurance                           |
| Journey advisory                | 23 of 38 E2E specs have no direct journey/layout-helper usage       | Advisory only; separate journey specs exist, so this is not “23 untested features”                         |

The four E2E skips were the private portfolio-dependent cases; the snapshot intentionally did not contain Tony's private sample. The 24 skipped unit tests likewise must not be counted as passed. See the preserved logs for the exact suite names.

Coverage over the configured included/excluded source set was **67.64% lines, 66.18% statements, 60.93% branches and 63.49% functions**. These are not whole-application coverage figures and do not mean every module has the same coverage. DOM wiring and selected engine code use other verification paths. A passing configured coverage gate does not prove the Save/Recover/Security state transitions in findings 1–11.

Most valuable next tests: source → edit → save → reopen → edit → crash/recover; changes during a slow save; undo/redo of security settings; unsupported/lost-content warnings; encrypted source recovery; and failure after partially applying an operation. Use actual output bytes and observable UI decisions as assertions rather than treating command completion as success.

**Claude Audit Comments:** The discipline in this table is worth noting on its own. Exit codes captured rather than inferred from a pipeline's last line; totals that reconcile (555 listed = 551 passed + 4 skipped); skipped counts stated separately rather than folded into "passed"; and an explicit statement that the probes are reproductions rather than acceptance tests. Several findings above exist precisely because the application reports success without that kind of care, so a report holding itself to the standard it asks of the code is fair.

Two observations rather than corrections.

The coverage caveat is the important sentence here — _"A passing configured coverage gate does not prove the Save/Recover/Security state transitions in findings 1-11."_ That is exactly right, and it explains how 67% line coverage coexists with ten P1 data-integrity findings: every one of those defects lives in the _sequencing between_ modules that individually have tests. Line coverage cannot see an ordering bug. If one metric is added in response to this audit, it should be a small number of end-to-end lifecycle scenarios, not a higher coverage threshold.

The "most valuable next tests" list matches my own reading of where the risk concentrates, and I'd single out the first — source → edit → save → reopen → edit → crash/recover — as the highest-value test in the report. It is the sequence that reproduces finding 6, and finding 6 is the one that silently corrupts documents. If only one test gets written this week, that is the test.

## 27. Architecture and maintainability assessment

**Codex resolution (12 September 2026):** Assessment retained. The repairs strengthen shared save/checkpoint, filesystem authority, protected-open and worker lifecycle contracts through ADRs 0023–0026. They do not replace the existing architecture. The coordinator owns current module status in PLAN.md/CHECKLIST.txt; the old figures below are historical.

The overall design is suitable to continue: strict TypeScript, a small DOM-based shell, service/command registration, a worker-backed engine abstraction, document commands and undo, sparse write plans, a full-rewrite writer, and ordered save stages. There is no audit finding that justifies substituting a frontend framework or replacing the PDF stack wholesale.

The highest maintenance cost is the number of overlapping representations: engine bytes/handles, document model, lazy object records, module state, blob storage, undo journal, tab metadata and saved source files. The reproduced defects occur where one representation advances while another does not. A shared lifecycle contract for identity, revisions, checkpointing, hydration, permissions and save success would address multiple findings more effectively than isolated special cases.

Several large orchestration classes are expected in a project of this size, but they need clearer seams for fault tests. The audit could exercise important SaveService and SecurityService cases with narrow injected collaborators, which is encouraging. Prefer extracting explicit state transitions and typed outcomes over creating another parallel service with duplicate bookkeeping.

Keep ADRs for shared contract changes and retain the existing module/worktree discipline. Security and recovery repairs touch several modules; give them coordinated ownership and acceptance scenarios rather than assuming separate module green ticks establish interoperability.

**Claude Audit Comments:** I agree with this assessment, including the conclusion that nothing in the findings justifies a rewrite or a framework change. These are integration defects in a coherent design, not symptoms of the wrong design.

The section's central sentence — _"The reproduced defects occur where one representation advances while another does not"_ — is the most useful line in the report, and it is worth making operational rather than leaving as an observation. Every one of findings 1-11 is a case of exactly one invariant being violated, and the list is short:

1. **Identity** — the document's path. Advances on the tab record, not on `Document.state` (finding 7; causes 8).
2. **Revision** — which edits a save covers. Advances to "now" instead of "what was captured" (finding 5).
3. **Recovery baseline** — the bytes a journal replays against. Advances on save for `entry.source` but not for the journal (finding 6; shapes 10 and 11).
4. **Security policy vs engine state** — what the file declared vs what PDFium holds, collapsed into one field (finding 3; related 1 and 21).
5. **Secrets** — the passwords a save will use; they do not participate in undo (finding 4).

Five invariants, eleven findings. That mapping is more useful than a repair checklist, because it tells you when you are finished with each one and it predicts where the next defect will appear. It also sharpens the point about coordinated ownership: a fix that satisfies one invariant in one module while another module still reads the stale copy has not fixed anything.

The warning against "creating another parallel service with duplicate bookkeeping" deserves emphasis. Given the diagnosis above, the tempting response — a `DocumentLifecycleService` tracking identity and revisions alongside the existing owners — would add a sixth representation to a list of five that already disagree.

## 28. Product scope and release readiness

**Codex resolution (12 September 2026):** Release limitations retained and made explicit. Signing, notarisation, update/rollback and unfinished feature modules remain with their planned owners. A strict component/notice release gate is now available and reports actual unresolved inputs. This audit repair series is not a commercial-parity or release-readiness claim.

[PLAN.md](D:/Projects/ynotPDF/PLAN.md:13) marks **27 of 44 modules complete** and 17 remaining. This is module count, not a reliable percentage of remaining effort. Major remaining work includes text editing with reflow, OCR, incremental writing, signatures, redaction, comparison, PDF/A, batch/CLI and release engineering. These are planned gaps, not newly discovered defects in supposedly implemented modules.

The project already supports substantial viewing, page organization, annotations, forms, portfolios, creation/export, security and optimization workflows. Its aspiration to rival commercial editors is understandable, but green module completion should not yet be represented as broad commercial-editor parity or release readiness. The interoperability and failure-path findings explain why.

Preserve the explicitly documented limitations: form actions are currently round-tripped rather than executed; image-field population awaits later work; XFA and Acrobat JavaScript are parked; optimization has deliberately unsupported encoders/font subsetting cases; full rewriting cannot substitute for the planned incremental/signature work. Do not quietly expand those scopes while fixing this audit.

Packaging configuration intentionally remains unsigned, with macOS hardened runtime disabled and publishing unset pending M131. Those settings are expected at this stage, not evidence of a failed current packaging task. Before release, complete signing/notarization, upgrade/rollback, installer verification, notices, help, crash handling and the planned update policy. Test installed builds on the actual target architectures, including both Windows installer formats. A fallback smoke test proves the installer that succeeded, not both installers independently.

**Claude Audit Comments:** Agree, and the distinction drawn here — planned gaps versus newly discovered defects in supposedly complete modules — is one the checklist should adopt directly. They need different responses, and conflating them makes both look worse than they are.

One addition on how this audit interacts with the module count. The repairs for findings 1-12 will take real time and will produce **no new module ticks**, because they are corrections inside modules already marked complete. If progress continues to be tracked by module count alone, that period reads as several weeks of zero progress — which creates pressure to work on new modules instead, and new modules built on the current save/recovery contracts will inherit these defects rather than being clean. Worth tracking the audit repairs as their own visible workstream so the trade-off stays explicit.

The related point: a module marked complete in `PLAN.md` currently means "its own tests pass". After this audit it should mean "its own tests pass **and** it participates correctly in the document lifecycle contracts". That is a stricter definition, and it will retroactively un-complete a handful of modules. Better to say so deliberately than to discover it later.

Agree on preserving the documented limitations verbatim — round-tripped form actions, parked XFA and Acrobat JavaScript, the unsupported optimisation encoders. The risk during a repair push is scope creeping into them incidentally ("while I'm in here"), which is how documented limitations quietly become undocumented partial implementations.

## 29. Review coverage by project area

**Codex resolution (12 September 2026):** Coverage assessment retained. New tests add filesystem fault injection, malformed IPC/sender boundaries, protected crash recovery, hostile rich-text input, catalog refusal and actual UI screenshot inspection. This does not claim exhaustive PDF fuzzing, competitor interoperability or a penetration test of deployed installers.

This matrix records the breadth of review without implying an independent exhaustive proof of each subsystem. “Suite” means the existing tests were run; it does not imply every feature had a new adversarial probe.

| Area                                                                 | Review performed                                                                                                       | Result or follow-up                                                                                                                                      |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M00/M03 build, packaging and platform support                        | Package/lock/configuration, CI matrix, installer smoke flow, local build                                               | Strong baseline; release tasks remain M131; independent per-installer evidence needed before shipping                                                    |
| M01/M02/M04 theme, shell and UI harness                              | Theme rules, CSP/DOM boundaries, layout/scale/keyboard suites, screenshot baseline policy                              | Windows suite passes; findings 17 and 25; preserve Tony's opaque chrome and contrast rules                                                               |
| M10/M11 engine and viewer                                            | Engine proxy/worker lifecycle, open/authentication flow, model attachment, viewport and existing engine/viewer tests   | Finding 20 and opening/recovery integration; no new measured performance regression established                                                          |
| M20/M21 document, undo, save and recovery                            | Detailed control/data flow, command journal, write plans, source identity, watchers, real round trip and fault tests   | Findings 2, 5–12, 19 and 22; highest concentration of correctness risk                                                                                   |
| M12/M42 navigation and portfolios                                    | Embedded-file opening/extraction, commands/codecs, blob/write-plan path, portfolio unit/UI suites                      | Findings 7–10 and 14–16; private sample cases excluded                                                                                                   |
| M13 selection, search, copy and print                                | Permission/caller inspection and complete existing unit/UI suite                                                       | No additional independently reproduced content-selection/printing defect in this audit; large/malformed-input robustness is not exhaustively established |
| M30/M31/M32/M33 annotation, comment, ink/stamp and measurement tools | Command/model/recovery interactions, rich-text sink, interchange/appearance and existing unit/UI suites                | Findings 9 and 17; preserve coordinate/appearance round trips and test cross-session identity                                                            |
| M40/M41 page organization and document operations                    | Page-copy/combine flow, crop/flatten inspection, operation and UI suites                                               | Finding 13; catalog-owned structures need explicit preservation policies                                                                                 |
| M50/M53 object editing, headers, watermarks, Bates and links         | Command codec/write-intent/writer interaction, fallback handling and existing suites                                   | Shared save-warning/recovery contracts apply; no claim that arbitrary content-stream edits are fully supported                                           |
| M60 forms                                                            | Commands, composites, field serialization, combine interaction, unit/UI/journey suites                                 | Findings 13 and 19; form logic/data work remains M61                                                                                                     |
| M70 security                                                         | Permission mapping, certificate open, stage ordering, secrets and undo, actual existing crypto suite plus added probes | Findings 1–4, 18, 21 and 22; current CI wrong-key repair tracked separately                                                                              |
| M72 properties/metadata                                              | Model/write-plan integration and existing property/metadata tests                                                      | Shared save revision and recovery findings apply                                                                                                         |
| M91/M92 creation and export                                          | Creation-to-pathless-document lifecycle, export permissions/filesystem output, conversion/codec/UI suites              | Findings 8, 14 and 21; broad fidelity across arbitrary third-party documents remains an ongoing corpus task                                              |
| M100 optimization/repair                                             | Pipeline/stage behaviour, documented unsupported cases, optimization/repair unit/UI suites                             | Warning delivery must work through ordinary Save too; deliberate limitations are documented                                                              |
| M130 preferences, shortcuts and i18n framework                       | Reboot/CI fixes, settings and UI suites, shortcut-sheet generator                                                      | Finding 23; 149 catalogued strings passing extraction checks establish framework consistency, not full localization of every current literal             |
| Resources, dependencies and docs                                     | Resource/attribution policy, fetch/build configuration, npm inventory/audit, plan/checklist/repair notes               | Findings 24 and 30; no private PDF contents or installed competitor files used                                                                           |

**Claude Audit Comments:** The disclaimer at the head of this matrix — _"Suite means the existing tests were run; it does not imply every feature had a new adversarial probe"_ — is what makes the table honest, and it should stay attached to it if the table is ever copied elsewhere. A coverage matrix without that sentence reads as a certificate.

Two rows worth drawing out.

**M20/M21 — "highest concentration of correctness risk", carrying findings 2, 5-12, 19 and 22.** That is eleven of twenty-five findings in one row, and it is the right place for them: it is where all five invariants from section 27 meet. This row alone justifies treating the document-lifecycle repair as one coordinated effort rather than eleven tickets.

**M13 selection, search, copy and print** is the row I'd read most carefully, because its result is phrased as _"no additional independently reproduced defect in this audit"_ while also saying _"large/malformed-input robustness is not exhaustively established"_. Both statements are accurate about what was done, but together they are easy to skim as "M13 is fine". Given that M13 handles text extraction from arbitrary third-party PDFs, it is a natural home for exactly the kind of input-robustness problem that inspection-plus-targeted-probes would not surface. Not a criticism of the audit — a note about where to point a fuzzer later.

The exclusion of private customer PDFs from the snapshot is correct practice and explains the four E2E skips. Keep doing that.

## 30. Current repair state and stale handover information

**Codex resolution (12 September 2026):** Dated status banners now distinguish historical handovers from the active repair log and ADR 0025. Findings 1–12 and 23 are merged; remaining source changes and PR65 validation are recorded separately. Original audit text and Claude comments remain intact for provenance.

The reboot-related repairs must be read as history against their commits. The shared-fixture paths, post-restore notes/checklist updates, macOS preferences repair and dropped-file path repair have landed in the audited main lineage. The old checklist omissions and unsafe bare-filename dropped-file fallback are **not outstanding findings** here.

[docs/open-work.md](D:/Projects/ynotPDF/docs/open-work.md) and parts of [renderer-filesystem-boundary.md](D:/Projects/ynotPDF/docs/security/renderer-filesystem-boundary.md) still contain statements from before those merges. The parent-folder [Codex handover](D:/Projects/AGENTS.md) is also an explicitly dated earlier snapshot. Preserve useful investigation history, but add a current status section with commit/PR links so a new session does not repeat repairs or resurrect withdrawn explanations.

At the final read-only GitHub check on 11 September 2026 during this audit, main remained `b6eb1369c3461cf01fd6a3b5ecb9c8185926d13b`. [Its CI run](https://github.com/tonybaynes/ynotPDF/actions/runs/34594703966) had succeeded on macOS, Ubuntu and Windows; the Windows ARM installer smoke job was still running. PR 47, `fix/pubsec-wrong-key`, remained open at `0ee82adcb06e5285e94ca11fcdc64ba933aa1f24`, with CI still active and the separate macOS failure described in finding 23. These are observations at audit time, not promises about what GitHub will show after this report is read.

The wrong-key repair correctly recognizes that incorrect AES-CBC keys can occasionally produce syntactically valid padding. Do not revive an unconditional “wrong key must throw” assertion as an audit recommendation. This audit did not modify or merge that PR, and did not attribute the unrelated shortcut-sheet failure to its small test change.

**Claude Audit Comments:** Confirmed against the current repository. The lineage has moved since the audit snapshot — `main` is now `8d9989f`, carrying PR 47 (`fix/pubsec-wrong-key`, merged as `e6e3162`), PR 49 (`fix/cheatsheet-determinism`, which closes finding 23) and PR 48 (`docs/close-out`). The audit's read of the repair state was accurate at the time, and two of its open items have since closed.

[docs/open-work.md](docs/open-work.md) still opens with _"Everything left unfinished on the night `main` was restored to `f1034ba`"_ and still presents `fix/macos-e2e-flakes` as "the one to land first". The finding stands: that document describes a moment, not a state, and nothing in it says so. The cheapest fix is not to rewrite it but to add a dated status banner at the top — "this describes the state on 11 September 2026; for current status see X" — leaving the investigation history intact below, which is what the finding recommends and is the right instinct. Deleting that history would lose the reasoning behind several decisions.

A small addition on the same theme: **this audit document will itself go stale, faster than the docs it criticises**, because a third of its findings are expected to be fixed. It needs the same treatment — a status marker per finding, updated as repairs land. I have marked finding 23 as fixed above; that convention is worth continuing rather than leaving the next reader to re-derive which findings still apply. The report's own closing instruction — _"rerun them against any revised branch before treating a finding as fixed"_ — is the right rule, but it only works if someone records the answer where the next reader will see it.

The note about not reviving an unconditional "wrong key must throw" assertion is genuinely useful institutional memory — it is exactly the correct-looking test that gets re-added by someone who hasn't met the underlying AES-CBC padding subtlety. It belongs in a comment beside that test, not only in this report.

## 31. Suggested repair order and retained reproduction material

**Codex resolution (12 September 2026):** The suggested order below is historical. The save/recovery batch is merged; the remaining audit contracts and regressions are being verified together, with UI repairs independently reviewed in PR65. The central Review PDF editor plan task coordinates integration and serial merges. Release prerequisites and new feature modules remain explicit follow-up work rather than being silently declared complete.

Repair the data/protection paths first: findings **1–7 and 12**, followed by the remaining recovery findings **8–11 and 22**. Treat these as a coordinated document-lifecycle effort with explicit source/checkpoint semantics. Then address form preservation and filesystem/attachment handling (**13–18**), transaction/worker resilience (**19–20**), export permissions (**21**) and the testing/policy gaps (**23–25**). Finding 23 is a small independent CI fix that can be completed while the larger design is being reviewed.

Do not implement all recommendations as one large patch. For each repair, first turn the relevant reproduction into a failing desired-behaviour test, agree any shared contract in an ADR, make the smallest coherent fix, and run the affected integration suites plus required CI. A probe that stops reproducing because the test no longer reaches the operation is not a repair.

The retained audit-only test is [codex-audit.test.ts](C:/Users/tonyb/Documents/Codex/2026-09-11/d-projects-ynotpdf/work/audit-20260911/source/test/unit/codex-audit.test.ts). An additional portable copy is [audit-reproductions.test.ts](C:/Users/tonyb/Documents/Codex/2026-09-11/d-projects-ynotpdf/outputs/audit-reproductions.test.ts). Its imports assume it is placed at `test/unit/codex-audit.test.ts` in the matching source tree. It was not added to Tony's repository.

Run the existing retained snapshot reproduction from PowerShell:

```powershell
Set-Location 'C:\Users\tonyb\Documents\Codex\2026-09-11\d-projects-ynotpdf\work\audit-20260911\source'
node node_modules/vitest/vitest.mjs run test/unit/codex-audit.test.ts --coverage.enabled=false --reporter=verbose
```

The baseline snapshot was built and linted before this audit test was added. The audit test is a diagnostic artifact with deliberate mocks and casts; it is not proposed as production-quality test code or part of the baseline lint result. A09 creates a scratch junction only between paths inside the audit evidence folder; A10 substitutes filesystem fault responses; A16 creates a synthetic form. No customer document or executable payload is needed.

| Probe | Finding | Evidence level                                                             |
| ----- | ------- | -------------------------------------------------------------------------- |
| A01   | 6       | Real PDFium + writer + saved-byte recovery replay                          |
| A02   | 7       | Actual SaveService/model with injected writer and IPC                      |
| A03   | 5       | Deferred writer and real command/dirty-state transition                    |
| A04   | 8       | Actual autosave/recovery service and in-memory record store                |
| A05   | 9       | Real model/command replay with fake engine annotation fixture              |
| A06   | 11      | Actual fingerprint functions with controlled byte/mtime changes            |
| A07   | 10      | Actual portfolio command IDs and codec registry lookup                     |
| A08   | 17      | Actual rich-text input/output functions; no script execution claimed       |
| A09   | 15      | Real Windows junction and scratch filesystem write                         |
| A10   | 12      | Injected short write and failed flush, observed rename/success             |
| A11   | 19      | Actual composite/undo stack with a failing child                           |
| A12   | 1       | Actual security stage cancellation returns plaintext                       |
| A13   | 3       | Actual permission service with explicitly restricted recipient             |
| A14   | 2       | Actual SaveService returns warning without presenting it                   |
| A15   | 14      | Real scratch output-name collision and replacement                         |
| A16   | 13      | Real generated form PDF, combine and field-tree inspection                 |
| A17   | 4       | Real security commands/undo; password passed to injected encryption client |
| A18   | 20      | Actual EngineClient with error from its fake-worker interface              |
| A19   | 23      | Actual shortcut-sheet PDF generation under two controlled clock times      |

Detailed command logs are retained in [the audit evidence folder](C:/Users/tonyb/Documents/Codex/2026-09-11/d-projects-ynotpdf/work/audit-20260911). They include `unit.log`, `lint.log`, `licenses.log`, `build.log`, `e2e-list.log`, `e2e.log`, `npm-audit.json`, `journey.log`, `reproductions.log` and the inspected PR 47 macOS job log. The report and probes describe the audited revision; rerun them against any revised branch before treating a finding as fixed.

**Claude Audit Comments:** Agree with the shape of this — data and protection paths first — and emphatically agree with _"Do not implement all recommendations as one large patch"_ and with turning each reproduction into a failing desired-behaviour test before fixing it. The closing warning that _"a probe that stops reproducing because the test no longer reaches the operation is not a repair"_ is the single most valuable sentence in this section.

Three amendments to the order, based on the code I checked.

**1. Land the cheap, isolated fixes first, before the design work starts.** Three findings need no shared contract and no ADR, and they currently sit at positions 12, 19 and 21:

- **Finding 21** (export permission mapping) — two string literals plus a matrix test.
- **Finding 19** (composite rollback) — roughly six lines, reusing the reverse walk `CompositeCommand.undo()` already implements.
- **Finding 12** (atomic write) — propagate the `sync()` error, use `writeFile(handle, bytes)`, unlink the temp file on the failure path. No design questions: the module's own doc comment already states the intended contract.

These can land in days, they shrink the surface of the larger work, and they give the repair effort visible progress while findings 1-11 are still being argued about.

**2. Write the capability ADR (finding 18) before patching findings 15 and 16.** As noted there, 14/15/16/18 are one problem and three symptoms, and patching symptoms individually risks the same rework that produced the existing reverted implementation.

**3. Treat findings 6, 10 and 8 as one design, not three repairs.** Finding 10 determines the answer: portfolio blobs cannot be recovered from JSON at all, so recovery needs a binary side-car store regardless of what is decided about journal rebasing — and finding 8's pathless-document base bytes need the same store. Designing finding 6 first and discovering this afterwards means designing it twice.

On the retained probes: they currently live outside the repository, under `C:\Users\tonyb\Documents\Codex\...`, so they will rot and will not be there when someone needs to confirm a repair six months from now. I'd copy them into `test/unit/audit/` now — in desired-behaviour form as each is fixed, and as `it.fails(...)` or an explicitly skipped test carrying the finding number for the ones still open. Then the repository itself records which findings are outstanding, and that answer cannot drift from the code.

---

## Claude Audit Comments: overall verdict, and what this audit does not cover

**On the audit as a whole.** It is accurate. Every source citation I checked still lands on the cited code two merges later; the reproductions describe mechanisms visible by inspection; and the report is careful about the line between what it demonstrated and what it inferred — it repeatedly declines to overclaim (no script execution demonstrated for finding 17, no exploitable path claimed for finding 18, no assertion that a PDF can create a junction for finding 15). The priorities are defensible. Finding 6 is correctly identified as the most serious, and section 27's diagnosis — representations advancing independently — genuinely _explains_ findings 1-11 rather than merely describing them.

Where I differ, it is mostly about **cost**: several recommendations describe the complete design when a much smaller change fixes the reproduced defect and buys time for that design (findings 1, 5, 6, 8, 19). That matters, because twenty-five findings each asking for a contract can produce paralysis, and the cheapest correct fix shipped this week is worth more than the complete one shipped next quarter.

**Gaps worth a follow-up, none of which undermine the above:**

1. **Multi-window and multi-instance behaviour is not examined anywhere.** Two windows with the same file open; two saves racing on one path; two processes sharing one recovery store. `writeAtomic`'s temp names are per-process unique ([atomic.ts:35-38](src/main/fs/atomic.ts:35)), which suggests the concurrent case was considered at the filesystem layer but not at the document layer. Given how much of this report is about state transitions, a second writer is the obvious untested adversary.

2. **The `.bak` policy loses history silently.** [atomic.ts:20-22](src/main/fs/atomic.ts:20) documents that "a previous `.bak` is replaced". Save twice after an unwanted change and the good version is gone — the backup protects against the _current write_ failing, not against the user. That is a defensible design, but it is the opposite of what most people assume a `.bak` file means, and no finding covers it.

3. **`recoverAll()` always reports `discarded: 0`** ([SaveService.ts:683](src/renderer/modules/M21-save/SaveService.ts:683)) even though `recoverOne()` discards records on the finding-8 path. The count returned to the caller cannot be true. Small, but it is the same species as finding 2 — an outcome value that does not describe what happened.

4. **Memory and large-document behaviour is unexamined.** The full-rewrite writer holds whole documents in memory, `fingerprintBytes` reads whole files under 4 MiB, and `combine` loads every source at once. Nothing addresses what happens with a 500 MB scanned PDF, which is an ordinary thing for a PDF editor to be handed.

5. **User-facing strings are hardcoded English in service code.** The warning at [SecurityService.ts:571](src/renderer/modules/M70-encryption/SecurityService.ts:571) and the toast at [SaveService.ts:692](src/renderer/modules/M21-save/SaveService.ts:692) are literals, while M130 has an i18n catalogue with 149 catalogued strings. Finding 2's repair will add more user-visible warning text — better to route it through the catalogue as it is written than to retrofit it later.

**Bottom line.** This is a useful audit and it should be acted on. The headline risk is finding 6: a plausible, ordinary sequence of user actions that silently corrupts a document, and it deserves attention before anything cosmetic. The headline strength is that the architecture is sound — everything here is a fixable integration defect, and the report is right that none of it argues for a rewrite.

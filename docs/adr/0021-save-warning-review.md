# ADR 0021 — Review save warnings before writing

Date: 2026-09-12. Status: accepted for implementation. Codex audit finding 2; builds on finding 1's `WriteCancelled` handling.

## Problem

The plan, writer and save stages return warnings that can describe omitted content or lost protection. Save previously wrote the bytes, deleted recovery and marked the model clean before returning warning strings to a caller that did not display them.

## Decision

M21 presents a persistent, opaque warning dialog before writing. Plan warnings are reviewed before invoking the engine/writer; newly discovered writer/stage warnings are reviewed after stages finish and before filesystem output. Each decision names the destination and shows every distinct warning as text. Cancel is the initial focus, Enter default and Escape result. Cancel throws the existing `WriteCancelled`, preserving the target, model and recovery.

An explicit **Save with these warnings** authorizes writing the available result to the displayed destination. It does not assert that every model change reached the file. Therefore any warning-bearing save leaves the document marked unsaved, preserves existing recovery records, and reports that state in words. A close/quit flow cannot treat `SaveOutcome.saved` alone as permission to close: it must also check the document is clean. Tony may subsequently review the result, resolve the warning, or explicitly choose Don't save when closing.

The existing string warning contracts remain compatible. No caller classifies risk by matching English text. Until producers supply reliable structured severity, all warnings receive this conservative treatment, including optimization warnings. Warning-free saves retain their existing behaviour. `saved: true` means bytes were written; it has never been a guarantee that every requested feature was preserved, and its interface comment now makes this distinction explicit.

## Limits and alternatives

A toast after saving cannot protect the previous file or let Tony decline loss. Merely adding a confirmation while marking incomplete output clean can still silently discard edits on close. Blocking all warned output would prevent Tony from deliberately saving the available result, so a clearly labelled opt-in remains available.

This change does not fix the separate recovery-base/replay, Save As identity or concurrent-save revision findings. Keeping a recovery record preserves evidence and possible recovery inputs; it does not certify that the current recovery machinery can reconstruct every state. A later severity contract can permit genuinely informational warnings to leave a document clean, provided producers and callers are updated together with tests.

## Verification

Service tests cover plan cancellation before work, deferred decisions before disk writes, writer/stage warnings, later warnings after an accepted plan, explicit consent with dirty/recovery retention, close refusal, clean-document Save As, and warning-free success. A UI test creates a real fast-web-view/protection warning and presses Save through the ribbon, verifies the destination is unchanged before consent and after Escape, and checks focus, readability and recovery retention.

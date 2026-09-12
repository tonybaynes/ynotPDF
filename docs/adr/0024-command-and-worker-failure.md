# ADR 0024: Command and worker failures must settle explicitly

Status: accepted for audit remediation, 12 September 2026.

A command that rejects must leave its own pre-call state intact. A composite rolls back
completed children in reverse order when applying or undoing fails. A failed rollback is
reported as CommandRollbackError, retaining all failures; UndoStack latches an integrity
failure, remains dirty, and rejects subsequent mutations and save/checkpoint captures.
Group/transaction rollback follows the same rule. Reopening or recovering the last good
checkpoint is the supported way forward. Saving inconsistent state as if it were valid
is not an acceptable fallback. Individual commands that touch multiple engine objects
still own rollback of a partially completed child; the composite cannot infer those steps.

Every worker client stores its terminal failure, settles pending calls, and refuses future
calls with that same cause. Engine readiness also rejects on startup failure or termination.
A stopped worker is not restarted silently: existing engine handles are no longer valid.
The caller's normal error UI reports the failure; reopening the app creates fresh workers.

Shared edits are confined to Command, UndoStack and EngineClient. The same lifecycle rule
is implemented in writer, document operations, converter, export and optimisation clients.
Regression tests cover apply/redo failure, rollback failure, startup and later crashes,
disposal, and synchronous message-post failure.

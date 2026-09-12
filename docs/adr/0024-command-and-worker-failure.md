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

Shared edits cover Command, UndoStack, EngineClient and a transport-envelope validator. The same lifecycle rule
is implemented in writer, document operations, converter, export and optimisation clients.
Regression tests cover apply/redo failure, rollback failure, startup and later crashes,
disposal, and synchronous message-post failure.

Transport decoding failures (`messageerror`) are terminal too. Before dispatch removes
any pending entry, `shared/workerMessages.ts` checks the message kind, request identifier
and fields needed by dispatch. Null, unknown or malformed envelopes stop the client and
reject every pending request; they cannot disappear in an event-handler exception. This
is a shallow transport check, not a deep validator for every PDF result. Existing typed
worker payload contracts remain unchanged. Stop removes message/error/messageerror
listeners where supported. Cancellation posts use the same terminal-error handling as
initial posts. Tests inject decoding errors before and after engine readiness, malformed
error envelopes and synchronous cancellation-post failures across all six clients.

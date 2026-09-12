# ADR 0026: One interactive protected-document opening path

Status: implemented for audit finding 22; validation in progress.
Date: 12 September 2026.

M11 authenticatedOpen coordinates certificate preparation, standard-password retry and
source-policy installation before M20 exposes a tab. Normal Open, checkpoint recovery and
reload use it. M20 remains the lower-level engine/model constructor for creation, unit tests
and future noninteractive callers; its open method is not a substitute for interactive Open.
No credential is persisted by this coordinator. Every engine attempt receives its own bytes.

A cancelled reload keeps the old document open. A successful replacement opens before the
old tab closes, then adopts the original path and builds its viewport. Recovery retains the
record until a complete save succeeds. Old journal-only recovery remains manual because
its original base cannot be proved (ADR 0023).

Checkpoint bytes describe the engine's current working state. Standard-encrypted engine
checkpoints use the normal password prompt. Certificate documents were already decrypted
for PDFium; their private local checkpoints are working copies and do not require the
digital ID again. Their source security policy and recipient rights are restored before
attachment. This does not grant owner authority. These are not encrypted archival backups;
OS account/disk protection remains relevant, as documented in ADR 0023. A checkpoint that
actually contains certificate-encrypted bytes goes through the same digital-ID preparation
as any other protected file.

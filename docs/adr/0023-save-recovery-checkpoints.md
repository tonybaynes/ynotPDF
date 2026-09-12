# ADR 0023 — Coherent saves and self-contained recovery checkpoints

Status: accepted (Codex audit findings 5–12).

Saving retains the live engine and undo history. A journal of that history therefore cannot be
replayed on the last saved PDF: some edits are already in those bytes. Journal replay also
depends on transient IDs, lazy hydration and module codecs, and cannot carry portfolio files.

Recovery checkpoints the current engine bytes, model state, ID bindings and binary inputs
together at one command boundary. It restores that pair directly, without applying the old
journal a second time. The checkpoint's write intents remain a baseline for subsequent edits
and saves. Recovery starts a fresh undo history; edits made after recovery can be undone, but
pre-crash undo history is not reconstructed. Normal saves continue to preserve session undo.

Engine bytes and portfolio blobs use a shared content-addressed binary store. Binary files are
written before the atomic JSON manifest; an interrupted update leaves the previous checkpoint
usable. Unreferenced binary generations are collected after publication. Records are retained
after recovery until a warning-free save or an explicit discard.
Pathless dirty documents, including those with no commands, are included. Failed recovery never
deletes its record. The model and tab use the same Save As destination and watcher lifecycle.

The command queue provides a short read barrier while collecting a save/checkpoint's engine
bytes and model. Save output is tied to a captured mutation revision; edits during asynchronous
work cannot be marked saved. Per-document save requests are serialized. Security stages must
not read a changed intent into an older save. A changed revision before writing cancels that
attempt; edits arriving during the atomic write remain dirty with recovery retained.

Recovery storage is private application data containing document contents, like the existing
journal. It must never include passwords or private-key credentials. Protected document bytes
must retain their encryption; certificate source policy must survive restoration. Missing or
invalid binaries fail recovery with the old record retained. Certificate working bytes are already
decrypted on Open; their recovery checkpoint retains the recipient policy, never owner authority.
The store is application-private, with 0700 directories and 0600 files on systems supporting these
modes. It is not a substitute for operating-system account/disk protection. No new key or password
is persisted. Standard-handler engine checkpoints retain the engine's encryption.

Legacy journal-only records remain listed and are retained for manual recovery. They cannot be
automatically replayed safely: even a matching fingerprint may describe a later Save containing
some of their edits, and their original base is unavailable. New records need no command codecs
for restoration: the persisted model, writer provenance and binary inputs cover portfolios too.
The legacy journal API counts actual model changes, not just commands that returned without error.

Source fingerprints cover all bytes and are captured before transferring the opening buffer to
the engine. When the current destination differs or cannot be verified, a checkpoint opens as a
pathless recovery copy, so Save must ask for a destination. The original is never replayed into.

Validation includes Save/edit/crash cycles, undo across save and branching, edits while saves
wait, new and Save As documents, existing annotation targets and portfolio byte equality.

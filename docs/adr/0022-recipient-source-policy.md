# ADR 0022 — Preserve recipient permissions independently of working bytes

Date: 2026-09-12. Status: accepted for implementation. Codex audit finding 3.

## Decision

M70 keeps the source security policy separate from the engine's working-byte information. Certificate decryption returns the selected recipient's envelope permissions and the original source information to M11. M11 installs that policy through an optional M20 `beforeAttach` callback before exposing the new tab to listeners or commands. The callback adds no member to `Document`, `PdfEngine` or `ModuleManifest`.

Session authority is `none`, `user`, `owner` or `recipient`. Only verified owner-password authority bypasses a protected source's permissions. A recipient's permission to modify does not grant permission to copy, print, or become an owner. An old caller that names a recipient without permissions gets `NONE_ALLOWED`. Source policy remains fixed across engine refreshes, including a refresh already in flight when the recipient policy arrives. Direct model opens without M11 retain the model's initial policy, with one conservative inspection to enrich it.

The existing digital-ID test helper feeds the same prepared-open result into M11 instead of modifying whichever document happens to be active afterward. Password unlocking is unavailable for certificate sources, and permission refusal text explains the digital ID's limits. Properties reports certificate security and this recipient's rights even though PDFium holds plaintext.

Source recipient envelopes contain identities but no reusable public certificates. Carrying that information into Properties must not make the save stage try to encrypt with empty certificates. Reprotection requires an explicit certificate intent; otherwise finding 2's protection-loss warning remains the pre-write decision.

## Boundaries

The ordinary-Open acceptance test also exposed that M13's print and copy paths did not consult any permission service. Its print/page-setup/print-to-PDF and dedicated document-copy commands now declare their permissions. Service-level checks also stop direct print, copy and snapshot callbacks before output. Contextual Copy checks PDF rights while preserving copying from ordinary text inputs. These are necessary consumers of the repaired policy, and they also protect password-opened files. M92's separate export-permission finding 21 remains open, as do broader capability and search/export policy work. This change does not alter cryptography or undo history. Source policy describes the opened source for the lifetime of this document; save/reopen lifecycle work remains separate.

## Evidence

Six service regressions failed before implementation, with the unrestricted-recipient control passing. Tests cover permission transport, plaintext working bytes, independent modify/copy/print rights, omitted permissions, refresh races and password-unlock rejection. UI acceptance uses an actual certificate-protected PDF with two recipients through ordinary Open; only native file selection is substituted. It checks ribbon/palette/direct-command enforcement and Properties.

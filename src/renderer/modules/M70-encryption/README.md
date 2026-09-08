# M70 — Encryption, permissions & certificate security

Password protection, permission flags, certificate (public-key) protection, removing protection,
and the enforcement of what a file allows — applied when the document is saved, never before.

The crypto itself is not here. It lives in `src/engine/security/`, knows nothing about the model or
the UI, and is bytes in and bytes out: qpdf for the standard security handler, and our own code for
the two things qpdf has no implementation of. It runs in the **main process**, not in a Worker —
see `docs/adr/0011-qpdf-packaging.md`, which is worth reading before adding another WebAssembly
module anywhere. The contracts are `docs/adr/0012-security-contracts.md`.

| File                 | What                                                                                          |
| -------------------- | --------------------------------------------------------------------------------------------- |
| `manifest.ts`        | Commands, the Protect ribbon group, the status item, the permission gate, settings.           |
| `SecurityService.ts` | The `security` service: the dialog, the intent, the save stage, the passwords, unlocking.     |
| `intent.ts`          | `SecurityIntent` on the model's custom bag, and the check that reads one back safely.         |
| `commands.ts`        | `SetSecurityCommand` — one undoable command for setting, changing and removing.               |
| `dialogs.ts`         | Every question this module asks, in one file so they read consistently.                       |
| `strength.ts`        | The password meter: a word, an icon and a sentence, never a coloured bar.                     |
| `SecurityClient.ts`  | The renderer's end of the `security:*` IPC channels; runs in-process when there is no bridge. |
| `settings.ts`        | `security.*` settings and their schema.                                                       |
| `security.css`       | The dialog, the properties panel and the status item. Tokens only.                            |

## How it joins the app

- **Protection is intent until the document is saved.** The Protect dialog records a
  `SecurityIntent` on the model through an undoable `Command`; nothing on disk changes until the
  next save, which is what the dialog says and what makes Undo mean something. The file is then
  written protected the _first_ time — M21 hands its output to this module's `SavePipelineStage`
  before the bytes reach `file:writeAtomic`, so there is never a plaintext version on disk.
- **Passwords are never written down.** The intent says _that_ there is an open password, not what
  it is. The passwords live in a private `Map` in `SecurityService` and reach nothing else — not
  the store, not `toJSON`, not the autosave record. After a crash the intent replays and the save
  asks for them again, saying why. `test/unit/security/intent.test.ts` asserts that the journal
  cannot contain one.
- **A protected document stays protected when it is saved.** M21's writer cannot rewrite an
  encrypted file, so it is given the decrypted bytes (`removeSecurity`) whenever a stage says it
  owns the document's security, and this module puts the protection back afterwards.
- **Permissions are one question with one answer.** `SecurityService.allows(action)` is `true` for
  an unprotected document, `true` for one opened with the owner password or a digital ID, and
  otherwise reads `/P`. A command declares `permission` in its spec and the shell disables it with
  a sentence saying which permission is missing and that the owner password lifts it.
- **Certificate-protected files are decrypted before PDFium sees them.** PDFium knows only the
  standard handler, so `prepareForOpen` is called by M11 before the engine is handed anything.

## What later modules do here

- **Declare `permission` on a command** (`CommandSpec.permission`) and the shell will disable it,
  with the reason, whenever the open document forbids it. M13's Print and Copy are the first two
  that should; nothing else is needed to make them behave.
- **Show the Security tab** — `securityPropertiesPanel()` returns the panel as an element, ready
  for M72's Properties dialog to host as a tab. Until then `protect.properties` shows it on its own.
- **Run the same protection over a batch** (M120) by calling `Security.protect` directly, or the
  stage through `runSaveStages`. Neither needs a window.
- **Reuse the certificate loading** (`src/engine/security/pubsec/certificates.ts`) rather than
  writing a second one: M81 needs exactly the same `.cer` / `.p7b` / `.p12` reading for signing,
  and there is no PDF in that file.

## What this module does not do

- **RMS / AIP** is Parked (PLAN.md §1) and nothing here anticipates it.
- **Certificate protection is AES-256 only.** The older public-key modes use SHA-1 key derivation
  and per-object RC4 keys; writing one today would be creating a file with broken cryptography in
  it. Password protection still offers AES-128 and RC4 for the compatibility cases the brief asks
  for, because those exist so that someone can _open_ a file in old software.
- **A certificate-protected file cannot be re-protected on its own.** It names its recipients but
  does not carry their certificates, so a save says in words that the copy is unprotected and asks
  the reader to choose the recipients again. That is a property of the format, not of this code.

# ADR 0012 — Encryption in the save pipeline, and the certificate handler we had to write

- Status: accepted
- Date: 2026-09-08
- Module: M70 (encryption); consumed by M71, M72, M81, M120

## Context

M70 has to put protection _back_ on a file that M21 has just rewritten, take it off, enforce what
a file's `/P` flags allow, and encrypt to certificate recipients. Three problems had to be settled
before any of that could be built, and each is a contract another module will meet.

1. **Where encryption happens.** M21 writes bytes and hands them to `file:writeAtomic`. If M70
   encrypted afterwards it would be a second save; if it encrypted before, the writer's own output
   would be plaintext on disk for the length of a rename. Neither is acceptable.
2. **What the document remembers.** Security is intent, so it belongs on the model — but the
   passwords are the one piece of document state that must never be persisted, and the model's
   journal is written to a recovery file after every autosave.
3. **Certificate encryption, which qpdf cannot do.** The brief's constraint is "qpdf is the single
   implementation of the crypto — do not reimplement". qpdf 12.2.0 has no public-key security
   handler: no `--recipient`, no `/Adobe.PubSec`, nothing in `--help=all` mentioning a
   certificate. There is no implementation to defer to.

## Decision

### A save pipeline stage, owned by `src/engine/Writer.ts`

`Writer.ts` gains one additive type:

```ts
export interface SavePipelineStage {
  readonly id: string;
  /** Lower runs first. Encryption is 100 and should stay last. */
  readonly order: number;
  run(input: SaveStageInput): Promise<SaveStageResult>;
}
```

`SaveService` runs every registered stage over the writer's output, in `order`, before the bytes
reach `file:writeAtomic`. A document therefore lands on disk encrypted the first time it is
written; there is no window in which the protected file exists unprotected, and no second save.

The stage is deliberately in the engine's vocabulary — bytes in, bytes out, plus a small
`SaveStageContext` carrying the document id, the path being written to and a `warnings` sink. It
knows nothing about the model, so M120 can run the identical stage over a batch with no UI
present, and a stage can be unit-tested with a `Uint8Array` and no shell at all.

`SaveService` gained a `stages` registry (`addStage`/`removeStage`) and calls them in `writeTo`
between `runWriter` and `writeBytes`. That is the whole change to M21.

### The intent lives in the custom bag; the passwords live in memory

`SecurityIntent` — algorithm, permissions, what to encrypt, recipients, and _whether_ there are
passwords — is stored in the model's custom bag under the `M70` namespace, which M20 already
provides for exactly this and which the journal already serialises. It contains no password and
no derived key.

The passwords sit in a module-private `Map<documentId, SecretBundle>` inside `SecurityService`,
are never put in the store, never in a `toJSON()`, never in a recovery record and never in a log
line. A `console` that printed a `SecurityIntent` would print no secret. After a crash the journal
replays the intent and the reader is asked for the passwords again, with the dialog saying why —
which is the only honest thing a recovery file can do, and what Foxit does too.

`SetSecurityCommand` carries its passwords in the command object, so undo and redo work for the
whole session without those passwords ever being written down.

### Certificate security is ours, and it is verified against qpdf

Since qpdf has no public-key handler, M70 implements one. The decision worth recording is _how
much_ of it is ours, because the answer is: only the parts qpdf has no opinion about.

- **The envelopes** are node-forge's CMS (`pkcs7.createEnvelopedData`), one per recipient, each
  carrying the shared 20-byte seed and that recipient's own four permission bytes — which is how
  per-recipient permissions work in the first place.
- **The key derivation** is the spec's: `SHA-256(seed ‖ each CMS blob in `/Recipients` order ‖
FFFFFFFF when metadata is left in the clear)`.
- **The content encryption** is AES-256-CBC over every string and every stream. This is not a
  second implementation of anything: under AESV3 the object key _is_ the file key, so the bytes
  the standard handler produces and the bytes the public-key handler produces are identical, and
  the only difference between the two files is the `/Encrypt` dictionary.

That last fact is what makes it testable rather than hopeful. Take our public-key file, replace
its `/Adobe.PubSec` dictionary with a `/Standard` R6 dictionary wrapping the _same_ file key under
a password we choose — a forward computation, Algorithms 2.B, 8, 9 and 10 — and run
`qpdf --check`. qpdf then decrypts and validates every stream in the document. If our content
encryption were wrong by one byte, qpdf would say so. That is the certificate acceptance test, and
it means the crypto is still ultimately checked by qpdf even where qpdf cannot write it.

**Opening** a certificate-encrypted file runs the same swap in the other direction, and never
parses the document. From the recipient's `.p12` we open the CMS envelope, recover the seed,
derive the file key, and append a twelve-line incremental update whose only content is a
`/Standard` R6 `/Encrypt` dictionary wrapping that key. `qpdf --decrypt` does the rest — object
streams, cross-reference streams, damaged files, everything pdf-lib would refuse — and PDFium is
handed plaintext. The alternative was a second PDF parser inside M70, and this is a hundredth of
the code with qpdf's tolerance behind it.

**Our public-key writer emits no object streams**, because pdf-lib builds those at save time,
after our pass has encrypted the strings, and a string inside an object stream must not be
encrypted separately from the stream containing it. Files are a few per cent larger. The password
path is unaffected: qpdf does the whole job there and keeps object streams.

Certificate encryption is offered at **AES-256 only**. The older public-key modes (RC4 and AESV2
with SHA-1 key derivation and per-object keys) exist for viewers that predate 2008; creating one
today would be a new file with broken cryptography in it. Password protection still offers
AES-128 and RC4-128 for the compatibility cases the brief asks for, because those are cases where
someone must _open_ the file in old software, not cases we invent.

### Permission enforcement asks one question

`SecurityService.allows(action)` is the single answer to "may the reader do this?". It is `true`
for every unencrypted document, `true` for every document opened with the owner password, and
otherwise reads `/P`. Commands that a permission can block declare it, and the shell's `when`
clause plus the tooltip come from the same call, so a disabled button always has a sentence
explaining which permission is missing and that the owner password lifts it.

## Consequences

- M21's `SaveService` gains a stage registry and one call site. Nothing else in M21 changes, and
  a build without M70 behaves exactly as it did.
- M120 runs the encryption stage directly over bytes, with no renderer.
- M72's Security tab reads `SecurityService.describe(document)` rather than the model, so it
  reports the file's real state including the parts that are not intent.
- M81 will need the same certificate plumbing for recipient lists; `src/engine/security/pubsec/`
  is written to be shared and its certificate loading has no PDF in it.
- If qpdf ever grows a public-key handler, `PubSecEncryptor` is one file to delete and the
  verification test is the one that proves the replacement matches.

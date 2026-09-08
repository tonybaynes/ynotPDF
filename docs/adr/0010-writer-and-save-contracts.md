# ADR 0010 — The writer's base and plan, and the IPC saving needs

- Status: accepted
- Date: 2026-09-08
- Module: M21 (save); consumed by M40, M41, M53, M70, M72, M80, M91, M100, M120

## Context

M21 has to write a document back to disk. Three things it depends on had to be settled first,
and each of them is a contract other modules will build on.

1. **What the writer takes as input.** The brief says `FullRewriteWriter` should "load original
   bytes, apply every journaled change". Taken literally that means a second implementation of
   every mutation — rotation, boxes, annotations, field values, page insertion — one in PDFium
   and one in pdf-lib, with two chances to disagree and no way to tell which is right.
2. **What the renderer may ask the main process to do.** Saving needs an atomic write, a
   read-only check, a file watcher, a place to keep autosave records, and a way to hold a window
   close back while the reader is asked about unsaved work. None of that existed.
3. **Whether a close or a quit can be vetoed.** Only the renderer knows a document is dirty and
   only it can ask about it, but only main can stop a window closing.

## Decision

### The writer's base is the engine's serialisation, and its plan is sparse

`Writer.write({ bytes, plan })` takes the document **as the engine currently holds it**
(`PdfEngine.save`) rather than the file as it was opened. PDFium has already applied everything
it can apply and reverse, and `FPDF_SaveAsCopy` preserves every object it does not understand.
The plan then says what is _left over_: page order and presence, page labels, the three boxes
PDFium has no setter for, the information dictionary and XMP, the outline, named destinations,
layer visibility, annotation entries that had to be **removed** rather than changed, cleared
field values, and appearance streams.

Determinism is unaffected, which is what the brief's "pure function of (original bytes, journal)"
is really asking for: the base bytes are themselves a function of (original bytes, journal), so
`write()` is a pure function of its inputs and a crash recovery, a batch run and an interactive
save all produce the same file.

Every section of `WritePlan` is nullable, and `null` means **leave it alone**. `buildWritePlan`
fills a section only when the document carries the matching write intent. That is what makes a
no-op save a re-serialisation and nothing more, which is in turn what makes the round-trip
acceptance test achievable at all.

One exception is worth naming: `metadataFallback` is written **only when the base has no
information dictionary at all**. PDFium rebuilds the cross-reference table of a damaged file,
reads its `/Info` perfectly well, and then serialises the repaired document without one — so
opening a damaged file and saving it would silently lose the title, the author and the dates.

### Encrypted documents are refused rather than rewritten

pdf-lib does not decrypt strings. A rewrite would emit plaintext under a trailer that still
claims encryption: a file no reader can open. `FullRewriteWriter` therefore throws
`WriteUnsupported('encrypted')`, and the save flow either writes the engine's bytes unchanged
(when the plan needs no pdf-lib pass, so the protection survives) or tells the reader in words
that saving would remove the password and lets them decide. M70 will re-encrypt at this point.

### IPC additions (all additive)

| Channel                                  | Why                                                                                                                                  |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `file:writeAtomic`                       | Temp file + rename, optional `.bak`. An interrupted save must never leave half a PDF where the document was.                         |
| `file:probe`                             | Does it exist, how big, when changed, and can it be written — the file _and_ its folder, because the last step is a rename into it.  |
| `file:saveAsDialog`                      | The Save As dialog with a title and button label of our choosing. `file:saveDialog` stays for callers that only have a default path. |
| `file:watch`, `file:suspendWatch`        | chokidar in main; the suspend mutes a path while we write to it, so a save never announces itself.                                   |
| `recovery:list/save/read/discard/clear`  | The autosave store under `<userData>/recovery`. Main stores an opaque string per id; the renderer owns the format.                   |
| `window:setUnsaved`                      | The renderer tells main whether it is holding unsaved work.                                                                          |
| `window:confirmClose`, `app:confirmQuit` | The renderer's answer to the two questions below.                                                                                    |

New push channels: `file:changedOnDisk`, `window:closeRequested`, `app:quitRequested`.

### Close and quit are vetoed only while a window has reported unsaved work

Main intercepts a window `close` or an app `before-quit` **only** when at least one window has
sent `window:setUnsaved(true)`. It then asks that window and waits. Three properties make this
safe, and all three are tested:

- A clean app quits instantly; nothing is intercepted and nothing can hang.
- A renderer that stops answering releases the window after five seconds, and main then closes
  or quits **itself** — the timeout is not merely a resolved promise, it is an action.
- A window whose close has been agreed is not asked again.

### `Documents.onAttached`, and the default close hook as a backstop

Two small changes to M02's `Documents`:

- `onAttached(listener)` fires when module state is attached to a tab. Opening a tab and
  attaching its `Document` are two steps and the store notification comes on the first, so a
  module watching the store alone sees a tab with no document and never hears about it again.
- `close()` now runs the registered hooks **and then** the default hook, rather than treating the
  default as a replacement. A module hook that has nothing to say about a tab — M21's, when the
  tab has no `Document` behind it — must not silently disarm the shell's own question. The
  default is asked with the tab as it is _now_, so a hook that got the reader's agreement to lose
  the changes (and cleared the dirty flag) does not cause a second question.

### Appearance generation is a registry, not a switch

`engine/appearance/` takes an `AppearanceInput` and returns an `AppearanceStream` of
`{ bbox, content, resources }` — content-stream text, not pdf-lib objects. Every annotation
module after this one adds a subtype and registers its generator; only `FullRewriteWriter` knows
which PDF library we write with.

## Consequences

- **M40, M41, M53** get page order, labels, boxes and the outline for free by recording the
  matching write intent; they add cases to `test/unit/roundtrip.ts` rather than writing their own
  comparison.
- **M30, M31, M33, M82** register appearance generators for their subtypes; the writer fills a
  missing `/AP` and replaces a stale one for anything the session changed.
- **M70** re-encrypts inside `FullRewriteWriter` and removes the refusal above.
- **M80** implements `Writer` as `IncrementalWriter` and becomes the default; the plan and the
  save flow do not change.
- **M120** replays a journal and calls the same writer, which is why the plan is data.
- **M130** renders `SAVE_SETTINGS_SCHEMA` in Preferences with no work on M21's side.

## Alternatives considered

**Rewrite from the original bytes with pdf-lib.** Rejected: two implementations of every
mutation, and PDFium's is the one that renders on screen, so a disagreement would show as "it
looked right until I saved it".

**Reload the engine handle after a save**, as the brief suggests. Rejected, and this is the one
place M21 knowingly departs from its brief. After a full rewrite the engine still holds the pages
the model deleted, and those pages are what `undo` puts back; reopening from the saved bytes
would throw them away, so a save would quietly cost the reader their undo history. Foxit does not
do that. The cost of not reloading is memory — pages deleted during a long session stay in the
engine until the document is closed — which is the lesser harm by a wide margin.

**Run the writer on the main thread.** Rejected: pdf-lib parses and serialises the whole object
graph, which on a large document is seconds of solid work, and the progress bar and the Cancel
button would both be frozen for exactly as long as the reader needs them.

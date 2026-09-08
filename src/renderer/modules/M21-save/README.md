# M21 — Save

Writing the document back to disk, and everything that keeps the reader's work safe until it
gets there: Save and Save As, autosave into a recovery store, the offer to put the work back
after a crash, the Save / Don't save / Cancel flow, the read-only check, and the watcher that
notices a file changing underneath us.

The writer itself is not here. It lives in `src/engine/` (`Writer.ts`, `writers/`,
`appearance/`), knows nothing about the model or the UI, and is a pure function of the bytes it
is given and the plan it is handed — which is what lets a crash recovery and a batch run produce
exactly the file an interactive save would. See `docs/adr/0010-writer-and-save-contracts.md`.

| File                | What                                                                                         |
| ------------------- | -------------------------------------------------------------------------------------------- |
| `manifest.ts`       | Commands, shortcuts, the Home ribbon group, the File backstage slots, the status item.       |
| `SaveService.ts`    | The `save` service: saving, autosave, recovery, the close flow, read-only, the disk watcher. |
| `plan.ts`           | `buildWritePlan(document)` — the model turned into instructions, pure and sparse.            |
| `commands.ts`       | `AddOutlineItemCommand`, the one document command this module adds (M12 builds on it).       |
| `recovery.ts`       | The recovery record, the source fingerprint, and the replay.                                 |
| `dialogs.ts`        | Every question M21 asks, in one file so they read consistently.                              |
| `WriterClient.ts`   | The renderer's end of the writer Worker; runs in-process when there is no `Worker`.          |
| `writer.worker.ts`  | The Worker itself. `serveWriter(port)` is exported so it can be tested without a thread.     |
| `writerProtocol.ts` | The three message kinds each way between the two.                                            |
| `settings.ts`       | `save.*` settings, their schema, and the folder Save As last used.                           |
| `save.css`          | The status item and the recovery dialog. Tokens only.                                        |

## How it joins the app

- **The model is the source of truth for intent, the engine for content** (M20's rule, unchanged).
  A save asks the engine for its bytes, asks `buildWritePlan` what the engine could not do, and
  hands both to the writer. Nothing here mutates a document.
- **Saving does not reload the engine handle.** After a full rewrite the engine still holds the
  pages the model deleted, and those pages are what `undo` puts back — so reopening from the
  saved bytes would quietly cost the reader their undo history. The one path that does reload is
  "the file changed on disk, reload it", where the reader was told exactly that first.
- **Nothing is intercepted until there is something to lose.** The renderer tells main whether it
  holds unsaved work (`window:setUnsaved`), and only then does main hold a window close or an app
  quit back to ask. A clean app quits instantly; a renderer that stops answering releases the
  window after five seconds.
- **Every question is a word, not a colour.** Save · Don't save · Cancel; Reload from disk · Keep
  mine; Recover · Discard · Not now. The status item says "Saved", "Unsaved changes",
  "Read-only" or "Saving…", with an icon beside it and colour only as a third, redundant cue.

## What later modules do here

- Register an appearance generator for a new annotation subtype
  (`AppearanceService.register`), and the writer will draw it into any file that lacks an `/AP`.
- Record a write intent on a command (M20's mechanism) and fill the matching section of the plan;
  the writer already knows how to emit page order, labels, boxes, metadata, the outline, named
  destinations, layers and field values.
- Add cases to `test/unit/roundtrip.ts` rather than writing a second comparison harness.

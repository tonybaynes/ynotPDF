# M41 — Combine, split, crop, flatten & straighten

The whole-document operations: joining files into one, cutting one into several, setting a page's
boxes, baking comments and form fields into the page, and straightening a scan that went through
the feeder crooked. Spec:
[`docs/modules/M41-merge-split-crop.md`](../../../../docs/modules/M41-merge-split-crop.md); the one
contract addition: [ADR 0017](../../../../docs/adr/0017-page-boxes-from-the-engine.md).

## What is where

| File                   | What it is                                                                                                     |
| ---------------------- | -------------------------------------------------------------------------------------------------------------- |
| `manifest.ts`          | Every command, the Convert and Organize ribbon groups, the crop tool and the thumbnail context menu.           |
| `MergeService.ts`      | Where the pure ops meet the open document: the settings, the page-replacing machinery, the detectors.          |
| `OpsClient.ts`         | The renderer's end of the operations Worker, with the in-process fallback for a run that has no `Worker`.      |
| `ops.worker.ts`        | The Worker itself. One request kind per operation, a cancel, and the answers.                                  |
| `opsProtocol.ts`       | The wire format between the two, typed so a dialog and the worker cannot disagree about an option.             |
| `commands.ts`          | Two document commands — re-aim destinations at replaced pages, drop fields with no widgets — and their codecs. |
| `combineDialog.ts`     | The file list: drag or keyboard reorder, a page range and a thumbnail per file, and the three options.         |
| `splitDialog.ts`       | The four ways to cut, with a live summary naming the first three files before anything is written.             |
| `cropDialog.ts`        | Margins in the reader's unit, the box to write, "remove white margins", and a preview of the rectangle.        |
| `cropTool.ts`          | The rectangle on the page: eight handles, arrow-key nudging, Enter to apply, Escape to give up.                |
| `flattenDialog.ts`     | Bake or remove, over which pages, with the difference between the two spelt out.                               |
| `deskewDialog.ts`      | The per-page table, the before-and-after preview and the ±5° fine-tune slider.                                 |
| `fields.ts`            | The form pieces the five dialogs share: the range field, the length field, checkboxes, radios, selects.        |
| `settings.ts`          | The fourteen settings and the schema M130's preferences dialog renders.                                        |
| `merge-split-crop.css` | Every rule, in theme tokens only.                                                                              |

The operations themselves are **not** here: they are pure functions over bytes in
[`src/engine/ops/`](../../../engine/ops/), so M120's batch runner and M121's command line get the
same code the dialogs use, and none of it knows what a tab is.

## The one decision worth knowing

**Deskew and flatten replace their pages.** Both change page _content_, and PDFium can neither
wrap a content stream nor un-flatten a page, so an in-place engine mutation could not be undone.
So `MergeService.replacePages` slices the pages out, puts them through the pure op, imports the
result back where they were, deletes the originals and re-aims any destination that pointed at a
replaced page — all inside one `doc.batch`. Edit ▸ Undo shows one entry and gives back exactly
what was there, annotations included. Runs of consecutive pages are rebuilt last-first, so the
indexes of the runs still to come do not move.

The cost is that a straightened page is a _new_ model page with a new id. Bookmarks and named
destinations survive because they are re-aimed; the thumbnail selection is put back on the
replacements.

**Cropping is the opposite:** it writes rectangles and nothing else, so it is M20's
`SetPageBoxCommand` per page per box, and a cropped page can always be un-cropped — in this app
or in any other reader, because the MediaBox is left alone unless the reader asks for it to
change.

## Where the split falls

| Question                     | Answered by                                                              |
| ---------------------------- | ------------------------------------------------------------------------ |
| What does this operation do? | `src/engine/ops/` — pure, no document, no DOM, no Node.                  |
| Which pages?                 | M40's `OrganiseService.target()`, so the two modules cannot disagree.    |
| How does it become undoable? | `MergeService`, through M20's and M40's commands plus this module's two. |
| What does the reader see?    | The five dialogs and the crop tool.                                      |

## Tests

The operations are unit-tested in `test/unit/ops/**`, with the halves that need a real renderer —
skew detection, the flatten render hash, "remove white margins" — against real PDFium in
`test/unit/engine/ops.test.ts`. The DOM half is proved by Playwright in
`test/e2e/document-ops.spec.ts`, which is why the dialogs, the tool and the service are out of the
coverage gate.

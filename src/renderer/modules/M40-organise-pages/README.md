# M40 — Organise pages

The Organize tab: insert, delete, extract, replace, rotate, move, duplicate, reverse, swap, copy
into another document, and page numbering — plus dragging thumbnails to reorder. Spec:
[`docs/modules/M40-organise-pages.md`](../../../../docs/modules/M40-organise-pages.md); the one
contract addition: [ADR 0015](../../../../docs/adr/0015-page-organisation-contracts.md).

## What is where

| File                 | What it is                                                                                                        |
| -------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `manifest.ts`        | Every command, the four Organize ribbon groups, the thumbnail context menu, the shortcuts and the status field.   |
| `OrganiseService.ts` | The service the commands share: the targeting rule, the settings, the progress dialog and the engine round-trips. |
| `commands.ts`        | The four document commands — reorder, import, renumber, prune the outline — and their journal codecs.             |
| `range.ts`           | **Pure.** The page-range dialect: `1-3,5,8-` plus odd, even, landscape, portrait, current, selected, all, last.   |
| `labels.ts`          | The numbering the dialog offers, on top of the engine's `/PageLabels` half.                                       |
| `extract.ts`         | Building a document out of another one's pages: the slice, the comment filter, the bookmarks that come with it.   |
| `dialogs.ts`         | The Organize dialogs, including the range field with its live summary and the thumbnail page picker.              |
| `dnd.ts`             | The thumbnail drag: insertion marker, auto-scroll, Ctrl to copy, and a drop on another document's tab.            |
| `settings.ts`        | The eight settings and the schema M130's preferences dialog renders.                                              |
| `organise.css`       | Every rule, in theme tokens only.                                                                                 |

The numbering itself lives in [`src/engine/pageLabels.ts`](../../../engine/pageLabels.ts) rather
than here, because M21's writer needs exactly the same answers: the dialog turns (style, prefix,
start) into strings, and the writer reads a run of strings back as `/S /r` — two implementations of
a roman numeral would be two chances to disagree.

## The one rule worth knowing

**Which pages?** Every command asks it, and `OrganiseService.target()` answers it the same way
every time: what the command was told (`{ pages: [0, 2] }` or `{ range: '1-3,odd' }`), else the
thumbnail selection M12 keeps in the shell's `Selection`, else the current page. That is why the
palette, the ribbon, the context menu, a drag and the e2e suite can never disagree about what
"Delete Pages" would delete.

## Where the split falls

Page **order** and **presence** are the model's, never the engine's: `FPDFPage_Delete` cannot be
undone, so a reorder or a delete that went to PDFium would make undo a lie (M20, ADR 0007). Page
**content** is the engine's: insert-blank, insert-from-file and duplicate all append at the
engine's own end, so no existing engine index shifts and undo is a delete of the highest ones.

## Tests

The pure half is unit-tested in `test/unit/organise/**` and the new engine call against real
PDFium in `test/unit/engine/create-document.test.ts`. The DOM half — the dialogs, the service and
the drag — is proved by Playwright in `test/e2e/organise.spec.ts`, which is why those four files
are out of the coverage gate.

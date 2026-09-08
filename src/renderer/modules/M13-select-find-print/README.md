# M13 — Text selection, find, copy, snapshot & print

Everything textual a reader does with a page, plus getting it on to paper.

## What is where

| File / folder                          | What it is                                                              |
| -------------------------------------- | ----------------------------------------------------------------------- |
| `manifest.ts`                          | Commands, ribbon groups, the Search panel, the Snapshot tool, shortcuts |
| `SelectFindService.ts`                 | The service everything calls into; one state per document tab           |
| `TextService.ts`                       | The page-text cache — one `textRuns` round trip per page, ever          |
| `settings.ts`                          | Find options, snapshot DPI, and the remembered print settings           |
| `canvas.ts`                            | The two canvas helpers snapshots and print sheets share                 |
| `selection/model.ts`                   | **Pure.** What is selected: two carets, a granularity, a column rect    |
| `selection/TextSelectionController.ts` | The pointer, keyboard and repaint plumbing round that model             |
| `selection/Highlighter.ts`             | Draws selection and search rectangles into the page text layer          |
| `selection/rtf.ts`                     | **Pure.** The RTF writer, built in-house                                |
| `selection/clipboard.ts`               | Text / RTF / image on to the clipboard, through main                    |
| `find/search.ts`                       | **Pure.** The matcher: case, whole word, regex, accents, proximity      |
| `find/FindController.ts`               | One document's hit list, and which hit is current                       |
| `find/FindBar.ts`                      | The Ctrl+F strip                                                        |
| `find/SearchPanel.ts`                  | The advanced-search panel: scope, options, results tree, CSV            |
| `find/csv.ts`                          | **Pure.** Results as CSV                                                |
| `print/imposition.ts`                  | **Pure.** Pages → sheets: n-up, booklet, tiling, scaling, auto-rotate   |
| `print/pageRange.ts`                   | **Pure.** "2-4, 7, 9-", odd / even, reverse                             |
| `print/plan.ts`                        | **Pure.** Settings → the plan the preview, the paper and the PDF share  |
| `print/paper.ts`                       | The paper catalogue (`resources/print/paper-sizes.json`)                |
| `print/render.ts`                      | One sheet → one PNG at the job's DPI                                    |
| `print/printToPdf.ts`                  | The same imposition, written to a file — vector or raster               |
| `print/PrintService.ts`                | Plans, renders, and talks to main                                       |
| `print/PrintDialog.ts`                 | Our print dialog, with a live preview                                   |

The text model itself lives one level up, in `src/renderer/view/TextLayer.ts`, because it is
shared: M51 will reflow from the same line and paragraph grouping, M54 replaces inside it and
M111 reads it aloud.

## The shape of it

- **Pure where it can be.** The text model, the matcher, the selection rules, RTF, page ranges and
  the whole imposition are pure functions with no DOM and no engine, unit-tested in Node
  (`test/unit/find/`). The DOM half is proved by Playwright (`test/e2e/select-find-print.spec.ts`).
- **One text model per page, read once.** `TextService` caches it with the document; a find and a
  selection on the same page read the same object.
- **One imposition, three consumers.** The preview, the printer and "Print to PDF" all draw the
  plan `print/plan.ts` produced, so they cannot disagree (ADR 0011).
- **Selection is ours, not the browser's.** See ADR 0011 for why, and `selection/Highlighter.ts`
  for how the highlight stays opaque without hiding the words under it.

## What M13 does not own

`tool.selectText` is **M11's** tool id — the cursor, the ribbon toggle and the `V` shortcut are
its. M13 watches `ui.activeTool` and turns its controller on while that tool is active, because a
drag that crosses a page boundary has to keep producing coordinates after it has left the page it
started on, which a `ToolSpec` cannot do.

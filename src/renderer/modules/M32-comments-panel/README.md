# M32 — Comments panel, replies & status, FDF/XFDF, summarise

The review workflow that sits on top of the annotations M30 and M31 create: the Comments panel,
reply threads, review status, show/hide, comment exchange, and the summary PDF.

## What is where

| File                 | What it is                                                                                                                                               |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `manifest.ts`        | Every command, the ribbon groups, the panel, the shortcuts, the settings schema, and the two hidden probes the acceptance tests read the module through. |
| `CommentsService.ts` | View state (filter, search, grouping, sorting), the review actions, and comment visibility. Reads the model, never the engine.                           |
| `CommentsPanel.ts`   | The left pane: a virtualised list, a search field, filter/arrange/visibility popovers, an inline reply editor, keyboard navigation.                      |
| `model.ts`           | Annotations → comment threads. Pure. Where "a status is the newest status reply" lives.                                                                  |
| `rows.ts`            | Filtering, sorting, grouping and searching → the flat row list the panel draws. Pure.                                                                    |
| `metrics.ts`         | Row heights and the visible window for the virtualised list. Pure.                                                                                       |
| `status.ts`          | The five review states and the checkmark, each a word **and** an icon.                                                                                   |
| `exchange.ts`        | Import and export against `engine/xfdf`, as commands on the document.                                                                                    |
| `summarise.ts`       | Runs a summary: the model's comments plus the engine's page pictures through `engine/summary`.                                                           |
| `dialogs.ts`         | Import, export and summarise option dialogs; the page-range parser.                                                                                      |
| `settings.ts`        | `comments.*` preferences. Every one of them is a view preference.                                                                                        |

The pure halves live in the engine, not here: `src/engine/xfdf/` (FDF and XFDF, both ways) and
`src/engine/summary/` (the layout and the pdf-lib build).

## Three rules this module keeps

1. **A status is a reply, not a field.** ISO 32000-1 12.5.6.4 records a review state on a reply
   annotation carrying `/State` and `/StateModel`. The current status of a comment is the newest
   one in its thread; the older ones stay as the record of who decided what. Acrobat and Foxit
   both do this, and it is why the panel can say "Rejected by C. Editor".
2. **Hiding a comment never changes the file.** Show/hide is a view flag: the raster stops drawing
   annotation appearance streams and M30's overlay draws the ones still visible (ADR 0017). The
   annotation's own `/F` hidden bit is never touched.
3. **Everything is a command.** Reply, status, checkmark, delete, import, export, summarise,
   group, sort, filter, show and hide — all registered, all in the palette, all reachable from
   M120's batch with plain-data arguments and no UI.

## Reading it out of the running app

`dev.comments` returns the panel's rows, counts, authors, types, filter state and visibility as
plain data; `dev.commentThread` returns one thread with its replies. Both are hidden commands, so
they are runnable by id and invisible in the palette.

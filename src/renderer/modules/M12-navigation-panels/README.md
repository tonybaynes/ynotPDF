# M12 — Navigation panels

The left pane: **Pages**, **Bookmarks**, **Layers**, **Attachments**, **Destinations**. Spec:
[`docs/modules/M12-navigation-panels.md`](../../../../docs/modules/M12-navigation-panels.md);
contract additions: [ADR 0011](../../../../docs/adr/0011-navigation-panel-contracts.md).

## What is where

| File                               | What it is                                                                                                        |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `manifest.ts`                      | Forty-odd commands, the View ribbon groups, the five panels, the shortcuts and the context menus.                 |
| `NavigationService.ts`             | The service the panels share: settings, the thumbnail renderer, navigation, attachments and portfolios.           |
| `commands.ts`                      | The thirteen document commands (bookmarks, destinations, embedded files) and their journal codecs.                |
| `settings.ts`                      | `ui.leftPaneOnOpen`, `ui.thumbnailSize` and the rest, plus the schema M130's preferences dialog renders.          |
| `panelChrome.ts`                   | The chrome all five share: toolbar, empty state, list keys, byte and date formatting.                             |
| `panels.css`                       | Every rule, in theme tokens only.                                                                                 |
| `thumbnails/grid.ts`               | **Pure.** The operator's layout rules as arithmetic: the size ladder, the pane width, the column count, the rows. |
| `thumbnails/ThumbnailRenderer.ts`  | The low-priority render queue and its own small LRU of bitmaps.                                                   |
| `thumbnails/ThumbnailPanel.ts`     | The virtualised grid.                                                                                             |
| `bookmarks/tree.ts`                | **Pure.** Insert, move, indent, outdent, remove-with-descendants, restore — the whole shape of an outline edit.   |
| `bookmarks/BookmarkPanel.ts`       | The tree, inline rename, drag to reorder.                                                                         |
| `layers/LayerPanel.ts`             | Checkboxes, "Visible"/"Hidden" in words, and the visibility file's reader and writer.                             |
| `attachments/AttachmentPanel.ts`   | The list, and a portfolio's own schema columns.                                                                   |
| `destinations/navigate.ts`         | **Pure.** A PDF destination → a zoom and a scroll offset. Shared with M53's links when they arrive.               |
| `destinations/DestinationPanel.ts` | The named-destination list.                                                                                       |

The pure files are unit-tested (`test/unit/panels/**`, `test/unit/outline-commands.test.ts`); the
DOM is proved by Playwright in `test/e2e/panels.spec.ts`, which is why the panel files are out of
the coverage gate.

## Three things worth knowing before changing this

**Pages is the default panel, and that is a requirement rather than a preference.**
`ui.leftPaneOnOpen` decides it, it is applied on every document open, and a file that asks for
`/PageMode /UseOutlines` does not get to override the reader. The only exception is a PDF
Portfolio, whose content _is_ its attachment list.

**The column count is derived, never stored.** `+` and `−` step the size ladder and set the pane
to exactly one column at the new size; dragging the splitter wider divides more columns out of
the width it was given. Nothing anywhere remembers "two columns".

**Layer visibility is render-time only.** The PDFium adapter applies it by deactivating the page
objects marked with the group, so the bytes are untouched and undo is exact — and a _save_ needs
the `layers` write intent, which `SetLayerVisibleCommand` therefore always records.

## What M40 and M42 will want

- **M40** (organise pages) reads the thumbnail selection from the shell's `Selection` service
  under the `pages` kind, and adds its items to the `left-pane` context menu. It does not need to
  know this module exists.
- **M42** (portfolios) extends `PdfEngine.collection()` with a writer and the Attachments panel
  with editing. The reader, the schema columns and "open an embedded PDF in a tab" are already
  here; nothing about them is portfolio-specific enough to need forking.

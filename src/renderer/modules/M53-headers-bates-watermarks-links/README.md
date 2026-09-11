# M53 — Page marks and links

Headers and footers, Bates numbering, watermarks, backgrounds, and links — drawn, edited,
followed and found in the text. Brief: `docs/modules/M53-headers-bates-watermarks-links.md`;
contracts: ADR 0020.

| File                                                        | What it is                                                                                                                                                             |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `model.ts`                                                  | The decoration state in `Document.custom('M53')` and the pure functions over it (`plannedDecorationsFor` feeds M21's write plan).                                      |
| `commands.ts`                                               | `SetDecorationsCommand` — one command for add, update, remove and undo — and its journal codec.                                                                        |
| `DecorationService.ts`                                      | The service `"decorations"`: re-applies the model to the live pages, captures each page's original content, finds what a file already carries, and holds the settings. |
| `decorationDialog.ts`                                       | The shared dialog: settings column, page range, presets, and a preview that is the real engine rendering a real copy of a page.                                        |
| `dialogs.ts`                                                | The four settings columns: header and footer, Bates, watermark, background.                                                                                            |
| `presets.ts`                                                | The presets that ship (`resources/presets/decorations.json`) and the reader's own, in one setting.                                                                     |
| `links.ts`                                                  | What a link _is_ in the model: its action as JSON on the annotation, its border, and the words for both.                                                               |
| `LinkService.ts`                                            | The service `"links"`: reads a page's links without disturbing it, follows one safely, creates, edits and deletes.                                                     |
| `linkDialogs.ts`                                            | The link properties dialog, and the review of the addresses found in the text.                                                                                         |
| `LinksPanel.ts`                                             | The left-pane list: every link, what it does, and where.                                                                                                               |
| `tools.ts`, `manifest.ts`, `settings.ts`, `decorations.css` | Contribution points, settings and chrome.                                                                                                                              |

The drawing itself is `src/engine/decorations/` (pure); the PDFium side is
`src/engine/pdfium/decorations.ts`; the writer's side is `src/engine/writers/decorations.ts`;
the overlay is `src/renderer/view/LinkLayer.ts`.

**Two rules worth knowing before changing anything here.**

1. A decoration is found again by its **content mark** (`/YNOTDec`), never by its position in a
   list. Everything about update and remove depends on that.
2. Reading a page's links must not call `Document.loadAnnotations`: it replaces the model's list
   with PDFium's, and PDFium cannot create half the subtypes this application offers. Use
   `annotationsOf`, which loads only a page nobody has looked at yet.

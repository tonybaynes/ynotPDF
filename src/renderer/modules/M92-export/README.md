# M92 — Export to images, text, HTML & RTF

Turns a document into something that is not a PDF: its pages as PNG / JPEG / TIFF / BMP, the
pictures inside it, and its text as plain text, HTML or RTF.

## Where the code is

|                        |                                                                                                                                                                                  |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/engine/export/**` | **All the decisions.** Pure: pixels, text models and bytes in, files out. No DOM, no engine handle, no Electron. Tested in Node against pictures the tests draw themselves.      |
| `export.worker.ts`     | Runs those functions off the main thread. Encoding a 300 dpi page is megapixels of work, and a hundred pages is a hundred of those.                                              |
| `ExportClient.ts`      | The renderer's end of that worker — and the only client in the repo that _answers_ as well as asks: the worker needs pages rendered, and only the renderer can reach the engine. |
| `ExportService.ts`     | Where the pure half meets the open `Document`: what "these pages" means, how a page becomes pixels or a text model, and where the files go.                                      |
| `dialogs.ts`           | The five option dialogs. Native controls on M02's `Dialogs`, page ranges from M41's `fields.ts`.                                                                                 |
| `manifest.ts`          | Five commands, one ribbon group on the Convert tab, one context-menu item, the settings schema.                                                                                  |

## The commands

| Command                                | What it does                                                                                                                                               |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `convert.exportImages` (`Mod+Shift+E`) | Pages as PNG / JPEG / TIFF / BMP: format, resolution, colour, range, name pattern, quality, compression, one multi-page TIFF, annotations and form fields. |
| `convert.exportAllImages`              | Every picture _inside_ the document, in the format the document stores it in.                                                                              |
| `convert.exportText`                   | The text layer in reading order, with an encoding, line endings and a page separator.                                                                      |
| `convert.exportHtml`                   | A web page — positioned (what it looked like) or flowing (what it said), one file or one per page.                                                         |
| `convert.exportRtf`                    | Rich text for a word processor: paragraphs, fonts, sizes, bold, italic, colour, page breaks.                                                               |

Every one of them can be driven entirely from its arguments, with no dialog in the way:

```ts
await run('convert.exportImages', {
  range: '1-3',
  format: 'png',
  dpi: 150,
  directory: 'C:/out', // or `path` for a single file; `ask: false` to write nothing
});
```

`{ pages: [0, 1] }` or `{ range: "1-3, odd" }` choose pages (M40's dialect); with neither, the
thumbnail selection, and failing that the whole document.

## Two things worth knowing

**Nothing here writes a `Command`.** The rule is that every _document change_ is undoable; an
export reads a document and writes files beside it, so there is nothing to undo.

**No new IPC.** Files go out through channels that already existed: `file:writeInto` and
`dialog:pickFolder` (M42), `file:saveAsDialog` and `file:write` (M21). One engine method was
added — `pageImages` (ADR 0019) — because "the picture that is in this file" cannot be got from a
render.

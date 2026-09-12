# ADR 0012 — Printing, and the IPC selection, search and print need

- Status: accepted
- Date: 2026-09-08
- Module: M13 (select, find & print); consumed by M40, M41, M53, M92, M110, M120

## Context

M13 has to put ink on paper, put text and pictures on the clipboard, and search a folder of PDFs
that are not open. None of those can be done from the renderer alone, and printing in particular
has exactly one route in Electron. Three things had to be settled.

1. **How a page reaches a printer.** Electron gives an app `webContents.print()` and
   `webContents.printToPDF()`. There is no "send this bitmap to the spooler" API, no PostScript
   path and no per-platform printing binding we are allowed to add (no new libraries in this
   module, and nothing copyleft anywhere).
2. **Which process does the imposition.** Booklets, n-up, tiling, scaling and auto-rotation
   decide where every page lands. The preview, the paper and "Print to PDF" must all agree.
3. **What the renderer may ask the main process to do.** The clipboard with more than one format,
   a folder picker, a search of files on disk, and a print job — none of it existed.

## Decision

### A print job is an HTML document of images, printed from a hidden window

The renderer imposes the pages and rasterises **one PNG per sheet** at the chosen DPI. Main
writes those PNGs into a temporary folder, writes an `index` HTML beside them — one `<img>` per
sheet, each declared at the exact paper size, with `@page { size: <w>pt <h>pt; margin: 0 }` — loads
it into a hidden `BrowserWindow` and calls `webContents.print()`.

The sheets are files referenced by relative path rather than `data:` URLs inlined in the markup: a
hundred 300-DPI A4 sheets is about 300 MB of base64, which is not a string any process should be
asked to hold. Sheets are sent to main **one at a time** (`print:begin` → `print:sheet` ×n →
`print:finish`), so neither process ever holds the whole job.

Consequences, stated plainly:

- **Everything that reaches a printer is a raster.** There is no vector path to a printer for us.
  At 150 DPI (the default) a page is about 1240 × 1754 pixels, which is what a printer driver
  would have rasterised it to anyway; at 600 DPI it is 5000 × 7000 and the job is large but
  correct. The DPI is in the dialog, and the sheet renderer caps a bitmap's longest edge at
  12 000 px so a mistyped number cannot ask for something that will not allocate.
- **The paper size is declared three times** — in `@page`, on the image's CSS box, and in
  Electron's `pageSize` (converted to microns). All three come from the same plan; disagreeing
  about it is how a print ends up scaled by 96/72.
- **`silent: true`.** Our dialog has already asked everything the OS dialog would, so showing the
  OS one after it would be asking twice.
- Every job cleans up its temporary folder — on finishing, on cancelling, and on quit.

### The imposition is pure, in the renderer, and shared by all three consumers

`print/imposition.ts` maps source pages and options to sheets of `Placement`s, in PDF points with
the origin at the bottom-left of the sheet. It touches no DOM and no engine, so:

- the **preview** renders sheet _n_ of the same plan the paper will get;
- the **printer** path rasterises each sheet of that plan;
- **Print to PDF** draws each sheet of that plan with pdf-lib.

A booklet saved to a file therefore folds exactly the way one that came out of the machine does,
and `test/unit/find/print.test.ts` can state the imposition as a table without a printer, a canvas
or a window.

### "Print as image" is what chooses between vector and raster for Print to PDF

Foxit's switch means "rasterise rather than send marks". For the printer path we have no choice —
see above — so the switch would be meaningless there. It is given the one place it can mean
something:

- **off (the default): vector.** Each source page is embedded as a Form XObject (`pdf-lib`
  `embedPage`) and drawn into its place. The text stays text: the result is searchable, sharp at
  any zoom, and small. Since the M13 completion repair (2026-09-12), a separate print snapshot
  materialises unsaved edits through M21 and bakes printable annotation/widget appearances into
  page content before embedding. Source pages and undo history remain unchanged. M41's appearance
  placement matrix is reused, with print-specific flags, resource isolation and strict failures.
- **on: raster.** Each sheet is the same bitmap the printer would have received, embedded as a
  PNG. Everything visible on screen is in the file, including annotations and widgets. Bigger, and
  no text. Greyscale also uses this route for PDFium colour conversion; the dialog says so.

The dialog says which is which, in words, next to the switch.

### The selection highlight blends with the paper rather than covering it

Not a printing decision, but the same kind: an opaque rectangle over a word hides the word, and
translucency is not available to us (overlays are opaque — CLAUDE.md, PLAN.md §3.2). The
highlights are drawn in the page's text layer with `mix-blend-mode: multiply` — fully opaque
paint that darkens the paper and leaves the ink — and `screen` under Night Mode, where the paper
is already dark. This is also why the selection model is ours rather than the browser's: with our
own model, column select, cross-page runs and "n of m" work the same way on every platform.

### The folder search is a Node worker thread started by main

`search:folder` starts a `worker_thread` (`out/main/searchWorker.js`) with its own PDFium
instance. It walks the tree, opens each file, and matches with **the same pure code the find bar
uses** — `view/TextLayer.ts` for the page model and `find/search.ts` for the matcher — so a folder
search cannot disagree with a search of a document that happens to be open. Results arrive in
batches on `search:results`; cancelling is `terminate()`, not a co-operative flag nobody checks.

The PDFium wasm bytes are read in **main** and handed to the worker in `workerData`. In a packaged
app they live inside `app.asar`, and asar-aware `fs` is a main-process guarantee; whether a worker
thread inherits it is not something to bet a feature on.

The worker needs its own bundle, so `electron.vite.config.ts` grows a second `main` entry. Vite
discovers a Web Worker from `new Worker(new URL(...))`; it cannot discover a Node one, so it is
declared.

## The IPC this adds (all additive)

| Channel                                                      | Why                                                   |
| ------------------------------------------------------------ | ----------------------------------------------------- |
| `clipboard:write`                                            | Text **and** RTF as one item, so a paste target picks |
| `clipboard:writeImage`                                       | Snapshot and Copy Image                               |
| `dialog:pickFolder`                                          | The search panel's folder scope                       |
| `search:folder`, `search:cancel`                             | Start and stop a folder search                        |
| `print:printers`                                             | Fill the dialog's printer list                        |
| `print:begin`, `print:sheet`, `print:finish`, `print:cancel` | A job, a sheet at a time                              |
| `search:results`, `search:progress`, `search:done` (events)  | What the worker has found so far                      |

`SaveDialogOptions` also grows an optional `filters`, so a snapshot can be saved as PNG and search
results as CSV through the same dialog M21 built. Absent, it behaves exactly as before.

## Alternatives considered

- **`printToPDF()` then hand the PDF to the OS.** Every platform's "print this file" route is
  different, several need a helper binary, and the ones that do not still open their own dialog.
- **A native printing binding.** A new native dependency per OS and architecture, for the one
  thing Electron already does.
- **Imposing in main.** Main has no engine, so it would need one, and the preview would then be
  produced by different code from the paper.
- **The browser's own text selection.** Free `::selection`, but it needs a translucent highlight
  to stay readable, gives no column select, and behaves differently on each platform.
- **Searching a folder in the renderer's engine worker.** Reading files still needs main, and a
  folder of a thousand documents would then compete with the viewer for the same worker.

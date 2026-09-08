# ADR 0011 — Converters as pure functions, the IPC creation needs, and a dirty-from-birth document

- Status: accepted
- Date: 2026-09-08
- Module: M91 (create); consumed by M40, M41, M93, M120, M121

## Context

M91 turns images, web pages, HTML, Markdown, plain text and the clipboard into PDF documents.
Four later modules want the same conversions without the dialogs: M40 inserts a converted file
as pages, M41 combines mixed files, M120 runs conversions in batch and M121 from the command
line. Three things had to be settled before any of that could be written against.

1. **Where a converter lives and what it may depend on.** A converter that reaches for the DOM,
   Node's `fs` or an Electron API cannot run in a Worker, a CLI or a batch job.
2. **What the renderer may ask the main process to do.** Printing a web page needs Chromium's
   `printToPDF`, which only a `BrowserWindow` in main has; reading the clipboard as an image and
   decoding the formats pdf-lib has no filter for are also main's (or the platform's) to do.
3. **What "unsaved" means for a document that was never a file.** `UndoStack.isDirty` compares
   the journal length against the position of the last save, so a document with no journal is
   clean. A freshly created document is exactly that: `Ctrl+S` would do nothing and closing it
   would ask nothing.

## Decision

### Converters are pure over bytes; the environment is an argument

`src/engine/create/` defines

```ts
interface Converter<O> {
  readonly id: string;
  readonly label: string;
  readonly extensions: ReadonlyArray<string>;
  readonly mimes: ReadonlyArray<string>;
  accepts(input: { name?: string; mime?: string }): boolean;
  convert(
    inputs: ReadonlyArray<ConvertInput>,
    options: O,
    ctx: ConvertContext,
  ): Promise<ConvertResult>;
}
```

and a `ConverterRegistry` that routes by extension or MIME type. `ConvertContext` carries an
`AbortSignal`, a progress callback and an `env: ConvertEnvironment` — the adapters a host may
install: `rasterDecoder` (decode a BMP/GIF/WebP/HEIC to RGBA) and `printer` (render a URL or an
HTML string to PDF bytes and report its links). Nothing under `src/engine/create/` imports from
`src/renderer/`, `src/main/` or Node; `tsconfig.web.json` already has no Node types, which
enforces it. A converter that needs an adapter the host did not install throws
`ConvertUnsupported` with a reason in words.

The consequence for callers: the renderer runs image and text conversion in a Worker with a
`createImageBitmap` decoder installed; main could run the same code with `nativeImage`; a CLI
runs it with neither and gets a clear error for a WebP rather than a blank page.

### IPC additions (all additive)

| Channel                | Why                                                                                                                                    |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `file:openFilesDialog` | A multi-select open dialog with caller-supplied filters and title. `file:openDialog` stays as the single-PDF picker every module uses. |
| `webpdf:render`        | Load one URL (or one temporary HTML file) in a hidden, sandboxed window; return the PDF bytes, the page title and the links it holds.  |
| `webpdf:cancel`        | Destroys that job's window. A crawl that is cancelled between pages must not leave a window loading.                                   |
| `clipboard:read`       | Text, HTML and the image (as PNG bytes) on the clipboard, in one round trip.                                                           |
| `image:decode`         | `nativeImage` as a last-resort decoder — the only route to HEIC, and only where the OS has a codec.                                    |

`webpdf:render` takes a `WebPrintSettings` (page size, orientation, margins, header/footer,
background graphics, scale, media type, timeout) that is defined once in `src/shared/create.ts`
and used by the dialog, the crawler and main's printer. Main returns bytes and data; every
decision about what the document looks like is made in the renderer or in the pure assembly.

### `UndoStack.markUnsaved()` — additive

One method on `UndoStack`: sets the saved position to a value no journal length can equal, so
`isDirty` is true until `markSaved()` runs. Listeners are notified. `Document` and
`DocumentService` need no change — the existing subscription carries the dirty flag to the tab
and to M21, which then treats the document exactly as it treats an edited file with no path:
`Ctrl+S` becomes Save As, closing asks, and the status bar says "Unsaved changes".

Creation is deliberately **not** a `Command`. There is no document for an undo to revert to,
and a journal entry naming the sources could not be replayed honestly: the clipboard changes,
a web page changes, and a batch of images may be gone. The bytes are the truth; M21's recovery
already says in words that a never-saved document cannot be put back.

### Page-size presets are data

`resources/page-sizes.json` holds the ISO, North American and envelope sizes in millimetres.
`src/engine/create/pageSizes.ts` reads it; M130's preferences and any later dialog that offers a
page size read the same file rather than a literal.

## Consequences

- M40 inserts a converted file by calling the registry for bytes and then `engine.open` +
  `importPages`, as a command of its own. M41 and M120 do the same in a loop. M121 runs the
  registry in Node with no adapters and inherits every limitation as a worded error.
- Two shared files carry one-line additions each: `src/renderer/core/UndoStack.ts`
  (`markUnsaved`) and `src/renderer/app/shell.ts` (non-PDF drops handed to `create.fromDropped`
  when the command exists). `src/shared/ipc.ts`, `src/main/ipc.ts`, `src/main/index.ts` and
  `src/main/menu.ts` gain the channels, the handlers, the printer dependency and a Create
  submenu. All are additive and listed in the PR.
- Chromium's PDF output is what a web page becomes; ynotPDF does not lay out HTML itself.
  Links, tagged structure and page breaks are Chromium's, and the stitch only adds bookmarks
  and turns intra-crawl links into `GoTo` actions.

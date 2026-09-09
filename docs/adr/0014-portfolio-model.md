# ADR 0014 — The PDF Portfolio model (M42)

**Status:** accepted · **Date:** 2026-09-09 · **Module:** M42

## Context

M42 builds PDF Portfolios in full: create one, put files and folders in it, order and
describe them, give it a cover sheet, take files back out, and save it so Foxit and Acrobat
open it as a portfolio again.

M12 already _reads_ a portfolio far enough to list it: `PdfEngine.collection()` reports the
catalogue's `/Collection`, the Attachments panel shows the schema's own columns, and an
embedded PDF opens in a tab. What it does not carry is everything that makes a portfolio a
structure rather than a list — folders, per-file order, the sort and the initial file — and
it has no way to _write_ any of it.

The requirement that decides the design is **round-trip fidelity**. The operator builds
document packs every day, and a pack usually contains a digitally signed instruction PDF.
Opening `Sample Portfolio.pdf`, changing one description and saving must leave every
embedded file byte-identical, so a signature inside one still verifies. That rules out any
route through an API that re-embeds a file to change something about it.

Two measurements were taken on the operator's own portfolio before this was written, and
both came out in favour of the design below:

| Stage                                               | Embedded streams |
| --------------------------------------------------- | ---------------- |
| PDFium open → `FPDF_SaveAsCopy` (the writer's base) | byte-identical   |
| pdf-lib load → save (the writer itself)             | byte-identical   |

Both preserve a stream they were not asked to change, because both re-serialise the object
graph rather than rebuilding it. So a save can be byte-exact as long as nothing in our own
code decodes and re-encodes an embedded file.

## Decisions

### 1. The portfolio model is a shared contract: `src/shared/portfolio.ts`

The structure is agreed in one place because four layers use it: the engine reads it, the
renderer edits it, the writer writes it, and M120 will drive it from a batch op. The file is
types plus pure functions only — no I/O, no DOM, no pdf-lib — so it can be imported from
main, the worker and the renderer alike.

```ts
interface PortfolioFile {
  readonly id: string; // stable within a session; not written to the file
  readonly name: string; // as shown, without any folder prefix
  readonly folderId: number; // 0 is the root folder
  readonly description: string | null;
  readonly mimeType: string | null;
  readonly size: number | null;
  readonly created: string | null; // ISO 8601
  readonly modified: string | null;
  readonly fields: Readonly<Record<string, string>>; // custom schema values (`/CI`)
  readonly order: number;
}

interface PortfolioFolder {
  readonly id: number;
  readonly name: string;
  readonly parentId: number | null; // null only for the root
  readonly description: string | null;
  readonly created: string | null;
  readonly modified: string | null;
}

interface Portfolio {
  readonly view: 'details' | 'tile' | 'hidden';
  readonly schema: ReadonlyArray<PortfolioColumn>;
  readonly sort: { readonly key: string; readonly ascending: boolean } | null;
  readonly initialFile: string | null;
  readonly folders: ReadonlyArray<PortfolioFolder>;
  readonly files: ReadonlyArray<PortfolioFile>;
}
```

`folderId` is a number rather than a path because that is what the file format keys on (see
decision 3), and a path would have to be re-derived on every read anyway.

### 2. `PdfEngine` reads the rest of the collection — additively

`PdfCollection` gains three optional members and `Attachment` gains two. Nothing that reads
either type today has to change, and no method signature moves:

```ts
interface PdfCollection {
  // ... view, fields, initialFile, folderCount as they are
  readonly folders?: ReadonlyArray<CollectionFolder>; // the whole /Folders tree
  readonly sort?: { readonly key: string; readonly ascending: boolean };
  /** `/Reorder` — the schema key a viewer reorders on (Foxit writes `foxit:Order`). */
  readonly reorderKey?: string;
}

interface Attachment {
  // ... name, description, mimeType, size, dates, collectionFields as they are
  /** The raw `/EmbeddedFiles` name-tree key, prefix included. */
  readonly treeKey?: string;
  /** Folder this file sits in; 0 (or absent) is the root. */
  readonly folderId?: number;
}
```

The reading is done where M12 already does it — `readRawInfo` in
`src/engine/pdfium/rawdoc.ts`, pdf-lib's parser over the decrypted bytes — because PDFium's
attachment API exposes none of it. `countFolders` becomes a walk that returns the folders
themselves; the count M12 uses is `folders.length`, unchanged in meaning.

**We extend M12's reader rather than forking it.** There is one name-tree walk, one
collection parser and one `Attachment` shape in the codebase, and both panels read them.

### 3. Files belong to folders through the name-tree key prefix

PDF 2.0 gives `/Collection` a `/Folders` tree of folder dictionaries (`/Type /Folder`,
`/ID`, `/Name`, `/Parent`, `/Child`, `/Next`) but does not put a folder reference on the
file specification. Acrobat 9 and Foxit both solve it the same way: the
`/Names /EmbeddedFiles` key is `<ID>name`, where `ID` is the folder's `/ID`. The operator's
own file uses exactly that, `<0>` for the root.

**We read and write that convention**, because a portfolio the operator's own editor cannot
open is not a portfolio. A key with no `<n>` prefix reads as folder 0, which is what an
ordinary attachment in a non-portfolio document is.

### 4. The writer owns the portfolio, not the engine

`WritePlan` gains one nullable section and `WriteIntent` one member (`'portfolio'`), so a
document that is not a portfolio, or is one nobody has edited, plans exactly what it planned
before:

```ts
interface WritePlan {
  // ... every existing section
  readonly portfolio: PlannedPortfolio | null;
}

interface PlannedPortfolioFile {
  readonly name: string;
  readonly folderId: number;
  readonly description: string | null;
  readonly mimeType: string | null;
  readonly fields: Readonly<Record<string, string>>;
  /** Where the bytes are. */
  readonly source:
    | { readonly kind: 'keep'; readonly treeKey: string } // reuse the object already in the file
    | { readonly kind: 'bytes'; readonly bytes: Uint8Array; readonly created; readonly modified };
}
```

`FullRewriteWriter` rebuilds `/Collection` and `/Names /EmbeddedFiles` from that section, and
this is where byte-identity is enforced:

- **`kind: 'keep'` reuses the existing embedded-file stream object.** The file specification
  is rewritten — that is how a description or a folder changes — but the stream it points at
  is the same `PDFRef` the base document had. Its bytes, its `/Filter`, and its `/Params`
  (size, dates, checksum) are never read, decoded or re-encoded, so a signed PDF inside a
  portfolio is as valid after a save as before it. This is the module's headline acceptance
  test and it is a writer test, written first.
- **`kind: 'bytes'` is the only path that creates a stream**, and it does so once, with
  `/Filter /FlateDecode` and a `/Params` dictionary carrying `/Size`, `/CreationDate`,
  `/ModDate` and an MD5 `/CheckSum` computed from the plaintext, as PDF 7.11.4 asks.

Doing this in the writer rather than through `PdfEngine.addAttachment` is what makes the
guarantee possible at all: PDFium's attachment API re-embeds a file to change any part of
it, and has no notion of folders, order or `/Collection` to begin with. The engine's
attachment methods stay exactly as M12 left them, for ordinary attachments.

### 5. Portfolio structure lives in the document's custom bag

M20 already provides `Document.custom(namespace)` and `setCustom` for "everything a module
may hang off the document", and the `custom` write intent to go with it. M42 keeps its
`Portfolio` there under `"M42"` rather than adding fields to `DocumentState`. Every edit —
add, remove, rename, describe, move, reorder, sort, view, column — is an ordinary `Command`
that swaps that value, so undo is exact and costs nothing to implement per operation.

Bytes of files added in this session are **not** in the custom bag: they are held by
`PortfolioService`, keyed by file id, because the bag is JSON and goes into snapshots.

### 6. The cover sheet is drawn, not printed

The cover is a one-page PDF generated with pdf-lib from
`resources/portfolio/cover-template.json`: an operator-editable data file giving the title
and subtitle text (with `{title}`, `{date}`, `{count}` placeholders), page size, margins,
fonts, sizes and which columns the table of contents lists.

The alternative was M91's HTML route through Chromium's `printToPDF`, which gives richer
layout. It was rejected because it needs the main process and a real window, so cover-sheet
generation could not be unit-tested and would not run in a batch action. Drawing it is pure,
deterministic and testable, and a data-file template still keeps the wording and the layout
out of the code, which is the project rule that mattered here.

The generated page reaches the document through the engine (`importPages` from the
one-page cover document, `deletePages` for the one it replaces), so it is in the bytes
before the writer ever runs and needs no plan section of its own.

### 7. Two new IPC channels

```ts
'file:readFolder': { args: [path: string, options?: ReadFolderOptions]; result: FolderEntry[] };
'file:writeInto': { args: [dir: string, relativePath: string, bytes: Uint8Array]; result: string };
```

- **`file:readFolder`** lists a folder recursively and returns metadata only — path, relative
  path, name, size, modified — never bytes. "New portfolio from a folder" needs the tree
  before it needs any file, and the files are then read one at a time through the existing
  `file:read`, so a 1 GB folder never becomes a 1 GB IPC message.
- **`file:writeInto`** writes one file under a base directory at a relative path, creating
  the directories on the way. "Extract all" preserves the folder structure, and doing it one
  file at a time is what keeps the memory flat. Every path segment is sanitised with the
  existing `safeFileName`, and a relative path that escapes the base directory is refused in
  main — the names come from inside a PDF, and a file specification is free to say
  `../../.bashrc`.

## Consequences

- A portfolio save is byte-exact for every file it did not change, which is the requirement
  the module exists to meet, and it is enforced by a test rather than by care.
- M80's incremental writer inherits the section unchanged: `kind: 'keep'` means "this object
  is already in the file", which is precisely what an incremental update wants to hear.
- `/Folders` written our way is Foxit's and Acrobat's way. A viewer that ignores folders
  still sees every file, because they are all in the one name tree.
- The engine's attachment API keeps its M12 meaning, and an ordinary document with
  attachments is written exactly as it was before this ADR.

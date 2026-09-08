# ADR 0011 — Contract additions for the navigation panels (M12)

**Status:** accepted · **Date:** 2026-09-08 · **Module:** M12

## Context

M12 builds the left-pane panels: thumbnails, bookmarks, layers, attachments and
destinations, plus opening PDF Portfolios. Five things it needs do not exist yet, and four
of them are on contracts other modules code against.

## Decisions

### 1. `PdfEngine` gains four additive methods

```ts
collection(doc): Promise<PdfCollection | null>;
addAttachment(doc, file: NewAttachment): Promise<Attachment>;
updateAttachment(doc, id, patch: AttachmentPatch): Promise<Attachment>;
deleteAttachment(doc, id): Promise<void>;
```

- **`collection`** reports the catalogue's `/Collection` dictionary: the file _is_ a
  portfolio when it is not `null`. It carries the schema (field key, display label, kind,
  order, hidden flag), the view mode and the initial file, which is what the Attachments
  panel needs to show a portfolio's own columns instead of our generic four.
- **`addAttachment` / `updateAttachment` / `deleteAttachment`** make embedded files
  editable. PDFium supports all three (`FPDFDoc_AddAttachment`, `FPDFAttachment_SetFile`,
  `FPDFAttachment_SetStringValue`, `FPDFDoc_DeleteAttachment`), so the commands are
  engine-backed and undo is exact — no write intent, and a render or a save sees the change
  at once.

`Attachment` gains two optional fields at the same time: `created` (`/CreationDate`, which
PDFium exposes and we were dropping) and `collectionFields` (the per-file `/CI` values a
portfolio's custom schema columns are read from). Both are optional, so nothing that reads
an `Attachment` today has to change.

Every addition is a new optional member: `NotImplementedEngine` answers
`NotImplementedError`, the RPC proxy picks them up from `ENGINE_METHODS`, and an adapter
that cannot do one of them stays valid.

### 2. `setLayerVisible` is implemented, not changed

The method has been on the contract since M00 and M20 left it deliberately unimplemented
("a per-object rendering concern that belongs to M12's layer panel"). The PDFium adapter now
implements it by walking each page's objects, matching the object's `/OC` marked-content
name to the group, and calling `FPDFPageObj_SetIsActive`. `FPDFPage_GenerateContent` is
never called, so the bytes on disk are untouched: the change is exactly as reversible as the
view rotation is, which is what undo needs. Saving the new visibility is still M21's job
through the `layers` write intent, which already exists and is already planned for.

### 3. `WriteIntent` gains `destinations`

Named destinations were read-only, so the write plan's `namedDestinations` section was
always `null` — the planner comment says "read-only until M12 edits them". M12 makes them
editable, so it needs to say so. `destinations` joins the union in
`src/renderer/core/model.ts` and `buildWritePlan` fills the section it already had. Purely
additive: a document that does not edit destinations plans exactly what it planned before.

### 4. One new IPC channel

```ts
'shell:openTempFile': { args: [name: string, bytes: Uint8Array]; result: string };
```

**`shell:openTempFile`** writes bytes to a per-session temp directory and hands them to the OS
default application (`shell.openPath`). The renderer has no filesystem, so opening an attachment
cannot be done any other way. The file name is sanitised in main (no separators, no `..`, length
capped) and everything written this way is deleted when the app quits. In an e2e run
(`YNOT_E2E=1`) everything happens except the `shell.openPath` — a test must never make the
machine it runs on open another application.

"Add attachments" also needs a file picker without the PDF filter. M12 wrote one and **M91
shipped the same channel** (`file:openFilesDialog`) while this module was in flight; M91's is
the one that stayed, and M12 calls it. Two modules inventing the same channel a week apart is
worth a note for whoever adds the third: look in `IpcInvokeMap` before adding to it.

### 5. `DocumentView.refresh()` and `Viewer.refresh()` (M11, additive)

Toggling a layer changes what a render of a page looks like without changing any of the
inputs the tile cache keys on. M12 drops the tab's cached tiles and then needs the viewport
to repaint; `setFlags({})` returns early precisely because nothing differs. One public
method on each — invalidate every mounted page view and paint — is the smallest honest way
to say "the pixels are stale". Nothing else in M11 changes.

## Consequences

- Modules after M12 get attachment editing and portfolio metadata for free; **M42**
  (portfolios) extends `collection()` with a writer rather than inventing its own reader.
- An engine adapter that is not PDFium can leave all four new methods unimplemented and the
  panels degrade to read-only, which is the same behaviour they already have for a file that
  has no attachments.
- `shell:openTempFile` writes user data to a temp directory. It is deleted at quit, and it
  is the same exposure Foxit's "Open attachment" has.

## Alternatives considered

- **Rendering layer visibility through `RenderOptions.layers` per request.** The option
  exists on the contract and no adapter implements it. It would mean threading a layer map
  through every tile request and re-keying the tile cache on it, for a state that changes
  perhaps twice in a session — and it could not be saved, because the writer needs the
  document to carry the visibility, not the request. Rejected.
- **Attachments as write intents rather than engine calls.** That is what M20 does for page
  order, because `FPDFPage_Delete` is destructive. Attachments are not: PDFium's delete is a
  name-tree removal, and re-adding the same bytes restores it exactly. Making them intents
  would mean the panel showed a change that no render agreed with until a save.

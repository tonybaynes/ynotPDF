# M72 — Document properties, metadata & XMP, initial view

What a document says about itself, and how it asks to be opened: the Properties dialog
(`Ctrl+D`), the information dictionary and the XMP packet kept in step as one edit, custom
properties, the fonts the file carries, a read-only view of its security, and `/PageMode`,
`/PageLayout`, `/OpenAction` and `/ViewerPreferences` — read on open, applied to the viewer, and
written back on save.

The XMP serialiser is not here. It lives in `src/engine/xmp/`, knows nothing about the model or
the UI, and patches a packet rather than regenerating one, so a PDF/A identification block or an
`xmpMM` history survives a title change. See `docs/adr/0017-properties-and-initial-view-contracts.md`.

| File                   | What                                                                                          |
| ---------------------- | --------------------------------------------------------------------------------------------- |
| `manifest.ts`          | The commands, `Ctrl+D`, the ribbon groups, the File backstage's Properties page.              |
| `PropertiesService.ts` | The `properties` service: the dialog, the fonts cache, and applying the initial view on open. |
| `dialog.ts`            | The six tabs. Words rather than colours; a real tablist; opaque like every other dialog.      |
| `properties.ts`        | The model ↔ dialog mapping, pure: read the document, diff two states, validate a name.        |
| `commands.ts`          | `SetPropertiesCommand` (metadata + XMP as one edit) and `SetInitialViewCommand`.              |
| `apply.ts`             | `/PageMode` and `/OpenAction` translated into calls on M11's viewer and M02's panes.          |
| `fonts.ts`             | The words the Fonts tab uses: "Embedded subset", "Not embedded", "Type 0 (CID TrueType)".     |
| `settings.ts`          | `properties.*` — whether to obey a document's initial view, and how far.                      |
| `properties.css`       | The dialog. Tokens only, nothing transparent.                                                 |

## How it joins the app

- **One edit, two views of it.** `SetPropertiesCommand` writes the model's metadata and re-derives
  the XMP packet from the result, so the file can never be saved with an information dictionary
  and an XMP packet that disagree. That is why this module does not reuse M20's
  `SetMetadataCommand`, which takes a flat string map and knows nothing about XMP.
- **The initial view is model state**, not a private bag: M20 declared `ViewSettings` and left it
  at defaults because nothing filled it. The engine reads it on open (`initialView()`), the
  command changes it, and M21's writer writes it back through the plan's new `view` section.
- **Applying it is this module's job, not M11's.** The brief puts it in the viewer, and it belongs
  there in spirit — but a module writes inside its own folder, so `apply.ts` translates the
  settings and the service hangs that off `Documents.onAttached`, the signal M21 already uses.
- **`/PageMode` is stored and written but never obeyed.** M12 carries the operator's requirement
  that `ui.leftPaneOnOpen` decides which panel opens, whatever a document asks for. The dialog and
  the applied report both say so in words rather than quietly doing nothing.
- **The Security tab is M70's own panel**, the element that module exports for exactly this, so
  the two places a reader can look at a document's protection say the same words.

## What it deliberately does not do

- **Edit XMP by hand.** The raw packet is shown on the Advanced tab and is read-only. A free-text
  XMP editor is the Parked half of this module's brief, and an editable box next to fields that
  re-derive the packet would be two ways to set the same thing.
- **Resize or centre the window** for a document that asks. A window with several tabs in it
  belongs to all of them; the flags are stored and written back exactly as the file set them, and
  the dialog says so in words rather than pretending.
- **Hide the toolbar because a file said so** — unless the reader turned that on
  (`properties.applyWindowOptions`, off by default). Most files carrying those flags got them from
  a tool that set them without being asked.

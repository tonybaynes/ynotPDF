# M20 — Document model, commands & undo stack

The model itself is `src/renderer/core/` (`Document`, `model`, `Ids`, `commands`, `events`,
`Journal`, and the transactions added to `UndoStack`); see `docs/modules/M20-document-model.md`
and ADRs 0007 and 0008. This module folder holds the renderer-side contribution:

- `DocumentService` — registered as the service `document`. Owns the `Document` behind each
  shell tab, keeps the tab's title and "Modified" marker in step with the model, and asks the
  shell to re-evaluate `when()` whenever the undo stack moves. M11 and M21 take documents from
  here rather than opening their own.
- `edit.undo` / `edit.redo` — `Mod+Z`, `Mod+Y` and `Mod+Shift+Z`. Registered commands, so they
  appear in the palette, on the Edit ribbon tab and in the quick-access toolbar. Their ribbon
  buttons rename themselves to name the change they would revert — "Undo Rotate page" — through
  the `dynamicLabel` hook of ADR 0008, and grey out when there is no history.
- `page.rotateRight` / `page.rotateLeft` — the first real document edits, on the Organize tab.
  M40 will take page organisation over; these exist so the model is reachable from the UI now.
- `dev.document*` (Developer) — `dev.documentOpen`, `dev.documentApply`, `dev.documentSummary`
  and `dev.documentJournal`. They open a fixture, apply model commands and report the model back
  as plain data, which is how `test/e2e/document.spec.ts` drives a real document through the
  packaged app.

M00 stubbed `edit.undo` and `edit.redo` against a `document` service that did not exist yet; this
module registers the real ones and provides that service, so the two stubs were removed from
M00's manifest in the same change.

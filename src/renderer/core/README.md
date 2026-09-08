# src/renderer/core

Framework-free application core. No DOM here except `Store.bind`; no Electron.

| File           | What                                                                                                           |
| -------------- | -------------------------------------------------------------------------------------------------------------- |
| `Store.ts`     | `createStore` — the in-house reactive store (`get/set/select/batch`). State → DOM.                             |
| `Command.ts`   | `Command` (`do/undo/merge`), `CompositeCommand`, `SetPropertyCommand`. **Every document change is a Command.** |
| `UndoStack.ts` | Unlimited undo/redo, merge coalescing, groups and transactions, dirty tracking. One per document.              |
| `Registry.ts`  | Module manifests → commands, palette entries, shortcuts, ribbon groups, panels, tools, services.               |
| `Selection.ts` | The current selection (text / annotations / objects / pages / fields / region).                                |
| `Document.ts`  | In-memory model of one open PDF + its journal. Engine = bytes, Document = intent.                              |
| `model.ts`     | The model's entity types: pages, the annotation union, fields, outline, destinations, layers.                  |
| `Ids.ts`       | Stable model ids, and the two-way table between them and the engine's own keys.                                |
| `commands.ts`  | The concrete document commands: rotate, insert, delete, move, crop, annotate, set a field.                     |
| `events.ts`    | Fine-grained change events, so a view repaints one annotation instead of a page.                               |
| `Journal.ts`   | Commands as plain data: autosave and recovery (M21), batch replay (M120).                                      |

## How a change happens (M20, ADR 0007)

1. A module builds a command from `commands.ts` and calls `document.apply(command)`.
2. The command edits the **model** first — the model is the authority for intent.
3. It then offers the change to the **engine**, so the next render shows it.
4. What the engine cannot express becomes a `WriteIntent` on the document, and M21's writer
   applies it at save time. `NotImplementedError` from the engine is an expected answer here.

Page **order** and page **presence** are the model's alone and never reach PDFium: `FPDFPage_Delete`
is destructive and could not be undone. A view turns a model page id into the live PDFium index
with `document.enginePage(pageId)`.

Shared-file rule (PLAN.md §12.3): edits here must be minimal, additive and called out in the PR.

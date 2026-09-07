# src/renderer/core

Framework-free application core. No DOM here except `Store.bind`; no Electron.

| File           | What                                                                                                           |
| -------------- | -------------------------------------------------------------------------------------------------------------- |
| `Store.ts`     | `createStore` — the in-house reactive store (`get/set/select/batch`). State → DOM.                             |
| `Command.ts`   | `Command` (`do/undo/merge`), `CompositeCommand`, `SetPropertyCommand`. **Every document change is a Command.** |
| `UndoStack.ts` | Unlimited undo/redo with merge coalescing, grouping, dirty tracking. One per document.                         |
| `Registry.ts`  | Module manifests → commands, palette entries, shortcuts, ribbon groups, panels, tools, services.               |
| `Selection.ts` | The current selection (text / annotations / objects / pages / fields / region).                                |
| `Document.ts`  | In-memory model of one open PDF + its journal. Engine = bytes, Document = intent.                              |

Shared-file rule (PLAN.md §12.3): edits here must be minimal, additive and called out in the PR.

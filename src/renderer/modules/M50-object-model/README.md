# M50 — Page-object model

Select, move, resize, rotate, flip, align, distribute, arrange, group, delete and
cut/copy/paste the objects of a page (text blocks, images, paths, shadings, form
XObjects). Brief: `docs/modules/M50-object-model.md`; contracts: ADR 0018.

| File                                                         | What it is                                                                                                              |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| `model.ts`                                                   | The edit state in `Document.custom('M50')` and the pure functions over it (`plannedObjectsFor` feeds M21's write plan). |
| `commands.ts`                                                | Every change as a `Command`: transform, delete, insert, reorder, style, groups — plus the journal codecs.               |
| `blocks.ts`                                                  | Text objects grouped into blocks with M13's paragraph heuristic.                                                        |
| `geometry.ts`                                                | Resize/rotate/flip matrices, align and distribute, snapping.                                                            |
| `ObjectService.ts`                                           | The service `"objects"`: per-tab layer and page data, the selection, the clipboard, and one method per user action.     |
| `ObjectController.ts`                                        | Pointer and keyboard while an Edit Object tool is active.                                                               |
| `PropertiesPanel.ts`                                         | The right-pane panel: position, size, rotation, stroke/fill, image and text facts.                                      |
| `tools.ts`, `manifest.ts`, `settings.ts`, `object-model.css` | Contribution points, settings and chrome.                                                                               |

The overlay itself is `src/renderer/view/ObjectLayer.ts`; the content-stream parser the
writer replays edits with is `src/engine/content/`; the PDFium mutations are
`src/engine/pdfium/objects.ts`.

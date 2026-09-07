# ADR 0004 — Shell contribution points: rich ribbon items, contextual tabs, status bar, backstage, context menus

- Status: accepted
- Date: 2026-09-07
- Module: M02 (application shell); consumed by every feature module

## Context

M00 stubbed `ModuleManifest` with `commands`, `ribbon` (groups of command ids), `panels`, `tools`,
`shortcuts` and `settings`. That is enough for a palette and a plain button ribbon, but the shell
M02 has to build (a Foxit-style ribbon, File backstage, status bar and right-click menus) needs
things a bare command id cannot express:

- ribbon controls that are not buttons: split buttons, dropdown menus, toggles that show a
  pressed state, galleries, colour pickers and inline inputs;
- contextual ribbon tabs ("Ink Tools") that exist only while a predicate holds;
- a right properties pane that shows the panel whose predicate matches the selection;
- status-bar slots, backstage slots and context-menu contributions that modules fill;
- pinned recent files.

`PLAN.md` §12.5 says contracts change only by ADR and only additively.

## Decision

All of the following are **optional additions** to `src/shared/module.ts` and `src/shared/ipc.ts`.
No existing field changed type in a way that breaks a manifest written against M00 — M00's and
M01's manifests compile and render unchanged.

### Ribbon items

`RibbonGroupSpec.items` is now `ReadonlyArray<RibbonItemSpec>` where `RibbonItemSpec` is either
the existing `string` (a command id, or `"-"` for a separator) or one of:

| `kind`     | Fields                                                                | Renders as                                                        |
| ---------- | --------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `button`   | `command`, `size?`                                                    | plain button (same as a string id)                                |
| `split`    | `command`, `menu`, `size?`                                            | main action + arrow that opens `menu`                             |
| `dropdown` | `id`, `label`, `icon?`, `menu`, `size?`                               | button that opens `menu`                                          |
| `toggle`   | `command`, `pressed(ctx)`, `size?`                                    | button with `aria-pressed` from `pressed(ctx)`                    |
| `gallery`  | `id`, `label`, `command`, `options`, `selected?(ctx)`                 | grid popup; picking runs `command` with `{ value }`               |
| `color`    | `id`, `label`, `command`, `value(ctx)`, `swatches?`                   | swatch button; popup grid + custom `<input type=color>`           |
| `input`    | `id`, `label`, `command`, `value(ctx)`, `type?`, `width?`, `options?` | inline text/number/select; change runs `command` with `{ value }` |

`size` is `'large' | 'small'` and overrides the group's `large` list. A `MenuItemSpec` is a
command id string, `"-"`, or `{ label, command?, args?, icon?, submenu?, checked?(ctx) }`.

### Contextual tabs

`ModuleManifest.ribbonTabs?: ReadonlyArray<RibbonTabSpec>` with `{ id, label, when, order?,
after? }`. `RibbonGroupSpec.tab` accepts a `RibbonTabId` **or** a contextual tab id. The shell
shows a contextual tab (and its groups) only while `when(ctx)` is true, re-evaluated on every
`ui.invalidate()`.

### Panels

`PanelSpec.when?: WhenClause`. For `dock: 'right'` the properties pane shows the first panel
(by `order`) whose `when` passes and hides itself when none does. Left panels ignore `when`.

### Status bar, backstage, context menus

- `ModuleManifest.statusBar?: ReadonlyArray<StatusItemSpec>` — `{ id, slot: 'left' | 'centre' |
'right', order?, mount(host, ctx) }`.
- `ModuleManifest.backstage?: ReadonlyArray<BackstageSpec>` — `{ slot, label?, icon?, order?,
command? | mount?(host, ctx) }`. Slots are the fixed Foxit list `open | recent | new | save |
saveAs | print | properties | preferences | exit`; a module fills one by declaring it. A slot
  nobody fills is shown disabled with the words "Not available yet". `new` collects **creators**:
  `ModuleManifest.creators?: ReadonlyArray<CreatorSpec>` — `{ id, label, description?, icon?,
command }` listed as tiles on the New page and on the empty state.
- `ModuleManifest.contextMenus?: ReadonlyArray<ContextMenuSpec>` — `{ id, region, items,
order?, when? }` where `region` is `'document' | 'tab' | 'left-pane' | 'right-pane' | 'ribbon' |
'any'` or a CSS selector. The `contextMenu` service also accepts the same object at runtime.

### Commands

`CommandSpec.keyTip?: string` — overrides the generated ribbon key tip (Alt navigation).

### IPC

- `RecentFile.pinned?: boolean`; new channels `recent:pin(path, pinned)` and `recent:remove(path)`.
- `window:new(path?: string)` opens another window, optionally loading a file — tab drag-out.
- `window:getState() → { maximized, fullScreen }` for the status bar / tests.
- `window:list() → number` for tests.

## Consequences

- Feature modules describe _what_ control they want; the shell owns how it looks, its keyboard
  behaviour and its theme. Nothing outside `src/renderer/app/` builds ribbon DOM.
- The `when` re-evaluation is explicit (`ui.invalidate()`), so predicates stay cheap pure
  functions and the shell re-renders per group, not per keystroke.
- M130 (ribbon/QAT customisation, shortcut editor) reads the same specs; nothing here
  presupposes its UI.
- The demo module under `test/e2e/demo-module/` uses every kind above and is the regression
  suite for the contract.

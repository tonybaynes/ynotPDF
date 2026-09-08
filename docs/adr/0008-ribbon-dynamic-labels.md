# ADR 0008 — Ribbon buttons may carry a dynamic label

- Status: accepted
- Date: 2026-09-08
- Module: M20 (document model); consumed by any module whose button text depends on state

## Context

Foxit's Edit menu and ribbon name the change that undo would revert: "Undo Rotate Pages", then
"Undo Delete Page" after the next edit. M20's acceptance test requires the same — the ribbon
undo and redo buttons must show the current command label and enable and disable correctly.

`CommandSpec.label` is a constant read once when the ribbon group is built. The shell already
re-evaluates each item's dynamic state on every `invalidate()` (`itemState` in
`src/renderer/app/ribbon/model.ts`) and re-renders a group when its signature changes, but the
only dynamic members are `enabled`, `pressed` and `value`. `value` is consumed by the gallery,
colour and input kinds; buttons have nowhere to put changing text.

Registering one command per possible label is not an option: the label is the label of whatever
the user last did, which is unbounded.

## Decision

`RibbonItemSpec`'s `button` and `toggle` variants gain an optional
`dynamicLabel?: (ctx: ServiceContext) => string`. When present, the shell calls it wherever it
already computes item state and uses the result as the button's visible text and as the first
line of its tooltip. When absent, nothing changes: the item keeps `CommandSpec.label`.

Mechanically:

- `ItemState` gains `label: string | null`, computed by `itemState()` inside the same
  `try`/`catch` that already guards `pressed` and `value`, so a throwing callback logs and
  falls back to the static label rather than breaking the ribbon.
- `groupSignature()` includes the label, so a group re-renders when the text changes.
- `renderButton()` and `renderToggle()` apply `state.label` to the label span and to `title`.

The accessible name follows the visible text, because the label span is the button's content.
Screen readers therefore announce "Undo Rotate pages" — the same string a sighted user reads,
which is the behaviour the operator's accessibility rules ask for.

## Alternatives rejected

- **A custom widget kind** (`kind: 'undo'`): puts a document concept in the shell, which is
  exactly what the manifest contract exists to avoid.
- **Mutating `CommandSpec.label` at runtime**: the registry hands out the spec object by
  reference to the palette, key tips and the QAT, so a mutation would leak into all of them and
  the palette would list a command whose name changes as you edit.
- **A separate `ribbon.setLabel(id, text)` service call**: imperative, needs every producer to
  remember to call it, and has no answer for the first paint.

## Consequences

- One optional field on two item variants; every existing manifest is unaffected, and the
  M02 ribbon unit tests pass unchanged.
- The label is recomputed on each `invalidate()`, which is a string concatenation per undo
  button. The signature comparison means the DOM is touched only when the text actually
  changes.
- Later modules get the same affordance for free: M13's "Find next" count, M60's field-name
  chip, M110's compare state.

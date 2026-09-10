# ADR 0019 — The UI-journey and layout test harness (M04)

- **Status:** accepted
- **Date:** 2026-09-10
- **Module:** M04 — UI-journey and layout test harness
- **Amends:** the e2e harness from [ADR 0004](0004-shell-contribution-points.md); adds one
  launch flag to `YnotBridge` ([ADR 0003](0003-settings-ipc.md) is untouched)

## Context

Between 2026-09-08 and 2026-09-10 the operator opened the installed app and found five defects
by clicking, in three days, that roughly four thousand automated tests had passed over:

| #   | What the operator saw                                                                         | Fixed in  |
| --- | --------------------------------------------------------------------------------------------- | --------- |
| 1   | The start page in the bottom half of the window behind a dead black band, its top unreachable | `90cdd1c` |
| 2   | The Pages panel permanently reading "the navigation panels are not available"                 | `884f000` |
| 3   | The right pane clipping its contents at the reader's UI scale                                 | `d1edee4` |
| 4   | Two rows of tabs — Electron's application menu above the ribbon                               | `d1edee4` |
| 5   | A stamp the reader made would not go on the page                                              | `45d810f` |

They are one defect wearing five hats. **The suite drove the app through its command API and
asserted that things exist; the operator drove it through the UI and saw where things were.**

- `expect(locator).toBeVisible()` is true of an element half-clipped and pushed into a corner
  (1), and of a pane whose contents are cut off at its right edge (3).
- Under `YNOT_E2E` a demo module registers two left panels that sort before M12's, so the panel
  a fresh profile opened was the demo's and the real startup path was never taken (2).
- Every test ran at 100 % UI scale, in one window size, and nothing ever looked at the window
  chrome (3, 4).
- Every stamp test called `draw.stamp` **with coordinates**; nothing clicked a tile and then a
  page, so neither the pointer path nor the placeability of a reader-made stamp was covered (5).

M04 closes that gap. It is a test module: it adds no product behaviour beyond one launch flag.

## Decision

### 1. Layout is asserted, not eyeballed — `test/e2e/layout.ts`

Four helpers, usable from any spec, each of which **names the offending element and both
numbers** when it fails. A helper that says "something is clipped" costs the next reader an
afternoon.

| Helper                        | Asserts                                                                                                                                                                                                                       |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `expectNothingClipped(scope)` | No descendant overflows its own box, unless it is a deliberate scroll container (`overflow: auto\|scroll`) — which must then be _reachable_: `scrollTop` returns to 0 and the first child's top is not above the container's. |
| `expectInsideWindow(scope)`   | Every visible element's rect lies inside the viewport, and `document.body` never scrolls horizontally.                                                                                                                        |
| `expectNoOverlap(a, b)`       | Two regions do not overlap — chrome against content.                                                                                                                                                                          |
| `expectReadable(scope)`       | Computed text/background contrast ≥ 4.5:1, and no `opacity < 1`, `rgba()` alpha or `backdrop-filter` anywhere.                                                                                                                |

**Reachability is the point of the first one, not overflow.** `justify-content: center` on a
scrolling box centres content that is taller than the box and _pushes its top above the scroll
origin_, where no scrollbar can reach it. That is defect 1 exactly, and `toBeVisible()` is
happy with it.

`expectReadable` **extends** the opacity walk that `annotations.spec.ts`, `comments.spec.ts`,
`drawing.spec.ts` and `preferences.spec.ts` each carried a copy of, rather than adding a fifth:
the shared implementation lives in `layout.ts` and those specs call it.

### 2. A journey is driven the way a person drives it — `test/e2e/journey.ts`

`clickRibbon(tab, label)` selects a ribbon tab and presses a button **by its visible label**;
`openPanel(id)` and `clickPanelTile(panel, selector)` work the left pane; `clickPage(point)` and
`dragOnPage(from, to)` work in page coordinates; `answerIdentityIfAsked(name)` deals with the
identity dialog the first annotation opens, which a journey must handle rather than hang on.

**Every helper asserts the thing it clicked was actually hit.** Playwright's actionability retry
ends in a pass often enough that "intercepts pointer events" goes unnoticed: the helpers check
`elementFromPoint` at the click point resolves inside the target _before_ clicking, and report
what is covering it when it does not.

### 3. `YNOT_E2E_NO_DEMO=1` — the one product change

The renderer registers the demo module only when the bridge says so:

```ts
// src/shared/ipc.ts
readonly e2eDemoModule: boolean;
```

`src/main/window.ts` adds `--ynot-e2e-no-demo` to `additionalArguments` under
`YNOT_E2E_NO_DEMO=1`; `src/preload/index.ts` reads it; `src/renderer/main.ts` honours it. Four
additive lines, no behaviour change in a release build (`e2e` is already false there).

### 3a. One more channel, found by the tests: `app:ready`

`IpcInvokeMap` gains `'app:ready': { args: []; result: void }` — renderer to main, no payload,
sent once at the end of the renderer's boot. Additive; nothing else changes.

Main used to decide the renderer was listening from `did-finish-load`, which fires when the
_document_ has loaded — while the renderer's entry module still has a theme to read, a shell to
mount and its IPC listeners to install, all behind `await`s. A PDF from the command line or a
file association was pushed at that moment and landed on nobody: the app opened empty,
intermittently, which is exactly why it had survived. The startup spec found it as a flake and
then reproduced it. `boot()` no longer flushes `pendingOpens` on `did-finish-load`; it flushes
them when the renderer says it is ready.

**Why a flag and not deleting the demo module:** the demo module is the shell's own regression
suite (M02) and covers every contribution point. Both worlds have to be testable — the one the
shell tests need, and the one the reader actually gets.

### 4. Scale and window size are a matrix, not an assumption

`test/e2e/scale-matrix.spec.ts` runs the layout assertions at **100 %, 150 % and 200 %** UI
scale across **1280×800, 1920×1080 and 1280×600**, over the start page, a document with both
panes open, every ribbon tab, the comments panel and the three largest dialogs. The short window
is where defect 1 lived; 150 % is where defect 3 lived.

The scale is seeded into the profile (`ui.scale`) rather than set by a command afterwards, so
the _first paint_ happens at that scale. Window size is set with `BrowserWindow.setContentSize`.

### 5. Visual regression, kept cheap

`test/e2e/visual.spec.ts` — 10 screens (start page, a document with both panes, the four themes,
and four of the ribbon's tabs) at one size, `maxDiffPixelRatio: 0.02`. Baselines are per platform
and committed; a platform with none skips with a message rather than failing, so seeding macOS
and Linux is one command on each and a commit. **The point is catching a layout collapse, not
policing pixels**; a suite that fails on antialiasing gets disabled within a week.

### 6. The rule, written down

`test/README.md` states it and every module brief now carries it in the shared acceptance
wording:

> **A feature is not covered until a test reaches it the way a person does.** Asserting that
> something is _visible_ is not asserting that it is _usable_.

A CI step warns — never blocks — when a new `*.spec.ts` uses no journey helper at all.

## Consequences

- Every later module gains the helpers and must use them; the journey specs are the pattern.
- The suite grows by about two minutes. The budget is ten on CI (`playwright.config.ts` runs one
  worker), and the matrix is the expensive part, so it relaunches only where the scale actually
  has to differ at first paint.
- `launchApp` gained four options (`noDemo`, `settings`, `open`, `window`) and `App` gained
  `resize`, `contentSize` and `userData`. All additive; every existing call site is unchanged.
- **A journey that finds a real defect is fixed in product code, not weakened in the test.**
  That is the whole point of the module, and the Build log in `docs/modules/M04-ui-journey-tests.md`
  records what each one found.

# test

- `unit/` — vitest. Model, engine, lint-rule and hook tests. `npm test` enforces coverage gates
  on `Store.ts`, `UndoStack.ts`, the M20 model files (`Document`, `commands`, `Journal`, `Ids`,
  `model`, `events`) and the theme maths.
  - `unit/core/` — the document model (M20). `fakeEngine.ts` is an in-memory `PdfEngine` so the
    property test can apply a thousand commands in seconds and can turn individual mutations off
    to exercise the fallback paths; `integration.test.ts` runs the same model over real PDFium.
  - `unit/engine/` — the PDFium adapter (M10, M20) against the fixture corpus.
- `e2e/` — Playwright driving the built Electron app through `harness.ts`
  (`launchApp()` → `run(commandId, args)`). Every module's UI test goes through this.
  - `layout.ts` — `expectNothingClipped`, `expectInsideWindow`, `expectNoOverlap`,
    `expectReadable` (M04). What `toBeVisible()` does not tell you.
  - `journey.ts` — `clickRibbon`, `openPanel`, `clickPanelTile`, `clickPage`, `dragOnPage`,
    `answerIdentityIfAsked` (M04). Driving the app the way a person drives it.
  - `journeys/` — one journey per merged module, plus `coverage.spec.ts`, which fails when a
    module ticked in `PLAN.md` §0 has no journey named after it.
  - `startup.spec.ts`, `scale-matrix.spec.ts`, `visual.spec.ts` — the real startup paths, the
    UI-scale × window-size matrix, and the cheap visual baselines.
- `fixtures/` — synthetic PDF corpus; see its README. The only place `.pdf` files may live.

## Running the suite while you work

E2E windows are **invisible by default**: parked off every display, transparent, kept out of the
taskbar, and shown inactive, so a run never steals the keyboard or follows you between virtual
desktops. Playwright drives the renderer over the debug protocol rather than real OS input, so
nothing is lost — screenshots, focus order and pointer journeys all still work.

To watch a run (debugging a journey, say):

```bash
YNOT_E2E_VISIBLE=1 npx playwright test test/e2e/<spec>.spec.ts
```

On Windows PowerShell: `$env:YNOT_E2E_VISIBLE=1; npx playwright test …` — and clear it after with
`Remove-Item Env:YNOT_E2E_VISIBLE`.

## The rule

**A feature is not covered until a test reaches it the way a person does.**
Asserting that something is _visible_ is not asserting that it is _usable_.

The operator opened the installed app on 2026-09-10 and found five defects by clicking that
four thousand automated tests had passed over. Every one of them satisfied
`expect(locator).toBeVisible()`:

| What they saw                                                        | What the suite believed                      |
| -------------------------------------------------------------------- | -------------------------------------------- |
| The start page in the bottom half of the window, its top unreachable | `#empty-state` is visible                    |
| The Pages panel reading "the navigation panels are not available"    | the panel mounted                            |
| The right pane cutting its contents off at 150 % UI scale            | the pane is visible                          |
| Two rows of tabs, Electron's menu above the ribbon                   | the ribbon is visible                        |
| A stamp that would not go on the page                                | `draw.stamp` with coordinates returned an id |

So, for every module:

1. **Press the button a person presses.** `clickRibbon(tab, label)` finds it by its _visible
   label_, not by a command id. `app.run(...)` is for setup — opening a file, seeding an
   identity, reading state back through a `dev.*` command — never for the action under test.
   `journeys/coverage.spec.ts` enforces both halves of that.
2. **Assert where things are, not just that they exist.** End a journey with
   `expectWindowSound(page)`; use `expectNothingClipped`, `expectInsideWindow`,
   `expectNoOverlap` and `expectReadable` on whatever the journey opened.
3. **Take the real startup path.** `launchApp({ noDemo: true })` leaves out the e2e demo module,
   whose panels sort before M12's and hid defect 2 for a month. Seed settings with
   `launchApp({ settings })` when a setting has to be true at the _first paint_.
4. **Do not assume 100 % and one window size.** `scale-matrix.spec.ts` runs the layout
   assertions at 100/150/200 % across 1280×800, 1920×1080 and a deliberately short 1280×600.
5. **Aim at page content in fractions, not pixels.** The viewer re-fits the page whenever the
   window around it changes — the first annotation opens the properties pane and the page goes
   from 1006 px wide to 720 — so `clickPageAt([0.33, 0.21])` survives what `clickPage([330, 300])`
   does not.
6. **Deliberate clipping is declared, not tolerated.** A box that truncates on purpose (a
   comments row clamped to three lines, a fixed-size preview frame) carries `data-allow-clip`
   with a sentence saying why. Anything else that is cut off is a defect.

If a journey finds a real defect, **fix the product**, not the test.

## Visual baselines

`visual.spec.ts` compares ten screens with `maxDiffPixelRatio: 0.02`. Baselines live in
`e2e/visual.spec.ts-snapshots/` and are per platform. A platform with none skips with a message
rather than failing; to seed one, run on that machine:

```bash
npx playwright test test/e2e/visual.spec.ts --update-snapshots=all
```

and commit what it writes.

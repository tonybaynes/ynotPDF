# src/renderer/theme

**The only place colour literals are allowed** (`scripts/check-styles.ts` enforces that).
Everything else in the app uses `var(--token)`.

## What is here

| File                                                                   | Role                                                                                                                                                                                                                                                                                                 |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tokens.css`                                                           | The token catalogue. Documents every colour token in a comment block (the tests and the gallery read that list) and defines the non-colour tokens: type scale, spacing, radii, focus widths, `--elevation`, `--ui-scale`. Also the global `:focus-visible`, `::placeholder` and `::selection` rules. |
| `graphite.css` · `midnight.css` · `daylight.css` · `high-contrast.css` | The four palettes. Each assigns **all** colour tokens under `[data-theme="<name>"]` as plain hex, and sets `color-scheme`.                                                                                                                                                                           |
| `themes.ts`                                                            | The theme list (name, label, `color-scheme`, description, file) and the UI-scale limits. Single source of truth.                                                                                                                                                                                     |
| `ThemeManager.ts`                                                      | Applies a theme, persists the choice and the UI scale, notifies listeners.                                                                                                                                                                                                                           |
| `contrast.ts`                                                          | Colour maths: sRGB↔linear, WCAG luminance and contrast, CIE L\* and L\*a\*b\*, Machado 2009 colour-vision simulation. No dependencies.                                                                                                                                                               |
| `separation.ts`                                                        | The status-colour separation rule (see ADR 0002).                                                                                                                                                                                                                                                    |
| `pairs.ts`                                                             | Which token sits on which, and the minimum ratio for each pair.                                                                                                                                                                                                                                      |
| `parse.ts`                                                             | Reads a theme CSS file into a token map.                                                                                                                                                                                                                                                             |
| `gallery.*`                                                            | Dev-only approval page: `npm run gallery`.                                                                                                                                                                                                                                                           |

## Rules

Text ≥ 4.5:1, icons and borders ≥ 3:1, in every theme. `--fg-muted` is text, so it is 4.5:1 too
— no dim grey on dark. `--fg-placeholder` is the only low-contrast text and still reaches 3:1.

No `rgba()`/`hsla()` with alpha < 1, no `opacity` < 1, no `backdrop-filter`: overlays are opaque.

Status is a word **and** an icon; the colour reinforces it. Status colours never differ by
red↔green alone — see `separation.ts` and `docs/adr/0002-status-colour-separation.md`.

## Changing a palette

Edit the hex value, then run `npm test`. `test/unit/theme-contrast.test.ts` checks all 136 pairs
in all four themes and `test/unit/theme-colour-vision.test.ts` checks the status separation; both
fail the build if a value breaks a rule. `npm run gallery` shows the result side by side.

Adding a token: document it in the `tokens.css` comment list, give it a value in **all four**
themes, and add the pairs it takes part in to `pairs.ts`. The tests enforce all three.

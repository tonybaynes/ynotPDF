# M01 — Theme system

The module wrapper around `src/renderer/theme/`: it registers the theme and UI-scale commands,
persists the choice through the settings IPC, and puts the quick-switch in the status bar.

- `manifest.ts` — commands (`view.theme.*`, `view.uiScale.*`), the View ribbon group, and the
  settings schema M130's preferences page will render. `activate()` keeps the OS chrome in step
  with the theme.
- `storage.ts` — reads and writes `theme.name` and `ui.scale` over `settings:get`/`settings:set`,
  validating both before they reach the ThemeManager.
- `switcher.ts` — the status-bar `<select>`. It runs `view.theme.set` rather than calling the
  manager, so every change goes through the command table.

The colour system itself — tokens, the four palettes, the contrast maths and the tests — lives
in `src/renderer/theme/`.

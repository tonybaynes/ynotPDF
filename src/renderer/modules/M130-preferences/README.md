# M130 — Preferences, keyboard shortcuts, ribbon & toolbar, UI scale, i18n

One dialog (`Ctrl+K`, or the File tab's Preferences button) holding every setting in the
application, a keyboard-shortcut editor with conflict detection and a printable sheet, ribbon and
quick-access-toolbar customisation, the interface font and scale, identity, units, and the
localisation framework.

Nothing in the dialog is written per module. The pages are generated from the `SettingsSchema`
every module already declares on its manifest, so a module merged next week appears with no change
here — and a setting whose title changes is retitled the moment its module says so. What is not
generated is a short list of pages that are not settings at all: the shortcut editor, the ribbon
customiser and the settings file itself.

The contract additions this needs are in
[`docs/adr/0018-preferences-contracts.md`](../../../../docs/adr/0018-preferences-contracts.md).

| File                      | What                                                                                                   |
| ------------------------- | ------------------------------------------------------------------------------------------------------ |
| `manifest.ts`             | The commands, `Ctrl+K` / `Ctrl+,`, the Help ribbon group, the File backstage's Preferences slot.       |
| `PreferencesService.ts`   | The `preferences` service: the appliers, the shortcut rebinding, the ribbon diff, file dialogs.        |
| `SettingsService.ts`      | The settings hub — read, write, reset, import/export, and getting a change to the module that owns it. |
| `PreferencesDialog.ts`    | The dialog: pages down the left, search across everything, live apply, per-page reset.                 |
| `controls.ts`             | One control per setting type, including the four M130 added (colour token, path, list, units).         |
| `model.ts`                | Pure: manifests → pages, the search, the coercion that survives a hand-edited file.                    |
| `shortcuts/model.ts`      | Pure: the binding table, conflicts, what a key may be, export/import.                                  |
| `shortcuts/editor.ts`     | The editor page: record a chord, resolve a conflict in words, reset.                                   |
| `shortcuts/cheatsheet.ts` | The printable PDF, drawn with pdf-lib from `resources/shortcuts/cheatsheet.json`.                      |
| `customise/model.ts`      | Pure: the ribbon diff — hide, show, reorder — applied over the manifests.                              |
| `customise/page.ts`       | The tree of tabs → groups → buttons, and the quick-access toolbar editor.                              |
| `i18n.ts`                 | `t()`, the catalogues, the language switch.                                                            |
| `fonts.ts`                | The interface font: the bundled faces, loaded the way M10 loads them.                                  |
| `units.ts`                | `app.units`, the one answer rulers, crop and measuring all read.                                       |
| `preferences.css`         | The dialog, the editor and the customiser. Tokens only, nothing transparent.                           |

## How it joins the app

- **Live apply rides a convention rather than a new hook.** Every module service already exposes
  `load()`, which re-reads its settings and applies them. After a write, M130 calls it on every
  registered service that has one (ADR 0018 §6). Three values live in memory rather than in a
  module that re-reads them — the theme, the shell's `ui.*` state, and M130's own language, font
  and units — so those get an _applier_ each, declared in `PreferencesService`.
- **An applier acts only on the keys that changed.** M130's cache is not the only writer of
  `settings.json`: M01, M11, M12 and others write directly through `settings:set`. Applying the
  whole snapshot on every write would push a stale cached value back over what a module had just
  set from its own toolbar.
- **The ribbon customisation is a filter, not a fork.** M130 registers a `ribbonCustomisation`
  service; `Ribbon.ts` asks for it and applies it to the group list before the pure model runs.
  The manifests stay the source of truth, so an id that no longer exists is simply dropped.
- **Shortcuts are stored as overrides.** What is kept is command id → key (or `null` for
  "unbound"), so a module that changes its own default is still obeyed for every command the
  reader has not touched, and Reset is deleting an entry. Rebinding unbinds the old key first —
  which is why `Registry.unbindShortcut` exists.
- **An object-valued setting must not have dots in its own keys.** The store is a dotted tree, so
  a map keyed by command id or ribbon group id cannot survive a round trip. Both of M130's
  composite settings are written as **arrays of entries** for that reason; see the note on
  `flatten` in `src/shared/settings.ts`.

## Things worth knowing

- **`resources/preferences.json` is where the dialog's shape lives** — page order, icons and
  labels; the synonym table that makes the operator's words find a setting ("tile cache" finds
  M11's page cache); and an alias table for the two places where a module declares one key and its
  code reads another. Nothing in that file is code, and changing it changes nothing else.
- **The interface font comes from the fonts the installer already carries.** Liberation and DejaVu
  (OFL / Bitstream Vera), fetched by `fetch-binaries` for PDF substitution and credited already.
  A build whose fonts have not been fetched falls back to the CSS stack, so the worst case is "it
  looks like the system font".
- **i18n is a framework plus a proof.** `t(key, fallbackEnglish)` reads a catalogue;
  `npm run i18n` regenerates `resources/i18n/en-GB.json` from the call sites and derives
  `en-US.json` from the spelling table. `npm run lint` runs the extractor with `--check`, so a
  string added without regenerating fails the build. Only M130's own interface is a consumer so
  far; a module adopts `t()` when it is next touched.
- **Nothing here is an undoable `Command`.** No document changes; the writes go to
  `settings.json`, and Reset is the undo.

# ADR 0018 — Contract additions for Preferences (M130)

- **Status:** accepted
- **Date:** 2026-09-10
- **Module:** M130 — Preferences, shortcut editor, ribbon/QAT customisation, UI scale, i18n
- **Supersedes / amends:** extends [ADR 0003](0003-settings-ipc.md) (settings IPC) and
  [ADR 0004](0004-shell-contribution-points.md) (shell contribution points)

## Context

M130 renders one Preferences dialog from every module's `SettingsSchema`, edits every keyboard
binding, customises the ribbon and the quick-access toolbar, and exports and imports the whole
settings file. Four things in the contracts as M00 and M02 left them do not stretch that far.

1. **`SettingSpec` has four types.** The brief asks for seven: boolean, number _with units_,
   enum, a colour-token pick, text, a file path and a list. A module cannot declare a page size
   in millimetres, a folder to save into, or a colour that must stay a theme token.
2. **Settings IPC is one key at a time.** `settings:get` / `settings:set` cannot answer "give me
   everything" (export), "take all of this" (import) or "forget this whole namespace" (reset).
3. **`Registry.bindShortcut` only ever adds.** Rebinding Ctrl+F to Ctrl+Shift+F has to leave
   Ctrl+F unbound, and there is no way to say so. Nor can anything enumerate the registered
   services, which is how live apply reaches the module that owns a setting.
4. **The ribbon is built straight from the manifests.** Hiding a group or moving a button has
   nowhere to live.

## Decision

### 1. `SettingSpec` gains three types and four optional fields (`src/shared/module.ts`)

Additive. Every existing schema still type-checks and renders identically.

```ts
/** Fields every setting may carry, whatever its type. */
interface SettingCommon {
  readonly title: string;
  /** A sentence under the control. Say what changes, not what the control is. */
  readonly description?: string;
  /** Extra words the Preferences search should match — the reader's words, not ours. */
  readonly keywords?: ReadonlyArray<string>;
  /** Hidden behind "Show advanced settings". */
  readonly advanced?: boolean;
  /** The owning module applies this without a restart (the dialog says so when false). */
  readonly live?: boolean;
}
```

- `number` gains `unit?: string` — the suffix shown after the field ("MB", "pt", "%"). It is a
  label, not a conversion: the stored number is in that unit.
- `colour` — the value is a **theme token name** (`'accent'`, `'warning'`, …) or, where a module
  says so with `allowCustom`, an `#rrggbb` value for PDF content. The dialog offers the token
  swatches; a literal is never offered for interface colour, because interface colour comes from
  the theme (CLAUDE.md).
- `path` — an absolute file or folder path with a Browse button; `pathKind: 'file' | 'directory'`.
- `list` — an ordered list of strings with add / remove / move up / move down.

Also added: `SettingCommon.section`, a heading a setting sits under on its page. A page with no
sections gets no headings, which is what every schema written before M130 has.

### 2. `SettingsSchema` gains `title`, `icon`, `order`

All optional. A module that sets none gets a page named after its manifest `name`, which is what
every merged module gets today.

### 3. Four settings IPC channels (`src/shared/ipc.ts`, `src/main/settings.ts`)

```ts
'settings:all':     { args: []; result: Record<string, unknown> };
'settings:setMany': { args: [values: Record<string, unknown>]; result: void };
'settings:reset':   { args: [prefixes?: string[]]; result: void };
'settings:path':    { args: []; result: string };
```

`settings:reset` with no prefixes empties the store back to its defaults (keeping `version`);
with prefixes it deletes only keys under those dotted prefixes, which is "Reset this page".
`settings:path` is the file path, shown in Preferences so the operator can find or back up the
file — the same courtesy the About dialog already gets.

### 4. Settings are versioned in one shared place (`src/shared/settings.ts`, new)

`SCHEMA_VERSION` plus an ordered list of `Migration { to, apply }`. Main runs them when the store
opens; M130 runs the same list over any imported JSON, so an export from an older build imports
cleanly instead of writing stale keys. Pure, and unit-tested without Electron.

### 5. `Registry.unbindShortcut(key)` and `Registry.serviceNames()`

Both additive. `unbindShortcut` removes a binding so a rebind does not leave the old key live.
`serviceNames()` lists the registered service names, which is how M130 finds the module services
to reload after a settings change (see below).

### 5b. A setting whose value is an object must not use dots in that object's keys

`electron-store` treats a dotted key as a _path_, so the settings file is a tree and an object
stored at a key is a subtree. Reading the whole file back therefore spreads such an object across
one key per field — and if a field name itself contains a dot, it is spread again and the module
does not recognise its own data.

So: **a map keyed by something dotted — a command id, a ribbon group id — is stored as an array of
entries.** Arrays are leaves. M130's shortcut bindings (`shortcuts.bindings`) and ribbon
customisation (`ui.ribbon.custom`) both do this; M30's tool defaults are keyed by plain names and
need not. `valueAt()` rebuilds a legitimately-nested object on read, and `dropTree()` deletes one
with its subtree, so the general case still works. The rule is written on `flatten` in
`src/shared/settings.ts`, which is where the next module author will meet it.

### 6. Live apply reuses the `load()` convention rather than adding a hook

Every module service registered on the Registry today (M11, M12, M13, M21, M30, M31, M32, M40,
M42, M70, M72, M91) already exposes `load()`, which re-reads its settings and applies them. That
is now the contract: **a service registered on the Registry may expose
`load(): void | Promise<void>`, and it must be safe to call at any time.** After Preferences
writes, M130 calls it on every service that has one. Nothing else in a module needs to change,
and a module that has no live-applicable settings simply does nothing expensive there.

`theme.*` goes to M01's `ThemeManager` and the shell's `ui.*` keys go to the `UiState` store,
because those two hold the value in memory rather than re-reading it. Those two, and M130's own
language / font / units, are **appliers**:

```ts
interface SettingsApplier {
  readonly prefixes: ReadonlyArray<string>;
  apply(values: Readonly<SettingsRecord>, changed: ReadonlySet<string>): void | Promise<void>;
}
```

An applier must act only on `changed`. M130's cache is not the only writer of the file — M01, M11
and M12 all write directly through `settings:set` — so applying the whole snapshot on every write
would push a stale cached value back over what a module had just set from its own toolbar. A key
in `changed` but absent from `values` was deleted, and the applier restores that setting's default.

### 7. `ribbonCustomisation` service (`src/renderer/app/ribbon/Ribbon.ts`)

The ribbon asks the Registry for an optional service named `ribbonCustomisation`:

```ts
interface RibbonCustomisation {
  apply(groups: ReadonlyArray<RibbonGroupSpec>): ReadonlyArray<RibbonGroupSpec>;
}
```

It is applied to the group list before the pure model runs, so hiding and reordering is a diff
over the manifests rather than a fork of them. With no service registered — a build without M130
— the ribbon behaves exactly as M02 built it.

## Consequences

- Modules can declare richer settings; nothing has to.
- The whole settings file can be exported, imported, reset per page and reset entirely.
- A rebound shortcut genuinely frees the old key.
- Ribbon customisation cannot drift from the manifests: it is stored as ids, and an id that no
  longer exists is dropped on read rather than breaking the ribbon.
- The `load()` convention is now load-bearing. A service that makes `load()` expensive or unsafe
  to call twice will make Preferences feel slow; the fix is in that module, not here.

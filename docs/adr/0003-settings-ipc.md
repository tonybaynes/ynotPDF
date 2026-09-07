# ADR 0003 — Persisted settings cross the typed IPC, main owns the file

- Status: accepted
- Date: 2026-09-07
- Module: M01 (theme system), consumed by M130 (preferences)

## Context

M01 has to persist the theme choice and the UI scale, and M130 will persist everything else.
`PLAN.md` §4.4 settles the storage: `electron-store` JSON in the OS user-data dir, no database.
What was not settled is how the renderer reaches it. The renderer is sandboxed with
`contextIsolation` and may only use the typed API in `src/shared/ipc.ts` (`PLAN.md` §4).

`localStorage` was rejected: it is per-origin browser state the main process cannot read, it
does not survive a packaging change of the load URL, and preferences that the main process
needs at startup (the native title-bar colour) would be invisible to it.

## Decision

Two generic channels, added to `IpcInvokeMap`:

- `settings:get(key: string) → unknown`
- `settings:set(key: string, value: unknown) → void`

Keys are dotted paths (`theme.name`, `ui.scale`); `electron-store` treats a dot as a path, which
gives modules a namespace for free. Values are `unknown` on the wire and validated by the
caller — M01 validates with `isThemeName` and `clampUiScale` before applying anything, so a
hand-edited settings file cannot break the app.

A third channel, `theme:setNative(scheme)`, lets the renderer tell the main process which
`nativeTheme.themeSource` to use, so the OS chrome follows the app theme rather than the OS
setting. Main also reads the saved theme directly at startup, before the window opens, so the
title bar is right on the first frame instead of flickering.

The additions are additive: no existing channel changed shape, so modules built against M00
still compile.

## Consequences

- M130 builds its preferences UI on these two channels and the `SettingsSchema` each module
  already declares in its manifest; no new plumbing is needed.
- Validation is the caller's job. That is deliberate: the main process must not need to know
  every module's value types.
- Settings are asynchronous in the renderer. `ThemeManager.create()` awaits the read once at
  boot, which is why the renderer entry applies the theme before mounting the shell.

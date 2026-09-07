# src/preload

`contextBridge` script. Exposes exactly `window.ynot` (`invoke`, `on`, `platform`, `e2e`) as
typed in `src/shared/ipc.ts`. Channel names are whitelisted; nothing else from Node or Electron
reaches the renderer. Runs with `sandbox: true`.

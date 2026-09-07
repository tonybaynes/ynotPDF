# src/main

Electron main process: window, native menu, file dialogs and file I/O, recent files
(`electron-store`), single-instance lock, `.pdf` file-association handling, IPC handlers.

Talks to the renderer **only** through the typed channels in `src/shared/ipc.ts`.

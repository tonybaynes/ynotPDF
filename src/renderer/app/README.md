# src/renderer/app

The application shell: ribbon, panes, document tabs, status bar, dialogs and the command
palette (M02). M00 ships only the empty frame (`shell.ts`), the About dialog and a minimal
palette so every registered command is reachable from day one.

Shell code is data-driven from module manifests via the `Registry`; it knows nothing about
individual features.

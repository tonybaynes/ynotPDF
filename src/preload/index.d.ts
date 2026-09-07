import type { YnotBridge } from '../shared/ipc';

declare global {
  interface Window {
    /** Typed IPC bridge exposed by src/preload/index.ts. Absent outside Electron. */
    ynot?: YnotBridge;
  }
}

export {};

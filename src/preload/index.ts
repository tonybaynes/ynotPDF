/**
 * Preload (M00): exposes exactly `window.ynot` — the typed bridge from `src/shared/ipc.ts`.
 * Channel names are whitelisted so the renderer cannot reach arbitrary IPC. Runs sandboxed.
 */

import { contextBridge, ipcRenderer } from 'electron';
import {
  EVENT_CHANNELS,
  INVOKE_CHANNELS,
  type IpcEventChannel,
  type IpcInvokeChannel,
  type YnotBridge,
} from '../shared/ipc';

const invokeSet = new Set<string>(INVOKE_CHANNELS);
const eventSet = new Set<string>(EVENT_CHANNELS);

// Main passes `--ynot-e2e` in `additionalArguments` only when YNOT_E2E=1 (see src/main/window.ts),
// and `--ynot-e2e-no-demo` on top of it under YNOT_E2E_NO_DEMO=1 (M04).
const e2e = process.argv.includes('--ynot-e2e');
const e2eDemoModule = e2e && !process.argv.includes('--ynot-e2e-no-demo');

const bridge: YnotBridge = {
  invoke(channel, ...args) {
    if (!invokeSet.has(channel)) {
      return Promise.reject(new Error(`IPC channel not allowed: ${channel}`));
    }
    return ipcRenderer.invoke(channel, ...args) as ReturnType<YnotBridge['invoke']>;
  },
  on(channel, listener) {
    if (!eventSet.has(channel)) throw new Error(`IPC event not allowed: ${channel}`);
    const wrapped = (_event: Electron.IpcRendererEvent, payload: unknown): void => {
      (listener as (p: unknown) => void)(payload);
    };
    ipcRenderer.on(channel, wrapped);
    return () => {
      ipcRenderer.removeListener(channel, wrapped);
    };
  },
  platform: process.platform,
  e2e,
  e2eDemoModule,
};

contextBridge.exposeInMainWorld('ynot', bridge);

// Keep the channel unions referenced so unused-type lint stays honest.
export type { IpcInvokeChannel, IpcEventChannel };

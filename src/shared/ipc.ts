/**
 * Typed IPC contract between the renderer and the Electron main process (M00).
 *
 * The renderer never touches `ipcRenderer` directly: `src/preload/index.ts` exposes exactly
 * `window.ynot` (see {@link YnotBridge}) via `contextBridge`, and main registers handlers with
 * {@link handle}. Add a channel here first; both sides then get compile-time checking.
 *
 * Renderer → main is request/response (`invoke`). Main → renderer is fire-and-forget (`on`).
 * Payloads must be structured-cloneable; bytes travel as `Uint8Array`.
 */

/** A file opened from disk. */
export interface OpenedFile {
  /** Absolute path. */
  readonly path: string;
  /** Base name including extension. */
  readonly name: string;
  /** Raw bytes. */
  readonly bytes: Uint8Array;
}

/** Recent-files entry persisted by main (`electron-store`). */
export interface RecentFile {
  readonly path: string;
  readonly name: string;
  /** Unix ms of the last open. */
  readonly openedAt: number;
}

/** OS platform as reported by Node's `process.platform`. */
export type Platform =
  | 'win32'
  | 'darwin'
  | 'linux'
  | 'freebsd'
  | 'openbsd'
  | 'sunos'
  | 'aix'
  | 'android'
  | 'cygwin'
  | 'netbsd'
  | 'haiku';

/** Static information about the running app. */
export interface AppInfo {
  readonly name: string;
  readonly version: string;
  readonly electron: string;
  readonly chrome: string;
  readonly node: string;
  readonly platform: Platform;
  readonly arch: string;
  readonly isPackaged: boolean;
  /** True when the e2e harness is enabled (env `YNOT_E2E=1`). Never true in a release build. */
  readonly e2e: boolean;
}

/**
 * Request/response channels. Key = channel name; `args` = tuple the renderer sends; `result` =
 * what main resolves with.
 */
export interface IpcInvokeMap {
  /** Shows the native open dialog filtered to PDFs. `null` when cancelled. */
  'file:openDialog': { args: []; result: OpenedFile | null };
  /** Reads a file by absolute path (recent files, file association). */
  'file:read': { args: [path: string]; result: OpenedFile };
  /** Writes bytes to an absolute path (used by Save in M21). */
  'file:write': { args: [path: string, bytes: Uint8Array]; result: void };
  /** Shows the native save dialog. `null` when cancelled. */
  'file:saveDialog': { args: [defaultPath?: string]; result: string | null };
  'recent:list': { args: []; result: RecentFile[] };
  'recent:add': { args: [path: string]; result: RecentFile[] };
  'recent:clear': { args: []; result: RecentFile[] };
  'app:info': { args: []; result: AppInfo };
  'app:quit': { args: []; result: void };
  'window:minimize': { args: []; result: void };
  'window:toggleMaximize': { args: []; result: void };
  'window:close': { args: []; result: void };
  'window:setTitle': { args: [title: string]; result: void };
  'shell:openExternal': { args: [url: string]; result: void };
  'shell:showItemInFolder': { args: [path: string]; result: void };
  'devtools:toggle': { args: []; result: void };
}

/** Push channels main → renderer. Key = channel name; value = payload. */
export interface IpcEventMap {
  /** A file was opened via file association, drag-onto-icon or a second app instance. */
  'file:openRequested': OpenedFile;
  /** A native menu item was activated; the renderer runs the command by id. */
  'menu:command': { readonly id: string; readonly args?: Readonly<Record<string, unknown>> };
  'recent:changed': RecentFile[];
  'window:focusChanged': { readonly focused: boolean };
}

export type IpcInvokeChannel = keyof IpcInvokeMap;
export type IpcEventChannel = keyof IpcEventMap;
export type IpcArgs<C extends IpcInvokeChannel> = IpcInvokeMap[C]['args'];
export type IpcResult<C extends IpcInvokeChannel> = IpcInvokeMap[C]['result'];
export type IpcEvent<C extends IpcEventChannel> = IpcEventMap[C];

/** Unsubscribe function. */
export type Unsubscribe = () => void;

/** The object the preload script exposes as `window.ynot`. */
export interface YnotBridge {
  invoke<C extends IpcInvokeChannel>(channel: C, ...args: IpcArgs<C>): Promise<IpcResult<C>>;
  on<C extends IpcEventChannel>(channel: C, listener: (payload: IpcEvent<C>) => void): Unsubscribe;
  /** Platform string, exposed so the renderer can pick Cmd vs Ctrl without an IPC round-trip. */
  readonly platform: Platform;
  /** True when launched with `YNOT_E2E=1` (see test/e2e/harness.ts). */
  readonly e2e: boolean;
}

/** Full list of invoke channels, used by the preload script to whitelist and by tests. */
export const INVOKE_CHANNELS: readonly IpcInvokeChannel[] = [
  'file:openDialog',
  'file:read',
  'file:write',
  'file:saveDialog',
  'recent:list',
  'recent:add',
  'recent:clear',
  'app:info',
  'app:quit',
  'window:minimize',
  'window:toggleMaximize',
  'window:close',
  'window:setTitle',
  'shell:openExternal',
  'shell:showItemInFolder',
  'devtools:toggle',
];

/** Full list of event channels main may push. */
export const EVENT_CHANNELS: readonly IpcEventChannel[] = [
  'file:openRequested',
  'menu:command',
  'recent:changed',
  'window:focusChanged',
];

/**
 * Renderer-side helper: `invoke('file:read', path)`. Throws if the preload bridge is missing
 * (i.e. the renderer is running outside Electron, e.g. in a plain browser tab).
 */
export function invoke<C extends IpcInvokeChannel>(
  channel: C,
  ...args: IpcArgs<C>
): Promise<IpcResult<C>> {
  return getBridge().invoke(channel, ...args);
}

/** Renderer-side helper: subscribe to a push channel. */
export function on<C extends IpcEventChannel>(
  channel: C,
  listener: (payload: IpcEvent<C>) => void,
): Unsubscribe {
  return getBridge().on(channel, listener);
}

/** Returns the preload bridge or throws a clear error. */
export function getBridge(): YnotBridge {
  const bridge = (globalThis as { ynot?: YnotBridge }).ynot;
  if (!bridge) {
    throw new Error('window.ynot bridge is not available: renderer is not running under Electron');
  }
  return bridge;
}

/** True when the preload bridge is present. */
export function hasBridge(): boolean {
  return (globalThis as { ynot?: YnotBridge }).ynot !== undefined;
}

/**
 * Main-side helper type: the handler signature for a channel. Main uses it as
 * `const handlers: IpcHandlers = { 'file:read': async (_e, path) => … }`.
 */
export type IpcHandlers = {
  [C in IpcInvokeChannel]: (
    event: { readonly sender: unknown },
    ...args: IpcArgs<C>
  ) => IpcResult<C> | Promise<IpcResult<C>>;
};

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

import type {
  ClipboardContents,
  DecodedRaster,
  OpenFilesOptions,
  WebRenderRequest,
  WebRenderResult,
} from './create';

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
  /** Pinned entries stay at the top of the backstage Recent list and are never evicted (M02). */
  readonly pinned?: boolean;
}

/** Where a save actually went, and what happened to the file that was there (M21). */
export interface WriteFileResult {
  readonly path: string;
  /** `<path>.bak`, when the backup setting is on and there was a previous version. */
  readonly backupPath: string | null;
  readonly bytesWritten: number;
  /** Modification time of the file we just wrote, so the watcher can tell ours from theirs. */
  readonly modifiedAt: number;
}

/** What main can tell the renderer about a path before it saves to it (M21). */
export interface FileProbe {
  readonly path: string;
  readonly exists: boolean;
  readonly size: number;
  /** Unix ms; 0 when the file is not there. */
  readonly modifiedAt: number;
  readonly writable: boolean;
  /** Whether a file can be created in the containing folder — what the atomic rename needs. */
  readonly directoryWritable: boolean;
  /** The file is there and cannot be replaced: Save has to become Save As. */
  readonly readOnly: boolean;
}

/** Options for the Save As dialog (M21). */
export interface SaveDialogOptions {
  /** Pre-filled path or file name. */
  readonly defaultPath?: string;
  readonly title?: string;
  /** Label of the confirm button ("Save", "Export"). */
  readonly buttonLabel?: string;
  /**
   * File-type filters. Absent means PDF plus "all files" — M21's original behaviour. M13 passes
   * PNG for a snapshot and CSV for exported search results (ADR 0012).
   */
  readonly filters?: ReadonlyArray<{
    readonly name: string;
    readonly extensions: ReadonlyArray<string>;
  }>;
}

// ---- clipboard, search and printing (M13, ADR 0012) -----------------------------------------

/** What to put on the clipboard. Every format given is offered at once, as one item. */
export interface ClipboardPayload {
  readonly text?: string;
  /** Rich Text Format, for "Copy with formatting". */
  readonly rtf?: string;
  readonly html?: string;
}

/** A printer the OS knows about. */
export interface PrinterInfo {
  readonly name: string;
  readonly displayName: string;
  readonly isDefault: boolean;
  readonly description?: string;
}

/** Everything a print job needs before its sheets arrive. */
export interface PrintJobSetup {
  /** Sheet size in PDF points; every sheet of a job is the same size. */
  readonly widthPt: number;
  readonly heightPt: number;
  /** Empty means the system default printer. */
  readonly printer?: string;
  readonly copies?: number;
  readonly collate?: boolean;
  /** Print in the printer's greyscale mode as well as rendering grey. */
  readonly grayscale?: boolean;
  /** Document name shown in the print queue. */
  readonly title?: string;
  /**
   * Build the job and return the HTML that would have been printed without sending it to a
   * printer. The e2e suite uses it; nothing in the app does.
   */
  readonly dryRun?: boolean;
}

/** How a print job ended. */
export interface PrintJobResult {
  readonly sheets: number;
  /** False for a dry run or a job the reader cancelled at the OS dialog. */
  readonly printed: boolean;
  /** The generated HTML's path, for a dry run. */
  readonly documentPath: string | null;
  readonly error?: string;
}

/** Find options as they cross the IPC boundary (M13). */
export interface FolderSearchOptions {
  readonly matchCase: boolean;
  readonly wholeWord: boolean;
  readonly regex: boolean;
  readonly ignoreDiacritics: boolean;
  readonly proximity: number;
  readonly includeBookmarks: boolean;
  readonly includeComments: boolean;
  readonly includeFormFields: boolean;
}

/** A folder search request. Results arrive on `search:results`. */
export interface FolderSearchRequest {
  readonly root: string;
  readonly query: string;
  readonly options: FolderSearchOptions;
  readonly recursive: boolean;
  /** Stop after this many hits so a large tree cannot run away. */
  readonly maxHits: number;
}

/** One hit from a folder search. */
export interface FolderSearchHit {
  readonly path: string;
  readonly name: string;
  /** 0-based, or -1 for a hit that belongs to the document rather than a page. */
  readonly page: number;
  readonly source: 'page' | 'bookmark' | 'comment' | 'field';
  readonly start: number;
  readonly end: number;
  readonly snippet: string;
  readonly label?: string;
}

/** One document a crash left behind, as the recovery dialog lists it (M21). */
export interface RecoveryEntry {
  readonly id: string;
  /** Unix ms of the last autosave. */
  readonly savedAt: number;
  readonly size: number;
  /** The record, for the renderer to parse. */
  readonly payload: string;
}

/** Window state reported by main (M02). */
export interface WindowState {
  readonly maximized: boolean;
  readonly fullScreen: boolean;
  readonly focused: boolean;
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
  /** Architecture this build was compiled for (M03). */
  readonly arch: string;
  /**
   * Architecture of the PC itself. Differs from `arch` only when the build runs under
   * emulation — an x64 build on a Windows-on-ARM PC (M03, `src/main/arch.ts`).
   */
  readonly hostArch: string;
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
  /**
   * Writes bytes through a temporary file and a rename, so an interrupted save can never leave
   * a half-written document behind (M21). `backup` renames the previous version to `<path>.bak`.
   */
  'file:writeAtomic': {
    args: [path: string, bytes: Uint8Array, options?: { backup?: boolean }];
    result: WriteFileResult;
  };
  /** Whether a path exists, its size and modification time, and whether it can be saved to (M21). */
  'file:probe': { args: [path: string]; result: FileProbe };
  /** Save As dialog with a title and button label of our choosing (M21). `null` when cancelled. */
  'file:saveAsDialog': { args: [options?: SaveDialogOptions]; result: string | null };
  /** Starts or stops watching a document for changes made outside the app (M21). */
  'file:watch': { args: [path: string, watching: boolean]; result: void };
  /** Mutes the watcher for a path while we write to it ourselves (M21). */
  'file:suspendWatch': { args: [path: string, ms?: number]; result: void };
  /** Every document a crash left behind, newest first (M21). */
  'recovery:list': { args: []; result: RecoveryEntry[] };
  /** Writes one autosave record. `id` must be `[A-Za-z0-9_-]{1,120}`. */
  'recovery:save': { args: [id: string, payload: string]; result: void };
  'recovery:read': { args: [id: string]; result: string | null };
  'recovery:discard': { args: [id: string]; result: void };
  'recovery:clear': { args: []; result: void };
  'recent:list': { args: []; result: RecentFile[] };
  'recent:add': { args: [path: string]; result: RecentFile[] };
  'recent:clear': { args: []; result: RecentFile[] };
  /** Pins or unpins a recent file (M02). */
  'recent:pin': { args: [path: string, pinned: boolean]; result: RecentFile[] };
  'recent:remove': { args: [path: string]; result: RecentFile[] };
  /**
   * Reads one persisted setting by dotted key (M01). Returns `undefined` when unset. Settings
   * live in `settings.json` in the OS user-data dir; M130 owns the preferences UI on top.
   */
  'settings:get': { args: [key: string]; result: unknown };
  /** Writes one persisted setting. `undefined` deletes the key. */
  'settings:set': { args: [key: string, value: unknown]; result: void };
  /**
   * Tells the main process which native colour scheme to use for title bars, menus and native
   * dialogs, so the OS chrome follows the active theme (M01).
   */
  'theme:setNative': { args: [scheme: 'dark' | 'light']; result: void };
  'app:info': { args: []; result: AppInfo };
  'app:quit': { args: []; result: void };
  'window:minimize': { args: []; result: void };
  'window:toggleMaximize': { args: []; result: void };
  'window:close': { args: []; result: void };
  'window:setTitle': { args: [title: string]; result: void };
  /** Opens another top-level window, optionally loading a file into it (tab drag-out, M02). */
  'window:new': { args: [path?: string]; result: void };
  'window:getState': { args: []; result: WindowState };
  /**
   * Enters or leaves OS full screen (M11, ADR 0009). The renderer cannot do this itself; the
   * resulting state comes back on `window:stateChanged`. Passing nothing toggles.
   */
  'window:setFullScreen': { args: [fullScreen?: boolean]; result: boolean };
  /** Number of open app windows (tests). */
  'window:count': { args: []; result: number };
  /**
   * Tells main whether this window is holding unsaved work (M21).
   *
   * Main intercepts a window close or an app quit **only** while at least one window has said
   * yes, so a clean app still shuts down instantly and nothing can be lost by a race between the
   * two processes. See `window:closeRequested` and `app:quitRequested`.
   */
  'window:setUnsaved': { args: [unsaved: boolean]; result: void };
  /**
   * The renderer has finished its close flow and the window may go (M21). `false` means the
   * reader cancelled, and the window stays.
   */
  'window:confirmClose': { args: [close: boolean]; result: void };
  /** The same answer for a quit that main asked about (M21). */
  'app:confirmQuit': { args: [quit: boolean]; result: void };
  'shell:openExternal': { args: [url: string]; result: void };
  'shell:showItemInFolder': { args: [path: string]; result: void };
  'devtools:toggle': { args: []; result: void };
  /** Puts text / RTF / HTML on the system clipboard as one item (M13). */
  'clipboard:write': { args: [payload: ClipboardPayload]; result: void };
  /** Puts a PNG on the system clipboard as an image (M13: Copy image, Snapshot). */
  'clipboard:writeImage': { args: [png: Uint8Array]; result: void };
  /** Native folder picker, for the advanced search panel's folder scope. `null` on cancel. */
  'dialog:pickFolder': { args: [title?: string]; result: string | null };
  /**
   * Starts a folder search in a main-process worker (M13, ADR 0012). Resolves with a job id;
   * hits arrive on `search:results` and the job ends with `search:done`.
   */
  'search:folder': { args: [request: FolderSearchRequest]; result: string };
  'search:cancel': { args: [jobId: string]; result: void };
  /** Printers the OS knows about (M13). */
  'print:printers': { args: []; result: PrinterInfo[] };
  /** Opens a print job; sheets follow one at a time (M13, ADR 0012). */
  'print:begin': { args: [setup: PrintJobSetup]; result: string };
  /** Adds one rendered sheet, as PNG bytes, to an open job. */
  'print:sheet': { args: [jobId: string, png: Uint8Array]; result: void };
  /** Sends the job to the printer (or, for a dry run, just builds it) and cleans up. */
  'print:finish': { args: [jobId: string]; result: PrintJobResult };
  /** Abandons an open job and deletes its temporary files. */
  'print:cancel': { args: [jobId: string]; result: void };
  /** A multi-select open dialog with the caller's filters (M91). Empty when cancelled. */
  'file:openFilesDialog': { args: [options?: OpenFilesOptions]; result: OpenedFile[] };
  /** Loads a URL or generated HTML in a hidden window and prints it to PDF (M91, ADR 0011). */
  'webpdf:render': { args: [request: WebRenderRequest]; result: WebRenderResult };
  /** Destroys a render job's window; a no-op when the job has finished. */
  'webpdf:cancel': { args: [jobId: string]; result: void };
  /** Text, HTML and image (PNG) on the clipboard (M91). */
  'clipboard:read': { args: []; result: ClipboardContents };
  /** Decodes an image with the platform's own codecs; `null` when it cannot (M91). */
  'image:decode': { args: [bytes: Uint8Array]; result: DecodedRaster | null };
}

/** Push channels main → renderer. Key = channel name; value = payload. */
export interface IpcEventMap {
  /** A file was opened via file association, drag-onto-icon or a second app instance. */
  'file:openRequested': OpenedFile;
  /** A native menu item was activated; the renderer runs the command by id. */
  'menu:command': { readonly id: string; readonly args?: Readonly<Record<string, unknown>> };
  'recent:changed': RecentFile[];
  'window:focusChanged': { readonly focused: boolean };
  /** Maximised / full-screen changed (M02). */
  'window:stateChanged': WindowState;
  /** A watched document changed on disk (M21). The renderer offers Reload or Keep mine. */
  'file:changedOnDisk': { readonly path: string };
  /**
   * The window is trying to close and main has held it back because this window reported
   * unsaved work (M21). Answer with `window:confirmClose`.
   */
  'window:closeRequested': { readonly reason: 'window' | 'quit' };
  /** The app is trying to quit and was held back the same way. Answer with `app:confirmQuit`. */
  'app:quitRequested': Record<string, never>;
  /** A batch of folder-search hits (M13). Batched so a big tree does not flood the channel. */
  'search:results': { readonly jobId: string; readonly hits: ReadonlyArray<FolderSearchHit> };
  /** Progress of a folder search: files looked at so far, and the one being read now. */
  'search:progress': {
    readonly jobId: string;
    readonly scanned: number;
    readonly total: number;
    readonly file: string;
  };
  /** A folder search has ended, one way or another. */
  'search:done': {
    readonly jobId: string;
    readonly cancelled: boolean;
    readonly hits: number;
    readonly error?: string;
  };
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
  'file:writeAtomic',
  'file:probe',
  'file:saveAsDialog',
  'file:watch',
  'file:suspendWatch',
  'recovery:list',
  'recovery:save',
  'recovery:read',
  'recovery:discard',
  'recovery:clear',
  'recent:list',
  'recent:add',
  'recent:clear',
  'recent:pin',
  'recent:remove',
  'settings:get',
  'settings:set',
  'theme:setNative',
  'app:info',
  'app:quit',
  'window:minimize',
  'window:toggleMaximize',
  'window:close',
  'window:setTitle',
  'window:new',
  'window:getState',
  'window:setFullScreen',
  'window:count',
  'window:setUnsaved',
  'window:confirmClose',
  'app:confirmQuit',
  'shell:openExternal',
  'shell:showItemInFolder',
  'devtools:toggle',
  'clipboard:write',
  'clipboard:writeImage',
  'dialog:pickFolder',
  'search:folder',
  'search:cancel',
  'print:printers',
  'print:begin',
  'print:sheet',
  'print:finish',
  'print:cancel',
  'file:openFilesDialog',
  'webpdf:render',
  'webpdf:cancel',
  'clipboard:read',
  'image:decode',
];

/** Full list of event channels main may push. */
export const EVENT_CHANNELS: readonly IpcEventChannel[] = [
  'file:openRequested',
  'menu:command',
  'recent:changed',
  'window:focusChanged',
  'window:stateChanged',
  'file:changedOnDisk',
  'window:closeRequested',
  'app:quitRequested',
  'search:results',
  'search:progress',
  'search:done',
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

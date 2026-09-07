/**
 * `UiState` — the single store the shell renders from (M02). Ribbon, panes, tabs, backstage,
 * status bar and focus all subscribe to their own slice; nothing in the shell keeps private
 * mutable state that another region needs.
 *
 * `revision` is bumped by `invalidate()` whenever something that `when()` predicates may depend
 * on has changed (selection, active tab, active tool, registry, document). Ribbon groups and the
 * properties pane re-evaluate their predicates on that signal only, then diff a small signature
 * and patch the DOM when it differs.
 *
 * The persisted subset (`PersistedUi`) goes through the settings IPC (ADR 0003) under `ui.*`
 * keys; `memoryUiStorage()` is used by tests.
 */

import { createStore, type Store } from '@core/Store';
import { hasBridge, invoke } from '@shared/ipc';
import type { BackstageSlot } from '@shared/module';

/** Page layout modes the status bar offers; M11 implements them. */
export type LayoutMode = 'single' | 'continuous' | 'facing' | 'book';
export const LAYOUT_MODES: ReadonlyArray<{ id: LayoutMode; label: string; icon: string }> = [
  { id: 'single', label: 'Single page', icon: 'rectangle-vertical' },
  { id: 'continuous', label: 'Continuous', icon: 'rows-3' },
  { id: 'facing', label: 'Facing', icon: 'columns-2' },
  { id: 'book', label: 'Book', icon: 'book-open' },
];

/** Shell regions in F6 order. */
export type Region = 'ribbon' | 'document' | 'left-pane' | 'right-pane' | 'status';
export const REGIONS: ReadonlyArray<Region> = [
  'ribbon',
  'document',
  'left-pane',
  'right-pane',
  'status',
];

/** Zoom modes: a number is percent; the strings are the fit modes. */
export type ZoomFit = 'page' | 'width' | null;
export const ZOOM_MIN = 1;
export const ZOOM_MAX = 6400;
export const ZOOM_PRESETS: ReadonlyArray<number> = [25, 50, 75, 100, 125, 150, 200, 300, 400];

export interface ViewState {
  /** 1-based current page (0 when nothing is open). */
  readonly page: number;
  readonly pageCount: number;
  /** Percent. */
  readonly zoom: number;
  readonly fit: ZoomFit;
  readonly layout: LayoutMode;
}

export interface UiState {
  readonly ribbon: {
    /** Active tab id (built-in or contextual). */
    readonly tab: string;
    readonly minimised: boolean;
    /** Minimised ribbon temporarily expanded (until a command runs or focus leaves). */
    readonly peek: boolean;
    /** Foxit-style single row of icon buttons (labels in tooltips) instead of labelled groups. */
    readonly compact: boolean;
  };
  /** Command ids on the quick-access toolbar, in order. */
  readonly qat: ReadonlyArray<string>;
  readonly leftPane: {
    readonly width: number;
    readonly collapsed: boolean;
    /** Last-open panel id, kept while collapsed so reopening restores it. */
    readonly panel: string | null;
  };
  readonly rightPane: {
    readonly width: number;
    /** User preference; the pane also hides itself when no panel's `when` matches. */
    readonly visible: boolean;
  };
  readonly backstage: { readonly open: boolean; readonly page: BackstageSlot };
  readonly view: ViewState;
  readonly activeTool: string | null;
  readonly keyTips: boolean;
  readonly region: Region;
  readonly window: {
    readonly focused: boolean;
    readonly maximized: boolean;
    readonly fullScreen: boolean;
  };
  readonly revision: number;
}

/** The subset that survives a restart. */
export interface PersistedUi {
  readonly ribbonMinimised: boolean;
  readonly ribbonCompact: boolean;
  readonly qat: ReadonlyArray<string>;
  readonly leftPaneWidth: number;
  readonly leftPaneCollapsed: boolean;
  readonly leftPanel: string | null;
  readonly rightPaneWidth: number;
  readonly layout: LayoutMode;
}

export const DEFAULT_QAT: ReadonlyArray<string> = ['file.open', 'edit.undo', 'edit.redo'];
export const PANE_MIN_WIDTH = 160;
export const PANE_MAX_WIDTH = 720;
export const DEFAULT_LEFT_WIDTH = 260;
export const DEFAULT_RIGHT_WIDTH = 280;

export const DEFAULT_PERSISTED: PersistedUi = {
  ribbonMinimised: false,
  ribbonCompact: true,
  qat: DEFAULT_QAT,
  leftPaneWidth: DEFAULT_LEFT_WIDTH,
  leftPaneCollapsed: false,
  leftPanel: null,
  rightPaneWidth: DEFAULT_RIGHT_WIDTH,
  layout: 'continuous',
};

export function initialUiState(persisted: Partial<PersistedUi> = {}): UiState {
  const p = { ...DEFAULT_PERSISTED, ...persisted };
  return {
    ribbon: { tab: 'home', minimised: p.ribbonMinimised, peek: false, compact: p.ribbonCompact },
    qat: p.qat,
    leftPane: {
      width: clampPaneWidth(p.leftPaneWidth),
      collapsed: p.leftPaneCollapsed,
      panel: p.leftPanel,
    },
    rightPane: { width: clampPaneWidth(p.rightPaneWidth), visible: true },
    backstage: { open: false, page: 'open' },
    view: { page: 0, pageCount: 0, zoom: 100, fit: null, layout: p.layout },
    activeTool: null,
    keyTips: false,
    region: 'document',
    window: { focused: true, maximized: false, fullScreen: false },
    revision: 0,
  };
}

export function clampPaneWidth(width: number): number {
  if (!Number.isFinite(width)) return DEFAULT_LEFT_WIDTH;
  return Math.min(PANE_MAX_WIDTH, Math.max(PANE_MIN_WIDTH, Math.round(width)));
}

export function clampZoom(percent: number): number {
  if (!Number.isFinite(percent)) return 100;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(percent)));
}

/** Next preset above/below the current zoom (Ctrl+= / Ctrl+-). */
export function stepZoom(current: number, direction: 1 | -1): number {
  if (direction > 0) {
    const next = ZOOM_PRESETS.find((z) => z > current);
    return clampZoom(next ?? Math.round(current * 1.25));
  }
  const prev = [...ZOOM_PRESETS].reverse().find((z) => z < current);
  return clampZoom(prev ?? Math.round(current / 1.25));
}

/**
 * Parses what the user typed into the zoom field: `"150"`, `"150%"`, `"1.5x"`, `"fit page"`,
 * `"fit width"`. Returns `null` for nonsense.
 */
export function parseZoomInput(text: string): { zoom: number; fit: ZoomFit } | null {
  const t = text.trim().toLowerCase();
  if (!t) return null;
  if (/^fit\s*(page|p)?$/.test(t) || t === 'page') return { zoom: 100, fit: 'page' };
  if (/^fit\s*(width|w)$/.test(t) || t === 'width') return { zoom: 100, fit: 'width' };
  const x = /^(\d+(?:\.\d+)?)\s*x$/.exec(t);
  if (x?.[1]) return { zoom: clampZoom(Number(x[1]) * 100), fit: null };
  const pct = /^(\d+(?:\.\d+)?)\s*%?$/.exec(t);
  if (pct?.[1]) return { zoom: clampZoom(Number(pct[1])), fit: null };
  return null;
}

/** Parses the page field: a 1-based number within range, else `null`. */
export function parsePageInput(text: string, pageCount: number): number | null {
  const n = Number.parseInt(text.trim(), 10);
  if (!Number.isFinite(n) || n < 1 || n > pageCount) return null;
  return n;
}

export function formatZoom(view: ViewState): string {
  if (view.fit === 'page') return 'Fit page';
  if (view.fit === 'width') return 'Fit width';
  return `${view.zoom}%`;
}

export function persistedFrom(state: UiState): PersistedUi {
  return {
    ribbonMinimised: state.ribbon.minimised,
    ribbonCompact: state.ribbon.compact,
    qat: state.qat,
    leftPaneWidth: state.leftPane.width,
    leftPaneCollapsed: state.leftPane.collapsed,
    leftPanel: state.leftPane.panel,
    rightPaneWidth: state.rightPane.width,
    layout: state.view.layout,
  };
}

// ---- persistence -------------------------------------------------------------------------------

export interface UiStorage {
  read(): Promise<Partial<PersistedUi>>;
  write(state: PersistedUi): Promise<void>;
}

export function memoryUiStorage(initial: Partial<PersistedUi> = {}): UiStorage {
  let saved: Partial<PersistedUi> = { ...initial };
  return {
    read: () => Promise.resolve({ ...saved }),
    write: (state) => {
      saved = { ...state };
      return Promise.resolve();
    },
  };
}

/** Settings keys — dotted so `electron-store` namespaces them under `ui`. */
const KEYS: Record<keyof PersistedUi, string> = {
  ribbonMinimised: 'ui.ribbon.minimised',
  ribbonCompact: 'ui.ribbon.compact',
  qat: 'ui.qat',
  leftPaneWidth: 'ui.leftPane.width',
  leftPaneCollapsed: 'ui.leftPane.collapsed',
  leftPanel: 'ui.leftPane.panel',
  rightPaneWidth: 'ui.rightPane.width',
  layout: 'ui.view.layout',
};

function isLayout(v: unknown): v is LayoutMode {
  return LAYOUT_MODES.some((m) => m.id === v);
}

/** Validates a raw settings object into a partial `PersistedUi` (hand-edited files cannot break the app). */
export function validatePersisted(
  raw: Readonly<Record<keyof PersistedUi, unknown>>,
): Partial<PersistedUi> {
  const out: { -readonly [K in keyof PersistedUi]?: PersistedUi[K] } = {};
  if (typeof raw.ribbonMinimised === 'boolean') out.ribbonMinimised = raw.ribbonMinimised;
  if (typeof raw.ribbonCompact === 'boolean') out.ribbonCompact = raw.ribbonCompact;
  if (Array.isArray(raw.qat) && raw.qat.every((x) => typeof x === 'string')) out.qat = raw.qat;
  if (typeof raw.leftPaneWidth === 'number') out.leftPaneWidth = clampPaneWidth(raw.leftPaneWidth);
  if (typeof raw.leftPaneCollapsed === 'boolean') out.leftPaneCollapsed = raw.leftPaneCollapsed;
  if (typeof raw.leftPanel === 'string' || raw.leftPanel === null) out.leftPanel = raw.leftPanel;
  if (typeof raw.rightPaneWidth === 'number')
    out.rightPaneWidth = clampPaneWidth(raw.rightPaneWidth);
  if (isLayout(raw.layout)) out.layout = raw.layout;
  return out;
}

export function ipcUiStorage(): UiStorage {
  return {
    async read(): Promise<Partial<PersistedUi>> {
      if (!hasBridge()) return {};
      const names = Object.keys(KEYS) as (keyof PersistedUi)[];
      const values = await Promise.all(names.map((n) => invoke('settings:get', KEYS[n])));
      const raw = Object.fromEntries(names.map((n, i) => [n, values[i]])) as Record<
        keyof PersistedUi,
        unknown
      >;
      return validatePersisted(raw);
    },
    async write(state: PersistedUi): Promise<void> {
      if (!hasBridge()) return;
      await Promise.all(
        (Object.keys(KEYS) as (keyof PersistedUi)[]).map((n) =>
          invoke('settings:set', KEYS[n], state[n]),
        ),
      );
    },
  };
}

// ---- the store + helpers ----------------------------------------------------------------------

export type UiStore = Store<UiState>;

export function createUiStore(persisted: Partial<PersistedUi> = {}): UiStore {
  return createStore(initialUiState(persisted));
}

/** Bumps `revision` so `when()` predicates are re-evaluated. */
export function invalidate(ui: UiStore): void {
  ui.set((s) => ({ revision: s.revision + 1 }));
}

/**
 * Persists changes to the `PersistedUi` subset (debounced). Returns a disposer. Writes only when
 * the persisted projection actually changed, so pure `revision` bumps never touch disk.
 */
export function persistUi(ui: UiStore, storage: UiStorage, delayMs = 250): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let last = JSON.stringify(persistedFrom(ui.get()));
  const unsub = ui.subscribe((state) => {
    const next = persistedFrom(state);
    const json = JSON.stringify(next);
    if (json === last) return;
    last = json;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void storage.write(next).catch((error: unknown) => {
        console.warn('ui: could not persist layout', error);
      });
    }, delayMs);
  });
  return () => {
    unsub();
    if (timer) clearTimeout(timer);
  };
}

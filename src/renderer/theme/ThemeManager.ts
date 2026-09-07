/**
 * `ThemeManager` — applies a theme to the document, persists the choice and the UI scale, and
 * notifies listeners (M01).
 *
 * ```ts
 * const themes = await ThemeManager.create();   // loads the saved choice, applies it
 * themes.set('midnight');                       // live, no reload
 * themes.next();                                // cycle
 * themes.setScale(150);                         // 150 % UI scale
 * themes.onChange((s) => console.info(s.theme, s.scale));
 * ```
 *
 * How a theme is applied: all four theme stylesheets are linked at once and scoped by
 * `[data-theme="…"]`, so switching is a single attribute write on `<html>` — no stylesheet
 * loading, no flash, no reload. `color-scheme` comes from the theme file itself, so native
 * scrollbars and form controls follow.
 */

import { DEFAULT_THEME, isThemeName, THEMES, clampUiScale, type ThemeName } from './themes';
import { UI_SCALE_DEFAULT } from './themes';

/** What listeners receive. */
export interface ThemeState {
  readonly theme: ThemeName;
  /** UI scale in percent (100–200). */
  readonly scale: number;
  /**
   * Night Mode: darken the *document* as well as the interface. Off by default in every theme,
   * because a PDF page renders as its author made it; this is the explicit opt-in (Foxit puts
   * the same switch under View). M11 applies the matching inversion to the page raster.
   */
  readonly nightMode: boolean;
}

export type ThemeListener = (state: ThemeState) => void;

/**
 * Where the choice is stored. The renderer never touches `localStorage`: it goes through the
 * typed settings IPC so the main process owns the on-disk JSON (PLAN.md §4.4). In a plain
 * browser (unit tests, the gallery page) an in-memory store is used instead.
 */
export interface ThemeStorage {
  read(): Promise<Partial<ThemeState>>;
  write(state: ThemeState): Promise<void>;
}

/** Storage that keeps nothing — used by tests and the dev gallery. */
export function memoryStorage(initial: Partial<ThemeState> = {}): ThemeStorage {
  let saved: Partial<ThemeState> = { ...initial };
  return {
    read: () => Promise.resolve({ ...saved }),
    write: (state) => {
      saved = { ...state };
      return Promise.resolve();
    },
  };
}

export interface ThemeManagerOptions {
  /** Element the `data-theme` attribute and `--ui-scale` go on. Defaults to `<html>`. */
  readonly root?: HTMLElement;
  readonly storage?: ThemeStorage;
  /** Called after every change; the app uses it to tell main which native theme to use. */
  readonly onApplied?: (state: ThemeState) => void;
}

export class ThemeManager {
  private readonly root: HTMLElement;
  private readonly storage: ThemeStorage;
  private readonly onApplied: ((state: ThemeState) => void) | undefined;
  private readonly listeners = new Set<ThemeListener>();
  private theme: ThemeName = DEFAULT_THEME;
  private scale: number = UI_SCALE_DEFAULT;
  private night = false;

  constructor(options: ThemeManagerOptions = {}) {
    this.root = options.root ?? document.documentElement;
    this.storage = options.storage ?? memoryStorage();
    this.onApplied = options.onApplied;
  }

  /** Builds a manager, loads the persisted choice and applies it. */
  static async create(options: ThemeManagerOptions = {}): Promise<ThemeManager> {
    const manager = new ThemeManager(options);
    await manager.load();
    return manager;
  }

  /** Reads the persisted state and applies it (falling back to the defaults). */
  async load(): Promise<void> {
    let saved: Partial<ThemeState> = {};
    try {
      saved = await this.storage.read();
    } catch (error) {
      console.warn('theme: could not read the saved theme, using the default', error);
    }
    this.theme = isThemeName(saved.theme) ? saved.theme : DEFAULT_THEME;
    this.scale = clampUiScale(saved.scale ?? UI_SCALE_DEFAULT);
    this.night = saved.nightMode === true;
    this.apply();
  }

  /** The theme in use. */
  get current(): ThemeName {
    return this.theme;
  }

  /** UI scale in percent. */
  get uiScale(): number {
    return this.scale;
  }

  /** True while Night Mode is on. */
  get nightMode(): boolean {
    return this.night;
  }

  get state(): ThemeState {
    return { theme: this.theme, scale: this.scale, nightMode: this.night };
  }

  /** Every theme, in menu order. A getter keeps the call sites uniform with `current`. */
  get list(): typeof THEMES {
    return THEMES;
  }

  /** Applies a theme by name and persists it. Unknown names throw. */
  set(name: ThemeName): void {
    if (!isThemeName(name)) throw new Error(`Unknown theme: ${String(name)}`);
    if (name === this.theme) return;
    this.theme = name;
    this.apply();
    void this.persist();
  }

  /** Cycles to the next theme in `list` order (wraps). */
  next(): ThemeName {
    const index = THEMES.findIndex((t) => t.name === this.theme);
    const nextTheme = THEMES[(index + 1) % THEMES.length];
    if (!nextTheme) throw new Error('no themes registered');
    this.set(nextTheme.name);
    return nextTheme.name;
  }

  /** Cycles backwards. */
  previous(): ThemeName {
    const index = THEMES.findIndex((t) => t.name === this.theme);
    const prev = THEMES[(index - 1 + THEMES.length) % THEMES.length];
    if (!prev) throw new Error('no themes registered');
    this.set(prev.name);
    return prev.name;
  }

  /** Sets the UI scale in percent; clamped to 100–200 and rounded to the 10 % step. */
  setScale(percent: number): number {
    const next = clampUiScale(percent);
    if (next === this.scale) return next;
    this.scale = next;
    this.apply();
    void this.persist();
    return next;
  }

  /** Turns Night Mode on or off. Returns the new state. */
  setNightMode(on: boolean): boolean {
    if (on === this.night) return this.night;
    this.night = on;
    this.apply();
    void this.persist();
    return this.night;
  }

  /** Flips Night Mode. Returns the new state. */
  toggleNightMode(): boolean {
    return this.setNightMode(!this.night);
  }

  /** Nudges the UI scale by one step (`+1` bigger, `-1` smaller). */
  stepScale(direction: 1 | -1): number {
    return this.setScale(this.scale + direction * 10);
  }

  /** Subscribes to changes. Returns an unsubscribe function. */
  onChange(listener: ThemeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Writes `data-theme`, `data-night-mode` and `--ui-scale`, then notifies. */
  private apply(): void {
    this.root.dataset['theme'] = this.theme;
    if (this.night) this.root.dataset['nightMode'] = 'on';
    else delete this.root.dataset['nightMode'];
    this.root.style.setProperty('--ui-scale', String(this.scale / 100));
    const state = this.state;
    this.onApplied?.(state);
    for (const listener of Array.from(this.listeners)) listener(state);
  }

  private async persist(): Promise<void> {
    try {
      await this.storage.write(this.state);
    } catch (error) {
      console.warn('theme: could not save the theme', error);
    }
  }
}

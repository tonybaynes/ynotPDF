/**
 * M130's service: the object every one of its commands goes through.
 *
 * It owns four things the manifest would otherwise have to hold: the {@link SettingsService} and
 * its appliers, the shortcut overrides and the rebinding they cause, the ribbon customisation
 * that `Ribbon.ts` asks for, and the file dialogs behind Import and Export.
 *
 * The appliers are the interesting part. Most settings apply themselves, because M130 calls
 * `load()` on every module service after a write (ADR 0018 §6) and every module re-reads there.
 * Three do not, because their value lives in memory rather than in a module that re-reads it:
 * the theme, the shell's own `ui.*` state, and M130's own language / font / units. Those get an
 * applier each, declared here and nowhere else.
 */

import type { ShellServices } from '@app/services';
import type { UiStore } from '@app/ui/UiState';
import { DEFAULT_PERSISTED, DEFAULT_QAT, clampPaneWidth } from '@app/ui/UiState';
import { normalizeKey, type Registry } from '@core/Registry';
import { hasBridge, invoke } from '@shared/ipc';
import { under } from '@shared/settings';
import type { LayoutMode } from '@app/ui/UiState';
import type { RibbonGroupSpec, ShortcutSpec } from '@shared/module';
import type { ThemeManager } from '@theme/ThemeManager';
import { clampUiScale, DEFAULT_THEME, isThemeName, UI_SCALE_DEFAULT } from '@theme/themes';
import type { Unit } from '@view/units';
import {
  applyCustomisation,
  readCustomState,
  RIBBON_CUSTOM_KEY,
  toStoredCustom,
  type RibbonCustomState,
} from './customise/model';
import { applyUiFont, DEFAULT_UI_FONT, isUiFont } from './fonts';
import { isLanguage, setLanguage, SOURCE_LANGUAGE } from './i18n';
import { SettingsService, type SettingsApplier } from './SettingsService';
import {
  OVERRIDES_KEY,
  readOverrides,
  toStoredOverrides,
  type ShortcutOverrides,
} from './shortcuts/model';
import { DEFAULT_UNIT, readUnit, RULER_UNITS_KEY, UNITS_KEY, type UnitsService } from './units';

export const PREFERENCES_SERVICE = 'preferences';

/** Keys M130 owns itself. Public so the manifest and the tests name the same strings. */
export const APP_KEYS = {
  language: 'app.language',
  uiFont: 'app.uiFont',
  units: UNITS_KEY,
  identityName: 'identity.name',
  identityInitials: 'identity.initials',
  identityEmail: 'identity.email',
  identityOrganisation: 'identity.organisation',
} as const;

export interface PreferencesServiceOptions {
  readonly registry: Registry;
  readonly shell: ShellServices;
  readonly themes: ThemeManager | null;
}

export class PreferencesService {
  readonly settings: SettingsService;
  private readonly registry: Registry;
  private readonly shell: ShellServices;
  private readonly themes: ThemeManager | null;
  /** The bindings the manifests declare, captured once before any override is applied. */
  private readonly defaultBindings: ReadonlyArray<ShortcutSpec>;
  private customState: RibbonCustomState = readCustomState(undefined);
  private overridesValue: ShortcutOverrides = {};
  private unitValue: Unit = DEFAULT_UNIT;
  private readonly unitListeners = new Set<(unit: Unit) => void>();

  constructor(options: PreferencesServiceOptions) {
    this.registry = options.registry;
    this.shell = options.shell;
    this.themes = options.themes;
    this.defaultBindings = options.registry.allShortcuts().map((spec) => ({ ...spec }));
    this.settings = new SettingsService({
      registry: options.registry,
      appliers: [this.themeApplier(), this.uiApplier(), this.ownApplier()],
      // M130's own two services *are* the settings; reloading them here would be a loop.
      skipServices: [PREFERENCES_SERVICE, 'settings'],
    });
  }

  /** Reads everything and applies it. Called once from `activate`. */
  async load(): Promise<void> {
    await this.settings.load();
    this.customState = readCustomState(this.settings.peek(RIBBON_CUSTOM_KEY));
    this.overridesValue = readOverrides(this.settings.peek(OVERRIDES_KEY));
    this.applyShortcuts();
    await this.applyOwn();
  }

  // ---- appliers ------------------------------------------------------------------------------

  /**
   * The theme, the UI scale and Night Mode live in `ThemeManager`, which read them once at boot.
   * A write from Preferences has to be handed to it or the file and the screen disagree.
   */
  private themeApplier(): SettingsApplier {
    return {
      prefixes: ['theme', 'ui.scale', 'view.nightMode'],
      apply: (values, changed) => {
        const themes = this.themes;
        if (!themes) return;
        if (changed.has('theme.name')) {
          const name = values['theme.name'];
          const next = isThemeName(name) ? name : DEFAULT_THEME;
          if (next !== themes.current) themes.set(next);
        }
        if (changed.has('ui.scale') || changed.has('theme.scale')) {
          const scale = values['ui.scale'] ?? values['theme.scale'];
          themes.setScale(typeof scale === 'number' ? clampUiScale(scale) : UI_SCALE_DEFAULT);
        }
        if (changed.has('view.nightMode') || changed.has('theme.nightMode')) {
          const night = values['view.nightMode'] ?? values['theme.nightMode'];
          const next = typeof night === 'boolean' ? night : false;
          if (next !== themes.nightMode) themes.setNightMode(next);
        }
      },
    };
  }

  /**
   * The shell's `ui.*` keys are held by the `UiState` store, which *writes* them on change and
   * never reads them again after boot. Preferences pushes into the store instead, and the store's
   * own persistence then writes the same value back — harmless, and one code path.
   */
  private uiApplier(): SettingsApplier {
    return {
      prefixes: ['ui'],
      apply: (values, changed) => {
        const ui: UiStore = this.shell.ui;
        if (changed.has('ui.ribbon.minimised') || changed.has('ui.ribbon.compact')) {
          const minimised = values['ui.ribbon.minimised'];
          const compact = values['ui.ribbon.compact'];
          ui.set((state) => ({
            ribbon: {
              ...state.ribbon,
              minimised:
                typeof minimised === 'boolean' ? minimised : DEFAULT_PERSISTED.ribbonMinimised,
              compact: typeof compact === 'boolean' ? compact : DEFAULT_PERSISTED.ribbonCompact,
            },
          }));
        }
        if (changed.has('ui.view.layout')) {
          const layout = values['ui.view.layout'];
          const next =
            typeof layout === 'string' ? (layout as LayoutMode) : DEFAULT_PERSISTED.layout;
          ui.set((state) => ({ view: { ...state.view, layout: next } }));
        }
        if (changed.has('ui.leftPane.width')) {
          const width = values['ui.leftPane.width'];
          const next = typeof width === 'number' ? width : DEFAULT_PERSISTED.leftPaneWidth;
          ui.set((state) => ({ leftPane: { ...state.leftPane, width: clampPaneWidth(next) } }));
        }
        if (changed.has('ui.qat')) {
          const qat = values['ui.qat'];
          const usable = Array.isArray(qat) && qat.every((id) => typeof id === 'string');
          ui.set({ qat: usable ? qat : [...DEFAULT_QAT] });
        }
        if ([...changed].some((key) => under(key, RIBBON_CUSTOM_KEY))) {
          this.customState = readCustomState(values[RIBBON_CUSTOM_KEY]);
          this.rebuildRibbon();
        }
      },
    };
  }

  /** M130's own keys: language, interface font, units and the shortcut overrides. */
  private ownApplier(): SettingsApplier {
    return {
      prefixes: ['app', 'identity', 'shortcuts', 'viewer.rulers.units'],
      apply: async (values, changed) => {
        if (changed.has(APP_KEYS.language)) {
          const language = values[APP_KEYS.language];
          setLanguage(isLanguage(language) ? language : SOURCE_LANGUAGE);
        }
        if (changed.has(APP_KEYS.uiFont)) {
          const font = values[APP_KEYS.uiFont];
          await applyUiFont(isUiFont(font) ? font : DEFAULT_UI_FONT);
        }
        if (changed.has(APP_KEYS.units) || changed.has(RULER_UNITS_KEY)) {
          const unit = readUnit(values[APP_KEYS.units] ?? values[RULER_UNITS_KEY]);
          if (unit !== this.unitValue) {
            this.unitValue = unit;
            for (const listener of Array.from(this.unitListeners)) listener(unit);
          }
        }
        if ([...changed].some((key) => under(key, OVERRIDES_KEY))) {
          const overrides = readOverrides(values[OVERRIDES_KEY]);
          if (JSON.stringify(overrides) !== JSON.stringify(this.overridesValue)) {
            this.overridesValue = overrides;
            this.applyShortcuts();
          }
        }
      },
    };
  }

  /** Applies language, font and units at boot, before any write has happened. */
  private async applyOwn(): Promise<void> {
    const values = this.settings.snapshot();
    const language = values[APP_KEYS.language];
    setLanguage(isLanguage(language) ? language : SOURCE_LANGUAGE);
    const font = values[APP_KEYS.uiFont];
    await applyUiFont(isUiFont(font) ? font : DEFAULT_UI_FONT);
    this.unitValue = readUnit(values[APP_KEYS.units] ?? values[RULER_UNITS_KEY]);
  }

  // ---- shortcuts -----------------------------------------------------------------------------

  overrides(): ShortcutOverrides {
    return this.overridesValue;
  }

  /** Persists new overrides and rebinds. */
  async setOverrides(next: ShortcutOverrides): Promise<void> {
    this.overridesValue = next;
    this.applyShortcuts();
    await this.settings.write(
      OVERRIDES_KEY,
      Object.keys(next).length === 0 ? undefined : toStoredOverrides(next),
    );
  }

  /**
   * Rebuilds the Registry's key map from the manifests' bindings plus the reader's overrides.
   *
   * Everything is unbound first. Rebinding on top of the old map would leave the previous key of
   * a rebound command still live, which is the exact bug the editor exists to prevent — and
   * `unbindShortcut` (ADR 0018) exists so this can be done at all.
   */
  applyShortcuts(): void {
    for (const spec of this.registry.allShortcuts()) {
      this.registry.unbindShortcut(normalizeKey(spec.key));
    }
    const overridden = new Set(Object.keys(this.overridesValue));
    for (const spec of this.defaultBindings) {
      if (overridden.has(spec.command)) continue;
      this.registry.bindShortcut(spec);
    }
    for (const [command, key] of Object.entries(this.overridesValue)) {
      if (key === null) continue;
      const original = this.defaultBindings.find((s) => s.command === command);
      this.registry.bindShortcut({
        ...(original ? { args: original.args, scope: original.scope } : {}),
        key: normalizeKey(key),
        command,
      });
    }
    this.shell.invalidate();
  }

  /** The key a command's module declares, for the editor's "default" column. */
  defaultKeyFor(commandId: string): string | undefined {
    const spec = this.defaultBindings.find((s) => s.command === commandId);
    return spec ? normalizeKey(spec.key) : undefined;
  }

  // ---- ribbon customisation ------------------------------------------------------------------

  ribbonCustom(): RibbonCustomState {
    return this.customState;
  }

  /** What the `ribbonCustomisation` service does (ADR 0018 §7). */
  customiseRibbon(groups: ReadonlyArray<RibbonGroupSpec>): ReadonlyArray<RibbonGroupSpec> {
    return applyCustomisation(groups, this.customState);
  }

  /** Redraws the ribbon after a customisation change. A build without one simply has nothing to do. */
  private rebuildRibbon(): void {
    if (!this.registry.hasService('ribbon')) return;
    this.registry.service<{ rebuild?: () => void }>('ribbon').rebuild?.();
  }

  async setRibbonCustom(next: RibbonCustomState): Promise<void> {
    this.customState = next;
    const empty =
      next.hiddenGroups.length === 0 &&
      next.hiddenItems.length === 0 &&
      Object.keys(next.groupOrder).length === 0 &&
      Object.keys(next.itemOrder).length === 0;
    await this.settings.write(RIBBON_CUSTOM_KEY, empty ? undefined : toStoredCustom(next));
    this.rebuildRibbon();
  }

  // ---- quick-access toolbar -------------------------------------------------------------------

  qat(): ReadonlyArray<string> {
    return this.shell.ui.get().qat;
  }

  async setQat(ids: ReadonlyArray<string>): Promise<void> {
    this.shell.ui.set({ qat: [...ids] });
    await this.settings.write('ui.qat', [...ids]);
  }

  async resetQat(): Promise<void> {
    await this.setQat(DEFAULT_QAT);
  }

  // ---- units ----------------------------------------------------------------------------------

  unitsService(): UnitsService {
    // Closures rather than `this`: the getter below belongs to the returned object literal, so
    // `this` inside it would be that object and not this service.
    const currentUnit = (): Unit => this.unitValue;
    const settings = this.settings;
    const listeners = this.unitListeners;
    return {
      get unit() {
        return currentUnit();
      },
      set: async (unit) => {
        // M11 reads the ruler key in its own `load()`; writing both keeps one visible answer.
        await settings.writeMany({ [UNITS_KEY]: unit, [RULER_UNITS_KEY]: unit });
      },
      subscribe: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    };
  }

  get unit(): Unit {
    return this.unitValue;
  }

  // ---- files ------------------------------------------------------------------------------------

  /** Asks for a path and writes `text` there. Returns the path, or `null` when cancelled. */
  async saveText(
    text: string,
    defaultName: string,
    title: string,
    filterName: string,
  ): Promise<string | null> {
    if (!hasBridge()) return null;
    const path = await invoke('file:saveAsDialog', {
      defaultPath: defaultName,
      title,
      buttonLabel: 'Export',
      filters: [{ name: filterName, extensions: ['json'] }],
    });
    if (path === null) return null;
    await invoke('file:write', path, new TextEncoder().encode(text));
    return path;
  }

  /** Asks for a JSON file and returns its text, or `null` when cancelled. */
  async openText(title: string, filterName: string): Promise<string | null> {
    if (!hasBridge()) return null;
    const files = await invoke('file:openFilesDialog', {
      title,
      multi: false,
      buttonLabel: 'Import',
      filters: [{ name: filterName, extensions: ['json'] }],
    });
    const file = files[0];
    return file ? new TextDecoder().decode(file.bytes) : null;
  }
}

/**
 * M01 manifest — theme and UI-scale commands.
 *
 * Every user action is a registered command with a palette entry, and the ones worth a key
 * have a shortcut. Nothing here changes the *document*, so no `Command` (undo) objects are
 * involved: switching theme is a view preference, persisted through the settings IPC.
 */

import { invoke, hasBridge } from '@shared/ipc';
import { defineModule, type CommandSpec } from '@shared/module';
import type { ThemeManager } from '@theme/ThemeManager';
import {
  clampUiScale,
  isThemeName,
  themeInfo,
  THEMES,
  UI_SCALE_DEFAULT,
  UI_SCALE_MAX,
  UI_SCALE_MIN,
  UI_SCALE_STEP,
} from '@theme/themes';

/** The service name the shell registers the manager under. */
export const THEME_SERVICE = 'theme';

function manager(ctx: { service<T>(name: string): T }): ThemeManager {
  return ctx.service<ThemeManager>(THEME_SERVICE);
}

/** One `view.theme.set.<name>` command per theme so each is directly reachable and bindable. */
const perThemeCommands: CommandSpec[] = THEMES.map((theme) => ({
  id: `view.theme.set.${theme.name}`,
  label: `Theme: ${theme.label}`,
  category: 'View',
  icon: 'palette',
  description: theme.description,
  run: (ctx) => {
    manager(ctx).set(theme.name);
    return theme.name;
  },
}));

export default defineModule({
  id: 'M01',
  name: 'Theme system',
  commands: [
    {
      id: 'view.theme.set',
      label: 'Set Theme…',
      category: 'View',
      icon: 'palette',
      description: 'Apply a theme by name: graphite, midnight, daylight or high-contrast',
      run: (ctx) => {
        const requested = ctx.args['theme'];
        if (!isThemeName(requested)) {
          throw new Error(
            `view.theme.set needs { theme } — one of ${THEMES.map((t) => t.name).join(', ')}`,
          );
        }
        manager(ctx).set(requested);
        return requested;
      },
    },
    ...perThemeCommands,
    {
      id: 'view.theme.next',
      label: 'Next Theme',
      category: 'View',
      icon: 'palette',
      shortcut: 'Mod+Alt+T',
      description: 'Cycle to the next colour theme',
      run: (ctx) => manager(ctx).next(),
    },
    {
      id: 'view.theme.previous',
      label: 'Previous Theme',
      category: 'View',
      icon: 'palette',
      shortcut: 'Mod+Alt+Shift+T',
      description: 'Cycle to the previous colour theme',
      run: (ctx) => manager(ctx).previous(),
    },
    {
      id: 'view.theme.current',
      label: 'Current theme',
      category: 'View',
      hidden: true,
      description: 'Internal: reports the active theme and UI scale',
      run: (ctx) => manager(ctx).state,
    },
    {
      id: 'view.nightMode.toggle',
      label: 'Night Mode',
      category: 'View',
      icon: 'moon',
      shortcut: 'Mod+Alt+N',
      description: 'Darken the document itself, not just the interface',
      run: (ctx) => manager(ctx).toggleNightMode(),
    },
    {
      id: 'view.nightMode.set',
      label: 'Set Night Mode…',
      category: 'View',
      icon: 'moon',
      description: 'Turn Night Mode on or off (pass { on: true | false })',
      run: (ctx) => {
        const on = ctx.args['on'];
        if (typeof on !== 'boolean') throw new Error('view.nightMode.set needs { on: boolean }');
        return manager(ctx).setNightMode(on);
      },
    },
    {
      id: 'view.uiScale.increase',
      label: 'Increase UI Scale',
      category: 'View',
      icon: 'zoom-in',
      shortcut: 'Mod+Alt+Plus',
      description: `Make the interface larger (up to ${UI_SCALE_MAX} %)`,
      when: (ctx) => manager(ctx).uiScale < UI_SCALE_MAX,
      run: (ctx) => manager(ctx).stepScale(1),
    },
    {
      id: 'view.uiScale.decrease',
      label: 'Decrease UI Scale',
      category: 'View',
      icon: 'zoom-out',
      shortcut: 'Mod+Alt+Minus',
      description: `Make the interface smaller (down to ${UI_SCALE_MIN} %)`,
      when: (ctx) => manager(ctx).uiScale > UI_SCALE_MIN,
      run: (ctx) => manager(ctx).stepScale(-1),
    },
    {
      id: 'view.uiScale.reset',
      label: 'Reset UI Scale',
      category: 'View',
      icon: 'rotate-ccw',
      shortcut: 'Mod+Alt+0',
      description: `Back to ${UI_SCALE_DEFAULT} %`,
      run: (ctx) => manager(ctx).setScale(UI_SCALE_DEFAULT),
    },
    {
      id: 'view.uiScale.set',
      label: 'Set UI Scale…',
      category: 'View',
      icon: 'ruler',
      description: `Set the interface scale in percent (${UI_SCALE_MIN}–${UI_SCALE_MAX})`,
      run: (ctx) => {
        const percent = ctx.args['percent'];
        if (typeof percent !== 'number') throw new Error('view.uiScale.set needs { percent }');
        return manager(ctx).setScale(percent);
      },
    },
  ],
  ribbon: [
    {
      id: 'view.appearance',
      tab: 'view',
      label: 'Appearance',
      order: 10,
      items: [
        'view.theme.next',
        'view.nightMode.toggle',
        '-',
        'view.uiScale.decrease',
        'view.uiScale.reset',
        'view.uiScale.increase',
      ],
      large: ['view.theme.next'],
    },
  ],
  settings: {
    namespace: 'theme',
    properties: {
      name: {
        type: 'enum',
        title: 'Colour theme',
        default: 'graphite',
        options: THEMES.map((t) => ({ value: t.name, label: t.label })),
      },
      nightMode: {
        type: 'boolean',
        title: 'Night Mode (darken the document, not just the interface)',
        default: false,
      },
      scale: {
        type: 'number',
        title: 'UI scale (%)',
        default: UI_SCALE_DEFAULT,
        min: UI_SCALE_MIN,
        max: UI_SCALE_MAX,
        step: UI_SCALE_STEP,
      },
    },
  },
  activate: (ctx) => {
    // Keep the OS chrome in step with the theme (Windows title bar, native menus and dialogs).
    const themes = manager(ctx);
    const push = (name: string): void => {
      if (!hasBridge() || !isThemeName(name)) return;
      void invoke('theme:setNative', themeInfo(name).scheme).catch((error: unknown) => {
        console.warn('could not update the native theme', error);
      });
    };
    push(themes.current);
    return themes.onChange((state) => {
      push(state.theme);
    });
  },
});

/** Re-exported so the shell and tests share one clamp implementation. */
export { clampUiScale };

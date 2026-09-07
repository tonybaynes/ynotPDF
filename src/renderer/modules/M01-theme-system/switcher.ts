/**
 * Status-bar theme quick-switch (M01). A plain `<select>` — keyboard-reachable by default,
 * announced by screen readers, and it renders with the native control colours the theme's
 * `color-scheme` asks for. Sits in the status bar until M02 builds the real one.
 *
 * The switcher is a *view* of the ThemeManager: it runs the `view.theme.set` command rather
 * than calling the manager directly, so every change goes through the command table (and is
 * therefore visible to the palette, the e2e harness and, later, macro recording).
 */

import type { Registry } from '@core/Registry';
import type { ThemeManager } from '@theme/ThemeManager';
import { THEMES } from '@theme/themes';

export interface Switcher {
  readonly element: HTMLElement;
  dispose(): void;
}

/** Builds the status-bar control. Call `dispose()` to unsubscribe. */
export function createThemeSwitcher(registry: Registry, themes: ThemeManager): Switcher {
  const wrapper = document.createElement('span');
  wrapper.className = 'theme-switcher';
  wrapper.id = 'theme-switcher';

  const label = document.createElement('label');
  label.htmlFor = 'theme-select';
  label.textContent = 'Theme';

  const select = document.createElement('select');
  select.id = 'theme-select';
  select.title = 'Change the colour theme';
  for (const theme of THEMES) {
    const option = document.createElement('option');
    option.value = theme.name;
    option.textContent = theme.label;
    select.append(option);
  }
  select.value = themes.current;

  select.addEventListener('change', () => {
    void registry.run('view.theme.set', { theme: select.value }).catch((error: unknown) => {
      console.error('theme switch failed', error);
      select.value = themes.current;
    });
  });

  const unsubscribe = themes.onChange((state) => {
    if (select.value !== state.theme) select.value = state.theme;
  });

  wrapper.append(label, select);
  return {
    element: wrapper,
    dispose: () => {
      unsubscribe();
      wrapper.remove();
    },
  };
}

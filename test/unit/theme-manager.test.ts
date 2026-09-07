/**
 * ThemeManager unit tests (M01). No DOM dependency: the manager only needs an element with
 * `dataset` and `style.setProperty`, so the tests hand it a tiny stand-in and assert exactly
 * what the app would see on `<html>`.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { memoryStorage, ThemeManager, type ThemeStorage } from '@theme/ThemeManager';
import {
  clampUiScale,
  DEFAULT_THEME,
  isThemeName,
  themeInfo,
  THEMES,
  THEME_NAMES,
  UI_SCALE_MAX,
  UI_SCALE_MIN,
} from '@theme/themes';
import { ipcThemeStorage, THEME_KEY, UI_SCALE_KEY } from '@modules/M01-theme-system/storage';
import type { YnotBridge } from '@shared/ipc';

/**
 * Stand-in for `<html>`: records the attribute and the custom property the manager writes.
 * ThemeManager touches exactly `root.dataset.theme` and `root.style.setProperty`, so a
 * two-property object is enough and the unit tests need no DOM implementation.
 */
interface RootStub {
  dataset: Record<string, string>;
  style: Pick<CSSStyleDeclaration, 'setProperty'>;
}

function fakeRoot(): {
  root: HTMLElement;
  dataset: Record<string, string>;
  properties: Record<string, string>;
} {
  const dataset: Record<string, string> = {};
  const properties: Record<string, string> = {};
  const root: RootStub = {
    dataset,
    style: {
      setProperty(name: string, value: string | null) {
        properties[name] = value ?? '';
      },
    },
  };
  return { root: root as unknown as HTMLElement, dataset, properties };
}

describe('themes.ts', () => {
  it('lists four themes, Graphite first and default', () => {
    expect(THEMES).toHaveLength(4);
    expect(THEMES[0]?.name).toBe('graphite');
    expect(DEFAULT_THEME).toBe('graphite');
    expect(THEME_NAMES).toEqual(['graphite', 'midnight', 'daylight', 'high-contrast']);
  });

  it('knows which themes are light', () => {
    expect(themeInfo('daylight').scheme).toBe('light');
    expect(themeInfo('graphite').scheme).toBe('dark');
    expect(() => themeInfo('nope' as never)).toThrow(/Unknown theme/);
  });

  it('validates theme names', () => {
    expect(isThemeName('midnight')).toBe(true);
    expect(isThemeName('MIDNIGHT')).toBe(false);
    expect(isThemeName(7)).toBe(false);
  });

  it('clamps the UI scale to 100–200 % in 10 % steps', () => {
    expect(clampUiScale(100)).toBe(100);
    expect(clampUiScale(37)).toBe(UI_SCALE_MIN);
    expect(clampUiScale(1000)).toBe(UI_SCALE_MAX);
    expect(clampUiScale(143)).toBe(140);
    expect(clampUiScale(Number.NaN)).toBe(100);
  });
});

describe('ThemeManager', () => {
  let stub: ReturnType<typeof fakeRoot>;

  beforeEach(() => {
    stub = fakeRoot();
  });

  it('applies the default theme when nothing is saved', async () => {
    const themes = await ThemeManager.create({ root: stub.root, storage: memoryStorage() });
    expect(themes.current).toBe('graphite');
    expect(stub.dataset['theme']).toBe('graphite');
    expect(stub.properties['--ui-scale']).toBe('1');
    expect(themes.list).toHaveLength(4);
  });

  it('restores a saved theme and scale', async () => {
    const themes = await ThemeManager.create({
      root: stub.root,
      storage: memoryStorage({ theme: 'midnight', scale: 150 }),
    });
    expect(themes.current).toBe('midnight');
    expect(themes.uiScale).toBe(150);
    expect(stub.dataset['theme']).toBe('midnight');
    expect(stub.properties['--ui-scale']).toBe('1.5');
  });

  it('ignores a saved value that is not a theme', async () => {
    const themes = await ThemeManager.create({
      root: stub.root,
      storage: memoryStorage({ theme: 'chartreuse' as never, scale: 999 }),
    });
    expect(themes.current).toBe(DEFAULT_THEME);
    expect(themes.uiScale).toBe(UI_SCALE_MAX);
  });

  it('falls back to the default when storage throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const broken: ThemeStorage = {
      read: () => Promise.reject(new Error('disk on fire')),
      write: () => Promise.resolve(),
    };
    const themes = await ThemeManager.create({ root: stub.root, storage: broken });
    expect(themes.current).toBe(DEFAULT_THEME);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('switches live and persists the choice', async () => {
    const storage = memoryStorage();
    const themes = await ThemeManager.create({ root: stub.root, storage });
    themes.set('daylight');
    expect(stub.dataset['theme']).toBe('daylight');
    await vi.waitFor(async () => {
      expect(await storage.read()).toEqual({ theme: 'daylight', scale: 100 });
    });
  });

  it('notifies listeners on change and stops after unsubscribe', async () => {
    const themes = await ThemeManager.create({ root: stub.root, storage: memoryStorage() });
    const seen: string[] = [];
    const off = themes.onChange((state) => {
      seen.push(state.theme);
    });
    themes.set('midnight');
    themes.set('midnight'); // no-op: same theme
    off();
    themes.set('daylight');
    expect(seen).toEqual(['midnight']);
  });

  it('cycles forwards and backwards, wrapping at both ends', async () => {
    const themes = await ThemeManager.create({ root: stub.root, storage: memoryStorage() });
    expect(themes.next()).toBe('midnight');
    expect(themes.next()).toBe('daylight');
    expect(themes.next()).toBe('high-contrast');
    expect(themes.next()).toBe('graphite');
    expect(themes.previous()).toBe('high-contrast');
  });

  it('rejects an unknown theme name', async () => {
    const themes = await ThemeManager.create({ root: stub.root, storage: memoryStorage() });
    expect(() => {
      themes.set('neon' as never);
    }).toThrow(/Unknown theme/);
  });

  it('steps, clamps and resets the UI scale', async () => {
    const themes = await ThemeManager.create({ root: stub.root, storage: memoryStorage() });
    expect(themes.stepScale(1)).toBe(110);
    expect(stub.properties['--ui-scale']).toBe('1.1');
    expect(themes.setScale(195)).toBe(200);
    expect(themes.stepScale(1)).toBe(200); // already at the top
    expect(themes.setScale(100)).toBe(100);
    expect(themes.stepScale(-1)).toBe(100); // already at the bottom
  });

  it('reports its state to the palette command', async () => {
    const themes = await ThemeManager.create({
      root: stub.root,
      storage: memoryStorage({ theme: 'high-contrast', scale: 120 }),
    });
    expect(themes.state).toEqual({ theme: 'high-contrast', scale: 120 });
  });

  it('tells the caller when a theme has been applied', async () => {
    const applied: string[] = [];
    const themes = await ThemeManager.create({
      root: stub.root,
      storage: memoryStorage(),
      onApplied: (state) => {
        applied.push(state.theme);
      },
    });
    themes.set('daylight');
    expect(applied).toEqual(['graphite', 'daylight']);
  });
});

describe('ipcThemeStorage', () => {
  const bridge = (get: (key: string) => unknown, set?: (k: string, v: unknown) => void): void => {
    const stub = {
      invoke: (channel: string, ...args: unknown[]) => {
        if (channel === 'settings:get') return Promise.resolve(get(String(args[0])));
        if (channel === 'settings:set') {
          set?.(String(args[0]), args[1]);
          return Promise.resolve(undefined);
        }
        return Promise.reject(new Error(`unexpected channel ${channel}`));
      },
      on: () => () => undefined,
      platform: 'win32',
      e2e: true,
    } as unknown as YnotBridge;
    (globalThis as { ynot?: YnotBridge }).ynot = stub;
  };

  beforeEach(() => {
    delete (globalThis as { ynot?: YnotBridge }).ynot;
  });

  it('returns nothing when there is no Electron bridge', async () => {
    expect(await ipcThemeStorage().read()).toEqual({});
    await expect(
      ipcThemeStorage().write({ theme: 'graphite', scale: 100 }),
    ).resolves.toBeUndefined();
  });

  it('reads the saved theme and scale', async () => {
    bridge((key) => (key === THEME_KEY ? 'daylight' : key === UI_SCALE_KEY ? 130 : undefined));
    expect(await ipcThemeStorage().read()).toEqual({ theme: 'daylight', scale: 130 });
  });

  it('drops values of the wrong shape', async () => {
    bridge((key) => (key === THEME_KEY ? 42 : 'big'));
    expect(await ipcThemeStorage().read()).toEqual({});
  });

  it('writes both keys', async () => {
    const written: Record<string, unknown> = {};
    bridge(
      () => undefined,
      (k, v) => {
        written[k] = v;
      },
    );
    await ipcThemeStorage().write({ theme: 'midnight', scale: 150 });
    expect(written).toEqual({ [THEME_KEY]: 'midnight', [UI_SCALE_KEY]: 150 });
  });
});

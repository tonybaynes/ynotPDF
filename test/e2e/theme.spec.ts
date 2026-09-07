/**
 * Theme e2e (M01). Drives the real Electron app through the command table:
 * every theme applies live (no reload), the computed colours really are the theme's tokens,
 * the status-bar switcher stays in step, UI scale changes the root font size, and the choice
 * survives a restart.
 */

import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { launchApp, type App } from './harness';
import { parseThemeCss } from '../../src/renderer/theme/parse';
import { THEMES, type ThemeName } from '../../src/renderer/theme/themes';

/** The token values straight from the CSS files, so the test cannot drift from the palettes. */
const TOKENS = new Map(
  THEMES.map((theme) => [
    theme.name,
    parseThemeCss(readFileSync(join('src/renderer/theme', theme.file), 'utf8')).tokens,
  ]),
);

/** `#1c1c1e` → `rgb(28, 28, 30)`, the form `getComputedStyle` reports. */
function toRgb(hex: string): string {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.replace(/./g, (c) => c + c) : h;
  const n = Number.parseInt(full, 16);
  return `rgb(${String((n >> 16) & 255)}, ${String((n >> 8) & 255)}, ${String(n & 255)})`;
}

function token(theme: ThemeName, name: string): string {
  const value = TOKENS.get(theme)?.get(name);
  if (!value) throw new Error(`${theme} has no ${name}`);
  return value;
}

let app: App;

test.beforeAll(async () => {
  app = await launchApp();
});

test.afterAll(async () => {
  await app.close();
});

test('every theme applies live, with the right colours and colour-scheme', async () => {
  for (const theme of THEMES) {
    await app.run('view.theme.set', { theme: theme.name });
    const applied = await app.page.evaluate(() => ({
      attribute: document.documentElement.dataset['theme'],
      body: getComputedStyle(document.body).backgroundColor,
      fg: getComputedStyle(document.body).color,
      scheme: getComputedStyle(document.documentElement).colorScheme,
    }));
    expect(applied.attribute, theme.name).toBe(theme.name);
    expect(applied.body, `${theme.name} --bg-app`).toBe(toRgb(token(theme.name, '--bg-app')));
    expect(applied.fg, `${theme.name} --fg`).toBe(toRgb(token(theme.name, '--fg')));
    // `only` stops a browser-level auto-dark feature repainting the app's own colours.
    expect(applied.scheme, `${theme.name} color-scheme`).toBe(`${theme.scheme} only`);
  }
});

test('switching does not reload the window', async () => {
  await app.run('view.theme.set', { theme: 'graphite' });
  // Leave a mark on the page; a reload would wipe it.
  await app.page.evaluate(() => {
    (window as unknown as { __themeMark?: number }).__themeMark = 1234;
  });
  await app.run('view.theme.set', { theme: 'midnight' });
  await app.run('view.theme.next');
  const mark = await app.page.evaluate(
    () => (window as unknown as { __themeMark?: number }).__themeMark,
  );
  expect(mark).toBe(1234);
});

test('the theme commands cycle and the status-bar switcher follows', async () => {
  await app.run('view.theme.set', { theme: 'graphite' });
  const select = app.page.locator('#theme-select');
  await expect(select).toHaveValue('graphite');

  expect(await app.run('view.theme.next')).toBe('midnight');
  await expect(select).toHaveValue('midnight');
  expect(await app.run('view.theme.previous')).toBe('graphite');
  await expect(select).toHaveValue('graphite');

  // Driving the control itself runs the command and applies the theme.
  await select.selectOption('daylight');
  await expect(app.page.locator('html')).toHaveAttribute('data-theme', 'daylight');
});

test('an unknown theme is refused and the current theme is untouched', async () => {
  await app.run('view.theme.set', { theme: 'graphite' });
  await expect(app.run('view.theme.set', { theme: 'chartreuse' })).rejects.toThrow(/theme/);
  await expect(app.page.locator('html')).toHaveAttribute('data-theme', 'graphite');
});

test('UI scale changes the root font size and clamps at 100–200 %', async () => {
  const rootFontSize = (): Promise<string> =>
    app.page.evaluate(() => getComputedStyle(document.documentElement).fontSize);

  await app.run('view.uiScale.reset');
  expect(await rootFontSize()).toBe('14px');

  expect(await app.run('view.uiScale.set', { percent: 150 })).toBe(150);
  expect(await rootFontSize()).toBe('21px');

  expect(await app.run('view.uiScale.set', { percent: 500 })).toBe(200);
  expect(await rootFontSize()).toBe('28px');

  expect(await app.run('view.uiScale.set', { percent: 10 })).toBe(100);
  expect(await rootFontSize()).toBe('14px');
});

test('the focus ring is a solid two-ring outline with no transparency', async () => {
  await app.run('view.theme.set', { theme: 'graphite' });
  await app.page.locator('#theme-select').focus();
  const style = await app.page.evaluate(() => {
    const el = document.getElementById('theme-select');
    if (!el) throw new Error('no switcher');
    const s = getComputedStyle(el);
    return {
      width: s.outlineWidth,
      style: s.outlineStyle,
      color: s.outlineColor,
      shadow: s.boxShadow,
    };
  });
  expect(style.style).toBe('solid');
  expect(style.width).toBe('2px');
  expect(style.color).toBe(toRgb(token('graphite', '--focus')));
  expect(style.shadow).not.toContain('rgba');
});

test('Night Mode darkens the page and is off by default', async () => {
  await app.run('view.theme.set', { theme: 'graphite' });
  await app.run('view.nightMode.set', { on: false });

  const pagePair = (): Promise<{ paper: string; ink: string; attribute: string | undefined }> =>
    app.page.evaluate(() => {
      const style = getComputedStyle(document.documentElement);
      return {
        paper: style.getPropertyValue('--page-paper').trim(),
        ink: style.getPropertyValue('--page-ink').trim(),
        attribute: document.documentElement.dataset['nightMode'],
      };
    });

  // Off: the page is the document's own white paper.
  const day = await pagePair();
  expect(day.attribute).toBeUndefined();
  expect(day.paper).toBe(token('graphite', '--page-paper'));

  expect(await app.run('view.nightMode.toggle')).toBe(true);
  const night = await pagePair();
  expect(night.attribute).toBe('on');
  expect(night.paper).toBe(token('graphite', '--page-paper-night'));
  expect(night.ink).toBe(token('graphite', '--page-ink-night'));

  expect(await app.run('view.nightMode.toggle')).toBe(false);
  expect((await pagePair()).attribute).toBeUndefined();
});

test('Night Mode is independent of the theme', async () => {
  await app.run('view.nightMode.set', { on: true });
  for (const theme of THEMES) {
    await app.run('view.theme.set', { theme: theme.name });
    const paper = await app.page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--page-paper').trim(),
    );
    expect(paper, theme.name).toBe(token(theme.name, '--page-paper-night'));
  }
  await app.run('view.nightMode.set', { on: false });
});

test('the theme and scale survive a restart', async () => {
  await app.run('view.theme.set', { theme: 'high-contrast' });
  await app.run('view.uiScale.set', { percent: 130 });
  await app.run('view.nightMode.set', { on: true });
  // Give the settings write a moment to reach the main process before we close the window.
  await expect
    .poll(async () => app.run('view.theme.current'))
    .toEqual({ theme: 'high-contrast', scale: 130, nightMode: true });
  await app.close();

  app = await launchApp({ reuseUserData: true });
  await expect(app.page.locator('html')).toHaveAttribute('data-theme', 'high-contrast');
  expect(await app.run('view.theme.current')).toEqual({
    theme: 'high-contrast',
    scale: 130,
    nightMode: true,
  });
  expect(await app.page.evaluate(() => document.documentElement.dataset['nightMode'])).toBe('on');
  expect(await app.page.evaluate(() => getComputedStyle(document.documentElement).fontSize)).toBe(
    '18.2px',
  );

  // Leave the app in the default theme for anything that runs after this file.
  await app.run('view.theme.set', { theme: 'graphite' });
  await app.run('view.uiScale.reset');
  await app.run('view.nightMode.set', { on: false });
});

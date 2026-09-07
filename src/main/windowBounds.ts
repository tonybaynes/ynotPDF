/**
 * Pure helpers for remembered window bounds (M02) — no Electron import so they unit-test in
 * Node. `windowState.ts` wires them to `screen` and `BrowserWindow`.
 */

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface SavedBounds extends Rect {
  readonly maximized: boolean;
}

export const WINDOW_BOUNDS_KEY = 'window.bounds';
export const DEFAULT_BOUNDS: SavedBounds = {
  x: 0,
  y: 0,
  width: 1280,
  height: 800,
  maximized: false,
};

/**
 * A key describing the current display arrangement: the ids and sizes of all displays, sorted.
 * Two monitors of the same model still differ by id, so a swapped pair gets its own entry. Dots
 * are replaced because `electron-store` treats them as path separators.
 */
export function displayKey(displays: ReadonlyArray<{ id: number; bounds: Rect }>): string {
  return [...displays]
    .map((d) => `${d.id}:${d.bounds.width}x${d.bounds.height}`)
    .sort()
    .join('|')
    .replace(/\./g, '_');
}

/** Clamps a saved rectangle so it is at least partly visible on one of the displays. */
export function clampToDisplays(
  saved: SavedBounds,
  displays: ReadonlyArray<{ workArea: Rect }>,
): SavedBounds {
  const areas = displays.map((d) => d.workArea);
  const first = areas[0];
  if (!first) return saved;
  const visible = areas.some(
    (a) =>
      saved.x + saved.width > a.x + 50 &&
      saved.x < a.x + a.width - 50 &&
      saved.y >= a.y - 10 &&
      saved.y < a.y + a.height - 50,
  );
  if (visible) return saved;
  const width = Math.min(saved.width, first.width);
  const height = Math.min(saved.height, first.height);
  return {
    x: first.x + Math.max(0, Math.round((first.width - width) / 2)),
    y: first.y + Math.max(0, Math.round((first.height - height) / 2)),
    width,
    height,
    maximized: saved.maximized,
  };
}

export function isSavedBounds(value: unknown): value is SavedBounds {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v['x'] === 'number' &&
    typeof v['y'] === 'number' &&
    typeof v['width'] === 'number' &&
    typeof v['height'] === 'number' &&
    typeof v['maximized'] === 'boolean'
  );
}

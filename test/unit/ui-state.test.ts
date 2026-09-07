import { describe, expect, it, vi } from 'vitest';
import {
  clampPaneWidth,
  clampZoom,
  createUiStore,
  DEFAULT_PERSISTED,
  formatZoom,
  initialUiState,
  invalidate,
  memoryUiStorage,
  parsePageInput,
  parseZoomInput,
  persistedFrom,
  persistUi,
  stepZoom,
  validatePersisted,
} from '@app/ui/UiState';

describe('UiState helpers', () => {
  it('clamps pane widths and zoom', () => {
    expect(clampPaneWidth(10)).toBe(160);
    expect(clampPaneWidth(10_000)).toBe(720);
    expect(clampPaneWidth(Number.NaN)).toBe(260);
    expect(clampZoom(0)).toBe(1);
    expect(clampZoom(99_999)).toBe(6400);
    expect(clampZoom(Number.NaN)).toBe(100);
  });

  it('steps zoom through the presets and beyond', () => {
    expect(stepZoom(100, 1)).toBe(125);
    expect(stepZoom(100, -1)).toBe(75);
    expect(stepZoom(400, 1)).toBe(500);
    expect(stepZoom(25, -1)).toBe(20);
    expect(stepZoom(110, 1)).toBe(125);
  });

  it('parses zoom and page input', () => {
    expect(parseZoomInput('150')).toEqual({ zoom: 150, fit: null });
    expect(parseZoomInput(' 150 % ')).toEqual({ zoom: 150, fit: null });
    expect(parseZoomInput('1.5x')).toEqual({ zoom: 150, fit: null });
    expect(parseZoomInput('fit page')).toEqual({ zoom: 100, fit: 'page' });
    expect(parseZoomInput('Fit Width')).toEqual({ zoom: 100, fit: 'width' });
    expect(parseZoomInput('abc')).toBeNull();
    expect(parseZoomInput('')).toBeNull();
    expect(parsePageInput('3', 10)).toBe(3);
    expect(parsePageInput('0', 10)).toBeNull();
    expect(parsePageInput('11', 10)).toBeNull();
    expect(parsePageInput('x', 10)).toBeNull();
  });

  it('formats the zoom field', () => {
    const view = initialUiState().view;
    expect(formatZoom(view)).toBe('100%');
    expect(formatZoom({ ...view, fit: 'page' })).toBe('Fit page');
    expect(formatZoom({ ...view, fit: 'width' })).toBe('Fit width');
  });

  it('builds the initial state from the persisted subset and projects it back', () => {
    const s = initialUiState({
      leftPaneWidth: 300,
      leftPanel: 'nav.x',
      ribbonMinimised: true,
      layout: 'book',
    });
    expect(s.leftPane).toEqual({ width: 300, collapsed: false, panel: 'nav.x' });
    expect(s.ribbon.minimised).toBe(true);
    expect(s.view.layout).toBe('book');
    expect(persistedFrom(s)).toEqual({
      ...DEFAULT_PERSISTED,
      leftPaneWidth: 300,
      leftPanel: 'nav.x',
      ribbonMinimised: true,
      layout: 'book',
    });
  });

  it('validates a hand-edited settings object', () => {
    const v = validatePersisted({
      ribbonMinimised: 'yes',
      ribbonCompact: 'no',
      qat: ['a', 1],
      leftPaneWidth: 5,
      leftPaneCollapsed: true,
      leftPanel: 7,
      rightPaneWidth: '9',
      layout: 'spiral',
    });
    expect(v).toEqual({ leftPaneWidth: 160, leftPaneCollapsed: true });
    expect(validatePersisted({ ...DEFAULT_PERSISTED, qat: ['x'], leftPanel: null })).toMatchObject({
      qat: ['x'],
      leftPanel: null,
      layout: 'continuous',
    });
  });

  it('persists only when the persisted projection changes, debounced', async () => {
    vi.useFakeTimers();
    const storage = memoryUiStorage();
    const write = vi.spyOn(storage, 'write');
    const ui = createUiStore();
    const stop = persistUi(ui, storage, 10);
    invalidate(ui);
    invalidate(ui);
    vi.advanceTimersByTime(50);
    expect(write).not.toHaveBeenCalled();
    ui.set((s) => ({ leftPane: { ...s.leftPane, width: 400 } }));
    ui.set((s) => ({ leftPane: { ...s.leftPane, width: 420 } }));
    vi.advanceTimersByTime(50);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0]?.[0].leftPaneWidth).toBe(420);
    expect((await storage.read()).leftPaneWidth).toBe(420);
    stop();
    ui.set((s) => ({ leftPane: { ...s.leftPane, width: 500 } }));
    vi.advanceTimersByTime(50);
    expect(write).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});

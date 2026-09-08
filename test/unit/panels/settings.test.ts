/**
 * The navigation settings (M12), the thumbnail renderer's queue, and the layer-visibility file.
 *
 * `ui.leftPaneOnOpen` is the operator's requirement in one key, so what happens to a malformed
 * or absent value matters: it must land on Pages, not on nothing.
 */

import { describe, expect, it } from 'vitest';
import type { EngineClient } from '@engine/EngineClient';
import { EngineError, type DocHandle } from '@engine/PdfEngine';
import {
  DEFAULT_NAVIGATION_SETTINGS,
  LEFT_PANE_ON_OPEN,
  NAVIGATION_SETTINGS_SCHEMA,
  memorySettingsStorage,
  readNavigationSettings,
  settingKey,
  writeNavigationSetting,
} from '@modules/M12-navigation-panels/settings';
import {
  ThumbnailRenderer,
  thumbnailId,
  type ThumbnailRequest,
} from '@modules/M12-navigation-panels/thumbnails/ThumbnailRenderer';
import { layerStateOf, parseLayerState } from '@modules/M12-navigation-panels/layers/LayerPanel';
import type { ModelId } from '@core/Ids';
import type { ModelLayer } from '@core/model';

describe('navigation settings', () => {
  it('an empty profile opens on Pages', async () => {
    const settings = await readNavigationSettings(memorySettingsStorage());
    expect(settings).toEqual(DEFAULT_NAVIGATION_SETTINGS);
    expect(settings.leftPaneOnOpen).toBe('pages');
  });

  it('reads what was written, for every value the setting takes', async () => {
    const storage = memorySettingsStorage();
    for (const option of LEFT_PANE_ON_OPEN) {
      await writeNavigationSetting(storage, 'leftPaneOnOpen', option.value);
      expect((await readNavigationSettings(storage)).leftPaneOnOpen).toBe(option.value);
    }
  });

  it('ignores a hand-edited file that says something silly', async () => {
    const storage = memorySettingsStorage({
      'ui.leftPaneOnOpen': 'sideways',
      'ui.thumbnailSize': 137,
      'ui.bookmarks.wrapTitles': 'yes please',
      'ui.bookmarks.expandToLevel': 99,
    });
    const settings = await readNavigationSettings(storage);
    expect(settings.leftPaneOnOpen).toBe('pages');
    // A size off the ladder snaps to the nearest rung, because that is what `+` and `−` step.
    expect(settings.thumbnailSize).toBe(120);
    expect(settings.wrapBookmarkTitles).toBe(DEFAULT_NAVIGATION_SETTINGS.wrapBookmarkTitles);
    expect(settings.expandBookmarksToLevel).toBe(6);
  });

  it('the schema M130 renders matches the keys the module actually writes', () => {
    expect(NAVIGATION_SETTINGS_SCHEMA.namespace).toBe('ui');
    for (const [name, key] of [
      ['leftPaneOnOpen', 'ui.leftPaneOnOpen'],
      ['thumbnailSize', 'ui.thumbnailSize'],
      ['wrapBookmarkTitles', 'ui.bookmarks.wrapTitles'],
    ] as const) {
      expect(settingKey(name)).toBe(key);
      const short = key.slice('ui.'.length);
      expect(Object.keys(NAVIGATION_SETTINGS_SCHEMA.properties)).toContain(short);
    }
  });
});

/** A fake engine client whose renders resolve when the test says so. */
function fakeClient(): {
  client: EngineClient;
  resolveAll: () => void;
  calls: number;
  cancelled: number;
} {
  const pending: Array<() => void> = [];
  const state = { calls: 0, cancelled: 0 };
  const client = {
    request: () => {
      state.calls++;
      let settle: () => void = () => undefined;
      let fail: (error: unknown) => void = () => undefined;
      const promise = new Promise((resolve, reject) => {
        settle = () => {
          resolve({ bitmap: { width: 10, height: 10, close: () => undefined }, scale: 1 });
        };
        fail = reject;
      });
      pending.push(settle);
      return {
        id: state.calls,
        promise,
        cancel: () => {
          state.cancelled++;
          fail(new EngineError('cancelled', 'cancelled'));
        },
      };
    },
  } as unknown as EngineClient;
  return {
    client,
    resolveAll: () => {
      for (const settle of pending.splice(0)) settle();
    },
    get calls() {
      return state.calls;
    },
    get cancelled() {
      return state.cancelled;
    },
  };
}

function request(page: number, overrides: Partial<ThumbnailRequest> = {}): ThumbnailRequest {
  return {
    docKey: 'tab-1',
    doc: 1 as DocHandle,
    page,
    pageId: `pg-${String(page)}`,
    size: 120,
    pageWidth: 595,
    pageHeight: 842,
    dpr: 1,
    priority: page,
    ...overrides,
  };
}

describe('the thumbnail renderer', () => {
  it('renders one at a time, nearest the current page first', async () => {
    const fake = fakeClient();
    const renderer = new ThumbnailRenderer({ client: fake.client });
    renderer.request([request(9, { priority: 9 }), request(1, { priority: 1 })]);
    // One in flight, whatever was asked for.
    expect(fake.calls).toBe(1);
    fake.resolveAll();
    await Promise.resolve();
    await Promise.resolve();
    renderer.dispose();
  });

  it('holds back entirely while the main view is busy', () => {
    const fake = fakeClient();
    let busy = true;
    const renderer = new ThumbnailRenderer({
      client: fake.client,
      viewerBusy: () => busy,
      retryMs: 1,
    });
    renderer.request([request(0)]);
    expect(fake.calls).toBe(0);
    busy = false;
    renderer.dispose();
  });

  it('cancels a render nobody wants any more', async () => {
    const fake = fakeClient();
    const renderer = new ThumbnailRenderer({ client: fake.client });
    renderer.request([request(0)]);
    expect(fake.calls).toBe(1);
    // The reader scrolled: page 0 is not wanted any more.
    renderer.request([request(50)]);
    expect(fake.cancelled).toBe(1);
    await Promise.resolve();
    renderer.dispose();
  });

  it('keys the cache by tab, page, size and revision', () => {
    const renderer = new ThumbnailRenderer({ client: fakeClient().client });
    const id = thumbnailId(request(3), 0);
    expect(id).toContain('tab-1');
    expect(id).toContain('pg-3');
    expect(thumbnailId(request(3), 1)).not.toBe(id);
    expect(thumbnailId(request(3, { size: 300 }), 0)).not.toBe(id);
    expect(renderer.revision('tab-1')).toBe(0);
    renderer.invalidate('tab-1');
    expect(renderer.revision('tab-1')).toBe(1);
    renderer.forget('tab-1');
    expect(renderer.revision('tab-1')).toBe(0);
    renderer.dispose();
  });

  it('reports what it is doing', () => {
    const renderer = new ThumbnailRenderer({ client: fakeClient().client });
    renderer.request([request(0), request(1), request(2)]);
    expect(renderer.stats.queued).toBe(3);
    expect(renderer.stats.cached).toBe(0);
    renderer.dispose();
    // Disposed: it stops asking for anything.
    renderer.request([request(4)]);
    expect(renderer.stats.queued).toBe(0);
  });
});

describe('the layer-visibility file', () => {
  const layers: ModelLayer[] = [
    {
      id: 'ly-1' as ModelId,
      engineId: 'ocg.1',
      name: 'Base',
      visible: true,
      locked: false,
      depth: 0,
    },
    {
      id: 'ly-2' as ModelId,
      engineId: 'ocg.2',
      name: 'Notes',
      visible: false,
      locked: true,
      depth: 1,
    },
  ];

  it('writes name → visible', () => {
    expect(layerStateOf(layers)).toEqual({ Base: true, Notes: false });
  });

  it('reads back only what is a name and a boolean', () => {
    expect(parseLayerState({ Base: true, Notes: false })).toEqual({ Base: true, Notes: false });
    expect(parseLayerState({ Base: true, Bad: 'yes' })).toEqual({ Base: true });
    expect(parseLayerState({})).toBeNull();
    expect(parseLayerState(null)).toBeNull();
    expect(parseLayerState('not a file')).toBeNull();
    expect(parseLayerState({ Bad: 1 })).toBeNull();
  });

  it('round-trips through JSON', () => {
    const json = JSON.stringify(layerStateOf(layers));
    expect(parseLayerState(JSON.parse(json) as unknown)).toEqual(layerStateOf(layers));
  });
});

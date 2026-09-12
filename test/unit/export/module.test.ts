/**
 * M92's module half that a unit test can reach: the Worker protocol driven through a fake port,
 * the settings reader, and the manifest's shape.
 *
 * `ExportClient` and `serveExport` are wired to each other here with two plain objects, so the
 * message flow the app really uses — including the question the worker asks back when it needs a
 * page rendered — is exercised without a browser.
 */

import { describe, expect, it, vi } from 'vitest';
import { buildPageText } from '@view/TextLayer';
import { ExportCancelled, readPngHeader, type Raster } from '@engine/export';
import {
  ExportClient,
  type ExportHandle,
  type ExportWorkerLike,
} from '@modules/M92-export/ExportClient';
import { serveExport, type ExportPort } from '@modules/M92-export/export.worker';
import type { ExportFromWorker, ExportToWorker } from '@modules/M92-export/exportProtocol';
import manifest from '@modules/M92-export/manifest';
import {
  DEFAULT_EXPORT_SETTINGS,
  EXPORT_SETTINGS_SCHEMA,
  memorySettingsStorage,
  readExportSettings,
  settingKey,
  writeExportSetting,
  writeExportSettings,
} from '@modules/M92-export/settings';

/**
 * A client and a worker joined by two message queues, delivered asynchronously so the ordering is
 * the ordering `postMessage` really gives.
 */
function pair(): ExportClient {
  const clientListeners: Array<(ev: MessageEvent) => void> = [];
  const workerListeners: Array<(ev: MessageEvent<ExportToWorker>) => void> = [];
  const port: ExportPort = {
    postMessage: (message: ExportFromWorker) => {
      queueMicrotask(() => {
        for (const listener of clientListeners) listener({ data: message } as MessageEvent);
      });
    },
    addEventListener: (_type, listener) => workerListeners.push(listener),
  };
  const worker: ExportWorkerLike = {
    postMessage: (message: ExportToWorker) => {
      queueMicrotask(() => {
        for (const listener of workerListeners) {
          listener({ data: message } as MessageEvent<ExportToWorker>);
        }
      });
    },
    addEventListener: (type, listener) => {
      if (type === 'message') clientListeners.push(listener as (ev: MessageEvent) => void);
    },
    terminate: () => undefined,
  };
  serveExport(port);
  return new ExportClient(worker);
}

/** A flat grey page of exactly the size the dpi asks for. */
const render = (page: number, dpi: number): Promise<Raster> => {
  const width = Math.round((200 * dpi) / 72);
  const height = Math.round((100 * dpi) / 72);
  const data = new Uint8Array(width * height * 4).fill(200);
  return Promise.resolve({ data, width, height });
};

const BASE = {
  pages: [0, 1],
  pageCount: 2,
  documentName: 'doc',
  format: 'png',
  dpi: 72,
  colour: 'colour',
} as const;

describe('ExportClient over a fake worker', () => {
  it('runs an image export, asking the renderer for each page', async () => {
    const client = pair();
    expect(client.offThread).toBe(true);
    const asked: number[] = [];
    const handle = client.images(
      { ...BASE, pages: [0, 1] },
      {
        render: (page, dpi) => {
          asked.push(page);
          return render(page, dpi);
        },
      },
    );
    const result = await handle.promise;
    expect(asked).toEqual([0, 1]);
    expect(result.files.map((f) => f.name)).toEqual(['doc_page1.png', 'doc_page2.png']);
    const header = readPngHeader(result.files[0]?.bytes ?? new Uint8Array(0));
    expect([header.width, header.height]).toEqual([200, 100]);
  });

  it('reports progress across the boundary', async () => {
    const client = pair();
    const progress = vi.fn();
    await client.images({ ...BASE }, { render, onProgress: progress }).promise;
    expect(progress).toHaveBeenCalled();
    expect(progress.mock.calls.some((c) => String(c[1]).includes('page 2'))).toBe(true);
  });

  it('turns a render failure into a failed export rather than a hang', async () => {
    const client = pair();
    const handle = client.images(
      { ...BASE, pages: [0] },
      {
        render: () => Promise.reject(new Error('the page could not be drawn')),
      },
    );
    await expect(handle.promise).rejects.toThrow(/could not be drawn/);
  });

  it('cancels a job in flight and produces nothing', async () => {
    const client = pair();
    const handle = client.images(
      { ...BASE, pages: [0, 1] },
      {
        render: async (page, dpi) => {
          if (page === 0) handle.cancel();
          return await render(page, dpi);
        },
      },
    );
    await expect(handle.promise).rejects.toBeInstanceOf(ExportCancelled);
  });

  it('runs the three text exports and the embedded one over the same channel', async () => {
    const client = pair();
    const pages = [
      {
        index: 0,
        width: 200,
        height: 100,
        text: buildPageText(0, []),
      },
    ];
    const text = await client.text(pages, { documentName: 'doc' }).promise;
    expect(text.files[0]?.name).toBe('doc.txt');
    const html = await client.html(pages, { documentName: 'doc' }).promise;
    expect(html.files[0]?.name).toBe('doc.html');
    const rtf = await client.rtf(pages, { documentName: 'doc' }).promise;
    expect(rtf.files[0]?.name).toBe('doc.rtf');
    const embedded = await client.embedded(
      [
        {
          page: 0,
          index: 0,
          width: 32,
          height: 32,
          dpiX: 72,
          dpiY: 72,
          encoding: 'jpeg',
          data: Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]),
        },
      ],
      { documentName: 'doc', pageCount: 1 },
    ).promise;
    expect(embedded.files[0]?.name).toBe('doc_p1_img1.jpg');
  });
});

describe('ExportClient with no worker at all', () => {
  it('runs the same functions in-process, so a test proves what ships', async () => {
    const client = new ExportClient(null);
    expect(client.offThread).toBe(false);
    const result = await client.images({ ...BASE, pages: [0] }, { render }).promise;
    expect(result.files).toHaveLength(1);
    expect(readPngHeader(result.files[0]?.bytes ?? new Uint8Array(0)).width).toBe(200);
  });

  it('cancels in-process too', async () => {
    const client = new ExportClient(null);
    // In-process the first render happens before `images()` has returned, so the handle is held
    // rather than closed over — which is exactly the difference between the two paths.
    const held: { handle: ExportHandle | null } = { handle: null };
    held.handle = client.images(
      { ...BASE, pages: [0, 1, 2], pageCount: 3 },
      {
        render: async (page, dpi) => {
          // Page 0 is rendered before the handle exists; cancel as soon as it does.
          held.handle?.cancel();
          return await render(page, dpi);
        },
      },
    );
    await expect(held.handle.promise).rejects.toBeInstanceOf(ExportCancelled);
  });

  it('says so rather than hanging when an image export is given no renderer', async () => {
    const client = new ExportClient(null);
    await expect(client.images({ ...BASE, pages: [0] }, {}).promise).rejects.toThrow(/No renderer/);
  });
});

describe('settings', () => {
  it('reads the defaults from an empty store', async () => {
    expect(await readExportSettings(memorySettingsStorage())).toEqual(DEFAULT_EXPORT_SETTINGS);
  });

  it('round-trips every value', async () => {
    const storage = memorySettingsStorage();
    await writeExportSettings(storage, {
      imageFormat: 'tiff',
      imageDpi: 300,
      imageColour: 'mono',
      tiffMultiPage: true,
      textEncoding: 'utf-16le',
      htmlLayout: 'flowing',
      rtfPageBreaks: false,
    });
    const read = await readExportSettings(storage);
    expect(read.imageFormat).toBe('tiff');
    expect(read.imageDpi).toBe(300);
    expect(read.imageColour).toBe('mono');
    expect(read.tiffMultiPage).toBe(true);
    expect(read.textEncoding).toBe('utf-16le');
    expect(read.htmlLayout).toBe('flowing');
    expect(read.rtfPageBreaks).toBe(false);
  });

  it('falls back rather than throwing on a hand-edited settings file', async () => {
    const storage = memorySettingsStorage({
      [settingKey('imageFormat')]: 'webp',
      [settingKey('imageDpi')]: 99_999,
      [settingKey('imageColour')]: 42,
      [settingKey('imageNamePattern')]: '   ',
      [settingKey('textEncoding')]: null,
      [settingKey('htmlPerPage')]: 'yes',
    });
    const read = await readExportSettings(storage);
    expect(read.imageFormat).toBe(DEFAULT_EXPORT_SETTINGS.imageFormat);
    expect(read.imageDpi).toBe(DEFAULT_EXPORT_SETTINGS.imageDpi);
    expect(read.imageColour).toBe(DEFAULT_EXPORT_SETTINGS.imageColour);
    expect(read.imageNamePattern).toBe(DEFAULT_EXPORT_SETTINGS.imageNamePattern);
    expect(read.textEncoding).toBe(DEFAULT_EXPORT_SETTINGS.textEncoding);
    expect(read.htmlPerPage).toBe(DEFAULT_EXPORT_SETTINGS.htmlPerPage);
  });

  it('writes one setting under the namespaced key Preferences reads', async () => {
    const storage = memorySettingsStorage();
    await writeExportSetting(storage, 'imageDpi', 200);
    expect(await storage.get('export.image.dpi')).toBe(200);
    expect(settingKey('imageDpi')).toBe('export.image.dpi');
  });

  it('declares every setting in the schema Preferences renders', () => {
    const keys = Object.keys(EXPORT_SETTINGS_SCHEMA.properties);
    const names = Object.keys(DEFAULT_EXPORT_SETTINGS) as Array<
      keyof typeof DEFAULT_EXPORT_SETTINGS
    >;
    expect(keys.length).toBe(names.length);
    for (const name of names) {
      expect(keys, name).toContain(settingKey(name).replace(/^export\./, ''));
    }
  });

  it('gives every setting a default that matches its declared type', () => {
    for (const [key, spec] of Object.entries(EXPORT_SETTINGS_SCHEMA.properties)) {
      if (spec.type === 'boolean') expect(typeof spec.default, key).toBe('boolean');
      else if (spec.type === 'number') expect(typeof spec.default, key).toBe('number');
      else expect(typeof spec.default, key).toBe('string');
      if (spec.type === 'enum') {
        expect(
          spec.options.map((o) => o.value),
          key,
        ).toContain(spec.default);
      }
    }
  });
});

describe('the manifest', () => {
  it('registers the five exports plus the developer probe, all well-formed', () => {
    const commands = manifest.commands ?? [];
    const ids = commands.map((c) => c.id);
    expect(ids).toEqual([
      'convert.exportImages',
      'convert.exportAllImages',
      'convert.exportText',
      'convert.exportHtml',
      'convert.exportRtf',
      'dev.exportState',
    ]);
    expect(new Set(ids).size).toBe(ids.length);
    for (const command of commands) {
      expect(command.label, command.id).toBeTruthy();
      expect(command.category, command.id).toBeTruthy();
      expect(/^[a-z][a-zA-Z0-9]*(\.[a-zA-Z0-9]+)+$/.test(command.id), command.id).toBe(true);
    }
  });

  it('gates every export on the permission the PDF can withhold', () => {
    const byId = new Map((manifest.commands ?? []).map((c) => [c.id, c]));
    expect(byId.get('convert.exportImages')?.permission).toBe('copy');
    expect(byId.get('convert.exportAllImages')?.permission).toBe('copy');
    expect(byId.get('convert.exportText')?.permission).toBe('copy');
    expect(byId.get('convert.exportHtml')?.permission).toBe('copy');
    expect(byId.get('convert.exportRtf')?.permission).toBe('copy');
  });

  it('puts one group on the Convert tab whose menu lists every export', () => {
    const groups = manifest.ribbon ?? [];
    expect(groups).toHaveLength(1);
    const group = groups[0];
    expect(group?.tab).toBe('convert');
    const item = group?.items[0];
    const menu =
      item && typeof item === 'object' && 'menu' in item && Array.isArray(item.menu)
        ? item.menu
        : [];
    for (const id of [
      'convert.exportImages',
      'convert.exportAllImages',
      'convert.exportText',
      'convert.exportHtml',
      'convert.exportRtf',
    ]) {
      expect(menu, id).toContain(id);
    }
  });

  it('hides the developer probe from the palette and shows everything else', () => {
    const byId = new Map((manifest.commands ?? []).map((c) => [c.id, c]));
    expect(byId.get('dev.exportState')?.hidden).toBe(true);
    for (const id of ['convert.exportImages', 'convert.exportText']) {
      expect(byId.get(id)?.hidden).toBeUndefined();
    }
  });

  it('does nothing at all without the shell, so importing it cannot break a test', () => {
    const registry = { hasService: () => false };
    const disposer = manifest.activate?.({
      run: () => Promise.resolve(undefined),
      service: <T>() => registry as T,
    });
    expect(disposer).toBeUndefined();
  });
});

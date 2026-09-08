/**
 * M13's settings, the CSV writer and the snapshot arithmetic.
 */

import { describe, expect, it } from 'vitest';
import { BOM, csvBytes, hitsToCsv } from '@modules/M13-select-find-print/find/csv';
import type { SearchHit } from '@modules/M13-select-find-print/find/search';
import {
  DEFAULT_PRINT_SETTINGS,
  DEFAULT_SELECT_FIND_SETTINGS,
  findOptionsOf,
  memorySettingsStorage,
  mergePrintSettings,
  readPrintSettings,
  readSettings,
  SELECT_FIND_SETTINGS_SCHEMA,
  settingKey,
  writePrintSettings,
  writeSetting,
} from '@modules/M13-select-find-print/settings';
import {
  clampRegion,
  snapshotFileName,
  snapshotPixelSize,
} from '@modules/M13-select-find-print/snapshot/snapshot';

describe('settings', () => {
  it('falls back to the defaults for anything unset', async () => {
    const settings = await readSettings(memorySettingsStorage());
    expect(settings).toEqual(DEFAULT_SELECT_FIND_SETTINGS);
  });

  it('reads what has been written, and ignores a value of the wrong type', async () => {
    const storage = memorySettingsStorage({
      'find.matchCase': true,
      'find.proximity': 'lots',
      'snapshot.dpi': 600,
    });
    const settings = await readSettings(storage);
    expect(settings.matchCase).toBe(true);
    expect(settings.proximity).toBe(0);
    expect(settings.snapshotDpi).toBe(600);
  });

  it('round-trips one setting', async () => {
    const storage = memorySettingsStorage();
    await writeSetting(storage, 'wholeWord', true);
    expect((await readSettings(storage)).wholeWord).toBe(true);
    expect(settingKey('wholeWord')).toBe('find.wholeWord');
  });

  it('turns the settings into find options', () => {
    const options = findOptionsOf({
      ...DEFAULT_SELECT_FIND_SETTINGS,
      matchCase: true,
      proximity: 4,
    });
    expect(options.matchCase).toBe(true);
    expect(options.proximity).toBe(4);
  });

  it('declares a schema M130 can render', () => {
    expect(SELECT_FIND_SETTINGS_SCHEMA.namespace).toBe('find');
    expect(Object.keys(SELECT_FIND_SETTINGS_SCHEMA.properties).length).toBeGreaterThan(8);
    for (const spec of Object.values(SELECT_FIND_SETTINGS_SCHEMA.properties)) {
      expect(typeof spec.default).toBe(
        spec.type === 'number' ? 'number' : spec.type === 'boolean' ? 'boolean' : 'string',
      );
    }
  });
});

describe('print settings', () => {
  it('start from the defaults when nothing is stored', async () => {
    expect(await readPrintSettings(memorySettingsStorage())).toEqual(DEFAULT_PRINT_SETTINGS);
  });

  it('merge a stored object field by field, so an older one still works', () => {
    const merged = mergePrintSettings({ copies: 3, mode: 'booklet', nonsense: 1, dpi: 'lots' });
    expect(merged.copies).toBe(3);
    expect(merged.mode).toBe('booklet');
    expect(merged.dpi).toBe(DEFAULT_PRINT_SETTINGS.dpi);
    expect(merged).not.toHaveProperty('nonsense');
  });

  it('ignore something that is not an object at all', () => {
    expect(mergePrintSettings('nope')).toEqual(DEFAULT_PRINT_SETTINGS);
    expect(mergePrintSettings(null)).toEqual(DEFAULT_PRINT_SETTINGS);
  });

  it('round-trip', async () => {
    const storage = memorySettingsStorage();
    await writePrintSettings(storage, { ...DEFAULT_PRINT_SETTINGS, copies: 7 });
    expect((await readPrintSettings(storage)).copies).toBe(7);
  });
});

describe('CSV export', () => {
  const hits: SearchHit[] = [
    {
      documentId: 'C:\\docs\\a.pdf',
      documentName: 'a.pdf',
      page: 2,
      source: 'page',
      start: 0,
      end: 4,
      snippet: 'he said "hello", then left',
    },
    {
      documentId: 'b.pdf',
      documentName: 'b.pdf',
      page: -1,
      source: 'bookmark',
      start: 0,
      end: 4,
      snippet: 'Chapter 1',
      label: 'Chapter 1',
    },
  ];

  it('writes a header and one row per hit, with a BOM and CRLF', () => {
    const csv = hitsToCsv(hits);
    expect(csv.startsWith(`${BOM}"Document"`)).toBe(true);
    expect(csv.split('\r\n')).toHaveLength(4); // header, two rows, trailing empty
    expect(csv).toContain('"3"'); // page numbers are 1-based
    expect(csv).toContain('""hello""'); // quotes are doubled
    expect(csv).toContain('"bookmark"');
  });

  it('leaves the page blank for a document-level hit', () => {
    const bookmarkHit = hits[1];
    expect(bookmarkHit).toBeDefined();
    expect(hitsToCsv(bookmarkHit ? [bookmarkHit] : [])).toContain('"b.pdf","b.pdf","","bookmark"');
  });

  it('encodes as UTF-8 bytes', () => {
    const bytes = csvBytes(hits);
    expect(bytes[0]).toBe(0xef);
    expect(bytes[1]).toBe(0xbb);
    expect(bytes[2]).toBe(0xbf);
  });
});

describe('snapshot arithmetic', () => {
  it('a 100 × 50 pt rectangle at 300 DPI is 417 × 208 pixels', () => {
    const size = snapshotPixelSize({ x0: 10, y0: 10, x1: 110, y1: 60 }, 300);
    expect(size.scale).toBeCloseTo(300 / 72, 5);
    expect(size.width).toBe(Math.round(100 * (300 / 72)));
    expect(size.height).toBe(Math.round(50 * (300 / 72)));
  });

  it('never asks for a zero-sized bitmap', () => {
    expect(snapshotPixelSize({ x0: 0, y0: 0, x1: 0, y1: 0 }, 72)).toMatchObject({
      width: 1,
      height: 1,
    });
  });

  it('clamps a marquee to the page and normalises it', () => {
    const page = { x0: 0, y0: 0, x1: 100, y1: 100 };
    expect(clampRegion({ x0: 80, y0: 90, x1: -20, y1: 200 }, page)).toEqual({
      x0: 0,
      y0: 90,
      x1: 80,
      y1: 100,
    });
  });

  it('suggests a file name that no OS will refuse', () => {
    expect(snapshotFileName('Report: Q1/Q2.pdf', 4)).toBe('Report- Q1-Q2-page-5.png');
    expect(snapshotFileName('', 0)).toBe('snapshot-page-1.png');
  });
});

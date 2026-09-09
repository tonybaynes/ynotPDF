/**
 * M40's settings reader and the pure half of the drag controller.
 *
 * The settings reader matters because a hand-edited `settings.json` must never stop a document
 * opening: everything it cannot understand falls back, and none of it throws.
 *
 * `insertionIndexFor` matters because it is where a drop actually lands. It is separated from the
 * pointer plumbing so the awkward case — a grid whose rows wrap, where "after the last cell of a
 * row" and "before the first cell of the next" are the same insertion point — can be tested
 * without a browser.
 */

import { describe, expect, it } from 'vitest';
import { insertionIndexFor, type DragCell } from '@modules/M40-organise-pages/dnd';
import {
  DEFAULT_ORGANISE_SETTINGS,
  INSERT_POSITIONS,
  ORGANISE_SETTINGS_SCHEMA,
  extractFileName,
  memorySettingsStorage,
  readOrganiseSettings,
  settingKey,
  writeOrganiseSetting,
} from '@modules/M40-organise-pages/settings';

describe('the settings reader', () => {
  it('answers the defaults for an empty store', async () => {
    expect(await readOrganiseSettings(memorySettingsStorage())).toEqual(DEFAULT_ORGANISE_SETTINGS);
  });

  it('reads what was written, through the keys the schema declares', async () => {
    const storage = memorySettingsStorage();
    await writeOrganiseSetting(storage, 'confirmDelete', false);
    await writeOrganiseSetting(storage, 'insertPosition', 'first');
    await writeOrganiseSetting(storage, 'extractNamePattern', '{label}');
    const settings = await readOrganiseSettings(storage);
    expect(settings.confirmDelete).toBe(false);
    expect(settings.insertPosition).toBe('first');
    expect(settings.extractNamePattern).toBe('{label}');
  });

  it('falls back rather than throwing on a hand-edited file', async () => {
    const storage = memorySettingsStorage({
      'organise.blankPageSize': 'Papyrus',
      'organise.insertPosition': 'sideways',
      'organise.confirmDelete': 'yes please',
      'organise.extractNamePattern': '   ',
      'organise.pruneBookmarksOnDelete': 3,
    });
    const settings = await readOrganiseSettings(storage);
    expect(settings).toEqual(DEFAULT_ORGANISE_SETTINGS);
  });

  it('names every setting in the schema by the key it is stored under', () => {
    for (const name of Object.keys(DEFAULT_ORGANISE_SETTINGS) as Array<
      keyof typeof DEFAULT_ORGANISE_SETTINGS
    >) {
      expect(settingKey(name)).toMatch(/^organise\./u);
    }
  });

  it('declares a default for every property, and they match the reader', () => {
    const properties = Object.values(ORGANISE_SETTINGS_SCHEMA.properties);
    expect(properties.length).toBe(Object.keys(DEFAULT_ORGANISE_SETTINGS).length);
    for (const property of properties) expect(property.default).toBeDefined();
    expect(ORGANISE_SETTINGS_SCHEMA.namespace).toBe('organise');
  });

  it('offers the four insert positions, each named in words', () => {
    expect(INSERT_POSITIONS).toHaveLength(4);
    for (const position of INSERT_POSITIONS) expect(position.label.length).toBeGreaterThan(4);
  });
});

describe('extractFileName', () => {
  const parts = { name: 'Report', page: 3, label: 'iii' };

  it('fills the pattern in and adds the extension', () => {
    expect(extractFileName('{name} page {page}', parts)).toBe('Report page 3.pdf');
    expect(extractFileName('{name}-{label}', parts)).toBe('Report-iii.pdf');
  });

  it('never doubles the extension a pattern already supplied', () => {
    expect(extractFileName('{name} {page}.pdf', parts)).toBe('Report 3.pdf');
    expect(extractFileName('{name} {page}.PDF', parts)).toBe('Report 3.pdf');
  });

  it('keeps spaces, which are legal and deliberate', () => {
    expect(extractFileName('my report {page}', parts)).toBe('my report 3.pdf');
  });

  it('replaces what a file system refuses, rather than removing it', () => {
    // Removing would let two different pages collapse onto one name.
    expect(extractFileName('a/b:c*d?{page}', parts)).toBe('a-b-c-d-3.pdf');
  });

  it('never ends in a dot or a space, which Windows cannot open', () => {
    expect(extractFileName('{name} {page} ', parts)).toBe('Report 3.pdf');
    expect(extractFileName('{name} {page}...', parts)).toBe('Report 3.pdf');
  });

  it('adds the page number to a pattern that does not name the page', () => {
    // Without this every page of a run would be written to one name, and twenty extracted pages
    // would leave one file holding the twentieth.
    expect(extractFileName('{name}', parts)).toBe('Report 3.pdf');
    expect(extractFileName('{name}.pdf', parts)).toBe('Report 3.pdf');
    expect(extractFileName('***', parts)).toBe('--- 3.pdf');
    expect(extractFileName('', parts)).toBe('3.pdf');
  });

  it('gives distinct names even for a pattern that names neither the page nor the label', () => {
    const names = [1, 2, 3].map((page) => extractFileName('{name}', { ...parts, page }));
    expect(new Set(names).size).toBe(3);
  });

  it('gives different pages different names, which is the whole point', () => {
    const names = [1, 2, 3].map((page) =>
      extractFileName('{name} page {page}', { ...parts, page }),
    );
    expect(new Set(names).size).toBe(3);
  });
});

describe('insertionIndexFor', () => {
  const box = (left: number, top: number): DragCell['rect'] => ({
    left,
    top,
    width: 100,
    height: 120,
  });

  /** A single column of three cells, 100 wide and 120 tall, starting at y = 0. */
  const column: DragCell[] = [0, 1, 2].map((page) => ({ page, rect: box(0, page * 120) }));

  /** Two rows of two, the same size. */
  const grid: DragCell[] = [0, 1, 2, 3].map((page) => ({
    page,
    rect: box((page % 2) * 100, Math.floor(page / 2) * 120),
  }));

  it('answers 0 for an empty grid, so a drop into an empty panel goes to the front', () => {
    expect(insertionIndexFor([], { x: 10, y: 10 }, 0)).toBe(0);
  });

  it('lands before a cell when the pointer is on its left half', () => {
    expect(insertionIndexFor(column, { x: 20, y: 60 }, 3)).toBe(0);
    expect(insertionIndexFor(column, { x: 20, y: 180 }, 3)).toBe(1);
  });

  it('lands after a cell when the pointer is on its right half', () => {
    expect(insertionIndexFor(column, { x: 80, y: 60 }, 3)).toBe(1);
    expect(insertionIndexFor(column, { x: 80, y: 300 }, 3)).toBe(3);
  });

  it('prefers the row the pointer is in over a nearer column in another row', () => {
    // Just inside the second row, far to the right: the answer must be in that row.
    expect(insertionIndexFor(grid, { x: 190, y: 180 }, 4)).toBe(4);
    expect(insertionIndexFor(grid, { x: 10, y: 180 }, 4)).toBe(2);
  });

  it('never answers past the end of the document', () => {
    expect(insertionIndexFor(column, { x: 999, y: 9999 }, 3)).toBe(3);
  });

  it('never answers before the start', () => {
    expect(insertionIndexFor(column, { x: -999, y: -999 }, 3)).toBe(0);
  });

  it('is stable whatever order the cells arrive in', () => {
    const shuffled = [...column].reverse();
    expect(insertionIndexFor(shuffled, { x: 20, y: 180 }, 3)).toBe(
      insertionIndexFor(column, { x: 20, y: 180 }, 3),
    );
  });
});

/**
 * M41's renderer half, without a shell.
 *
 * Three things are worth proving here that the engine tests cannot: the settings reader falls
 * back rather than throwing on a hand-edited file, `RepointDestinationsCommand` undoes itself
 * exactly and survives a journal round-trip, and `runsOf` groups pages the way the page-replacing
 * machinery depends on — get that wrong and straightening pages 1 and 5 of a document quietly
 * reorders it.
 */

import { describe, expect, it } from 'vitest';
import type { ModelId } from '@core/Ids';
import { deserialiseCommand, serialiseCommand } from '@core/Journal';
import { runsOf } from '@modules/M41-merge-split-crop/MergeService';
import { DeletePagesCommand } from '@core/commands';
import {
  DropFieldsCommand,
  MERGE_COMMAND_ID,
  RepointDestinationsCommand,
  fieldsWithoutWidgets,
  registerMergeCodecs,
  repointingsFor,
} from '@modules/M41-merge-split-crop/commands';
import {
  CROP_BOXES,
  DEFAULT_MERGE_SETTINGS,
  MERGE_SETTINGS_SCHEMA,
  memorySettingsStorage,
  readMergeSettings,
  settingKey,
  writeMergeSetting,
} from '@modules/M41-merge-split-crop/settings';
import { ruleFor } from '@modules/M41-merge-split-crop/combineDialog';
import { parseLines } from '@modules/M41-merge-split-crop/splitDialog';
import { must, openFake, RICH_SPEC } from '../core/helpers';

registerMergeCodecs();

describe('the settings reader', () => {
  it('answers the defaults for an empty store', async () => {
    expect(await readMergeSettings(memorySettingsStorage())).toEqual(DEFAULT_MERGE_SETTINGS);
  });

  it('reads what was written, through the keys the schema declares', async () => {
    const storage = memorySettingsStorage();
    await writeMergeSetting(storage, 'cropBox', 'trim');
    await writeMergeSetting(storage, 'splitNamePattern', '{name}-{index}');
    await writeMergeSetting(storage, 'autoDeskewScans', true);
    const settings = await readMergeSettings(storage);
    expect(settings.cropBox).toBe('trim');
    expect(settings.splitNamePattern).toBe('{name}-{index}');
    expect(settings.autoDeskewScans).toBe(true);
  });

  it('falls back rather than throwing on a hand-edited file', async () => {
    const settings = await readMergeSettings(
      memorySettingsStorage({
        'crop.box': 'sideways',
        'crop.marginPoints': -12,
        'split.namePattern': '   ',
        'flatten.annotations': 'yes please',
        'scan.autoDeskew': 3,
      }),
    );
    expect(settings).toEqual(DEFAULT_MERGE_SETTINGS);
  });

  it('declares a default for every setting, under the key it is stored at', () => {
    const properties = MERGE_SETTINGS_SCHEMA.properties;
    expect(Object.keys(properties)).toHaveLength(Object.keys(DEFAULT_MERGE_SETTINGS).length);
    for (const name of Object.keys(DEFAULT_MERGE_SETTINGS) as Array<
      keyof typeof DEFAULT_MERGE_SETTINGS
    >) {
      expect(properties[settingKey(name)]).toBeDefined();
    }
  });

  it("keeps the scanner preference under M130's own name, because M91 reads it", () => {
    expect(settingKey('autoDeskewScans')).toBe('scan.autoDeskew');
  });

  it('names all five boxes in words a reader can act on', () => {
    expect(CROP_BOXES).toHaveLength(5);
    for (const box of CROP_BOXES) expect(box.label).toContain('—');
  });
});

describe('runsOf', () => {
  it('groups consecutive pages and leaves gaps alone', () => {
    expect(runsOf([0, 1, 2, 5, 6])).toEqual([
      [0, 1, 2],
      [5, 6],
    ]);
  });

  it('sorts and de-duplicates first', () => {
    expect(runsOf([5, 0, 1, 1, 6])).toEqual([
      [0, 1],
      [5, 6],
    ]);
  });

  it('answers nothing for nothing', () => {
    expect(runsOf([])).toEqual([]);
  });
});

describe('RepointDestinationsCommand', () => {
  it('aims a destination at a different page and puts it back exactly', async () => {
    const { doc } = await openFake(RICH_SPEC);
    const destination = must(doc.state.destinations[0], 'destination');
    const before = destination.pageId;
    const other = must(doc.state.pages[3], 'page').id;
    expect(before).not.toBe(other);

    const command = new RepointDestinationsCommand(doc, [
      { destinationId: destination.id, pageId: other },
    ]);
    await doc.apply(command);
    expect(doc.destination(destination.id)?.pageId).toBe(other);
    await doc.undoLast();
    expect(doc.destination(destination.id)?.pageId).toBe(before);
  });

  it('is a no-op when the destinations already point there', async () => {
    const { doc } = await openFake(RICH_SPEC);
    const destination = must(doc.state.destinations[0], 'destination');
    const command = new RepointDestinationsCommand(doc, [
      { destinationId: destination.id, pageId: destination.pageId },
    ]);
    expect(command.isNoop).toBe(true);
  });

  it('tells the writer to rebuild both the outline and the name tree', async () => {
    const { doc } = await openFake(RICH_SPEC);
    const command = new RepointDestinationsCommand(doc, []);
    expect([...command.writeIntents].sort()).toEqual(['destinations', 'outline']);
  });

  it('ignores a destination that has gone', async () => {
    const { doc } = await openFake(RICH_SPEC);
    const command = new RepointDestinationsCommand(doc, [
      { destinationId: 'no-such-destination' as ModelId, pageId: null },
    ]);
    await doc.apply(command);
    await doc.undoLast();
    expect(doc.validate()).toEqual([]);
  });

  it('survives the journal: serialised, deserialised, and does the same thing', async () => {
    const { doc } = await openFake(RICH_SPEC);
    const destination = must(doc.state.destinations[0], 'destination');
    const other = must(doc.state.pages[2], 'page').id;
    const json = serialiseCommand(
      new RepointDestinationsCommand(doc, [{ destinationId: destination.id, pageId: other }]),
    );
    expect(json?.type).toBe(MERGE_COMMAND_ID.repointDestinations);
    const replayed = must(deserialiseCommand(doc, must(json)), 'command');
    await doc.apply(replayed);
    expect(doc.destination(destination.id)?.pageId).toBe(other);
  });

  it('refuses a payload that is not a list of repointings', async () => {
    const { doc } = await openFake(RICH_SPEC);
    const entry = (payload: unknown) => ({
      type: MERGE_COMMAND_ID.repointDestinations,
      payload,
    });
    expect(deserialiseCommand(doc, entry({ entries: 'nope' }))).toBeNull();
    expect(deserialiseCommand(doc, entry({ entries: [{ destinationId: 3 }] }))).toBeNull();
  });
});

describe('repointingsFor', () => {
  it('finds the destinations that pointed at a replaced page', async () => {
    const { doc } = await openFake(RICH_SPEC);
    const first = must(doc.state.pages[0], 'page').id;
    const replacement = must(doc.state.pages[3], 'page').id;
    const found = repointingsFor(doc, new Map([[first, replacement]]));
    expect(found.length).toBeGreaterThan(0);
    for (const entry of found) expect(entry.pageId).toBe(replacement);
  });

  it('leaves alone a destination whose page is not being replaced', async () => {
    const { doc } = await openFake(RICH_SPEC);
    expect(repointingsFor(doc, new Map())).toEqual([]);
  });
});

describe('the combine dialog’s page-size rule', () => {
  it('maps the three named choices', () => {
    expect(ruleFor('keep')).toEqual({ kind: 'keep' });
    expect(ruleFor('first')).toEqual({ kind: 'first' });
    expect(ruleFor('largest')).toEqual({ kind: 'largest' });
  });

  it('turns a preset into points', () => {
    const rule = ruleFor('preset:A4');
    expect(rule.kind).toBe('fixed');
    if (rule.kind !== 'fixed') return;
    expect(rule.width).toBeCloseTo(595.28, 1);
    expect(rule.height).toBeCloseTo(841.89, 1);
  });

  it('falls back to "keep" for a preset that is not in the file any more', () => {
    expect(ruleFor('preset:Papyrus')).toEqual({ kind: 'keep' });
    expect(ruleFor('nonsense')).toEqual({ kind: 'keep' });
  });
});

describe('the split dialog’s range lines', () => {
  const context = {
    pageCount: 10,
    currentPage: 0,
    selectedPages: [],
    pageSizes: [],
  };

  it('makes one group per line, in M40’s dialect', () => {
    expect(parseLines('1-3\n5\n8-', context)).toEqual([[0, 1, 2], [4], [7, 8, 9]]);
  });

  it('skips blank lines and lines that do not parse', () => {
    expect(parseLines('1-2\n\n  \nnonsense\n4', context)).toEqual([[0, 1], [3]]);
  });

  it('answers nothing for an empty box', () => {
    expect(parseLines('', context)).toEqual([]);
  });
});

describe('DropFieldsCommand', () => {
  /** Deleting the page a field's widgets are on is what leaves the field with none. */
  async function withEmptyFields(): Promise<{ doc: Awaited<ReturnType<typeof openFake>>['doc'] }> {
    const { doc } = await openFake(RICH_SPEC);
    const firstPage = must(doc.state.pages[0], 'page').id;
    await doc.apply(new DeletePagesCommand(doc, [firstPage]));
    return { doc };
  }

  it('finds the whole branch a flatten emptied, parent included', async () => {
    const { doc } = await withEmptyFields();
    const empty = fieldsWithoutWidgets(doc);
    const names = empty.map((id) => doc.field(id)?.name);
    // `address.city` and `address.postcode` were on the deleted page, so the invented `address`
    // parent is empty too; `agree` is on another page and stays.
    expect(names.sort()).toEqual(['address', 'address.city', 'address.postcode']);
    expect(names).not.toContain('agree');
  });

  it('finds nothing when every field still has a widget', async () => {
    const { doc } = await openFake(RICH_SPEC);
    expect(fieldsWithoutWidgets(doc)).toEqual([]);
  });

  it('removes them, and undo puts them back in the same places', async () => {
    const { doc } = await withEmptyFields();
    const before = doc.state.fields.map((f) => f.name);
    const empty = fieldsWithoutWidgets(doc);
    await doc.apply(new DropFieldsCommand(doc, empty));
    expect(doc.state.fields.map((f) => f.name)).toEqual(['agree']);
    // The parent no longer claims children it has not got.
    for (const field of doc.state.fields) {
      for (const child of field.childIds) expect(doc.field(child)).not.toBeNull();
    }

    await doc.undoLast();
    expect(doc.state.fields.map((f) => f.name)).toEqual(before);
    expect(doc.validate()).toEqual([]);
  });

  it('tells the writer the form changed', async () => {
    const { doc } = await openFake(RICH_SPEC);
    expect([...new DropFieldsCommand(doc, []).writeIntents]).toEqual(['fields']);
  });

  it('is a no-op when the fields have gone already', async () => {
    const { doc } = await openFake(RICH_SPEC);
    expect(new DropFieldsCommand(doc, ['no-such-field' as ModelId]).isNoop).toBe(true);
    expect(new DropFieldsCommand(doc, [must(doc.state.fields[0], 'field').id]).isNoop).toBe(false);
  });

  it('survives the journal', async () => {
    const { doc } = await withEmptyFields();
    const empty = fieldsWithoutWidgets(doc);
    const json = serialiseCommand(new DropFieldsCommand(doc, empty));
    expect(json?.type).toBe(MERGE_COMMAND_ID.dropFields);
    const replayed = must(deserialiseCommand(doc, must(json)), 'command');
    await doc.apply(replayed);
    expect(doc.state.fields.map((f) => f.name)).toEqual(['agree']);
  });

  it('refuses a payload that is not a list of ids', async () => {
    const { doc } = await openFake(RICH_SPEC);
    expect(
      deserialiseCommand(doc, { type: MERGE_COMMAND_ID.dropFields, payload: { fieldIds: 3 } }),
    ).toBeNull();
  });
});

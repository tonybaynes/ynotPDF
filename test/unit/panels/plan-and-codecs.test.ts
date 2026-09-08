/**
 * What M12 hands to M21 (ADR 0011), and what its journal can rebuild.
 *
 * Two halves that only meet at a save: the write plan has to name the destinations and the
 * embedded files the session changed, and every command has to come back from a payload — or say
 * clearly that it cannot, rather than replaying as something else.
 */

import { describe, expect, it } from 'vitest';
import { deserialiseCommand, type JournalEntry } from '@core/Journal';
import type { ModelId } from '@core/Ids';
import { buildWritePlan } from '@modules/M21-save/plan';
import {
  AddAttachmentCommand,
  AddBookmarkCommand,
  AddDestinationCommand,
  DeleteAttachmentCommand,
  DescribeAttachmentCommand,
  NAV_COMMAND_ID,
  RenameBookmarkCommand,
  RenameDestinationCommand,
  registerNavigationCodecs,
} from '@modules/M12-navigation-panels/commands';
import { ipcSettingsStorage } from '@modules/M12-navigation-panels/settings';
import { openFake, RICH_SPEC } from '../core/helpers';

registerNavigationCodecs();

describe('the write plan', () => {
  it('says nothing about destinations or attachments in a document nobody touched', async () => {
    const { doc } = await openFake(RICH_SPEC);
    const { plan } = buildWritePlan(doc);
    expect(plan.namedDestinations).toBeNull();
    expect(plan.attachments).toBeNull();
  });

  it('plans the name tree once a destination has been edited', async () => {
    const { doc } = await openFake(RICH_SPEC);
    await doc.apply(
      new AddDestinationCommand(doc, {
        name: 'chapter-two',
        destination: {
          pageId: doc.state.pages[1]?.id ?? null,
          fit: 'xyz',
          left: 0,
          top: 500,
          zoom: 1,
          rect: null,
        },
      }),
    );
    const { plan } = buildWritePlan(doc);
    expect(plan.namedDestinations).not.toBeNull();
    const names = (plan.namedDestinations ?? []).map((d) => d.name);
    // Every *named* destination is written, not only the new one: the section replaces the tree.
    expect(names).toContain('chapter-two');
    expect(names).toContain('top');
    const added = (plan.namedDestinations ?? []).find((d) => d.name === 'chapter-two');
    expect(added?.dest).toMatchObject({ page: 1, fit: 'xyz', top: 500 });
  });

  it('drops a destination whose page has gone rather than writing a dangling one', async () => {
    const { doc } = await openFake(RICH_SPEC);
    const page = doc.state.pages[1];
    if (!page) throw new Error('no page');
    await doc.apply(
      new AddDestinationCommand(doc, {
        name: 'doomed',
        destination: { pageId: page.id, fit: 'fit', left: null, top: null, zoom: null, rect: null },
      }),
    );
    // Take the page out from under it.
    doc.removePageRecord(page.id);
    const { plan } = buildWritePlan(doc);
    expect((plan.namedDestinations ?? []).map((d) => d.name)).not.toContain('doomed');
  });

  it('plans the embedded files once one has been added or described', async () => {
    const { doc } = await openFake(RICH_SPEC);
    const add = new AddAttachmentCommand(doc, {
      name: 'note.txt',
      bytes: new TextEncoder().encode('hello'),
      description: 'A note',
      mimeType: 'text/plain',
    });
    await doc.apply(add);
    const { plan } = buildWritePlan(doc);
    expect(plan.attachments).not.toBeNull();
    const planned = (plan.attachments ?? []).find((a) => a.name === 'note.txt');
    expect(planned).toEqual({ name: 'note.txt', description: 'A note', mimeType: 'text/plain' });
  });

  it('plans a cleared description as a removal, not as an absence', async () => {
    const { doc } = await openFake(RICH_SPEC);
    const attachment = doc.state.attachments[0];
    if (!attachment) throw new Error('no attachment');
    await doc.apply(new DescribeAttachmentCommand(doc, attachment.id, ''));
    const { plan } = buildWritePlan(doc);
    const planned = (plan.attachments ?? []).find((a) => a.name === attachment.name);
    expect(planned?.description).toBeNull();
  });

  it('leaves attachment annotations alone — they are M31’s', async () => {
    const { doc } = await openFake({
      ...RICH_SPEC,
      attachments: [
        { id: 'att.0', name: 'embedded.bin', size: 1 },
        { id: 'annot.0.0', name: 'on-a-page.bin', size: 2, page: 0 },
      ],
    });
    await doc.apply(new AddAttachmentCommand(doc, { name: 'new.bin', bytes: new Uint8Array([1]) }));
    const { plan } = buildWritePlan(doc);
    expect((plan.attachments ?? []).map((a) => a.name)).not.toContain('on-a-page.bin');
  });
});

describe('the journal codecs', () => {
  it('rebuild a command from its own payload', async () => {
    const { doc } = await openFake(RICH_SPEC);
    const chapter = doc.state.outline[0];
    if (!chapter) throw new Error('no outline');
    const commands = [
      new AddBookmarkCommand(doc, { title: 'A', at: { parentId: null, index: 0 } }),
      new RenameBookmarkCommand(doc, chapter.id, 'B'),
      new AddDestinationCommand(doc, {
        name: 'x',
        destination: { pageId: null, fit: 'fit', left: null, top: null, zoom: null, rect: null },
      }),
      new RenameDestinationCommand(doc, doc.state.destinations[0]?.id ?? ('' as ModelId), 'y'),
      new AddAttachmentCommand(doc, { name: 'a.bin', bytes: new Uint8Array([1, 2]) }),
      new DeleteAttachmentCommand(doc, doc.state.attachments[0]?.id ?? ('' as ModelId)),
    ];
    for (const command of commands) {
      const json = command.toJSON();
      const entry: JournalEntry = { type: json.id, payload: JSON.parse(JSON.stringify(json.data)) };
      const rebuilt = deserialiseCommand(doc, entry);
      expect(rebuilt, `${json.id} should rebuild`).not.toBeNull();
      expect(rebuilt?.id).toBe(command.id);
    }
  });

  it('refuse a payload that is not one of theirs, instead of guessing', () => {
    const doc = null as never;
    for (const type of Object.values(NAV_COMMAND_ID)) {
      expect(deserialiseCommand(doc, { type, payload: 'nonsense' })).toBeNull();
      expect(deserialiseCommand(doc, { type, payload: {} })).toBeNull();
    }
  });

  it('a bookmark add replays with the ids it minted, not with fresh ones', async () => {
    const { doc } = await openFake(RICH_SPEC);
    const add = new AddBookmarkCommand(doc, {
      title: 'Anchored',
      at: { parentId: null, index: 0 },
      destination: {
        pageId: doc.state.pages[0]?.id ?? null,
        fit: 'fit',
        left: null,
        top: null,
        zoom: null,
        rect: null,
      },
    });
    const json = add.toJSON();
    const { doc: fresh } = await openFake(RICH_SPEC);
    const rebuilt = deserialiseCommand(fresh, {
      type: json.id,
      payload: JSON.parse(JSON.stringify(json.data)),
    });
    await fresh.apply(rebuilt ?? add);
    expect(fresh.outlineItem(add.newId)?.title).toBe('Anchored');
  });
});

describe('merging', () => {
  it('two renames of the same bookmark merge; two of different ones do not', async () => {
    const { doc } = await openFake(RICH_SPEC);
    const [first, second] = doc.state.outline;
    if (!first || !second) throw new Error('no outline');
    const a = new RenameBookmarkCommand(doc, first.id, 'One');
    await doc.apply(a);
    expect(a.merge(new RenameBookmarkCommand(doc, first.id, 'Two'))).not.toBeNull();
    expect(a.merge(new RenameBookmarkCommand(doc, second.id, 'Two'))).toBeNull();
    expect(
      a.merge(
        new AddDestinationCommand(doc, {
          name: 'n',
          destination: { pageId: null, fit: 'fit', left: null, top: null, zoom: null, rect: null },
        }),
      ),
    ).toBeNull();
  });

  it('the same for destination names and attachment descriptions', async () => {
    const { doc } = await openFake(RICH_SPEC);
    const dest = doc.state.destinations[0];
    const attachment = doc.state.attachments[0];
    if (!dest || !attachment) throw new Error('fixture');
    const rename = new RenameDestinationCommand(doc, dest.id, 'a');
    await doc.apply(rename);
    expect(rename.merge(new RenameDestinationCommand(doc, dest.id, 'b'))).not.toBeNull();
    const describe_ = new DescribeAttachmentCommand(doc, attachment.id, 'a');
    await doc.apply(describe_);
    expect(describe_.merge(new DescribeAttachmentCommand(doc, attachment.id, 'b'))).not.toBeNull();
    expect(describe_.merge(rename)).toBeNull();
  });
});

describe('settings storage outside Electron', () => {
  it('reads undefined and writes nothing when there is no bridge', async () => {
    const storage = ipcSettingsStorage();
    expect(await storage.get('ui.leftPaneOnOpen')).toBeUndefined();
    await expect(storage.set('ui.leftPaneOnOpen', 'pages')).resolves.toBeUndefined();
  });
});

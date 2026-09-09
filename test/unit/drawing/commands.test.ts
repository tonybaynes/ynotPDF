/**
 * `AttachFileCommand` (M31) against the fake engine: the file goes into the document pinned to
 * a page, undo takes it out, the journal replays it, and `Document.rebindAttachments` keeps a
 * page-pinned file in step with its name-tree neighbours (ADR 0015 §5).
 */

import { describe, expect, it } from 'vitest';
import { deserialiseCommand, serialiseCommand } from '@core/Journal';
import {
  AttachFileCommand,
  ATTACH_FILE_COMMAND_ID,
  registerDrawingCodecs,
} from '@modules/M31-shapes-ink-stamps/commands';
import {
  AddAttachmentCommand,
  DeleteAttachmentCommand,
  registerNavigationCodecs,
} from '@modules/M12-navigation-panels/commands';
import { must, openFake, pageIds } from '../core/helpers';

const BYTES = new Uint8Array([1, 2, 3, 4]);

describe('attaching a file to a page', () => {
  it('embeds the file, pins the record to the page, and undoes cleanly', async () => {
    const { doc, engine } = await openFake();
    const [pageId] = pageIds(doc);
    const before = doc.state.attachments.length;
    const command = new AttachFileCommand(doc, must(pageId), {
      name: 'notes.txt',
      bytes: BYTES,
      description: 'my notes',
      mimeType: 'text/plain',
    });
    await doc.apply(command);
    const record = must(doc.attachment(command.newId), 'record');
    expect(record.pageId).toBe(pageId);
    expect(record.name).toBe('notes.txt');
    expect(record.engineId.startsWith('att.')).toBe(true);
    expect(doc.state.attachments.length).toBe(before + 1);
    expect(command.writeIntents).toContain('attachments');
    expect(command.writeIntents).toContain('annotations');
    expect(await engine.attachmentData(doc.handle, record.engineId)).toEqual(BYTES);

    await doc.undoLast();
    expect(doc.attachment(command.newId)).toBeNull();
    expect(doc.state.attachments.length).toBe(before);
    await doc.redoLast();
    expect(doc.attachment(command.newId)?.pageId).toBe(pageId);
  });

  it('serialises to JSON and replays through its codec with the same id', async () => {
    registerDrawingCodecs();
    registerDrawingCodecs();
    const { doc } = await openFake();
    const [pageId] = pageIds(doc);
    const command = new AttachFileCommand(doc, must(pageId), { name: 'a.bin', bytes: BYTES });
    const entry = serialiseCommand(command);
    expect(entry.type).toBe(ATTACH_FILE_COMMAND_ID);
    const replayed = deserialiseCommand(doc, entry);
    expect(replayed).toBeInstanceOf(AttachFileCommand);
    expect((replayed as AttachFileCommand).newId).toBe(command.newId);
    expect(deserialiseCommand(doc, { ...entry, payload: { name: 'x' } })).toBeNull();
  });

  it('keeps a page-pinned file in step when a neighbour in the name tree goes', async () => {
    registerNavigationCodecs();
    const { doc } = await openFake();
    const [pageId] = pageIds(doc);
    // Two files: one plain, then one pinned to a page. The engine sorts the tree by name.
    const plain = new AddAttachmentCommand(doc, { name: 'a-first.txt', bytes: BYTES });
    await doc.apply(plain);
    const pinned = new AttachFileCommand(doc, must(pageId), { name: 'b-second.txt', bytes: BYTES });
    await doc.apply(pinned);
    const pinnedKey = must(doc.attachment(pinned.newId), 'pinned').engineId;
    await doc.apply(new DeleteAttachmentCommand(doc, plain.newId));
    const after = must(doc.attachment(pinned.newId), 'pinned after');
    // Its neighbour before it went, so its key moved down — and the record followed it.
    expect(after.engineId).not.toBe(pinnedKey);
    expect(after.engineId).toBe(doc.idTable.engineKey('attachment', pinned.newId));
    expect(after.pageId).toBe(pageId);
  });
});

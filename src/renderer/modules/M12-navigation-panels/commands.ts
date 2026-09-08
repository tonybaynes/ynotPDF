/**
 * The document commands of M12: bookmarks, named destinations and embedded files.
 *
 * The rules are M20's (`src/renderer/core/commands.ts`): mutate the model first, offer the
 * change to the engine, record a {@link WriteIntent} for whatever the engine cannot express, and
 * describe yourself as plain data so the journal can replay you.
 *
 * Which is which here:
 *
 * - **Bookmarks and destinations are model-only.** PDFium has no writer for `/Outlines` or
 *   `/Names /Dests`, so every edit records its intent and M21's writer rebuilds the tree on save.
 * - **Attachments are engine-backed** (ADR 0011). PDFium can embed, re-describe and remove a
 *   file, so undo puts the bytes back exactly; the `attachments` intent is still recorded,
 *   because the description and the MIME type land in `/Params` and only the writer can move
 *   them to where a reader looks.
 */

import type { Command, CommandJson } from '@core/Command';
import type { Document, DocumentCommand } from '@core/Document';
import type { ModelId } from '@core/Ids';
import { registerCommandCodec } from '@core/Journal';
import type { ModelAttachment, ModelDestination, ModelOutlineItem, WriteIntent } from '@core/model';
import type { PdfRect } from '@shared/pdf';
import type { Destination } from '@engine/PdfEngine';
import { EngineError } from '@engine/PdfEngine';
import {
  insert,
  move,
  positionOf,
  removeSubtree,
  restoreSubtree,
  update,
  type Position,
} from './bookmarks/tree';

/** Command ids, so the journal, the palette and the tests all name the same thing. */
export const NAV_COMMAND_ID = {
  addBookmark: 'bookmark.add',
  renameBookmark: 'bookmark.rename',
  deleteBookmark: 'bookmark.delete',
  moveBookmark: 'bookmark.move',
  setBookmarkTarget: 'bookmark.setTarget',
  setBookmarkStyle: 'bookmark.setStyle',
  addDestination: 'destination.add',
  renameDestination: 'destination.rename',
  setDestination: 'destination.set',
  deleteDestination: 'destination.delete',
  addAttachment: 'attachment.add',
  deleteAttachment: 'attachment.delete',
  describeAttachment: 'attachment.describe',
} as const;

/** The geometry half of a destination — everything but its identity. */
export interface DestinationSpec {
  readonly pageId: ModelId | null;
  readonly fit: Destination['fit'];
  readonly left: number | null;
  readonly top: number | null;
  readonly zoom: number | null;
  readonly rect: PdfRect | null;
}

/** Base class: the M20 shape, minus the engine plumbing the model-only commands never use. */
abstract class NavCommand implements DocumentCommand {
  abstract readonly id: string;
  abstract readonly label: string;
  protected readonly doc: Document;
  private intents: WriteIntent[] = [];

  constructor(doc: Document) {
    this.doc = doc;
  }

  get writeIntents(): ReadonlyArray<WriteIntent> {
    return this.intents;
  }

  protected intend(...intents: WriteIntent[]): void {
    for (const i of intents) if (!this.intents.includes(i)) this.intents.push(i);
  }

  protected adoptIntents(intents: ReadonlyArray<WriteIntent>): void {
    this.intents = [...intents];
  }

  abstract do(): Promise<void>;
  abstract undo(): Promise<void>;
  abstract toJSON(): CommandJson;
}

// ---- bookmarks ---------------------------------------------------------------------------------

/**
 * Adds a bookmark, optionally with a destination of its own.
 *
 * The ids it mints are in `toJSON`, so a replay from the journal produces the *same* ids — the
 * bug M20 found the hard way with page inserts: a later entry naming the new bookmark would
 * otherwise silently do nothing.
 */
export class AddBookmarkCommand extends NavCommand {
  readonly id = NAV_COMMAND_ID.addBookmark;
  readonly label = 'Add bookmark';
  private readonly title: string;
  private readonly at: Position;
  private readonly target: DestinationSpec | null;
  private readonly uri: string | null;
  private readonly bookmarkId: ModelId;
  private readonly destinationId: ModelId | null;

  constructor(
    doc: Document,
    options: {
      readonly title: string;
      readonly at: Position;
      readonly destination?: DestinationSpec | null;
      readonly uri?: string | null;
      /** Reserved ids, for a journal replay. */
      readonly bookmarkId?: ModelId;
      readonly destinationId?: ModelId;
    },
  ) {
    super(doc);
    this.title = options.title;
    this.at = options.at;
    this.target = options.destination ?? null;
    this.uri = options.uri ?? null;
    this.bookmarkId = options.bookmarkId ?? doc.ids.next('outline');
    this.destinationId =
      this.target === null ? null : (options.destinationId ?? doc.ids.next('destination'));
  }

  /** The id the new bookmark has, so the panel can select it. */
  get newId(): ModelId {
    return this.bookmarkId;
  }

  do(): Promise<void> {
    if (this.target !== null && this.destinationId !== null) {
      this.doc.putDestinationRecord({
        id: this.destinationId,
        name: null,
        pageId: this.target.pageId,
        fit: this.target.fit,
        left: this.target.left,
        top: this.target.top,
        zoom: this.target.zoom,
        rect: this.target.rect,
      });
    }
    const item: ModelOutlineItem = {
      id: this.bookmarkId,
      title: this.title,
      parentId: this.at.parentId,
      childIds: [],
      destinationId: this.destinationId,
      uri: this.uri,
      open: true,
      bold: false,
      italic: false,
      color: null,
    };
    this.doc.setOutlineRecord(insert(this.doc.state.outline, item, this.at));
    this.intend('outline');
    return Promise.resolve();
  }

  undo(): Promise<void> {
    this.doc.setOutlineRecord(removeSubtree(this.doc.state.outline, this.bookmarkId).list);
    if (this.destinationId !== null) this.doc.removeDestinationRecord(this.destinationId);
    return Promise.resolve();
  }

  toJSON(): CommandJson {
    return {
      id: this.id,
      data: {
        title: this.title,
        at: this.at,
        destination: this.target,
        uri: this.uri,
        bookmarkId: this.bookmarkId,
        destinationId: this.destinationId,
      },
    };
  }
}

/** Renames a bookmark. Consecutive renames of the same one merge into a single undo step. */
export class RenameBookmarkCommand extends NavCommand {
  readonly id = NAV_COMMAND_ID.renameBookmark;
  readonly label = 'Rename bookmark';
  private readonly bookmarkId: ModelId;
  private title: string;
  private before = '';

  constructor(doc: Document, bookmarkId: ModelId, title: string) {
    super(doc);
    this.bookmarkId = bookmarkId;
    this.title = title;
  }

  do(): Promise<void> {
    this.before = this.doc.outlineItem(this.bookmarkId)?.title ?? '';
    this.write(this.title);
    return Promise.resolve();
  }

  undo(): Promise<void> {
    this.write(this.before);
    return Promise.resolve();
  }

  merge(next: Command): Command | null {
    if (!(next instanceof RenameBookmarkCommand) || next.bookmarkId !== this.bookmarkId) {
      return null;
    }
    const merged = new RenameBookmarkCommand(this.doc, this.bookmarkId, next.title);
    merged.before = this.before;
    // A merged command's `do()` never runs, so it has to adopt what the two it replaces earned.
    merged.adoptIntents([...this.writeIntents, ...next.writeIntents, 'outline']);
    return merged;
  }

  private write(title: string): void {
    this.title = title;
    this.doc.setOutlineRecord(update(this.doc.state.outline, this.bookmarkId, { title }));
    this.intend('outline');
  }

  toJSON(): CommandJson {
    return { id: this.id, data: { bookmarkId: this.bookmarkId, title: this.title } };
  }
}

/** Deletes a bookmark and everything under it; undo puts the whole subtree back where it was. */
export class DeleteBookmarkCommand extends NavCommand {
  readonly id = NAV_COMMAND_ID.deleteBookmark;
  readonly label: string;
  private readonly bookmarkId: ModelId;
  private removed: ReadonlyArray<ModelOutlineItem> = [];
  private at: Position = { parentId: null, index: 0 };
  private destinations: Array<{ destination: ModelDestination; index: number }> = [];

  constructor(doc: Document, bookmarkId: ModelId) {
    super(doc);
    this.bookmarkId = bookmarkId;
    const count = removeSubtree(doc.state.outline, bookmarkId).removed.length;
    this.label = count > 1 ? `Delete ${String(count)} bookmarks` : 'Delete bookmark';
  }

  do(): Promise<void> {
    const result = removeSubtree(this.doc.state.outline, this.bookmarkId);
    if (result.removed.length === 0) return Promise.resolve();
    this.removed = result.removed;
    this.at = result.at;
    // A bookmark's own (unnamed) destination goes with it; a named one is shared with the
    // Destinations panel and stays.
    this.destinations = [];
    for (const item of result.removed) {
      if (item.destinationId === null) continue;
      const dest = this.doc.destination(item.destinationId);
      if (dest?.name === null) {
        const removed = this.doc.removeDestinationRecord(dest.id);
        if (removed) this.destinations.push(removed);
      }
    }
    this.doc.setOutlineRecord(result.list);
    this.intend('outline');
    return Promise.resolve();
  }

  undo(): Promise<void> {
    // Back in their own places, so a snapshot of the whole model compares equal to the original.
    for (const { destination, index } of [...this.destinations].reverse()) {
      this.doc.putDestinationRecord(destination, index);
    }
    this.doc.setOutlineRecord(restoreSubtree(this.doc.state.outline, this.removed, this.at));
    return Promise.resolve();
  }

  toJSON(): CommandJson {
    return { id: this.id, data: { bookmarkId: this.bookmarkId } };
  }
}

/** Moves a bookmark: reorder, nest, un-nest and drag are all this one command. */
export class MoveBookmarkCommand extends NavCommand {
  readonly id = NAV_COMMAND_ID.moveBookmark;
  readonly label: string;
  private readonly bookmarkId: ModelId;
  private readonly to: Position;
  private from: Position = { parentId: null, index: 0 };

  constructor(doc: Document, bookmarkId: ModelId, to: Position, label = 'Move bookmark') {
    super(doc);
    this.bookmarkId = bookmarkId;
    this.to = to;
    this.label = label;
  }

  do(): Promise<void> {
    this.from = positionOf(this.doc.state.outline, this.bookmarkId) ?? this.from;
    this.doc.setOutlineRecord(move(this.doc.state.outline, this.bookmarkId, this.to));
    this.intend('outline');
    return Promise.resolve();
  }

  undo(): Promise<void> {
    this.doc.setOutlineRecord(move(this.doc.state.outline, this.bookmarkId, this.from));
    return Promise.resolve();
  }

  toJSON(): CommandJson {
    return {
      id: this.id,
      data: { bookmarkId: this.bookmarkId, to: this.to, label: this.label },
    };
  }
}

/** Points a bookmark at a destination or a URI ("set destination to current view", actions). */
export class SetBookmarkTargetCommand extends NavCommand {
  readonly id = NAV_COMMAND_ID.setBookmarkTarget;
  readonly label: string;
  private readonly bookmarkId: ModelId;
  private readonly target: DestinationSpec | null;
  private readonly uri: string | null;
  private readonly destinationId: ModelId;
  private before: {
    destinationId: ModelId | null;
    uri: string | null;
    destination: ModelDestination | null;
  } | null = null;

  constructor(
    doc: Document,
    bookmarkId: ModelId,
    options: {
      readonly destination?: DestinationSpec | null;
      readonly uri?: string | null;
      readonly label?: string;
      readonly destinationId?: ModelId;
    },
  ) {
    super(doc);
    this.bookmarkId = bookmarkId;
    this.target = options.destination ?? null;
    this.uri = options.uri ?? null;
    this.label =
      options.label ?? (this.uri === null ? 'Set bookmark destination' : 'Set bookmark action');
    this.destinationId = options.destinationId ?? doc.ids.next('destination');
  }

  do(): Promise<void> {
    const item = this.doc.outlineItem(this.bookmarkId);
    if (!item) return Promise.resolve();
    const existing = item.destinationId === null ? null : this.doc.destination(item.destinationId);
    this.before = {
      destinationId: item.destinationId,
      uri: item.uri,
      destination: existing,
    };
    // A bookmark's own destination is replaced in place; a *named* one is shared, so a new
    // unnamed destination is minted rather than editing the entry the panel also lists.
    let destinationId: ModelId | null = null;
    if (this.target !== null) {
      const reuse = existing !== null && existing.name === null;
      destinationId = reuse ? existing.id : this.destinationId;
      this.doc.putDestinationRecord({
        id: destinationId,
        name: null,
        pageId: this.target.pageId,
        fit: this.target.fit,
        left: this.target.left,
        top: this.target.top,
        zoom: this.target.zoom,
        rect: this.target.rect,
      });
    } else if (existing !== null && existing.name === null) {
      this.doc.removeDestinationRecord(existing.id);
    }
    this.doc.setOutlineRecord(
      update(this.doc.state.outline, this.bookmarkId, { destinationId, uri: this.uri }),
    );
    this.intend('outline');
    return Promise.resolve();
  }

  undo(): Promise<void> {
    const before = this.before;
    if (!before) return Promise.resolve();
    const item = this.doc.outlineItem(this.bookmarkId);
    if (item?.destinationId != null && this.doc.destination(item.destinationId)?.name === null) {
      this.doc.removeDestinationRecord(item.destinationId);
    }
    if (before.destination) this.doc.putDestinationRecord(before.destination);
    this.doc.setOutlineRecord(
      update(this.doc.state.outline, this.bookmarkId, {
        destinationId: before.destinationId,
        uri: before.uri,
      }),
    );
    return Promise.resolve();
  }

  toJSON(): CommandJson {
    return {
      id: this.id,
      data: {
        bookmarkId: this.bookmarkId,
        destination: this.target,
        uri: this.uri,
        label: this.label,
        destinationId: this.destinationId,
      },
    };
  }
}

/** Colour, bold and italic — the three things a PDF lets a bookmark say about itself. */
export class SetBookmarkStyleCommand extends NavCommand {
  readonly id = NAV_COMMAND_ID.setBookmarkStyle;
  readonly label = 'Change bookmark style';
  private readonly bookmarkId: ModelId;
  private readonly style: {
    readonly bold?: boolean;
    readonly italic?: boolean;
    readonly color?: number | null;
  };
  private before: { bold: boolean; italic: boolean; color: number | null } | null = null;

  constructor(
    doc: Document,
    bookmarkId: ModelId,
    style: { readonly bold?: boolean; readonly italic?: boolean; readonly color?: number | null },
  ) {
    super(doc);
    this.bookmarkId = bookmarkId;
    this.style = style;
  }

  do(): Promise<void> {
    const item = this.doc.outlineItem(this.bookmarkId);
    if (!item) return Promise.resolve();
    this.before = { bold: item.bold, italic: item.italic, color: item.color };
    this.doc.setOutlineRecord(update(this.doc.state.outline, this.bookmarkId, this.style));
    this.intend('outline');
    return Promise.resolve();
  }

  undo(): Promise<void> {
    if (!this.before) return Promise.resolve();
    this.doc.setOutlineRecord(update(this.doc.state.outline, this.bookmarkId, this.before));
    return Promise.resolve();
  }

  toJSON(): CommandJson {
    return { id: this.id, data: { bookmarkId: this.bookmarkId, style: this.style } };
  }
}

// ---- named destinations ------------------------------------------------------------------------

export class AddDestinationCommand extends NavCommand {
  readonly id = NAV_COMMAND_ID.addDestination;
  readonly label = 'Add destination';
  private readonly name: string;
  private readonly spec: DestinationSpec;
  private readonly destinationId: ModelId;

  constructor(
    doc: Document,
    options: {
      readonly name: string;
      readonly destination: DestinationSpec;
      readonly destinationId?: ModelId;
    },
  ) {
    super(doc);
    this.name = options.name;
    this.spec = options.destination;
    this.destinationId = options.destinationId ?? doc.ids.next('destination');
  }

  get newId(): ModelId {
    return this.destinationId;
  }

  do(): Promise<void> {
    this.doc.putDestinationRecord({
      id: this.destinationId,
      name: this.name,
      pageId: this.spec.pageId,
      fit: this.spec.fit,
      left: this.spec.left,
      top: this.spec.top,
      zoom: this.spec.zoom,
      rect: this.spec.rect,
    });
    this.intend('destinations');
    return Promise.resolve();
  }

  undo(): Promise<void> {
    this.doc.removeDestinationRecord(this.destinationId);
    return Promise.resolve();
  }

  toJSON(): CommandJson {
    return {
      id: this.id,
      data: { name: this.name, destination: this.spec, destinationId: this.destinationId },
    };
  }
}

export class RenameDestinationCommand extends NavCommand {
  readonly id = NAV_COMMAND_ID.renameDestination;
  readonly label = 'Rename destination';
  private readonly destinationId: ModelId;
  private name: string;
  private before = '';

  constructor(doc: Document, destinationId: ModelId, name: string) {
    super(doc);
    this.destinationId = destinationId;
    this.name = name;
  }

  do(): Promise<void> {
    this.before = this.doc.destination(this.destinationId)?.name ?? '';
    this.write(this.name);
    return Promise.resolve();
  }

  undo(): Promise<void> {
    this.write(this.before);
    return Promise.resolve();
  }

  merge(next: Command): Command | null {
    if (!(next instanceof RenameDestinationCommand) || next.destinationId !== this.destinationId) {
      return null;
    }
    const merged = new RenameDestinationCommand(this.doc, this.destinationId, next.name);
    merged.before = this.before;
    merged.adoptIntents([...this.writeIntents, ...next.writeIntents, 'destinations']);
    return merged;
  }

  private write(name: string): void {
    this.name = name;
    const dest = this.doc.destination(this.destinationId);
    if (dest) this.doc.putDestinationRecord({ ...dest, name });
    this.intend('destinations');
  }

  toJSON(): CommandJson {
    return { id: this.id, data: { destinationId: this.destinationId, name: this.name } };
  }
}

/** Re-aims a named destination — "set to current view". */
export class SetDestinationCommand extends NavCommand {
  readonly id = NAV_COMMAND_ID.setDestination;
  readonly label = 'Set destination to this view';
  private readonly destinationId: ModelId;
  private readonly spec: DestinationSpec;
  private before: ModelDestination | null = null;

  constructor(doc: Document, destinationId: ModelId, destination: DestinationSpec) {
    super(doc);
    this.destinationId = destinationId;
    this.spec = destination;
  }

  do(): Promise<void> {
    const dest = this.doc.destination(this.destinationId);
    if (!dest) return Promise.resolve();
    this.before = dest;
    this.doc.putDestinationRecord({ ...dest, ...this.spec });
    this.intend('destinations');
    return Promise.resolve();
  }

  undo(): Promise<void> {
    if (this.before) this.doc.putDestinationRecord(this.before);
    return Promise.resolve();
  }

  toJSON(): CommandJson {
    return {
      id: this.id,
      data: { destinationId: this.destinationId, destination: this.spec },
    };
  }
}

export class DeleteDestinationCommand extends NavCommand {
  readonly id = NAV_COMMAND_ID.deleteDestination;
  readonly label = 'Delete destination';
  private readonly destinationId: ModelId;
  private removed: { destination: ModelDestination; index: number } | null = null;

  constructor(doc: Document, destinationId: ModelId) {
    super(doc);
    this.destinationId = destinationId;
  }

  do(): Promise<void> {
    this.removed = this.doc.removeDestinationRecord(this.destinationId);
    this.intend('destinations');
    return Promise.resolve();
  }

  undo(): Promise<void> {
    if (this.removed) this.doc.putDestinationRecord(this.removed.destination, this.removed.index);
    return Promise.resolve();
  }

  toJSON(): CommandJson {
    return { id: this.id, data: { destinationId: this.destinationId } };
  }
}

// ---- attachments (engine-backed) -----------------------------------------------------------------

/** Engine keys of the embedded files, in order — what `Document.rebindAttachments` needs. */
async function engineAttachmentIds(doc: Document): Promise<string[]> {
  const list = await doc.engine.attachments(doc.handle);
  return list.filter((a) => a.page === undefined).map((a) => a.id);
}

/** True when an engine rejection means "this backend cannot do that". */
function isUnsupported(error: unknown): boolean {
  return error instanceof EngineError && error.code === 'not-implemented';
}

export class AddAttachmentCommand extends NavCommand {
  readonly id = NAV_COMMAND_ID.addAttachment;
  readonly label: string;
  private readonly file: {
    readonly name: string;
    readonly bytes: Uint8Array;
    readonly description: string | null;
    readonly mimeType: string | null;
  };
  private readonly attachmentId: ModelId;

  constructor(
    doc: Document,
    file: {
      readonly name: string;
      readonly bytes: Uint8Array;
      readonly description?: string | null;
      readonly mimeType?: string | null;
    },
    attachmentId?: ModelId,
  ) {
    super(doc);
    this.file = {
      name: file.name,
      bytes: file.bytes,
      description: file.description ?? null,
      mimeType: file.mimeType ?? null,
    };
    this.label = `Attach ${file.name}`;
    this.attachmentId = attachmentId ?? doc.ids.next('attachment');
  }

  get newId(): ModelId {
    return this.attachmentId;
  }

  async do(): Promise<void> {
    const added = await this.doc.engine.addAttachment(this.doc.handle, {
      name: this.file.name,
      bytes: this.file.bytes,
      ...(this.file.description === null ? {} : { description: this.file.description }),
      ...(this.file.mimeType === null ? {} : { mimeType: this.file.mimeType }),
      modified: new Date().toISOString(),
    });
    const record: ModelAttachment = {
      id: this.attachmentId,
      engineId: added.id,
      name: added.name,
      description: added.description ?? this.file.description,
      mimeType: added.mimeType ?? this.file.mimeType,
      size: added.size ?? this.file.bytes.length,
      modified: added.modified ?? null,
      created: added.created ?? null,
      collectionFields: added.collectionFields ?? {},
      pageId: null,
    };
    this.doc.putAttachmentRecord(record);
    this.doc.idTable.bind('attachment', this.attachmentId, added.id);
    this.doc.rebindAttachments(await engineAttachmentIds(this.doc));
    this.intend('attachments');
  }

  async undo(): Promise<void> {
    const record = this.doc.attachment(this.attachmentId);
    if (record) {
      try {
        await this.doc.engine.deleteAttachment(this.doc.handle, record.engineId);
      } catch (error) {
        if (!isUnsupported(error)) throw error;
      }
      this.doc.removeAttachmentRecord(this.attachmentId);
      this.doc.rebindAttachments(await engineAttachmentIds(this.doc));
    }
  }

  toJSON(): CommandJson {
    // The bytes travel as an array of numbers: a journal entry has to be JSON, and a recovery
    // that could not restore an attached file would be a recovery that lost work.
    return {
      id: this.id,
      data: {
        name: this.file.name,
        bytes: Array.from(this.file.bytes),
        description: this.file.description,
        mimeType: this.file.mimeType,
        attachmentId: this.attachmentId,
      },
    };
  }
}

export class DeleteAttachmentCommand extends NavCommand {
  readonly id = NAV_COMMAND_ID.deleteAttachment;
  readonly label: string;
  private readonly attachmentId: ModelId;
  private removed: { attachment: ModelAttachment; index: number } | null = null;
  private bytes: Uint8Array | null = null;

  constructor(doc: Document, attachmentId: ModelId) {
    super(doc);
    this.attachmentId = attachmentId;
    this.label = `Delete ${doc.attachment(attachmentId)?.name ?? 'attachment'}`;
  }

  async do(): Promise<void> {
    const record = this.doc.attachment(this.attachmentId);
    if (!record) return;
    // The bytes are read *before* the delete: they are the only copy, and undo needs them.
    this.bytes = await this.doc.engine
      .attachmentData(this.doc.handle, record.engineId)
      .catch(() => new Uint8Array(0));
    await this.doc.engine.deleteAttachment(this.doc.handle, record.engineId);
    this.removed = this.doc.removeAttachmentRecord(this.attachmentId);
    this.doc.rebindAttachments(await engineAttachmentIds(this.doc));
    this.intend('attachments');
  }

  async undo(): Promise<void> {
    const removed = this.removed;
    if (!removed) return;
    const added = await this.doc.engine.addAttachment(this.doc.handle, {
      name: removed.attachment.name,
      bytes: this.bytes ?? new Uint8Array(0),
      ...(removed.attachment.description === null
        ? {}
        : { description: removed.attachment.description }),
      ...(removed.attachment.mimeType === null ? {} : { mimeType: removed.attachment.mimeType }),
      ...(removed.attachment.modified === null ? {} : { modified: removed.attachment.modified }),
    });
    this.doc.putAttachmentRecord({ ...removed.attachment, engineId: added.id }, removed.index);
    this.doc.idTable.bind('attachment', removed.attachment.id, added.id);
    this.doc.rebindAttachments(await engineAttachmentIds(this.doc));
  }

  toJSON(): CommandJson {
    return { id: this.id, data: { attachmentId: this.attachmentId } };
  }
}

/** Edits an attachment's description — the one field a reader can usefully change. */
export class DescribeAttachmentCommand extends NavCommand {
  readonly id = NAV_COMMAND_ID.describeAttachment;
  readonly label = 'Edit attachment description';
  private readonly attachmentId: ModelId;
  private description: string;
  private before = '';

  constructor(doc: Document, attachmentId: ModelId, description: string) {
    super(doc);
    this.attachmentId = attachmentId;
    this.description = description;
  }

  async do(): Promise<void> {
    this.before = this.doc.attachment(this.attachmentId)?.description ?? '';
    await this.write(this.description);
  }

  async undo(): Promise<void> {
    await this.write(this.before);
  }

  merge(next: Command): Command | null {
    if (!(next instanceof DescribeAttachmentCommand) || next.attachmentId !== this.attachmentId) {
      return null;
    }
    const merged = new DescribeAttachmentCommand(this.doc, this.attachmentId, next.description);
    merged.before = this.before;
    merged.adoptIntents([...this.writeIntents, ...next.writeIntents, 'attachments']);
    return merged;
  }

  private async write(description: string): Promise<void> {
    this.description = description;
    const record = this.doc.attachment(this.attachmentId);
    if (!record) return;
    try {
      await this.doc.engine.updateAttachment(this.doc.handle, record.engineId, { description });
    } catch (error) {
      if (!isUnsupported(error)) throw error;
    }
    this.doc.putAttachmentRecord({
      ...record,
      description: description === '' ? null : description,
    });
    this.intend('attachments');
  }

  toJSON(): CommandJson {
    return {
      id: this.id,
      data: { attachmentId: this.attachmentId, description: this.description },
    };
  }
}

// ---- journal codecs ------------------------------------------------------------------------------

function asRecord(payload: unknown): Record<string, unknown> | null {
  return typeof payload === 'object' && payload !== null
    ? (payload as Record<string, unknown>)
    : null;
}

function asId(value: unknown): ModelId | null {
  return typeof value === 'string' ? (value as ModelId) : null;
}

function asPosition(value: unknown): Position | null {
  const p = asRecord(value);
  if (!p) return null;
  const parentId = p['parentId'];
  const index = p['index'];
  if (typeof index !== 'number') return null;
  if (parentId !== null && typeof parentId !== 'string') return null;
  return { parentId: parentId === null ? null : (parentId as ModelId), index };
}

function asSpec(value: unknown): DestinationSpec | null {
  const d = asRecord(value);
  if (!d) return null;
  const fit = d['fit'];
  if (typeof fit !== 'string') return null;
  const num = (key: string): number | null => {
    const value_ = d[key];
    return typeof value_ === 'number' ? value_ : null;
  };
  return {
    pageId: asId(d['pageId']),
    fit: fit as Destination['fit'],
    left: num('left'),
    top: num('top'),
    zoom: num('zoom'),
    rect: (d['rect'] ?? null) as PdfRect | null,
  };
}

let registered = false;

/**
 * Registers the journal codecs for M12's commands. Called from the manifest's `activate`, and
 * by the unit tests directly; registering twice is harmless.
 */
export function registerNavigationCodecs(): void {
  if (registered) return;
  registered = true;

  registerCommandCodec(NAV_COMMAND_ID.addBookmark, (doc, payload) => {
    const d = asRecord(payload);
    const at = asPosition(d?.['at']);
    if (!d || !at || typeof d['title'] !== 'string') return null;
    const bookmarkId = asId(d['bookmarkId']);
    const destinationId = asId(d['destinationId']);
    return new AddBookmarkCommand(doc, {
      title: d['title'],
      at,
      destination: asSpec(d['destination']),
      uri: typeof d['uri'] === 'string' ? d['uri'] : null,
      ...(bookmarkId === null ? {} : { bookmarkId }),
      ...(destinationId === null ? {} : { destinationId }),
    });
  });

  registerCommandCodec(NAV_COMMAND_ID.renameBookmark, (doc, payload) => {
    const d = asRecord(payload);
    const id = asId(d?.['bookmarkId']);
    if (!d || id === null || typeof d['title'] !== 'string') return null;
    return new RenameBookmarkCommand(doc, id, d['title']);
  });

  registerCommandCodec(NAV_COMMAND_ID.deleteBookmark, (doc, payload) => {
    const id = asId(asRecord(payload)?.['bookmarkId']);
    return id === null ? null : new DeleteBookmarkCommand(doc, id);
  });

  registerCommandCodec(NAV_COMMAND_ID.moveBookmark, (doc, payload) => {
    const d = asRecord(payload);
    const id = asId(d?.['bookmarkId']);
    const to = asPosition(d?.['to']);
    if (id === null || !to) return null;
    const label = typeof d?.['label'] === 'string' ? d['label'] : undefined;
    return new MoveBookmarkCommand(doc, id, to, label);
  });

  registerCommandCodec(NAV_COMMAND_ID.setBookmarkTarget, (doc, payload) => {
    const d = asRecord(payload);
    const id = asId(d?.['bookmarkId']);
    if (!d || id === null) return null;
    const destinationId = asId(d['destinationId']);
    return new SetBookmarkTargetCommand(doc, id, {
      destination: asSpec(d['destination']),
      uri: typeof d['uri'] === 'string' ? d['uri'] : null,
      ...(typeof d['label'] === 'string' ? { label: d['label'] } : {}),
      ...(destinationId === null ? {} : { destinationId }),
    });
  });

  registerCommandCodec(NAV_COMMAND_ID.setBookmarkStyle, (doc, payload) => {
    const d = asRecord(payload);
    const id = asId(d?.['bookmarkId']);
    const style = asRecord(d?.['style']);
    if (id === null || !style) return null;
    return new SetBookmarkStyleCommand(doc, id, style);
  });

  registerCommandCodec(NAV_COMMAND_ID.addDestination, (doc, payload) => {
    const d = asRecord(payload);
    const spec = asSpec(d?.['destination']);
    if (!d || !spec || typeof d['name'] !== 'string') return null;
    const destinationId = asId(d['destinationId']);
    return new AddDestinationCommand(doc, {
      name: d['name'],
      destination: spec,
      ...(destinationId === null ? {} : { destinationId }),
    });
  });

  registerCommandCodec(NAV_COMMAND_ID.renameDestination, (doc, payload) => {
    const d = asRecord(payload);
    const id = asId(d?.['destinationId']);
    if (!d || id === null || typeof d['name'] !== 'string') return null;
    return new RenameDestinationCommand(doc, id, d['name']);
  });

  registerCommandCodec(NAV_COMMAND_ID.setDestination, (doc, payload) => {
    const d = asRecord(payload);
    const id = asId(d?.['destinationId']);
    const spec = asSpec(d?.['destination']);
    if (id === null || !spec) return null;
    return new SetDestinationCommand(doc, id, spec);
  });

  registerCommandCodec(NAV_COMMAND_ID.deleteDestination, (doc, payload) => {
    const id = asId(asRecord(payload)?.['destinationId']);
    return id === null ? null : new DeleteDestinationCommand(doc, id);
  });

  registerCommandCodec(NAV_COMMAND_ID.addAttachment, (doc, payload) => {
    const d = asRecord(payload);
    const bytes = d?.['bytes'];
    if (!d || typeof d['name'] !== 'string' || !Array.isArray(bytes)) return null;
    const attachmentId = asId(d['attachmentId']);
    return new AddAttachmentCommand(
      doc,
      {
        name: d['name'],
        bytes: Uint8Array.from(bytes as number[]),
        description: typeof d['description'] === 'string' ? d['description'] : null,
        mimeType: typeof d['mimeType'] === 'string' ? d['mimeType'] : null,
      },
      attachmentId ?? undefined,
    );
  });

  registerCommandCodec(NAV_COMMAND_ID.deleteAttachment, (doc, payload) => {
    const id = asId(asRecord(payload)?.['attachmentId']);
    return id === null ? null : new DeleteAttachmentCommand(doc, id);
  });

  registerCommandCodec(NAV_COMMAND_ID.describeAttachment, (doc, payload) => {
    const d = asRecord(payload);
    const id = asId(d?.['attachmentId']);
    if (!d || id === null || typeof d['description'] !== 'string') return null;
    return new DescribeAttachmentCommand(doc, id, d['description']);
  });
}

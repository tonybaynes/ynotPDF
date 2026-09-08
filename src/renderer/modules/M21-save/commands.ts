/**
 * Document commands M21 needs and no earlier module provides (M21).
 *
 * There is exactly one: adding a bookmark. The writer has to be able to emit an outline — that
 * is one of the module's acceptance tests — and nothing before M12 can put a bookmark into the
 * model to emit. The command is a proper `DocumentCommand` with a journal codec, so it undoes,
 * redoes, autosaves and replays like every other change; M12 will build its bookmarks panel on
 * top of it rather than on a second implementation.
 *
 * PDFium has no outline mutation, so the change is model-only and records the `outline` write
 * intent, which is what tells the writer to rebuild `/Outlines` on the next save.
 */

import type { Command, CommandJson } from '@core/Command';
import type { Document, DocumentCommand } from '@core/Document';
import type { ModelId } from '@core/Ids';
import { registerCommandCodec } from '@core/Journal';
import type { ModelDestination, ModelOutlineItem, WriteIntent } from '@core/model';

export const M21_COMMAND_ID = {
  addOutlineItem: 'outline.add',
} as const;

/** Where a new bookmark points. Absent means "a bookmark with no destination". */
export interface BookmarkTarget {
  readonly pageId: ModelId;
  readonly fit?: ModelDestination['fit'];
  readonly top?: number | null;
}

export interface AddOutlineItemOptions {
  readonly title: string;
  readonly target?: BookmarkTarget;
  /** Parent bookmark; absent adds a root. */
  readonly parentId?: ModelId | null;
  /** Position among its siblings; absent appends. */
  readonly index?: number;
  /** Ids to reuse, so a journal replay rebuilds the same bookmark rather than a new one. */
  readonly ids?: { readonly item: ModelId; readonly destination?: ModelId };
}

/**
 * Adds a bookmark, with its destination. Model-only: undo removes both again, and the `outline`
 * write intent tells M21's writer to emit the tree on the next save.
 */
export class AddOutlineItemCommand implements DocumentCommand {
  readonly id = M21_COMMAND_ID.addOutlineItem;
  readonly label = 'Add bookmark';
  readonly writeIntents: ReadonlyArray<WriteIntent> = ['outline'];

  private readonly doc: Document;
  private readonly options: AddOutlineItemOptions;
  private readonly itemId: ModelId;
  private readonly destinationId: ModelId | null;

  constructor(doc: Document, options: AddOutlineItemOptions) {
    this.doc = doc;
    this.options = options;
    this.itemId = options.ids?.item ?? doc.ids.next('outline');
    this.destinationId = options.target
      ? (options.ids?.destination ?? doc.ids.next('destination'))
      : null;
  }

  /** The id of the bookmark this command adds, for a caller that wants to select it. */
  get outlineId(): ModelId {
    return this.itemId;
  }

  do(): Promise<void> {
    const state = this.doc.state;
    const target = this.options.target;
    if (target && this.destinationId) {
      const destination: ModelDestination = {
        id: this.destinationId,
        name: null,
        pageId: target.pageId,
        fit: target.fit ?? 'fit',
        left: null,
        top: target.top ?? null,
        zoom: null,
        rect: null,
      };
      this.doc.store.set((s) => ({ destinations: [...s.destinations, destination] }));
    }

    const parentId = this.options.parentId ?? null;
    const item: ModelOutlineItem = {
      id: this.itemId,
      title: this.options.title,
      parentId,
      childIds: [],
      destinationId: this.destinationId,
      uri: null,
      open: true,
      bold: false,
      italic: false,
      color: null,
    };
    // Parents come before their children in the flat list, so a child goes in after its parent
    // rather than wherever the caller's index happens to fall.
    const outline = [...state.outline];
    const at = this.positionFor(outline, parentId);
    outline.splice(at, 0, item);
    const withParent = outline.map((o) =>
      o.id === parentId ? { ...o, childIds: [...o.childIds, this.itemId] } : o,
    );
    this.doc.setOutlineRecord(withParent);
    return Promise.resolve();
  }

  undo(): Promise<void> {
    const outline = this.doc.state.outline
      .filter((o) => o.id !== this.itemId)
      .map((o) =>
        o.childIds.includes(this.itemId)
          ? { ...o, childIds: o.childIds.filter((c) => c !== this.itemId) }
          : o,
      );
    this.doc.setOutlineRecord(outline);
    if (this.destinationId) {
      const id = this.destinationId;
      this.doc.store.set((s) => ({ destinations: s.destinations.filter((d) => d.id !== id) }));
    }
    return Promise.resolve();
  }

  toJSON(): CommandJson {
    const target = this.options.target;
    return {
      id: this.id,
      data: {
        title: this.options.title,
        parentId: this.options.parentId ?? null,
        index: this.options.index ?? null,
        ids: {
          item: this.itemId,
          ...(this.destinationId === null ? {} : { destination: this.destinationId }),
        },
        ...(target
          ? { target: { pageId: target.pageId, fit: target.fit ?? 'fit', top: target.top ?? null } }
          : {}),
      },
    };
  }

  /** Index in the flat outline where a child of `parentId` belongs: after its last descendant. */
  private positionFor(outline: ReadonlyArray<ModelOutlineItem>, parentId: ModelId | null): number {
    if (parentId === null) {
      const explicit = this.options.index;
      if (explicit === undefined) return outline.length;
      const roots = outline.filter((o) => o.parentId === null);
      const sibling = roots[explicit];
      return sibling ? outline.indexOf(sibling) : outline.length;
    }
    const parentAt = outline.findIndex((o) => o.id === parentId);
    if (parentAt < 0) return outline.length;
    // Walk forward past everything that descends from the parent.
    const descendants = new Set<string>([parentId]);
    let at = parentAt + 1;
    while (at < outline.length) {
      const candidate = outline[at];
      if (candidate?.parentId == null || !descendants.has(candidate.parentId)) break;
      descendants.add(candidate.id);
      at++;
    }
    return at;
  }
}

registerCommandCodec(M21_COMMAND_ID.addOutlineItem, (doc, payload): Command | null => {
  const p = (payload ?? {}) as Record<string, unknown>;
  const title = typeof p['title'] === 'string' ? p['title'] : null;
  if (title === null) return null;
  const ids = (p['ids'] ?? {}) as Record<string, unknown>;
  const item = typeof ids['item'] === 'string' ? (ids['item'] as ModelId) : null;
  if (!item) return null;
  const destination =
    typeof ids['destination'] === 'string' ? (ids['destination'] as ModelId) : undefined;
  // Reserve the recorded ids so a later allocation cannot hand the same one out again.
  doc.ids.reserve(item);
  if (destination) doc.ids.reserve(destination);
  const rawTarget = p['target'];
  const target =
    rawTarget && typeof rawTarget === 'object'
      ? (rawTarget as { pageId?: unknown; fit?: unknown; top?: unknown })
      : null;
  return new AddOutlineItemCommand(doc, {
    title,
    parentId: typeof p['parentId'] === 'string' ? (p['parentId'] as ModelId) : null,
    ...(typeof p['index'] === 'number' ? { index: p['index'] } : {}),
    ids: { item, ...(destination === undefined ? {} : { destination }) },
    ...(target && typeof target.pageId === 'string'
      ? {
          target: {
            pageId: target.pageId as ModelId,
            fit: (typeof target.fit === 'string' ? target.fit : 'fit') as ModelDestination['fit'],
            top: typeof target.top === 'number' ? target.top : null,
          },
        }
      : {}),
  });
});

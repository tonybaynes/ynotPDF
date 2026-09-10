/**
 * M50's `Command`s: every change to a page's objects, undoable and journalled.
 *
 * Each one does two things in step and reverses both exactly: it changes the engine's live page
 * (so the next render shows it) and the module's edit state in `Document.custom('M50')` (so the
 * writer and the recovery file know). The state is restored on undo from a snapshot taken
 * before `do()`, which is what makes "the model always matches the engine" a property rather
 * than a hope.
 *
 * The first edit on a page captures its original content stream, PDFium's object kinds and the
 * text matrices (`ensureState`). That capture is part of the same command, so undoing the very
 * first edit leaves no state behind — and the writer then plans nothing for the page.
 */

import type { Command, CommandJson } from '@core/Command';
import type { Document, DocumentCommand } from '@core/Document';
import type { ModelId } from '@core/Ids';
import { registerCommandCodec } from '@core/Journal';
import type { WriteIntent } from '@core/model';
import type { PageObject } from '@engine/PdfEngine';
import { invert, multiply } from '@engine/content/matrix';
import type { ObjectStyle, PdfMatrix } from '@shared/pdf';
import {
  OBJECTS_NAMESPACE,
  baseId,
  fromBase64,
  indexOfId,
  readObjectsState,
  toBase64,
  type LiveObject,
  type PageEditState,
  type PageGroups,
} from './model';

export const OBJECT_COMMAND_ID = {
  transform: 'object.transform',
  delete: 'object.delete',
  insert: 'object.insert',
  reorder: 'object.reorder',
  style: 'object.style',
  groups: 'object.groups',
} as const;

abstract class ObjectCommand implements DocumentCommand {
  abstract readonly id: string;
  abstract readonly label: string;
  protected readonly doc: Document;
  readonly pageId: ModelId;
  /** The page's state before `do()`: `null` when there was none, `undefined` until run. */
  protected before: PageEditState | null | undefined;
  protected after: PageEditState | null | undefined;

  constructor(doc: Document, pageId: ModelId) {
    this.doc = doc;
    this.pageId = pageId;
  }

  get writeIntents(): ReadonlyArray<WriteIntent> {
    return ['page-objects'];
  }

  abstract do(): Promise<void>;
  abstract undo(): Promise<void>;
  abstract toJSON(): CommandJson;

  protected get pageIndex(): number {
    const index = this.doc.enginePage(this.pageId);
    if (index === undefined) throw new Error(`page ${this.pageId} is not in the engine`);
    return index;
  }

  protected state(): PageEditState | null {
    return readObjectsState(this.doc.custom(OBJECTS_NAMESPACE)).pages[this.pageId] ?? null;
  }

  /** The page's edit state, capturing the original content on the first edit. */
  protected async ensureState(): Promise<PageEditState> {
    const existing = this.state();
    if (existing) return existing;
    const index = this.pageIndex;
    const content = await this.doc.engine.pageContent(this.doc.handle, index);
    const objects = await this.doc.engine.pageObjects(this.doc.handle, index);
    const textMatrices: Record<string, PdfMatrix> = {};
    for (const o of objects) if (o.kind === 'text') textMatrices[String(o.index)] = o.matrix;
    const state: PageEditState = {
      original: toBase64(content),
      kinds: objects.map((o) => o.kind),
      textMatrices,
      live: objects.map((o, i): LiveObject => ({ kind: 'base', id: baseId(i), index: i })),
      pasted: 0,
    };
    this.writeState(state);
    return state;
  }

  protected writeState(next: PageEditState | null): void {
    const bag = this.doc.custom(OBJECTS_NAMESPACE);
    const pages: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(
      (bag['pages'] as Record<string, unknown> | undefined) ?? {},
    )) {
      if (k !== this.pageId) pages[k] = v;
    }
    if (next) pages[this.pageId] = next;
    this.doc.setCustomRecord(OBJECTS_NAMESPACE, { pages });
  }

  /** Engine index of an object id right now. */
  protected indexOf(id: string): number {
    const state = this.state();
    if (state) {
      const index = indexOfId(state.live, id);
      if (index < 0) throw new Error(`object ${id} is not on page ${this.pageId}`);
      return index;
    }
    if (!id.startsWith('b')) throw new Error(`object ${id} is not on page ${this.pageId}`);
    return Number(id.slice(1));
  }

  /** Tells the views the page's objects changed. */
  protected notify(): void {
    this.doc.replacePage(this.pageId, (p) => ({ ...p, objects: null }), 'objects');
  }

  protected snapshotAfter(): void {
    this.after = this.state();
  }

  protected restoreBefore(): void {
    if (this.before === undefined) return;
    this.writeState(this.before);
  }
}

/** Moves, resizes, rotates or flips objects: one page-space matrix, post-multiplied. */
export class TransformObjectsCommand extends ObjectCommand {
  readonly id = OBJECT_COMMAND_ID.transform;
  readonly label: string;
  readonly ids: ReadonlyArray<string>;
  readonly delta: PdfMatrix;
  readonly mergeable = true;

  constructor(
    doc: Document,
    pageId: ModelId,
    ids: ReadonlyArray<string>,
    delta: PdfMatrix,
    label = 'Move object',
    merged?: { readonly before: PageEditState | null; readonly after: PageEditState | null },
  ) {
    super(doc, pageId);
    this.ids = [...ids];
    this.delta = delta;
    this.label = label;
    if (merged) {
      this.before = merged.before;
      this.after = merged.after;
    }
  }

  async do(): Promise<void> {
    if (this.before === undefined) this.before = this.state();
    if (this.after && this.before !== undefined) {
      // Redo: replay the engine change and put the known state back.
      await this.apply(this.delta);
      this.writeState(this.after);
      this.notify();
      return;
    }
    const state = await this.ensureState();
    await this.apply(this.delta);
    const live = state.live.map((o): LiveObject => {
      if (!this.ids.includes(o.id)) return o;
      return o.kind === 'base'
        ? { ...o, transform: o.transform ? multiply(o.transform, this.delta) : this.delta }
        : { ...o, matrix: multiply(o.matrix, this.delta) };
    });
    this.writeState({ ...state, live });
    this.snapshotAfter();
    this.notify();
  }

  async undo(): Promise<void> {
    const inverse = invert(this.delta);
    if (inverse) await this.apply(inverse);
    this.restoreBefore();
    this.notify();
  }

  private async apply(delta: PdfMatrix): Promise<void> {
    const page = this.pageIndex;
    for (const id of this.ids) {
      await this.doc.engine.transformObject(this.doc.handle, page, this.indexOf(id), delta);
    }
  }

  merge(next: Command): Command | null {
    if (!(next instanceof TransformObjectsCommand)) return null;
    if (next.doc !== this.doc || next.pageId !== this.pageId) return null;
    if (next.ids.length !== this.ids.length || !next.ids.every((id) => this.ids.includes(id))) {
      return null;
    }
    if (next.label !== this.label) return null;
    return new TransformObjectsCommand(
      this.doc,
      this.pageId,
      this.ids,
      multiply(this.delta, next.delta),
      this.label,
      { before: this.before ?? null, after: next.after ?? null },
    );
  }

  toJSON(): CommandJson {
    return {
      id: this.id,
      data: { pageId: this.pageId, ids: this.ids, delta: this.delta, label: this.label },
    };
  }
}

/** Removes objects; undo puts the very same objects back through the engine's stash. */
export class DeleteObjectsCommand extends ObjectCommand {
  readonly id = OBJECT_COMMAND_ID.delete;
  readonly label: string;
  readonly ids: ReadonlyArray<string>;
  private removed: Array<{ id: string; index: number; token: number }> = [];

  constructor(doc: Document, pageId: ModelId, ids: ReadonlyArray<string>) {
    super(doc, pageId);
    this.ids = [...ids];
    this.label = ids.length === 1 ? 'Delete object' : `Delete ${ids.length} objects`;
  }

  async do(): Promise<void> {
    if (this.before === undefined) this.before = this.state();
    const state = await this.ensureState();
    const page = this.pageIndex;
    const targets = this.ids
      .map((id) => ({ id, index: indexOfId(state.live, id) }))
      .filter((t) => t.index >= 0)
      .sort((a, b) => b.index - a.index);
    this.removed = [];
    for (const t of targets) {
      const token = await this.doc.engine.removeObject(this.doc.handle, page, t.index);
      this.removed.push({ ...t, token });
    }
    const gone = new Set(targets.map((t) => t.id));
    this.writeState({ ...state, live: state.live.filter((o) => !gone.has(o.id)) });
    this.snapshotAfter();
    this.notify();
  }

  async undo(): Promise<void> {
    const page = this.pageIndex;
    for (const r of [...this.removed].sort((a, b) => a.index - b.index)) {
      await this.doc.engine.restoreObject(this.doc.handle, page, r.token, r.index);
    }
    this.removed = [];
    this.restoreBefore();
    this.notify();
  }

  toJSON(): CommandJson {
    return { id: this.id, data: { pageId: this.pageId, ids: this.ids } };
  }
}

/** Puts a copied object (a one-page PDF) on the page as a form XObject, on top. */
export class InsertObjectCommand extends ObjectCommand {
  readonly id = OBJECT_COMMAND_ID.insert;
  readonly label: string;
  readonly pdf: string;
  readonly matrix: PdfMatrix;
  readonly from: PageObject['kind'];
  /** The id the object got, once done. */
  insertedId: string | null = null;
  private token: number | null = null;

  constructor(
    doc: Document,
    pageId: ModelId,
    pdf: string,
    matrix: PdfMatrix,
    from: PageObject['kind'],
    label = 'Paste object',
  ) {
    super(doc, pageId);
    this.pdf = pdf;
    this.matrix = matrix;
    this.from = from;
    this.label = label;
  }

  async do(): Promise<void> {
    if (this.before === undefined) this.before = this.state();
    const state = await this.ensureState();
    const page = this.pageIndex;
    const at = state.live.length;
    if (this.token !== null) {
      await this.doc.engine.restoreObject(this.doc.handle, page, this.token, at);
      this.token = null;
    } else {
      await this.doc.engine.insertObject(this.doc.handle, page, {
        pdf: fromBase64(this.pdf),
        matrix: this.matrix,
      });
    }
    if (this.after) {
      this.writeState(this.after);
    } else {
      const n = state.pasted + 1;
      this.insertedId = `p${n}`;
      this.writeState({
        ...state,
        pasted: n,
        live: [
          ...state.live,
          {
            kind: 'pasted',
            id: this.insertedId,
            pdf: this.pdf,
            matrix: this.matrix,
            from: this.from,
          },
        ],
      });
      this.snapshotAfter();
    }
    this.notify();
  }

  async undo(): Promise<void> {
    const state = this.state();
    const index = state && this.insertedId ? indexOfId(state.live, this.insertedId) : -1;
    if (index >= 0) {
      this.token = await this.doc.engine.removeObject(this.doc.handle, this.pageIndex, index);
    }
    this.restoreBefore();
    this.notify();
  }

  toJSON(): CommandJson {
    return {
      id: this.id,
      data: {
        pageId: this.pageId,
        pdf: this.pdf,
        matrix: this.matrix,
        from: this.from,
        label: this.label,
      },
    };
  }
}

/** Rewrites the page's z-order. `order[i]` is the current index of what ends up at `i`. */
export class ReorderObjectsCommand extends ObjectCommand {
  readonly id = OBJECT_COMMAND_ID.reorder;
  readonly label: string;
  readonly order: ReadonlyArray<number>;

  constructor(
    doc: Document,
    pageId: ModelId,
    order: ReadonlyArray<number>,
    label = 'Arrange objects',
  ) {
    super(doc, pageId);
    this.order = [...order];
    this.label = label;
  }

  async do(): Promise<void> {
    if (this.before === undefined) this.before = this.state();
    const state = await this.ensureState();
    await this.doc.engine.reorderObjects(this.doc.handle, this.pageIndex, this.order);
    const live = this.order
      .map((from) => state.live[from])
      .filter((o): o is LiveObject => o !== undefined);
    this.writeState({ ...state, live });
    this.snapshotAfter();
    this.notify();
  }

  async undo(): Promise<void> {
    const inverse: number[] = [];
    this.order.forEach((from, to) => {
      inverse[from] = to;
    });
    await this.doc.engine.reorderObjects(this.doc.handle, this.pageIndex, inverse);
    this.restoreBefore();
    this.notify();
  }

  toJSON(): CommandJson {
    return { id: this.id, data: { pageId: this.pageId, order: this.order, label: this.label } };
  }
}

/** Sets a path's stroke and fill properties. Merges, so a colour picker's drag is one entry. */
export class SetObjectStyleCommand extends ObjectCommand {
  readonly id = OBJECT_COMMAND_ID.style;
  readonly label = 'Change object style';
  readonly objectId: string;
  readonly style: ObjectStyle;
  readonly previous: ObjectStyle;
  readonly mergeable = true;

  constructor(
    doc: Document,
    pageId: ModelId,
    objectId: string,
    style: ObjectStyle,
    previous: ObjectStyle,
    merged?: { readonly before: PageEditState | null; readonly after: PageEditState | null },
  ) {
    super(doc, pageId);
    this.objectId = objectId;
    this.style = style;
    this.previous = previous;
    if (merged) {
      this.before = merged.before;
      this.after = merged.after;
    }
  }

  async do(): Promise<void> {
    if (this.before === undefined) this.before = this.state();
    const state = await this.ensureState();
    const index = this.indexOf(this.objectId);
    await this.doc.engine.setObjectStyle(this.doc.handle, this.pageIndex, index, this.style);
    if (this.after) {
      this.writeState(this.after);
    } else {
      const live = state.live.map((o): LiveObject =>
        o.id === this.objectId && o.kind === 'base'
          ? { ...o, style: { ...o.style, ...this.style } }
          : o,
      );
      this.writeState({ ...state, live });
      this.snapshotAfter();
    }
    this.notify();
  }

  async undo(): Promise<void> {
    const index = this.indexOf(this.objectId);
    await this.doc.engine.setObjectStyle(this.doc.handle, this.pageIndex, index, this.previous);
    this.restoreBefore();
    this.notify();
  }

  merge(next: Command): Command | null {
    if (!(next instanceof SetObjectStyleCommand)) return null;
    if (next.doc !== this.doc || next.pageId !== this.pageId || next.objectId !== this.objectId) {
      return null;
    }
    return new SetObjectStyleCommand(
      this.doc,
      this.pageId,
      this.objectId,
      { ...this.style, ...next.style },
      // The earliest value of each field is what undo has to put back.
      { ...next.previous, ...this.previous },
      { before: this.before ?? null, after: next.after ?? null },
    );
  }

  toJSON(): CommandJson {
    return {
      id: this.id,
      data: {
        pageId: this.pageId,
        objectId: this.objectId,
        style: this.style,
        previous: this.previous,
      },
    };
  }
}

/** Replaces a page's groups. Groups live only in the model, so this touches no engine. */
export class SetGroupsCommand implements DocumentCommand {
  readonly id = OBJECT_COMMAND_ID.groups;
  readonly label: string;
  readonly writeIntents: ReadonlyArray<WriteIntent> = ['page-objects'];
  private readonly doc: Document;
  readonly pageId: ModelId;
  readonly groups: PageGroups;
  private previous: PageGroups | null = null;

  constructor(doc: Document, pageId: ModelId, groups: PageGroups, label: string) {
    this.doc = doc;
    this.pageId = pageId;
    this.groups = groups;
    this.label = label;
  }

  private write(groups: PageGroups | null): void {
    const bag = this.doc.custom(OBJECTS_NAMESPACE);
    const all: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(
      (bag['groups'] as Record<string, unknown> | undefined) ?? {},
    )) {
      if (k !== this.pageId) all[k] = v;
    }
    if (groups) all[this.pageId] = groups;
    this.doc.setCustomRecord(OBJECTS_NAMESPACE, { groups: all });
  }

  do(): Promise<void> {
    this.previous =
      readObjectsState(this.doc.custom(OBJECTS_NAMESPACE)).groups[this.pageId] ?? null;
    this.write(this.groups);
    this.doc.replacePage(this.pageId, (p) => p, 'objects');
    return Promise.resolve();
  }

  undo(): Promise<void> {
    this.write(this.previous);
    this.doc.replacePage(this.pageId, (p) => p, 'objects');
    return Promise.resolve();
  }

  toJSON(): CommandJson {
    return { id: this.id, data: { pageId: this.pageId, groups: this.groups, label: this.label } };
  }
}

function isMatrix(v: unknown): v is PdfMatrix {
  return Array.isArray(v) && v.length === 6 && v.every((n) => typeof n === 'number');
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : [];
}

/** Registers the journal codecs, so a recovery file replays every object edit (M21). */
export function registerObjectCodecs(): void {
  registerCommandCodec(OBJECT_COMMAND_ID.transform, (doc, payload) => {
    const p = payload as Record<string, unknown>;
    if (typeof p['pageId'] !== 'string' || !isMatrix(p['delta'])) return null;
    return new TransformObjectsCommand(
      doc,
      p['pageId'] as ModelId,
      strings(p['ids']),
      p['delta'],
      typeof p['label'] === 'string' ? p['label'] : undefined,
    );
  });
  registerCommandCodec(OBJECT_COMMAND_ID.delete, (doc, payload) => {
    const p = payload as Record<string, unknown>;
    if (typeof p['pageId'] !== 'string') return null;
    return new DeleteObjectsCommand(doc, p['pageId'] as ModelId, strings(p['ids']));
  });
  registerCommandCodec(OBJECT_COMMAND_ID.insert, (doc, payload) => {
    const p = payload as Record<string, unknown>;
    if (typeof p['pageId'] !== 'string' || typeof p['pdf'] !== 'string' || !isMatrix(p['matrix'])) {
      return null;
    }
    const from = p['from'];
    return new InsertObjectCommand(
      doc,
      p['pageId'] as ModelId,
      p['pdf'],
      p['matrix'],
      from === 'text' || from === 'path' || from === 'image' || from === 'shading' ? from : 'form',
      typeof p['label'] === 'string' ? p['label'] : undefined,
    );
  });
  registerCommandCodec(OBJECT_COMMAND_ID.reorder, (doc, payload) => {
    const p = payload as Record<string, unknown>;
    if (typeof p['pageId'] !== 'string' || !Array.isArray(p['order'])) return null;
    return new ReorderObjectsCommand(
      doc,
      p['pageId'] as ModelId,
      p['order'].filter((n): n is number => typeof n === 'number'),
      typeof p['label'] === 'string' ? p['label'] : undefined,
    );
  });
  registerCommandCodec(OBJECT_COMMAND_ID.style, (doc, payload) => {
    const p = payload as Record<string, unknown>;
    if (typeof p['pageId'] !== 'string' || typeof p['objectId'] !== 'string') return null;
    return new SetObjectStyleCommand(
      doc,
      p['pageId'] as ModelId,
      p['objectId'],
      p['style'] ?? {},
      p['previous'] ?? {},
    );
  });
  registerCommandCodec(OBJECT_COMMAND_ID.groups, (doc, payload) => {
    const p = payload as Record<string, unknown>;
    if (typeof p['pageId'] !== 'string' || !p['groups'] || typeof p['groups'] !== 'object') {
      return null;
    }
    const groups: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(p['groups'] as Record<string, unknown>)) {
      groups[k] = strings(v);
    }
    return new SetGroupsCommand(
      doc,
      p['pageId'] as ModelId,
      groups,
      typeof p['label'] === 'string' ? p['label'] : 'Group objects',
    );
  });
}

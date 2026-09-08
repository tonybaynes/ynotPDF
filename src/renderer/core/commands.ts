/**
 * The document commands (M20, ADR 0007). Every change a user can make to a PDF is one of these,
 * so undo, redo, autosave and batch all work without each feature module re-inventing them.
 *
 * Each command:
 * - mutates the **model** first — the model is the authority for intent;
 * - then offers the change to the **engine**, so a render reflects it immediately;
 * - records a {@link WriteIntent} when the engine cannot express it, so M21's writer knows
 *   what it must apply itself. A `NotImplementedError` from the engine is an expected answer
 *   here, not a failure.
 *
 * Page order and page presence never go to the engine: `FPDFPage_Delete` cannot be undone. See
 * the comment on `Document` for why that is the right split.
 *
 * Commands are constructed with plain data and serialise to plain data (`toJSON`), which is
 * what makes the journal in `Journal.ts` work.
 */

import type { Annotation, AnnotationFlags } from '@engine/PdfEngine';
import { EngineError } from '@engine/PdfEngine';
import type { PdfRect, Rotation } from '@shared/pdf';
import { normalizeRect } from '@shared/pdf';
import type { Command, CommandJson } from './Command';
import type { Document, DocumentCommand } from './Document';
import type { ModelId } from './Ids';
import {
  pageSizeOf,
  toEngineAnnotation,
  toModelAnnotation,
  type AnnotationPatch,
  type ModelAnnotation,
  type ModelPage,
  type ModelWidget,
  type PageBoxName,
  type WriteIntent,
} from './model';

/** Command ids, so the journal, the palette and the tests all name the same thing. */
export const COMMAND_ID = {
  rotatePages: 'page.rotate',
  insertPages: 'page.insert',
  deletePages: 'page.delete',
  movePage: 'page.move',
  setPageBox: 'page.setBox',
  setPageLabel: 'page.label',
  addAnnotation: 'annot.add',
  updateAnnotation: 'annot.update',
  deleteAnnotation: 'annot.delete',
  setFieldValue: 'field.setValue',
  setMetadata: 'meta.set',
  setLayerVisible: 'layer.visible',
  setCustom: 'custom.set',
} as const;

/** True when an engine rejection means "this backend cannot do that", not "that went wrong". */
function isUnsupported(error: unknown): boolean {
  return error instanceof EngineError && error.code === 'not-implemented';
}

/**
 * Runs an engine call, reporting whether it happened. Unsupported operations resolve to
 * `false`; anything else is a real failure and propagates, so a corrupt file or a bad handle
 * still surfaces instead of being silently downgraded to a write intent.
 */
async function tryEngine(fn: () => Promise<unknown>): Promise<boolean> {
  try {
    await fn();
    return true;
  } catch (error) {
    if (isUnsupported(error)) return false;
    throw error;
  }
}

/** Base class: holds the document, tracks what the engine refused. */
abstract class BaseCommand implements DocumentCommand {
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

  /** Records that the writer must apply this kind of change itself. */
  protected intend(...intents: WriteIntent[]): void {
    for (const i of intents) if (!this.intents.includes(i)) this.intents.push(i);
  }

  /** Replaces the intent list (used when a merge builds a new command from two old ones). */
  protected adoptIntents(intents: ReadonlyArray<WriteIntent>): void {
    this.intents = [...intents];
  }

  abstract do(): Promise<void>;
  abstract undo(): Promise<void>;
  abstract toJSON(): CommandJson;
}

// ---- pages -------------------------------------------------------------------------------------

/**
 * Rotates pages to an absolute `/Rotate`, or by a delta when `relative` is set. Engine-backed:
 * PDFium reverses a rotation exactly, so undo restores each page's previous value.
 */
export class RotatePagesCommand extends BaseCommand {
  readonly id = COMMAND_ID.rotatePages;
  readonly label: string;
  private readonly pageIds: ReadonlyArray<ModelId>;
  private readonly rotation: Rotation;
  private readonly relative: boolean;
  private before = new Map<ModelId, Rotation>();

  constructor(
    doc: Document,
    pageIds: ReadonlyArray<ModelId>,
    rotation: Rotation,
    relative = false,
  ) {
    super(doc);
    this.pageIds = [...pageIds];
    this.rotation = rotation;
    this.relative = relative;
    this.label = pageIds.length === 1 ? 'Rotate page' : `Rotate ${pageIds.length} pages`;
  }

  async do(): Promise<void> {
    this.before = new Map();
    for (const pageId of this.pageIds) {
      const page = this.doc.pageById(pageId);
      if (!page) continue;
      this.before.set(pageId, page.rotation);
      const next = this.relative
        ? (((page.rotation + this.rotation + 360) % 360) as Rotation)
        : this.rotation;
      await this.applyRotation(pageId, next);
    }
  }

  async undo(): Promise<void> {
    for (const [pageId, rotation] of this.before) await this.applyRotation(pageId, rotation);
  }

  private async applyRotation(pageId: ModelId, rotation: Rotation): Promise<void> {
    const index = this.doc.enginePage(pageId);
    const applied =
      index === undefined
        ? false
        : await tryEngine(() => this.doc.engine.setPageRotation(this.doc.handle, index, rotation));
    if (!applied) this.intend('page-boxes');
    this.doc.replacePage(pageId, (p) => ({ ...p, rotation }), 'rotation');
  }

  toJSON(): CommandJson {
    return {
      id: this.id,
      data: { pageIds: this.pageIds, rotation: this.rotation, relative: this.relative },
    };
  }
}

/**
 * Inserts blank pages at a visual index. The engine appends the real pages at its own end (so no
 * existing engine index shifts) and the model puts their ids where the user asked. Undo removes
 * both, which is safe because we created them.
 */
export class InsertPagesCommand extends BaseCommand {
  readonly id = COMMAND_ID.insertPages;
  readonly label: string;
  private readonly at: number;
  private readonly count: number;
  private readonly size: { readonly width: number; readonly height: number };
  private created: ModelId[] = [];

  constructor(
    doc: Document,
    at: number,
    count: number,
    size: { readonly width: number; readonly height: number },
    /** Ids to reuse. The journal replays with the ids the original run minted. */
    ids: ReadonlyArray<ModelId> = [],
  ) {
    super(doc);
    this.at = at;
    this.count = Math.max(1, Math.floor(count));
    this.size = size;
    this.created = [...ids];
    this.label = this.count === 1 ? 'Insert page' : `Insert ${this.count} pages`;
  }

  /** The pages this command created, in order. Empty until it has run. */
  get pageIds(): ReadonlyArray<ModelId> {
    return this.created;
  }

  async do(): Promise<void> {
    const engineCount = await this.doc.engine.pageCount(this.doc.handle);
    const applied = await tryEngine(() =>
      this.doc.engine.insertBlankPages(this.doc.handle, engineCount, this.count, this.size),
    );
    if (!applied) this.intend('page-order');
    // Reuse the ids from a previous run so undo/redo keeps selections and comments valid.
    if (this.created.length === 0) {
      for (let i = 0; i < this.count; i++) this.created.push(this.doc.ids.next('page'));
    }
    const box: PdfRect = { x0: 0, y0: 0, x1: this.size.width, y1: this.size.height };
    this.created.forEach((id, i) => {
      if (applied) this.doc.idTable.bind('page', id, String(engineCount + i));
      const page: ModelPage = {
        id,
        label: String(this.at + i + 1),
        rotation: 0,
        mediaBox: box,
        cropBox: box,
        bleedBox: null,
        trimBox: null,
        artBox: null,
        objects: null,
      };
      this.doc.insertPageRecord(page, this.at + i);
    });
    this.intend('page-order', 'page-labels');
  }

  async undo(): Promise<void> {
    // Collect every engine index first: deleting one at a time renumbers the rest.
    const indexes: number[] = [];
    for (const id of this.created) {
      const index = this.doc.enginePage(id);
      if (index !== undefined) indexes.push(index);
      this.doc.removePageRecord(id);
      this.doc.idTable.unbind('page', id);
    }
    if (indexes.length > 0) {
      await tryEngine(() => this.doc.engine.deletePages(this.doc.handle, indexes));
    }
  }

  toJSON(): CommandJson {
    // The ids go in the journal: a later entry names an inserted page by id, and a replay that
    // minted fresh ones would find nothing and skip that entry while reporting success.
    return {
      id: this.id,
      data: { at: this.at, count: this.count, size: this.size, ids: this.created },
    };
  }
}

/**
 * Removes pages from the document. The engine keeps its pages — deletion there is destructive
 * and could not be undone — so this is a model change plus a `page-order` write intent, and
 * M21's writer emits only the pages the model still lists.
 */
export class DeletePagesCommand extends BaseCommand {
  readonly id = COMMAND_ID.deletePages;
  readonly label: string;
  private readonly pageIds: ReadonlyArray<ModelId>;
  private removed: {
    page: ModelPage;
    index: number;
    annotations: ReadonlyArray<ModelAnnotation> | null;
  }[] = [];
  /** Widget lists of fields that had a widget on a deleted page, as they were before. */
  private widgets: { fieldId: ModelId; before: ReadonlyArray<ModelWidget> }[] = [];
  /** Destinations that pointed at a deleted page, and the page they pointed at. */
  private destinations: { destinationId: ModelId; before: ModelId }[] = [];

  constructor(doc: Document, pageIds: ReadonlyArray<ModelId>) {
    super(doc);
    this.pageIds = [...pageIds];
    this.label = pageIds.length === 1 ? 'Delete page' : `Delete ${pageIds.length} pages`;
  }

  do(): Promise<void> {
    this.removed = [];
    this.widgets = [];
    this.destinations = [];
    const gone = new Set<string>();
    // Highest index first, so the indexes we record stay valid as we go.
    const ordered = [...this.pageIds].sort((a, b) => this.doc.pageIndex(b) - this.doc.pageIndex(a));
    for (const pageId of ordered) {
      const removed = this.doc.removePageRecord(pageId);
      if (!removed) continue;
      this.removed.push(removed);
      gone.add(pageId);
    }
    if (gone.size === 0) return Promise.resolve();

    // A page takes its field widgets with it, and orphans any destination aimed at it.
    for (const field of this.doc.state.fields) {
      if (!field.widgets.some((w) => gone.has(w.pageId))) continue;
      this.widgets.push({ fieldId: field.id, before: field.widgets });
      this.doc.setFieldWidgetsRecord(
        field.id,
        field.widgets.filter((w) => !gone.has(w.pageId)),
      );
    }
    for (const dest of this.doc.state.destinations) {
      if (dest.pageId === null || !gone.has(dest.pageId)) continue;
      this.destinations.push({ destinationId: dest.id, before: dest.pageId });
      this.doc.setDestinationPageRecord(dest.id, null);
    }
    this.intend('page-order');
    return Promise.resolve();
  }

  undo(): Promise<void> {
    // Lowest index first, restoring each page where it was.
    for (const { page, index, annotations } of [...this.removed].sort(
      (a, b) => a.index - b.index,
    )) {
      this.doc.insertPageRecord(page, index);
      this.doc.restoreAnnotations(page.id, annotations);
    }
    for (const { fieldId, before } of this.widgets) this.doc.setFieldWidgetsRecord(fieldId, before);
    for (const { destinationId, before } of this.destinations) {
      this.doc.setDestinationPageRecord(destinationId, before);
    }
    return Promise.resolve();
  }

  toJSON(): CommandJson {
    return { id: this.id, data: { pageIds: this.pageIds } };
  }
}

/** Moves a page to another position. Model-only, like deletion: order is the model's business. */
export class MovePageCommand extends BaseCommand {
  readonly id = COMMAND_ID.movePage;
  readonly label = 'Move page';
  private readonly pageId: ModelId;
  private readonly to: number;
  private from = -1;

  constructor(doc: Document, pageId: ModelId, to: number) {
    super(doc);
    this.pageId = pageId;
    this.to = to;
  }

  do(): Promise<void> {
    this.from = this.doc.pageIndex(this.pageId);
    if (this.from >= 0) this.doc.movePageRecord(this.pageId, this.to);
    this.intend('page-order');
    return Promise.resolve();
  }

  undo(): Promise<void> {
    if (this.from >= 0) this.doc.movePageRecord(this.pageId, this.from);
    return Promise.resolve();
  }

  toJSON(): CommandJson {
    return { id: this.id, data: { pageId: this.pageId, to: this.to } };
  }
}

/**
 * Sets one of a page's boxes. CropBox and MediaBox go to the engine (PDFium has setters and
 * reverses them exactly); the other three are model-only until M21's writer emits them.
 */
export class SetPageBoxCommand extends BaseCommand {
  readonly id = COMMAND_ID.setPageBox;
  readonly label: string;
  private readonly pageId: ModelId;
  private readonly box: PageBoxName;
  private readonly rect: PdfRect;
  private before: PdfRect | null = null;
  private hadBox = false;

  constructor(doc: Document, pageId: ModelId, box: PageBoxName, rect: PdfRect) {
    super(doc);
    this.pageId = pageId;
    this.box = box;
    this.rect = normalizeRect(rect);
    this.label = box === 'crop' ? 'Crop page' : `Set ${box} box`;
  }

  async do(): Promise<void> {
    const page = this.doc.pageById(this.pageId);
    if (!page) return;
    const key = `${this.box}Box` as const;
    this.before = page[key];
    this.hadBox = page[key] !== null;
    await this.write(this.rect);
  }

  async undo(): Promise<void> {
    await this.write(this.hadBox ? this.before : null);
  }

  private async write(rect: PdfRect | null): Promise<void> {
    const key = `${this.box}Box` as const;
    if (rect !== null && this.box === 'crop') {
      const index = this.doc.enginePage(this.pageId);
      const applied =
        index === undefined
          ? false
          : await tryEngine(() => this.doc.engine.setCropBox(this.doc.handle, index, rect));
      if (!applied) this.intend('page-boxes');
    } else {
      this.intend('page-boxes');
    }
    this.doc.replacePage(this.pageId, (p) => ({ ...p, [key]: rect }), 'boxes', this.box);
  }

  toJSON(): CommandJson {
    return { id: this.id, data: { pageId: this.pageId, box: this.box, rect: this.rect } };
  }
}

/** Renames a page's display label. `/PageLabels` has no PDFium setter, so the writer applies it. */
export class SetPageLabelCommand extends BaseCommand {
  readonly id = COMMAND_ID.setPageLabel;
  readonly label = 'Rename page';
  readonly mergeable = true;
  private readonly pageId: ModelId;
  private readonly value: string;
  private before = '';

  constructor(doc: Document, pageId: ModelId, value: string, before?: string) {
    super(doc);
    this.pageId = pageId;
    this.value = value;
    if (before !== undefined) this.before = before;
  }

  do(): Promise<void> {
    const page = this.doc.pageById(this.pageId);
    if (page) this.before = this.before === '' ? page.label : this.before;
    this.doc.replacePage(this.pageId, (p) => ({ ...p, label: this.value }), 'label');
    this.intend('page-labels');
    return Promise.resolve();
  }

  undo(): Promise<void> {
    this.doc.replacePage(this.pageId, (p) => ({ ...p, label: this.before }), 'label');
    return Promise.resolve();
  }

  /** Consecutive renames of the same page collapse, so typing a label is one undo step. */
  merge(next: Command): Command | null {
    if (!(next instanceof SetPageLabelCommand) || next.pageId !== this.pageId) return null;
    const merged = new SetPageLabelCommand(this.doc, this.pageId, next.value, this.before);
    // The merged command replaces both in the journal, so it has to carry both their intents:
    // its own `do()` never runs, and the label would otherwise never reach M21's writer.
    merged.adoptIntents([...this.writeIntents, ...next.writeIntents]);
    return merged;
  }

  toJSON(): CommandJson {
    return { id: this.id, data: { pageId: this.pageId, value: this.value } };
  }
}

// ---- annotations -------------------------------------------------------------------------------

/**
 * Adds an annotation. Engine-backed: PDFium creates it so the page raster shows it at once, and
 * undo removes it again. The model id is minted once and reused across undo/redo, so a comment
 * thread or a selection that names it survives.
 */
export class AddAnnotationCommand extends BaseCommand {
  readonly id = COMMAND_ID.addAnnotation;
  readonly label: string;
  private readonly draft: ModelAnnotation;
  private readonly index: number | undefined;
  /** Whether the page's annotations had been loaded before this command ran. */
  private pageWasLoaded = true;

  constructor(doc: Document, annotation: ModelAnnotation, index?: number) {
    super(doc);
    this.draft = annotation;
    this.index = index;
    this.label = `Add ${annotation.subtype.toLowerCase()} annotation`;
  }

  /** The annotation this command adds, with its final model id. */
  get annotationId(): ModelId {
    return this.draft.id;
  }

  async do(): Promise<void> {
    this.pageWasLoaded = this.draft.pageId in this.doc.state.annotations;
    const applied = await createInEngine(this.doc, this.draft);
    if (!applied) this.intend('annotations');
    this.doc.putAnnotation(this.draft, this.index);
  }

  async undo(): Promise<void> {
    const engineId = this.doc.idTable.engineKey('annotation', this.draft.id);
    this.doc.removeAnnotationRecord(this.draft.id);
    // Undoing the first annotation on a page must leave the page unread, not read-and-empty.
    if (!this.pageWasLoaded) this.doc.forgetAnnotations(this.draft.pageId);
    if (engineId !== undefined) {
      await tryEngine(() => this.doc.engine.deleteAnnotation(this.doc.handle, engineId));
      this.doc.idTable.unbind('annotation', this.draft.id);
      shiftBindingsAfterDelete(this.doc, this.draft.pageId, engineId);
    }
  }

  toJSON(): CommandJson {
    return { id: this.id, data: { annotation: this.draft, index: this.index ?? null } };
  }
}

/** Changes an annotation's properties. Merges with the next change of the same annotation. */
export class UpdateAnnotationCommand extends BaseCommand {
  readonly id = COMMAND_ID.updateAnnotation;
  readonly label = 'Edit annotation';
  readonly mergeable = true;
  private readonly annotationId: ModelId;
  private readonly patch: AnnotationPatch;
  private before: ModelAnnotation | null = null;

  constructor(
    doc: Document,
    annotationId: ModelId,
    patch: AnnotationPatch,
    before?: ModelAnnotation | null,
  ) {
    super(doc);
    this.annotationId = annotationId;
    this.patch = patch;
    this.before = before ?? null;
  }

  async do(): Promise<void> {
    const current = this.doc.annotation(this.annotationId);
    if (!current) return;
    this.before ??= current;
    const next = { ...current, ...this.patch } as ModelAnnotation;
    await this.write(next, current);
  }

  async undo(): Promise<void> {
    if (this.before) await this.write(this.before, null);
  }

  /**
   * `previous` is the state this is changing *from* when going forwards, and null when undoing.
   * Only the forward direction records what the writer must redo: an intent describes the change
   * the journal still holds, and undoing takes the command out of the journal.
   */
  private async write(
    annotation: ModelAnnotation,
    previous: ModelAnnotation | null,
  ): Promise<void> {
    const engineId = this.doc.idTable.engineKey('annotation', annotation.id);
    const pageIndex = this.doc.enginePage(annotation.pageId);
    let applied = false;
    if (engineId !== undefined && pageIndex !== undefined) {
      const { page: _page, ...patch } = toEngineAnnotation(annotation, pageIndex);
      applied = await tryEngine(() =>
        this.doc.engine.updateAnnotation(this.doc.handle, engineId, patch),
      );
    }
    // An engine patch says what a field *becomes*, and has no way to say "and clear that one".
    // Emptying a note, a colour or an ink list therefore only happens in the model, and the
    // writer has to redo it — otherwise the cleared value comes back on the next save.
    if (!applied || (previous !== null && clearsAField(previous, annotation))) {
      this.intend('annotations');
    }
    this.doc.putAnnotation(annotation);
  }

  /** Dragging or typing produces a stream of updates; they collapse into one undo entry. */
  merge(next: Command): Command | null {
    if (!(next instanceof UpdateAnnotationCommand)) return null;
    if (next.annotationId !== this.annotationId) return null;
    const merged = new UpdateAnnotationCommand(
      this.doc,
      this.annotationId,
      { ...this.patch, ...next.patch },
      this.before,
    );
    merged.adoptIntents([...this.writeIntents, ...next.writeIntents]);
    return merged;
  }

  toJSON(): CommandJson {
    return { id: this.id, data: { annotationId: this.annotationId, patch: this.patch } };
  }
}

/** Deletes an annotation; undo re-creates it in the engine from the model's record. */
export class DeleteAnnotationCommand extends BaseCommand {
  readonly id = COMMAND_ID.deleteAnnotation;
  readonly label = 'Delete annotation';
  private readonly annotationId: ModelId;
  private removed: { annotation: ModelAnnotation; index: number } | null = null;

  constructor(doc: Document, annotationId: ModelId) {
    super(doc);
    this.annotationId = annotationId;
  }

  async do(): Promise<void> {
    const engineId = this.doc.idTable.engineKey('annotation', this.annotationId);
    const annotation = this.doc.annotation(this.annotationId);
    if (!annotation) return;
    let applied = false;
    if (engineId !== undefined) {
      applied = await tryEngine(() => this.doc.engine.deleteAnnotation(this.doc.handle, engineId));
      this.doc.idTable.unbind('annotation', this.annotationId);
    }
    if (!applied) this.intend('annotations');
    this.removed = this.doc.removeAnnotationRecord(this.annotationId);
    if (applied && engineId !== undefined) {
      shiftBindingsAfterDelete(this.doc, annotation.pageId, engineId);
    }
  }

  async undo(): Promise<void> {
    if (!this.removed) return;
    const { annotation, index } = this.removed;
    const applied = await createInEngine(this.doc, annotation);
    if (!applied) this.intend('annotations');
    this.doc.putAnnotation(annotation, index);
  }

  toJSON(): CommandJson {
    return { id: this.id, data: { annotationId: this.annotationId } };
  }
}

/**
 * Creates an annotation in the engine and binds its model id to the engine's new one. Returns
 * false when the backend cannot create annotations, so the caller records a write intent.
 */
async function createInEngine(doc: Document, annotation: ModelAnnotation): Promise<boolean> {
  const pageIndex = doc.enginePage(annotation.pageId);
  if (pageIndex === undefined) return false;
  try {
    const created = await doc.engine.addAnnotation(
      doc.handle,
      toEngineAnnotation(annotation, pageIndex),
    );
    doc.idTable.bind('annotation', annotation.id, created.id);
    return true;
  } catch (error) {
    if (isUnsupported(error)) return false;
    throw error;
  }
}

/**
 * Whether the change from `before` to `after` empties something the engine patch cannot express.
 * `toEngineAnnotation` omits null fields and empty geometry, because an absent key means "leave
 * this alone" — so a value going to null, or a list going to empty, reaches the model and not the
 * file.
 */
function clearsAField(before: ModelAnnotation, after: ModelAnnotation): boolean {
  const scalars = [
    'contents',
    'author',
    'created',
    'modified',
    'color',
    'interiorColor',
    'opacity',
    'borderWidth',
    'appearanceState',
    'name',
    'subject',
    'state',
  ] as const;
  for (const key of scalars) {
    if (before[key] !== null && after[key] === null) return true;
  }
  const geometry = (a: ModelAnnotation): number =>
    (a.family === 'markup' || a.family === 'link' ? a.quadPoints.length : 0) +
    (a.family === 'ink' ? a.paths.length : 0) +
    (a.family === 'shape' ? a.vertices.length : 0);
  return geometry(before) > 0 && geometry(after) === 0;
}

/** Splits an engine annotation id (`"a2.7"`) into its page and index. */
function parseEngineAnnotationId(id: string): { page: number; index: number } | null {
  const m = /^a(\d+)\.(\d+)$/.exec(id);
  return m ? { page: Number(m[1]), index: Number(m[2]) } : null;
}

/**
 * Repairs the id table after the engine removed the annotation at `removed`.
 *
 * PDFium closes the gap: everything after the removed index shifts down by one. Only the
 * bindings need to move — the model ids do not change, which is the whole point of having them.
 *
 * This shifts by *index arithmetic* rather than by pairing the two lists positionally. They are
 * not in the same order: an annotation restored by undo goes back to its original place in the
 * model while the engine appends it at the end. Pairing by position bound every id after the
 * change to the wrong annotation, so an edit landed on a neighbour and an undo deleted one.
 */
function shiftBindingsAfterDelete(doc: Document, pageId: ModelId, removed: string): void {
  const gone = parseEngineAnnotationId(removed);
  if (!gone) return;
  const moves: { id: ModelId; index: number }[] = [];
  for (const a of doc.annotations(pageId)) {
    const key = doc.idTable.engineKey('annotation', a.id);
    const at = key === undefined ? null : parseEngineAnnotationId(key);
    if (at?.page !== gone.page || at.index <= gone.index) continue;
    moves.push({ id: a.id, index: at.index - 1 });
  }
  // Lowest index first, so each id moves into a slot its previous holder has already left.
  // Sorting numerically, not by id text, or "a0.10" would move before "a0.9".
  moves.sort((x, y) => x.index - y.index);
  for (const { id, index } of moves) {
    doc.idTable.bind('annotation', id, `a${gone.page}.${index}`);
  }
}

// ---- fields, metadata, layers, custom ------------------------------------------------------------

/** Sets a form field's value. Merges, so typing into a field is one undo step. */
export class SetFieldValueCommand extends BaseCommand {
  readonly id = COMMAND_ID.setFieldValue;
  readonly label = 'Change field value';
  readonly mergeable = true;
  private readonly fieldId: ModelId;
  private readonly value: string;
  private before: string | null = null;

  constructor(doc: Document, fieldId: ModelId, value: string, before?: string) {
    super(doc);
    this.fieldId = fieldId;
    this.value = value;
    this.before = before ?? null;
  }

  async do(): Promise<void> {
    const field = this.doc.field(this.fieldId);
    if (!field) return;
    this.before ??= field.value;
    await this.write(this.value);
  }

  async undo(): Promise<void> {
    if (this.before !== null) await this.write(this.before);
  }

  private async write(value: string): Promise<void> {
    const field = this.doc.field(this.fieldId);
    if (!field) return;
    const applied = await tryEngine(() =>
      this.doc.engine.setFieldValue(this.doc.handle, field.name, value),
    );
    if (!applied) this.intend('fields');
    this.doc.setFieldValueRecord(this.fieldId, value);
  }

  merge(next: Command): Command | null {
    if (!(next instanceof SetFieldValueCommand) || next.fieldId !== this.fieldId) return null;
    const merged = new SetFieldValueCommand(
      this.doc,
      this.fieldId,
      next.value,
      this.before ?? undefined,
    );
    merged.adoptIntents([...this.writeIntents, ...next.writeIntents]);
    return merged;
  }

  toJSON(): CommandJson {
    return { id: this.id, data: { fieldId: this.fieldId, value: this.value } };
  }
}

/**
 * Edits the document information dictionary. PDFium has no setter for it, so this is always a
 * model change plus a `metadata` write intent — the writer in M21 applies it.
 */
export class SetMetadataCommand extends BaseCommand {
  readonly id = COMMAND_ID.setMetadata;
  readonly label = 'Change document properties';
  readonly mergeable = true;
  private readonly patch: Readonly<Record<string, string | null>>;
  private before: Record<string, string | null> = {};

  constructor(
    doc: Document,
    patch: Readonly<Record<string, string | null>>,
    before?: Record<string, string | null>,
  ) {
    super(doc);
    this.patch = patch;
    if (before) this.before = before;
  }

  async do(): Promise<void> {
    const meta = this.doc.state.metadata as unknown as Record<string, string | null>;
    if (Object.keys(this.before).length === 0) {
      for (const key of Object.keys(this.patch)) this.before[key] = meta[key] ?? null;
    }
    await this.write(this.patch);
  }

  async undo(): Promise<void> {
    await this.write(this.before);
  }

  private async write(patch: Readonly<Record<string, string | null>>): Promise<void> {
    const applied = await tryEngine(() =>
      this.doc.engine.setMetadata(
        this.doc.handle,
        Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== null)),
      ),
    );
    if (!applied) this.intend('metadata');
    this.doc.setMetadataRecord(patch);
  }

  merge(next: Command): Command | null {
    if (!(next instanceof SetMetadataCommand)) return null;
    // The earlier "before" wins, so undo returns to the value before the whole run of edits.
    const merged = new SetMetadataCommand(
      this.doc,
      { ...this.patch, ...next.patch },
      { ...next.before, ...this.before },
    );
    merged.adoptIntents([...this.writeIntents, ...next.writeIntents]);
    return merged;
  }

  toJSON(): CommandJson {
    return { id: this.id, data: { patch: this.patch } };
  }
}

/** Shows or hides an optional-content group. Model-only in M20; M12 applies it when rendering. */
export class SetLayerVisibleCommand extends BaseCommand {
  readonly id = COMMAND_ID.setLayerVisible;
  readonly label: string;
  private readonly layerId: ModelId;
  private readonly visible: boolean;
  private before = false;

  constructor(doc: Document, layerId: ModelId, visible: boolean) {
    super(doc);
    this.layerId = layerId;
    this.visible = visible;
    this.label = visible ? 'Show layer' : 'Hide layer';
  }

  async do(): Promise<void> {
    const layer = this.doc.layer(this.layerId);
    if (!layer) return;
    this.before = layer.visible;
    await this.write(this.visible);
  }

  async undo(): Promise<void> {
    await this.write(this.before);
  }

  private async write(visible: boolean): Promise<void> {
    const layer = this.doc.layer(this.layerId);
    if (!layer) return;
    const applied = await tryEngine(() =>
      this.doc.engine.setLayerVisible(this.doc.handle, layer.engineId, visible),
    );
    if (!applied) this.intend('layers');
    this.doc.setLayerVisibleRecord(this.layerId, visible);
  }

  toJSON(): CommandJson {
    return { id: this.id, data: { layerId: this.layerId, visible: this.visible } };
  }
}

/**
 * Writes into a module's namespace of `Document.custom`. Modules use this instead of mutating
 * the bag directly, so their state is undoable and lands in the recovery file like everything
 * else.
 */
export class SetCustomCommand extends BaseCommand {
  readonly id = COMMAND_ID.setCustom;
  readonly label: string;
  private readonly namespace: string;
  private readonly values: Readonly<Record<string, unknown>>;
  private before: Readonly<Record<string, unknown>> | null = null;

  constructor(
    doc: Document,
    namespace: string,
    values: Readonly<Record<string, unknown>>,
    label = 'Change settings',
  ) {
    super(doc);
    this.namespace = namespace;
    this.values = values;
    this.label = label;
  }

  do(): Promise<void> {
    // Null means the namespace did not exist, so undo removes it rather than leaving `{}`.
    this.before = this.namespace in this.doc.state.custom ? this.doc.custom(this.namespace) : null;
    this.doc.setCustomRecord(this.namespace, this.values);
    this.intend('custom');
    return Promise.resolve();
  }

  undo(): Promise<void> {
    if (this.before === null) this.doc.deleteCustomRecord(this.namespace);
    else this.doc.replaceCustomRecord(this.namespace, this.before);
    return Promise.resolve();
  }

  toJSON(): CommandJson {
    return { id: this.id, data: { namespace: this.namespace, values: this.values } };
  }
}

// ---- convenience builders ------------------------------------------------------------------------

/**
 * A model annotation ready to be added, with a fresh id and every optional field defaulted.
 * Feature modules (M30, M31) build on this rather than assembling the union by hand.
 */
export function draftAnnotation(
  doc: Document,
  pageId: ModelId,
  source: Omit<Annotation, 'id' | 'page'>,
): ModelAnnotation {
  const id = doc.ids.next('annotation');
  return toModelAnnotation(id, pageId, {
    ...source,
    id: String(id),
    page: Math.max(0, doc.pageIndex(pageId)),
  });
}

/** Default annotation flags: visible, printable, editable — what a new markup annotation gets. */
export const DEFAULT_ANNOTATION_FLAGS: AnnotationFlags = {
  hidden: false,
  print: true,
  noView: false,
  readOnly: false,
  locked: false,
};

/** The size of a page, for `InsertPagesCommand` defaults. Falls back to A4 for an empty model. */
export function defaultPageSize(doc: Document): { width: number; height: number } {
  const first = doc.state.pages[0];
  if (!first) return { width: 595.276, height: 841.89 };
  const size = pageSizeOf(first);
  return { width: size.width, height: size.height };
}

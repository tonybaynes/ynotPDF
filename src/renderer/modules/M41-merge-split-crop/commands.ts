/**
 * M41's own document commands: re-aiming destinations (bookmarks, links, named destinations) at
 * pages that have taken the place of the ones they used to point at.
 *
 * Everything else this module does to an open document is already a command somebody else owns.
 * A crop is M20's `SetPageBoxCommand`. Straightening and flattening replace the pages they touch:
 * M40's `ImportPagesCommand` brings the new ones in and M20's `DeletePagesCommand` takes the old
 * ones out, both inside one `doc.batch`, so Edit ▸ Undo shows one entry and gives back exactly
 * what was there. That leaves one gap — `DeletePagesCommand` correctly points a destination at
 * nothing when its page goes, and here the page has not gone, it has been *replaced* — which is
 * what this file fills.
 *
 * The rules are M20's, and this follows them: the model is the authority, the engine hears about
 * whatever it can express, a `WriteIntent` covers the rest, and `toJSON` is plain data so a
 * recovery file can replay it.
 */

import type { CommandJson } from '@core/Command';
import type { Document, DocumentCommand } from '@core/Document';
import type { ModelId } from '@core/Ids';
import { registerCommandCodec } from '@core/Journal';
import type { ModelField, WriteIntent } from '@core/model';

export const MERGE_COMMAND_ID = {
  repointDestinations: 'page.repointDestinations',
  dropFields: 'form.dropFields',
} as const;

/** One destination and the page it should aim at from now on. */
export interface Repointing {
  readonly destinationId: ModelId;
  /** `null` aims it at nothing, which is what a lost page means. */
  readonly pageId: ModelId | null;
}

/**
 * Aims some destinations at different pages.
 *
 * Used after pages have been replaced by transformed copies: without it, straightening the page
 * a chapter heading points at would silently lose the heading's destination, and the reader
 * would find out months later when a bookmark did nothing.
 *
 * Model-only. A destination is a model entity (M20, ADR 0007) and the engine has no setter for
 * one; M21's writer emits the outline and the named-destination tree from the model, so the
 * `outline` intent is all the writer needs to hear.
 */
export class RepointDestinationsCommand implements DocumentCommand {
  readonly id = MERGE_COMMAND_ID.repointDestinations;
  readonly label: string;
  private readonly doc: Document;
  private readonly entries: ReadonlyArray<Repointing>;
  private before: Repointing[] = [];

  constructor(doc: Document, entries: ReadonlyArray<Repointing>, label = 'Move bookmarks') {
    this.doc = doc;
    this.entries = [...entries];
    this.label = label;
  }

  get writeIntents(): ReadonlyArray<WriteIntent> {
    // Both, because a destination reaches the file twice: inline in an outline item, and by name
    // in `/Names /Dests`. The writer rebuilds each from the model, and it has to rebuild both.
    return ['outline', 'destinations'];
  }

  /** True when this would change nothing; the caller skips it rather than filling the undo stack. */
  get isNoop(): boolean {
    return this.entries.every((entry) => {
      const current = this.doc.destination(entry.destinationId);
      return current === null || current.pageId === entry.pageId;
    });
  }

  do(): Promise<void> {
    this.before = [];
    for (const entry of this.entries) {
      const current = this.doc.destination(entry.destinationId);
      if (!current) continue;
      this.before.push({ destinationId: entry.destinationId, pageId: current.pageId });
      this.doc.setDestinationPageRecord(entry.destinationId, entry.pageId);
    }
    return Promise.resolve();
  }

  undo(): Promise<void> {
    for (const entry of this.before) {
      this.doc.setDestinationPageRecord(entry.destinationId, entry.pageId);
    }
    return Promise.resolve();
  }

  toJSON(): CommandJson {
    return { id: this.id, data: { entries: this.entries, label: this.label } };
  }
}

/** Registers this module's codecs so a recovery file can replay what it did (M21). */
export function registerMergeCodecs(): void {
  registerCommandCodec(MERGE_COMMAND_ID.dropFields, (doc, payload) => {
    const record = asRecord(payload);
    const raw = record['fieldIds'];
    if (!Array.isArray(raw) || !raw.every((id) => typeof id === 'string')) return null;
    const label = record['label'];
    return new DropFieldsCommand(
      doc,
      raw as ModelId[],
      typeof label === 'string' ? label : undefined,
    );
  });

  registerCommandCodec(MERGE_COMMAND_ID.repointDestinations, (doc, payload) => {
    const record = asRecord(payload);
    const raw = record['entries'];
    if (!Array.isArray(raw)) return null;
    const entries = raw.filter(isRepointing);
    if (entries.length !== raw.length) return null;
    const label = record['label'];
    return new RepointDestinationsCommand(
      doc,
      entries,
      typeof label === 'string' ? label : undefined,
    );
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function isRepointing(value: unknown): value is Repointing {
  if (!value || typeof value !== 'object') return false;
  const entry = value as { destinationId?: unknown; pageId?: unknown };
  return (
    typeof entry.destinationId === 'string' &&
    (entry.pageId === null || typeof entry.pageId === 'string')
  );
}

/**
 * Which destinations pointed at pages that are being replaced, and where they should aim now.
 *
 * `replacements` maps an old page id to the page that took its place. A destination whose page
 * has no replacement is left alone: it is on a page that is not being touched.
 */
export function repointingsFor(
  doc: Document,
  replacements: ReadonlyMap<ModelId, ModelId>,
): Repointing[] {
  const out: Repointing[] = [];
  for (const destination of doc.state.destinations) {
    if (destination.pageId === null) continue;
    const replacement = replacements.get(destination.pageId);
    if (replacement === undefined) continue;
    out.push({ destinationId: destination.id, pageId: replacement });
  }
  return out;
}

/**
 * Drops fields that have no widget left on any page.
 *
 * Flattening a form bakes every widget into the page and takes it off; the field itself is a
 * catalogue entry, not a page one, so nothing else removes it, and what would be left is a form
 * whose fields no reader can fill, no viewer draws and every validator complains about.
 *
 * Model-only, with a `fields` write intent. M21's writer prunes the file's own `/AcroForm` of
 * fields no surviving page reaches, so the model and the file agree without this command having
 * to know anything about `/AcroForm`.
 */
export class DropFieldsCommand implements DocumentCommand {
  readonly id = MERGE_COMMAND_ID.dropFields;
  readonly label: string;
  private readonly doc: Document;
  private readonly fieldIds: ReadonlyArray<ModelId>;
  private removed: Array<{ field: ModelField; index: number }> = [];

  constructor(doc: Document, fieldIds: ReadonlyArray<ModelId>, label = 'Remove form fields') {
    this.doc = doc;
    this.fieldIds = [...fieldIds];
    this.label = label;
  }

  get writeIntents(): ReadonlyArray<WriteIntent> {
    return ['fields'];
  }

  get isNoop(): boolean {
    return this.fieldIds.every((id) => this.doc.field(id) === null);
  }

  do(): Promise<void> {
    this.removed = [];
    // Highest index first, so the indexes recorded for the undo stay valid as the list shortens.
    const ordered = [...this.fieldIds].sort(
      (a, b) =>
        this.doc.state.fields.findIndex((f) => f.id === b) -
        this.doc.state.fields.findIndex((f) => f.id === a),
    );
    for (const id of ordered) {
      const gone = this.doc.removeFieldRecord(id);
      if (gone) this.removed.push(gone);
    }
    return Promise.resolve();
  }

  undo(): Promise<void> {
    // Lowest index first, putting each field back where it was.
    for (const { field, index } of [...this.removed].sort((a, b) => a.index - b.index)) {
      this.doc.putFieldRecord(field, index);
    }
    return Promise.resolve();
  }

  toJSON(): CommandJson {
    return { id: this.id, data: { fieldIds: this.fieldIds, label: this.label } };
  }
}

/**
 * Fields with no widget left on any page — what a flatten leaves behind.
 *
 * A whole *branch* has to go, not just its leaves. A radio group is one field with a widget per
 * button, and a dotted name like `address.city` invents a parent to hold its children; drop the
 * leaves and the parent is left holding nothing, which is just as much a field no reader can
 * fill. So a field goes when neither it nor anything under it has a widget left.
 */
export function fieldsWithoutWidgets(doc: Document): ModelId[] {
  const byId = new Map(doc.state.fields.map((field) => [field.id, field]));
  const empty = new Map<ModelId, boolean>();

  const isEmpty = (id: ModelId, depth = 0): boolean => {
    const cached = empty.get(id);
    if (cached !== undefined) return cached;
    const field = byId.get(id);
    // A cycle in the tree would be a model bug, but it must not hang a flatten.
    if (!field || depth > 64) return false;
    empty.set(id, false);
    const answer =
      field.widgets.length === 0 && field.childIds.every((child) => isEmpty(child, depth + 1));
    empty.set(id, answer);
    return answer;
  };

  return doc.state.fields.filter((field) => isEmpty(field.id)).map((field) => field.id);
}

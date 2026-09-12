/**
 * `Journal` — commands as plain data (M20, ADR 0007).
 *
 * Every document change is a `Command`, and every command can describe itself as
 * `{ type, payload }` of JSON values. That single mechanism serves three features:
 *
 * - **Undo/redo** in memory (the `UndoStack` holds the objects, not the data).
 * - **Autosave and crash recovery** (M21): write the journal beside the file, replay it on the
 *   next launch to get the user's unsaved work back.
 * - **Batch and the action wizard** (M120): record a sequence once, replay it over many files.
 *
 * A codec per command type rebuilds a command against a document. A command whose type has no
 * codec serialises as an entry with `replayable: false` rather than vanishing, so a recovery
 * file never silently loses a step: M21 can tell the user "3 of 40 changes could not be
 * restored" instead of restoring the wrong document.
 */

import { COMPOSITE_COMMAND_ID, CompositeCommand, type Command } from './Command';
import {
  AddAnnotationCommand,
  COMMAND_ID,
  DeleteAnnotationCommand,
  DeletePagesCommand,
  InsertPagesCommand,
  MovePageCommand,
  RotatePagesCommand,
  SetCustomCommand,
  SetFieldValueCommand,
  SetLayerVisibleCommand,
  SetMetadataCommand,
  SetPageBoxCommand,
  SetPageLabelCommand,
  UpdateAnnotationCommand,
} from './commands';
import type { Document } from './Document';
import type { ModelId } from './Ids';
import type { ModelAnnotation, PageBoxName } from './model';
import type { PdfRect, Rotation } from '@shared/pdf';

/** The format version written into every journal file. Bump only on a breaking change. */
export const JOURNAL_VERSION = 1;

/** One recorded command. `payload` is JSON; `null` means the command could not describe itself. */
export interface JournalEntry {
  readonly type: string;
  readonly payload: unknown;
}

/** A serialised journal, ready for `JSON.stringify`. */
export interface JournalFile {
  readonly version: number;
  /** The document the journal was recorded against, for a sanity check on recovery. */
  readonly documentId: string;
  /** Path of the document when the journal was written, or null for an unsaved one. */
  readonly path: string | null;
  readonly entries: ReadonlyArray<JournalEntry>;
  /** False when at least one command could not be serialised; a replay will be incomplete. */
  readonly complete: boolean;
}

/** Rebuilds a command of one type from its payload. Returns `null` if the payload is unusable. */
export type CommandCodec = (doc: Document, payload: unknown) => Command | null;

const codecs = new Map<string, CommandCodec>();

/** Registers a codec. Later modules call this for their own command types. */
export function registerCommandCodec(type: string, codec: CommandCodec): void {
  codecs.set(type, codec);
}

/** Whether a command type can be replayed from data. */
export function hasCommandCodec(type: string): boolean {
  return codecs.has(type);
}

/** Every registered command type, sorted (diagnostics and tests). */
export function registeredCommandTypes(): string[] {
  return [...codecs.keys()].sort();
}

// ---- serialising ---------------------------------------------------------------------------------

/** One command as a journal entry. A command without `toJSON` yields a `null` payload. */
export function serialiseCommand(command: Command): JournalEntry {
  const json = command.toJSON?.();
  return json ? { type: json.id, payload: json.data } : { type: command.id, payload: null };
}

/** True when this entry, and everything nested inside it, can be replayed. */
export function isReplayable(entry: JournalEntry): boolean {
  if (entry.payload === null) return false;
  if (entry.type === COMPOSITE_COMMAND_ID) {
    const { children } = entry.payload as { children?: ReadonlyArray<JournalEntry | null> };
    if (!Array.isArray(children)) return false;
    return children.every((c: JournalEntry | null) => c !== null && isReplayable(c));
  }
  return codecs.has(entry.type);
}

/** The whole undo history of a document, oldest first. */
export function serialiseJournal(doc: Document): JournalFile {
  const entries = [...doc.recoveryJournal, ...doc.undo.journal.map(serialiseCommand)];
  return {
    version: JOURNAL_VERSION,
    documentId: doc.id,
    path: doc.state.path,
    entries,
    complete: entries.every(isReplayable),
  };
}

// ---- replaying -----------------------------------------------------------------------------------

/** What a replay did. `applied + skipped === entries.length`. */
export interface ReplayResult {
  readonly applied: number;
  readonly skipped: number;
  /** Types that had no codec, in the order first seen. */
  readonly skippedTypes: ReadonlyArray<string>;
}

/** Rebuilds one entry against a document, or `null` when its type has no codec. */
export function deserialiseCommand(doc: Document, entry: JournalEntry): Command | null {
  if (entry.payload === null) return null;
  if (entry.type === COMPOSITE_COMMAND_ID) {
    const data = entry.payload as {
      id?: unknown;
      label?: unknown;
      children?: ReadonlyArray<JournalEntry | null>;
    };
    if (!Array.isArray(data.children)) return null;
    const children: Command[] = [];
    for (const child of data.children as ReadonlyArray<JournalEntry | null>) {
      if (child === null) return null;
      const c = deserialiseCommand(doc, child);
      if (!c) return null;
      children.push(c);
    }
    return new CompositeCommand(
      typeof data.id === 'string' ? data.id : 'group',
      typeof data.label === 'string' ? data.label : 'Change',
      children,
    );
  }
  const codec = codecs.get(entry.type);
  if (!codec) return null;
  try {
    return codec(doc, entry.payload);
  } catch {
    return null;
  }
}

/**
 * Applies a recorded sequence to a document, in order, through its undo stack — so a recovered
 * document has exactly the history it had before the crash. Entries whose type has no codec are
 * counted and skipped; the caller decides whether that is acceptable.
 */
export async function replayJournal(
  doc: Document,
  entries: ReadonlyArray<JournalEntry>,
): Promise<ReplayResult> {
  let applied = 0;
  const skippedTypes: string[] = [];
  for (const entry of entries) {
    const command = deserialiseCommand(doc, entry);
    if (!command) {
      if (!skippedTypes.includes(entry.type)) skippedTypes.push(entry.type);
      continue;
    }
    // Each recorded entry is one undo step; merging would collapse two of them into one.
    const before = JSON.stringify({ ...doc.state, revision: 0, writeIntents: [] });
    doc.breakMerge();
    await doc.apply(command);
    const after = JSON.stringify({ ...doc.state, revision: 0, writeIntents: [] });
    // Missing lazy targets used to return quietly and were reported as recovered. A completed
    // apply is not evidence that it changed the document. Checkpoints avoid replay altogether;
    // legacy journals and batch callers still need an honest result here.
    if (before !== after) applied++;
    else if (!skippedTypes.includes(entry.type)) skippedTypes.push(entry.type);
  }
  return { applied, skipped: entries.length - applied, skippedTypes };
}

/** Parses a journal file, returning `null` when it is not one we understand. */
export function parseJournal(text: string): JournalFile | null {
  try {
    const data = JSON.parse(text) as Partial<JournalFile>;
    if (data.version !== JOURNAL_VERSION || !Array.isArray(data.entries)) return null;
    return {
      version: JOURNAL_VERSION,
      documentId: typeof data.documentId === 'string' ? data.documentId : '',
      path: typeof data.path === 'string' ? data.path : null,
      entries: data.entries,
      complete: data.complete !== false,
    };
  } catch {
    return null;
  }
}

// ---- codecs for the built-in commands -------------------------------------------------------------

/** Narrowing helpers. A payload that fails one of these makes the entry unreplayable. */
const asRecord = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
const asString = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const asNumber = (v: unknown): number | null => (typeof v === 'number' ? v : null);
const asId = (v: unknown): ModelId | null => (typeof v === 'string' ? (v as ModelId) : null);
const asIds = (v: unknown): ModelId[] | null =>
  Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as ModelId[]) : null;
const asRect = (v: unknown): PdfRect | null => {
  const r = asRecord(v);
  return typeof r['x0'] === 'number' &&
    typeof r['y0'] === 'number' &&
    typeof r['x1'] === 'number' &&
    typeof r['y1'] === 'number'
    ? (r as unknown as PdfRect)
    : null;
};

registerCommandCodec(COMMAND_ID.rotatePages, (doc, payload) => {
  const p = asRecord(payload);
  const pageIds = asIds(p['pageIds']);
  const rotation = asNumber(p['rotation']);
  if (!pageIds || rotation === null) return null;
  return new RotatePagesCommand(doc, pageIds, rotation as Rotation, p['relative'] === true);
});

registerCommandCodec(COMMAND_ID.insertPages, (doc, payload) => {
  const p = asRecord(payload);
  const at = asNumber(p['at']);
  const count = asNumber(p['count']);
  const size = asRecord(p['size']);
  const width = asNumber(size['width']);
  const height = asNumber(size['height']);
  if (at === null || count === null || width === null || height === null) return null;
  // Reuse the recorded ids, and reserve them so a later allocation cannot collide.
  const ids = asIds(p['ids']) ?? [];
  for (const id of ids) doc.ids.reserve(id);
  return new InsertPagesCommand(doc, at, count, { width, height }, ids);
});

registerCommandCodec(COMMAND_ID.deletePages, (doc, payload) => {
  const pageIds = asIds(asRecord(payload)['pageIds']);
  return pageIds ? new DeletePagesCommand(doc, pageIds) : null;
});

registerCommandCodec(COMMAND_ID.movePage, (doc, payload) => {
  const p = asRecord(payload);
  const pageId = asId(p['pageId']);
  const to = asNumber(p['to']);
  return pageId && to !== null ? new MovePageCommand(doc, pageId, to) : null;
});

registerCommandCodec(COMMAND_ID.setPageBox, (doc, payload) => {
  const p = asRecord(payload);
  const pageId = asId(p['pageId']);
  const box = asString(p['box']);
  const rect = asRect(p['rect']);
  if (!pageId || !box || !rect) return null;
  return new SetPageBoxCommand(doc, pageId, box as PageBoxName, rect);
});

registerCommandCodec(COMMAND_ID.setPageLabel, (doc, payload) => {
  const p = asRecord(payload);
  const pageId = asId(p['pageId']);
  const value = asString(p['value']);
  return pageId && value !== null ? new SetPageLabelCommand(doc, pageId, value) : null;
});

registerCommandCodec(COMMAND_ID.addAnnotation, (doc, payload) => {
  const p = asRecord(payload);
  const annotation = p['annotation'];
  if (!annotation || typeof annotation !== 'object') return null;
  const model = annotation as ModelAnnotation;
  doc.ids.reserve(model.id);
  const index = asNumber(p['index']) ?? undefined;
  return new AddAnnotationCommand(doc, model, index);
});

registerCommandCodec(COMMAND_ID.updateAnnotation, (doc, payload) => {
  const p = asRecord(payload);
  const annotationId = asId(p['annotationId']);
  const patch = p['patch'];
  if (!annotationId || !patch || typeof patch !== 'object') return null;
  return new UpdateAnnotationCommand(doc, annotationId, patch);
});

registerCommandCodec(COMMAND_ID.deleteAnnotation, (doc, payload) => {
  const annotationId = asId(asRecord(payload)['annotationId']);
  return annotationId ? new DeleteAnnotationCommand(doc, annotationId) : null;
});

registerCommandCodec(COMMAND_ID.setFieldValue, (doc, payload) => {
  const p = asRecord(payload);
  const fieldId = asId(p['fieldId']);
  const value = asString(p['value']);
  return fieldId && value !== null ? new SetFieldValueCommand(doc, fieldId, value) : null;
});

registerCommandCodec(COMMAND_ID.setMetadata, (doc, payload) => {
  const patch = asRecord(payload)['patch'];
  if (!patch || typeof patch !== 'object') return null;
  return new SetMetadataCommand(doc, patch as Record<string, string | null>);
});

registerCommandCodec(COMMAND_ID.setLayerVisible, (doc, payload) => {
  const p = asRecord(payload);
  const layerId = asId(p['layerId']);
  if (!layerId || typeof p['visible'] !== 'boolean') return null;
  return new SetLayerVisibleCommand(doc, layerId, p['visible']);
});

registerCommandCodec(COMMAND_ID.setCustom, (doc, payload) => {
  const p = asRecord(payload);
  const namespace = asString(p['namespace']);
  const values = p['values'];
  if (!namespace || !values || typeof values !== 'object') return null;
  return new SetCustomCommand(doc, namespace, values as Record<string, unknown>);
});

/**
 * Turning what the engine read into the portfolio model (M42, ADR 0014).
 *
 * Pure, and deliberately forgiving: portfolios in the wild are written by four editors and two
 * of them get parts of it wrong. A file with no `/Folders` still has a root; a schema with no
 * order column gets one; a name-tree key with no `<n>` prefix is a file at the top level; a
 * `/Sort` naming a column that is not in the schema is dropped rather than obeyed.
 */

import type { Attachment, PdfCollection } from '@engine/PdfEngine';
import {
  columnKindOf,
  emptyPortfolio,
  isCustom,
  KNOWN_ORDER_KEYS,
  ORDER_KEY,
  orderColumn,
  parseTreeKey,
  rootFolder,
  ROOT_FOLDER_ID,
  STANDARD_COLUMNS,
  treeKey,
  type Portfolio,
  type PortfolioColumn,
  type PortfolioFile,
  type PortfolioFolder,
} from '@shared/portfolio';

/**
 * The portfolio a document holds, or null when it is not one.
 *
 * `attachments` are the engine's, not the model's, because only they carry the name-tree key —
 * and the key is both what says which folder a file is in and what the writer matches on to
 * reuse the stream untouched.
 */
export function portfolioFrom(
  collection: PdfCollection | null,
  attachments: ReadonlyArray<Attachment>,
): Portfolio | null {
  if (collection === null) return null;
  const empty = emptyPortfolio();
  const schema = readSchema(collection);
  const orderKey = pickOrderKey(collection, schema);
  const columns = schema.some((c) => c.key === orderKey)
    ? schema
    : [...schema, orderColumn(orderKey)];

  const folders = readFolders(collection);
  const known = new Set(folders.map((f) => f.id));
  const files: PortfolioFile[] = [];
  // Embedded files only: a FileAttachment annotation belongs to a page, not to the collection.
  const embedded = attachments.filter((a) => a.page === undefined);
  embedded.forEach((attachment, index) => {
    const key = attachment.treeKey ?? treeKey(attachment.name, ROOT_FOLDER_ID);
    const folderId = attachment.folderId ?? ROOT_FOLDER_ID;
    const fields = { ...(attachment.collectionFields ?? {}) };
    const stated = Number(fields[orderKey]);
    files.push({
      id: key,
      name: attachment.name,
      // A key naming a folder the tree does not have would strand the file; the root always
      // exists, and a file a reader can see beats one that is only in the bytes.
      folderId: known.has(folderId) ? folderId : ROOT_FOLDER_ID,
      description: attachment.description ?? null,
      mimeType: attachment.mimeType ?? null,
      size: attachment.size ?? null,
      created: attachment.created ?? null,
      modified: attachment.modified ?? null,
      fields,
      order: Number.isFinite(stated) ? stated : index,
      source: { kind: 'embedded', treeKey: key },
    });
  });
  // Two files claiming the same order — or a file with none — must still land somewhere
  // definite, or "move up" would swap a pair that looks identical to it.
  const ordered = [...files].sort((a, b) => a.order - b.order);
  const renumbered = new Map(ordered.map((file, i) => [file.id, i]));

  const sort =
    collection.sort && columns.some((c) => c.key === collection.sort?.key)
      ? { key: collection.sort.key, ascending: collection.sort.ascending }
      : { key: orderKey, ascending: true };

  return {
    view: collection.view === 'custom' ? empty.view : collection.view,
    schema: columns,
    sort,
    // `/D` is a name-tree key (`<0>name`), or a bare name in a file that keys without folders.
    initialFile:
      collection.initialFile === undefined ? null : parseTreeKey(collection.initialFile).name,
    folders,
    files: files.map((f) => ({ ...f, order: renumbered.get(f.id) ?? f.order })),
    orderKey,
    generatedCover: false,
  };
}

/** The schema as columns, falling back to the standard six when the file declares none. */
function readSchema(collection: PdfCollection): PortfolioColumn[] {
  if (collection.fields.length === 0) return [...STANDARD_COLUMNS];
  return collection.fields.map((field) => ({
    key: field.key,
    label: field.label,
    kind: columnKindOf(field.kind),
    order: field.order,
    visible: field.visible,
  }));
}

/**
 * Which column carries the reader's order. `/Reorder` says so outright; otherwise a column we
 * recognise by name is used, so a portfolio Foxit made keeps ordering on Foxit's own key rather
 * than growing a second one beside it.
 */
function pickOrderKey(collection: PdfCollection, schema: ReadonlyArray<PortfolioColumn>): string {
  const reorder = collection.reorderKey;
  if (reorder !== undefined && schema.some((c) => c.key === reorder)) return reorder;
  const known = KNOWN_ORDER_KEYS.find((key) => schema.some((c) => c.key === key && isCustom(c)));
  return known ?? ORDER_KEY;
}

/** The folder tree, always with a root, and always without a cycle. */
function readFolders(collection: PdfCollection): PortfolioFolder[] {
  const raw = collection.folders ?? [];
  const out: PortfolioFolder[] = [];
  const seen = new Set<number>();
  for (const folder of raw) {
    if (seen.has(folder.id)) continue;
    seen.add(folder.id);
    out.push({
      id: folder.id,
      name: folder.name,
      parentId: folder.parentId,
      description: folder.description ?? null,
      created: folder.created ?? null,
      modified: folder.modified ?? null,
    });
  }
  const root = out.find((f) => f.parentId === null);
  if (!root) return [rootFolder(), ...out.map((f) => reparent(f, out))];
  return out.map((f) => (f === root ? f : reparent(f, out)));
}

/** A folder whose parent is missing hangs off the root rather than disappearing. */
function reparent(folder: PortfolioFolder, all: ReadonlyArray<PortfolioFolder>): PortfolioFolder {
  if (folder.parentId !== null && all.some((f) => f.id === folder.parentId)) return folder;
  return folder.parentId === null ? folder : { ...folder, parentId: ROOT_FOLDER_ID };
}

/**
 * The PDF Portfolio model (M42, ADR 0014) — the one shape four layers agree on.
 *
 * A portfolio is a `/Collection` dictionary in the catalogue plus the `/EmbeddedFiles` name
 * tree, and (PDF 2.0 / Acrobat 9, which Foxit writes and reads) a `/Folders` tree of folder
 * dictionaries. The engine reads it, the renderer edits it, `FullRewriteWriter` writes it and
 * M120 will drive it from a batch op — so the structure lives here rather than in any one of
 * them.
 *
 * **Types and pure functions only.** No I/O, no DOM, no pdf-lib: this file is imported from
 * main, from the engine Worker and from the renderer alike.
 *
 * Two conventions in the format are worth knowing before reading the code:
 *
 * - **Folder membership is the name-tree key prefix.** The specification gives folders their
 *   own tree but puts no folder reference on a file specification; Acrobat and Foxit both key
 *   the entry as `<ID>name`, where `ID` is the folder's `/ID`. A key with no prefix is a file
 *   in the root, which is also what an ordinary attachment looks like.
 * - **Order is a schema column.** There is no `/Order` array. A viewer shows the files in the
 *   order its sort column says, so "move up" writes a number into a custom column and points
 *   `/Sort` at it. Foxit calls that column `foxit:Order`; we keep whichever key the file
 *   already uses and create {@link ORDER_KEY} when it has none.
 */

/** The root folder's `/ID`. Every portfolio has one, even when it shows no folders. */
export const ROOT_FOLDER_ID = 0;

/** The custom schema column we create to persist the file order. Hidden in the grid. */
export const ORDER_KEY = 'ynot:Order';

/** Key of the order column a file already uses, if we recognise it. */
export const KNOWN_ORDER_KEYS: ReadonlyArray<string> = [ORDER_KEY, 'foxit:Order'];

/** `/View` — how a viewer shows the portfolio when it opens. */
export type PortfolioView = 'details' | 'tile' | 'hidden';

/**
 * What a schema column shows. The first six read a property of the file itself; the last three
 * are a custom string, date or number whose value is in each file specification's `/CI`.
 */
export type ColumnKind =
  | 'name'
  | 'description'
  | 'created'
  | 'modified'
  | 'size'
  | 'compressedSize'
  | 'text'
  | 'date'
  | 'number';

/** Column kinds an operator may add; the rest describe the file and cannot be duplicated. */
export const CUSTOM_KINDS: ReadonlyArray<ColumnKind> = ['text', 'date', 'number'];

/** One `/Schema` column. */
export interface PortfolioColumn {
  /** Key in `/Schema` and in each file's `/CI`. */
  readonly key: string;
  /** `/N` — the column heading. */
  readonly label: string;
  readonly kind: ColumnKind;
  /** `/O` — lower first. */
  readonly order: number;
  /** `/V` — false hides the column. */
  readonly visible: boolean;
}

/** One folder. The root is `id === ROOT_FOLDER_ID` and is the only one with `parentId === null`. */
export interface PortfolioFolder {
  readonly id: number;
  readonly name: string;
  readonly parentId: number | null;
  readonly description: string | null;
  /** ISO 8601. */
  readonly created: string | null;
  readonly modified: string | null;
}

/**
 * Where a file's bytes are.
 *
 * `embedded` means the document already holds the stream, named by its name-tree key: the
 * writer reuses that object untouched, which is what keeps a signed PDF inside a portfolio
 * valid across a save. `added` means this session brought the bytes in; the service holds them
 * by `fileId` and the writer creates the stream once.
 */
export type FileSource =
  { readonly kind: 'embedded'; readonly treeKey: string } | { readonly kind: 'added' };

/** One file in the portfolio. */
export interface PortfolioFile {
  /** Stable for the life of the document in this session. Never written to the file. */
  readonly id: string;
  /** The name a reader sees, with no folder prefix. Unique within its folder. */
  readonly name: string;
  readonly folderId: number;
  readonly description: string | null;
  readonly mimeType: string | null;
  /** Uncompressed size in bytes, as `/Params /Size` states it. */
  readonly size: number | null;
  /** ISO 8601. */
  readonly created: string | null;
  readonly modified: string | null;
  /** Values of the custom schema columns, keyed by column key. */
  readonly fields: Readonly<Record<string, string>>;
  /** Position in the reader's order, ascending. Persisted through the order column. */
  readonly order: number;
  readonly source: FileSource;
}

/** `/Sort` — the column a viewer orders on, and which way. */
export interface PortfolioSort {
  readonly key: string;
  readonly ascending: boolean;
}

/** A whole portfolio, as the document model holds it. */
export interface Portfolio {
  readonly view: PortfolioView;
  readonly schema: ReadonlyArray<PortfolioColumn>;
  readonly sort: PortfolioSort | null;
  /** `/D` — name of the file a viewer shows first. Matched against {@link PortfolioFile.name}. */
  readonly initialFile: string | null;
  /** Always contains the root; children follow in creation order. */
  readonly folders: ReadonlyArray<PortfolioFolder>;
  readonly files: ReadonlyArray<PortfolioFile>;
  /** Which schema column carries {@link PortfolioFile.order}. */
  readonly orderKey: string;
  /** Whether the document's own pages are a cover sheet this module generated. */
  readonly generatedCover: boolean;
}

/** The six standard columns, in the order Foxit writes them. */
export const STANDARD_COLUMNS: ReadonlyArray<PortfolioColumn> = [
  { key: 'FileName', label: 'Name', kind: 'name', order: 0, visible: true },
  { key: 'Description', label: 'Description', kind: 'description', order: 1, visible: true },
  { key: 'CreationDate', label: 'Created', kind: 'created', order: 2, visible: true },
  { key: 'ModDate', label: 'Modified', kind: 'modified', order: 3, visible: true },
  { key: 'Size', label: 'Size', kind: 'size', order: 4, visible: true },
  {
    key: 'CompressedSize',
    label: 'Compressed size',
    kind: 'compressedSize',
    order: 5,
    visible: false,
  },
];

/** The order column, which exists so the reader's own order survives a save. */
export function orderColumn(key: string = ORDER_KEY): PortfolioColumn {
  return { key, label: 'Order', kind: 'number', order: 90, visible: false };
}

/** A new, empty portfolio: the standard columns, one root folder, no files. */
export function emptyPortfolio(): Portfolio {
  return {
    view: 'details',
    schema: [...STANDARD_COLUMNS, orderColumn()],
    sort: { key: ORDER_KEY, ascending: true },
    initialFile: null,
    folders: [rootFolder()],
    files: [],
    orderKey: ORDER_KEY,
    generatedCover: false,
  };
}

export function rootFolder(): PortfolioFolder {
  return {
    id: ROOT_FOLDER_ID,
    name: '',
    parentId: null,
    description: null,
    created: null,
    modified: null,
  };
}

// ---- the name-tree key ------------------------------------------------------------------------

/** The `/EmbeddedFiles` key for a file: `<folderId>name`, the convention Acrobat and Foxit use. */
export function treeKey(name: string, folderId: number): string {
  return `<${String(folderId)}>${name}`;
}

/** Splits a name-tree key. A key with no `<n>` prefix is a file in the root folder. */
export function parseTreeKey(key: string): { readonly name: string; readonly folderId: number } {
  const match = /^<(\d+)>(.*)$/s.exec(key);
  if (!match?.[1] || match[2] === undefined) return { name: key, folderId: ROOT_FOLDER_ID };
  return { name: match[2], folderId: Number(match[1]) };
}

// ---- the folder tree --------------------------------------------------------------------------

export function folderById(portfolio: Portfolio, id: number): PortfolioFolder | null {
  return portfolio.folders.find((f) => f.id === id) ?? null;
}

/** Direct children of a folder, in creation order. */
export function childFolders(
  portfolio: Portfolio,
  parentId: number,
): ReadonlyArray<PortfolioFolder> {
  return portfolio.folders.filter((f) => f.parentId === parentId);
}

/** Every folder below `id`, deepest last. Cycles in a malformed file terminate the walk. */
export function descendantFolders(
  portfolio: Portfolio,
  id: number,
): ReadonlyArray<PortfolioFolder> {
  const out: PortfolioFolder[] = [];
  const seen = new Set<number>([id]);
  const queue = [id];
  while (queue.length > 0) {
    const next = queue.shift();
    if (next === undefined) break;
    for (const child of childFolders(portfolio, next)) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      out.push(child);
      queue.push(child.id);
    }
  }
  return out;
}

/** A folder's path from the root, `/`-joined. The root itself is `""`. */
export function folderPath(portfolio: Portfolio, id: number): string {
  const parts: string[] = [];
  const seen = new Set<number>();
  let current = folderById(portfolio, id);
  while (current?.parentId != null && !seen.has(current.id)) {
    seen.add(current.id);
    parts.unshift(current.name);
    current = folderById(portfolio, current.parentId);
  }
  return parts.join('/');
}

/** The path a file extracts to, relative to the chosen directory. */
export function filePath(portfolio: Portfolio, file: PortfolioFile): string {
  const dir = folderPath(portfolio, file.folderId);
  return dir === '' ? file.name : `${dir}/${file.name}`;
}

/** An id no folder in this portfolio uses. */
export function nextFolderId(portfolio: Portfolio): number {
  return portfolio.folders.reduce((max, f) => Math.max(max, f.id), ROOT_FOLDER_ID) + 1;
}

/** Files directly in a folder, in the portfolio's own order. */
export function filesInFolder(
  portfolio: Portfolio,
  folderId: number,
): ReadonlyArray<PortfolioFile> {
  return portfolio.files.filter((f) => f.folderId === folderId).sort((a, b) => a.order - b.order);
}

// ---- names ------------------------------------------------------------------------------------

/**
 * `name`, or `name (2)` and upwards, so that no two files in one folder share a name. The name
 * tree cannot hold a duplicate key, so this is correctness rather than tidiness.
 */
export function uniqueName(taken: Iterable<string>, name: string): string {
  const used = new Set<string>();
  for (const t of taken) used.add(t.toLowerCase());
  if (!used.has(name.toLowerCase())) return name;
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let n = 2; n < 10000; n++) {
    const candidate = `${stem} (${String(n)})${ext}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
  return `${stem} (${String(Date.now())})${ext}`;
}

/** The names already used in a folder, optionally ignoring one file (a rename). */
export function namesInFolder(
  portfolio: Portfolio,
  folderId: number,
  exceptFileId?: string,
): ReadonlyArray<string> {
  return portfolio.files
    .filter((f) => f.folderId === folderId && f.id !== exceptFileId)
    .map((f) => f.name);
}

// ---- columns ----------------------------------------------------------------------------------

export function columnByKey(portfolio: Portfolio, key: string): PortfolioColumn | null {
  return portfolio.schema.find((c) => c.key === key) ?? null;
}

/** Columns a reader sees, in `/O` order. */
export function visibleColumns(portfolio: Portfolio): ReadonlyArray<PortfolioColumn> {
  return [...portfolio.schema]
    .filter((c) => c.visible)
    .sort((a, b) => a.order - b.order || a.key.localeCompare(b.key));
}

/** True when the column holds a value of its own rather than describing the file. */
export function isCustom(column: PortfolioColumn): boolean {
  return CUSTOM_KINDS.includes(column.kind);
}

/**
 * The value of one column for one file, as a sortable primitive: a number for sizes, dates and
 * number columns, a string for the rest. `null` when the file has nothing for it.
 */
export function columnValue(file: PortfolioFile, column: PortfolioColumn): string | number | null {
  switch (column.kind) {
    case 'name':
      return file.name;
    case 'description':
      return file.description;
    case 'created':
      return dateValue(file.created);
    case 'modified':
      return dateValue(file.modified);
    case 'size':
    case 'compressedSize':
      return file.size;
    case 'text':
      return file.fields[column.key] ?? null;
    case 'date':
      return dateValue(file.fields[column.key] ?? null);
    case 'number': {
      const raw = file.fields[column.key];
      if (raw === undefined || raw === '') return null;
      const n = Number(raw);
      return Number.isFinite(n) ? n : raw;
    }
  }
}

function dateValue(iso: string | null): number | null {
  if (iso === null || iso === '') return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

/**
 * Files in the order the grid shows them: the sort column when one is set, the portfolio's own
 * order when it is not. Files with no value for the column sort last whichever way the arrow
 * points, which is what a reader expects of an empty cell.
 */
export function sortedFiles(
  portfolio: Portfolio,
  files: ReadonlyArray<PortfolioFile> = portfolio.files,
): ReadonlyArray<PortfolioFile> {
  const sort = portfolio.sort;
  const column = sort ? columnByKey(portfolio, sort.key) : null;
  const list = [...files];
  if (!sort || !column || column.key === portfolio.orderKey) {
    list.sort((a, b) => a.order - b.order);
    return sort?.ascending === false ? list.reverse() : list;
  }
  const direction = sort.ascending ? 1 : -1;
  list.sort((a, b) => {
    const va = columnValue(a, column);
    const vb = columnValue(b, column);
    if (va === null && vb === null) return a.order - b.order;
    if (va === null) return 1;
    if (vb === null) return -1;
    if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * direction;
    return String(va).localeCompare(String(vb), 'en-GB', { numeric: true }) * direction;
  });
  return list;
}

// ---- edits (pure: every one returns a new portfolio) --------------------------------------------

/** Replaces one file, matched by id. Unknown ids are left alone. */
export function withFile(portfolio: Portfolio, file: PortfolioFile): Portfolio {
  return { ...portfolio, files: portfolio.files.map((f) => (f.id === file.id ? file : f)) };
}

/** Adds files at the end of the reader's order. */
export function withFilesAdded(
  portfolio: Portfolio,
  files: ReadonlyArray<PortfolioFile>,
): Portfolio {
  return { ...portfolio, files: [...portfolio.files, ...files] };
}

export function withoutFile(portfolio: Portfolio, fileId: string): Portfolio {
  return { ...portfolio, files: portfolio.files.filter((f) => f.id !== fileId) };
}

/** The next free order number. */
export function nextOrder(portfolio: Portfolio): number {
  return portfolio.files.reduce((max, f) => Math.max(max, f.order), -1) + 1;
}

/**
 * Renumbers `order` from 0 in the given sequence, which is what a drag or a "move up" produces.
 * Files not in `ids` keep their relative order after the ones that are.
 */
export function reordered(portfolio: Portfolio, ids: ReadonlyArray<string>): Portfolio {
  const rank = new Map(ids.map((id, i) => [id, i]));
  const rest = [...portfolio.files]
    .filter((f) => !rank.has(f.id))
    .sort((a, b) => a.order - b.order);
  const sequence = [
    ...ids.map((id) => portfolio.files.find((f) => f.id === id)).filter(isFile),
    ...rest,
  ];
  return { ...portfolio, files: sequence.map((f, i) => ({ ...f, order: i })) };
}

function isFile(f: PortfolioFile | undefined): f is PortfolioFile {
  return f !== undefined;
}

/** A copy of a file's column values without one key. */
export function withoutField(
  fields: Readonly<Record<string, string>>,
  key: string,
): Readonly<Record<string, string>> {
  return Object.fromEntries(Object.entries(fields).filter(([k]) => k !== key));
}

/** The order column's value for a file, as the `/CI` entry the writer stores. */
export function orderFields(
  file: PortfolioFile,
  orderKey: string,
): Readonly<Record<string, string>> {
  return { ...file.fields, [orderKey]: String(file.order) };
}

// ---- describing a portfolio in words -----------------------------------------------------------

/** "3 files in 2 folders", for a status line or a toast. Always a whole sentence fragment. */
export function describePortfolio(portfolio: Portfolio): string {
  const files = portfolio.files.length;
  const folders = portfolio.folders.filter((f) => f.parentId !== null).length;
  const filePart = files === 1 ? '1 file' : `${String(files)} files`;
  if (folders === 0) return filePart;
  return `${filePart} in ${folders === 1 ? '1 folder' : `${String(folders)} folders`}`;
}

/** Total uncompressed size of every file, or null when no file states one. */
export function totalSize(portfolio: Portfolio): number | null {
  let total = 0;
  let known = false;
  for (const file of portfolio.files) {
    if (file.size === null) continue;
    known = true;
    total += file.size;
  }
  return known ? total : null;
}

// ---- where a document keeps it -----------------------------------------------------------------

/** M42's namespace in the document's custom bag (ADR 0014). */
export const PORTFOLIO_NAMESPACE = 'M42';

/** Key of the {@link Portfolio} inside that namespace. */
export const PORTFOLIO_KEY = 'portfolio';

/**
 * The portfolio a document carries, or null for an ordinary file. Takes the bag rather than the
 * document so the writer's plan builder can read it without importing the module.
 */
export function portfolioOf(bag: Readonly<Record<string, unknown>>): Portfolio | null {
  const value = bag[PORTFOLIO_KEY];
  if (value === null || typeof value !== 'object') return null;
  const portfolio = value as Partial<Portfolio>;
  return Array.isArray(portfolio.files) && Array.isArray(portfolio.folders)
    ? (value as Portfolio)
    : null;
}

/** Key under which `Document.blobs` holds the bytes of a file added in this session. */
export function blobKey(fileId: string): string {
  return `${PORTFOLIO_NAMESPACE}:file:${fileId}`;
}

/** The `/Subtype` name a schema column of this kind is written with (PDF 12.3.5). */
export const COLUMN_SUBTYPE: Readonly<Record<ColumnKind, string>> = {
  name: 'F',
  description: 'Desc',
  created: 'CreationDate',
  modified: 'ModDate',
  size: 'Size',
  compressedSize: 'CompressedSize',
  text: 'S',
  date: 'D',
  number: 'N',
};

/** The column kind a `/Subtype` name means; anything unknown is a custom string column. */
export function columnKindOf(subtype: string): ColumnKind {
  const found = (Object.keys(COLUMN_SUBTYPE) as ColumnKind[]).find(
    (kind) => COLUMN_SUBTYPE[kind] === subtype,
  );
  return found ?? 'text';
}

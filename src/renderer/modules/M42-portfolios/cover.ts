/**
 * The generated cover sheet (M42, ADR 0014).
 *
 * A portfolio's own pages are its cover: the page a reader sees in an application that cannot
 * show portfolios, and the page that gets printed. This draws one, with pdf-lib and the standard
 * fonts, from `resources/portfolio/cover-template.json` — wording, sizes, margins and which
 * columns the contents table lists are all in that file, per the project's rule that anything
 * which can change is data rather than code.
 *
 * Pure and deterministic apart from the date it is given, so it can be unit-tested and run in a
 * batch action. Drawing it rather than printing HTML through Chromium is decision 6 of ADR 0014.
 */

import { PDFDocument, StandardFonts, type PDFFont, type PDFPage } from 'pdf-lib';
import { marginsToPoints, resolvePageSize } from '@shared/pageSizes';
import type { MarginsMm, Orientation, PageSizeChoice } from '@shared/create';
import {
  columnValue,
  describePortfolio,
  filePath,
  sortedFiles,
  STANDARD_COLUMNS,
  totalSize,
  type ColumnKind,
  type Portfolio,
  type PortfolioColumn,
} from '@shared/portfolio';
import template from '../../../../resources/portfolio/cover-template.json';

/** One line of text on the cover. `text: ""` leaves the line out entirely. */
interface TextBlock {
  readonly text: string;
  readonly size: number;
  readonly bold: boolean;
  readonly gapAfter: number;
}

interface TableColumn {
  readonly key: string;
  readonly label: string;
  readonly width: number;
  readonly align?: string;
}

export interface CoverTemplate {
  readonly page: {
    readonly size: string;
    readonly orientation: string;
    readonly margins: MarginsMm;
  };
  readonly title: TextBlock;
  readonly subtitle: TextBlock;
  readonly date: TextBlock;
  readonly intro: TextBlock;
  readonly table: {
    readonly columns: ReadonlyArray<TableColumn>;
    readonly headerSize: number;
    readonly rowSize: number;
    readonly rowGap: number;
    readonly rule: boolean;
  };
  readonly footer: TextBlock;
}

/** The template as shipped. Exported so a test can vary it without touching the file. */
export const COVER_TEMPLATE = template as unknown as CoverTemplate;

export interface CoverOptions {
  /** Shown as the heading. The document's title, or the file name. */
  readonly title: string;
  /** The reader's own line under it; empty leaves it out. */
  readonly subtitle?: string;
  /** The date the sheet says it was prepared. Defaults to now. */
  readonly date?: Date;
  readonly template?: CoverTemplate;
}

/**
 * A one-page PDF listing every file in the portfolio, in the reader's own order.
 *
 * The list may be longer than a page. It is not paginated: a cover sheet is one page by
 * definition, so when the files run past the bottom margin the last line says how many are not
 * shown rather than silently stopping. Saying so is the point — a cover that quietly omitted
 * four files would be worse than one that admits it.
 */
export async function generateCover(
  portfolio: Portfolio,
  options: CoverOptions,
): Promise<Uint8Array> {
  const t = options.template ?? COVER_TEMPLATE;
  const doc = await PDFDocument.create();
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const font = (isBold: boolean): PDFFont => (isBold ? bold : regular);

  const choice: PageSizeChoice = { kind: 'preset', id: t.page.size };
  const size = resolvePageSize(choice, t.page.orientation as Orientation);
  const page = doc.addPage([size.width, size.height]);
  const margins = marginsToPoints(t.page.margins, size);
  const left = margins.left;
  const right = size.width - margins.right;
  const width = right - left;
  let y = size.height - margins.top;

  const values = placeholders(portfolio, options);
  const line = (block: TextBlock): void => {
    const text = fill(block.text, values);
    if (text === '') return;
    for (const row of wrap(text, font(block.bold), block.size, width)) {
      y -= block.size * 1.2;
      draw(page, row, left, y, block.size, font(block.bold));
    }
    y -= block.gapAfter;
  };

  line(t.title);
  line(t.subtitle);
  line(t.date);
  line(t.intro);

  // ---- the contents table ---------------------------------------------------------------------
  const columns = resolveColumns(portfolio, t.table.columns, width);
  y -= t.table.headerSize * 1.2;
  for (const column of columns) {
    draw(page, column.label, column.x, y, t.table.headerSize, bold, column.width, column.right);
  }
  y -= 4;
  if (t.table.rule) {
    page.drawLine({ start: { x: left, y }, end: { x: right, y }, thickness: 0.75 });
  }

  const files = sortedFiles(portfolio);
  const rowHeight = t.table.rowSize * 1.25 + t.table.rowGap;
  const footerRoom = t.footer.text === '' ? 0 : t.footer.size * 2.4;
  let shown = 0;
  for (const file of files) {
    if (y - rowHeight < margins.bottom + footerRoom + rowHeight) break;
    y -= rowHeight;
    for (const column of columns) {
      const text = cellText(portfolio, file, column.kind, column.key);
      draw(page, text, column.x, y, t.table.rowSize, regular, column.width, column.right);
    }
    shown++;
  }
  if (shown < files.length) {
    y -= rowHeight;
    const missing = files.length - shown;
    const text = `… and ${String(missing)} more ${missing === 1 ? 'file' : 'files'}, listed in the portfolio itself.`;
    draw(page, text, left, y, t.table.rowSize, regular, width);
  }

  if (t.footer.text !== '') {
    const text = fill(t.footer.text, values);
    draw(page, text, left, margins.bottom, t.footer.size, regular, width);
  }

  doc.setTitle(options.title);
  doc.setProducer('ynotPDF');
  doc.setCreator('ynotPDF');
  return await doc.save({ useObjectStreams: false });
}

// ---- placeholders ---------------------------------------------------------------------------

function placeholders(portfolio: Portfolio, options: CoverOptions): Record<string, string> {
  const total = totalSize(portfolio);
  return {
    title: options.title,
    subtitle: options.subtitle ?? '',
    date: new Intl.DateTimeFormat('en-GB', { dateStyle: 'long' }).format(
      options.date ?? new Date(),
    ),
    count: describePortfolio(portfolio),
    size: total === null ? 'size unknown' : formatBytes(total),
  };
}

/** Substitutes `{name}` placeholders; an unknown one is left as it was written. */
export function fill(text: string, values: Readonly<Record<string, string>>): string {
  const out = text.replace(/\{(\w+)\}/g, (whole, key: string) => values[key] ?? whole);
  // A line that is nothing but an empty placeholder is a line the operator asked to leave out.
  return out.trim();
}

// ---- the table ------------------------------------------------------------------------------

interface ResolvedColumn {
  readonly key: string;
  readonly label: string;
  readonly kind: ColumnKind;
  readonly x: number;
  readonly width: number;
  readonly right: boolean;
}

/**
 * The template's columns placed across the text width. A key naming a column the portfolio does
 * not have is dropped rather than drawn empty; widths are normalised so they always fill the
 * page, whatever the operator typed.
 */
function resolveColumns(
  portfolio: Portfolio,
  columns: ReadonlyArray<TableColumn>,
  width: number,
): ResolvedColumn[] {
  const known = new Map<string, PortfolioColumn>();
  for (const column of [...STANDARD_COLUMNS, ...portfolio.schema]) known.set(column.key, column);
  const usable = columns.filter((c) => kindOf(c.key, known) !== null);
  const total = usable.reduce((sum, c) => sum + Math.max(0, c.width), 0);
  let x = 0;
  const out: ResolvedColumn[] = [];
  for (const column of usable) {
    const share = total > 0 ? Math.max(0, column.width) / total : 1 / usable.length;
    const columnWidth = share * width;
    out.push({
      key: column.key,
      label: column.label,
      kind: kindOf(column.key, known) ?? 'text',
      x,
      width: columnWidth,
      right: column.align === 'right',
    });
    x += columnWidth;
  }
  return out;
}

/** The kind a template column key means: a standard name, or a schema column of the portfolio. */
function kindOf(key: string, known: ReadonlyMap<string, PortfolioColumn>): ColumnKind | null {
  const direct: Readonly<Record<string, ColumnKind>> = {
    name: 'name',
    description: 'description',
    size: 'size',
    created: 'created',
    modified: 'modified',
  };
  return direct[key] ?? known.get(key)?.kind ?? null;
}

function cellText(
  portfolio: Portfolio,
  file: Portfolio['files'][number],
  kind: ColumnKind,
  key: string,
): string {
  if (kind === 'name') return filePath(portfolio, file);
  const value = columnValue(file, { key, label: '', kind, order: 0, visible: true });
  if (value === null) return '';
  if (kind === 'size' || kind === 'compressedSize') return formatBytes(Number(value));
  if (kind === 'created' || kind === 'modified' || kind === 'date') {
    return new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium' }).format(
      new Date(Number(value)),
    );
  }
  return String(value);
}

// ---- drawing ---------------------------------------------------------------------------------

/** One line, clipped to `width` with an ellipsis, and right-aligned when asked. */
function draw(
  page: PDFPage,
  text: string,
  x: number,
  y: number,
  size: number,
  font: PDFFont,
  width?: number,
  right = false,
): void {
  if (text === '') return;
  const safe = toWinAnsi(text);
  const room = width === undefined ? Number.POSITIVE_INFINITY : width - 6;
  const shown = clip(safe, font, size, room);
  const drawnWidth = font.widthOfTextAtSize(shown, size);
  const at = right && width !== undefined ? x + width - drawnWidth - 4 : x;
  page.drawText(shown, { x: at, y, size, font });
}

/** Wraps on spaces; a single word longer than the line is clipped rather than broken. */
export function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const safe = toWinAnsi(text);
  const words = safe.split(/\s+/).filter((w) => w !== '');
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const candidate = current === '' ? word : `${current} ${word}`;
    if (font.widthOfTextAtSize(candidate, size) <= width || current === '') current = candidate;
    else {
      lines.push(current);
      current = word;
    }
  }
  if (current !== '') lines.push(current);
  return lines;
}

function clip(text: string, font: PDFFont, size: number, width: number): string {
  if (font.widthOfTextAtSize(text, size) <= width) return text;
  let out = text;
  while (out.length > 1 && font.widthOfTextAtSize(`${out}…`, size) > width) out = out.slice(0, -1);
  return `${out}…`;
}

/**
 * The standard fonts speak WinAnsi and nothing else, so a character outside it becomes `?`
 * rather than throwing halfway through drawing a cover sheet. Embedding a Unicode font waits for
 * M51, which brings fontkit — the same trade M91's text converter makes.
 */
export function toWinAnsi(text: string): string {
  let out = '';
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code === 0x2026) {
      out += '…';
      continue;
    }
    out += code >= 0x20 && code <= 0xff ? ch : '?';
  }
  return out;
}

/** Bytes in the units a reader reads, en-GB. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${String(bytes)} bytes`;
  const units = ['kB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit] ?? 'kB'}`;
}

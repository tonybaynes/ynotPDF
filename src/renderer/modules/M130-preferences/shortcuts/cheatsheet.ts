/**
 * The printable keyboard-shortcut sheet (M130).
 *
 * Drawn with pdf-lib and the standard fonts, the same approach as M42's cover sheet and for the
 * same reasons: it is deterministic, it needs no browser, and it can run in a batch action later.
 * The layout — page size, margins, type sizes, how many columns — is `resources/shortcuts/
 * cheatsheet.json`, because that is the sort of thing that changes without the code changing.
 *
 * It lists **every command**, including the ones with no key. A sheet that showed only the bound
 * ones would answer "what can I press" but not "what is still free", and the second question is
 * the one someone holding this sheet next to the shortcut editor is actually asking.
 *
 * Modifiers are spelled in words (`Ctrl`, `Cmd`, `Opt`, `Shift`) rather than as the macOS glyphs:
 * the standard PDF fonts are WinAnsi-encoded and have no glyph for a command key, and a sheet
 * with a blank where the modifier should be is worse than one that says "Cmd".
 */

import { PDFDocument, StandardFonts, type PDFFont, type PDFPage } from 'pdf-lib';
import { marginsToPoints, resolvePageSize } from '@shared/pageSizes';
import type { MarginsMm, Orientation, PageSizeChoice } from '@shared/create';
import template from '../../../../../resources/shortcuts/cheatsheet.json';
import type { BindingRow } from './model';

export interface CheatSheetTemplate {
  readonly page: {
    readonly size: string;
    readonly orientation: string;
    readonly margins: MarginsMm;
  };
  readonly title: string;
  readonly subtitle: string;
  readonly titleSize: number;
  readonly subtitleSize: number;
  readonly categorySize: number;
  readonly rowSize: number;
  readonly rowGap: number;
  readonly categoryGapBefore: number;
  readonly categoryGapAfter: number;
  readonly columns: number;
  readonly columnGap: number;
  readonly keyColumnWidth: number;
  readonly rule: boolean;
  readonly footer: string;
  readonly footerSize: number;
  readonly unboundNote: string;
}

/** The template as shipped. Exported so a test can vary it without touching the file. */
export const CHEAT_SHEET_TEMPLATE = template as unknown as CheatSheetTemplate;

export interface CheatSheetOptions {
  /** macOS spells the modifiers differently; the sheet follows the machine it was made on. */
  readonly isMac?: boolean;
  readonly date?: Date;
  readonly template?: CheatSheetTemplate;
  /** Locale for the date. Defaults to en-GB, like everything else the app formats. */
  readonly locale?: string;
}

/**
 * A shortcut as the sheet prints it: `"Mod+Shift+P"` becomes `"Ctrl+Shift+P"` on Windows and
 * Linux and `"Cmd+Shift+P"` on macOS. Words, never glyphs — see the file comment.
 */
export function printableKey(key: string, isMac: boolean): string {
  return key
    .split('+')
    .map((part) => {
      if (part === 'Mod') return isMac ? 'Cmd' : 'Ctrl';
      if (part === 'Meta') return isMac ? 'Cmd' : 'Win';
      if (part === 'Alt') return isMac ? 'Opt' : 'Alt';
      if (part === 'Space') return 'Space';
      return part;
    })
    .join('+');
}

/** Rows grouped into the sections the sheet prints, in the order they print. */
export function sections(
  rows: ReadonlyArray<BindingRow>,
): ReadonlyArray<{ readonly category: string; readonly rows: ReadonlyArray<BindingRow> }> {
  const byCategory = new Map<string, BindingRow[]>();
  for (const row of rows) {
    const list = byCategory.get(row.category) ?? [];
    list.push(row);
    byCategory.set(row.category, list);
  }
  return Array.from(byCategory.entries())
    .map(([category, list]) => ({
      category,
      // Bound commands first inside a section: the sheet's job is the keys, and the unbound ones
      // are the appendix that answers "what is free".
      rows: [...list].sort((a, b) => {
        const aBound = a.key === undefined ? 1 : 0;
        const bBound = b.key === undefined ? 1 : 0;
        return aBound - bBound || a.label.localeCompare(b.label);
      }),
    }))
    .sort((a, b) => a.category.localeCompare(b.category));
}

/** Replaces `{name}` placeholders. */
function fill(text: string, values: Readonly<Record<string, string>>): string {
  return text.replace(/\{(\w+)\}/g, (whole, name: string) => values[name] ?? whole);
}

/** Truncates to fit `width`, ending in an ellipsis when it had to. */
function ellipsise(text: string, font: PDFFont, size: number, width: number): string {
  if (font.widthOfTextAtSize(text, size) <= width) return text;
  let cut = text;
  while (cut.length > 1 && font.widthOfTextAtSize(`${cut}…`, size) > width) {
    cut = cut.slice(0, -1);
  }
  return `${cut}…`;
}

/**
 * The standard fonts are WinAnsi-encoded; a label containing something outside that (a module
 * that named a command with a curly apostrophe from a source we do not control) would throw
 * halfway through drawing. Replacing the character is the right failure: a sheet with a `?` in
 * one label beats no sheet at all.
 */
const WIN_ANSI_EXTRAS = new Set(
  '€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ'.split('').map((c) => c.codePointAt(0) ?? 0),
);

export function winAnsiSafe(text: string): string {
  let out = '';
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    const printable =
      (code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff) || WIN_ANSI_EXTRAS.has(code);
    out += printable ? character : '?';
  }
  return out;
}

interface Entry {
  readonly kind: 'category' | 'row';
  readonly height: number;
  readonly draw: (page: PDFPage, x: number, y: number, width: number) => void;
}

export interface CheatSheetResult {
  readonly bytes: Uint8Array;
  readonly pageCount: number;
  /** Commands listed, and how many of them have a key. */
  readonly commandCount: number;
  readonly boundCount: number;
  readonly fileName: string;
}

/**
 * Draws the sheet. Columns are filled top to bottom, then left to right, then a new page — the
 * order a reader scans, and the order that keeps a category's rows together where it can.
 */
export async function buildCheatSheet(
  rows: ReadonlyArray<BindingRow>,
  options: CheatSheetOptions = {},
): Promise<CheatSheetResult> {
  const t = options.template ?? CHEAT_SHEET_TEMPLATE;
  const isMac = options.isMac ?? false;
  const doc = await PDFDocument.create();
  // The sheet is dated, so date it once and stamp that everywhere — including the document's own
  // metadata. Left alone, pdf-lib fills CreationDate and ModificationDate from the wall clock at
  // save time, and those live inside a deflate-compressed object stream: two builds a second apart
  // compress to *different lengths*. Measured on this machine, one unchanged document saved at 575,
  // 576 or 577 bytes across 120 consecutive seconds. A sheet built for a given day should be the
  // same file every time (2026-09-11).
  const stamp = options.date ?? new Date();
  doc.setCreationDate(stamp);
  doc.setModificationDate(stamp);
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  const choice: PageSizeChoice = { kind: 'preset', id: t.page.size };
  const size = resolvePageSize(choice, t.page.orientation as Orientation);
  const margins = marginsToPoints(t.page.margins, size);
  const contentWidth = size.width - margins.left - margins.right;
  const columns = Math.max(1, Math.round(t.columns));
  const columnWidth = (contentWidth - t.columnGap * (columns - 1)) / columns;
  const keyWidth = Math.min(t.keyColumnWidth, columnWidth * 0.55);
  const labelWidth = columnWidth - keyWidth - 6;

  const boundCount = rows.filter((r) => r.key !== undefined).length;
  const dateText = stamp.toLocaleDateString(options.locale ?? 'en-GB', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  // ---- flow the entries -------------------------------------------------------------------
  const entries: Entry[] = [];
  for (const section of sections(rows)) {
    const heading = winAnsiSafe(section.category);
    entries.push({
      kind: 'category',
      height: t.categorySize + t.categoryGapBefore + t.categoryGapAfter,
      draw: (page, x, y, width) => {
        const baseline = y - t.categoryGapBefore - t.categorySize;
        page.drawText(heading, { x, y: baseline, size: t.categorySize, font: bold });
        if (t.rule) {
          page.drawLine({
            start: { x, y: baseline - 3 },
            end: { x: x + width, y: baseline - 3 },
            thickness: 0.5,
          });
        }
      },
    });
    for (const row of section.rows) {
      const label = ellipsise(winAnsiSafe(row.label), regular, t.rowSize, labelWidth);
      const keyText = row.key === undefined ? '—' : printableKey(winAnsiSafe(row.key), isMac);
      entries.push({
        kind: 'row',
        height: t.rowSize + t.rowGap,
        draw: (page, x, y, width) => {
          const baseline = y - t.rowSize;
          page.drawText(label, { x, y: baseline, size: t.rowSize, font: regular });
          const keyX = x + width - keyWidth;
          page.drawText(ellipsise(keyText, bold, t.rowSize, keyWidth), {
            x: keyX,
            y: baseline,
            size: t.rowSize,
            font: row.key === undefined ? regular : bold,
          });
        },
      });
    }
  }

  // ---- lay them into columns ----------------------------------------------------------------
  const pages: PDFPage[] = [];
  let page = doc.addPage([size.width, size.height]);
  pages.push(page);
  let column = 0;
  // The first page carries the title block; later pages start at the top margin.
  const headerHeight = t.titleSize + 6 + t.subtitleSize + 6 + t.subtitleSize + 10;
  let top = size.height - margins.top - headerHeight;
  let y = top;
  const bottom = margins.bottom + t.footerSize + 6;

  const columnX = (index: number): number => margins.left + index * (columnWidth + t.columnGap);

  drawHeader(page);

  function drawHeader(target: PDFPage): void {
    const values = {
      count: String(rows.length),
      bound: String(boundCount),
      date: dateText,
      page: '',
      pages: '',
    };
    let cursor = size.height - margins.top - t.titleSize;
    target.drawText(winAnsiSafe(fill(t.title, values)), {
      x: margins.left,
      y: cursor,
      size: t.titleSize,
      font: bold,
    });
    cursor -= t.subtitleSize + 6;
    target.drawText(winAnsiSafe(fill(t.subtitle, values)), {
      x: margins.left,
      y: cursor,
      size: t.subtitleSize,
      font: regular,
    });
    cursor -= t.subtitleSize + 4;
    target.drawText(winAnsiSafe(t.unboundNote), {
      x: margins.left,
      y: cursor,
      size: t.subtitleSize,
      font: regular,
    });
  }

  for (const entry of entries) {
    // A category heading at the very bottom of a column would leave its rows orphaned overleaf.
    const needed = entry.kind === 'category' ? entry.height + t.rowSize * 2 : entry.height;
    if (y - needed < bottom) {
      column++;
      if (column >= columns) {
        column = 0;
        page = doc.addPage([size.width, size.height]);
        pages.push(page);
        top = size.height - margins.top;
      }
      y = top;
    }
    entry.draw(page, columnX(column), y, columnWidth);
    y -= entry.height;
  }

  // ---- footers ------------------------------------------------------------------------------
  pages.forEach((target, index) => {
    const text = winAnsiSafe(
      fill(t.footer, {
        page: String(index + 1),
        pages: String(pages.length),
        count: String(rows.length),
        bound: String(boundCount),
        date: dateText,
      }),
    );
    const width = regular.widthOfTextAtSize(text, t.footerSize);
    target.drawText(text, {
      x: (size.width - width) / 2,
      y: margins.bottom,
      size: t.footerSize,
      font: regular,
    });
  });

  return {
    bytes: await doc.save(),
    pageCount: pages.length,
    commandCount: rows.length,
    boundCount,
    fileName: 'ynotPDF keyboard shortcuts.pdf',
  };
}

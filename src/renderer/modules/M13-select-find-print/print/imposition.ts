/**
 * Imposition (M13): the arithmetic that decides which source page goes where on which sheet of
 * paper, at what size and which way up. Pure — no engine, no DOM — so the same function drives
 * the print preview, the raster path that reaches the printer and the vector path that writes
 * "Print to PDF". Three consumers, one answer; the preview cannot disagree with the paper.
 *
 * Coordinates are PDF points with the origin at the **bottom-left of the sheet**, because that
 * is what pdf-lib wants and what the PDF page model uses. The raster renderer flips once, at
 * the edge, rather than every rule in here having a y-down twin.
 *
 * `rotation` on a placement is the clockwise rotation applied to the source page before it is
 * drawn into `rect`; `rect` is already the rotated page's footprint, so a consumer never has to
 * work out which of width and height it is looking at.
 */

/** A source page: its index and its *displayed* size in points. */
export interface SourcePage {
  readonly index: number;
  readonly width: number;
  readonly height: number;
}

/** A sheet of paper, portrait dimensions swapped by the caller for landscape. */
export interface Paper {
  readonly width: number;
  readonly height: number;
}

export interface Margins {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
}

export const NO_MARGINS: Margins = { top: 0, right: 0, bottom: 0, left: 0 };

/** How a page is sized into the space it has been given. */
export type ScalingMode = 'fit' | 'actual' | 'shrink' | 'fill' | 'custom';

/** Order the cells of an n-up sheet are filled in. */
export type NUpOrder = 'horizontal' | 'horizontalReverse' | 'vertical' | 'verticalReverse';

export interface NUpOptions {
  readonly columns: number;
  readonly rows: number;
  readonly order: NUpOrder;
  /** Draw a hairline round each cell, as Foxit's "Print page border" does. */
  readonly border: boolean;
}

export interface BookletOptions {
  /** Which half of a duplex job to produce. */
  readonly subset: 'both' | 'front' | 'back';
  readonly binding: 'left' | 'right';
}

export interface TileOptions {
  /** Zoom applied to the page before it is cut up; 1 is actual size. */
  readonly scale: number;
  /** Overlap between neighbouring tiles, points. */
  readonly overlap: number;
  /** Cut marks and a "page 2 of 6" label in the margin. */
  readonly marks: boolean;
}

/** Everything the imposition needs to know. */
export interface ImpositionOptions {
  readonly paper: Paper;
  readonly margins: Margins;
  readonly scaling: ScalingMode;
  /** Percentage for `scaling: 'custom'`, e.g. 75. */
  readonly customScale: number;
  /** Turn a page to match the sheet when that fits more of it on. */
  readonly autoRotate: boolean;
  readonly autoCentre: boolean;
  /** `null` for one page per sheet. Ignored when `booklet` is set. */
  readonly nUp: NUpOptions | null;
  readonly booklet: BookletOptions | null;
  readonly tile: TileOptions | null;
}

export const DEFAULT_IMPOSITION: ImpositionOptions = {
  paper: { width: 595.28, height: 841.89 },
  margins: NO_MARGINS,
  scaling: 'shrink',
  customScale: 100,
  autoRotate: true,
  autoCentre: true,
  nUp: null,
  booklet: null,
  tile: null,
};

/** Where one source page lands on a sheet. */
export interface Placement {
  /** Source page index, or `-1` for a blank a booklet needs to pad with. */
  readonly page: number;
  /** Footprint on the sheet, points, origin bottom-left. */
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** Clockwise rotation applied to the page before it is drawn. */
  readonly rotation: 0 | 90 | 180 | 270;
  /** Scale from source points to sheet points. */
  readonly scale: number;
  /**
   * The part of the source page to draw, in the page's own points (origin bottom-left). Absent
   * means the whole page; set only when tiling.
   */
  readonly clip?: {
    readonly x0: number;
    readonly y0: number;
    readonly x1: number;
    readonly y1: number;
  };
  /** Draw a border round this cell. */
  readonly border?: boolean;
  /** Human label for tiles, e.g. `"1 of 4"`. */
  readonly label?: string;
}

/** One sheet of paper. */
export interface Sheet {
  readonly index: number;
  readonly width: number;
  readonly height: number;
  readonly placements: ReadonlyArray<Placement>;
}

/** A rectangle of usable paper. */
interface Cell {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

function contentArea(options: ImpositionOptions): Cell {
  const { paper, margins } = options;
  return {
    x: margins.left,
    y: margins.bottom,
    width: Math.max(1, paper.width - margins.left - margins.right),
    height: Math.max(1, paper.height - margins.top - margins.bottom),
  };
}

/** The scale for one page in one cell. */
function scaleFor(
  page: { readonly width: number; readonly height: number },
  cell: Cell,
  options: ImpositionOptions,
): number {
  const fit = Math.min(cell.width / page.width, cell.height / page.height);
  switch (options.scaling) {
    case 'fit':
      return fit;
    case 'actual':
      return 1;
    case 'shrink':
      return Math.min(1, fit);
    case 'fill':
      return Math.max(cell.width / page.width, cell.height / page.height);
    case 'custom':
      return Math.max(0.01, options.customScale / 100);
  }
}

/**
 * Places one page in one cell. `autoRotate` turns the page a quarter when the cell and the page
 * disagree about which way is long — that is what makes a landscape drawing fill a portrait
 * sheet instead of shrinking into a strip across the middle of it.
 */
export function placeInCell(
  page: SourcePage,
  cell: Cell,
  options: ImpositionOptions,
  extra: { readonly border?: boolean; readonly label?: string } = {},
): Placement {
  const upright = { width: page.width, height: page.height };
  const turned = { width: page.height, height: page.width };
  const uprightScale = scaleFor(upright, cell, options);
  const turnedScale = scaleFor(turned, cell, options);
  const cellLandscape = cell.width >= cell.height;
  const pageLandscape = page.width >= page.height;
  const rotate =
    options.autoRotate && cellLandscape !== pageLandscape && turnedScale > uprightScale + 1e-9;
  const size = rotate ? turned : upright;
  const scale = rotate ? turnedScale : uprightScale;
  const width = size.width * scale;
  const height = size.height * scale;
  const x = options.autoCentre ? cell.x + (cell.width - width) / 2 : cell.x;
  const y = options.autoCentre
    ? cell.y + (cell.height - height) / 2
    : cell.y + cell.height - height;
  return {
    page: page.index,
    x,
    y,
    width,
    height,
    rotation: rotate ? 90 : 0,
    scale,
    ...(extra.border ? { border: true } : {}),
    ...(extra.label !== undefined ? { label: extra.label } : {}),
  };
}

/** The cells of an n-up sheet, in the fill order asked for. */
export function nUpCells(area: Cell, nUp: NUpOptions): Cell[] {
  const columns = Math.max(1, Math.floor(nUp.columns));
  const rows = Math.max(1, Math.floor(nUp.rows));
  const width = area.width / columns;
  const height = area.height / rows;
  const cells: Cell[] = [];
  const at = (column: number, row: number): Cell => ({
    // Row 0 is the *top* row of the sheet, so it is the highest y.
    x: area.x + column * width,
    y: area.y + area.height - (row + 1) * height,
    width,
    height,
  });
  const horizontal = nUp.order === 'horizontal' || nUp.order === 'horizontalReverse';
  const reverse = nUp.order === 'horizontalReverse' || nUp.order === 'verticalReverse';
  if (horizontal) {
    for (let row = 0; row < rows; row++) {
      for (let column = 0; column < columns; column++) {
        cells.push(at(reverse ? columns - 1 - column : column, row));
      }
    }
  } else {
    for (let column = 0; column < columns; column++) {
      for (let row = 0; row < rows; row++) {
        cells.push(at(reverse ? columns - 1 - column : column, row));
      }
    }
  }
  return cells;
}

/**
 * Booklet order for saddle stitching. The pages are padded to a multiple of four, then folded:
 * sheet *i* carries the last page and the first on its front, and the second and the
 * second-to-last on its back, so a stack folded down the middle reads in order.
 */
export function bookletOrder(count: number): Array<[number, number]> {
  const padded = Math.ceil(Math.max(count, 1) / 4) * 4;
  const pages = Array.from({ length: padded }, (_, i) => (i < count ? i : -1));
  const sheets: Array<[number, number]> = [];
  for (let i = 0; i < padded / 4; i++) {
    const front: [number, number] = [pages[padded - 1 - 2 * i] ?? -1, pages[2 * i] ?? -1];
    const back: [number, number] = [pages[2 * i + 1] ?? -1, pages[padded - 2 - 2 * i] ?? -1];
    sheets.push(front, back);
  }
  return sheets;
}

/** The tiles one page is cut into. */
export function tileGrid(
  page: SourcePage,
  area: Cell,
  tile: TileOptions,
): Array<{ readonly x0: number; readonly y0: number; readonly x1: number; readonly y1: number }> {
  const scale = Math.max(0.01, tile.scale);
  // How much of the *page* one sheet holds, in the page's own points.
  const stepX = Math.max(1, area.width / scale - tile.overlap);
  const stepY = Math.max(1, area.height / scale - tile.overlap);
  const spanX = area.width / scale;
  const spanY = area.height / scale;
  const columns = Math.max(1, Math.ceil((page.width - tile.overlap) / stepX));
  const rows = Math.max(1, Math.ceil((page.height - tile.overlap) / stepY));
  const out: Array<{ x0: number; y0: number; x1: number; y1: number }> = [];
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      const x0 = column * stepX;
      // Row 0 is the top of the page.
      const y1 = page.height - row * stepY;
      out.push({
        x0,
        y0: Math.max(0, y1 - spanY),
        x1: Math.min(page.width, x0 + spanX),
        y1,
      });
    }
  }
  return out;
}

/**
 * The whole plan: pages in, sheets out. Booklet wins over n-up (a booklet *is* a 2-up
 * imposition, and asking for both is asking for one of them twice); tiling applies to whatever
 * each sheet would otherwise have held, one tile per sheet.
 */
export function imposePages(pages: ReadonlyArray<SourcePage>, options: ImpositionOptions): Sheet[] {
  const area = contentArea(options);
  const sheets: Sheet[] = [];
  const push = (placements: ReadonlyArray<Placement>): void => {
    sheets.push({
      index: sheets.length,
      width: options.paper.width,
      height: options.paper.height,
      placements,
    });
  };

  if (options.booklet) {
    const order = bookletOrder(pages.length);
    const halves = nUpCells(area, { columns: 2, rows: 1, order: 'horizontal', border: false });
    const [leftCell, rightCell] = halves;
    order.forEach(([left, right], sheetIndex) => {
      const isFront = sheetIndex % 2 === 0;
      const subset = options.booklet?.subset ?? 'both';
      if ((subset === 'front' && !isFront) || (subset === 'back' && isFront)) return;
      const binding = options.booklet?.binding ?? 'left';
      const [a, b] = binding === 'left' ? [left, right] : [right, left];
      const placements: Placement[] = [];
      if (a >= 0 && leftCell) {
        const page = pages[a];
        if (page) placements.push(placeInCell(page, leftCell, options));
      }
      if (b >= 0 && rightCell) {
        const page = pages[b];
        if (page) placements.push(placeInCell(page, rightCell, options));
      }
      push(placements);
    });
    return sheets;
  }

  if (options.tile) {
    pages.forEach((page) => {
      const tiles = tileGrid(page, area, options.tile ?? { scale: 1, overlap: 0, marks: false });
      tiles.forEach((clip, i) => {
        const scale = Math.max(0.01, options.tile?.scale ?? 1);
        const width = (clip.x1 - clip.x0) * scale;
        const height = (clip.y1 - clip.y0) * scale;
        push([
          {
            page: page.index,
            x: area.x,
            y: area.y + area.height - height,
            width,
            height,
            rotation: 0,
            scale,
            clip,
            ...(options.tile?.marks ? { label: `${i + 1} of ${tiles.length}` } : {}),
          },
        ]);
      });
    });
    return sheets;
  }

  const nUp = options.nUp;
  if (nUp && nUp.columns * nUp.rows > 1) {
    const cells = nUpCells(area, nUp);
    const perSheet = cells.length;
    for (let i = 0; i < pages.length; i += perSheet) {
      const placements: Placement[] = [];
      for (let k = 0; k < perSheet; k++) {
        const page = pages[i + k];
        const cell = cells[k];
        if (!page || !cell) continue;
        placements.push(placeInCell(page, cell, options, { border: nUp.border }));
      }
      push(placements);
    }
    return sheets;
  }

  for (const page of pages) push([placeInCell(page, area, options)]);
  return sheets;
}

/** The source pages each sheet carries, in placement order — what the acceptance test reads. */
export function sheetOrder(sheets: ReadonlyArray<Sheet>): number[][] {
  return sheets.map((sheet) => sheet.placements.map((p) => p.page));
}

/** Swaps a paper's dimensions for landscape. */
export function orientPaper(paper: Paper, orientation: 'portrait' | 'landscape'): Paper {
  const portrait = paper.width <= paper.height;
  const wantPortrait = orientation === 'portrait';
  return portrait === wantPortrait ? paper : { width: paper.height, height: paper.width };
}

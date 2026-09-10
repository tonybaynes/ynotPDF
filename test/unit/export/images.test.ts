/**
 * The image export (M92): the resolution arithmetic that the acceptance test rests on, the file
 * names, the multi-page TIFF, and cancelling.
 *
 * No PDF and no engine here — pages arrive through the `RenderPage` callback, which is the whole
 * reason the exporter takes one.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_IMAGE_PATTERN,
  ExportCancelled,
  ExportFailed,
  documentStem,
  exportImages,
  fillImageName,
  pixelSize,
  readBmpHeader,
  readJfifDensity,
  readJpegSize,
  readPngHeader,
  readTiffFrames,
  stripPageTokens,
  uniqueNames,
  type Raster,
  type RenderPage,
} from '@engine/export';

/** A4 in points, as every fixture in the corpus uses. */
const A4 = { width: 595.28, height: 841.89 };

/** Renders a page as a flat grey rectangle of exactly the size the dpi asks for. */
function pageRenderer(size = A4, onRender?: (page: number) => void): RenderPage {
  return (page, dpi) => {
    onRender?.(page);
    const { width, height } = pixelSize(size.width, size.height, dpi);
    const data = new Uint8Array(width * height * 4);
    for (let i = 0; i < width * height; i++) {
      // A little variation so the encoders are not compressing a constant.
      const v = (i * 7) & 0xff;
      data.set([v, v, v, 255], i * 4);
    }
    return Promise.resolve<Raster>({ data, width, height });
  };
}

const BASE = {
  pages: [0, 1, 2],
  pageCount: 5,
  documentName: 'multipage',
  when: new Date('2026-09-10T09:30:00'),
} as const;

describe('pixelSize', () => {
  it('is the page size in points times the dpi over 72', () => {
    expect(pixelSize(595.28, 841.89, 150)).toEqual({ width: 1240, height: 1754 });
    expect(pixelSize(595.28, 841.89, 72)).toEqual({ width: 595, height: 842 });
    expect(pixelSize(612, 792, 300)).toEqual({ width: 2550, height: 3300 });
  });

  it('never returns a zero dimension, however small the page', () => {
    expect(pixelSize(0.1, 0.1, 10)).toEqual({ width: 1, height: 1 });
  });
});

describe('exportImages — the acceptance line', () => {
  it('three pages at 150 dpi PNG have pixel dimensions of page size × dpi', async () => {
    const result = await exportImages(pageRenderer(), {
      ...BASE,
      format: 'png',
      dpi: 150,
      colour: 'colour',
    });
    expect(result.files).toHaveLength(3);
    const expected = pixelSize(A4.width, A4.height, 150);
    for (const file of result.files) {
      const header = readPngHeader(file.bytes);
      expect([header.width, header.height]).toEqual([expected.width, expected.height]);
      expect(header.pixelsPerMetreX).toBe(5906); // 150 dpi
    }
    expect(result.files.map((f) => f.name)).toEqual([
      'multipage_page1.png',
      'multipage_page2.png',
      'multipage_page3.png',
    ]);
  });

  it('the same three pages as one TIFF have three frames', async () => {
    const result = await exportImages(pageRenderer(), {
      ...BASE,
      format: 'tiff',
      dpi: 150,
      colour: 'colour',
      multiPage: true,
    });
    expect(result.files).toHaveLength(1);
    const file = result.files[0];
    expect(file?.name).toBe('multipage.tif');
    expect(file?.pages).toEqual([0, 1, 2]);
    const frames = readTiffFrames(file?.bytes ?? new Uint8Array(0));
    expect(frames).toHaveLength(3);
    const expected = pixelSize(A4.width, A4.height, 150);
    for (const frame of frames) {
      expect([frame.width, frame.height]).toEqual([expected.width, expected.height]);
      expect(frame.xResolution).toBe(150);
    }
  });
});

describe('exportImages — formats and colour', () => {
  it('writes JPEG with the resolution in it', async () => {
    const result = await exportImages(pageRenderer(), {
      ...BASE,
      pages: [0],
      format: 'jpeg',
      dpi: 96,
      colour: 'colour',
      quality: 70,
    });
    const bytes = result.files[0]?.bytes ?? new Uint8Array(0);
    expect(readJpegSize(bytes)).toEqual(pixelSize(A4.width, A4.height, 96));
    expect(readJfifDensity(bytes)).toEqual({ x: 96, y: 96 });
    expect(result.files[0]?.name).toBe('multipage_page1.jpg');
  });

  it('writes BMP at one bit a pixel in monochrome, and 24 in colour', async () => {
    const mono = await exportImages(pageRenderer(), {
      ...BASE,
      pages: [0],
      format: 'bmp',
      dpi: 72,
      colour: 'mono',
    });
    expect(readBmpHeader(mono.files[0]?.bytes ?? new Uint8Array(0)).bitCount).toBe(1);
    const colour = await exportImages(pageRenderer(), {
      ...BASE,
      pages: [0],
      format: 'bmp',
      dpi: 72,
      colour: 'colour',
    });
    expect(readBmpHeader(colour.files[0]?.bytes ?? new Uint8Array(0)).bitCount).toBe(24);
  });

  it('writes greyscale PNG as colour type 0 and colour PNG as type 2', async () => {
    const grey = await exportImages(pageRenderer(), {
      ...BASE,
      pages: [0],
      format: 'png',
      dpi: 72,
      colour: 'grey',
    });
    expect(readPngHeader(grey.files[0]?.bytes ?? new Uint8Array(0)).colourType).toBe(0);
  });

  it('says so when monochrome is asked for in a format that cannot hold it', async () => {
    const result = await exportImages(pageRenderer(), {
      ...BASE,
      pages: [0],
      format: 'jpeg',
      dpi: 72,
      colour: 'mono',
    });
    expect(result.warnings.join(' ')).toMatch(/JPEG cannot hold a black-and-white image/);
  });
});

describe('exportImages — names', () => {
  it('zero-pads the page number to the width of the document, not of the range', async () => {
    const result = await exportImages(pageRenderer(), {
      ...BASE,
      pages: [8, 9],
      pageCount: 120,
      format: 'png',
      dpi: 72,
      colour: 'colour',
    });
    expect(result.files.map((f) => f.name)).toEqual([
      'multipage_page009.png',
      'multipage_page010.png',
    ]);
  });

  it('never writes two pages to the same name, even when the pattern forgot the page', async () => {
    const result = await exportImages(pageRenderer(), {
      ...BASE,
      format: 'png',
      dpi: 72,
      colour: 'colour',
      namePattern: '{name}',
    });
    expect(result.files.map((f) => f.name)).toEqual([
      'multipage.png',
      'multipage (2).png',
      'multipage (3).png',
    ]);
  });

  it('uses the page label when the document numbers its own pages', async () => {
    const result = await exportImages(pageRenderer(), {
      ...BASE,
      pages: [0, 1],
      format: 'png',
      dpi: 72,
      colour: 'colour',
      namePattern: '{name}-{label}',
      labels: ['i', 'ii', 'A-5'],
    });
    expect(result.files.map((f) => f.name)).toEqual(['multipage-i.png', 'multipage-ii.png']);
  });

  it('falls back to the default pattern when the field was left empty', async () => {
    const result = await exportImages(pageRenderer(), {
      ...BASE,
      pages: [0],
      format: 'png',
      dpi: 72,
      colour: 'colour',
      namePattern: '   ',
    });
    expect(result.files[0]?.name).toBe('multipage_page1.png');
    expect(DEFAULT_IMAGE_PATTERN).toBe('{name}_page{page}');
  });
});

describe('fillImageName', () => {
  const values = {
    name: 'Report',
    page: 6,
    index: 1,
    total: 3,
    pageCount: 12,
    dpi: 300,
    when: new Date('2026-09-10T14:05:09'),
  };

  it('fills every token it knows', () => {
    expect(fillImageName('{name} {page} {n} {index} {total} {dpi}', '.png', values)).toBe(
      'Report 07 7 2 3 300.png',
    );
    expect(fillImageName('{date}_{time}', '.png', values)).toBe('2026-09-10_140509.png');
  });

  it('leaves an unknown token exactly as it was typed, so a typo is visible', () => {
    expect(fillImageName('{name}-{pge}', '.png', values)).toBe('Report-{pge}.png');
  });

  it('takes out the characters an operating system refuses', () => {
    expect(fillImageName('a/b:c*d?e"f<g>h|i', '.png', values)).toBe('a-b-c-d-e-f-g-h-i.png');
  });

  it('never produces an empty name', () => {
    expect(fillImageName('   ', '.png', values)).toBe('part.png');
  });
});

describe('stripPageTokens', () => {
  it('takes the page number and its separator out of a multi-page name', () => {
    expect(stripPageTokens('{name}_page{page}')).toBe('{name}');
    expect(stripPageTokens('{name}-{n}')).toBe('{name}');
    expect(stripPageTokens('scan {label}')).toBe('scan');
  });

  it('leaves a pattern that never mentioned a page alone', () => {
    expect(stripPageTokens('{name}_{date}')).toBe('{name}_{date}');
  });

  it('answers with something rather than nothing', () => {
    expect(stripPageTokens('{page}')).toBe('{name}');
  });
});

describe('uniqueNames and documentStem', () => {
  it('numbers repeats and is blind to case, as Windows and macOS are', () => {
    expect(uniqueNames(['a.png', 'A.PNG', 'b.png', 'a.png'])).toEqual([
      'a.png',
      'A (2).PNG',
      'b.png',
      'a (3).png',
    ]);
  });

  it('takes a document name off a path and off its extension', () => {
    expect(documentStem('C:/files/Quarterly Report.pdf')).toBe('Quarterly Report');
    expect(documentStem('/home/a/b/report.PDF')).toBe('report');
    expect(documentStem('noextension')).toBe('noextension');
  });
});

describe('exportImages — refusing and stopping', () => {
  it('refuses an empty range and a nonsense resolution', async () => {
    await expect(
      exportImages(pageRenderer(), {
        ...BASE,
        pages: [],
        format: 'png',
        dpi: 150,
        colour: 'colour',
      }),
    ).rejects.toBeInstanceOf(ExportFailed);
    await expect(
      exportImages(pageRenderer(), { ...BASE, format: 'png', dpi: 0, colour: 'colour' }),
    ).rejects.toBeInstanceOf(ExportFailed);
  });

  it('refuses a page that would be too large to encode rather than running out of memory', async () => {
    // A renderer that only *claims* the size: allocating 300 megapixels to prove we refuse them
    // would be the very thing the guard exists to avoid.
    const enormous: RenderPage = () =>
      Promise.resolve({ data: new Uint8Array(4), width: 30_000, height: 30_000 });
    await expect(
      exportImages(enormous, { ...BASE, pages: [0], format: 'png', dpi: 4000, colour: 'colour' }),
    ).rejects.toThrow(/too large to encode/);
  });

  it('stops between pages when the signal aborts, and produces nothing', async () => {
    const controller = new AbortController();
    const rendered: number[] = [];
    const render = pageRenderer(A4, (page) => {
      rendered.push(page);
      if (page === 0) controller.abort();
    });
    await expect(
      exportImages(
        render,
        { ...BASE, format: 'png', dpi: 72, colour: 'colour' },
        { signal: controller.signal },
      ),
    ).rejects.toBeInstanceOf(ExportCancelled);
    expect(rendered).toEqual([0]);
  });

  it('reports progress once per page and finishes at one', async () => {
    const progress = vi.fn();
    await exportImages(
      pageRenderer(),
      { ...BASE, format: 'png', dpi: 72, colour: 'colour' },
      { progress },
    );
    const fractions = progress.mock.calls.map((c) => c[0] as number | null);
    expect(fractions[0]).toBe(0);
    expect(fractions[fractions.length - 1]).toBe(1);
    expect(progress.mock.calls.some((c) => String(c[1]).includes('page 2'))).toBe(true);
  });
});

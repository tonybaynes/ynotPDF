/**
 * M91's main-process half, the pure parts: the settings → `printToPDF` mapping, the URL scheme
 * gate and the BGRA → RGBA swap. The hidden window itself is proved by Playwright.
 *
 * `electron` is a path string outside the Electron runtime, so it is stubbed; nothing here
 * constructs a window.
 */

import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_WEB_PRINT_SETTINGS, type WebPrintSettings } from '../../../src/shared/create';
import { bgraToRgba } from '../../../src/main/webpdf/decodeImage';
import { isPrintableUrl, printOptionsFor } from '../../../src/main/webpdf/WebPdfPrinter';

vi.mock('electron', () => ({
  app: { getPath: () => '' },
  BrowserWindow: class {},
  nativeImage: {},
  clipboard: {},
}));

const settings = (overrides: Partial<WebPrintSettings> = {}): WebPrintSettings => ({
  ...DEFAULT_WEB_PRINT_SETTINGS,
  ...overrides,
});

function sizeOf(options: Electron.PrintToPDFOptions): { width: number; height: number } {
  const size = options.pageSize;
  if (typeof size !== 'object') throw new Error('expected a Size, not a preset name');
  return size;
}

describe('printOptionsFor', () => {
  it('A4 portrait is 8.27 x 11.69 inches, already oriented', () => {
    const options = printOptionsFor(settings());
    const size = sizeOf(options);
    expect(size.width).toBeCloseTo(8.27, 2);
    expect(size.height).toBeCloseTo(11.69, 2);
    expect(options.landscape).toBe(false);
  });

  it('landscape swaps the sides and still leaves `landscape` off', () => {
    const options = printOptionsFor(settings({ orientation: 'landscape' }));
    const size = sizeOf(options);
    expect(size.width).toBeCloseTo(11.69, 2);
    expect(size.height).toBeCloseTo(8.27, 2);
    expect(options.landscape).toBe(false);
  });

  it('a custom size is taken in millimetres', () => {
    const options = printOptionsFor(
      settings({ pageSize: { kind: 'custom', widthMm: 100, heightMm: 200 } }),
    );
    const size = sizeOf(options);
    expect(size.width).toBeCloseTo(100 / 25.4, 3);
    expect(size.height).toBeCloseTo(200 / 25.4, 3);
  });

  it('margins are converted from millimetres to inches', () => {
    const options = printOptionsFor(
      settings({ margins: { top: 25.4, right: 12.7, bottom: 0, left: 50.8 } }),
    );
    expect(options.margins?.top).toBeCloseTo(1, 5);
    expect(options.margins?.right).toBeCloseTo(0.5, 5);
    expect(options.margins?.bottom).toBeCloseTo(0, 5);
    expect(options.margins?.left).toBeCloseTo(2, 5);
  });

  it('margins can never swallow the page', () => {
    const options = printOptionsFor(
      settings({ margins: { top: 500, right: 500, bottom: 500, left: 500 } }),
    );
    const size = sizeOf(options);
    expect((options.margins?.left ?? 0) + (options.margins?.right ?? 0)).toBeLessThan(size.width);
    expect((options.margins?.top ?? 0) + (options.margins?.bottom ?? 0)).toBeLessThan(size.height);
  });

  it('header/footer toggles the display flag and the templates', () => {
    const off = printOptionsFor(settings({ headerFooter: false }));
    expect(off.displayHeaderFooter).toBe(false);
    expect(off.headerTemplate).toBeUndefined();
    expect(off.footerTemplate).toBeUndefined();

    const on = printOptionsFor(settings({ headerFooter: true }));
    expect(on.displayHeaderFooter).toBe(true);
    expect(on.headerTemplate).toContain('class="title"');
    expect(on.headerTemplate).toContain('class="date"');
    expect(on.footerTemplate).toContain('class="url"');
    expect(on.footerTemplate).toContain('class="pageNumber"');
    expect(on.footerTemplate).toContain('class="totalPages"');
    expect(on.headerTemplate).not.toMatch(/color\s*:/);
    expect(on.footerTemplate).not.toMatch(/color\s*:/);
  });

  it('passes scale, background and CSS page size through', () => {
    const options = printOptionsFor(
      settings({ scale: 1.5, backgroundGraphics: false, preferCssPageSize: true }),
    );
    expect(options.scale).toBe(1.5);
    expect(options.printBackground).toBe(false);
    expect(options.preferCSSPageSize).toBe(true);
    expect(options.generateDocumentOutline).toBe(false);
  });

  it('clamps a scale outside 0.1 – 2', () => {
    expect(printOptionsFor(settings({ scale: 9 })).scale).toBe(2);
    expect(printOptionsFor(settings({ scale: 0 })).scale).toBe(0.1);
    expect(printOptionsFor(settings({ scale: Number.NaN })).scale).toBe(1);
  });
});

describe('isPrintableUrl', () => {
  it('accepts http, https and file', () => {
    expect(isPrintableUrl('http://example.com/')).toBe(true);
    expect(isPrintableUrl('https://example.com/a?b=c#d')).toBe(true);
    expect(isPrintableUrl('file:///C:/docs/page.html')).toBe(true);
  });

  it('refuses every other scheme', () => {
    expect(isPrintableUrl('javascript:alert(1)')).toBe(false);
    expect(isPrintableUrl('data:text/html,<p>hi</p>')).toBe(false);
    expect(isPrintableUrl('about:blank')).toBe(false);
    expect(isPrintableUrl('chrome://gpu')).toBe(false);
    expect(isPrintableUrl('ftp://example.com/')).toBe(false);
  });

  it('refuses garbage', () => {
    expect(isPrintableUrl('')).toBe(false);
    expect(isPrintableUrl('not a url')).toBe(false);
    expect(isPrintableUrl('example.com')).toBe(false);
  });
});

describe('bgraToRgba', () => {
  it('swaps blue and red and keeps green and alpha', () => {
    const bgra = new Uint8Array([1, 2, 3, 4, 10, 20, 30, 40]);
    expect(Array.from(bgraToRgba(bgra, 2, 1))).toEqual([3, 2, 1, 4, 30, 20, 10, 40]);
  });

  it('sizes the output from width and height', () => {
    const out = bgraToRgba(new Uint8Array(3 * 2 * 4), 3, 2);
    expect(out.length).toBe(24);
  });

  it('tolerates a short bitmap by leaving the rest transparent', () => {
    const out = bgraToRgba(new Uint8Array([9, 8, 7, 255]), 2, 1);
    expect(Array.from(out)).toEqual([7, 8, 9, 255, 0, 0, 0, 0]);
  });
});

/**
 * The pure half of M53: macros, geometry, WinAnsi text, address detection, presets and the
 * model's readers. No engine, no DOM.
 */

import { describe, expect, it } from 'vitest';
import {
  MACROS,
  batesNumber,
  detectLinks,
  displaySize,
  displayToPage,
  expandMacros,
  findAddresses,
  formatDate,
  normalRotation,
  placement,
  rotatedExtent,
  shrinkMatrix,
  toWinAnsi,
  zoneBaseline,
  zoneX,
  DEFAULT_MARGINS,
  type PageContext,
} from '@engine/decorations';
import { apply } from '@engine/content/matrix';
import type { TextRun } from '@engine/PdfEngine';
import { readDecorationsState, readSpec } from '@modules/M53-headers-bates-watermarks-links/model';
import {
  BUILT_IN_PRESETS,
  presetId,
  presetsToJson,
  readCustomPresets,
  withPreset,
} from '@modules/M53-headers-bates-watermarks-links/presets';

const A4 = { x0: 0, y0: 0, x1: 595, y1: 842 };

function page(overrides: Partial<PageContext> = {}): PageContext {
  return {
    index: 0,
    ordinal: 1,
    rangeCount: 10,
    box: A4,
    rotation: 0,
    document: {
      fileName: 'contract.pdf',
      fullPath: 'C:\\Work\\contract.pdf',
      title: 'Supply agreement',
      author: 'A. Baynes',
      subject: 'Draft 3',
      pageCount: 10,
      labels: ['i', 'ii', 'A-5'],
      now: '2026-09-11T09:24:07.000Z',
    },
    ...overrides,
  };
}

describe('macros', () => {
  it('expands the page-number family within the decoration’s own range', () => {
    const p = page({ ordinal: 7, rangeCount: 100 });
    expect(expandMacros('<<1 of n>>', p)).toBe('7 of 100');
    expect(expandMacros('Page <<1>> / <<n>>', p)).toBe('Page 7 / 100');
    expect(expandMacros('<<1>>', p, { startNumber: 5 })).toBe('11');
    expect(expandMacros('<<1 of n>>', p, { totalOverride: 12 })).toBe('7 of 12');
  });

  it('expands the document facts', () => {
    const p = page({ index: 2 });
    expect(expandMacros('<<FileName>>', p)).toBe('contract.pdf');
    expect(expandMacros('<<FullPath>>', p)).toBe('C:\\Work\\contract.pdf');
    expect(expandMacros('<<Title>> — <<Author>> — <<Subject>>', p)).toBe(
      'Supply agreement — A. Baynes — Draft 3',
    );
    expect(expandMacros('<<PageLabel>>', p)).toBe('A-5');
  });

  it('leaves a token it does not know exactly as it was written', () => {
    expect(expandMacros('<<Sausages>>', page())).toBe('<<Sausages>>');
    expect(expandMacros('a << b >> c', page())).toBe('a << b >> c');
  });

  it('formats dates itself, so two machines say the same words', () => {
    const date = new Date(Date.UTC(2026, 8, 11, 9, 24, 7));
    // Local time is the reader's own, so only the date parts are asserted here.
    expect(formatDate(date, 'yyyy-MM-dd')).toMatch(/^2026-09-1[01]$/);
    expect(formatDate(date, 'd MMMM yyyy')).toContain('September 2026');
    expect(formatDate(date, 'MMM')).toBe('Sep');
    expect(formatDate(date, "'on' d MMM")).toMatch(/^on 1[01] Sep$/);
  });

  it('pads a Bates number and clamps the digits to what a PDF can hold', () => {
    expect(batesNumber({ prefix: 'ACME', suffix: '-X', digits: 6, value: 123 })).toBe(
      'ACME000123-X',
    );
    expect(batesNumber({ prefix: '', suffix: '', digits: 99, value: 1 })).toHaveLength(15);
    expect(batesNumber({ prefix: '', suffix: '', digits: 0, value: 7 })).toBe('7');
  });

  it('offers a catalogue the dialog can list', () => {
    expect(MACROS.length).toBeGreaterThan(8);
    expect(MACROS.map((m) => m.token)).toContain('<<1 of n>>');
    for (const macro of MACROS) {
      expect(macro.label, macro.token).not.toBe('');
      expect(macro.description, macro.token).not.toBe('');
    }
  });
});

describe('display space', () => {
  it('swaps the page’s sides for a quarter turn', () => {
    expect(displaySize(A4, 0)).toEqual({ width: 595, height: 842 });
    expect(displaySize(A4, 90)).toEqual({ width: 842, height: 595 });
    expect(displaySize(A4, 270)).toEqual({ width: 842, height: 595 });
    expect(displaySize(A4, 180)).toEqual({ width: 595, height: 842 });
  });

  it('normalises whatever a file writes in /Rotate', () => {
    expect(normalRotation(-90)).toBe(270);
    expect(normalRotation(450)).toBe(90);
    expect(normalRotation(0)).toBe(0);
  });

  it('puts the display’s top-left where the reader sees the top-left', () => {
    for (const rotation of [0, 90, 180, 270]) {
      const size = displaySize(A4, rotation);
      const matrix = displayToPage(A4, rotation);
      const topLeft = apply(matrix, { x: 0, y: size.height });
      // Whatever the rotation, the display's top-left must land on a corner of the page.
      const corners = [
        { x: A4.x0, y: A4.y0 },
        { x: A4.x0, y: A4.y1 },
        { x: A4.x1, y: A4.y0 },
        { x: A4.x1, y: A4.y1 },
      ];
      expect(
        corners.some((c) => Math.abs(c.x - topLeft.x) < 0.001 && Math.abs(c.y - topLeft.y) < 0.001),
        `rotation ${String(rotation)}`,
      ).toBe(true);
      // And the four corners must stay distinct — a matrix that collapsed would pass the above.
      const bottomRight = apply(matrix, { x: size.width, y: 0 });
      expect(Math.hypot(bottomRight.x - topLeft.x, bottomRight.y - topLeft.y)).toBeGreaterThan(100);
    }
  });
});

describe('zones', () => {
  const size = { width: 595, height: 842 };

  it('puts the header near the top and the footer near the bottom', () => {
    expect(zoneBaseline('header-left', size, DEFAULT_MARGINS, 10)).toBeGreaterThan(800);
    expect(zoneBaseline('footer-left', size, DEFAULT_MARGINS, 10)).toBeLessThan(40);
  });

  it('aligns left, centre and right within the margins', () => {
    expect(zoneX('header-left', size, DEFAULT_MARGINS, 100)).toBe(DEFAULT_MARGINS.left);
    expect(zoneX('header-right', size, DEFAULT_MARGINS, 100)).toBe(
      595 - DEFAULT_MARGINS.right - 100,
    );
    const centre = zoneX('header-centre', size, DEFAULT_MARGINS, 100);
    expect(centre).toBeGreaterThan(DEFAULT_MARGINS.left);
    expect(centre + 100).toBeLessThan(595 - DEFAULT_MARGINS.right);
  });
});

describe('placement', () => {
  const size = { width: 595, height: 842 };
  const box = { x0: 0, y0: 0, x1: 200, y1: 50 };

  it('grows a box to the asked-for share of the page width', () => {
    const m = placement(box, size, {
      rotation: 0,
      scale: 0.5,
      position: 'centre',
      offsetX: 0,
      offsetY: 0,
    });
    const a = apply(m, { x: 0, y: 0 });
    const b = apply(m, { x: 200, y: 0 });
    expect(Math.abs(b.x - a.x)).toBeCloseTo(595 * 0.5, 3);
  });

  it('turns a box about its own centre', () => {
    const centred = placement(box, size, {
      rotation: 0,
      scale: 0,
      position: 'centre',
      offsetX: 0,
      offsetY: 0,
    });
    const turned = placement(box, size, {
      rotation: 45,
      scale: 0,
      position: 'centre',
      offsetX: 0,
      offsetY: 0,
    });
    const c1 = apply(centred, { x: 100, y: 25 });
    const c2 = apply(turned, { x: 100, y: 25 });
    expect(c1.x).toBeCloseTo(c2.x, 3);
    expect(c1.y).toBeCloseTo(c2.y, 3);
  });

  it('keeps a rotated box on the page', () => {
    const m = placement(box, size, {
      rotation: 45,
      scale: 0,
      position: 'top-right',
      offsetX: 0,
      offsetY: 0,
    });
    const extent = rotatedExtent(box, 45);
    const centre = apply(m, { x: 100, y: 25 });
    expect(centre.x + extent.width / 2).toBeLessThanOrEqual(size.width + 0.001);
    expect(centre.y + extent.height / 2).toBeLessThanOrEqual(size.height + 0.001);
  });

  it('shrinks a page about its own centre, and refuses a meaningless factor', () => {
    expect(shrinkMatrix(A4, 0)).toBeNull();
    expect(shrinkMatrix(A4, 1)).toBeNull();
    const m = shrinkMatrix(A4, 0.5);
    expect(m).not.toBeNull();
    if (!m) return;
    const centre = apply(m, { x: 297.5, y: 421 });
    expect(centre.x).toBeCloseTo(297.5, 3);
    expect(centre.y).toBeCloseTo(421, 3);
  });
});

describe('WinAnsi text', () => {
  it('turns the characters a word processor supplies into their WinAnsi bytes', () => {
    const result = toWinAnsi('“Smart” quotes — and an ellipsis…');
    expect(result.dropped).toEqual([]);
    expect(result.text.charCodeAt(0)).toBe(0x93);
    expect(result.text).toContain(String.fromCharCode(0x97));
    expect(result.text).toContain(String.fromCharCode(0x85));
  });

  it('keeps Latin-1 as it is and reports what it cannot write', () => {
    expect(toWinAnsi('café').text).toBe('café');
    const cjk = toWinAnsi('価格');
    expect(cjk.text).toBe('??');
    expect(cjk.dropped).toEqual(['価', '格']);
  });
});

describe('finding addresses', () => {
  it('finds full, bare and e-mail addresses without the sentence’s punctuation', () => {
    const found = findAddresses(
      'See https://example.com/a_b. Or www.example.org, or write to bob.smith@example.co.uk.',
    );
    // Sorted by where they sit in the line, which is the order a reader reads them in.
    expect(found.map((f) => f.uri)).toEqual([
      'https://example.com/a_b',
      'https://www.example.org',
      'mailto:bob.smith@example.co.uk',
    ]);
  });

  it('leaves bare addresses alone when it is told to', () => {
    const found = findAddresses('www.example.org and a@b.com', { bare: false });
    expect(found).toHaveLength(0);
  });

  it('does not find an address inside one it has already found', () => {
    const found = findAddresses('https://mail.example.com/u/bob@example.com');
    expect(found).toHaveLength(1);
    expect(found[0]?.uri).toBe('https://mail.example.com/u/bob@example.com');
  });

  it('boxes the matched characters, not the whole line', () => {
    const text = 'Visit https://a.example';
    const chars = Array.from(text, (_c, i) => ({ x0: i * 5, y0: 100, x1: i * 5 + 5, y1: 110 }));
    const run: TextRun = {
      text,
      rect: { x0: 0, y0: 100, x1: text.length * 5, y1: 110 },
      chars,
      origin: { x: 0, y: 100 },
      matrix: [1, 0, 0, 1, 0, 0],
      fontName: 'Helvetica',
      fontSize: 10,
      color: 0,
      objectIndex: 0,
    };
    const [found] = detectLinks(3, [run]);
    expect(found).toBeDefined();
    expect(found?.page).toBe(3);
    // "Visit " is six characters, so the box starts at 30 less the one-point padding.
    expect(found?.rect.x0).toBeCloseTo(29, 3);
    expect(found?.rect.x1).toBeCloseTo(text.length * 5 + 1, 3);
  });

  it('skips a candidate that is already a link', () => {
    const text = 'https://a.example';
    const chars = Array.from(text, (_c, i) => ({ x0: i * 5, y0: 0, x1: i * 5 + 5, y1: 10 }));
    const run: TextRun = {
      text,
      rect: { x0: 0, y0: 0, x1: text.length * 5, y1: 10 },
      chars,
      origin: { x: 0, y: 0 },
      matrix: [1, 0, 0, 1, 0, 0],
      fontName: 'Helvetica',
      fontSize: 10,
      color: 0,
      objectIndex: 0,
    };
    expect(detectLinks(0, [run])).toHaveLength(1);
    expect(detectLinks(0, [run], { existing: [{ x0: 10, y0: 0, x1: 20, y1: 10 }] })).toHaveLength(
      0,
    );
  });
});

describe('the stored model', () => {
  it('reads a spec back, and refuses one that is not a spec at all', () => {
    expect(readSpec(null)).toBeNull();
    expect(readSpec({ kind: 'sausages' })).toBeNull();
    const spec = readSpec({
      kind: 'header-footer',
      zones: { 'footer-centre': '<<1>>', nonsense: 'x' },
      size: 'big',
    });
    expect(spec?.kind).toBe('header-footer');
    if (spec?.kind !== 'header-footer') return;
    expect(spec.zones).toEqual({ 'footer-centre': '<<1>>' });
    // A field that is not a number falls back rather than throwing.
    expect(spec.size).toBe(10);
  });

  it('drops a decoration whose spec cannot be read, and keeps the rest', () => {
    const state = readDecorationsState({
      items: [
        { id: 'd1', kind: 'header-footer', range: '', pages: ['p1'], spec: { kind: 'nope' } },
        {
          id: 'd2',
          kind: 'bates',
          range: '1-3',
          pages: ['p1', 'p2'],
          appliedAt: '2026-09-11T00:00:00.000Z',
          spec: { kind: 'bates', prefix: 'A' },
        },
      ],
      pages: { p1: { original: 'AAA', resources: '<<>>' }, p2: 'rubbish' },
      seq: 4,
    });
    expect(state.items.map((d) => d.id)).toEqual(['d2']);
    expect(state.items[0]?.pages).toEqual(['p1', 'p2']);
    expect(Object.keys(state.pages)).toEqual(['p1']);
    expect(state.seq).toBe(4);
  });
});

describe('presets', () => {
  it('ships one for every family', () => {
    for (const kind of ['header-footer', 'bates', 'watermark', 'background']) {
      expect(
        BUILT_IN_PRESETS.some((p) => p.kind === kind),
        kind,
      ).toBe(true);
    }
    expect(BUILT_IN_PRESETS.every((p) => !p.custom)).toBe(true);
  });

  it('round-trips the reader’s own through the settings string', () => {
    const first = BUILT_IN_PRESETS[0];
    expect(first).toBeDefined();
    if (!first) return;
    const mine = { ...first, id: 'mine', name: 'Mine', custom: true };
    const json = presetsToJson(withPreset([], mine));
    const back = readCustomPresets(json);
    expect(back).toHaveLength(1);
    expect(back[0]?.name).toBe('Mine');
    expect(back[0]?.custom).toBe(true);
    // Built-ins are never written to the reader's settings.
    expect(readCustomPresets(presetsToJson([first]))).toHaveLength(0);
    expect(readCustomPresets('not json at all')).toEqual([]);
  });

  it('makes an id that does not collide', () => {
    const first = BUILT_IN_PRESETS[0];
    if (!first) return;
    const taken = [{ ...first, id: 'my-preset', custom: true }];
    expect(presetId('My preset', taken)).toBe('my-preset-2');
    expect(presetId('!!!', [])).toBe('preset');
  });
});

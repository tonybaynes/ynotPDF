/**
 * Colour maths and theme-file parsing (M01). These are the primitives the contrast and
 * colour-vision tests stand on, so they are checked against published reference values rather
 * than against themselves.
 */

import { describe, expect, it } from 'vitest';
import {
  contrastRatio,
  formatRatio,
  fromLinear,
  lightness,
  lightnessFromLuminance,
  linearToSrgb,
  parseHex,
  relativeLuminance,
  simulateCvd,
  srgbToLinear,
  toHex,
  toLab,
  toLinear,
} from '@theme/contrast';
import { isHexColor, parseThemeCss, stripCssComments, tokenNamesFromDocs } from '@theme/parse';
import { MIN_DELTA_B, separatesUnderAllModels, VISION_MODELS } from '@theme/separation';

describe('parseHex', () => {
  it('reads the 3, 4, 6 and 8 digit forms', () => {
    expect(parseHex('#fff')).toEqual({ r: 255, g: 255, b: 255 });
    expect(parseHex('#1a2b3c')).toEqual({ r: 26, g: 43, b: 60 });
    expect(parseHex('#ABC')).toEqual({ r: 170, g: 187, b: 204 });
    expect(parseHex('  #0f0f0f  ')).toEqual({ r: 15, g: 15, b: 15 });
    // Alpha digits are ignored — theme files may not use them anyway.
    expect(parseHex('#11223344')).toEqual({ r: 17, g: 34, b: 51 });
    expect(parseHex('#abcd')).toEqual({ r: 170, g: 187, b: 204 });
  });

  it('refuses anything that is not hex', () => {
    for (const bad of ['red', 'rgb(0,0,0)', '#12', '', '#gggggg', '#1234567']) {
      expect(() => parseHex(bad), bad).toThrow(/Not a hex colour/);
    }
  });
});

describe('contrast', () => {
  it('matches the WCAG reference values', () => {
    expect(contrastRatio('#ffffff', '#000000')).toBeCloseTo(21, 5);
    expect(contrastRatio('#000000', '#000000')).toBeCloseTo(1, 5);
    // Published examples: #777777 on white is 4.48:1; #767676 is the 4.54:1 AA threshold.
    expect(contrastRatio('#777777', '#ffffff')).toBeCloseTo(4.48, 2);
    expect(contrastRatio('#767676', '#ffffff')).toBeCloseTo(4.54, 2);
  });

  it('does not care about the order of its arguments', () => {
    expect(contrastRatio('#123456', '#fedcba')).toBeCloseTo(contrastRatio('#fedcba', '#123456'), 9);
  });

  it('accepts parsed triples as well as strings', () => {
    expect(contrastRatio(parseHex('#ffffff'), parseHex('#000000'))).toBeCloseTo(21, 5);
  });

  it('computes relative luminance for the primaries', () => {
    expect(relativeLuminance(parseHex('#ffffff'))).toBeCloseTo(1, 6);
    expect(relativeLuminance(parseHex('#000000'))).toBeCloseTo(0, 6);
    expect(relativeLuminance(parseHex('#00ff00'))).toBeCloseTo(0.7152, 4);
  });

  it('formats a ratio without rounding up past a threshold', () => {
    expect(formatRatio(4.499)).toBe('4.49:1');
    expect(formatRatio(21)).toBe('21.00:1');
  });
});

describe('sRGB and Lab conversions', () => {
  it('round-trips through linear light', () => {
    for (const hex of ['#000000', '#ffffff', '#4da3ff', '#3a2900']) {
      expect(toHex(fromLinear(toLinear(parseHex(hex))))).toBe(hex);
    }
  });

  it('uses the piecewise sRGB transfer function', () => {
    expect(srgbToLinear(0)).toBe(0);
    expect(srgbToLinear(255)).toBeCloseTo(1, 9);
    expect(srgbToLinear(10)).toBeCloseTo(0.0030352, 6); // below the 0.04045 knee
    expect(linearToSrgb(0)).toBe(0);
    expect(linearToSrgb(1)).toBeCloseTo(255, 6);
    expect(linearToSrgb(-5)).toBe(0); // clamped
    expect(linearToSrgb(50)).toBeCloseTo(255, 6); // clamped
  });

  it('clamps out-of-gamut channels when writing hex', () => {
    expect(toHex({ r: -20, g: 300, b: 127.6 })).toBe('#00ff80');
  });

  it('reports L* on the 0–100 scale', () => {
    expect(lightness('#000000')).toBeCloseTo(0, 6);
    expect(lightness('#ffffff')).toBeCloseTo(100, 6);
    expect(lightness('#777777')).toBeCloseTo(50.03, 1);
    expect(lightnessFromLuminance(0.008)).toBeCloseTo(7.22, 1); // the linear branch
  });

  it('puts yellow and blue at the ends of the b* axis', () => {
    expect(toLab('#ffff00').b).toBeGreaterThan(90);
    expect(toLab('#0000ff').b).toBeLessThan(-100);
    expect(toLab('#808080').a).toBeCloseTo(0, 1);
    expect(toLab('#000000').L).toBeCloseTo(0, 6); // the linear branch of f(t)
  });
});

describe('colour-vision simulation', () => {
  it('leaves greys alone under every model', () => {
    for (const model of ['protanopia', 'deuteranopia', 'tritanopia'] as const) {
      const seen = simulateCvd('#808080', model);
      expect(Math.abs(seen.r - 128), model).toBeLessThan(4);
      expect(Math.abs(seen.b - 128), model).toBeLessThan(6);
    }
  });

  it('turns red towards yellow-olive for protanopes and deuteranopes', () => {
    expect(toLab(toHex(simulateCvd('#ff0000', 'protanopia'))).a).toBeLessThan(
      toLab('#ff0000').a - 40,
    );
    expect(toLab(toHex(simulateCvd('#ff0000', 'deuteranopia'))).a).toBeLessThan(
      toLab('#ff0000').a - 40,
    );
  });

  it('leaves the blue-yellow axis largely intact for red-green deficiencies', () => {
    for (const model of ['protanopia', 'deuteranopia'] as const) {
      const yellow = toLab(toHex(simulateCvd('#ffff00', model)));
      const blue = toLab(toHex(simulateCvd('#0000ff', model)));
      expect(yellow.b - blue.b, model).toBeGreaterThan(MIN_DELTA_B * 2);
    }
  });

  it('affects the blue-yellow axis under tritanopia', () => {
    const before = Math.abs(toLab('#ffff00').b - toLab('#0000ff').b);
    const after = Math.abs(
      toLab(toHex(simulateCvd('#ffff00', 'tritanopia'))).b -
        toLab(toHex(simulateCvd('#0000ff', 'tritanopia'))).b,
    );
    expect(after).toBeLessThan(before);
  });
});

describe('separation', () => {
  it('checks a pair under every vision model at once', () => {
    const results = separatesUnderAllModels('#ffe14d', '#5aa9ff');
    expect(results).toHaveLength(VISION_MODELS.length);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(results.map((r) => r.model)).toEqual([...VISION_MODELS]);
  });

  it('reports which channel carries the difference', () => {
    // Same hue, far apart in lightness.
    expect(separatesUnderAllModels('#ffe14d', '#3a2900')[0]?.by).toBe('lightness');
    // Nearly the same lightness, opposite ends of blue↔yellow.
    const blueYellow = separatesUnderAllModels('#ffe14d', '#b3f0e0')[0];
    expect(blueYellow?.by).toBe('blue-yellow');
    // Two reds a dichromat cannot separate at all.
    const hopeless = separatesUnderAllModels('#c0392b', '#a93226')[0];
    expect(hopeless?.ok).toBe(false);
    expect(hopeless?.by).toBe('none');
    expect(hopeless?.deltaA).toBeGreaterThanOrEqual(0);
  });
});

describe('theme css parsing', () => {
  const css = `
    /* a comment with --not-a-token: #fff; in it */
    [data-theme='demo'] {
      color-scheme: light;
      --bg-app: #ffffff;
      --fg: #101010;
    }
  `;

  it('reads the name, colour scheme and tokens', () => {
    const parsed = parseThemeCss(css);
    expect(parsed.name).toBe('demo');
    expect(parsed.colorScheme).toBe('light');
    expect(parsed.tokens.get('--bg-app')).toBe('#ffffff');
    expect(parsed.tokens.size).toBe(2);
  });

  it('accepts double quotes and several blocks for one theme', () => {
    const parsed = parseThemeCss(
      `[data-theme="demo"] { --a: #111; } [data-theme="demo"] { --b: #222; }`,
    );
    expect(parsed.tokens.get('--b')).toBe('#222');
  });

  it('throws when the file has no theme block', () => {
    expect(() => parseThemeCss(':root { --a: #fff; }')).toThrow(/no \[data-theme\] block/);
  });

  it('strips comments', () => {
    expect(stripCssComments('a /* b */ c')).toBe('a  c');
  });

  it('reads the documented token list in order, without duplicates', () => {
    const names = tokenNamesFromDocs(
      ` *   --bg-app  first\n *   --fg  second\n *   --bg-app  again`,
    );
    expect(names).toEqual(['--bg-app', '--fg']);
  });

  it('recognises plain hex values only', () => {
    expect(isHexColor('#abc')).toBe(true);
    expect(isHexColor('#AABBCC')).toBe(true);
    expect(isHexColor('rgb(0 0 0)')).toBe(false);
    expect(isHexColor('var(--x)')).toBe(false);
    expect(isHexColor('#abcd')).toBe(false); // alpha is not allowed in a theme file
  });
});

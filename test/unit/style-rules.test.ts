import { describe, expect, it } from 'vitest';
import { checkSource, formatViolation, isThemeFile } from '../../scripts/lib/style-rules';

const app = 'src/renderer/app/shell.css';
const theme = 'src/renderer/theme/graphite.css';

describe('style rules', () => {
  it('fails on a hex colour literal outside theme/', () => {
    const v = checkSource(app, '.a { color: #fff; }');
    expect(v).toHaveLength(1);
    expect(v[0]?.rule).toBe('color-literal');
    expect(v[0]?.line).toBe(1);
  });

  it('allows hex colours inside theme/', () => {
    expect(checkSource(theme, ':root { --fg: #fff; --bg: #1a1a1a; }')).toEqual([]);
    expect(isThemeFile('src\\renderer\\theme\\midnight.css')).toBe(true);
    expect(isThemeFile(app)).toBe(false);
  });

  it('fails on rgba() with alpha < 1 — everywhere, including theme/', () => {
    expect(checkSource(app, 'background: rgba(0,0,0,.5);').map((v) => v.rule)).toEqual(
      expect.arrayContaining(['alpha']),
    );
    const themed = checkSource(theme, '--overlay: rgba(0, 0, 0, 0.5);');
    expect(themed).toHaveLength(1);
    expect(themed[0]?.rule).toBe('alpha');
    expect(checkSource(theme, '--x: hsla(200 50% 50% / 50%);')[0]?.rule).toBe('alpha');
    expect(checkSource(theme, '--x: rgb(0 0 0 / 0.3);')[0]?.rule).toBe('alpha');
  });

  it('allows rgba()/hsla() with alpha 1 inside theme/', () => {
    expect(checkSource(theme, '--x: rgba(0,0,0,1); --y: hsla(1,2%,3%,100%);')).toEqual([]);
  });

  it('fails on opacity < 1, allows opacity 1', () => {
    expect(checkSource(app, '.m { opacity: .9; }')[0]?.rule).toBe('opacity');
    expect(checkSource(app, '.m { opacity: 0; }')[0]?.rule).toBe('opacity');
    expect(checkSource(app, 'el.style.opacity = "0.5";')[0]?.rule).toBe('opacity');
    expect(checkSource(app, '.m { opacity: 1; }')).toEqual([]);
    expect(checkSource(theme, '.m { opacity: 50%; }')[0]?.rule).toBe('opacity');
  });

  it('fails on backdrop-filter (CSS and inline JS)', () => {
    expect(checkSource(app, '.m { backdrop-filter: blur(4px); }')[0]?.rule).toBe('backdrop-filter');
    expect(checkSource(app, 'el.style.backdropFilter = "blur(2px)";')[0]?.rule).toBe(
      'backdrop-filter',
    );
    expect(checkSource(theme, '.m { backdrop-filter: none; }')[0]?.rule).toBe('backdrop-filter');
  });

  it('catches functional and named colours and inline TS styles outside theme/', () => {
    expect(checkSource(app, 'color: rgb(1,2,3);')[0]?.rule).toBe('color-literal');
    expect(checkSource(app, 'fill: hsl(1,2%,3%);')[0]?.rule).toBe('color-literal');
    expect(checkSource(app, 'color: oklch(0.5 0.1 200);')[0]?.rule).toBe('color-literal');
    expect(checkSource(app, 'background: white;')[0]?.rule).toBe('color-literal');
    expect(checkSource(app, 'border: 1px solid red;')[0]?.rule).toBe('color-literal');
    expect(checkSource('src/renderer/app/x.ts', "el.style.color = 'black';")[0]?.rule).toBe(
      'color-literal',
    );
    expect(
      checkSource('src/renderer/app/x.ts', "el.style.backgroundColor = '#ABCDEF';")[0]?.rule,
    ).toBe('color-literal');
  });

  it('does not flag tokens, transparent/currentColor, ids, comments or the allow marker', () => {
    const ok = [
      'color: var(--fg);',
      'background: transparent; fill: currentColor;',
      '<div id="#app">',
      'const url = "https://example.com/#section";',
      '/* color: #fff */',
      '// background: red',
      ' * opacity: .5 in a JSDoc block',
      'const whitelist = ["a"];',
      'reddit.example',
      'color: #fff; /* ynot-allow-color: PDF content colour */',
      'const GOLD = "goldenrod-ish";',
      'greenlight()',
    ].join('\n');
    expect(checkSource(app, ok)).toEqual([]);
  });

  it('reports the right line numbers and formats violations', () => {
    const v = checkSource(app, 'a{}\nb{ color:#123456 }\nc{ opacity: .1 }');
    expect(v.map((x) => [x.line, x.rule])).toEqual([
      [2, 'color-literal'],
      [3, 'opacity'],
    ]);
    const first = v[0];
    expect(first).toBeDefined();
    if (first) expect(formatViolation(first)).toContain(`${app}:2`);
    for (const rule of ['alpha', 'opacity', 'backdrop-filter'] as const) {
      expect(formatViolation({ file: app, line: 1, rule, text: 'x' })).toContain(app);
    }
  });
});

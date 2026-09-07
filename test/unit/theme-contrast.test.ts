/**
 * Contrast test (M01). Parses every theme file, checks every documented foreground/background
 * pair from `pairs.ts` against its WCAG threshold, and enforces the opacity rules. Failing this
 * test fails the build — that is the point: a palette tweak cannot quietly break readability.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { contrastRatio, formatRatio } from '@theme/contrast';
import { isHexColor, parseThemeCss, stripCssComments, tokenNamesFromDocs } from '@theme/parse';
import { CONTRAST_PAIRS } from '@theme/pairs';
import { THEMES } from '@theme/themes';

const THEME_DIR = join(process.cwd(), 'src/renderer/theme');

function readTheme(file: string): string {
  return readFileSync(join(THEME_DIR, file), 'utf8');
}

/**
 * Every colour token the catalogue documents. `tokenNamesFromDocs` reads the comment list at
 * the top of tokens.css, which covers the colour tokens only — the non-colour ones (type
 * scale, spacing, radius, --ui-scale) are plain declarations on `:root`.
 */
const DOCUMENTED_TOKENS = tokenNamesFromDocs(readTheme('tokens.css'));

describe('theme tokens', () => {
  it('documents at least the tokens the pair table uses', () => {
    const used = new Set(CONTRAST_PAIRS.flatMap((p) => [p.fg, p.bg]));
    for (const token of used) expect(DOCUMENTED_TOKENS).toContain(token);
  });

  for (const theme of THEMES) {
    describe(theme.name, () => {
      const parsed = parseThemeCss(readTheme(theme.file));

      it('declares the right selector and color-scheme', () => {
        expect(parsed.name).toBe(theme.name);
        /*
         * The `only` keyword is required, not cosmetic: it forbids the browser substituting a
         * scheme of its own. Without it, Chrome's Auto Dark Mode repaints any subtree that says
         * `color-scheme: light`, which made the Daylight palette render dark in the gallery.
         */
        expect(parsed.colorScheme).toBe(`${theme.scheme} only`);
      });

      it('defines every documented colour token as a plain hex value', () => {
        for (const token of DOCUMENTED_TOKENS) {
          const value = parsed.tokens.get(token);
          expect(value, `${theme.name} is missing ${token}`).toBeDefined();
          expect(isHexColor(value ?? ''), `${theme.name} ${token} = ${value ?? ''}`).toBe(true);
        }
      });

      it('defines no tokens the catalogue does not document', () => {
        for (const token of parsed.tokens.keys()) {
          if (token === '--border-width') continue; // themes may thicken borders
          expect(DOCUMENTED_TOKENS, `${theme.name} declares undocumented ${token}`).toContain(
            token,
          );
        }
      });

      it('uses no transparency: no alpha < 1, no opacity, no backdrop-filter', () => {
        const css = stripCssComments(readTheme(theme.file));
        expect(css).not.toMatch(/rgba\s*\(/i);
        expect(css).not.toMatch(/hsla\s*\(/i);
        expect(css).not.toMatch(/\/\s*0?\.\d+\s*\)/);
        expect(css).not.toMatch(/opacity\s*:/i);
        expect(css).not.toMatch(/backdrop-filter/i);
      });

      it.each(CONTRAST_PAIRS.map((p) => [`${p.fg} on ${p.bg}`, p] as const))(
        'contrast %s',
        (_label, pair) => {
          const fg = parsed.tokens.get(pair.fg);
          const bg = parsed.tokens.get(pair.bg);
          expect(fg, `${theme.name} missing ${pair.fg}`).toBeDefined();
          expect(bg, `${theme.name} missing ${pair.bg}`).toBeDefined();
          const ratio = contrastRatio(fg ?? '#000', bg ?? '#000');
          expect(
            ratio,
            `${theme.name}: ${pair.fg} (${fg ?? ''}) on ${pair.bg} (${bg ?? ''}) is ` +
              `${formatRatio(ratio)}, needs ${pair.min}:1 for ${pair.kind}`,
          ).toBeGreaterThanOrEqual(pair.min);
        },
      );
    });
  }
});

describe('the contrast test actually catches a broken token', () => {
  it('fails when --fg-muted is dimmed to grey-on-dark', () => {
    const broken = readTheme('graphite.css').replace(
      /--fg-muted:\s*#[0-9a-f]{3,8};/i,
      '--fg-muted: #6a6a6a;',
    );
    const parsed = parseThemeCss(broken);
    const ratio = contrastRatio(parsed.tokens.get('--fg-muted') ?? '', '#121212');
    expect(ratio).toBeLessThan(4.5);
  });

  it('fails when a border is dropped below 3:1', () => {
    const ratio = contrastRatio('#2e2e33', '#121212');
    expect(ratio).toBeLessThan(3);
  });
});

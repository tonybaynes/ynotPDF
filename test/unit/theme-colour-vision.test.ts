/**
 * Colour-vision test (M01). Simulates protanopia and deuteranopia (Machado 2009, severity 1.0)
 * on the four status colours of every theme and asserts each pair stays distinguishable — by
 * lightness (ΔL* ≥ 20) or by the blue↔yellow axis (Δb* ≥ 45), never by red↔green alone.
 * See `src/renderer/theme/separation.ts` for why the rule has two channels.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { contrastRatio, lightness, parseHex, simulateCvd, toHex, toLab } from '@theme/contrast';
import { parseThemeCss } from '@theme/parse';
import { STATUS } from '@theme/pairs';
import { MIN_DELTA_B, MIN_DELTA_L, seenAs, separation, VISION_MODELS } from '@theme/separation';
import { THEMES } from '@theme/themes';

const THEME_DIR = join(process.cwd(), 'src/renderer/theme');

const PAIRS: [string, string][] = STATUS.flatMap((a, i) =>
  STATUS.slice(i + 1).map((b) => [a, b] as [string, string]),
);

describe('colour vision', () => {
  it('the Machado matrices collapse red and green as expected', () => {
    // Pure red and pure green must become hard to tell apart on the red↔green axis...
    const red = toLab(toHex(simulateCvd('#ff0000', 'deuteranopia')));
    const green = toLab(toHex(simulateCvd('#00ff00', 'deuteranopia')));
    expect(Math.abs(red.a - green.a)).toBeLessThan(60);
    // ...while blue and yellow stay far apart on the blue↔yellow axis.
    const blue = toLab(toHex(simulateCvd('#0000ff', 'deuteranopia')));
    const yellow = toLab(toHex(simulateCvd('#ffff00', 'deuteranopia')));
    expect(Math.abs(blue.b - yellow.b)).toBeGreaterThan(100);
  });

  it('simulating normal vision changes nothing', () => {
    expect(seenAs('#4da3ff', 'normal')).toBe('#4da3ff');
  });

  for (const theme of THEMES) {
    describe(theme.name, () => {
      const parsed = parseThemeCss(readFileSync(join(THEME_DIR, theme.file), 'utf8'));
      const value = (token: string): string => {
        const v = parsed.tokens.get(token);
        if (v === undefined) throw new Error(`${theme.name} is missing ${token}`);
        return v;
      };

      for (const model of VISION_MODELS) {
        for (const [a, b] of PAIRS) {
          it(`${a} vs ${b} under ${model}`, () => {
            const result = separation(value(a), value(b), model);
            expect(
              result.ok,
              `${theme.name}: ${a} (${value(a)} → ${seenAs(value(a), model)}) and ` +
                `${b} (${value(b)} → ${seenAs(value(b), model)}) differ by ` +
                `ΔL*=${result.deltaL.toFixed(1)} (needs ${MIN_DELTA_L}) and ` +
                `Δb*=${result.deltaB.toFixed(1)} (needs ${MIN_DELTA_B}) under ${model}`,
            ).toBe(true);
          });
        }
      }

      it('never leaves red↔green as the only difference', () => {
        for (const [a, b] of PAIRS) {
          for (const model of VISION_MODELS) {
            const r = separation(value(a), value(b), model);
            expect(r.by, `${a}/${b} under ${model}`).not.toBe('none');
          }
        }
      });

      it('has no red text on a dark surface', () => {
        // "Red on black is forbidden in every theme": a warm, strongly red foreground may not
        // be the danger colour when the app background is dark.
        const bg = parseHex(value('--bg-app'));
        const isDark = lightness(bg) < 50;
        if (!isDark) return;
        const danger = toLab(value('--danger'));
        // Pure reds sit near a* > 60 with b* < 45; ours is an orange-red carried by lightness.
        expect(danger.a < 60 || danger.b >= 45).toBe(true);
        expect(contrastRatio(value('--danger'), value('--bg-app'))).toBeGreaterThanOrEqual(4.5);
      });
    });
  }
});

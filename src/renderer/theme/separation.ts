/**
 * Status-colour separation rule (M01).
 *
 * The operator is colourblind: red and black read as one colour, and red↔green or gold↔green
 * differences carry no information. Status must therefore separate on the two channels a
 * dichromat keeps: **lightness (L\*)** and the **blue↔yellow axis (b\*)**. The red↔green axis
 * (a\*) is never allowed to be the only difference.
 *
 * Why "L\* ≥ 20 **or** b\* ≥ 45" and not the flat "ΔL\* ≥ 20" the brief first sketched:
 * every status colour must also clear 4.5:1 as text. On the darkest surface (#000000) that
 * puts all four statuses above L\* 48.9, leaving a 51-point lightness range; four colours
 * pairwise 20 apart need 60. The flat rule is arithmetically impossible without breaking the
 * (non-negotiable) contrast floor, so lightness is backed by the blue↔yellow axis, which
 * survives both protanopia and deuteranopia. See docs/modules/M01-theme-system.md.
 */

import { lightness, simulateCvd, toHex, toLab } from './contrast';

/** Minimum perceptual lightness difference for a pair separated by lightness. */
export const MIN_DELTA_L = 20;
/** Minimum blue↔yellow (CIE b\*) difference for a pair separated by that axis. */
export const MIN_DELTA_B = 45;

/** The vision models every pair is checked under. */
export const VISION_MODELS = ['normal', 'protanopia', 'deuteranopia'] as const;
export type VisionModel = (typeof VISION_MODELS)[number];

export interface SeparationResult {
  readonly model: VisionModel;
  /** |ΔL\*| as seen under this model. */
  readonly deltaL: number;
  /** |Δb\*| (blue↔yellow) as seen under this model. */
  readonly deltaB: number;
  /** |Δa\*| (red↔green) — reported only to show it is not what carries the difference. */
  readonly deltaA: number;
  readonly ok: boolean;
  /** Which channel carries the separation. */
  readonly by: 'lightness' | 'blue-yellow' | 'none';
}

/** Applies a vision model to a colour. `normal` returns it unchanged. */
export function seenAs(color: string, model: VisionModel): string {
  return model === 'normal' ? color : toHex(simulateCvd(color, model));
}

/** Measures how two colours separate under one vision model. */
export function separation(a: string, b: string, model: VisionModel): SeparationResult {
  const ca = seenAs(a, model);
  const cb = seenAs(b, model);
  const la = toLab(ca);
  const lb = toLab(cb);
  const deltaL = Math.abs(lightness(ca) - lightness(cb));
  const deltaB = Math.abs(la.b - lb.b);
  const deltaA = Math.abs(la.a - lb.a);
  const byL = deltaL >= MIN_DELTA_L;
  const byB = deltaB >= MIN_DELTA_B;
  return {
    model,
    deltaL,
    deltaB,
    deltaA,
    ok: byL || byB,
    by: byL ? 'lightness' : byB ? 'blue-yellow' : 'none',
  };
}

/** Checks a pair under every vision model; all must pass. */
export function separatesUnderAllModels(a: string, b: string): SeparationResult[] {
  return VISION_MODELS.map((m) => separation(a, b, m));
}

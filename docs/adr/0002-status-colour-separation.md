# ADR 0002 — Status colours separate on lightness _or_ blue↔yellow

- Status: accepted
- Date: 2026-09-07
- Module: M01 (theme system)

## Context

`docs/modules/M01-theme-system.md` asked for a colour-vision test that simulates protanopia and
deuteranopia on `--danger`, `--warning`, `--success` and `--info` and asserts the four "remain
pairwise distinguishable by lightness (ΔL\* ≥ 20)".

That rule cannot hold together with the contrast floor, which is non-negotiable
(`CLAUDE.md`: text ≥ 4.5:1). Every status colour is used as text, so on the darkest surface a
theme has (`#000000` in Midnight and High Contrast) each one needs a relative luminance of at
least 0.175, i.e. **L\* ≥ 48.9**. Lightness tops out at 100, so all four must fit inside a
51-point band, while four values pairwise 20 apart need a 60-point span. The same squeeze
happens from the other end on the light theme: text on white must sit at **L\* ≤ 49.9**.

Four colours, pairwise ΔL\* ≥ 20, with a 4.5:1 contrast floor, is arithmetically impossible.

## Decision

A status pair counts as distinguishable when, under normal vision **and** simulated protanopia
**and** simulated deuteranopia (Machado, Oliveira & Fernandes 2009, severity 1.0), it differs by

- **ΔL\* ≥ 20** (perceptual lightness), **or**
- **Δb\* ≥ 45** on the CIE L\*a\*b\* blue↔yellow axis.

Separation by the red↔green axis (Δa\*) alone never counts: `separation()` reports which channel
carries the difference and the test asserts it is never `none`. The thresholds and the rule live
in `src/renderer/theme/separation.ts`; `test/unit/theme-colour-vision.test.ts` enforces them for
all four themes.

The palettes are laid out so each theme has one warm/cool pair at each end of the usable
lightness band: same-family pairs separate by lightness, cross-family pairs by blue↔yellow.

## Consequences

- The colour-vision test is stricter than the brief in one respect (it also checks normal
  vision, and it forbids red↔green-only separation) and looser in one (a pair may lean on
  blue↔yellow instead of lightness).
- Blue↔yellow is the right second channel: it is precisely the axis both red-green
  deficiencies preserve, and it is the one the operator relies on.
- Status is still never colour alone — the UI pairs every status with a word and an icon
  (`CLAUDE.md`), so the colour is a reinforcement, not the signal.
- If a future theme wants four statuses each 20 apart in lightness, it would have to drop below
  4.5:1 somewhere. That is not allowed, so this rule stands.

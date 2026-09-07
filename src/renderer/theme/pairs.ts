/**
 * Which colour tokens sit on which (M01). The contrast test (`test/unit/theme-contrast.test.ts`)
 * checks every pair in every theme; the gallery shows the same numbers. If you use a token on a
 * surface that is not listed here, add the pair — the rule is "no untested combination".
 *
 * Thresholds (CLAUDE.md / PLAN.md §3.2): text ≥ 4.5:1, icons and borders ≥ 3:1,
 * `--fg-muted` ≥ 4.5:1 (no dim grey on dark). `--fg-placeholder` is the one permitted
 * low-contrast text and must still reach 3:1.
 */

export interface ContrastPair {
  /** The token drawn on top (text, icon, border, focus ring...). */
  readonly fg: string;
  /** The token underneath. */
  readonly bg: string;
  /** Minimum WCAG ratio. */
  readonly min: number;
  /** What the foreground is, for messages and the gallery. */
  readonly kind: 'text' | 'icon' | 'border' | 'focus' | 'fill';
}

/** Surfaces text and icons are laid on. Every `--bg-*` token except the page paper. */
export const SURFACES = [
  '--bg-app',
  '--bg-panel',
  '--bg-ribbon',
  '--bg-input',
  '--bg-hover',
  '--bg-active',
  '--bg-selected',
  '--bg-modal',
  '--bg-canvas',
] as const;

/** Surfaces that normally carry a `--border` edge (state fills use `--border-strong`). */
export const BORDERED_SURFACES = [
  '--bg-app',
  '--bg-panel',
  '--bg-ribbon',
  '--bg-input',
  '--bg-modal',
  '--bg-canvas',
] as const;

/** Surfaces status colours and accent are used as *text* on. */
export const TEXT_SURFACES = ['--bg-app', '--bg-panel', '--bg-ribbon', '--bg-input'] as const;

export const STATUS = ['--danger', '--warning', '--success', '--info'] as const;
export type StatusToken = (typeof STATUS)[number];

export const TEXT_MIN = 4.5;
export const GRAPHIC_MIN = 3;

function pairs(
  fgs: ReadonlyArray<string>,
  bgs: ReadonlyArray<string>,
  min: number,
  kind: ContrastPair['kind'],
): ContrastPair[] {
  const out: ContrastPair[] = [];
  for (const fg of fgs) for (const bg of bgs) out.push({ fg, bg, min, kind });
  return out;
}

/** The full table. Order matters only for display. */
export const CONTRAST_PAIRS: ReadonlyArray<ContrastPair> = [
  // Text on every surface.
  ...pairs(['--fg', '--fg-muted'], SURFACES, TEXT_MIN, 'text'),
  ...pairs(['--fg-placeholder'], ['--bg-input'], GRAPHIC_MIN, 'text'),
  ...pairs(['--fg-on-accent'], ['--accent', '--accent-hover'], TEXT_MIN, 'text'),
  // Icons on every surface (Lucide strokes use currentColor = --icon).
  ...pairs(['--icon', '--icon-disabled'], SURFACES, GRAPHIC_MIN, 'icon'),
  // Accent as link/active text on the main surfaces, as a graphic elsewhere.
  ...pairs(['--accent'], TEXT_SURFACES, TEXT_MIN, 'text'),
  ...pairs(
    ['--accent'],
    ['--bg-hover', '--bg-active', '--bg-selected', '--bg-modal', '--bg-canvas'],
    GRAPHIC_MIN,
    'icon',
  ),
  // --accent-hover only ever fills a hovered accent control, which sits on a calm surface —
  // never inside a selected row or a pressed fill, so those pairs are not part of the contract.
  ...pairs(['--accent-hover'], BORDERED_SURFACES, GRAPHIC_MIN, 'icon'),
  // Borders: 1 px separators on the calm surfaces; strong borders everywhere.
  ...pairs(['--border'], BORDERED_SURFACES, GRAPHIC_MIN, 'border'),
  ...pairs(['--border-strong', '--shadow'], SURFACES, GRAPHIC_MIN, 'border'),
  // Focus ring: the outer ring sits on the surface, the inner ring on the control's own fill.
  // One colour cannot do both on a light theme (a focus light enough to show on a dark accent
  // is too light for a white panel), hence the pair.
  ...pairs(['--focus'], SURFACES, GRAPHIC_MIN, 'focus'),
  ...pairs(['--focus-contrast'], ['--accent', '--accent-hover', '--focus'], GRAPHIC_MIN, 'focus'),
  // Text selection fill against the page paper; selected rows keep readable text.
  ...pairs(['--selection'], ['--page-paper'], GRAPHIC_MIN, 'fill'),
  ...pairs(['--page-ink'], ['--page-paper', '--selection'], TEXT_MIN, 'text'),
  // Night Mode swaps the page pair; the document must stay just as readable.
  ...pairs(['--page-ink-night'], ['--page-paper-night'], TEXT_MIN, 'text'),
  // Status colours: readable as text on the main surfaces, and their -fg pairs on top of them.
  ...pairs(STATUS, TEXT_SURFACES, TEXT_MIN, 'text'),
  ...pairs(
    STATUS,
    ['--bg-hover', '--bg-active', '--bg-selected', '--bg-modal'],
    GRAPHIC_MIN,
    'icon',
  ),
  { fg: '--danger-fg', bg: '--danger', min: TEXT_MIN, kind: 'text' },
  { fg: '--warning-fg', bg: '--warning', min: TEXT_MIN, kind: 'text' },
  { fg: '--success-fg', bg: '--success', min: TEXT_MIN, kind: 'text' },
  { fg: '--info-fg', bg: '--info', min: TEXT_MIN, kind: 'text' },
  // Annotation defaults are drawn on the page: fills keep page ink readable, strokes stand out.
  ...pairs(['--page-ink'], ['--annot-highlight'], TEXT_MIN, 'text'),
  ...pairs(
    ['--annot-note', '--annot-ink', '--annot-shape', '--annot-underline', '--annot-strikeout'],
    ['--page-paper'],
    GRAPHIC_MIN,
    'fill',
  ),
  ...pairs(['--annot-redact-fg'], ['--annot-redact'], TEXT_MIN, 'text'),
  // The same contracts again with Night Mode on, against the darkened page.
  ...pairs(['--page-ink-night'], ['--annot-highlight-night'], TEXT_MIN, 'text'),
  ...pairs(
    [
      '--annot-note-night',
      '--annot-ink-night',
      '--annot-shape-night',
      '--annot-underline-night',
      '--annot-strikeout-night',
    ],
    ['--page-paper-night'],
    GRAPHIC_MIN,
    'fill',
  ),
];

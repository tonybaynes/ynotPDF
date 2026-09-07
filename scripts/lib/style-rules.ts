/**
 * Style rules enforced by `scripts/check-styles.ts` and unit-tested in
 * `test/unit/style-rules.test.ts`:
 *
 * 1. **No colour literals outside `src/renderer/theme/`** — hex (`#fff`, `#1a2b3c`),
 *    `rgb()`/`rgba()`/`hsl()`/`hsla()`, `color()`, `oklch()`, and CSS named colours in a colour
 *    position (`color: white`, `background: black`).
 * 2. **No `rgba()`/`hsla()` (or slash-alpha `rgb(... / .5)`) with alpha < 1** — anywhere.
 * 3. **No `opacity:` < 1** — anywhere (CSS or inline style strings). `opacity: 1` is fine.
 * 4. **No `backdrop-filter`** — anywhere.
 *
 * Runs over `.css`, `.html`, `.ts`, `.js` sources. Lines carrying the marker
 * `ynot-allow-color` are skipped (use sparingly, e.g. a PDF-content colour picker).
 */

export interface Violation {
  readonly file: string;
  readonly line: number;
  readonly rule: 'color-literal' | 'alpha' | 'opacity' | 'backdrop-filter';
  readonly text: string;
}

const NAMED_COLORS = [
  'white',
  'black',
  'red',
  'green',
  'blue',
  'yellow',
  'orange',
  'purple',
  'pink',
  'gray',
  'grey',
  'silver',
  'maroon',
  'navy',
  'teal',
  'olive',
  'lime',
  'aqua',
  'cyan',
  'magenta',
  'fuchsia',
  'brown',
  'gold',
  'tan',
  'beige',
  'ivory',
  'coral',
  'salmon',
  'crimson',
  'indigo',
  'violet',
  'turquoise',
  'khaki',
  'lavender',
  'plum',
  'orchid',
  'tomato',
  'wheat',
  'azure',
  'chocolate',
  'firebrick',
  'goldenrod',
  'honeydew',
  'hotpink',
  'lightblue',
  'lightgray',
  'lightgrey',
  'lightgreen',
  'darkblue',
  'darkgray',
  'darkgrey',
  'darkgreen',
  'darkred',
  'dimgray',
  'dimgrey',
  'whitesmoke',
  'snow',
  'slategray',
  'slategrey',
  'steelblue',
  'royalblue',
  'skyblue',
  'dodgerblue',
  'deepskyblue',
  'cornflowerblue',
  'midnightblue',
  'seagreen',
  'forestgreen',
  'limegreen',
  'springgreen',
  'chartreuse',
  'greenyellow',
  'yellowgreen',
  'orangered',
  'darkorange',
  'peru',
  'sienna',
  'rebeccapurple',
];

const COLOR_PROPS =
  'color|background|background-color|border|border-color|border-top|border-right|border-bottom|border-left|outline|outline-color|fill|stroke|box-shadow|text-shadow|caret-color|accent-color|text-decoration-color|column-rule-color';

/** Hex colour: 3, 4, 6 or 8 hex digits after `#`, not part of a longer identifier. */
const HEX_RE = /(^|[^\w&#])#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})(?![\w-])/i;
/** Functional colour notations. */
const FUNC_RE = /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/i;
/** Named colour in a colour position: `prop: name` or `prop: ... name` within a declaration. */
const NAMED_RE = new RegExp(
  `(?:^|[;{\\s'"])(?:${COLOR_PROPS})\\s*[:=]\\s*(?:[^;'"\\n]*\\s)?(?:${NAMED_COLORS.join('|')})\\b(?![-\\w(])`,
  'i',
);
/** Property-name-ish suffix like `color:`/`Color =` for inline style strings in TS. */
const NAMED_INLINE_RE = new RegExp(
  `\\.(?:style\\.)?(?:color|backgroundColor|borderColor|outlineColor|fill|stroke)\\s*=\\s*['"](?:${NAMED_COLORS.join('|')})['"]`,
  'i',
);

const ALPHA_FUNC_RE = /\b(rgba|hsla)\(\s*([^)]*)\)/gi;
const SLASH_ALPHA_RE =
  /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\([^)]*\/\s*([0-9.]+%?)\s*\)/gi;
const OPACITY_RE = /(?:^|[^\w-])opacity\s*[:=]\s*['"]?\s*([0-9.]+%?)/gi;
const BACKDROP_RE = /backdrop-filter|backdropFilter/i;

/** The single directory whose files may contain colour literals. */
export const THEME_DIR = 'src/renderer/theme/';

/** True when `file` (posix-style relative path) is inside the theme directory. */
export function isThemeFile(file: string): boolean {
  return file.replace(/\\/g, '/').includes(THEME_DIR);
}

function parseAlpha(raw: string): number | null {
  const s = raw.trim();
  if (s.endsWith('%')) {
    const n = Number.parseFloat(s.slice(0, -1));
    return Number.isNaN(n) ? null : n / 100;
  }
  const n = Number.parseFloat(s);
  return Number.isNaN(n) ? null : n;
}

/** Strip full-line and inline comments so commented-out examples don't trip the rules. */
function stripComments(line: string): string {
  return line
    .replace(/\/\*.*?\*\//g, '')
    .replace(/^\s*\*.*$/, '')
    .replace(/^\s*\/\/.*$/, '')
    .replace(/\s\/\/.*$/, '');
}

/** Checks one source file's text. `file` is the path used for the theme-dir exemption. */
export function checkSource(file: string, text: string): Violation[] {
  const out: Violation[] = [];
  const themed = isThemeFile(file);
  const lines = text.split(/\r?\n/);
  lines.forEach((raw, i) => {
    if (raw.includes('ynot-allow-color')) return;
    const line = stripComments(raw);
    if (!line.trim()) return;
    const at = (rule: Violation['rule']): void => {
      out.push({ file, line: i + 1, rule, text: raw.trim() });
    };

    if (BACKDROP_RE.test(line)) at('backdrop-filter');

    for (const m of line.matchAll(OPACITY_RE)) {
      const a = parseAlpha(m[1] ?? '');
      if (a !== null && a < 1) at('opacity');
    }

    for (const m of line.matchAll(ALPHA_FUNC_RE)) {
      const parts = (m[2] ?? '').split(/[,/]/).map((p) => p.trim());
      const last = parts[parts.length - 1];
      if (parts.length >= 4 && last !== undefined) {
        const a = parseAlpha(last);
        if (a !== null && a < 1) at('alpha');
      }
    }
    for (const m of line.matchAll(SLASH_ALPHA_RE)) {
      const a = parseAlpha(m[1] ?? '');
      if (a !== null && a < 1) at('alpha');
    }

    if (!themed) {
      if (
        HEX_RE.test(line) ||
        FUNC_RE.test(line) ||
        NAMED_RE.test(line) ||
        NAMED_INLINE_RE.test(line)
      ) {
        at('color-literal');
      }
    }
  });
  return out;
}

/** Human-readable one-liner per violation. */
export function formatViolation(v: Violation): string {
  const why: Record<Violation['rule'], string> = {
    'color-literal': 'colour literal outside src/renderer/theme/ (use a --token)',
    alpha: 'rgba()/hsla() alpha < 1 is not allowed (overlays must be opaque)',
    opacity: 'opacity < 1 is not allowed',
    'backdrop-filter': 'backdrop-filter is not allowed',
  };
  return `${v.file}:${v.line}: ${why[v.rule]}\n    ${v.text}`;
}

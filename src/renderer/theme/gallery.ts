/**
 * Theme gallery (M01, development only — never bundled into the app window).
 *
 * Renders all four themes side by side: every token as a swatch with its value, the whole
 * contrast pair table with its measured ratio and pass/fail, the status colours as they look
 * under protanopia and deuteranopia, and a sample of real UI (buttons, inputs, a dialog, a
 * status badge row) so the operator can approve the palettes by eye.
 *
 * Run it with `npm run gallery`, or open `src/renderer/theme/gallery.html` through the Vite
 * dev server. It reads the CSS files themselves, so what you see is what the app ships.
 */

/*
 * The CSS files are imported with Vite's `?raw` so the page reads the exact bytes that ship.
 * (Fetching a .css URL from the dev server returns Vite's JS module wrapper, not the file.)
 */
import tokensCss from './tokens.css?raw';
import graphiteCss from './graphite.css?raw';
import midnightCss from './midnight.css?raw';
import daylightCss from './daylight.css?raw';
import highContrastCss from './high-contrast.css?raw';
import { contrastRatio, formatRatio, lightness, toLab } from './contrast';
import { parseThemeCss, tokenNamesFromDocs } from './parse';
import { CONTRAST_PAIRS, STATUS } from './pairs';
import { seenAs, separation, VISION_MODELS } from './separation';
import { THEMES, type ThemeInfo } from './themes';

interface Loaded {
  readonly info: ThemeInfo;
  readonly tokens: ReadonlyMap<string, string>;
}

const THEME_CSS: Readonly<Record<string, string>> = {
  graphite: graphiteCss,
  midnight: midnightCss,
  daylight: daylightCss,
  'high-contrast': highContrastCss,
};

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  content?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content !== undefined) node.textContent = content;
  return node;
}

/** A block that renders in a given theme, whatever the page's own theme is. */
function themed(theme: string, className: string): HTMLElement {
  const box = el('div', className);
  box.dataset['theme'] = theme;
  return box;
}

/**
 * The surface each token is judged against in the swatch list. Most tokens are drawn on the app
 * background; the ones that live on the page or inside a filled control are measured against
 * what actually sits behind them.
 */
function referenceSurface(token: string): string {
  if (token.startsWith('--annot-') || token === '--selection' || token === '--page-ink') {
    return '--page-paper';
  }
  if (token === '--page-paper') return '--page-ink';
  if (token === '--fg-on-accent') return '--accent';
  if (token.endsWith('-fg')) return token.slice(0, -3);
  if (token === '--focus-contrast') return '--accent';
  return '--bg-app';
}

function swatchGrid(loaded: Loaded, tokenNames: readonly string[]): HTMLElement {
  const grid = themed(loaded.info.name, 'swatches');
  for (const token of tokenNames) {
    const value = loaded.tokens.get(token);
    if (!value) continue;
    const against = referenceSurface(token);
    const surface = loaded.tokens.get(against);
    const cell = el('div', 'swatch');
    const chip = el('span', 'chip');
    chip.style.background = `var(${token})`;
    if (surface) chip.style.borderColor = `var(${against})`;
    const name = el('code', 'token', token);
    const hex = el('code', 'value', value);
    const meta = el(
      'span',
      'meta',
      surface
        ? `${formatRatio(contrastRatio(value, surface))} on ${against}  ·  ` +
            `L* ${lightness(value).toFixed(0)}  b* ${toLab(value).b.toFixed(0)}`
        : `L* ${lightness(value).toFixed(0)}  b* ${toLab(value).b.toFixed(0)}`,
    );
    cell.append(chip, name, hex, meta);
    grid.append(cell);
  }
  return grid;
}

function pairTable(loaded: Loaded): HTMLElement {
  const wrap = el('div', 'scroll');
  const table = el('table', 'pairs');
  const head = el('tr');
  for (const h of ['Foreground', 'on Background', 'Kind', 'Needs', 'Measured', '']) {
    head.append(el('th', undefined, h));
  }
  table.append(head);
  let failures = 0;
  for (const pair of CONTRAST_PAIRS) {
    const fg = loaded.tokens.get(pair.fg);
    const bg = loaded.tokens.get(pair.bg);
    if (!fg || !bg) continue;
    const ratio = contrastRatio(fg, bg);
    const ok = ratio >= pair.min;
    if (!ok) failures++;
    const row = el('tr', ok ? undefined : 'bad');
    row.append(
      el('td', undefined, pair.fg),
      el('td', undefined, pair.bg),
      el('td', undefined, pair.kind),
      el('td', undefined, `${pair.min}:1`),
      el('td', undefined, formatRatio(ratio)),
    );
    const sample = el('td');
    const box = themed(loaded.info.name, 'sample');
    box.style.background = `var(${pair.bg})`;
    box.style.color = `var(${pair.fg})`;
    box.style.borderColor = `var(${pair.fg})`;
    box.textContent = 'Abg';
    sample.append(box);
    row.append(sample);
    table.append(row);
  }
  const caption = el(
    'p',
    failures === 0 ? 'ok' : 'bad',
    failures === 0
      ? `All ${String(CONTRAST_PAIRS.length)} pairs pass.`
      : `${String(failures)} pair(s) fail.`,
  );
  wrap.append(caption, table);
  return wrap;
}

function visionTable(loaded: Loaded): HTMLElement {
  const wrap = el('div', 'scroll');
  const table = el('table', 'vision');
  const head = el('tr');
  head.append(el('th', undefined, 'Status'));
  for (const model of VISION_MODELS) head.append(el('th', undefined, model));
  table.append(head);
  for (const token of STATUS) {
    const value = loaded.tokens.get(token);
    if (!value) continue;
    const row = el('tr');
    row.append(el('td', undefined, token));
    for (const model of VISION_MODELS) {
      const cell = el('td');
      const seen = seenAs(value, model);
      const chip = el('span', 'chip');
      chip.style.background = seen;
      cell.append(chip, el('code', 'value', seen));
      row.append(cell);
    }
    table.append(row);
  }

  const pairsTable = el('table', 'vision');
  const phead = el('tr');
  phead.append(el('th', undefined, 'Pair'));
  for (const model of VISION_MODELS) phead.append(el('th', undefined, model));
  pairsTable.append(phead);
  for (let i = 0; i < STATUS.length; i++) {
    for (let j = i + 1; j < STATUS.length; j++) {
      const a = STATUS[i];
      const b = STATUS[j];
      const va = a ? loaded.tokens.get(a) : undefined;
      const vb = b ? loaded.tokens.get(b) : undefined;
      if (!a || !b || !va || !vb) continue;
      const row = el('tr');
      row.append(el('td', undefined, `${a} / ${b}`));
      for (const model of VISION_MODELS) {
        const r = separation(va, vb, model);
        row.append(
          el(
            'td',
            r.ok ? 'ok' : 'bad',
            `ΔL* ${r.deltaL.toFixed(0)}  Δb* ${r.deltaB.toFixed(0)}  ${r.by}`,
          ),
        );
      }
      pairsTable.append(row);
    }
  }
  wrap.append(
    table,
    el('p', 'note', 'Separated by lightness (ΔL* ≥ 20) or blue↔yellow (Δb* ≥ 45).'),
    pairsTable,
  );
  return wrap;
}

function uiSample(loaded: Loaded): HTMLElement {
  const box = themed(loaded.info.name, 'ui-sample');
  const ribbon = el('div', 'ui-ribbon');
  for (const [i, name] of ['Home', 'Edit', 'Comment', 'View'].entries()) {
    const tab = el('button', i === 0 ? 'ui-tab active' : 'ui-tab', name);
    tab.type = 'button';
    ribbon.append(tab);
  }
  const body = el('div', 'ui-body');
  const heading = el('h4', undefined, 'Panel heading');
  const para = el('p', undefined, 'Primary text on the panel surface.');
  const muted = el('p', 'muted', 'Muted secondary text — still 4.5:1.');
  const controls = el('div', 'ui-controls');
  const primary = el('button', 'ui-btn primary', 'Primary');
  primary.type = 'button';
  const normal = el('button', 'ui-btn', 'Button');
  normal.type = 'button';
  const input = el('input');
  input.placeholder = 'Placeholder hint';
  input.setAttribute('aria-label', 'Sample input');
  controls.append(primary, normal, input);

  const statuses = el('div', 'ui-status');
  const words: Record<string, [string, string]> = {
    '--danger': ['✖', 'Error'],
    '--warning': ['▲', 'Warning'],
    '--success': ['✔', 'Done'],
    '--info': ['●', 'Info'],
  };
  for (const token of STATUS) {
    const pair = words[token];
    if (!pair) continue;
    const badge = el('span', 'badge');
    badge.style.color = `var(${token})`;
    badge.append(el('span', 'badge-icon', pair[0]), el('span', undefined, pair[1]));
    statuses.append(badge);
  }
  const filled = el('div', 'ui-status');
  for (const token of STATUS) {
    const pair = words[token];
    if (!pair) continue;
    const badge = el('span', 'badge filled');
    badge.style.background = `var(${token})`;
    badge.style.color = `var(${token}-fg)`;
    badge.append(el('span', 'badge-icon', pair[0]), el('span', undefined, pair[1]));
    filled.append(badge);
  }

  const page = el('div', 'ui-page');
  const paper = el('div', 'paper');
  paper.append(
    el('span', undefined, 'Page text with '),
    el('mark', 'hl', 'a highlight'),
    el('span', undefined, ' and '),
    el('mark', 'sel', 'a selection'),
    el('span', undefined, '.'),
  );
  page.append(paper);

  body.append(heading, para, muted, controls, statuses, filled, page);
  box.append(ribbon, body);
  return box;
}

function main(): void {
  const root = document.getElementById('gallery');
  if (!root) throw new Error('#gallery missing');
  const tokenNames = tokenNamesFromDocs(tokensCss);
  const loaded: Loaded[] = THEMES.map((info) => {
    const css = THEME_CSS[info.name];
    if (css === undefined) throw new Error(`no CSS imported for ${info.name}`);
    return { info, tokens: parseThemeCss(css).tokens };
  });

  const nav = el('nav', 'toc');
  for (const section of ['UI sample', 'Swatches', 'Contrast pairs', 'Colour vision']) {
    const link = el('a', undefined, section);
    link.href = `#${section.toLowerCase().replace(/\s+/g, '-')}`;
    nav.append(link);
  }
  root.append(nav);

  for (const [title, render] of [
    ['UI sample', uiSample],
    ['Swatches', (l: Loaded) => swatchGrid(l, tokenNames)],
    ['Contrast pairs', pairTable],
    ['Colour vision', visionTable],
  ] as const) {
    const section = el('section');
    section.id = title.toLowerCase().replace(/\s+/g, '-');
    section.append(el('h2', undefined, title));
    const columns = el('div', 'columns');
    for (const theme of loaded) {
      const column = el('div', 'column');
      column.append(el('h3', undefined, theme.info.label), el('p', 'note', theme.info.description));
      column.append(render(theme));
      columns.append(column);
    }
    section.append(columns);
    root.append(section);
  }
}

try {
  main();
} catch (error: unknown) {
  const root = document.getElementById('gallery');
  if (root) root.textContent = `Gallery failed: ${String(error)}`;
  console.error(error);
}

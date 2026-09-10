/**
 * The space audit, drawn (M100).
 *
 * The brief asks for "a pie of bytes by category, words + values". It gets one — with the slices
 * told apart by **hatch pattern rather than by colour**, because the operator is colourblind and
 * this project forbids differentiating by colour alone. Solid, diagonal, cross, dotted,
 * horizontal and vertical fills, in two theme tokens that alternate as a second cue, separated by
 * a `--border-strong` stroke so the boundary between two slices is visible whatever they are
 * filled with.
 *
 * Beside the chart is the table, and the table is the part that actually answers the question: a
 * word, the bytes, the share, and a proportional bar. A reader who cannot see the chart at all
 * loses nothing — which is the test any chart in this app has to pass.
 *
 * Nothing here reads a colour literal; the two fills are `var(--accent)` and `var(--fg-muted)`,
 * both of which every theme guarantees against `--bg-modal`.
 */

import { el } from '@app/dom';
import { AUDIT_LABELS, type SpaceAudit } from '@engine/optimise';

/** The six fills, in the order the slices take them. Pattern first; colour is the second cue. */
const PATTERNS = ['solid', 'diagonal', 'cross', 'dots', 'horizontal', 'vertical'] as const;
type PatternName = (typeof PATTERNS)[number];

const SVG = 'http://www.w3.org/2000/svg';
let seq = 0;

export interface AuditViewOptions {
  /** Slices smaller than this share of the file are gathered into one "Everything else" row. */
  readonly minShare?: number;
}

/** Builds the whole audit: the donut, its legend, and the table. */
export function auditView(audit: SpaceAudit, options: AuditViewOptions = {}): HTMLElement {
  const shown = visibleSlices(audit, options.minShare ?? 0.01);
  const root = el('div.opt-audit');
  if (audit.total === 0 || shown.length === 0) {
    root.append(el('p.field-hint', null, 'There is nothing to measure in this document.'));
    return root;
  }
  root.append(donut(shown), auditTable(shown, audit.total));
  return root;
}

/**
 * The slices worth drawing: everything at or above `minShare`, with the rest added up into one
 * row. A pie with ten one-percent slivers is a pie nobody can read, and a category that rounds to
 * nothing is not the answer to "where did my file go".
 */
export function visibleSlices(
  audit: SpaceAudit,
  minShare: number,
): Array<{ label: string; bytes: number; share: number }> {
  const big = audit.slices.filter((s) => s.share >= minShare && s.bytes > 0);
  const rest = audit.slices.filter((s) => !big.includes(s) && s.bytes > 0);
  const out = big
    .map((s) => ({ label: AUDIT_LABELS[s.category], bytes: s.bytes, share: s.share }))
    .sort((a, b) => b.bytes - a.bytes);
  const restBytes = rest.reduce((n, s) => n + s.bytes, 0);
  if (restBytes > 0) {
    out.push({
      label: 'Everything else',
      bytes: restBytes,
      share: audit.total > 0 ? restBytes / audit.total : 0,
    });
  }
  return out;
}

/** The donut itself, with a legend under it. */
function donut(
  slices: ReadonlyArray<{ label: string; bytes: number; share: number }>,
): HTMLElement {
  const id = `opt-audit-${String(++seq)}`;
  const size = 180;
  const centre = size / 2;
  const outer = 84;
  const inner = 46;

  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', `0 0 ${String(size)} ${String(size)}`);
  svg.setAttribute('class', 'opt-donut');
  svg.setAttribute('role', 'img');
  svg.setAttribute(
    'aria-label',
    `Where this file's bytes are: ${slices
      .map((s) => `${s.label} ${percent(s.share)}`)
      .join(', ')}. The same figures are in the table beside this chart.`,
  );
  svg.append(defs(id));

  let angle = -Math.PI / 2;
  slices.forEach((slice, i) => {
    const sweep = Math.max(slice.share, 0) * Math.PI * 2;
    // A slice of the whole file cannot be drawn as an arc — the start and end points coincide and
    // the path collapses — so it becomes a ring.
    const path =
      sweep >= Math.PI * 2 - 1e-6
        ? ringPath(centre, outer, inner)
        : arcPath(centre, outer, inner, angle, angle + sweep);
    const el_ = document.createElementNS(SVG, 'path');
    el_.setAttribute('d', path);
    el_.setAttribute('fill', `url(#${id}-${patternOf(i)}-${String(i % 2)})`);
    el_.setAttribute('stroke', 'var(--border-strong)');
    el_.setAttribute('stroke-width', '1');
    svg.append(el_);
    angle += sweep;
  });

  const wrapper = el('div.opt-audit-chart');
  wrapper.append(svg, legend(slices, id));
  return wrapper;
}

/** The legend: a swatch drawn with the same pattern, then the word, then the share. */
function legend(
  slices: ReadonlyArray<{ label: string; bytes: number; share: number }>,
  id: string,
): HTMLElement {
  const list = el('ul.opt-legend');
  slices.forEach((slice, i) => {
    const swatch = document.createElementNS(SVG, 'svg');
    swatch.setAttribute('viewBox', '0 0 16 16');
    swatch.setAttribute('class', 'opt-swatch');
    swatch.setAttribute('aria-hidden', 'true');
    swatch.append(defs(`${id}-legend-${String(i)}`));
    const rect = document.createElementNS(SVG, 'rect');
    rect.setAttribute('x', '0.5');
    rect.setAttribute('y', '0.5');
    rect.setAttribute('width', '15');
    rect.setAttribute('height', '15');
    rect.setAttribute('fill', `url(#${id}-legend-${String(i)}-${patternOf(i)}-${String(i % 2)})`);
    rect.setAttribute('stroke', 'var(--border-strong)');
    swatch.append(rect);

    const item = el('li.opt-legend-item');
    item.append(swatch, el('span.opt-legend-label', null, slice.label));
    item.append(el('span.opt-legend-share', null, percent(slice.share)));
    list.append(item);
  });
  return list;
}

/** The table, which is the part that has to work on its own. */
function auditTable(
  slices: ReadonlyArray<{ label: string; bytes: number; share: number }>,
  total: number,
): HTMLElement {
  const table = el('table.opt-audit-table');
  const head = el('thead');
  const headRow = el('tr');
  headRow.append(
    el('th', { scope: 'col' }, 'What'),
    el('th', { scope: 'col' }, 'Size'),
    el('th', { scope: 'col' }, 'Share'),
  );
  head.append(headRow);
  const body = el('tbody');
  for (const slice of slices) {
    const row = el('tr');
    row.append(el('th', { scope: 'row' }, slice.label));
    row.append(el('td.opt-num', null, formatBytes(slice.bytes)));
    const share = el('td.opt-share');
    const bar = el('span.opt-bar');
    // A width in per cent is a length, not a colour, so it is fine as an inline style.
    bar.style.width = `${String(Math.max(1, Math.round(slice.share * 100)))}%`;
    share.append(el('span.opt-share-value', null, percent(slice.share)), bar);
    row.append(share);
    body.append(row);
  }
  const foot = el('tfoot');
  const footRow = el('tr');
  footRow.append(
    el('th', { scope: 'row' }, 'Whole file'),
    el('td.opt-num', null, formatBytes(total)),
    el('td', null, ''),
  );
  foot.append(footRow);
  table.append(head, body, foot);
  return table;
}

// ---- the patterns -------------------------------------------------------------------------------

function patternOf(index: number): PatternName {
  return PATTERNS[index % PATTERNS.length] ?? 'solid';
}

/**
 * One `<defs>` holding all six patterns in both colours.
 *
 * Repeated per chart rather than shared, because two charts on one page — the before and after of
 * an optimise — must not fight over an id.
 */
function defs(id: string): SVGDefsElement {
  const defsEl = document.createElementNS(SVG, 'defs');
  for (const [tone, colour] of [
    ['0', 'var(--accent)'],
    ['1', 'var(--fg-muted)'],
  ] as const) {
    for (const name of PATTERNS) {
      defsEl.append(pattern(`${id}-${name}-${tone}`, name, colour));
    }
  }
  return defsEl;
}

function pattern(id: string, name: PatternName, colour: string): SVGPatternElement {
  const p = document.createElementNS(SVG, 'pattern');
  p.setAttribute('id', id);
  p.setAttribute('patternUnits', 'userSpaceOnUse');
  p.setAttribute('width', '6');
  p.setAttribute('height', '6');

  const background = document.createElementNS(SVG, 'rect');
  background.setAttribute('width', '6');
  background.setAttribute('height', '6');
  background.setAttribute('fill', name === 'solid' ? colour : 'var(--bg-modal)');
  p.append(background);
  if (name === 'solid') return p;

  const stroke = (d: string): SVGPathElement => {
    const path = document.createElementNS(SVG, 'path');
    path.setAttribute('d', d);
    path.setAttribute('stroke', colour);
    path.setAttribute('stroke-width', '2');
    return path;
  };
  switch (name) {
    case 'diagonal':
      p.append(stroke('M-1 1 L1 -1 M0 6 L6 0 M5 7 L7 5'));
      break;
    case 'cross':
      p.append(stroke('M0 6 L6 0'), stroke('M0 0 L6 6'));
      break;
    case 'dots': {
      const dot = document.createElementNS(SVG, 'circle');
      dot.setAttribute('cx', '3');
      dot.setAttribute('cy', '3');
      dot.setAttribute('r', '1.8');
      dot.setAttribute('fill', colour);
      p.append(dot);
      break;
    }
    case 'horizontal':
      p.append(stroke('M0 3 L6 3'));
      break;
    case 'vertical':
      p.append(stroke('M3 0 L3 6'));
      break;
  }
  return p;
}

// ---- the geometry ---------------------------------------------------------------------------------

/** A donut segment from `from` to `to` radians, drawn clockwise. */
export function arcPath(
  centre: number,
  outer: number,
  inner: number,
  from: number,
  to: number,
): string {
  const large = to - from > Math.PI ? 1 : 0;
  const p = (radius: number, angle: number): string =>
    `${(centre + radius * Math.cos(angle)).toFixed(2)} ${(centre + radius * Math.sin(angle)).toFixed(2)}`;
  return [
    `M ${p(outer, from)}`,
    `A ${String(outer)} ${String(outer)} 0 ${String(large)} 1 ${p(outer, to)}`,
    `L ${p(inner, to)}`,
    `A ${String(inner)} ${String(inner)} 0 ${String(large)} 0 ${p(inner, from)}`,
    'Z',
  ].join(' ');
}

/** The whole ring, for a document that is one category from end to end. */
export function ringPath(centre: number, outer: number, inner: number): string {
  const circle = (r: number, sweep: number): string =>
    `M ${String(centre - r)} ${String(centre)} ` +
    `A ${String(r)} ${String(r)} 0 1 ${String(sweep)} ${String(centre + r)} ${String(centre)} ` +
    `A ${String(r)} ${String(r)} 0 1 ${String(sweep)} ${String(centre - r)} ${String(centre)} Z`;
  return `${circle(outer, 1)} ${circle(inner, 0)}`;
}

// ---- words and numbers ------------------------------------------------------------------------------

/** A share as a percentage, with a floor so a real category never reads as nothing. */
export function percent(share: number): string {
  if (!(share > 0)) return '0%';
  if (share < 0.005) return '<1%';
  return `${String(Math.round(share * 100))}%`;
}

/**
 * Bytes as a reader would say them: 1.4 MB, 812 kB, 96 bytes.
 *
 * Decimal multiples, because that is what a file manager shows and what the reader will compare
 * this against. `Intl` for the number so the decimal separator follows the locale.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1000) return `${String(Math.round(bytes))} bytes`;
  const units = ['kB', 'MB', 'GB', 'TB'];
  let value = bytes / 1000;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit++;
  }
  const digits = value < 10 ? 1 : 0;
  return `${new Intl.NumberFormat(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value)} ${units[unit] ?? 'kB'}`;
}

/** "1.4 MB → 620 kB, 56 % smaller" — the one line the reader actually wants. */
export function savingLine(before: number, after: number): string {
  const saved = before - after;
  if (saved <= 0) {
    return `${formatBytes(before)} → ${formatBytes(after)}, no smaller`;
  }
  const share = Math.round((saved / before) * 100);
  return `${formatBytes(before)} → ${formatBytes(after)}, ${String(share)}% smaller`;
}

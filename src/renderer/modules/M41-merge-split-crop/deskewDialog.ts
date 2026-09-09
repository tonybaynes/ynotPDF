/**
 * The Straighten Pages dialog (M41).
 *
 * Three things at once, because straightening is a judgement the reader has to be able to make:
 *
 * 1. **A table** — one row per page, with the angle found, how sure the measurement is *in
 *    words*, and a tick. A page the detector could not measure is in the table too, unticked,
 *    saying why; hiding it would leave the reader wondering where page 7 went.
 * 2. **A before-and-after preview** of whichever row is selected, side by side, so "is that
 *    straight" is a question about a picture rather than about a number.
 * 3. **A fine-tune slider**, ±5° in tenths, with a number box beside it. The detector is very
 *    good on a page of text and no use at all on a photograph, and the reader who can see the
 *    page should always be able to overrule it.
 *
 * The "after" preview is drawn by rotating the "before" picture in CSS, which is exact for this
 * purpose — the page turns about its own centre, which is what the op does — and costs one
 * render per page rather than one per nudge of the slider.
 */

import { field, type DialogHandle, type Dialogs } from '@app/dialog/Dialogs';
import { el } from '@app/dom';
import { CONFIDENCE_WORDS, MIN_ANGLE, type SkewConfidence } from '@engine/ops/deskew';
import { icon } from '@app/icons';
import { checkbox } from './fields';

/** One page's row, as the dialog holds it. */
export interface DeskewRow {
  readonly page: number;
  readonly label: string;
  /** Clockwise degrees the page leans by. The reader may change this. */
  angle: number;
  readonly detected: number;
  readonly confidence: SkewConfidence;
  readonly reason: string;
  chosen: boolean;
}

export interface DeskewChoice {
  /** Clockwise degrees per 0-based page index, for the pages the reader ticked. */
  readonly angles: Readonly<Record<number, number>>;
  readonly trimEdges: boolean;
}

export interface DeskewDialogOptions {
  readonly dialogs: Dialogs;
  readonly rows: ReadonlyArray<DeskewRow>;
  readonly trimEdges: boolean;
  /** Draws one page for the preview; `null` when it cannot be drawn. */
  readonly preview: (page: number) => Promise<string | null>;
}

/** How far the fine-tune slider reaches, and how finely it moves. */
export const TUNE_LIMIT = 5;
export const TUNE_STEP = 0.1;

export async function askDeskew(options: DeskewDialogOptions): Promise<DeskewChoice | null> {
  const rows: DeskewRow[] = options.rows.map((row) => ({ ...row }));
  let selected = rows.findIndex((row) => row.chosen);
  if (selected < 0) selected = 0;
  let handle: DialogHandle | null = null;

  const table = el('table.ops-table');
  const tbody = el('tbody');
  table.append(
    el('caption.sr-only', null, 'Pages and the angle each one leans by'),
    headerRow(),
    tbody,
  );

  const before = el('img.ops-skew-image', { alt: '' });
  const after = el('img.ops-skew-image', { alt: '' });
  const beforePane = paneFor('As it is', before);
  const afterPane = paneFor('Straightened', after);
  const previews = el('div.ops-skew-previews');
  previews.append(beforePane, afterPane);

  const slider = el('input.ops-slider', {
    type: 'range',
    min: String(-TUNE_LIMIT),
    max: String(TUNE_LIMIT),
    step: String(TUNE_STEP),
    'aria-label': 'Fine-tune the angle, degrees',
  });
  const number = el('input.input.ops-number', {
    type: 'number',
    min: String(-TUNE_LIMIT),
    max: String(TUNE_LIMIT),
    step: String(TUNE_STEP),
    'aria-label': 'Angle in degrees',
  });
  const tuneRow = el('div.ops-tune');
  tuneRow.append(slider, number, el('span.ops-unit', { 'aria-hidden': 'true' }, '°'));

  const trimEdges = checkbox({
    label: 'Trim the corners the turn exposes',
    checked: options.trimEdges,
    hint: 'Off keeps the whole page and fills the corners with the paper colour.',
  });

  const summary = el('p.ops-summary', { role: 'status' });

  const setAngle = (value: number): void => {
    const row = rows[selected];
    if (!row) return;
    const clamped = Math.max(-TUNE_LIMIT, Math.min(TUNE_LIMIT, Number(value.toFixed(2))));
    row.angle = clamped;
    if (Math.abs(clamped) >= MIN_ANGLE) row.chosen = true;
    slider.value = String(clamped);
    number.value = clamped.toFixed(1);
    paintPreview();
    paintTable();
  };

  slider.addEventListener('input', () => {
    setAngle(Number(slider.value));
  });
  number.addEventListener('input', () => {
    const typed = Number(number.value);
    if (Number.isFinite(typed)) setAngle(typed);
  });

  function paintPreview(): void {
    const row = rows[selected];
    if (!row) return;
    // Straightening a page that leans by +2.3° turns it by −2.3°.
    after.style.transform = `rotate(${String(-row.angle)}deg)`;
    beforePane.setAttribute('aria-label', `Page ${row.label} as it is`);
    afterPane.setAttribute('aria-label', `Page ${row.label} straightened`);
  }

  function paintTable(): void {
    tbody.replaceChildren();
    rows.forEach((row, index) => {
      const tr = el('tr.ops-row', {
        'aria-current': index === selected ? 'true' : 'false',
      });
      const tick = el('input', { type: 'checkbox', 'aria-label': `Straighten page ${row.label}` });
      tick.checked = row.chosen;
      tick.addEventListener('change', () => {
        row.chosen = tick.checked;
        paintSummary();
      });
      const choose = el('button.ops-row-button', { type: 'button' }, `Page ${row.label}`);
      choose.addEventListener('click', () => {
        selected = index;
        void showPage(index);
      });
      tr.append(
        el('td', null, tick),
        el('td', null, choose),
        el('td.ops-angle', null, `${row.angle >= 0 ? '+' : '−'}${Math.abs(row.angle).toFixed(2)}°`),
        el(
          'td.ops-confidence',
          { title: row.reason },
          icon(
            row.confidence === 'clear'
              ? 'circle-check'
              : row.confidence === 'uncertain'
                ? 'circle-help'
                : 'circle-slash',
          ),
          // Word *and* icon, never colour alone.
          el('span', null, ` ${CONFIDENCE_WORDS[row.confidence]}`),
        ),
      );
      tbody.append(tr);
    });
    paintSummary();
  }

  function paintSummary(): void {
    const ticked = rows.filter((row) => row.chosen && Math.abs(row.angle) >= MIN_ANGLE);
    const skipped = rows.filter((row) => row.confidence === 'none');
    const parts = [
      ticked.length === 0
        ? 'Nothing to straighten.'
        : `Straightens ${String(ticked.length)} ${ticked.length === 1 ? 'page' : 'pages'}.`,
    ];
    if (skipped.length > 0) {
      parts.push(
        `${String(skipped.length)} ${skipped.length === 1 ? 'page has' : 'pages have'} nothing to measure against.`,
      );
    }
    summary.textContent = parts.join(' ');
    handle?.setEnabled('ok', ticked.length > 0);
  }

  async function showPage(index: number): Promise<void> {
    const row = rows[index];
    if (!row) return;
    slider.value = String(row.angle);
    number.value = row.angle.toFixed(1);
    paintTable();
    paintPreview();
    const url = await options.preview(row.page);
    if (url === null) {
      before.removeAttribute('src');
      after.removeAttribute('src');
      return;
    }
    before.src = url;
    after.src = url;
  }

  const selectAll = el('button.btn', { type: 'button' }, 'Tick every page it is sure about');
  selectAll.addEventListener('click', () => {
    for (const row of rows) {
      row.chosen = row.confidence !== 'none' && Math.abs(row.angle) >= MIN_ANGLE;
    }
    paintTable();
  });
  const selectNone = el('button.btn', { type: 'button' }, 'Tick none');
  selectNone.addEventListener('click', () => {
    for (const row of rows) row.chosen = false;
    paintTable();
  });

  const body = el('div.ops-dialog.ops-skew');
  const toolbar = el('div.ops-toolbar');
  toolbar.append(selectAll, selectNone);
  const left = el('div.ops-skew-list');
  left.append(toolbar, el('div.ops-table-scroll', null, table));
  const right = el('div.ops-skew-detail');
  right.append(previews, field({ label: 'Fine-tune', input: tuneRow }), trimEdges.element, summary);
  body.append(left, right);

  handle = options.dialogs.open({
    title: 'Straighten pages',
    id: 'ops-deskew',
    width: 860,
    className: 'ops-wide',
    content: body,
    buttons: [
      { id: 'cancel', label: 'Cancel' },
      { id: 'ok', label: 'Straighten', primary: true },
    ],
  });
  void showPage(selected);

  const result = await handle.result;
  if (result !== 'ok') return null;
  const angles: Record<number, number> = {};
  for (const row of rows) {
    if (row.chosen && Math.abs(row.angle) >= MIN_ANGLE) angles[row.page] = row.angle;
  }
  if (Object.keys(angles).length === 0) return null;
  return { angles, trimEdges: trimEdges.input.checked };
}

function headerRow(): HTMLElement {
  const head = el('thead');
  const row = el('tr');
  row.append(
    el('th', { scope: 'col' }, el('span.sr-only', null, 'Straighten')),
    el('th', { scope: 'col' }, 'Page'),
    el('th', { scope: 'col' }, 'Leans by'),
    el('th', { scope: 'col' }, 'Measurement'),
  );
  head.append(row);
  return head;
}

function paneFor(caption: string, image: HTMLElement): HTMLElement {
  const pane = el('figure.ops-skew-pane', { role: 'img' });
  const frame = el('div.ops-skew-frame');
  frame.append(image);
  pane.append(frame, el('figcaption', null, caption));
  return pane;
}

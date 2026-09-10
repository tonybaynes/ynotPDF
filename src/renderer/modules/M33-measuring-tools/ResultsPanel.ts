/**
 * The Measurements panel (M33): a left-dock list of every measurement in the document, with the
 * value a tool is showing right now at the top, running totals at the bottom, and Copy and
 * Export.
 *
 * A panel rather than a dialog on purpose — it has to stay open while measuring, which is the
 * whole point of a cumulative list.
 *
 * Every row is a button: clicking it selects that measurement and goes to its page. Nothing is
 * distinguished by colour; the kind of each measurement is a word.
 */

import { button, el } from '@app/dom';
import { icon } from '@app/icons';
import type { ModelId } from '@core/Ids';
import type { MeasureService } from './MeasureService';
import type { ResultRow } from './results';

const KIND_ICON: Readonly<Record<string, string>> = {
  Distance: 'ruler',
  Perimeter: 'spline',
  Area: 'square-dashed',
};

/** Mounts the panel into `host`; returns a disposer. */
export function mountResultsPanel(host: HTMLElement, service: MeasureService): () => void {
  const root = el('div.measure-panel');
  const live = el('div.measure-live', { role: 'status', 'aria-live': 'polite' });
  const scale = el('p.measure-scale');
  const list = el('div.measure-list', { role: 'list' });
  const totals = el('div.measure-totals');
  const actions = el('div.measure-actions', { role: 'group', 'aria-label': 'Measurements' });

  const copy = button('btn', { type: 'button' }, icon('copy'), 'Copy');
  const exportCsv = button('btn', { type: 'button' }, icon('download'), 'Export CSV');
  const calibrate = button('btn', { type: 'button' }, icon('ruler'), 'Scale…');
  copy.addEventListener('click', () => {
    void service.shellServices.run('measure.copy');
  });
  exportCsv.addEventListener('click', () => {
    void service.shellServices.run('measure.export');
  });
  calibrate.addEventListener('click', () => {
    void service.shellServices.run('measure.scale');
  });
  actions.append(calibrate, copy, exportCsv);
  root.append(live, scale, actions, list, totals);
  host.append(root);

  const rowButton = (row: ResultRow): HTMLElement => {
    const b = button('measure-row', {
      type: 'button',
      role: 'listitem',
      'aria-label': `${row.kindLabel} on page ${row.pageLabel}: ${row.text}`,
    });
    b.append(
      el(
        'span.measure-row-icon',
        { 'aria-hidden': 'true' },
        icon(KIND_ICON[row.kindLabel] ?? 'ruler'),
      ),
      el(
        'span.measure-row-body',
        null,
        el('span.measure-row-value', null, row.text),
        el('span.measure-row-meta', null, `${row.kindLabel} · page ${row.pageLabel}`),
      ),
    );
    b.addEventListener('click', () => {
      service.reveal(row.id as ModelId);
    });
    return b;
  };

  const render = (): void => {
    const current = service.live;
    live.replaceChildren(
      el('span.measure-live-label', null, current ? 'Measuring' : 'Measurements'),
      el('span.measure-live-value', null, current ? current.text : '—'),
      ...(current ? [el('span.measure-live-detail', null, current.detail)] : []),
    );
    const document = service.annotationService.activeDocument();
    const page = service.annotationService.activeViewer()?.state.page ?? 0;
    scale.textContent = document
      ? `Scale: ${service.ratioText(page)}${service.pageIsCalibrated(page) ? ' (this page)' : ''}`
      : 'No document is open.';

    const rows = service.rows();
    copy.disabled = rows.length === 0;
    exportCsv.disabled = rows.length === 0;
    calibrate.disabled = document === null;
    list.replaceChildren();
    if (rows.length === 0) {
      list.append(
        el(
          'p.measure-empty',
          null,
          document
            ? 'Nothing measured yet. Use Distance, Perimeter or Area on the Comment tab.'
            : 'Open a document to measure it.',
        ),
      );
    } else {
      for (const row of rows) list.append(rowButton(row));
    }
    const sums = service.totals();
    totals.replaceChildren();
    if (sums.length > 0) {
      totals.append(el('p.measure-field-label', null, 'Totals'));
      for (const total of sums) {
        totals.append(
          el(
            'p.measure-total',
            null,
            `${total.kind === 'area' ? 'Area' : 'Length'} (${total.unit}), ${String(total.count)} measured: ${total.text}`,
          ),
        );
      }
    }
  };

  render();
  const disposers = [service.subscribe(render), service.annotationService.subscribe(render)];
  // Every page's annotations, so the list is the document rather than what happens to be open.
  void service.loadAll();

  return () => {
    for (const d of disposers) d();
    root.remove();
  };
}

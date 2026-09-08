/**
 * The Layers panel (M12): the document's optional-content groups, with a checkbox each.
 *
 * Toggling one is a `Command` — Foxit's is undoable too, and it is what a save writes — and it
 * re-renders the affected pages, because the PDFium adapter applies visibility by deactivating
 * the page objects marked with the group (ADR 0011).
 *
 * Visibility as a *view state* is the import/export pair at the top: a small JSON file of name →
 * visible, applied without touching the document unless "Apply as default" is ticked, which runs
 * the same commands in a single undo entry.
 */

import { el } from '@app/dom';
import { icon } from '@app/icons';
import { SetLayerVisibleCommand } from '@core/commands';
import type { ModelId } from '@core/Ids';
import type { ModelLayer } from '@core/model';
import type { ServiceContext } from '@shared/module';
import { emptyMessage, installListKeys, toolButton, toolbar } from '../panelChrome';
import type { NavigationService } from '../NavigationService';

/** A saved visibility set: layer name → visible. Written and read as JSON. */
export type LayerState = Readonly<Record<string, boolean>>;

/** The visibility of every layer, by name — what export writes. */
export function layerStateOf(layers: ReadonlyArray<ModelLayer>): LayerState {
  const out: Record<string, boolean> = {};
  for (const layer of layers) out[layer.name] = layer.visible;
  return out;
}

/** Validates a parsed file into a state; anything that is not `name: boolean` is dropped. */
export function parseLayerState(raw: unknown): LayerState | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const out: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'boolean') out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : null;
}

export function mountLayerPanel(
  host: HTMLElement,
  _ctx: ServiceContext,
  nav: NavigationService,
): () => void {
  const disposers: Array<() => void> = [];
  /** The visibility each layer had when the document opened — what "reset" returns to. */
  let initial: LayerState | null = null;
  let initialFor: string | null = null;

  const bar = toolbar(
    'Layers',
    toolButton({
      label: 'Reset layers to their initial visibility',
      icon: 'rotate-ccw',
      id: 'layers-reset',
      onPress: () => void nav.run('layers.reset'),
    }),
    toolButton({
      label: 'Export layer visibility to a file',
      icon: 'download',
      id: 'layers-export',
      onPress: () => void nav.run('layers.export'),
    }),
    toolButton({
      label: 'Import layer visibility from a file',
      icon: 'upload',
      id: 'layers-import',
      onPress: () => void nav.run('layers.import'),
    }),
  );
  const scroller = el('div.nav-scroll', { 'data-panel-scroll': 'layers' });
  const list = el('div.nav-list', { role: 'list', 'aria-label': 'Layers' });
  scroller.append(list);
  const empty = emptyMessage('This document has no layers.', 'layers');
  host.append(bar, scroller, empty);

  const layers = (): ReadonlyArray<ModelLayer> => nav.context?.document.state.layers ?? [];

  const render = (): void => {
    const context = nav.context;
    const all = layers();
    if (context && initialFor !== context.tab.id) {
      initialFor = context.tab.id;
      initial = layerStateOf(all);
      nav.initialLayerState.set(context.tab.id, initial);
    }
    empty.hidden = all.length > 0;
    scroller.hidden = all.length === 0;
    bar.hidden = all.length === 0;
    list.replaceChildren();

    for (const layer of all) {
      const row = el('div.nav-row.layer-row', {
        role: 'listitem',
        'data-row': '',
        'data-id': layer.id,
        tabindex: '-1',
      });
      row.style.paddingLeft = `${String(6 + layer.depth * 14)}px`;
      const box = el('input', {
        type: 'checkbox',
        id: `layer-${layer.id}`,
        ...(layer.locked ? { disabled: true } : {}),
      });
      box.checked = layer.visible;
      box.addEventListener('change', () => {
        void toggle(layer.id, box.checked);
      });
      const label = el('label.nav-title', { for: `layer-${layer.id}` }, layer.name);
      // The state is a word, never the tick alone: "Visible" / "Hidden" (CLAUDE.md).
      const state = el('span.nav-state', null, layer.visible ? 'Visible' : 'Hidden');
      row.append(box, label, state);
      if (layer.locked) {
        row.append(
          el(
            'span.nav-badge',
            { title: 'This layer is locked by the document' },
            icon('lock'),
            'Locked',
          ),
        );
      }
      row.title = `${layer.name} — ${layer.visible ? 'visible' : 'hidden'}${layer.locked ? ', locked' : ''}`;
      list.append(row);
    }
    const rows = [...list.querySelectorAll<HTMLElement>('[data-row]')];
    for (const [i, row] of rows.entries()) row.tabIndex = i === 0 ? 0 : -1;
  };

  const toggle = async (layerId: ModelId, visible: boolean): Promise<void> => {
    const context = nav.context;
    if (!context) return;
    await context.document.apply(new SetLayerVisibleCommand(context.document, layerId, visible));
    nav.invalidateRender(context.tab.id);
  };

  disposers.push(
    installListKeys(list, {
      rows: () => [...list.querySelectorAll<HTMLElement>('[data-row]')],
      activate: (row) => {
        const box = row.querySelector('input');
        if (box instanceof HTMLInputElement && !box.disabled) {
          box.checked = !box.checked;
          void toggle(row.dataset['id'] as ModelId, box.checked);
        }
      },
    }),
    nav.watch(() => {
      render();
    }),
  );

  render();
  return () => {
    for (const d of disposers.splice(0)) d();
    host.replaceChildren();
  };
}

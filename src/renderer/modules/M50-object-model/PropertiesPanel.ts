/**
 * The Object properties panel (M50): position, size and rotation of the selection with live
 * apply; stroke, fill, line width and dash for a path; what an image and a text block are.
 *
 * Every field is a plain input with a label, keyboard-reachable, and commits on change (Enter
 * or blur) — a number field that applied on every keystroke would move an object as the reader
 * typed "1" on the way to "120". Opacity is reported, never offered: CLAUDE.md forbids
 * translucency and the brief marks it ✗.
 */

import { el } from '@app/dom';
import { decompose } from '@engine/content/matrix';
import type { PageObject } from '@engine/PdfEngine';
import type { ObjectService } from './ObjectService';

function hex(color: number): string {
  return `#${(color & 0xffffff).toString(16).padStart(6, '0')}`;
}

function parseHex(value: string): number | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(value.trim());
  return m?.[1] ? Number.parseInt(m[1], 16) : null;
}

function fmt(n: number): string {
  return (Math.round(n * 100) / 100).toString();
}

const DASH_PRESETS: ReadonlyArray<{ value: string; label: string; dash: number[] }> = [
  { value: 'solid', label: 'Solid', dash: [] },
  { value: 'dashed', label: 'Dashed', dash: [6, 3] },
  { value: 'dotted', label: 'Dotted', dash: [1, 2] },
  { value: 'dash-dot', label: 'Dash dot', dash: [6, 3, 1, 3] },
];

export function mountObjectPanel(host: HTMLElement, service: ObjectService): () => void {
  const root = el('div.obj-props');
  host.replaceChildren(root);

  const render = (): void => {
    const info = service.selected();
    root.replaceChildren();
    if (!info?.bounds) {
      root.append(el('p.obj-props-empty', null, 'Select an object with the Edit Object tool.'));
      return;
    }
    root.append(el('div.obj-props-what', null, service.describe()));

    // ---- geometry -------------------------------------------------------------------------
    const b = info.bounds;
    const geometry = el('section.obj-props-section');
    geometry.append(el('h4', null, 'Position and size'));
    const grid = el('div.obj-props-grid');
    const number = (id: string, label: string, value: number, apply: (n: number) => void): void => {
      const input = el('input', { id, type: 'number', step: '0.5', value: fmt(value) });
      input.addEventListener('change', () => {
        const n = Number.parseFloat(input.value);
        if (Number.isFinite(n)) apply(n);
      });
      grid.append(el('label', { for: id }, label), input);
    };
    number('obj-x', 'X', b.x0, (n) => void service.setBounds({ x: n }));
    number('obj-y', 'Y', b.y0, (n) => void service.setBounds({ y: n }));
    number('obj-w', 'W', b.x1 - b.x0, (n) => void service.setBounds({ width: n }));
    number('obj-h', 'H', b.y1 - b.y0, (n) => void service.setBounds({ height: n }));
    geometry.append(grid);

    const single = info.units.length === 1 ? info.objects[0] : undefined;
    const angle = single ? decompose(single.matrix).rotate : 0;
    const rotateGrid = el('div.obj-props-grid');
    const rotate = el('input', { id: 'obj-rotate', type: 'number', step: '1', value: fmt(angle) });
    rotate.addEventListener('change', () => {
      const n = Number.parseFloat(rotate.value);
      if (Number.isFinite(n)) void service.rotateBy(n - angle);
    });
    rotateGrid.append(el('label', { for: 'obj-rotate' }, 'Rotation °'), rotate);
    geometry.append(rotateGrid);

    const row = el('div.obj-props-row');
    const button = (label: string, action: () => void): HTMLButtonElement => {
      const btn = el('button', { type: 'button' }, label);
      btn.addEventListener('click', action);
      return btn;
    };
    row.append(
      button('Rotate ↺ 90°', () => void service.rotateBy(90)),
      button('Rotate ↻ 90°', () => void service.rotateBy(-90)),
      button('Flip ↔', () => void service.flip('horizontal')),
      button('Flip ↕', () => void service.flip('vertical')),
    );
    geometry.append(row);
    root.append(geometry);

    // ---- kind specifics -----------------------------------------------------------------------
    const paths = info.units.filter((u) => u.kind === 'path');
    if (paths.length > 0) {
      const first = info.objects.find((o) => o.kind === 'path');
      root.append(styleSection(service, first));
    }
    const image =
      info.units.length === 1 && info.units[0]?.kind === 'image' ? info.objects[0] : undefined;
    if (image) {
      const section = el('section.obj-props-section');
      section.append(el('h4', null, 'Image'));
      const dl = el('dl');
      dl.append(
        el('dt', null, 'Pixels'),
        el('dd', null, `${image.imageWidth ?? '?'} × ${image.imageHeight ?? '?'}`),
        el('dt', null, 'On page'),
        el('dd', null, `${fmt(b.x1 - b.x0)} × ${fmt(b.y1 - b.y0)} pt`),
      );
      if (image.imageWidth && image.imageHeight) {
        const dpi = (image.imageWidth / Math.max(b.x1 - b.x0, 1e-6)) * 72;
        dl.append(el('dt', null, 'Resolution'), el('dd', null, `${Math.round(dpi)} dpi`));
      }
      section.append(dl);
      root.append(section);
    }
    const textUnit =
      info.units.length === 1 && info.units[0]?.kind === 'text' ? info.units[0] : undefined;
    if (textUnit) {
      const block = service.blockFor(info.page, textUnit.id);
      const first = info.objects.find((o) => o.kind === 'text');
      const section = el('section.obj-props-section');
      section.append(el('h4', null, 'Text'));
      const dl = el('dl');
      dl.append(
        el('dt', null, 'Font'),
        el('dd', null, first?.fontName ?? 'Unknown'),
        el('dt', null, 'Size'),
        el('dd', null, first?.fontSize !== undefined ? `${fmt(first.fontSize)} pt` : 'Unknown'),
        el('dt', null, 'Runs'),
        el('dd', null, String(textUnit.indexes.length)),
      );
      if (block?.text) dl.append(el('dt', null, 'Text'), el('dd', null, block.text.slice(0, 200)));
      section.append(dl);
      section.append(
        el(
          'p.obj-props-note',
          null,
          'Editing the words themselves arrives with text editing (M51).',
        ),
      );
      root.append(section);
    }
    const alpha = info.objects.find((o) => (o.fillAlpha ?? 1) < 1 || (o.strokeAlpha ?? 1) < 1);
    if (alpha) {
      root.append(
        el(
          'p.obj-props-note',
          null,
          `Opacity in the file: ${Math.round((alpha.fillAlpha ?? alpha.strokeAlpha ?? 1) * 100)} % (not editable).`,
        ),
      );
    }
  };

  const unsubscribe = service.onChange(render);
  render();
  return () => {
    unsubscribe();
    root.remove();
  };
}

function styleSection(service: ObjectService, path: PageObject | undefined): HTMLElement {
  const section = el('section.obj-props-section');
  section.append(el('h4', null, 'Stroke and fill'));
  const colour = (
    id: string,
    label: string,
    value: number | undefined,
    apply: (c: number) => void,
  ): HTMLElement => {
    const wrap = el('div.obj-props-colour');
    const input = el('input', { id, type: 'color', value: hex(value ?? 0) });
    const text = el('input', {
      type: 'text',
      'aria-label': `${label} as hex`,
      value: hex(value ?? 0),
      size: 8,
    });
    input.addEventListener('change', () => {
      const c = parseHex(input.value);
      if (c !== null) {
        text.value = hex(c);
        apply(c);
      }
    });
    text.addEventListener('change', () => {
      const c = parseHex(text.value);
      if (c !== null) {
        input.value = hex(c);
        apply(c);
      }
    });
    wrap.append(el('label', { for: id }, label), input, text);
    return wrap;
  };
  section.append(
    colour(
      'obj-stroke',
      'Stroke',
      path?.strokeColor,
      (c) => void service.setStyle({ strokeColor: c }),
    ),
    colour('obj-fill', 'Fill', path?.fillColor, (c) => void service.setStyle({ fillColor: c })),
  );
  const grid = el('div.obj-props-grid');
  const width = el('input', {
    id: 'obj-width',
    type: 'number',
    min: 0,
    step: '0.25',
    value: fmt(path?.strokeWidth ?? 1),
  });
  width.addEventListener('change', () => {
    const n = Number.parseFloat(width.value);
    if (Number.isFinite(n) && n >= 0) void service.setStyle({ strokeWidth: n });
  });
  const current = service.currentDash();
  const dash = el('select', { id: 'obj-dash' });
  for (const p of DASH_PRESETS) {
    const option = el('option', { value: p.value }, p.label);
    if (p.dash.join(',') === current.join(',')) option.selected = true;
    dash.append(option);
  }
  dash.addEventListener('change', () => {
    const preset = DASH_PRESETS.find((p) => p.value === dash.value);
    if (preset) void service.setStyle({ dash: preset.dash });
  });
  grid.append(
    el('label', { for: 'obj-width' }, 'Width'),
    width,
    el('label', { for: 'obj-dash' }, 'Dash'),
    dash,
  );
  section.append(grid);
  return section;
}

/**
 * The properties sections M31's families add to M30's panel (ADR 0015): stroke and fill, the
 * dash, a cloudy border and its intensity, a line's two endings, the pencil's width, a stamp's
 * picture and rotation, an attachment's icon and its open/save buttons — and "Set as default".
 *
 * The same rules as M30's panel, because it *is* M30's panel: every colour swatch carries its
 * name as text; every control has a real `<label>`; nothing is disabled without saying why in
 * words; and every change writes straight through, so the page updates as the control moves.
 */

import { button, el } from '@app/dom';
import { field } from '@app/dialog/Dialogs';
import type { ModelAnnotation } from '@core/model';
import {
  ATTACHMENT_ICONS,
  ATTACHMENT_ICON_LABELS,
  LINE_ENDINGS,
  LINE_ENDING_LABELS,
  cloudIntensityOf,
  dashOf,
  isLineEnding,
  lineEndingsOf,
  shapeRectFor,
  stampRotationOf,
  type LineEnding,
} from '@engine/appearance';
import {
  FILL_PRESETS,
  HIGHLIGHT_PRESETS,
  INK_PRESETS,
  colourName,
  hexOf,
  parseHexColour,
  type ColourPreset,
} from '@modules/M30-markup-annotations/presets';
import { isImageStamp, stampEntryLabel, type DrawingService } from './DrawingService';
import { quadOfRect } from './geometry';
import { AREA_HIGHLIGHT_INTENT } from './overlay';
import type { DrawingDefaults, DrawingToolId } from './settings';
import { stampPreview } from './StampPanel';

/** The tool a selected annotation's defaults belong to. */
export function toolOfDrawing(a: ModelAnnotation): DrawingToolId {
  switch (a.subtype) {
    case 'Square':
      return cloudIntensityOf(a.extra) > 0 ? 'cloud' : 'rectangle';
    case 'Circle':
      return 'ellipse';
    case 'Line':
      return lineEndingsOf(a.extra).some((e) => e !== 'None') || a.extra['intent'] === 'LineArrow'
        ? 'arrow'
        : 'line';
    case 'Polygon':
      return cloudIntensityOf(a.extra) > 0 ? 'cloud' : 'polygon';
    case 'PolyLine':
      return 'polyline';
    case 'Highlight':
      return 'areaHighlight';
    case 'Ink':
      return 'pencil';
    case 'Stamp':
      return 'stamp';
    default:
      return 'attachFile';
  }
}

/** The heading's wording. */
export function describeDrawing(service: DrawingService, a: ModelAnnotation): string {
  switch (a.subtype) {
    case 'Square':
      return cloudIntensityOf(a.extra) > 0 ? 'Cloudy rectangle' : 'Rectangle';
    case 'Circle':
      return cloudIntensityOf(a.extra) > 0 ? 'Cloudy oval' : 'Oval';
    case 'Line':
      return toolOfDrawing(a) === 'arrow' ? 'Arrow' : 'Line';
    case 'Polygon':
      return cloudIntensityOf(a.extra) > 0 ? 'Cloud' : 'Polygon';
    case 'PolyLine':
      return 'Polyline';
    case 'Highlight':
      return a.extra['intent'] === AREA_HIGHLIGHT_INTENT ? 'Area highlight' : 'Highlight';
    case 'Ink':
      return 'Pencil';
    case 'Stamp': {
      const entry =
        typeof a.extra['icon'] === 'string' ? service.stampEntry(a.extra['icon']) : null;
      return entry ? `${stampEntryLabel(entry)} stamp` : 'Stamp';
    }
    case 'FileAttachment':
      return 'File attachment';
    default:
      return a.subtype;
  }
}

/** The sections, in order, for one annotation. */
export function mountDrawingSections(
  service: DrawingService,
  a: ModelAnnotation,
  refresh: () => void,
): HTMLElement[] {
  const annotations = service.annotationService;
  const out: HTMLElement[] = [];
  const patch = (p: Parameters<typeof annotations.patchSelection>[0], label?: string): void => {
    void annotations.patchSelection(p, label);
  };
  const extra = (values: Record<string, unknown>, label?: string): void => {
    patch({ extra: { ...a.extra, ...values } }, label);
  };

  switch (a.family) {
    case 'shape':
      out.push(
        colourField({
          label: 'Line colour',
          presets: INK_PRESETS,
          value: a.color,
          onPick: (v) => {
            patch({ color: v }, 'Change colour');
          },
        }),
      );
      if (a.subtype !== 'PolyLine' || lineEndingsOf(a.extra).some((e) => e !== 'None')) {
        out.push(
          colourField({
            label: a.subtype === 'Line' || a.subtype === 'PolyLine' ? 'Arrow-head fill' : 'Fill',
            presets: FILL_PRESETS,
            value: a.interiorColor,
            allowNone: true,
            onPick: (v) => {
              patch({ interiorColor: v }, 'Change fill');
            },
          }),
        );
      }
      out.push(strokeFields(a, patch, extra));
      if (a.subtype === 'Square' || a.subtype === 'Circle' || a.subtype === 'Polygon') {
        out.push(cloudField(a, extra));
      }
      if (a.subtype === 'Line' || a.subtype === 'PolyLine') out.push(endingsField(a, patch));
      break;
    case 'markup':
      out.push(
        colourField({
          label: 'Highlight colour',
          presets: HIGHLIGHT_PRESETS,
          value: a.color,
          onPick: (v) => {
            patch({ color: v }, 'Change colour');
          },
        }),
      );
      break;
    case 'ink':
      out.push(
        colourField({
          label: 'Pencil colour',
          presets: INK_PRESETS,
          value: a.color,
          onPick: (v) => {
            patch({ color: v }, 'Change colour');
          },
        }),
      );
      out.push(strokeFields(a, patch, extra));
      break;
    case 'stamp':
      out.push(stampFields(service, a));
      break;
    case 'fileAttachment':
      out.push(attachmentFields(service, a, patch, extra));
      break;
    default:
      break;
  }
  out.push(defaultsRow(service, a, refresh));
  return out;
}

// ---- fields ---------------------------------------------------------------------------------------

interface ColourFieldOptions {
  readonly label: string;
  readonly presets: ReadonlyArray<ColourPreset>;
  readonly value: number | null;
  readonly allowNone?: boolean;
  onPick(value: number | null): void;
}

/** Named swatches plus a custom value — the same control M30's panel uses, for the same reasons. */
function colourField(options: ColourFieldOptions): HTMLElement {
  const wrapper = el('div.annot-field');
  const legend = el('p.annot-field-label', null, options.label);
  const grid = el('div.annot-swatches', { role: 'group', 'aria-label': options.label });
  for (const preset of options.presets) {
    if (preset.value === null && !options.allowNone) continue;
    const chosen = preset.value === options.value;
    const chip = el('span.annot-swatch-chip', { 'aria-hidden': 'true' });
    if (preset.value === null) chip.classList.add('annot-swatch-chip-none');
    // ynot-allow-color: an annotation's colour is document content, not chrome.
    else chip.style.backgroundColor = hexOf(preset.value);
    const b = button(
      'annot-swatch',
      { 'aria-pressed': chosen ? 'true' : 'false', title: preset.name },
      chip,
      el('span.annot-swatch-name', null, preset.name),
    );
    b.addEventListener('click', () => {
      options.onPick(preset.value);
    });
    grid.append(b);
  }
  const custom = el('input.annot-colour-input', {
    type: 'text',
    value: options.value === null ? '' : hexOf(options.value),
    placeholder: 'RRGGBB',
    'aria-label': `${options.label}: a colour of your own, as six hexadecimal digits`,
  });
  custom.addEventListener('change', () => {
    const parsed = parseHexColour(custom.value);
    if (parsed !== null) options.onPick(parsed);
  });
  wrapper.append(legend, grid, field({ label: 'Custom', input: custom }));
  return wrapper;
}

type Patch = (
  p: Parameters<DrawingService['annotationService']['patchSelection']>[0],
  label?: string,
) => void;
type ExtraPatch = (values: Record<string, unknown>, label?: string) => void;

/** Width and dash. A polygon's rect follows its width, since heads and strokes grow with it. */
function strokeFields(a: ModelAnnotation, patch: Patch, extra: ExtraPatch): HTMLElement {
  const width = el('input', {
    type: 'number',
    min: '0',
    max: '36',
    step: '0.5',
    value: String(a.borderWidth ?? 1),
    'aria-label': 'Line width in points',
  });
  width.addEventListener('change', () => {
    const value = Number.parseFloat(width.value);
    if (!Number.isFinite(value)) return;
    const next = Math.max(0, value);
    if (
      a.family === 'shape' &&
      (a.subtype === 'Line' || a.subtype === 'Polygon' || a.subtype === 'PolyLine')
    ) {
      patch(
        { borderWidth: next, rect: shapeRectFor(a.subtype, a.vertices, next, a.extra) },
        'Change width',
      );
    } else {
      patch({ borderWidth: next }, 'Change width');
    }
  });
  const dash = el('select', { 'aria-label': 'Dash pattern' });
  const current = dashOf(a.extra).join(',');
  for (const [value, label] of [
    ['', 'Solid'],
    ['3,3', 'Dashed'],
    ['6,3', 'Long dashes'],
    ['1,2', 'Dotted'],
    ['6,3,1,3', 'Dash and dot'],
  ] as const) {
    const option = el('option', { value }, label);
    if (value === current) option.setAttribute('selected', '');
    dash.append(option);
  }
  dash.addEventListener('change', () => {
    const numbers = dash.value === '' ? [] : dash.value.split(',').map(Number);
    extra({ dashArray: numbers }, 'Change dash');
  });
  const wrapper = el('div.annot-field');
  wrapper.append(
    field({ label: 'Line width (points)', input: width }),
    field({ label: 'Line style', input: dash }),
  );
  return wrapper;
}

/** Cloudy border: off, or an intensity from a slider. */
function cloudField(a: ModelAnnotation, extra: ExtraPatch): HTMLElement {
  const intensity = cloudIntensityOf(a.extra);
  const on = el('input', { type: 'checkbox' });
  if (intensity > 0) on.setAttribute('checked', '');
  const range = el('input', {
    type: 'range',
    min: '0.5',
    max: '2',
    step: '0.25',
    value: String(intensity > 0 ? intensity : 1),
    'aria-label': 'Cloud size',
  });
  range.disabled = intensity <= 0;
  const output = el('output', null, intensity > 0 ? String(intensity) : '—');
  on.addEventListener('change', () => {
    extra(
      { cloudy: on.checked ? Number.parseFloat(range.value) : 0 },
      on.checked ? 'Cloudy border' : 'Plain border',
    );
  });
  range.addEventListener('input', () => {
    output.textContent = range.value;
  });
  range.addEventListener('change', () => {
    extra({ cloudy: Number.parseFloat(range.value) }, 'Change cloud size');
  });
  const row = el('div.draw-range', null, range, output);
  const wrapper = el('div.annot-field');
  const check = el('div.annot-check');
  check.append(field({ label: 'Cloudy border', input: on }));
  wrapper.append(check, field({ label: 'Cloud size (small to large)', input: row }));
  return wrapper;
}

/** The two endings of a line or a polyline, each named in words. */
function endingsField(a: ModelAnnotation, patch: Patch): HTMLElement {
  const [start, end] = lineEndingsOf(a.extra);
  const select = (label: string, current: LineEnding, which: 0 | 1): HTMLElement => {
    const s = el('select', { 'aria-label': label });
    for (const ending of LINE_ENDINGS) {
      const option = el('option', { value: ending }, LINE_ENDING_LABELS[ending]);
      if (ending === current) option.setAttribute('selected', '');
      s.append(option);
    }
    s.addEventListener('change', () => {
      const next: [LineEnding, LineEnding] = [start, end];
      next[which] = isLineEnding(s.value) ? s.value : 'None';
      if (a.family !== 'shape') return;
      const extra = { ...a.extra, lineEndings: next };
      patch(
        {
          extra,
          rect:
            a.subtype === 'Line' || a.subtype === 'PolyLine'
              ? shapeRectFor(a.subtype, a.vertices, a.borderWidth ?? 1, extra)
              : a.rect,
        },
        'Change line ending',
      );
    });
    return field({ label, input: s });
  };
  const wrapper = el('div.annot-field');
  const grid = el('div.draw-endings');
  grid.append(select('Start', start, 0), select('End', end, 1));
  wrapper.append(el('p.annot-field-label', null, 'Line endings'), grid);
  return wrapper;
}

/** A stamp: its picture, and the turn, when the picture is known. */
function stampFields(service: DrawingService, a: ModelAnnotation): HTMLElement {
  const wrapper = el('div.annot-field');
  const entry = typeof a.extra['icon'] === 'string' ? service.stampEntry(a.extra['icon']) : null;
  const picture = service.stampPicture(a);
  const thumb = el('div.draw-stamp-thumb');
  if (picture?.kind === 'drawing') thumb.append(stampPreview(picture.drawing));
  else if (picture?.kind === 'image') thumb.append(el('img', { src: picture.href, alt: '' }));
  else thumb.append(el('span.annot-props-empty', null, 'Picture kept in the file'));
  wrapper.append(el('p.annot-field-label', null, entry ? stampEntryLabel(entry) : 'Stamp'), thumb);

  const rotation = el('input', {
    type: 'number',
    min: '-359',
    max: '359',
    step: '1',
    value: String(stampRotationOf(a.extra)),
    'aria-label': 'Rotation in degrees, anticlockwise',
  });
  const canTurn = service.canRotate(a);
  rotation.disabled = !canTurn;
  rotation.addEventListener('change', () => {
    const value = Number.parseFloat(rotation.value);
    if (Number.isFinite(value)) void service.setStampRotation(a.id, value);
  });
  const quick = el('div.annot-buttons', { role: 'group', 'aria-label': 'Turn the stamp' });
  for (const [label, delta] of [
    ['Turn left 15°', 15],
    ['Turn right 15°', -15],
    ['Straighten', 0],
  ] as const) {
    const b = button('btn', { type: 'button' }, label);
    b.disabled = !canTurn;
    b.addEventListener('click', () => {
      const current = stampRotationOf(a.extra);
      void service.setStampRotation(a.id, delta === 0 ? 0 : current + delta);
    });
    quick.append(b);
  }
  wrapper.append(field({ label: 'Rotation (degrees)', input: rotation }), quick);
  if (!canTurn) {
    wrapper.append(
      el(
        'p.annot-field-note',
        null,
        isImageStamp(a) || picture === null
          ? 'This stamp’s picture came from the file, so it can be moved and resized but not turned.'
          : 'This stamp cannot be turned.',
      ),
    );
  }
  return wrapper;
}

/** An attachment: its icon, and the two things M12 can do with the file. */
function attachmentFields(
  service: DrawingService,
  a: ModelAnnotation,
  patch: Patch,
  extra: ExtraPatch,
): HTMLElement {
  const wrapper = el('div.annot-field');
  const icon = el('select', { 'aria-label': 'Attachment icon' });
  const current = typeof a.extra['icon'] === 'string' ? a.extra['icon'] : 'PushPin';
  for (const name of ATTACHMENT_ICONS) {
    const option = el('option', { value: name }, ATTACHMENT_ICON_LABELS[name]);
    if (name === current) option.setAttribute('selected', '');
    icon.append(option);
  }
  icon.addEventListener('change', () => {
    // A new icon is a new picture, so the appearance the file had no longer applies.
    extra({ icon: icon.value, hasAP: false }, 'Change icon');
  });
  wrapper.append(
    colourField({
      label: 'Icon colour',
      presets: INK_PRESETS,
      value: a.color,
      onPick: (v) => {
        patch({ color: v, extra: { ...a.extra, hasAP: false } }, 'Change colour');
      },
    }),
    field({ label: 'Icon', input: icon }),
  );
  const attachmentId = service.attachmentOf(a);
  const document = service.annotationService.activeDocument();
  const record = attachmentId && document ? document.attachment(attachmentId) : null;
  wrapper.append(
    el(
      'p.annot-field-note',
      null,
      record
        ? `Attached file: ${record.name}`
        : 'The attached file is listed in the Attachments panel.',
    ),
  );
  const actions = el('div.annot-buttons', { role: 'group', 'aria-label': 'Attached file' });
  const open = button('btn', { type: 'button' }, 'Open file');
  const save = button('btn', { type: 'button' }, 'Save file as…');
  open.disabled = attachmentId === null;
  save.disabled = attachmentId === null;
  open.addEventListener('click', () => {
    if (attachmentId)
      void service.shellServices.run('attachments.open', { attachment: attachmentId });
  });
  save.addEventListener('click', () => {
    if (attachmentId)
      void service.shellServices.run('attachments.saveAs', { attachment: attachmentId });
  });
  actions.append(open, save);
  wrapper.append(actions);
  return wrapper;
}

/** "Set as default for this tool": the values of the selected annotation become the tool's. */
function defaultsRow(
  service: DrawingService,
  a: ModelAnnotation,
  refresh: () => void,
): HTMLElement {
  const tool = toolOfDrawing(a);
  const b = button('btn', { type: 'button' }, 'Set as default for this tool');
  b.addEventListener('click', () => {
    const patch: Partial<DrawingDefaults> = {
      ...(a.color === null ? {} : { color: a.color }),
      fillColor: a.interiorColor,
      borderWidth: a.borderWidth ?? service.defaults(tool).borderWidth,
      dashArray: dashOf(a.extra),
      ...(cloudIntensityOf(a.extra) > 0 ? { cloudy: cloudIntensityOf(a.extra) } : {}),
      ...(a.subtype === 'Line' || a.subtype === 'PolyLine'
        ? { lineEndings: lineEndingsOf(a.extra) }
        : {}),
      ...(a.family === 'stamp' && typeof a.extra['icon'] === 'string'
        ? { stampId: a.extra['icon'] }
        : {}),
      ...(a.family === 'fileAttachment' && typeof a.extra['icon'] === 'string'
        ? { icon: a.extra['icon'] }
        : {}),
    };
    void service
      .setDefaults(tool, patch)
      .then(refresh)
      .catch(() => undefined);
  });
  const wrapper = el('div.annot-field.annot-actions');
  wrapper.append(b);
  return wrapper;
}

/** The area-highlight quad, kept in step with its rect — exported for the provider. */
export { quadOfRect, colourName };

/**
 * Appearance streams for form-field widgets (M60, ADR 0019).
 *
 * `/NeedAppearances` is off in everything we write, so every widget must carry a stream that
 * says exactly what it looks like — that is what makes a form we designed look the same in
 * Acrobat, in Chrome and here. This module is the single answer to "what does that field look
 * like": the writer turns its output into `/AP`, and the DOM widget layer lays its controls out
 * from the same geometry helpers, so the screen and the file cannot drift apart.
 *
 * Everything is drawn in **widget-local space**: the origin is the bottom-left of the widget's
 * `/Rect` and the BBox is `[0 0 w h]`, which is the shape every viewer expects of a widget's
 * appearance and the one that survives the widget being moved.
 *
 * Behaviour follows ISO 32000-1 §12.7 for what the dictionaries mean, and Acrobat's long-settled
 * drawing conventions for the parts the spec leaves open (the bevel, the comb separators, the
 * combo arrow, the 1-point text inset) — learned from the specification and from how existing
 * files are built, never from another product's code.
 */

import { ContentBuilder } from '../appearance/content';
import { glyphWidth, textWidth, wrapText } from '../appearance/metrics';
import type { AppearanceStream, StandardFontName } from '../appearance/types';
import { metricFont } from '../appearance/types';
import type { PdfRect } from '@shared/pdf';
import { barcodeSymbol, fitBarcode, BarcodeError } from './barcode';
import { parseDefaultAppearance, type DefaultAppearance } from './da';
import {
  CHECK_STYLE_GLYPH,
  isComb,
  isMultiline,
  isMultiSelect,
  isPassword,
  type FieldDesign,
  type FieldOption,
  type WidgetAppearance,
} from './model';

/** What the generator is told about one widget. */
export interface WidgetAppearanceInput {
  /** The widget's `/Rect` in page space; only its size is used. */
  readonly rect: PdfRect;
  readonly design: FieldDesign;
  readonly widget: WidgetAppearance;
  /** The field's `/V` as text. A list box's multi-selection is newline-separated. */
  readonly value: string;
  /**
   * Which state of a check box or radio to draw. `"on"` is the ticked appearance stored under the
   * widget's export value; `"off"` is `/Off`.
   */
  readonly state?: 'on' | 'off';
  /** Draws the box but not the value — how a designer sees an unfilled field. */
  readonly ignoreValue?: boolean;
}

/** The inset from the border to the text, in points. Acrobat's is 1; so is ours. */
export const TEXT_PADDING = 1;

/** The smallest font size auto-sizing will pick. Below this a value is unreadable anyway. */
const MIN_AUTO_SIZE = 4;
const MAX_AUTO_SIZE = 24;

function size(rect: PdfRect): { width: number; height: number } {
  return { width: Math.abs(rect.x1 - rect.x0), height: Math.abs(rect.y1 - rect.y0) };
}

/** Lightens or darkens a colour towards white or black — the bevel's two edges. */
function shade(color: number, factor: number): number {
  const mix = (v: number): number =>
    Math.max(0, Math.min(255, Math.round(factor >= 0 ? v + (255 - v) * factor : v * (1 + factor))));
  return (mix((color >> 16) & 0xff) << 16) | (mix((color >> 8) & 0xff) << 8) | mix(color & 0xff);
}

/** The border width actually drawn: 0 when there is no border colour to draw it in. */
export function effectiveBorderWidth(widget: WidgetAppearance): number {
  if (widget.borderColor === null) return 0;
  const w = Math.max(0, widget.borderWidth);
  return widget.borderStyle === 'beveled' || widget.borderStyle === 'inset' ? Math.max(w, 1) : w;
}

/** The rectangle a field's contents may use: the box less its border and the text padding. */
export function contentBox(
  rect: PdfRect,
  widget: WidgetAppearance,
  padding = TEXT_PADDING,
): PdfRect {
  const { width, height } = size(rect);
  const inset =
    effectiveBorderWidth(widget) *
      (widget.borderStyle === 'beveled' || widget.borderStyle === 'inset' ? 2 : 1) +
    padding;
  return {
    x0: Math.min(inset, width / 2),
    y0: Math.min(inset, height / 2),
    x1: Math.max(width - inset, width / 2),
    y1: Math.max(height - inset, height / 2),
  };
}

// ---- the box: background and border -------------------------------------------------------------

function drawBox(b: ContentBuilder, rect: PdfRect, widget: WidgetAppearance): void {
  const { width, height } = size(rect);
  if (widget.fillColor !== null) {
    b.fillColor(widget.fillColor);
    b.rect({ x0: 0, y0: 0, x1: width, y1: height });
    b.fill();
  }
  const w = effectiveBorderWidth(widget);
  if (w <= 0 || widget.borderColor === null) return;
  const colour = widget.borderColor;
  switch (widget.borderStyle) {
    case 'underline':
      b.strokeColor(colour).lineWidth(w);
      b.moveTo(0, w / 2)
        .lineTo(width, w / 2)
        .stroke();
      return;
    case 'beveled':
    case 'inset': {
      // The outer frame in the border colour, then two shaded edges inside it. Acrobat's bevel
      // is white/grey for "beveled" and grey/white for "inset"; the direction of the light is
      // what tells the two apart.
      const light = widget.borderStyle === 'beveled' ? shade(colour, 0.85) : shade(colour, -0.5);
      const dark = widget.borderStyle === 'beveled' ? shade(colour, -0.5) : shade(colour, 0.85);
      b.strokeColor(colour).lineWidth(w);
      b.rect({ x0: w / 2, y0: w / 2, x1: width - w / 2, y1: height - w / 2 });
      b.stroke();
      b.fillColor(light);
      b.moveTo(w, w)
        .lineTo(w, height - w)
        .lineTo(width - w, height - w)
        .lineTo(width - 2 * w, height - 2 * w)
        .lineTo(2 * w, height - 2 * w)
        .lineTo(2 * w, 2 * w)
        .closePath();
      b.fill();
      b.fillColor(dark);
      b.moveTo(width - w, height - w)
        .lineTo(width - w, w)
        .lineTo(w, w)
        .lineTo(2 * w, 2 * w)
        .lineTo(width - 2 * w, 2 * w)
        .lineTo(width - 2 * w, height - 2 * w)
        .closePath();
      b.fill();
      return;
    }
    case 'dashed':
      b.dash(widget.dashArray.length > 0 ? widget.dashArray : [3]);
      break;
    default:
      break;
  }
  b.strokeColor(colour).lineWidth(w);
  b.rect({ x0: w / 2, y0: w / 2, x1: width - w / 2, y1: height - w / 2 });
  b.stroke();
  if (widget.borderStyle === 'dashed') b.dash([]);
}

/** Clips everything that follows to the content box. */
function clipTo(b: ContentBuilder, box: PdfRect): void {
  b.rect(box);
  b.push('W');
  b.push('n');
}

// ---- text layout ---------------------------------------------------------------------------------

/** The baseline offset inside a line box, as a fraction of the font size. */
const BASELINE = 0.72;
/** Line spacing for a multiline field, as a fraction of the font size. */
const LEADING = 1.15;

/** The size auto-sizing picks for a single line of `text` in `box`. */
export function autoSize(
  text: string,
  font: StandardFontName,
  box: PdfRect,
  multiline: boolean,
): number {
  const width = box.x1 - box.x0;
  const height = box.y1 - box.y0;
  if (multiline) {
    for (let s = Math.min(MAX_AUTO_SIZE, Math.floor(height)); s >= MIN_AUTO_SIZE; s--) {
      const lines = wrapText(text, font, s, width);
      if (lines.length * s * LEADING <= height) return s;
    }
    return MIN_AUTO_SIZE;
  }
  const byHeight = height / LEADING;
  const measured = textWidth(text === '' ? 'X' : text, font, 100) / 100;
  const byWidth = measured > 0 ? width / measured : byHeight;
  return Math.max(MIN_AUTO_SIZE, Math.min(MAX_AUTO_SIZE, Math.floor(Math.min(byHeight, byWidth))));
}

/** Where a line of text starts, given the field's `/Q`. */
function alignedX(box: PdfRect, lineWidth: number, align: 0 | 1 | 2): number {
  switch (align) {
    case 1:
      return box.x0 + (box.x1 - box.x0 - lineWidth) / 2;
    case 2:
      return box.x1 - lineWidth;
    default:
      return box.x0;
  }
}

/**
 * The baseline that centres one line of text in `box`.
 *
 * A line's visual middle is roughly half its cap height above the baseline, so putting the
 * baseline that far below the box's centre is what makes text sit in the middle of a field rather
 * than in the middle of its own em box — which is a third of a point too high at 9 pt and
 * unmistakable at 24.
 */
export function centredBaseline(box: PdfRect, fontSize: number): number {
  return (box.y0 + box.y1) / 2 - (fontSize * BASELINE) / 2;
}

/** One line of text placed inside a box, in widget-local space. */
export interface PlacedLine {
  readonly text: string;
  readonly x: number;
  readonly y: number;
}

/**
 * Lays a value out inside the content box: wrapping and top alignment for a multiline field,
 * vertical centring for a single line, and the field's `/Q` horizontally.
 */
export function layoutValue(
  text: string,
  da: DefaultAppearance,
  box: PdfRect,
  options: { readonly multiline: boolean; readonly align: 0 | 1 | 2 },
): { readonly lines: ReadonlyArray<PlacedLine>; readonly size: number } {
  const metric = metricFont(da.font);
  const fontSize = da.size > 0 ? da.size : autoSize(text, metric, box, options.multiline);
  if (text === '') return { lines: [], size: fontSize };
  const width = box.x1 - box.x0;
  const lines: PlacedLine[] = [];
  if (options.multiline) {
    let y = box.y1 - fontSize * BASELINE;
    for (const line of wrapText(text, metric, fontSize, width)) {
      lines.push({
        text: line,
        x: alignedX(box, textWidth(line, metric, fontSize), options.align),
        y,
      });
      y -= fontSize * LEADING;
    }
  } else {
    const line = text.replace(/\s+/g, ' ');
    lines.push({
      text: line,
      x: alignedX(box, textWidth(line, metric, fontSize), options.align),
      y: centredBaseline(box, fontSize),
    });
  }
  return { lines, size: fontSize };
}

// ---- the generator -------------------------------------------------------------------------------

/**
 * Draws one widget. Returns null only when the widget is hidden — every other field, empty or
 * not, has a box to draw, and a widget with no `/AP` at all is drawn by viewer guesswork.
 */
export function widgetAppearance(input: WidgetAppearanceInput): AppearanceStream | null {
  if (input.widget.hidden) return null;
  const { width, height } = size(input.rect);
  if (!(width > 0) || !(height > 0)) return null;
  const b = new ContentBuilder();
  const da = daOf(input.design);
  drawBox(b, input.rect, input.widget);

  const box = contentBox(input.rect, input.widget);
  const role = input.design.role;
  const value = input.ignoreValue ? '' : input.value;

  b.save();
  clipTo(b, box);
  switch (role) {
    case 'checkbox':
    case 'radio':
      drawCheck(b, input, box);
      break;
    case 'button':
    case 'image':
      drawButton(b, input, box, da);
      break;
    case 'combobox':
      drawCombo(b, input, box, da, value);
      break;
    case 'listbox':
      drawList(b, input, box, da, value);
      break;
    case 'signature':
      break;
    case 'barcode':
      drawBarcode(b, input, box, value);
      break;
    default:
      drawText(b, input, box, da, value);
      break;
  }
  b.restore();

  // A signature field, an empty text field and an off check box all draw only their box, and a
  // box with no border and no fill puts no ink on the page at all. `ContentBuilder.isEmpty` would
  // call that nothing to draw — but for a widget an empty `/AP` is the right answer: it says
  // "this field looks like nothing", which stops a viewer inventing an appearance of its own.
  return {
    bbox: { x0: 0, y0: 0, x1: width, y1: height },
    content: b.build(),
    resources: b.resources,
  };
}

/** The `/DA` a field draws with. */
export function daOf(design: FieldDesign): DefaultAppearance {
  return { font: design.font, size: design.fontSize, color: design.textColor };
}

/** Re-reads a `/DA` string into the three design fields that hold it. */
export function designFromDa(da: string | null | undefined): DefaultAppearance {
  return parseDefaultAppearance(da);
}

function drawText(
  b: ContentBuilder,
  input: WidgetAppearanceInput,
  box: PdfRect,
  da: DefaultAppearance,
  value: string,
): void {
  const design = input.design;
  const shown = isPassword(design) ? '•'.repeat(Array.from(value).length) : value;
  if (isComb(design)) {
    drawComb(b, input, box, da, shown);
    return;
  }
  if (shown === '') return;
  const laid = layoutValue(shown, da, box, {
    multiline: isMultiline(design),
    align: design.align,
  });
  if (laid.lines.length === 0) return;
  b.fillColor(da.color);
  b.textLinesAt(laid.lines, { font: da.font, size: laid.size });
}

/**
 * A comb field: `/MaxLen` equal cells, one character centred in each, with a separator between
 * them in the border colour. The separators are what makes a comb legible on paper, and Acrobat
 * draws them whenever the field has a border.
 */
function drawComb(
  b: ContentBuilder,
  input: WidgetAppearanceInput,
  box: PdfRect,
  da: DefaultAppearance,
  value: string,
): void {
  const cells = Math.max(1, input.design.maxLength ?? 1);
  const width = (box.x1 - box.x0) / cells;
  const metric = metricFont(da.font);
  const fontSize =
    da.size > 0 ? da.size : autoSize('X', metric, { ...box, x1: box.x0 + width }, false);
  const border = input.widget.borderColor;
  const w = effectiveBorderWidth(input.widget);
  if (border !== null && w > 0 && cells > 1) {
    b.strokeColor(border).lineWidth(Math.min(w, 1));
    for (let i = 1; i < cells; i++) {
      const x = box.x0 + width * i;
      b.moveTo(x, box.y0).lineTo(x, box.y1).stroke();
    }
  }
  const chars = Array.from(value).slice(0, cells);
  if (chars.length === 0) return;
  const baseline = centredBaseline(box, fontSize);
  const lines = chars.map((ch, i) => ({
    text: ch,
    x: box.x0 + width * i + (width - textWidth(ch, metric, fontSize)) / 2,
    y: baseline,
  }));
  b.fillColor(da.color);
  b.textLinesAt(lines, { font: da.font, size: fontSize });
}

/** A check box or radio: the mark, drawn only for the "on" state. */
function drawCheck(b: ContentBuilder, input: WidgetAppearanceInput, box: PdfRect): void {
  if (input.state !== 'on') return;
  const style = input.widget.checkStyle;
  const w = box.x1 - box.x0;
  const h = box.y1 - box.y0;
  const colour = input.design.textColor;
  if (input.design.role === 'radio' && style === 'circle') {
    // A radio's dot is drawn rather than set in ZapfDingbats: a filled circle at two thirds of
    // the box reads at every size, which the glyph does not.
    const r = Math.min(w, h) / 3;
    b.fillColor(colour);
    b.ellipse({
      x0: box.x0 + w / 2 - r,
      y0: box.y0 + h / 2 - r,
      x1: box.x0 + w / 2 + r,
      y1: box.y0 + h / 2 + r,
    });
    b.fill();
    return;
  }
  const glyph = CHECK_STYLE_GLYPH[style];
  const fontSize = Math.min(w, h) * 0.85;
  const advance = (glyphWidth('ZapfDingbats', glyph.codePointAt(0) ?? 32) * fontSize) / 1000;
  b.fillColor(colour);
  b.text(glyph, {
    font: 'ZapfDingbats',
    size: fontSize,
    x: box.x0 + (w - advance) / 2,
    y: box.y0 + (h - fontSize * 0.72) / 2,
  });
}

/** A push button or image field: the icon, the caption, or both in the chosen layout. */
function drawButton(
  b: ContentBuilder,
  input: WidgetAppearanceInput,
  box: PdfRect,
  da: DefaultAppearance,
): void {
  const layout = input.widget.layout;
  const caption = layout === 'icon-only' ? '' : (input.widget.caption ?? '');
  const iconKey = input.widget.iconKey;
  const hasIcon = iconKey !== null && layout !== 'caption-only';

  let iconBox = box;
  let textBox = box;
  if (hasIcon && caption !== '') {
    const half = (box.y1 - box.y0) / 2;
    const halfW = (box.x1 - box.x0) / 2;
    switch (layout) {
      case 'caption-below':
        iconBox = { ...box, y0: box.y0 + half };
        textBox = { ...box, y1: box.y0 + half };
        break;
      case 'caption-above':
        iconBox = { ...box, y1: box.y1 - half };
        textBox = { ...box, y0: box.y1 - half };
        break;
      case 'caption-right':
        iconBox = { ...box, x1: box.x0 + halfW };
        textBox = { ...box, x0: box.x0 + halfW };
        break;
      case 'caption-left':
        iconBox = { ...box, x0: box.x0 + halfW };
        textBox = { ...box, x1: box.x0 + halfW };
        break;
      default:
        break;
    }
  }

  if (hasIcon && iconKey) {
    const w = iconBox.x1 - iconBox.x0;
    const h = iconBox.y1 - iconBox.y0;
    // The picture is a form XObject in its own unit box; scaling it to the icon box and placing
    // it there is the whole of `/MK /I` plus a "proportional, fit" `/IF`.
    b.drawXObject(iconKey, [w, 0, 0, h, iconBox.x0, iconBox.y0]);
  }
  if (caption === '') return;
  const laid = layoutValue(caption, { ...da, size: da.size }, textBox, {
    multiline: false,
    align: 1,
  });
  if (laid.lines.length === 0) return;
  b.fillColor(da.color);
  b.textLinesAt(laid.lines, { font: da.font, size: laid.size });
}

/** The width of a combo box's drop-down button, in points. */
const COMBO_ARROW = 12;

function drawCombo(
  b: ContentBuilder,
  input: WidgetAppearanceInput,
  box: PdfRect,
  da: DefaultAppearance,
  value: string,
): void {
  const arrowBox: PdfRect = { ...box, x0: Math.max(box.x0, box.x1 - COMBO_ARROW) };
  const textBox: PdfRect = { ...box, x1: arrowBox.x0 - TEXT_PADDING };
  const label = labelFor(input.design.options, value);
  if (label !== '') {
    const laid = layoutValue(label, da, textBox, { multiline: false, align: input.design.align });
    if (laid.lines.length > 0) {
      b.fillColor(da.color);
      b.textLinesAt(laid.lines, { font: da.font, size: laid.size });
    }
  }
  // The arrow: a solid triangle in the text colour, which is the one colour the field is certain
  // to have and which therefore always contrasts with its own background.
  const cx = (arrowBox.x0 + arrowBox.x1) / 2;
  const cy = (arrowBox.y0 + arrowBox.y1) / 2;
  const r = Math.min(COMBO_ARROW, arrowBox.y1 - arrowBox.y0) / 3;
  b.fillColor(da.color);
  b.moveTo(cx - r, cy + r / 2)
    .lineTo(cx + r, cy + r / 2)
    .lineTo(cx, cy - r)
    .closePath();
  b.fill();
}

/** The list box: as many options as fit from `/TI`, the selected ones on a highlight band. */
function drawList(
  b: ContentBuilder,
  input: WidgetAppearanceInput,
  box: PdfRect,
  da: DefaultAppearance,
  value: string,
): void {
  const design = input.design;
  const options = design.options;
  const selected = new Set(
    isMultiSelect(design) ? value.split('\n').filter((v) => v !== '') : value === '' ? [] : [value],
  );
  const metric = metricFont(da.font);
  const fontSize = da.size > 0 ? da.size : Math.min(MAX_AUTO_SIZE, Math.max(MIN_AUTO_SIZE, 9));
  const rowHeight = fontSize * LEADING;
  const first = Math.max(0, Math.min(design.topIndex, Math.max(0, options.length - 1)));
  const rows = Math.max(1, Math.floor((box.y1 - box.y0) / rowHeight));
  const shown = options.slice(first, first + rows);

  // The selection band. Acrobat's is a light blue; ours is the text colour lightened towards the
  // paper, so it separates on lightness in every colour scheme rather than on hue alone.
  const bandColour = shade(da.color, 0.75);
  shown.forEach((option, i) => {
    if (!selected.has(option.value)) return;
    const top = box.y1 - rowHeight * i;
    b.fillColor(bandColour);
    b.rect({ x0: box.x0, y0: top - rowHeight, x1: box.x1, y1: top });
    b.fill();
  });
  const lines = shown.map((option, i) => ({
    text: option.label,
    x: alignedX(box, textWidth(option.label, metric, fontSize), design.align),
    y: box.y1 - rowHeight * i - fontSize * BASELINE,
  }));
  if (lines.length === 0) return;
  b.fillColor(da.color);
  b.textLinesAt(lines, { font: da.font, size: fontSize });
}

/** The barcode: the encoded symbol, centred and scaled to fit without distortion. */
function drawBarcode(
  b: ContentBuilder,
  input: WidgetAppearanceInput,
  box: PdfRect,
  value: string,
): void {
  const spec = input.design.barcode;
  if (!spec || value === '') return;
  let symbol;
  try {
    symbol = barcodeSymbol(spec, value);
  } catch (error) {
    if (!(error instanceof BarcodeError)) throw error;
    return;
  }
  if (!symbol) return;
  const fitted = fitBarcode(symbol, spec, {
    width: box.x1 - box.x0,
    height: box.y1 - box.y0,
  });
  const originX = box.x0 + (box.x1 - box.x0 - fitted.width) / 2;
  const originY = box.y0 + (box.y1 - box.y0 - fitted.height) / 2;
  // The symbol's own y runs downwards; the flip is folded into the placement rather than into a
  // `cm`, so the path numbers in the file read the same way as the ones on screen.
  b.fillColor(0x000000);
  for (const polygon of symbol.polygons) {
    const [head, ...rest] = polygon;
    if (!head) continue;
    b.moveTo(originX + head.x * fitted.scale, originY + fitted.height - head.y * fitted.scale);
    for (const p of rest) {
      b.lineTo(originX + p.x * fitted.scale, originY + fitted.height - p.y * fitted.scale);
    }
    b.closePath();
  }
  b.fill();
}

/** The label a choice field shows for a stored export value. */
export function labelFor(options: ReadonlyArray<FieldOption>, value: string): string {
  return options.find((o) => o.value === value)?.label ?? value;
}

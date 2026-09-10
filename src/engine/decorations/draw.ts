/**
 * Turning a decoration spec into content (M53, ADR 0020 §4).
 *
 * One function per family, all pure and all producing the same thing: a {@link DecorationDraw}
 * for one page. The live engine wraps it in a form XObject and hands it to PDFium; the writer
 * wraps it in a form XObject and puts it in the file. There is one piece of drawing code, so the
 * preview, the page on screen and the saved bytes cannot disagree — which is the whole reason
 * this file has no idea PDFium or pdf-lib exist.
 *
 * Geometry is display space (see `layout.ts`): the page as the reader sees it, `/Rotate` already
 * applied, origin bottom-left. `DecorationDraw.matrix` carries the trip back to page space.
 */

import type { PdfRect } from '@shared/pdf';
import { ContentBuilder } from '../appearance/content';
import { textWidth } from '../appearance/metrics';
import type { StandardFontName } from '../appearance/types';
import { batesNumber, expandMacros } from './macros';
import { displaySize, displayToPage, isHeaderZone, placement, zoneBaseline, zoneX } from './layout';
import { multiply } from '../content/matrix';
import { toWinAnsi } from './text';
import {
  ZONES,
  type BatesSpec,
  type DecorationDraw,
  type DecorationSpec,
  type HeaderFooterSpec,
  type PageContext,
  type DecorationFont,
  type WatermarkSpec,
  type ZoneName,
} from './types';

/**
 * The face whose widths lay a decoration out. Every decoration font *is* one of the standard 14,
 * so this is the identity — it exists to say so once, and to give a future embedded-font option
 * one place to change.
 */
function metricsFace(font: DecorationFont): StandardFontName {
  return font;
}

/** The natural size of a picture or PDF page a watermark draws, in points. */
export interface SourceSize {
  readonly width: number;
  readonly height: number;
}

export interface DrawContext {
  readonly page: PageContext;
  /** Natural sizes of the `xobjects` a spec names, by key. */
  readonly sources?: Readonly<Record<string, SourceSize>>;
}

/** Everything a caller may want to know about a draw that did not go perfectly. */
export interface DrawResult {
  readonly draw: DecorationDraw | null;
  /** Characters the standard-14 encoding could not write. */
  readonly dropped: ReadonlyArray<string>;
}

/** Draws whichever family the spec belongs to. */
export function drawDecoration(id: string, spec: DecorationSpec, context: DrawContext): DrawResult {
  switch (spec.kind) {
    case 'header-footer':
      return drawHeaderFooter(id, spec, context);
    case 'bates':
      return drawBates(id, spec, context);
    default:
      return drawWatermark(id, spec, context);
  }
}

/** The whole displayed page, as the bounding box a full-page decoration is drawn in. */
function pageBox(context: DrawContext): PdfRect {
  const size = displaySize(context.page.box, context.page.rotation);
  return { x0: 0, y0: 0, x1: size.width, y1: size.height };
}

function drawHeaderFooter(id: string, spec: HeaderFooterSpec, context: DrawContext): DrawResult {
  const size = displaySize(context.page.box, context.page.rotation);
  const builder = new ContentBuilder();
  const dropped: string[] = [];
  const lines: Array<{ text: string; x: number; y: number }> = [];
  let anyHeader = false;
  let anyFooter = false;

  for (const zone of ZONES) {
    const raw = spec.zones[zone] ?? '';
    if (raw.trim() === '') continue;
    const expanded = expandMacros(raw, context.page, {
      startNumber: spec.startNumber,
      totalOverride: spec.totalOverride,
    });
    const encoded = toWinAnsi(expanded);
    for (const ch of encoded.dropped) if (!dropped.includes(ch)) dropped.push(ch);
    if (encoded.text === '') continue;
    const width = textWidth(encoded.text, metricsFace(spec.font), spec.size);
    lines.push({
      text: encoded.text,
      x: zoneX(zone, size, spec.margins, width),
      y: zoneBaseline(zone, size, spec.margins, spec.size),
    });
    if (isHeaderZone(zone)) anyHeader = true;
    else anyFooter = true;
  }

  if (lines.length === 0) return { draw: null, dropped };

  builder.fillColor(spec.colour);
  builder.textLinesAt(lines, { font: spec.font, size: spec.size });

  if (spec.underline) {
    builder.strokeColor(spec.colour);
    builder.lineWidth(0.5);
    const left = spec.margins.left;
    const right = size.width - spec.margins.right;
    if (anyHeader) {
      const y = zoneBaseline('header-left', size, spec.margins, spec.size) - spec.size * 0.3;
      builder.moveTo(left, y).lineTo(right, y).stroke();
    }
    if (anyFooter) {
      const y = zoneBaseline('footer-left', size, spec.margins, spec.size) + spec.size * 1.05;
      builder.moveTo(left, y).lineTo(right, y).stroke();
    }
  }

  return {
    draw: {
      id,
      kind: 'header-footer',
      bbox: pageBox(context),
      matrix: displayToPage(context.page.box, context.page.rotation),
      content: builder.build(),
      resources: builder.resources,
      behind: false,
      print: true,
      screen: true,
      spec: JSON.stringify(spec),
    },
    dropped,
  };
}

function drawBates(id: string, spec: BatesSpec, context: DrawContext): DrawResult {
  const size = displaySize(context.page.box, context.page.rotation);
  const value = batesNumber({
    prefix: spec.prefix,
    suffix: spec.suffix,
    digits: spec.digits,
    value: spec.startAt + context.page.ordinal - 1,
  });
  const encoded = toWinAnsi(value);
  if (encoded.text === '') return { draw: null, dropped: encoded.dropped };
  const width = textWidth(encoded.text, metricsFace(spec.font), spec.size);
  const builder = new ContentBuilder();
  builder.fillColor(spec.colour);
  builder.text(encoded.text, {
    font: spec.font,
    size: spec.size,
    x: zoneX(spec.zone, size, spec.margins, width),
    y: zoneBaseline(spec.zone, size, spec.margins, spec.size),
  });
  return {
    draw: {
      id,
      kind: 'bates',
      bbox: pageBox(context),
      matrix: displayToPage(context.page.box, context.page.rotation),
      content: builder.build(),
      resources: builder.resources,
      behind: false,
      print: true,
      screen: true,
      spec: JSON.stringify(spec),
    },
    dropped: encoded.dropped,
  };
}

function drawWatermark(id: string, spec: WatermarkSpec, context: DrawContext): DrawResult {
  const size = displaySize(context.page.box, context.page.rotation);
  const builder = new ContentBuilder();
  const dropped: string[] = [];
  let bbox: PdfRect;

  switch (spec.source.kind) {
    case 'colour': {
      // A flat colour fills the whole page and is never scaled, rotated or moved: it is the
      // paper, not something on it.
      bbox = { x0: 0, y0: 0, x1: size.width, y1: size.height };
      builder.fillColor(spec.colour);
      builder.rect(bbox).fill();
      return {
        draw: {
          id,
          kind: spec.kind,
          bbox,
          matrix: displayToPage(context.page.box, context.page.rotation),
          content: builder.build(),
          resources: builder.resources,
          behind: spec.behind,
          print: spec.print,
          screen: spec.screen,
          spec: JSON.stringify(spec),
        },
        dropped,
      };
    }
    case 'text': {
      const encoded = toWinAnsi(spec.source.text);
      dropped.push(...encoded.dropped);
      const lines = encoded.text.split(/\r\n|\r|\n/).filter((l) => l !== '');
      if (lines.length === 0) return { draw: null, dropped };
      const face = metricsFace(spec.font);
      const widest = Math.max(...lines.map((l) => textWidth(l, face, spec.size)));
      const leading = spec.size * 1.2;
      const height = leading * lines.length;
      bbox = { x0: 0, y0: 0, x1: Math.max(1, widest), y1: Math.max(1, height) };
      builder.fillColor(spec.colour);
      builder.textLinesAt(
        lines.map((text, i) => ({
          text,
          x: (widest - textWidth(text, face, spec.size)) / 2,
          // Top line first: the last line's baseline sits one descender above the box's floor.
          y: height - leading * (i + 1) + spec.size * 0.24,
        })),
        { font: spec.font, size: spec.size },
      );
      break;
    }
    default: {
      const key = spec.source.key;
      const natural = context.sources?.[key];
      if (!natural || natural.width <= 0 || natural.height <= 0) return { draw: null, dropped };
      bbox = { x0: 0, y0: 0, x1: natural.width, y1: natural.height };
      builder.drawXObject(key, [natural.width, 0, 0, natural.height, 0, 0]);
      break;
    }
  }

  const place = placement(bbox, size, {
    rotation: spec.rotation,
    scale: spec.scale,
    position: spec.position,
    offsetX: spec.offsetX,
    offsetY: spec.offsetY,
  });
  return {
    draw: {
      id,
      kind: spec.kind,
      bbox,
      matrix: multiply(place, displayToPage(context.page.box, context.page.rotation)),
      content: builder.build(),
      resources: builder.resources,
      behind: spec.behind,
      print: spec.print,
      screen: spec.screen,
      spec: JSON.stringify(spec),
    },
    dropped,
  };
}

/**
 * The Bates value a page would carry, so a header's `<<Bates>>` and the Bates decoration itself
 * always say the same thing.
 */
export function batesFor(spec: BatesSpec, ordinal: number): string {
  return batesNumber({
    prefix: spec.prefix,
    suffix: spec.suffix,
    digits: spec.digits,
    value: spec.startAt + ordinal - 1,
  });
}

/** A zone's default text, for the dialog's first paint. */
export const DEFAULT_ZONE_TEXT: Readonly<Partial<Record<ZoneName, string>>> = {
  'footer-centre': '<<1 of n>>',
};

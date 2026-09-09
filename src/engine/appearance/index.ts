/**
 * `AppearanceService` — the registry of appearance generators (M21).
 *
 * A registry rather than a switch, because every annotation module after this one adds a subtype
 * and needs to say how it is drawn without editing a file it does not own. M30 registers its
 * callout, M31 its stamps, M33 its measurements; each calls `register()` from its manifest's
 * `activate`, and `FullRewriteWriter` asks the service for whatever it is given.
 *
 * Nothing here touches a PDF library or the DOM: a generator takes an {@link AppearanceInput}
 * and returns content-stream text.
 */

import type { AnnotationSubtype } from '../PdfEngine';
import { fileAttachmentAppearance } from './generators';
import { freeTextAppearance } from './freetext';
import { inkAppearance } from './ink';
import {
  caretAppearance,
  highlightAppearance,
  squigglyAppearance,
  strikeOutAppearance,
  underlineAppearance,
} from './markup';
import { noteAppearance } from './note';
import {
  circleAppearance,
  lineAppearance,
  polygonAppearance,
  polylineAppearance,
  squareAppearance,
} from './shapes';
import { stampAppearance } from './stamp';
import type { AppearanceGenerator, AppearanceInput, AppearanceStream } from './types';

export * from './types';
export { ContentBuilder, num, pdfString, rgbComponents, type PathOp } from './content';
export { glyphWidth, textWidth, wrapText } from './metrics';
export {
  quadRects,
  ATTACHMENT_ICONS,
  ATTACHMENT_ICON_LABELS,
  isAttachmentIcon,
  type AttachmentIcon,
} from './generators';
export {
  quads,
  quadNumbers,
  quadFromRect,
  quadsBounds,
  caretRectAt,
  CARET_SIZE,
  type Quad,
} from './markup';
export {
  NOTE_ICONS,
  NOTE_SIZE,
  DEFAULT_NOTE_ICON,
  noteIcon,
  noteRectAt,
  iconPointsIn,
  type IconStep,
  type NoteIcon,
} from './note';
export {
  BASE_FAMILIES,
  DEFAULT_FREE_TEXT_STYLE,
  appearanceFontFor,
  buildDefaultAppearance,
  buildDefaultStyle,
  calloutNumbers,
  calloutOf,
  familyFor,
  intentOf,
  layoutFreeText,
  measureFreeText,
  paddingOf,
  logicalBox,
  parseDefaultAppearance,
  parseDefaultStyle,
  rotateOf,
  rotatePoint,
  styleOf,
  styledStandardFont,
  textBoxOf,
  FREE_TEXT_PADDING,
  type FreeTextFamily,
  type FreeTextIntent,
  type FreeTextStyle,
  type LaidOutLine,
  type TextAlign,
} from './freetext';
export {
  ANNOTATION_DICT_MAPPINGS,
  dictEntries,
  dictMapping,
  engineWritableKeys,
  toDictValue,
  type DictMapping,
  type DictValue,
} from './dict';
export {
  LINE_ENDINGS,
  LINE_ENDING_LABELS,
  isLineEnding,
  lineEndingsOf,
  lineEndingDrawing,
  endingSize,
  cloudIntensityOf,
  cloudRadius,
  cloudOverhang,
  cloudOps,
  dashOf,
  arcOps,
  ellipseOps,
  ellipsePoints,
  rectPoints,
  polygonOps,
  signedArea,
  opsBounds,
  pointsBounds,
  shapeDrawings,
  shapeRectFor,
  paintDrawings,
  type LineEnding,
  type EndingDrawing,
  type ShapeDrawing,
} from './shapes';
export {
  smoothStrokeOps,
  catmullRomSegments,
  inkDrawings,
  inkRect,
  pressuresOf,
  widthForPressure,
  pointSegmentDistance,
  strokeHit,
  splitStroke,
  type BezierSegment,
} from './ink';
export {
  parseStampCatalogue,
  resolveStampTokens,
  isDynamicStamp,
  STAMP_TOKENS,
  STAMP_FONT,
  STAMP_KEY,
  STAMP_SIZE,
  stampDrawing,
  stampForm,
  stampKey,
  stampMatrix,
  stampRectAt,
  stampSizeOf,
  stampRotationOf,
  applyMatrix,
  transformOps,
  matrixScale,
  roundedRectOps,
  drawingBounds,
  type StampDefinition,
  type StampCategory,
  type StampCatalogue,
  type StampTokenContext,
  type StampDrawing,
  type StampText,
} from './stamp';

/**
 * The subtypes PDFium generates an `/AP` for by itself when it loads a page
 * (`CPDF_AnnotList` → `CPVT_GenerateAP`). Ours are still registered for them, because a file
 * saved by another tool can arrive with none and PDFium only fixes what it has loaded.
 */
export const PDFIUM_GENERATES: ReadonlySet<AnnotationSubtype> = new Set<AnnotationSubtype>([
  'Highlight',
  'Underline',
  'StrikeOut',
  'Squiggly',
  'Square',
  'Circle',
  'Ink',
  'Text',
  'Popup',
]);

export class AppearanceService {
  private readonly generators = new Map<AnnotationSubtype, AppearanceGenerator>();

  /** Registers (or replaces) the generator for one subtype. Returns a disposer. */
  register(subtype: AnnotationSubtype, generator: AppearanceGenerator): () => void {
    const previous = this.generators.get(subtype);
    this.generators.set(subtype, generator);
    return () => {
      if (previous) this.generators.set(subtype, previous);
      else this.generators.delete(subtype);
    };
  }

  has(subtype: AnnotationSubtype): boolean {
    return this.generators.has(subtype);
  }

  /** Every subtype that can be drawn, sorted (diagnostics and tests). */
  subtypes(): AnnotationSubtype[] {
    return [...this.generators.keys()].sort();
  }

  /**
   * Draws one annotation, or returns `null` when there is no generator for its subtype or the
   * annotation has nothing to draw (an ink stroke with no points, a rect of zero area).
   */
  generate(input: AppearanceInput): AppearanceStream | null {
    const generator = this.generators.get(input.subtype);
    if (!generator) return null;
    return generator(input);
  }
}

/** Builds a service with the generators M21 ships. Modules add to their own copy. */
export function createAppearanceService(): AppearanceService {
  const service = new AppearanceService();
  service.register('Square', squareAppearance);
  service.register('Circle', circleAppearance);
  service.register('Line', lineAppearance);
  service.register('Polygon', polygonAppearance);
  service.register('PolyLine', polylineAppearance);
  service.register('Ink', inkAppearance);
  service.register('Highlight', highlightAppearance);
  service.register('Underline', underlineAppearance);
  service.register('StrikeOut', strikeOutAppearance);
  service.register('Squiggly', squigglyAppearance);
  service.register('FreeText', freeTextAppearance);
  service.register('FileAttachment', fileAttachmentAppearance);
  service.register('Caret', caretAppearance);
  service.register('Text', noteAppearance);
  service.register('Stamp', stampAppearance);
  return service;
}

/** The service the writer uses when the caller does not pass one. */
export const defaultAppearanceService: AppearanceService = createAppearanceService();

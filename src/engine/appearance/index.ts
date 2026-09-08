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
import {
  caretAppearance,
  circleAppearance,
  fileAttachmentAppearance,
  freeTextAppearance,
  highlightAppearance,
  inkAppearance,
  lineAppearance,
  polygonAppearance,
  polylineAppearance,
  squareAppearance,
  squigglyAppearance,
  strikeOutAppearance,
  underlineAppearance,
} from './generators';
import type { AppearanceGenerator, AppearanceInput, AppearanceStream } from './types';

export * from './types';
export { ContentBuilder, num, pdfString, rgbComponents } from './content';
export { glyphWidth, textWidth, wrapText } from './metrics';
export { quadRects } from './generators';

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
  return service;
}

/** The service the writer uses when the caller does not pass one. */
export const defaultAppearanceService: AppearanceService = createAppearanceService();

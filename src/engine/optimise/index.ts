/**
 * `src/engine/optimise/` — reducing a PDF's size, linearising it, repairing it and merging its
 * duplicate resources (M100, ADR 0019).
 *
 * Import from here rather than from the individual files: this is the surface M120's batch runner
 * and M121's command line are meant to see, and keeping it in one place makes it obvious when it
 * grows. Everything exported is a pure function over bytes except {@link QpdfTasks}, which is
 * given a runner and therefore just as portable.
 */

export * from './types';
export { optimise, auditBytes, type OptimiseHooks } from './optimise';
export { auditDocument } from './audit';
export { discard, type DiscardOutcome } from './discard';
export { dedupe, type DedupeOutcome } from './dedupe';
export { optimiseImages, type ImageOutcome } from './images/pipeline';
export { optimiseFonts, type FontOutcome } from './fonts/pipeline';
export { collectFontUsage, type UsageMap } from './fonts/usage';
export { isSafeToUnembed, stripSubsetPrefix, STANDARD_14 } from './fonts/standard';
export { subsetFont, readSfnt, glyphsReachableByCmap, withComponents } from './fonts/sfnt';
export { encodeGroup4 } from './images/ccitt';
export { resample, targetSize } from './images/resample';
export { findPlacements, type Placements, type DrawnSize } from './images/placement';
export {
  BUILT_IN_PRESETS,
  DEFAULT_PRESET_ID,
  NO_CHANGE,
  isLossless,
  presetById,
  readOptions,
  readPreset,
} from './presets';
export { QpdfTasks } from './qpdf/tasks';
export { repairBytes, type RepairTools } from './repair';
export { checkArgs, lineariseArgs, readCheck, repairArgs, structureArgs } from './qpdf/structure';

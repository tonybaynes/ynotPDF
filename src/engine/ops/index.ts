/**
 * The whole-document operations (M41). See `types.ts` for what they all have in common.
 *
 * Import from here rather than from the individual files: this is the surface M120's batch
 * runner and M121's command line are meant to see, and keeping it in one place makes it obvious
 * when it grows.
 */

export * from './types';
export * from './combine';
export * from './split';
export * from './crop';
export * from './flatten';
export * from './deskew';
export { writeOutlineTree, type OutlineEntry } from './outline';
export {
  BOX_KEYS,
  createPdf,
  effectiveBox,
  loadPdf,
  pageLeaves,
  readBox,
  readOutline,
  readRotation,
  savePdf,
  writeBoxes,
  type FlatBookmark,
} from './pdfdoc';

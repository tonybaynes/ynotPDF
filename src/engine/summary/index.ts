/**
 * Comment summary (M32): the layout is pure, the build turns it into a PDF.
 */

export * from './types';
export {
  layoutSummary,
  blockLines,
  compareComments,
  clampFontSize,
  formatSummaryDate,
  widestLine,
  anchorOnPage,
  SUMMARY_MARGIN,
  SUMMARY_BODY_FONT,
  SUMMARY_HEAD_FONT,
  SUMMARY_BLOCK_PADDING,
  SUMMARY_HEADING_GAP,
} from './layout';
export {
  buildSummary,
  type BuildSummaryInput,
  type BuiltSummary,
  type RenderedPage,
} from './build';

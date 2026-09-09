/**
 * Turns a laid-out summary into a PDF (M32). pdf-lib does the writing; the pages come in as
 * pictures from the caller.
 *
 * The source pages arrive as **rendered PNGs**, not as copied page trees, and that is a decision
 * worth stating. Copying a page brings its whole resource graph with it — fonts, XObjects,
 * optional content, annotations — and would make a summary of a 200-page document as big as the
 * document. A summary is a thing to read and to send; what matters is that the page looks like
 * the page, which a render at a sensible density gives exactly, including every annotation drawn
 * by the engine. The comments themselves are real text, so the summary is searchable.
 *
 * The layout is already decided (`layout.ts`); nothing here computes a position.
 */

import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import type { PdfPoint } from '@shared/pdf';
import { SUMMARY_BLOCK_PADDING, SUMMARY_HEADING_GAP, SUMMARY_MARGIN } from './layout';
import { toDrawableText } from './text';
import type { SummaryOptions, SummaryPagePlan, SummaryPlan } from './types';

/** A rendered source page. `png` is the encoded image; the size is the page's own, in points. */
export interface RenderedPage {
  readonly png: Uint8Array;
  readonly width: number;
  readonly height: number;
}

export interface BuildSummaryInput {
  readonly plan: SummaryPlan;
  readonly options: SummaryOptions;
  /** A rendered picture of one source page, or null when it could not be rendered. */
  readonly render: (page: number) => Promise<RenderedPage | null>;
  /** Metadata for the new file. */
  readonly sourceTitle: string;
  /** Called between pages so a long summary can show progress and be cancelled. */
  readonly onProgress?: (fraction: number) => void;
  readonly signal?: AbortSignal;
}

/**
 * Everything drawn on a summary is one of three inks, and all three are PDF *content*, not
 * interface colours: a summary is read in whatever viewer the reader has, so it cannot borrow a
 * theme token. Ink is near-black, the rule and the connector a mid grey that prints, and the
 * marker a strong blue that stays distinguishable from the ink to a dichromat.
 */
const INK = rgb(0.09, 0.09, 0.11); // ynot-allow-color: PDF content, not interface chrome
const RULE = rgb(0.45, 0.45, 0.5); // ynot-allow-color: PDF content, not interface chrome
const MARKER = rgb(0.05, 0.25, 0.6); // ynot-allow-color: PDF content, not interface chrome

export interface BuiltSummary {
  readonly bytes: Uint8Array;
  readonly pageCount: number;
  /** Pages the engine could not draw; their comments are still listed. */
  readonly unrendered: ReadonlyArray<number>;
}

export async function buildSummary(input: BuildSummaryInput): Promise<BuiltSummary> {
  const { plan, options } = input;
  const doc = await PDFDocument.create({ updateMetadata: false });
  doc.setTitle(`${options.title} — ${input.sourceTitle}`);
  doc.setCreator('ynotPDF');
  doc.setProducer('ynotPDF');
  const body = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  const images = new Map<number, Awaited<ReturnType<PDFDocument['embedPng']>> | null>();
  const unrendered: number[] = [];
  const total = Math.max(1, plan.pages.length);

  for (const [index, page] of plan.pages.entries()) {
    input.signal?.throwIfAborted();
    const sheet = doc.addPage([page.width, page.height]);
    if (page.document) {
      const source = page.document.sourcePage;
      if (!images.has(source)) {
        const rendered = await input.render(source);
        images.set(source, rendered === null ? null : await doc.embedPng(rendered.png));
        if (rendered === null) unrendered.push(source);
      }
      const image = images.get(source);
      if (image) {
        sheet.drawImage(image, {
          x: page.document.x,
          y: page.document.y,
          width: page.document.width,
          height: page.document.height,
        });
      }
      // A thin frame so the reader can tell where the page ends on a wide sheet, and so a page
      // that could not be rendered is still visibly a page rather than nothing at all.
      sheet.drawRectangle({
        x: page.document.x,
        y: page.document.y,
        width: page.document.width,
        height: page.document.height,
        borderColor: RULE,
        borderWidth: 0.5,
      });
      if (!image) {
        sheet.drawText('This page could not be drawn', {
          x: page.document.x + SUMMARY_MARGIN,
          y: page.document.y + page.document.height / 2,
          font: body,
          size: 10,
          color: RULE,
        });
      }
    }
    drawSheet(sheet, page, body, bold);
    input.onProgress?.((index + 1) / total);
  }

  if (plan.pages.length === 0) {
    // A summary of nothing is still a document: it says so, rather than being a zero-page file
    // no viewer will open.
    const sheet = doc.addPage([595.28, 841.89]);
    sheet.drawText(toDrawableText(`${options.title} — no comments`), {
      x: SUMMARY_MARGIN,
      y: 841.89 - SUMMARY_MARGIN - 12,
      font: bold,
      size: 12,
      color: INK,
    });
  }

  const bytes = await doc.save({ useObjectStreams: false });
  return { bytes, pageCount: doc.getPageCount(), unrendered };
}

function drawSheet(sheet: PDFPage, page: SummaryPagePlan, body: PDFFont, bold: PDFFont): void {
  if (page.heading !== null) {
    sheet.drawText(toDrawableText(page.heading), {
      x: SUMMARY_MARGIN,
      y: page.height - SUMMARY_MARGIN - SUMMARY_HEADING_GAP + 6,
      font: bold,
      size: 10,
      color: INK,
    });
    sheet.drawLine({
      start: { x: SUMMARY_MARGIN, y: page.height - SUMMARY_MARGIN - SUMMARY_HEADING_GAP },
      end: {
        x: page.width - SUMMARY_MARGIN,
        y: page.height - SUMMARY_MARGIN - SUMMARY_HEADING_GAP,
      },
      thickness: 0.5,
      color: RULE,
    });
  }

  for (const connector of page.connectors) {
    sheet.drawLine({
      start: connector.from,
      end: connector.to,
      thickness: 0.5,
      color: RULE,
    });
  }

  for (const marker of page.markers) {
    drawMarker(sheet, marker.at, marker.sequence, bold);
  }

  for (const block of page.blocks) {
    sheet.drawRectangle({
      x: block.x,
      y: block.y,
      width: block.width,
      height: block.height,
      borderColor: RULE,
      borderWidth: 0.5,
    });
    let y = block.y + block.height - SUMMARY_BLOCK_PADDING;
    for (const line of block.lines) {
      y -= line.size * 1.35;
      if (line.text === '') continue;
      sheet.drawText(toDrawableText(line.text), {
        x: block.x + SUMMARY_BLOCK_PADDING + line.indent,
        y: y + line.size * 0.25,
        font: line.bold ? bold : body,
        size: line.size,
        color: INK,
      });
    }
  }
}

/** A numbered pin on the source page: a filled circle with the number reversed out of it. */
function drawMarker(sheet: PDFPage, at: PdfPoint, sequence: number, bold: PDFFont): void {
  const label = String(sequence);
  const size = 7;
  const radius = Math.max(7, bold.widthOfTextAtSize(label, size) / 2 + 3);
  sheet.drawCircle({ x: at.x, y: at.y, size: radius, color: MARKER });
  sheet.drawText(label, {
    x: at.x - bold.widthOfTextAtSize(label, size) / 2,
    y: at.y - size / 2 + 0.5,
    font: bold,
    size,
    color: rgb(1, 1, 1), // ynot-allow-color: PDF content, not interface chrome
  });
}

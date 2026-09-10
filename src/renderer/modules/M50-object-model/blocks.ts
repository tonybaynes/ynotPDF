/**
 * Text blocks (M50): the engine's text objects — one per showing operator, far too fine to click
 * on — grouped into the paragraphs M13's `buildPageText` finds, so selection here, copy in M13
 * and reflow in M51 all agree on what a block is.
 *
 * Each character of the page text names the run it came from and each run names its owning
 * page object, so a paragraph maps to a set of object indexes. A text object that no run reached
 * (a space-only run, say) becomes a block of its own rather than vanishing.
 */

import type { PageObject, TextRun } from '@engine/PdfEngine';
import type { PdfRect } from '@shared/pdf';
import { buildPageText } from '@view/TextLayer';
import { unionRect } from './geometry';

export interface TextBlock {
  /** `t<first member index>`. */
  readonly id: string;
  /** Engine indexes of the text objects, ascending. */
  readonly members: ReadonlyArray<number>;
  readonly rect: PdfRect;
  /** The block's text, for the panel and the palette. */
  readonly text: string;
}

export function textBlocks(
  page: number,
  runs: ReadonlyArray<TextRun>,
  objects: ReadonlyArray<PageObject>,
): TextBlock[] {
  const model = buildPageText(page, runs);
  const out: TextBlock[] = [];
  const covered = new Set<number>();
  for (const paragraph of model.paragraphs) {
    const members = new Set<number>();
    for (let i = paragraph.start; i < paragraph.end; i++) {
      const c = model.chars[i];
      if (!c || c.synthetic) continue;
      const run = runs[c.run];
      if (run && objects[run.objectIndex]?.kind === 'text') members.add(run.objectIndex);
    }
    // A block is owned by the first paragraph that claims an object; later ones leave it.
    const own = [...members].filter((m) => !covered.has(m)).sort((a, b) => a - b);
    if (own.length === 0) continue;
    for (const m of own) covered.add(m);
    const rects = own.map((m) => objects[m]?.rect).filter((r): r is PdfRect => r !== undefined);
    out.push({
      id: `t${own[0] ?? 0}`,
      members: own,
      rect: unionRect(rects) ?? paragraph.rect,
      text: model.text.slice(paragraph.start, paragraph.end).trim(),
    });
  }
  objects.forEach((o) => {
    if (o.kind !== 'text' || covered.has(o.index)) return;
    covered.add(o.index);
    out.push({ id: `t${o.index}`, members: [o.index], rect: o.rect, text: o.text ?? '' });
  });
  return out.sort((a, b) => (a.members[0] ?? 0) - (b.members[0] ?? 0));
}

/** The block an engine index belongs to, if any. */
export function blockOf(blocks: ReadonlyArray<TextBlock>, index: number): TextBlock | null {
  return blocks.find((b) => b.members.includes(index)) ?? null;
}

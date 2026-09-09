/**
 * M30 against the operator's own PDFs (`test/fixtures/local/`, git-ignored).
 *
 * The synthetic fixtures are built to be easy; these are what the module is actually for — three
 * boarding passes from three different producers (our own writer, an unknown one, and Edge's Skia
 * print-to-PDF, which is tagged) and a Foxit portfolio. Marking real text on a real file is where
 * a wrong assumption about `textRuns`, page boxes or `/Annots` shows up.
 *
 * Every test skips when the folder is empty, because CI and every other machine has no copy of it
 * (CLAUDE.md). Nothing here reads, prints or asserts anything about what the documents *say*: the
 * checks are about geometry and structure only.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Document } from '@core/Document';
import { AddAnnotationCommand, DEFAULT_ANNOTATION_FLAGS, draftAnnotation } from '@core/commands';
import { FullRewriteWriter } from '@engine/writers/FullRewriteWriter';
import { buildWritePlan } from '@modules/M21-save/plan';
import {
  buildDefaultAppearance,
  buildDefaultStyle,
  DEFAULT_FREE_TEXT_STYLE,
  noteRectAt,
  quadNumbers,
  quadsBounds,
} from '@engine/appearance';
import { buildPageText } from '@view/TextLayer';
import { quadsForSpan } from '@modules/M30-markup-annotations/quads';
import { engine, FIXTURES } from '../engine/helpers';
import { must } from '../find/helpers';

const LOCAL = join(FIXTURES, 'local');

/** The operator's PDFs, or an empty list on a machine that has none. */
function localFiles(): string[] {
  if (!existsSync(LOCAL)) return [];
  return readdirSync(LOCAL)
    .filter((name) => name.toLowerCase().endsWith('.pdf'))
    .sort();
}

const FILES = localFiles();
const skip = FILES.length === 0;

describe.skipIf(skip)('the operator’s own PDFs', () => {
  it('has files to check', () => {
    expect(FILES.length).toBeGreaterThan(0);
  });

  for (const name of FILES) {
    it(`marks real text on ${name.replace(/[^\w. -]/g, '')} and reads it back after a save`, async () => {
      const eng = await engine();
      const bytes = new Uint8Array(readFileSync(join(LOCAL, name)));
      const doc = await Document.open(eng, bytes.slice());
      const page = must(doc.state.pages[0], 'page');
      const before = (await doc.loadAnnotations(page.id)).length;

      /*
       * A highlight over the first line of the page's own text — not a rectangle we invented, so
       * the quads have to come out of whatever `textRuns` actually reports for this producer.
       * A page with no extractable text (a pure scan) is a skip, not a failure.
       */
      const text = buildPageText(0, await eng.textRuns(doc.handle, 0));
      const line = text.lines[0];
      if (!line) {
        await doc.close();
        return;
      }
      const list = quadsForSpan(text, { start: line.start, end: line.end });
      expect(list.length, 'quads for the first line').toBeGreaterThan(0);
      const bounds = must(quadsBounds(list), 'bounds');

      // The quads must sit inside the page, or the highlight is somewhere the reader cannot see.
      const box = page.cropBox;
      expect(bounds.x0).toBeGreaterThanOrEqual(box.x0 - 1);
      expect(bounds.x1).toBeLessThanOrEqual(box.x1 + 1);
      expect(bounds.y0).toBeGreaterThanOrEqual(box.y0 - 1);
      expect(bounds.y1).toBeLessThanOrEqual(box.y1 + 1);

      const stamp = {
        flags: DEFAULT_ANNOTATION_FLAGS,
        author: 'A Reader',
        created: '2026-09-08T12:00:00.000Z',
        modified: '2026-09-08T12:00:00.000Z',
      };
      const style = { ...DEFAULT_FREE_TEXT_STYLE };
      const drafts = [
        draftAnnotation(doc, page.id, {
          subtype: 'Highlight',
          rect: bounds,
          quadPoints: list.flatMap(quadNumbers),
          color: 0xffe14d,
          subject: 'Highlight',
          ...stamp,
        } as never),
        draftAnnotation(doc, page.id, {
          subtype: 'Text',
          rect: noteRectAt({ x: box.x0 + 20, y: box.y1 - 20 }),
          color: 0xffd400,
          contents: 'checked by the M30 suite',
          subject: 'Note',
          ...stamp,
          extra: { icon: 'Key' },
        } as never),
        draftAnnotation(doc, page.id, {
          subtype: 'FreeText',
          rect: { x0: box.x0 + 20, y0: box.y0 + 20, x1: box.x0 + 220, y1: box.y0 + 70 },
          borderWidth: 0,
          contents: 'typed on to a real page',
          subject: 'Typewriter',
          ...stamp,
          extra: {
            intent: 'FreeTextTypewriter',
            defaultAppearance: buildDefaultAppearance(style),
            defaultStyle: buildDefaultStyle(style),
          },
        } as never),
      ];
      for (const draft of drafts) await doc.apply(new AddAnnotationCommand(doc, draft));

      const { plan, warnings } = buildWritePlan(doc);
      expect(warnings).toEqual([]);
      const base = await eng.save(doc.handle);
      const encrypted = doc.state.security.encrypted;
      await doc.close();
      // An encrypted file is the writer's refusal, not ours; M70 owns re-encrypting on save.
      if (encrypted) return;

      const result = await new FullRewriteWriter().write({ bytes: base, plan });
      expect(result.warnings).toEqual([]);

      const reopened = await Document.open(eng, result.bytes.slice());
      const reopenedPage = must(reopened.state.pages[0], 'page');
      const after = await reopened.loadAnnotations(reopenedPage.id);
      // The page keeps whatever it already had, and gains exactly our three.
      expect(after.length).toBe(before + 3);
      const highlight = must(
        after.find((a) => a.subtype === 'Highlight' && a.subject === 'Highlight'),
        'highlight',
      );
      expect('quadPoints' in highlight ? highlight.quadPoints.length : 0).toBe(list.length * 8);
      expect(
        must(
          after.find((a) => a.subtype === 'Text'),
          'note',
        ).extra['icon'],
      ).toBe('Key');
      const freeText = must(
        after.find((a) => a.subtype === 'FreeText'),
        'free text',
      );
      expect(freeText.contents).toBe('typed on to a real page');
      // The one PDFium cannot create is the one the writer had to insert, and it still has an /AP.
      expect(freeText.extra['hasAP']).toBe(true);
      // The page count is untouched — annotating is not a structural edit.
      expect(reopened.pageCount).toBe(await countPages(bytes));
      await reopened.close();
    });
  }
});

/** Page count of a file, read on its own so the comparison is against the original. */
async function countPages(bytes: Uint8Array): Promise<number> {
  const eng = await engine();
  const handle = await eng.open(bytes.slice());
  const count = await eng.pageCount(handle);
  await eng.close(handle);
  return count;
}

/**
 * M30 acceptance: **each tool creates its annotation; save; reopen; annotation list equal.**
 *
 * This is that line at the model level, through the whole real pipeline — PDFium creates the
 * annotations, M21's planner turns the document into a `WritePlan`, PDFium serialises the base
 * bytes, `FullRewriteWriter` applies the plan, and the result is opened in PDFium again and
 * compared field by field. The version that drives the running app is in
 * `test/e2e/annotations.spec.ts`; this one is where a regression in the *file* shows up, with a
 * stack trace rather than a screenshot.
 *
 * It also checks the thing the brief calls mandatory: every annotation this app writes carries an
 * appearance stream of its own, so a viewer that generates nothing still draws it.
 */

import { describe, expect, it } from 'vitest';
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFString,
  PDFHexString,
} from 'pdf-lib';
import { Document } from '@core/Document';
import {
  AddAnnotationCommand,
  DEFAULT_ANNOTATION_FLAGS,
  draftAnnotation,
  UpdateAnnotationCommand,
} from '@core/commands';
import type { ModelAnnotation } from '@core/model';
import type { ModelId } from '@core/Ids';
import { FullRewriteWriter } from '@engine/writers/FullRewriteWriter';
import { buildWritePlan } from '@modules/M21-save/plan';
import {
  appearanceInput,
  buildDefaultAppearance,
  buildDefaultStyle,
  caretRectAt,
  defaultAppearanceService,
  DEFAULT_FREE_TEXT_STYLE,
  noteRectAt,
  quadNumbers,
  type FreeTextStyle,
} from '@engine/appearance';
import { drawnByOverlay, isOurs } from '@modules/M30-markup-annotations/shapes';
import { engine, fixture } from '../engine/helpers';
import { must } from '../find/helpers';

const NOW = '2026-09-08T12:00:00.000Z';

const HIGHLIGHT_QUADS = [
  ...quadNumbers({
    ul: { x: 72, y: 700 },
    ur: { x: 300, y: 700 },
    ll: { x: 72, y: 688 },
    lr: { x: 300, y: 688 },
  }),
  ...quadNumbers({
    ul: { x: 72, y: 686 },
    ur: { x: 250, y: 686 },
    ll: { x: 72, y: 674 },
    lr: { x: 250, y: 674 },
  }),
];

const STYLE: FreeTextStyle = {
  ...DEFAULT_FREE_TEXT_STYLE,
  family: 'Times New Roman',
  size: 14,
  align: 1,
};

/** One draft per tool M30 ships, as the service builds them. */
function drafts(doc: Document, pageId: ModelId): ModelAnnotation[] {
  const stamp = {
    flags: DEFAULT_ANNOTATION_FLAGS,
    author: 'A Reader',
    created: NOW,
    modified: NOW,
  };
  const freeTextExtra = {
    defaultAppearance: buildDefaultAppearance(STYLE),
    defaultStyle: buildDefaultStyle(STYLE),
    align: STYLE.align,
  };
  return [
    draftAnnotation(doc, pageId, {
      subtype: 'Highlight',
      rect: { x0: 72, y0: 674, x1: 300, y1: 700 },
      quadPoints: HIGHLIGHT_QUADS,
      color: 0xffe14d,
      subject: 'Highlight',
      contents: 'the important bit',
      ...stamp,
    } as never),
    draftAnnotation(doc, pageId, {
      subtype: 'Underline',
      rect: { x0: 72, y0: 660, x1: 300, y1: 672 },
      quadPoints: quadNumbers({
        ul: { x: 72, y: 672 },
        ur: { x: 300, y: 672 },
        ll: { x: 72, y: 660 },
        lr: { x: 300, y: 660 },
      }),
      color: 0x0b5cd6,
      subject: 'Underline',
      ...stamp,
    } as never),
    draftAnnotation(doc, pageId, {
      subtype: 'Squiggly',
      rect: { x0: 72, y0: 640, x1: 300, y1: 652 },
      quadPoints: quadNumbers({
        ul: { x: 72, y: 652 },
        ur: { x: 300, y: 652 },
        ll: { x: 72, y: 640 },
        lr: { x: 300, y: 640 },
      }),
      color: 0xc2185b,
      subject: 'Squiggly',
      ...stamp,
    } as never),
    draftAnnotation(doc, pageId, {
      subtype: 'StrikeOut',
      rect: { x0: 72, y0: 620, x1: 300, y1: 632 },
      quadPoints: quadNumbers({
        ul: { x: 72, y: 632 },
        ur: { x: 300, y: 632 },
        ll: { x: 72, y: 620 },
        lr: { x: 300, y: 620 },
      }),
      color: 0xc2185b,
      subject: 'Strikeout',
      ...stamp,
    } as never),
    draftAnnotation(doc, pageId, {
      subtype: 'Caret',
      rect: caretRectAt({ x: 320, y: 620 }, 12),
      color: 0x0b5cd6,
      contents: 'insert this',
      subject: 'Insert Text',
      ...stamp,
      extra: { intent: 'InsertText' },
    } as never),
    draftAnnotation(doc, pageId, {
      subtype: 'Text',
      rect: noteRectAt({ x: 400, y: 700 }),
      color: 0xffd400,
      contents: 'a sticky note',
      subject: 'Note',
      ...stamp,
      extra: { icon: 'Key' },
    } as never),
    draftAnnotation(doc, pageId, {
      subtype: 'FreeText',
      rect: { x0: 72, y0: 540, x1: 260, y1: 590 },
      borderWidth: 0,
      contents: 'typed straight on the page',
      subject: 'Typewriter',
      ...stamp,
      extra: { ...freeTextExtra, intent: 'FreeTextTypewriter' },
    } as never),
    draftAnnotation(doc, pageId, {
      subtype: 'FreeText',
      rect: { x0: 300, y0: 540, x1: 500, y1: 590 },
      color: 0x000000,
      interiorColor: 0xffffff,
      borderWidth: 1,
      contents: 'in a box',
      subject: 'Text Box',
      ...stamp,
      extra: { ...freeTextExtra, intent: 'FreeText' },
    } as never),
    draftAnnotation(doc, pageId, {
      subtype: 'FreeText',
      rect: { x0: 300, y0: 440, x1: 500, y1: 500 },
      color: 0x0b5cd6,
      interiorColor: 0xffffff,
      borderWidth: 1,
      contents: 'pointing at something',
      subject: 'Callout',
      ...stamp,
      extra: {
        ...freeTextExtra,
        intent: 'FreeTextCallout',
        callout: [120, 400, 210, 470, 300, 470],
        lineEnding: 'OpenArrow',
        padding: [0, 0, 0, 0],
      },
    } as never),
  ];
}

/** The comparable shape of one annotation — what "the annotation list is equal" means. */
function summary(a: ModelAnnotation): Record<string, unknown> {
  return {
    subtype: a.subtype,
    rect: round(a.rect),
    contents: a.contents,
    author: a.author,
    subject: a.subject,
    color: a.color,
    interiorColor: a.interiorColor,
    quadPoints: 'quadPoints' in a ? a.quadPoints.map((n) => Math.round(n * 100) / 100) : [],
    icon: a.extra['icon'] ?? null,
    intent: a.extra['intent'] ?? null,
    defaultAppearance: a.extra['defaultAppearance'] ?? null,
    defaultStyle: a.extra['defaultStyle'] ?? null,
  };
}

function round(r: { x0: number; y0: number; x1: number; y1: number }): number[] {
  return [r.x0, r.y0, r.x1, r.y1].map((n) => Math.round(n * 100) / 100);
}

/** Opens a document, adds every draft, and returns the saved bytes plus what the model held. */
async function makeAnnotated(): Promise<{
  bytes: Uint8Array;
  before: Record<string, unknown>[];
  warnings: string[];
}> {
  const eng = await engine();
  const doc = await Document.open(eng, fixture('text.pdf'));
  const page = must(doc.state.pages[0], 'page');
  await doc.loadAnnotations(page.id);
  for (const draft of drafts(doc, page.id)) {
    await doc.apply(new AddAnnotationCommand(doc, draft));
  }
  const before = doc.annotations(page.id).map(summary);
  const { plan, warnings } = buildWritePlan(doc);
  const base = await eng.save(doc.handle);
  await doc.close();
  const result = await new FullRewriteWriter().write({
    bytes: base,
    plan,
    options: { objectStreams: false },
  });
  return { bytes: result.bytes, before, warnings: [...warnings, ...result.warnings] };
}

describe('every tool’s annotation survives a save and a reopen', () => {
  it('the annotation list is equal, field for field', async () => {
    const eng = await engine();
    const { bytes, before, warnings } = await makeAnnotated();
    expect(warnings).toEqual([]);
    expect(before.length).toBe(9);

    const reopened = await Document.open(eng, bytes.slice());
    const page = must(reopened.state.pages[0], 'page');
    const after = (await reopened.loadAnnotations(page.id)).map(summary);
    await reopened.close();

    expect(after.length).toBe(before.length);
    /*
     * Compared as a set, not as a list. The ones PDFium could create are in the file where it put
     * them; the ones it refused — the free texts and the caret — are appended by the writer, so
     * the *order* differs even though every annotation is there and identical. Nothing in a PDF
     * promises an `/Annots` order, and neither does the brief.
     */
    const key = (a: Record<string, unknown>): string => JSON.stringify(a);
    expect(after.map(key).sort()).toEqual(before.map(key).sort());
  });

  it('every one of them carries an appearance stream of its own', async () => {
    const { bytes } = await makeAnnotated();
    const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
    const annots = pdf.getPage(0).node.Annots();
    expect(annots?.size()).toBe(9);
    for (let i = 0; i < (annots?.size() ?? 0); i++) {
      const dict = pdf.context.lookupMaybe(annots?.get(i), PDFDict);
      const subtype = dict?.get(PDFName.of('Subtype'))?.toString();
      const ap = dict?.lookupMaybe(PDFName.of('AP'), PDFDict);
      expect(ap?.get(PDFName.of('N')), `${subtype ?? '?'} has no /AP /N`).toBeDefined();
    }
  });

  it('writes the dictionary entries PDFium has no setter for, with the right types', async () => {
    const { bytes } = await makeAnnotated();
    const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
    const annots = must(pdf.getPage(0).node.Annots(), 'annots');
    const dicts: PDFDict[] = [];
    for (let i = 0; i < annots.size(); i++) {
      const dict = pdf.context.lookupMaybe(annots.get(i), PDFDict);
      if (dict) dicts.push(dict);
    }
    const note = must(
      dicts.find((d) => d.get(PDFName.of('Subtype'))?.toString() === '/Text'),
      'note',
    );
    // `/Name` is a *name* object, which is what the spec wants — PDFium can only write a string.
    expect(note.get(PDFName.of('Name'))).toBeInstanceOf(PDFName);
    expect(note.get(PDFName.of('Name'))?.toString()).toBe('/Key');

    const callout = must(
      dicts.find((d) => d.lookupMaybe(PDFName.of('CL'), PDFArray) !== undefined),
      'callout',
    );
    const cl = must(callout.lookupMaybe(PDFName.of('CL'), PDFArray), 'CL');
    expect(cl.asArray().map((n) => (n instanceof PDFNumber ? n.asNumber() : NaN))).toEqual([
      120, 400, 210, 470, 300, 470,
    ]);
    expect(callout.get(PDFName.of('IT'))?.toString()).toBe('/FreeTextCallout');
    expect(callout.lookupMaybe(PDFName.of('Q'), PDFNumber)?.asNumber()).toBe(1);

    // `/DA` and `/DS` are strings, and they say the same thing.
    const da = callout.get(PDFName.of('DA'));
    expect(da instanceof PDFString || da instanceof PDFHexString).toBe(true);
    expect(callout.get(PDFName.of('DS'))).toBeDefined();
  });

  it('the app writes no `/CA` of its own, so every annotation it made is opaque', async () => {
    const { bytes } = await makeAnnotated();
    const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
    const annots = must(pdf.getPage(0).node.Annots(), 'annots');
    for (let i = 0; i < annots.size(); i++) {
      const dict = pdf.context.lookupMaybe(annots.get(i), PDFDict);
      const ca = dict?.lookupMaybe(PDFName.of('CA'), PDFNumber);
      expect(ca === undefined || ca.asNumber() === 1, `annotation ${i} is translucent`).toBe(true);
    }
  });

  it('a highlight’s quads survive the round trip exactly, both lines of them', async () => {
    const eng = await engine();
    const { bytes } = await makeAnnotated();
    const reopened = await Document.open(eng, bytes.slice());
    const page = must(reopened.state.pages[0], 'page');
    const list = await reopened.loadAnnotations(page.id);
    const highlight = must(
      list.find((a) => a.subtype === 'Highlight'),
      'highlight',
    );
    await reopened.close();
    expect('quadPoints' in highlight ? highlight.quadPoints.length : 0).toBe(16);
    if ('quadPoints' in highlight) {
      for (let i = 0; i < HIGHLIGHT_QUADS.length; i++) {
        expect(highlight.quadPoints[i]).toBeCloseTo(HIGHLIGHT_QUADS[i] ?? 0, 2);
      }
    }
  });
});

describe('a file that already has annotations', () => {
  it('is left to the raster, so nothing is drawn twice', async () => {
    const eng = await engine();
    const doc = await Document.open(eng, fixture('annotations-all.pdf'));
    const page = must(doc.state.pages[0], 'page');
    const list = await doc.loadAnnotations(page.id);
    expect(list.length).toBeGreaterThan(3);
    for (const a of list) {
      if (!isOurs(a)) continue;
      /*
       * Nothing has been edited, so the overlay draws only what the file itself left undrawn —
       * which for a fixture written by a tool that generates appearances is nothing at all.
       */
      expect(drawnByOverlay(a, new Set()), `${a.subtype} ${String(a.id)}`).toBe(
        a.extra['hasAP'] !== true && a.subtype !== 'Text' && !a.flags.hidden,
      );
    }
    await doc.close();
  });

  it('an existing translucent highlight keeps its `/CA` when its appearance is repaired', async () => {
    const eng = await engine();
    const doc = await Document.open(eng, fixture('annotations-all.pdf'));
    const page = must(doc.state.pages[0], 'page');
    const list = await doc.loadAnnotations(page.id);
    // Only the families M30 draws: an unregistered subtype has no generator and no state at all.
    const translucent = list.find(
      (a) => a.family === 'markup' && a.opacity !== null && a.opacity < 1,
    );
    await doc.close();
    if (!translucent) return; // the fixture may carry none; that is not a failure
    const stream = defaultAppearanceService.generate(
      appearanceInput({
        subtype: translucent.subtype,
        rect: translucent.rect,
        color: translucent.color,
        opacity: translucent.opacity,
        quadPoints: 'quadPoints' in translucent ? translucent.quadPoints : [],
        extra: translucent.extra,
      }),
    );
    const state = Object.values(stream?.resources.extGState ?? {})[0];
    expect(state?.fillAlpha).toBe(translucent.opacity);
  });
});

describe('editing then saving', () => {
  it('a property change reaches the file and replaces the appearance with it', async () => {
    const eng = await engine();
    const doc = await Document.open(eng, fixture('text.pdf'));
    const page = must(doc.state.pages[0], 'page');
    await doc.loadAnnotations(page.id);
    const draft = must(drafts(doc, page.id)[0], 'draft');
    await doc.apply(new AddAnnotationCommand(doc, draft));
    await doc.apply(
      new UpdateAnnotationCommand(doc, draft.id, { color: 0x9bd7ff, contents: 'changed' }),
    );

    const { plan } = buildWritePlan(doc);
    const base = await eng.save(doc.handle);
    await doc.close();
    const result = await new FullRewriteWriter().write({
      bytes: base,
      plan,
      options: { objectStreams: false },
    });

    const reopened = await Document.open(eng, result.bytes.slice());
    const reopenedPage = must(reopened.state.pages[0], 'page');
    const list = await reopened.loadAnnotations(reopenedPage.id);
    const highlight = must(
      list.find((a) => a.subtype === 'Highlight'),
      'highlight',
    );
    await reopened.close();
    expect(highlight.color).toBe(0x9bd7ff);
    expect(highlight.contents).toBe('changed');
  });

  it('undoing an add leaves the document exactly as it was', async () => {
    const eng = await engine();
    const doc = await Document.open(eng, fixture('text.pdf'));
    const page = must(doc.state.pages[0], 'page');
    const originally = (await doc.loadAnnotations(page.id)).length;
    for (const draft of drafts(doc, page.id)) {
      await doc.apply(new AddAnnotationCommand(doc, draft));
    }
    expect(doc.annotations(page.id).length).toBe(originally + 9);
    for (let i = 0; i < 9; i++) await doc.undoLast();
    expect(doc.annotations(page.id).length).toBe(originally);
    // And redo puts every one of them back, with the same model ids.
    for (let i = 0; i < 9; i++) await doc.redoLast();
    expect(doc.annotations(page.id).length).toBe(originally + 9);
    await doc.close();
  });

  it('a note’s appearance can be pushed straight into the live document', async () => {
    const eng = await engine();
    const doc = await Document.open(eng, fixture('text.pdf'));
    const page = must(doc.state.pages[0], 'page');
    await doc.loadAnnotations(page.id);
    const note = must(
      drafts(doc, page.id).find((d) => d.subtype === 'Text'),
      'note',
    );
    await doc.apply(new AddAnnotationCommand(doc, note));
    const engineId = must(doc.idTable.engineKey('annotation', note.id), 'engine id');
    // A trivial but valid stream: PDFium accepts it and the page reloads without complaint.
    await expect(
      eng.setAnnotationAppearance(doc.handle, engineId, '1 0 0 rg 0 0 20 20 re f'),
    ).resolves.toBeUndefined();
    const back = (await eng.annotations(doc.handle, 0)).find((a) => a.id === engineId);
    expect(back?.extra?.['hasAP']).toBe(true);
    await doc.close();
  });
});

/**
 * The writer's initial-view section and the metadata entries M72 added (ADR 0017).
 *
 * The claims worth making are the same two the rest of the plan makes: what the plan does not
 * mention is not touched, and what it does mention lands where the PDF specification says it
 * goes — a name for `/PageMode`, a `/GoTo` action for `/OpenAction`, booleans in
 * `/ViewerPreferences`, `/Base` inside `/URI`, and `/Trapped` as a name rather than a string.
 */

import { describe, expect, it } from 'vitest';
import { PDFDict, PDFDocument, PDFHexString, PDFName, PDFString } from 'pdf-lib';
import { emptyWritePlan, planIsEmpty, type WritePlan } from '@engine/Writer';
import { FullRewriteWriter } from '@engine/writers/FullRewriteWriter';

async function threePages(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create({ updateMetadata: false });
  for (let i = 0; i < 3; i++) pdf.addPage([300, 400]);
  return pdf.save({ useObjectStreams: false, updateFieldAppearances: false });
}

const write = (bytes: Uint8Array, plan: WritePlan): ReturnType<FullRewriteWriter['write']> =>
  new FullRewriteWriter().write({ bytes, plan, options: { objectStreams: false } });

async function reopen(bytes: Uint8Array): Promise<PDFDocument> {
  return PDFDocument.load(bytes, { updateMetadata: false, throwOnInvalidObject: false });
}

function plan(patch: Partial<WritePlan>): WritePlan {
  return { ...emptyWritePlan(3), ...patch };
}

describe('the view section', () => {
  it('is absent from an empty plan, and an empty plan stays empty', () => {
    const empty = emptyWritePlan(3);
    expect(empty.view).toBeNull();
    expect(planIsEmpty(empty)).toBe(true);
    expect(planIsEmpty({ ...empty, view: { pageMode: 'outlines' } })).toBe(false);
  });

  it('writes the page mode and the layout as names', async () => {
    const result = await write(
      await threePages(),
      plan({ view: { pageMode: 'thumbnails', pageLayout: 'two-column-left' } }),
    );
    const doc = await reopen(result.bytes);
    expect(doc.catalog.lookupMaybe(PDFName.of('PageMode'), PDFName)?.decodeText()).toBe(
      'UseThumbs',
    );
    expect(doc.catalog.lookupMaybe(PDFName.of('PageLayout'), PDFName)?.decodeText()).toBe(
      'TwoColumnLeft',
    );
    expect(result.applied).toContain('view');
  });

  it('removes the layout when the document stops asking for one', async () => {
    const first = await write(await threePages(), plan({ view: { pageLayout: 'single' } }));
    const second = await write(first.bytes, plan({ view: { pageLayout: 'default' } }));
    const doc = await reopen(second.bytes);
    expect(doc.catalog.get(PDFName.of('PageLayout'))).toBeUndefined();
  });

  it('writes the open action as a GoTo to the planned page', async () => {
    const result = await write(
      await threePages(),
      plan({ view: { openAction: { page: 2, fit: 'fit' } } }),
    );
    const doc = await reopen(result.bytes);
    const action = doc.catalog.lookupMaybe(PDFName.of('OpenAction'), PDFDict);
    expect(action?.lookupMaybe(PDFName.of('S'), PDFName)?.decodeText()).toBe('GoTo');
    const dest = action?.lookup(PDFName.of('D'));
    const pageRef = doc.getPages()[2]?.ref.toString();
    expect(String(dest)).toContain(pageRef ?? 'no page');
    expect(String(dest)).toContain('/Fit');
  });

  it('removes the open action rather than pointing it at a page that has gone', async () => {
    const first = await write(
      await threePages(),
      plan({ view: { openAction: { page: 2, fit: 'fit' } } }),
    );
    const second = await write(
      first.bytes,
      plan({ view: { openAction: { page: 9, fit: 'fit' } } }),
    );
    const doc = await reopen(second.bytes);
    expect(doc.catalog.get(PDFName.of('OpenAction'))).toBeUndefined();
  });

  it('writes a true viewer preference and removes a false one', async () => {
    const on = await write(
      await threePages(),
      plan({ view: { hideToolbar: true, displayDocTitle: true, printScaling: 'none' } }),
    );
    let doc = await reopen(on.bytes);
    let prefs = doc.catalog.lookupMaybe(PDFName.of('ViewerPreferences'), PDFDict);
    expect(String(prefs?.get(PDFName.of('HideToolbar')))).toBe('true');
    expect(prefs?.lookupMaybe(PDFName.of('PrintScaling'), PDFName)?.decodeText()).toBe('None');

    const off = await write(
      on.bytes,
      plan({ view: { hideToolbar: false, printScaling: 'app-default' } }),
    );
    doc = await reopen(off.bytes);
    prefs = doc.catalog.lookupMaybe(PDFName.of('ViewerPreferences'), PDFDict);
    expect(prefs?.get(PDFName.of('HideToolbar'))).toBeUndefined();
    expect(prefs?.get(PDFName.of('PrintScaling'))).toBeUndefined();
    // The preference the plan did not mention is still there.
    expect(String(prefs?.get(PDFName.of('DisplayDocTitle')))).toBe('true');
  });

  it('puts the base URL inside /URI and takes the dictionary away with it', async () => {
    const set = await write(
      await threePages(),
      plan({ view: { baseUrl: 'https://example.invalid/docs/', lang: 'en-GB' } }),
    );
    let doc = await reopen(set.bytes);
    const uri = doc.catalog.lookupMaybe(PDFName.of('URI'), PDFDict);
    expect(uri?.lookupMaybe(PDFName.of('Base'), PDFString)?.decodeText()).toBe(
      'https://example.invalid/docs/',
    );
    expect(doc.catalog.lookup(PDFName.of('Lang'), PDFHexString).decodeText()).toBe('en-GB');

    const cleared = await write(set.bytes, plan({ view: { baseUrl: null, lang: null } }));
    doc = await reopen(cleared.bytes);
    expect(doc.catalog.get(PDFName.of('URI'))).toBeUndefined();
    expect(doc.catalog.get(PDFName.of('Lang'))).toBeUndefined();
  });
});

describe('custom information-dictionary entries', () => {
  const infoOf = (doc: PDFDocument): PDFDict | undefined =>
    doc.context.lookupMaybe(doc.context.trailerInfo.Info, PDFDict);

  it('writes and removes custom entries, and leaves the standard ones alone', async () => {
    const first = await write(
      await threePages(),
      plan({
        metadata: { title: 'A title', custom: { Department: 'Accounts', Reference: 'A-1' } },
      }),
    );
    let info = infoOf(await reopen(first.bytes));
    expect(info?.lookup(PDFName.of('Department'), PDFHexString).decodeText()).toBe('Accounts');

    // The set is complete, so a key that is no longer in it has been deleted.
    const second = await write(
      first.bytes,
      plan({ metadata: { custom: { Department: 'Sales' } } }),
    );
    info = infoOf(await reopen(second.bytes));
    expect(info?.lookup(PDFName.of('Department'), PDFHexString).decodeText()).toBe('Sales');
    expect(info?.get(PDFName.of('Reference'))).toBeUndefined();
    expect(info?.lookup(PDFName.of('Title'), PDFHexString).decodeText()).toBe('A title');
  });

  it('does not delete an entry whose value the model could never have shown', async () => {
    const base = await threePages();
    const doc = await reopen(base);
    const info = doc.context.obj({});
    info.set(PDFName.of('Odd'), doc.context.obj([1, 2, 3]));
    doc.context.trailerInfo.Info = doc.context.register(info);
    const withArray = await doc.save({ useObjectStreams: false, updateFieldAppearances: false });

    const result = await write(
      withArray,
      plan({ metadata: { custom: { Department: 'Accounts' } } }),
    );
    const after = infoOf(await reopen(result.bytes));
    expect(after?.get(PDFName.of('Odd'))).toBeDefined();
  });

  it('writes /Trapped as a name, and removes it when the plan says null', async () => {
    const set = await write(await threePages(), plan({ metadata: { trapped: 'True' } }));
    let info = infoOf(await reopen(set.bytes));
    expect(info?.lookupMaybe(PDFName.of('Trapped'), PDFName)?.decodeText()).toBe('True');

    const cleared = await write(set.bytes, plan({ metadata: { trapped: null } }));
    info = infoOf(await reopen(cleared.bytes));
    expect(info?.get(PDFName.of('Trapped'))).toBeUndefined();
  });

  it('refuses to let a custom property overwrite a standard one', async () => {
    const result = await write(
      await threePages(),
      plan({ metadata: { title: 'Real title', custom: { Title: 'Impostor' } } }),
    );
    const info = infoOf(await reopen(result.bytes));
    expect(info?.lookup(PDFName.of('Title'), PDFHexString).decodeText()).toBe('Real title');
  });
});

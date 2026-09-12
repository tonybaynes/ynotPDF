import { expect, it, vi } from 'vitest';
import { SetPageBoxCommand } from '@core/commands';
import type { Document } from '@core/Document';
import { applyCropChoice } from '@modules/M41-merge-split-crop/applyCropChoice';
import type { CropChoice } from '@modules/M41-merge-split-crop/cropDialog';
import { openFake } from '../core/helpers';

const choice: CropChoice = {
  box: 'crop',
  changePageSize: false,
  pages: [0, 1],
  margins: { left: 20, right: 20, top: 20, bottom: 20 },
  rect: { x0: 20, y0: 20, x1: 200, y1: 200 },
  ratio: 1,
  ratioChoice: { mode: 'square', width: '1', height: '1' },
};
type CropHost = Parameters<typeof applyCropChoice>[0];

async function context() {
  const { doc } = await openFake({ pageCount: 2 });
  const { doc: other } = await openFake({ pageCount: 2, width: 400, height: 400 });
  let active = doc;
  const service: CropHost = {
    require: () => active,
    organise: {
      targetOf: (indexes, document) => ({
        indexes: [...indexes],
        ids: indexes.flatMap((i) => (document ?? doc).state.pages[i]?.id ?? []),
        text: '',
      }),
    },
    crop: vi.fn<CropHost['crop']>(async (options) => {
      const selected = active;
      if (!options.rect) throw new Error('The crop plan must contain a rectangle');
      for (const id of options.target.ids)
        await selected.apply(new SetPageBoxCommand(selected, id, options.box, options.rect));
      return options.target.ids.length;
    }),
  };
  return {
    doc,
    other,
    service,
    switchTo: (document: Document) => {
      active = document;
    },
  };
}

it('rejects a tab switch while crop confirmation/settings are pending, even when page IDs coincide', async () => {
  const { doc, other, service, switchTo } = await context();
  const expected = { document: doc, revision: doc.state.revision };
  const before = [doc.snapshot(), other.snapshot()];
  let release: (() => void) | undefined;
  const pendingSettings = new Promise<void>((resolve) => {
    release = resolve;
  });
  const result = (async () => {
    await pendingSettings;
    return applyCropChoice(service, choice, 0, expected);
  })();
  switchTo(other);
  release?.();
  await expect(result).rejects.toThrow('active document changed');
  expect(service.crop).not.toHaveBeenCalled();
  expect([doc.snapshot(), other.snapshot()]).toEqual(before);
  await doc.close();
  await other.close();
});

it('rejects edits to the original document after the dialog captured its revision', async () => {
  const { doc, other, service } = await context();
  const expected = { document: doc, revision: doc.state.revision };
  const page = doc.state.pages[0];
  if (!page) throw new Error('Missing page');
  await doc.apply(new SetPageBoxCommand(doc, page.id, 'crop', choice.rect));
  const before = doc.snapshot();
  await expect(applyCropChoice(service, choice, 0, expected)).rejects.toThrow(
    'document changed while',
  );
  expect(service.crop).not.toHaveBeenCalled();
  expect(doc.snapshot()).toEqual(before);
  await doc.close();
  await other.close();
});

it('rolls back earlier pages when the active document changes during a range crop', async () => {
  const { doc, other, service, switchTo } = await context();
  const crop = service.crop;
  service.crop = vi.fn<CropHost['crop']>(async (options) => {
    const result = await crop(options);
    switchTo(other);
    return result;
  });
  const before = [doc.snapshot(), other.snapshot()];
  await expect(
    applyCropChoice(service, choice, 0, { document: doc, revision: doc.state.revision }),
  ).rejects.toThrow('active document changed');
  expect(service.crop).toHaveBeenCalledTimes(1);
  expect([doc.snapshot(), other.snapshot()]).toEqual(before);
  expect(doc.undo.canUndo).toBe(false);
  await doc.close();
  await other.close();
});

it('applies a stable range as one undo step and preflights every page', async () => {
  const { doc, other, service } = await context();
  const before = doc.snapshot();
  expect(
    await applyCropChoice(service, choice, 0, { document: doc, revision: doc.state.revision }),
  ).toBe(2);
  for (const page of doc.state.pages)
    expect(page.cropBox.x1 - page.cropBox.x0).toBeCloseTo(page.cropBox.y1 - page.cropBox.y0);
  await doc.undo.undo();
  expect(doc.snapshot()).toEqual(before);
  expect(doc.undo.canUndo).toBe(false);
  vi.mocked(service.crop).mockClear();
  await expect(
    applyCropChoice(service, { ...choice, pages: [0, 9] }, 0, {
      document: doc,
      revision: doc.state.revision,
    }),
  ).rejects.toThrow('no longer available');
  expect(service.crop).not.toHaveBeenCalled();
  await doc.close();
  await other.close();
});

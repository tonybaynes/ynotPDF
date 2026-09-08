/**
 * The writer's embedded-file section (M12, ADR 0011).
 *
 * PDFium can embed a file, but it writes the description and the MIME type into the embedded
 * stream's `/Params` dictionary, which is not where PDF 7.11.3 puts either of them — so a
 * description written by ynotPDF would be invisible to every other reader. This is the pass that
 * moves them, and these are the bytes it has to produce.
 */

import { describe, expect, it } from 'vitest';
import { PDFArray, PDFDict, PDFName, PDFRawStream, PDFString } from 'pdf-lib';
import { PDFDocument } from 'pdf-lib';
import { emptyWritePlan, type WritePlan } from '@engine/Writer';
import { FullRewriteWriter } from '@engine/writers/FullRewriteWriter';
import { engine, fixture } from '../engine/helpers';

const write = (bytes: Uint8Array, plan: WritePlan): ReturnType<FullRewriteWriter['write']> =>
  new FullRewriteWriter().write({ bytes, plan, options: { objectStreams: false } });

/** The file specification and embedded stream of one attachment in a saved file. */
async function inspect(
  bytes: Uint8Array,
  name: string,
): Promise<{ desc: string | undefined; subtype: string | undefined; params: string[] }> {
  const pdf = await PDFDocument.load(bytes, {
    ignoreEncryption: true,
    updateMetadata: false,
    throwOnInvalidObject: false,
  });
  const ctx = pdf.context;
  const names = pdf.catalog
    .lookupMaybe(PDFName.of('Names'), PDFDict)
    ?.lookupMaybe(PDFName.of('EmbeddedFiles'), PDFDict)
    ?.lookupMaybe(PDFName.of('Names'), PDFArray);
  const list = names?.asArray() ?? [];
  for (let i = 1; i < list.length; i += 2) {
    const spec = ctx.lookupMaybe(list[i], PDFDict);
    const fileName = spec?.lookup(PDFName.of('F'));
    const asText = fileName instanceof PDFString ? fileName.decodeText() : '';
    if (asText !== name) continue;
    const ef = spec?.lookupMaybe(PDFName.of('EF'), PDFDict);
    const stream = ef ? ctx.lookup(ef.get(PDFName.of('F'))) : undefined;
    const params =
      stream instanceof PDFRawStream
        ? (stream.dict.lookupMaybe(PDFName.of('Params'), PDFDict)?.keys() ?? [])
        : [];
    const desc = spec?.lookup(PDFName.of('Desc'));
    const subtype =
      stream instanceof PDFRawStream
        ? stream.dict.lookupMaybe(PDFName.of('Subtype'), PDFName)?.decodeText()
        : undefined;
    return {
      desc: desc instanceof PDFString ? desc.decodeText() : undefined,
      subtype,
      params: params.map((k) => k.decodeText()),
    };
  }
  return { desc: undefined, subtype: undefined, params: [] };
}

/** A blank document with one embedded file, added the way the app adds one. */
async function withAttachment(): Promise<Uint8Array> {
  const pdfium = await engine();
  const doc = pdfium.openSync(fixture('blank.pdf'));
  try {
    await pdfium.addAttachment(doc, {
      name: 'note.txt',
      bytes: new TextEncoder().encode('hello'),
      description: 'Written by PDFium into the wrong dictionary',
      mimeType: 'text/plain',
    });
    return await pdfium.save(doc);
  } finally {
    await pdfium.close(doc);
  }
}

describe('the writer’s embedded-file section', () => {
  it('PDFium leaves the description in /Params, where nothing looks for it', async () => {
    const found = await inspect(await withAttachment(), 'note.txt');
    expect(found.desc).toBeUndefined();
    expect(found.params).toContain('Desc');
  });

  it('the writer moves it onto the file specification, and the type onto the stream', async () => {
    const bytes = await withAttachment();
    const result = await write(bytes, {
      ...emptyWritePlan(1),
      attachments: [{ name: 'note.txt', description: 'A note', mimeType: 'text/plain' }],
    });
    const found = await inspect(result.bytes, 'note.txt');
    expect(found.desc).toBe('A note');
    expect(found.subtype).toBe('text/plain');
    // And it is not left in both places.
    expect(found.params).not.toContain('Desc');
    expect(found.params).not.toContain('Subtype');
    expect(result.applied).toContain('attachments');
  });

  it('a null description removes it', async () => {
    const bytes = await withAttachment();
    const result = await write(bytes, {
      ...emptyWritePlan(1),
      attachments: [{ name: 'note.txt', description: null, mimeType: null }],
    });
    const found = await inspect(result.bytes, 'note.txt');
    expect(found.desc).toBeUndefined();
    expect(found.subtype).toBeUndefined();
  });

  it('warns about an attachment that is not in the file rather than failing the save', async () => {
    const bytes = await withAttachment();
    const result = await write(bytes, {
      ...emptyWritePlan(1),
      attachments: [{ name: 'ghost.txt', description: 'nothing', mimeType: null }],
    });
    expect(result.warnings.join(' ')).toContain('ghost.txt');
    expect(result.bytes.length).toBeGreaterThan(0);
  });

  it('a plan with no attachment section leaves the file’s own alone', async () => {
    const bytes = await withAttachment();
    const result = await write(bytes, emptyWritePlan(1));
    expect(result.applied).not.toContain('attachments');
    const found = await inspect(result.bytes, 'note.txt');
    expect(found.params).toContain('Desc');
  });
});

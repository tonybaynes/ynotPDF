import { describe, expect, it } from 'vitest';
import { PDFDocument, PDFName } from 'pdf-lib';
import { combine } from '@engine/ops/combine';

describe('combine catalogue policy', () => {
  it.each(['AcroForm', 'Names', 'OCProperties', 'StructTreeRoot', 'MarkInfo'])(
    'refuses loss of %s before producing output',
    async (key) => {
      const pdf = await PDFDocument.create();
      pdf.addPage();
      pdf.catalog.set(PDFName.of(key), pdf.context.obj({ Marked: true }));
      const bytes = await pdf.save();
      await expect(combine([{ name: 'structured.pdf', bytes }])).rejects.toThrow(
        /Cannot safely combine.*No combined document was created/,
      );
    },
  );

  it.each([true, false])(
    'does not silently drop fields when their names are shared: %s',
    async (sameNames) => {
      const sources = [];
      for (let i = 0; i < 2; i++) {
        const pdf = await PDFDocument.create();
        const page = pdf.addPage();
        const form = pdf.getForm();
        form.createTextField(sameNames ? 'name' : `name${i}`).addToPage(page);
        form.createCheckBox(`check${i}`).addToPage(page);
        sources.push({ name: `form${i}.pdf`, bytes: await pdf.save() });
      }
      await expect(combine(sources)).rejects.toThrow(/interactive forms/);
      for (const source of sources)
        expect((await PDFDocument.load(source.bytes)).getForm().getFields()).toHaveLength(2);
    },
  );
});

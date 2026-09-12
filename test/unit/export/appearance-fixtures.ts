import { PDFDocument, PDFName } from 'pdf-lib';

/** Known quadrant colours, rotation/clip/opacity, and siblings that must not leak into a picture. */
export async function appearanceFixture(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const rgb = Uint8Array.from([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 0]);
  const palette = pdf.context.register(pdf.context.stream(rgb));
  const indexed = pdf.context.register(
    pdf.context.flateStream(Uint8Array.from([0, 1, 2, 3]), {
      Type: 'XObject',
      Subtype: 'Image',
      Width: 2,
      Height: 2,
      BitsPerComponent: 8,
      ColorSpace: ['Indexed', 'DeviceRGB', 3, palette],
    }),
  );
  const direct = pdf.context.register(
    pdf.context.flateStream(rgb, {
      Type: 'XObject',
      Subtype: 'Image',
      Width: 2,
      Height: 2,
      BitsPerComponent: 8,
      ColorSpace: 'DeviceRGB',
    }),
  );
  const inner = pdf.context.register(
    pdf.context.flateStream(
      'q 0 0 10 20 re W n /Half gs 20 0 0 20 0 0 cm /Rgb Do Q 0 0 1 rg 0 0 20 20 re f',
      {
        Type: 'XObject',
        Subtype: 'Form',
        BBox: [0, 0, 30, 30],
        Resources: {
          XObject: { Rgb: direct },
          ExtGState: { Half: { Type: 'ExtGState', ca: 0.5, CA: 0.5 } },
        },
      },
    ),
  );
  const outer = pdf.context.register(
    pdf.context.flateStream('/Inner Do 1 0 1 rg 0 0 20 20 re f', {
      Type: 'XObject',
      Subtype: 'Form',
      BBox: [0, 0, 30, 30],
      Matrix: [0, 1, -1, 0, 75, 10],
      Resources: { XObject: { Inner: inner } },
    }),
  );
  const page = pdf.addPage([80, 50]);
  page.node.set(
    PDFName.of('Resources'),
    pdf.context.obj({
      XObject: { Indexed: indexed, Outer: outer },
      ExtGState: { Half: { Type: 'ExtGState', ca: 0.5, CA: 0.5 } },
    }),
  );
  page.node.set(
    PDFName.of('Contents'),
    pdf.context.register(
      pdf.context.flateStream(
        'q 20 10 10 20 re W n /Half gs 0 20 -20 0 40 10 cm /Indexed Do Q 0 0 1 rg 20 10 20 20 re f q 55 10 10 20 re W n /Half gs /Outer Do Q',
      ),
    ),
  );
  return pdf.save();
}

/**
 * Form XObjects and their `/Resources`, in pdf-lib terms (M21; extracted for M53, ADR 0020).
 *
 * An appearance stream, a shared stamp picture and a page decoration are all the same object in
 * the end: a content stream with a `/BBox`, a `/Matrix` and a resource dictionary naming the
 * fonts and pictures it draws with. This file builds that once. It lived inside
 * `FullRewriteWriter` until decorations needed the identical thing — both in the writer and,
 * through the engine's one-page-PDF builder, in the live view.
 *
 * Nothing is embedded that a subsetter would be needed for: the standard 14 go in as Type1 with
 * WinAnsi encoding, and a family the reader named goes in as a non-embedded TrueType, which
 * PDFium (ours and Chrome's) resolves through the bundled substitutes.
 */

import { PDFName, PDFNumber, type PDFContext, type PDFDict, type PDFDocument, type PDFRef } from 'pdf-lib';
import type { PdfRect } from '@shared/pdf';
import { num } from '../appearance/content';
import {
  isNonEmbeddedFont,
  type AppearanceFont,
  type AppearanceResources,
} from '../appearance/types';
import type { PlannedXObject } from '../Writer';

/** The empty resource set, so a caller with nothing to name still has the shape. */
export const EMPTY_RESOURCES: AppearanceResources = { extGState: {}, fonts: {} };

/** Key → the object embedded for it. */
export type EmbeddedXObjects = ReadonlyMap<string, PDFRef>;

/** Base64 → bytes, tolerating a `data:` prefix. */
export function fromBase64(data: string): Uint8Array {
  const clean = data.includes(',') ? data.slice(data.indexOf(',') + 1) : data;
  const bin = atob(clean);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** A family name as a PDF name: no delimiters, no whitespace, never empty. */
export function pdfNameOf(family: string): string {
  const cleaned = family.replace(/[^A-Za-z0-9+.-]/g, '');
  return cleaned === '' ? 'Helvetica' : cleaned;
}

/**
 * A font resource for a stream: one of the standard 14 as a Type1, or a family the reader chose
 * from the system list as a non-embedded TrueType (M30, ADR 0013).
 */
export function fontDict(ctx: PDFContext, font: AppearanceFont): PDFDict {
  const dict = ctx.obj({});
  dict.set(PDFName.of('Type'), PDFName.of('Font'));
  if (isNonEmbeddedFont(font)) {
    dict.set(PDFName.of('Subtype'), PDFName.of('TrueType'));
    dict.set(PDFName.of('BaseFont'), PDFName.of(pdfNameOf(font.baseFont)));
    dict.set(PDFName.of('Encoding'), PDFName.of('WinAnsiEncoding'));
    return dict;
  }
  dict.set(PDFName.of('Subtype'), PDFName.of('Type1'));
  dict.set(PDFName.of('BaseFont'), PDFName.of(font));
  // Symbol and ZapfDingbats carry their own built-in encoding and must not be re-encoded.
  if (font !== 'Symbol' && font !== 'ZapfDingbats') {
    dict.set(PDFName.of('Encoding'), PDFName.of('WinAnsiEncoding'));
  }
  return dict;
}

/** The `/Resources` a stream's declared needs come to. */
export function resourcesDict(
  ctx: PDFContext,
  spec: AppearanceResources,
  xobjects: EmbeddedXObjects,
): PDFDict {
  const resources = ctx.obj({});
  resources.set(PDFName.of('ProcSet'), ctx.obj([PDFName.of('PDF'), PDFName.of('Text')]));
  const gsNames = Object.entries(spec.extGState);
  if (gsNames.length > 0) {
    const gs = ctx.obj({});
    for (const [name, g] of gsNames) {
      const state = ctx.obj({});
      state.set(PDFName.of('Type'), PDFName.of('ExtGState'));
      if (g.fillAlpha !== undefined) state.set(PDFName.of('ca'), PDFNumber.of(g.fillAlpha));
      if (g.strokeAlpha !== undefined) state.set(PDFName.of('CA'), PDFNumber.of(g.strokeAlpha));
      if (g.blendMode !== undefined) state.set(PDFName.of('BM'), PDFName.of(g.blendMode));
      gs.set(PDFName.of(name), state);
    }
    resources.set(PDFName.of('ExtGState'), gs);
  }
  const fontNames = Object.entries(spec.fonts);
  if (fontNames.length > 0) {
    const fonts = ctx.obj({});
    for (const [name, font] of fontNames) {
      fonts.set(PDFName.of(name), ctx.register(fontDict(ctx, font)));
    }
    resources.set(PDFName.of('Font'), fonts);
  }
  const xobjectNames = Object.entries(spec.xobjects ?? {});
  if (xobjectNames.length > 0) {
    const forms = ctx.obj({});
    for (const [name, key] of xobjectNames) {
      const ref = xobjects.get(key);
      // Callers check first (`xobjectsResolve`); the guard is for the types.
      if (ref) forms.set(PDFName.of(name), ref);
    }
    resources.set(PDFName.of('XObject'), forms);
  }
  return resources;
}

/** Builds a form XObject from a content stream and registers it. */
export function formXObject(
  ctx: PDFContext,
  options: {
    readonly content: string;
    readonly bbox: PdfRect;
    readonly matrix?: readonly [number, number, number, number, number, number];
    readonly resources: AppearanceResources;
    readonly xobjects: EmbeddedXObjects;
    /** Extra dictionary entries — the decoration marker, for one. */
    readonly entries?: Readonly<Record<string, PDFName>>;
  },
): PDFRef {
  const form = ctx.flateStream(options.content, {
    Type: 'XObject',
    Subtype: 'Form',
    FormType: 1,
  });
  const b = options.bbox;
  form.dict.set(PDFName.of('BBox'), ctx.obj([b.x0, b.y0, b.x1, b.y1]));
  form.dict.set(PDFName.of('Matrix'), ctx.obj([...(options.matrix ?? [1, 0, 0, 1, 0, 0])]));
  form.dict.set(
    PDFName.of('Resources'),
    resourcesDict(ctx, options.resources, options.xobjects),
  );
  for (const [key, value] of Object.entries(options.entries ?? {})) {
    form.dict.set(PDFName.of(key), value);
  }
  return ctx.register(form);
}

/**
 * Embeds one shared XObject source: a stream of our own content, a PNG, or a page of another
 * PDF (M53, ADR 0020 §4 — the `pdf` kind is what a watermark made from a file needs).
 *
 * A picture is wrapped in a form of its own size rather than left as a bare image XObject, so
 * every placement is the same "fit this box into that rect" matrix and the picture itself is
 * embedded exactly once.
 */
export async function embedXObjectSource(
  doc: PDFDocument,
  source: PlannedXObject,
): Promise<PDFRef> {
  const ctx = doc.context;
  switch (source.kind) {
    case 'form':
      return formXObject(ctx, {
        content: source.content,
        bbox: source.bbox,
        resources: source.resources ?? EMPTY_RESOURCES,
        xobjects: new Map(),
      });
    case 'image': {
      const image = await doc.embedPng(fromBase64(source.data));
      const form = ctx.flateStream(
        `q ${num(source.width)} 0 0 ${num(source.height)} 0 0 cm /Im1 Do Q`,
        { Type: 'XObject', Subtype: 'Form', FormType: 1 },
      );
      form.dict.set(PDFName.of('BBox'), ctx.obj([0, 0, source.width, source.height]));
      form.dict.set(PDFName.of('Matrix'), ctx.obj([1, 0, 0, 1, 0, 0]));
      const resources = ctx.obj({});
      const images = ctx.obj({});
      images.set(PDFName.of('Im1'), image.ref);
      resources.set(PDFName.of('XObject'), images);
      resources.set(PDFName.of('ProcSet'), ctx.obj([PDFName.of('PDF'), PDFName.of('ImageC')]));
      form.dict.set(PDFName.of('Resources'), resources);
      return ctx.register(form);
    }
    case 'pdf': {
      const [page] = await doc.embedPdf(fromBase64(source.data), [Math.max(0, source.page)]);
      if (!page) throw new Error('that PDF has no such page');
      return page.ref;
    }
  }
}

/** The natural size of a source, for a caller laying it out before it is embedded. */
export function sourceSize(
  source: PlannedXObject,
): { readonly width: number; readonly height: number } | null {
  switch (source.kind) {
    case 'form':
      return { width: source.bbox.x1 - source.bbox.x0, height: source.bbox.y1 - source.bbox.y0 };
    case 'image':
      return { width: source.width, height: source.height };
    case 'pdf':
      return source.width > 0 && source.height > 0
        ? { width: source.width, height: source.height }
        : null;
  }
}

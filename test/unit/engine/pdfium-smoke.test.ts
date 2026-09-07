import { describe, expect, it } from 'vitest';
import { EngineError } from '@engine/PdfEngine';
import { dhash, engine, fixture, hasInk, inkCoverage } from './helpers';

describe('PdfiumEngine on the M00 fixtures', () => {
  it('reports itself', async () => {
    const e = await engine();
    const info = await e.info();
    expect(info.name).toBe('pdfium');
    expect(info.version).toContain('wasm');
    expect(e.fontCount).toBeGreaterThanOrEqual(0);
  });

  it('opens, counts pages and reads sizes (including /Rotate)', async () => {
    const e = await engine();
    const doc = await e.open(fixture('multipage.pdf'));
    expect(await e.pageCount(doc)).toBe(5);
    const first = await e.pageSize(doc, 0);
    expect(first.width).toBeCloseTo(595.28, 1);
    expect(first.height).toBeCloseTo(841.89, 1);
    expect(first.rotation).toBe(0);
    const rotated = await e.pageSize(doc, 4);
    expect(rotated.rotation).toBe(90);
    // A4 portrait with /Rotate 90 displays landscape.
    expect(rotated.width).toBeCloseTo(841.89, 1);
    expect(rotated.height).toBeCloseTo(595.28, 1);
    expect(rotated.cropBox.x1).toBeCloseTo(595.28, 1);
    await expect(e.pageSize(doc, 5)).rejects.toMatchObject({ code: 'invalid-page' });
    await e.close(doc);
    await expect(e.pageCount(doc)).rejects.toMatchObject({ code: 'invalid-handle' });
  });

  it('extracts text runs with per-glyph boxes in reading order', async () => {
    const e = await engine();
    const doc = await e.open(fixture('text.pdf'));
    const runs = await e.textRuns(doc, 0);
    const text = runs.map((r) => r.text).join('\n');
    expect(text.startsWith('Heading in Helvetica 24 pt')).toBe(true);
    expect(text).toContain('The quick brown fox jumps over the lazy dog.');
    expect(text).toContain('const x = 42; // Courier 10 pt');
    const heading = runs[0];
    expect(heading).toBeDefined();
    if (!heading) return;
    expect(heading.fontSize).toBeCloseTo(24, 3);
    expect(heading.fontName.toLowerCase()).toContain('helvetica');
    expect(heading.chars).toHaveLength(heading.text.length);
    expect(heading.rect.y1).toBeGreaterThan(heading.rect.y0);
    // Glyph boxes sit on one baseline and advance left to right.
    for (let i = 1; i < heading.chars.length; i++) {
      const prev = heading.chars[i - 1];
      const cur = heading.chars[i];
      if (!prev || !cur) continue;
      expect(cur.x0).toBeGreaterThanOrEqual(prev.x0);
    }
    const rotated = runs.find((r) => r.text.includes('Rotated text'));
    expect(rotated).toBeDefined();
    expect(Math.abs(rotated?.angle ?? 0)).toBeGreaterThan(0.4);
    await e.close(doc);
  });

  it('renders a page and glyph boxes contain ink', async () => {
    const e = await engine();
    const doc = await e.open(fixture('text.pdf'));
    const blankDoc = await e.open(fixture('blank.pdf'));
    const blank = await e.renderRaw(blankDoc, 0, 1);
    expect(blank.width).toBe(595);
    expect(blank.height).toBe(842);
    expect(hasInk(blank)).toBe(false);
    const scale = 2;
    const page = await e.renderRaw(doc, 0, scale);
    expect(page.width).toBe(Math.round(595.28 * scale));
    expect(hasInk(page)).toBe(true);
    const geo = e.pageGeometry(doc, 0);
    const runs = await e.textRuns(doc, 0);
    const heading = runs[0];
    if (!heading) throw new Error('no heading run');
    let checked = 0;
    for (let i = 0; i < heading.text.length; i += 3) {
      if (heading.text[i] === ' ') continue;
      const box = heading.chars[i];
      if (!box) continue;
      const dev = geo.rectToDevice(box, page.scale);
      expect(
        inkCoverage(page, dev),
        `glyph ${heading.text[i]} at ${JSON.stringify(dev)}`,
      ).toBeGreaterThan(0.02);
      checked++;
    }
    expect(checked).toBeGreaterThan(5);
    const hash = dhash(page);
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
    await e.close(doc);
    await e.close(blankDoc);
  });

  it('renders tiles that line up with the full page', async () => {
    const e = await engine();
    const doc = await e.open(fixture('text.pdf'));
    const full = await e.renderRaw(doc, 0, 1);
    const size = await e.pageSize(doc, 0);
    // Top-left quarter in page space (origin bottom-left).
    const tile = await e.renderRaw(doc, 0, 1, {
      x0: 0,
      y0: size.height / 2,
      x1: size.width / 2,
      y1: size.height,
    });
    expect(tile.width).toBe(Math.ceil(full.width / 2));
    expect(tile.height).toBe(Math.ceil(full.height / 2));
    expect(tile.rect.x0).toBeCloseTo(0, 3);
    expect(tile.rect.y1).toBeCloseTo(size.height, 1);
    // Pixel rows of the tile equal the corresponding rows of the full render.
    let mismatches = 0;
    for (let y = 0; y < tile.height; y += 7) {
      for (let x = 0; x < tile.width; x += 5) {
        const a = (y * tile.width + x) * 4;
        const b = (y * full.width + x) * 4;
        if (tile.rgba[a] !== full.rgba[b] || tile.rgba[a + 1] !== full.rgba[b + 1]) mismatches++;
      }
    }
    expect(mismatches).toBe(0);
    await e.close(doc);
  });

  it('reads annotations with types, colours, quads and ink paths', async () => {
    const e = await engine();
    const doc = await e.open(fixture('annotated.pdf'));
    const annots = await e.annotations(doc, 0);
    const subtypes = annots.map((a) => a.subtype).sort();
    expect(subtypes).toEqual(['Circle', 'Highlight', 'Ink', 'Square', 'Text']);
    const square = annots.find((a) => a.subtype === 'Square');
    expect(square?.color).toBe(0x0000ff);
    expect(square?.interiorColor).toBe(0xe6e6ff);
    expect(square?.borderWidth).toBe(2);
    expect(square?.contents).toBe('A square annotation');
    expect(square?.author).toBe('ynotPDF fixtures');
    expect(square?.modified).toBe('2026-01-01T00:00:00Z');
    expect(square?.rect).toEqual({ x0: 72, y0: 500, x1: 272, y1: 620 });
    expect(annots.find((a) => a.subtype === 'Highlight')?.quadPoints).toHaveLength(8);
    const ink = annots.find((a) => a.subtype === 'Ink');
    expect(ink?.paths?.[0]).toHaveLength(6);
    expect(annots.every((a) => a.flags.print)).toBe(true);
    expect(annots.map((a) => a.id)).toEqual(['a0.0', 'a0.1', 'a0.2', 'a0.3', 'a0.4']);
    await e.close(doc);
  });

  it('reads the AcroForm field tree with values and options', async () => {
    const e = await engine();
    const doc = await e.open(fixture('form.pdf'));
    const fields = await e.formFields(doc);
    const byName = new Map(fields.map((f) => [f.name, f]));
    expect(byName.get('person.name')?.type).toBe('text');
    expect(byName.get('person.name')?.value).toBe('Ada Lovelace');
    expect(byName.get('person.subscribe')?.type).toBe('checkbox');
    expect(byName.get('person.subscribe')?.value).not.toBe('Off');
    const size = byName.get('person.size');
    expect(size?.type).toBe('radio');
    expect(size?.widgets).toHaveLength(3);
    expect(size?.value).toBe('M');
    const country = byName.get('person.country');
    expect(country?.type).toBe('combobox');
    expect(country?.options?.map((o) => o.label)).toEqual([
      'United Kingdom',
      'Ireland',
      'France',
      'Germany',
    ]);
    expect(country?.value).toBe('United Kingdom');
    expect(byName.get('form.submit')?.type).toBe('button');
    const meta = await e.metadata(doc);
    expect(meta.hasForm).toBe(true);
    expect(meta.hasXfa).toBe(false);
    // Widgets render with their values: the text field area has ink.
    const render = await e.renderRaw(doc, 0, 1);
    const geo = e.pageGeometry(doc, 0);
    const widget = byName.get('person.name')?.widgets[0];
    if (!widget) throw new Error('missing widget');
    expect(inkCoverage(render, geo.rectToDevice(widget.rect, 1))).toBeGreaterThan(0.005);
    const noForms = await e.renderRaw(doc, 0, 1, undefined, { forms: false });
    expect(inkCoverage(noForms, geo.rectToDevice(widget.rect, 1))).toBeLessThan(
      inkCoverage(render, geo.rectToDevice(widget.rect, 1)),
    );
    await e.close(doc);
  });

  it('reads outlines with destinations', async () => {
    const e = await engine();
    const doc = await e.open(fixture('outline.pdf'));
    const outline = await e.outline(doc);
    expect(outline.map((o) => o.title)).toEqual(['Chapter 1', 'Chapter 2', 'Chapter 3']);
    expect(outline[0]?.open).toBe(true);
    expect(outline[1]?.open).toBe(false);
    expect(outline[0]?.children[0]?.title).toBe('Section 1.1');
    expect(outline[2]?.dest).toMatchObject({ page: 2, fit: 'xyz', top: 800 });
    expect(outline[0]?.children[0]?.dest).toMatchObject({ page: 0, top: 420 });
    await e.close(doc);
  });

  it('reads layers, attachments and metadata', async () => {
    const e = await engine();
    const layered = await e.open(fixture('layers.pdf'));
    const layers = await e.layers(layered);
    expect(layers.map((l) => [l.name, l.visible])).toEqual([
      ['Base', true],
      ['Overlay', false],
    ]);
    const objects = await e.pageObjects(layered, 0);
    const texts = objects.filter((o) => o.kind === 'text');
    expect(texts).toHaveLength(2);
    expect(texts.map((t) => t.layerId)).toEqual([layers[0]?.id, layers[1]?.id]);
    expect(texts[1]?.fillColor).toBe(0x0000ff);
    expect(texts[0]?.text).toContain('Base');
    await e.close(layered);

    const attached = await e.open(fixture('attachments.pdf'));
    const attachments = await e.attachments(attached);
    expect(attachments.map((a) => a.name)).toEqual(['note.txt', 'people.csv']);
    expect(attachments[0]?.description).toBe('A plain-text note');
    expect(attachments[0]?.mimeType).toBe('text/plain');
    const data = await e.attachmentData(attached, attachments[1]?.id ?? '');
    expect(new TextDecoder().decode(data)).toBe('id,name\n1,Ada\n2,Grace\n');
    const meta = await e.metadata(attached);
    expect(meta.title).toBe('Attachments sample');
    expect(meta.author).toBe('ynotPDF fixtures');
    expect(meta.created).toBe('2026-01-01T00:00:00Z');
    expect(meta.pageCount).toBe(1);
    expect(meta.encrypted).toBe(false);
    expect(meta.version).toMatch(/^1\.\d$/);
    const perms = await e.permissions(attached);
    expect(Object.values(perms).every(Boolean)).toBe(true);
    await e.close(attached);
  });

  it('handles encrypted files: password-required, wrong-password, success', async () => {
    const e = await engine();
    const bytes = fixture('encrypted.pdf');
    await expect(e.open(bytes)).rejects.toMatchObject({ code: 'password-required' });
    await expect(e.open(bytes, { password: 'nope' })).rejects.toMatchObject({
      code: 'wrong-password',
    });
    const doc = await e.open(bytes, { password: 'ynot' });
    expect(await e.pageCount(doc)).toBe(1);
    const meta = await e.metadata(doc);
    expect(meta.encrypted).toBe(true);
    expect(meta.title).toBe('Encrypted sample');
    const runs = await e.textRuns(doc, 0);
    expect(runs.map((r) => r.text).join(' ')).toContain('Encrypted with RC4-128');
    const owner = await e.open(bytes, { password: 'owner' });
    expect(await e.pageCount(owner)).toBe(1);
    await e.close(doc);
    await e.close(owner);
  });

  it('rejects garbage as corrupt', async () => {
    const e = await engine();
    const err = await e
      .open(new TextEncoder().encode('this is not a pdf'))
      .catch((x: unknown) => x);
    expect(err).toBeInstanceOf(EngineError);
    expect((err as EngineError).code).toBe('corrupt');
  });

  it('serialises a copy of the document', async () => {
    const e = await engine();
    const doc = await e.open(fixture('text.pdf'));
    const seen: number[] = [];
    const bytes = await e.save(doc, {}, (f) => seen.push(f));
    expect(new TextDecoder('latin1').decode(bytes.subarray(0, 5))).toBe('%PDF-');
    expect(seen).toEqual([0, 1]);
    const reopened = await e.open(bytes);
    expect(await e.pageCount(reopened)).toBe(1);
    await e.close(reopened);
    await e.close(doc);
  });
});

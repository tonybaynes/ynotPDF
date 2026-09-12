/**
 * M30's stored state: the per-tool defaults, the identity, and the annotation clipboard.
 *
 * The clipboard is here rather than in a file of its own because it is the same kind of thing —
 * data that leaves the app and comes back, from a source that cannot be trusted to have kept its
 * shape. Both are tested the same way: a round trip, and then what happens when the stored value
 * is nonsense.
 */

import { describe, expect, it } from 'vitest';
import type { ModelAnnotation } from '@core/model';
import type { ModelId } from '@core/Ids';
import { toModelAnnotation } from '@core/model';
import {
  ANNOTATION_TOOLS,
  DEFAULT_ANNOTATION_SETTINGS,
  factoryDefaults,
  initialsOf,
  memorySettingsStorage,
  mergeToolDefaults,
  readIdentity,
  readSettings,
  readToolDefaults,
  writeIdentity,
  writeSetting,
  writeToolDefaults,
} from '@modules/M30-markup-annotations/settings';
import {
  CLIPBOARD_MARKER,
  decodeAnnotations,
  encodeAnnotations,
  looksLikeAnnotations,
} from '@modules/M30-markup-annotations/clipboard';
import {
  FILL_PRESETS,
  HIGHLIGHT_PRESETS,
  INK_PRESETS,
  colourName,
  defaultColourFor,
  hexOf,
  parseHexColour,
} from '@modules/M30-markup-annotations/presets';
import { toRichContents, sanitiseRich } from '@modules/M30-markup-annotations/NotePopup';

it('reconstructs rich-text formatting without event, navigation or layout attributes', () => {
  const hostile =
    '<p style="position:fixed;z-index:999999" onclick="alert(1)"><b id="shell">bold</b><span style="color:#112233;position:absolute" onmouseover="x()">text</span><img src=x onerror="x()"></p>';
  const expected = '<p><b>bold</b><span style="color:#112233">text</span></p>';
  expect(sanitiseRich(hostile)).toBe(expected);
  expect(sanitiseRich(toRichContents(hostile))).toBe(expected);
  expect(sanitiseRich(expected)).toBe(expected);
  expect(sanitiseRich('<u style="font-size:9999px" autofocus>underlined</u><')).toBe(
    '<u>underlined</u>&lt;',
  );
});
import { must } from '../find/helpers';

describe('tool defaults', () => {
  it('every tool has a subject, a colour and a full set of properties', () => {
    for (const tool of ANNOTATION_TOOLS) {
      const defaults = factoryDefaults(tool);
      expect(defaults.subject, tool).not.toBe('');
      expect(defaults.color, tool).toBeGreaterThanOrEqual(0);
      expect(defaults.fontSize, tool).toBeGreaterThan(0);
    }
  });

  it('a typewriter has no border and a text box has one, which is what tells them apart', () => {
    expect(factoryDefaults('typewriter').borderWidth).toBe(0);
    expect(factoryDefaults('textbox').borderWidth).toBeGreaterThan(0);
    expect(factoryDefaults('textbox').fillColor).not.toBeNull();
  });

  it('round-trips through storage', async () => {
    const storage = memorySettingsStorage();
    const wanted = { ...factoryDefaults('highlight'), color: 0x123456, fontSize: 18 };
    await writeToolDefaults(storage, 'highlight', wanted);
    expect(await readToolDefaults(storage, 'highlight')).toEqual(wanted);
  });

  it('merges a stored set from an older version rather than rejecting it', () => {
    const merged = mergeToolDefaults('note', { icon: 'Key', gone: true, color: 'not a number' });
    expect(merged.icon).toBe('Key');
    expect(merged.color).toBe(factoryDefaults('note').color);
    expect('gone' in merged).toBe(false);
  });

  it('a null fill is a value, not a missing field', () => {
    expect(mergeToolDefaults('textbox', { fillColor: null }).fillColor).toBeNull();
    expect(mergeToolDefaults('textbox', { fillColor: 0x010203 }).fillColor).toBe(0x010203);
  });

  it('unusable storage leaves the factory defaults alone', () => {
    expect(mergeToolDefaults('callout', null)).toEqual(factoryDefaults('callout'));
    expect(mergeToolDefaults('callout', 'nonsense')).toEqual(factoryDefaults('callout'));
  });
});

describe('the module’s own settings', () => {
  it('round-trip, and a value of the wrong type is ignored', async () => {
    const storage = memorySettingsStorage();
    await writeSetting(storage, 'keepToolSelected', true);
    await storage.set('annot.nudgePoints', 'four');
    const read = await readSettings(storage);
    expect(read.keepToolSelected).toBe(true);
    expect(read.nudgePoints).toBe(DEFAULT_ANNOTATION_SETTINGS.nudgePoints);
  });
});

describe('identity', () => {
  it('round-trips, and an unanswered identity is not "asked"', async () => {
    const storage = memorySettingsStorage();
    expect((await readIdentity(storage)).asked).toBe(false);
    await writeIdentity(storage, { name: 'A Reader', initials: 'AR', email: '', asked: true });
    const read = await readIdentity(storage);
    expect(read.name).toBe('A Reader');
    expect(read.asked).toBe(true);
  });

  it('offers initials from a name', () => {
    expect(initialsOf('Tony Baynes')).toBe('TB');
    expect(initialsOf('  ada   lovelace  ')).toBe('AL');
    expect(initialsOf('Jean-Luc Picard of the Enterprise')).toBe('JE');
    expect(initialsOf('Prince')).toBe('P');
    expect(initialsOf('   ')).toBe('');
  });
});

describe('colour presets', () => {
  it('every preset parses to a colour, except the "None" the fill list carries', () => {
    for (const preset of [...HIGHLIGHT_PRESETS, ...INK_PRESETS]) {
      expect(preset.value, preset.name).not.toBeNull();
    }
    expect(FILL_PRESETS.some((p) => p.value === null)).toBe(true);
  });

  it('every preset has a name, because a swatch that says only its colour says nothing', () => {
    for (const preset of [...HIGHLIGHT_PRESETS, ...INK_PRESETS, ...FILL_PRESETS]) {
      expect(preset.name.trim().length).toBeGreaterThan(0);
    }
  });

  it('names a colour, and falls back to its digits for one nobody named', () => {
    const yellow = must(HIGHLIGHT_PRESETS[0], 'preset');
    expect(colourName(yellow.value)).toBe(yellow.name);
    expect(colourName(null)).toBe('None');
    expect(colourName(0x123456)).toBe('#123456');
  });

  it('every tool starts from a colour the catalogue names', () => {
    for (const tool of ANNOTATION_TOOLS) {
      expect(defaultColourFor(tool), tool).toBeGreaterThanOrEqual(0);
    }
  });

  it('parses and formats hexadecimal both ways', () => {
    expect(parseHexColour('#ff0000')).toBe(0xff0000);
    expect(parseHexColour('00FF00')).toBe(0x00ff00);
    expect(parseHexColour('#abc')).toBe(0xaabbcc);
    expect(parseHexColour('rubbish')).toBeNull();
    expect(hexOf(0x0b5cd6)).toBe('#0b5cd6');
    expect(hexOf(0x000001)).toBe('#000001');
  });
});

// ---- the clipboard -----------------------------------------------------------------------------

function sample(subtype: 'Highlight' | 'FreeText' | 'Text'): ModelAnnotation {
  return toModelAnnotation('an-9' as ModelId, 'pg-2' as ModelId, {
    id: 'a1.3',
    page: 1,
    subtype,
    rect: { x0: 10, y0: 20, x1: 110, y1: 60 },
    flags: { hidden: false, print: true, noView: false, readOnly: false, locked: false },
    contents: 'a note',
    author: 'A Reader',
    color: 0xffe14d,
    ...(subtype === 'Highlight' ? { quadPoints: [10, 60, 110, 60, 10, 20, 110, 20] } : {}),
    extra: { icon: 'Key', hasAP: true },
  });
}

describe('the annotation clipboard', () => {
  it('round-trips what a paste needs and nothing it does not', () => {
    const encoded = encodeAnnotations([{ annotation: sample('Highlight'), page: 1 }]);
    expect(encoded.startsWith(CLIPBOARD_MARKER)).toBe(true);
    const [item] = decodeAnnotations(encoded);
    const back = must(item, 'item');
    expect(back.page).toBe(1);
    expect(back.annotation.subtype).toBe('Highlight');
    expect(back.annotation.rect).toEqual({ x0: 10, y0: 20, x1: 110, y1: 60 });
    expect(back.annotation.contents).toBe('a note');
    expect(back.annotation.color).toBe(0xffe14d);
    // Identity, dates and thread links belong to the new annotation, not to the old one.
    expect(back.annotation.created).toBeNull();
    expect(back.annotation.inReplyTo).toBeNull();
  });

  it('a pasted annotation starts without an appearance stream, whatever the source had', () => {
    const [item] = decodeAnnotations(encodeAnnotations([{ annotation: sample('Text'), page: 0 }]));
    expect(must(item, 'item').annotation.extra['hasAP']).toBeUndefined();
    expect(must(item, 'item').annotation.extra['icon']).toBe('Key');
  });

  it('ignores anything that is not ours', () => {
    expect(decodeAnnotations('')).toEqual([]);
    expect(decodeAnnotations('hello world')).toEqual([]);
    expect(looksLikeAnnotations('hello')).toBe(false);
    expect(decodeAnnotations(`${CLIPBOARD_MARKER}\nnot json`)).toEqual([]);
    expect(decodeAnnotations(`${CLIPBOARD_MARKER}\n{"not":"an array"}`)).toEqual([]);
  });

  it('drops an entry with no usable geometry rather than inventing one', () => {
    const payload = `${CLIPBOARD_MARKER}\n${JSON.stringify([
      { subtype: 'Highlight' },
      { subtype: 'Highlight', rect: { x0: 'a', y0: 0, x1: 1, y1: 1 } },
      { rect: { x0: 0, y0: 0, x1: 1, y1: 1 } },
      { subtype: 'Text', rect: { x0: 0, y0: 0, x1: 1, y1: 1 } },
    ])}`;
    expect(decodeAnnotations(payload).length).toBe(1);
  });

  it('normalises a rect that arrives the wrong way round', () => {
    const payload = `${CLIPBOARD_MARKER}\n${JSON.stringify([
      { subtype: 'Text', rect: { x0: 10, y0: 10, x1: 0, y1: 0 } },
    ])}`;
    expect(must(decodeAnnotations(payload)[0], 'item').annotation.rect).toEqual({
      x0: 0,
      y0: 0,
      x1: 10,
      y1: 10,
    });
  });

  it('keeps only JSON values out of a foreign `extra` bag', () => {
    const payload = `${CLIPBOARD_MARKER}\n${JSON.stringify([
      {
        subtype: 'Text',
        rect: { x0: 0, y0: 0, x1: 1, y1: 1 },
        extra: { icon: 'Key', nested: { deep: 1 }, list: [1, 2] },
      },
    ])}`;
    const extra = must(decodeAnnotations(payload)[0], 'item').annotation.extra;
    expect(extra['icon']).toBe('Key');
    expect(extra['list']).toEqual([1, 2]);
    expect(extra['nested']).toBeUndefined();
  });
});

describe('the popup’s rich text', () => {
  it('keeps the tags it can produce and drops everything else', () => {
    const rc = toRichContents('<b>bold</b><script>alert(1)</script><i>it</i>');
    expect(rc).toContain('<b>bold</b>');
    expect(rc).toContain('<i>it</i>');
    expect(rc).not.toContain('script');
    expect(rc).toContain('xmlns="http://www.w3.org/1999/xhtml"');
  });

  it('normalises the tags a browser prefers to the ones the spec names', () => {
    const rc = toRichContents('<strong>a</strong><em>b</em><br>');
    expect(rc).toContain('<b>a</b>');
    expect(rc).toContain('<i>b</i>');
    expect(rc).toContain('<br/>');
  });

  it('keeps a colour, as a hexadecimal value, and nothing else from a span', () => {
    const rc = toRichContents('<span style="color:#ff0000;font-size:99pt">red</span>');
    expect(rc).toContain('color:#ff0000');
    expect(rc).not.toContain('99pt');
  });

  it('reads a stored fragment back without its wrapper', () => {
    const inner = sanitiseRich(toRichContents('<b>hi</b>'));
    expect(inner).toBe('<b>hi</b>');
    expect(sanitiseRich('<body><script>x</script><u>y</u></body>')).toBe('x<u>y</u>');
  });
});

/**
 * The converter registry (M91): routing by MIME type and extension, grouping for Create.
 */

import { describe, expect, it } from 'vitest';
import { ConverterRegistry, createRegistry } from '@engine/create/registry';
import { ConvertUnsupported, type Converter } from '@engine/create/types';

describe('createRegistry', () => {
  it('holds the five built-in converters', () => {
    const registry = createRegistry();
    expect(registry.all().map((c) => c.id)).toEqual(['image', 'text', 'html', 'web', 'blank']);
    expect(registry.get('image')?.id).toBe('image');
    expect(registry.get('blank')?.label).toBe('Blank document');
    expect(registry.get('nope')).toBeUndefined();
  });

  it('routes by extension', () => {
    const registry = createRegistry();
    expect(registry.find({ name: 'photo.jpg' })?.id).toBe('image');
    expect(registry.find({ name: 'C:\\docs\\PHOTO.JPEG' })?.id).toBe('image');
    expect(registry.find({ name: 'notes.md' })?.id).toBe('html');
    expect(registry.find({ name: 'page.html' })?.id).toBe('html');
    expect(registry.find({ name: 'readme.txt' })?.id).toBe('text');
    expect(registry.find({ name: 'data.json' })?.id).toBe('text');
    expect(registry.find({ name: 'file.pdf' })).toBeUndefined();
    expect(registry.find({ name: 'archive.zip' })).toBeUndefined();
    expect(registry.find({ name: 'noextension' })).toBeUndefined();
    expect(registry.find({})).toBeUndefined();
  });

  it('prefers the MIME type over the extension', () => {
    const registry = createRegistry();
    expect(registry.find({ name: 'photo.jpg', mime: 'text/plain' })?.id).toBe('text');
    expect(registry.find({ name: 'notes.txt', mime: 'TEXT/HTML' })?.id).toBe('html');
    expect(registry.find({ mime: 'image/png' })?.id).toBe('image');
    // An unknown MIME type falls back to the extension.
    expect(registry.find({ name: 'photo.jpg', mime: 'application/octet-stream' })?.id).toBe(
      'image',
    );
    expect(registry.find({ mime: 'application/octet-stream' })).toBeUndefined();
  });

  it('require() names the file it cannot take', () => {
    const registry = createRegistry();
    expect(registry.require({ name: 'a.png' }).id).toBe('image');
    let caught: unknown;
    try {
      registry.require({ name: 'archive.zip' });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConvertUnsupported);
    if (caught instanceof ConvertUnsupported) {
      expect(caught.reason).toBe('unknown-format');
      expect(caught.message).toContain('archive.zip');
    }
    expect(() => registry.require({ mime: 'application/zip' })).toThrow(/application\/zip/);
    expect(() => registry.require({})).toThrow(/this file/);
  });

  it('accepts() mirrors find()', () => {
    const registry = createRegistry();
    expect(registry.accepts({ name: 'a.tif' })).toBe(true);
    expect(registry.accepts({ name: 'a.docx' })).toBe(false);
  });

  it('lists every extension once, sorted', () => {
    const exts = registry().extensions();
    expect(exts).toEqual([...new Set(exts)].sort());
    expect(exts).toContain('jpg');
    expect(exts).toContain('md');
    expect(exts).toContain('txt');
    expect(exts).toContain('html');
    expect(exts).not.toContain('pdf');
  });

  it('groups images together and everything else on its own', () => {
    const inputs = [
      { name: 'a.jpg' },
      { name: 'b.txt' },
      { name: 'c.png' },
      { name: 'd.md' },
      { name: 'e.pdf' },
      { name: 'f.txt' },
      { name: 'g.zip' },
    ];
    const { groups, rejected } = registry().group(inputs);
    expect(groups.map((g) => [g.converter.id, g.inputs.map((i) => i.name)])).toEqual([
      ['image', ['a.jpg', 'c.png']],
      ['text', ['b.txt']],
      ['html', ['d.md']],
      ['text', ['f.txt']],
    ]);
    expect(rejected.map((r) => r.name)).toEqual(['e.pdf', 'g.zip']);
    expect(registry().group([])).toEqual({ groups: [], rejected: [] });
  });

  it('register() replaces a converter with the same id', () => {
    const reg = registry();
    const fake: Converter = {
      id: 'text',
      label: 'Fake text',
      extensions: ['fake'],
      mimes: [],
      multi: false,
      accepts: () => true,
      defaults: () => ({}),
      convert: () => Promise.reject(new Error('not called')),
    };
    reg.register(fake);
    expect(reg.all()).toHaveLength(5);
    expect(reg.get('text')).toBe(fake);
    expect(reg.find({ name: 'x.fake' })).toBe(fake);
    expect(reg.find({ name: 'x.txt' })).toBeUndefined();
  });

  it('starts empty when built by hand', () => {
    const empty = new ConverterRegistry();
    expect(empty.all()).toEqual([]);
    expect(empty.extensions()).toEqual([]);
    expect(empty.find({ name: 'a.jpg' })).toBeUndefined();
  });
});

function registry(): ConverterRegistry {
  return createRegistry();
}

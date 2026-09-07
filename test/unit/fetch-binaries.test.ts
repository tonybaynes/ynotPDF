import { describe, expect, it } from 'vitest';
import { deflateRawSync, gunzipSync, gzipSync } from 'node:zlib';
import { readTar, readZip } from '../../scripts/fetch-binaries';

/** Builds a minimal ustar archive in memory. */
function makeTar(entries: Array<{ name: string; data: Uint8Array }>): Uint8Array {
  const blocks: Uint8Array[] = [];
  for (const e of entries) {
    const header = new Uint8Array(512);
    const enc = new TextEncoder();
    header.set(enc.encode(e.name).subarray(0, 100), 0);
    header.set(enc.encode('0000644\0'), 100);
    header.set(enc.encode('0000000\0'), 108);
    header.set(enc.encode('0000000\0'), 116);
    header.set(enc.encode(e.data.length.toString(8).padStart(11, '0') + '\0'), 124);
    header.set(enc.encode('00000000000\0'), 136);
    header[156] = 0x30;
    header.set(enc.encode('ustar\0'), 257);
    header.set(enc.encode('00'), 263);
    header.set(enc.encode('        '), 148); // checksum placeholder (spaces)
    let sum = 0;
    for (const b of header) sum += b;
    header.set(enc.encode(sum.toString(8).padStart(6, '0') + '\0 '), 148);
    blocks.push(header, e.data, new Uint8Array((512 - (e.data.length % 512)) % 512));
  }
  blocks.push(new Uint8Array(1024));
  const total = blocks.reduce((n, b) => n + b.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const b of blocks) {
    out.set(b, at);
    at += b.length;
  }
  return out;
}

/** Builds a minimal zip with one stored and one deflated entry. */
function makeZip(entries: Array<{ name: string; data: Uint8Array; deflate: boolean }>): Uint8Array {
  const enc = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  const u16 = (v: number): number[] => [v & 255, (v >> 8) & 255];
  const u32 = (v: number): number[] => [v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255];
  for (const e of entries) {
    const name = enc.encode(e.name);
    const payload = e.deflate ? new Uint8Array(deflateRawSync(e.data)) : e.data;
    const method = e.deflate ? 8 : 0;
    const local = new Uint8Array([
      ...u32(0x04034b50),
      ...u16(20),
      ...u16(0),
      ...u16(method),
      ...u16(0),
      ...u16(0),
      ...u32(0),
      ...u32(payload.length),
      ...u32(e.data.length),
      ...u16(name.length),
      ...u16(0),
      ...name,
      ...payload,
    ]);
    const central = new Uint8Array([
      ...u32(0x02014b50),
      ...u16(20),
      ...u16(20),
      ...u16(0),
      ...u16(method),
      ...u16(0),
      ...u16(0),
      ...u32(0),
      ...u32(payload.length),
      ...u32(e.data.length),
      ...u16(name.length),
      ...u16(0),
      ...u16(0),
      ...u16(0),
      ...u16(0),
      ...u32(0),
      ...u32(offset),
      ...name,
    ]);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const cdSize = centrals.reduce((n, c) => n + c.length, 0);
  const eocd = new Uint8Array([
    ...u32(0x06054b50),
    ...u16(0),
    ...u16(0),
    ...u16(entries.length),
    ...u16(entries.length),
    ...u32(cdSize),
    ...u32(offset),
    ...u16(0),
  ]);
  const parts = [...locals, ...centrals, eocd];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

describe('fetch-binaries archive readers', () => {
  it('extracts selected members of a gzipped tar', () => {
    const tar = makeTar([
      { name: 'fonts-1.0/A.ttf', data: new TextEncoder().encode('AAAA') },
      { name: 'fonts-1.0/B.ttf', data: new Uint8Array(700).fill(7) },
      { name: 'fonts-1.0/README', data: new TextEncoder().encode('readme') },
    ]);
    const gz = new Uint8Array(gzipSync(tar));
    const got = readTar(
      new Uint8Array(gunzipSync(gz)),
      new Set(['fonts-1.0/B.ttf', 'fonts-1.0/README']),
    );
    expect([...got.keys()].sort()).toEqual(['fonts-1.0/B.ttf', 'fonts-1.0/README']);
    expect(got.get('fonts-1.0/B.ttf')?.length).toBe(700);
    expect(new TextDecoder().decode(got.get('fonts-1.0/README'))).toBe('readme');
  });

  it('extracts stored and deflated zip members', () => {
    const zip = makeZip([
      { name: 'd/ttf/X.ttf', data: new TextEncoder().encode('stored bytes'), deflate: false },
      { name: 'd/ttf/Y.ttf', data: new Uint8Array(5000).map((_, i) => i % 13), deflate: true },
      { name: 'd/LICENSE', data: new TextEncoder().encode('licence'), deflate: true },
    ]);
    const got = readZip(zip, new Set(['d/ttf/Y.ttf', 'd/LICENSE']));
    expect(got.size).toBe(2);
    expect(got.get('d/ttf/Y.ttf')?.length).toBe(5000);
    expect(got.get('d/ttf/Y.ttf')?.[26]).toBe(0);
    expect(new TextDecoder().decode(got.get('d/LICENSE'))).toBe('licence');
    expect(() => readZip(new Uint8Array(30), new Set())).toThrow(/central directory/);
  });
});
